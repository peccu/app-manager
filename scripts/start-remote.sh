#!/usr/bin/env bash
# LAN の IP と Tailscale の名前でアクセスできるように App Manager を起動する。
#
#   scripts/start-remote.sh
#
# - 0.0.0.0 で待ち受け、LAN の IP / ホスト名 / Tailscale の IP・名前を ALLOWED_HOSTS に入れる
# - Tailscale はホストの `tailscale` CLI、無ければ docker の tailscale コンテナから情報を取る
# - 起動直後（ホスト再起動時）は Tailscale がまだ上がっていないことがあるので、しばらく待つ
#
# 環境変数（任意）
#   PORT                   待ち受けポート（既定 4949）
#   HOST                   待ち受けアドレス（既定 0.0.0.0）
#   EXTRA_ALLOWED_HOSTS    追加で許可するホスト名（カンマ区切り）
#   TAILSCALE_CONTAINER    Tailscale コンテナ名（既定 tailscale）
#   TAILSCALE_WAIT         Tailscale を待つ秒数（既定 60）
set -uo pipefail

cd "$(dirname "$0")/.."

export PORT="${PORT:-4949}"
export HOST="${HOST:-0.0.0.0}"
TAILSCALE_CONTAINER="${TAILSCALE_CONTAINER:-tailscale}"
TAILSCALE_WAIT="${TAILSCALE_WAIT:-60}"

hosts=()
add() { local h; for h in "$@"; do [ -n "$h" ] && hosts+=("${h%.}"); done; }

# --- LAN ---
lan_ip=""
for _ in $(seq 1 30); do
  lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  [ -n "$lan_ip" ] && break
  sleep 1
done
add "$lan_ip" "$(hostname)" "$(hostname).local"

# --- Tailscale ---
ts() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale "$@"
  elif command -v docker >/dev/null 2>&1 && docker inspect "$TAILSCALE_CONTAINER" >/dev/null 2>&1; then
    docker exec "$TAILSCALE_CONTAINER" tailscale "$@"
  else
    return 127
  fi
}

ts_json=""
for _ in $(seq 1 "$TAILSCALE_WAIT"); do
  ts_json=$(ts status --self --peers=false --json 2>/dev/null); rc=$?
  [ "$rc" = 0 ] && [ "$(jq -r '.BackendState' <<<"$ts_json")" = "Running" ] && break
  ts_json=""
  [ "$rc" = 127 ] && break   # Tailscale が見つからない
  sleep 1
done
if [ -n "$ts_json" ]; then
  ts_fqdn=$(jq -r '.Self.DNSName // empty' <<<"$ts_json")
  add $(jq -r '.Self.TailscaleIPs[]? | select(test("^[0-9.]+$"))' <<<"$ts_json")
  add "$ts_fqdn" "${ts_fqdn%%.*}"
else
  echo "warning: Tailscale の情報を取得できませんでした（LAN のみで起動します）" >&2
fi

add $(tr ',' ' ' <<<"${EXTRA_ALLOWED_HOSTS:-}")

ALLOWED_HOSTS=$(printf '%s\n' "${hosts[@]}" | tr 'A-Z' 'a-z' | awk '!seen[$0]++' | paste -sd, -)
export ALLOWED_HOSTS

BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
exec "$BUN" src/server.ts
