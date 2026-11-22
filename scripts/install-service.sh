#!/usr/bin/env bash
# App Manager を systemd のユーザーサービスとして登録し、ホスト起動時に自動起動させる（Linux 用）。
#
#   scripts/install-service.sh            登録して起動
#   scripts/install-service.sh uninstall  停止して登録解除
#
# ログイン前（ホスト再起動直後）でも起動させるため `loginctl enable-linger` を使う（sudo が要る場合あり）。
set -euo pipefail

NAME=app-manager
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"
LOGIN_SHELL=$(getent passwd "$USER" | cut -d: -f7)
LOGIN_SHELL=${LOGIN_SHELL:-/bin/bash}

if [ "${1:-}" = "uninstall" ]; then
  systemctl --user disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "uninstalled $NAME (linger は残しています。不要なら: sudo loginctl disable-linger $USER)"
  exit 0
fi

mkdir -p "$UNIT_DIR"
cat >"$UNIT" <<EOF
[Unit]
Description=App Manager (LAN / Tailscale)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=SHELL=$LOGIN_SHELL
# ログインシェル経由で起動し、PATH（bun / nvm / pyenv など）を管理下のコマンドにも引き継ぐ
ExecStart=$LOGIN_SHELL -lc 'exec "$ROOT/scripts/start-remote.sh"'
Restart=on-failure
RestartSec=5
# App Manager を再起動・停止しても、起動したアプリは止めない（PID で追跡を再開する設計のため）
KillMode=process

[Install]
WantedBy=default.target
EOF

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "enabling linger for $USER (ログインしていなくても起動させるため)"
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"
fi

systemctl --user daemon-reload
systemctl --user enable --now "$NAME"
systemctl --user restart "$NAME"
sleep 2
systemctl --user --no-pager status "$NAME" | head -n 12
echo
echo "ログ: journalctl --user -u $NAME -f"
