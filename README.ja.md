# App Manager

[English](README.md) | 日本語

ローカルで起動するアプリ（bun / node / python / docker compose など）を、
「どのフォルダで・どのコマンドを・どのポートで」動かすかごと一元管理する Web UI です。
pm2 と Portainer の中間のような役割で、依存パッケージなし（Bun のみ）で動きます。
UI は英語で、スマホの画面幅にも対応しています。

## 起動

```bash
bun install   # 型定義のみ。実行には不要
bun start     # http://127.0.0.1:4949
```

| 環境変数 | 既定 | 説明 |
| --- | --- | --- |
| `PORT` | `4949` | 待ち受けポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス。任意のコマンドを実行できるため、信頼できないネットワークに公開しないこと |
| `APP_MANAGER_DATA` | `./data` | 設定・状態・ログの保存先 |
| `ALLOWED_HOSTS` | — | 追加で許可する Host ヘッダー（カンマ区切り）。`host:port` か、ポートを問わない `host` を指定 |

> ターミナルから `bun start` したときの環境変数（PATH など）が、管理下のコマンドにも引き継がれます。
> nvm / pyenv などはそのシェルで有効になっている前提です。

## 別のマシンから使う（Tailscale）

App Manager には認証の仕組みがありません。他のマシンから使うときは、Tailscale のような
自分だけが入れるネットワーク越しにしてください。方法は 2 つあります。

### A. `tailscale serve` を使う（推奨）

App Manager は 127.0.0.1 で待ち受けたまま、Tailscale が tailnet 内にだけ HTTPS で中継します。
HTTPS になるので、ブラウザのクリップボード API などもそのまま使えます。

```bash
# 1. マシン名を確認（例: mymac.tail1234.ts.net）
tailscale status --self

# 2. その名前を許可して起動
ALLOWED_HOSTS=mymac.tail1234.ts.net bun start

# 3. 別のターミナルで、tailnet 内に公開（バックグラウンドで常駐）
tailscale serve --bg 4949
```

別のマシンから `https://mymac.tail1234.ts.net` を開きます。

- 初回は tailnet の HTTPS 証明書を有効にするよう案内されることがあります。案内の URL から有効にしてください
- 公開をやめるときは `tailscale serve reset`
- macOS の Tailscale アプリでは、CLI は `/Applications/Tailscale.app/Contents/MacOS/Tailscale` にあります

### B. Tailscale の IP で直接待ち受ける

`tailscale serve` を使わない場合は、Tailscale のインターフェースだけで待ち受けます（LAN には公開されません）。

```bash
TS_IP=$(tailscale ip -4)   # 例: 100.64.0.1
HOST=$TS_IP ALLOWED_HOSTS=$TS_IP,mymac,mymac.tail1234.ts.net bun start
```

別のマシンから `http://100.64.0.1:4949`（MagicDNS なら `http://mymac:4949`）を開きます。
通信は WireGuard で暗号化されますが、ブラウザからは HTTP として扱われます（コピー機能は代替手段で動きます）。

### C. LAN と Tailscale の両方から使う（Linux・自動起動）

`scripts/start-remote.sh` は `0.0.0.0` で待ち受け、LAN の IP・ホスト名と Tailscale の IP・名前を
自動で `ALLOWED_HOSTS` に入れて起動します。Tailscale はホストの `tailscale` CLI か、
docker の `tailscale` コンテナ（`TAILSCALE_CONTAINER` で変更可）から情報を取ります。

```bash
scripts/start-remote.sh            # その場で起動
scripts/install-service.sh         # systemd ユーザーサービスとして登録（ホスト再起動後も自動起動）
scripts/install-service.sh uninstall
journalctl --user -u app-manager -f   # ログ
```

- ログイン前でも起動するよう `loginctl enable-linger` を有効にします
- サービスはログインシェル（`bash -l` など）経由で起動するので、`.profile` の PATH が管理下のコマンドにも引き継がれます
- `KillMode=process` なので、サービスを再起動・停止しても App Manager から起動したアプリは止まりません
- LAN 内の誰でも任意のコマンドを実行できる状態になります。信頼できる LAN でのみ使ってください
- 追加のホスト名は `EXTRA_ALLOWED_HOSTS`（カンマ区切り）で指定できます

### 共通の注意

- tailnet に入っている全員（共有したデバイスを含む）が任意のコマンドを実行できる状態になります。
  必要に応じて Tailscale の ACL で、このマシンの 443 / 4949 番に接続できる人を絞ってください
- `Host not allowed: ...` と表示されたら、表示されたホスト名を `ALLOWED_HOSTS` に追加してください
- ポート番号のリンクは、App Manager を開いているホスト名（例: `http://mymac.tail1234.ts.net:3000`）を開きます。
  別のマシンから開けるのは、そのアプリが `0.0.0.0` か Tailscale の IP で待ち受けている場合だけです

## できること

- **アプリ = フォルダ** 単位で登録し、その下に **複数の起動コマンド** を持てます
  （例: `dev` = `bun run dev`、`prod` = `docker compose -f compose.prod.yml up -d --build`）
- コマンドの種類
  - **コマンド**: `$SHELL -c` で detached 起動。出力は `data/logs/<id>.log` に保存。
    App Manager を再起動してもプロセスは生き続け、PID で追跡を再開します。停止はプロセスグループごと SIGTERM → 5 秒後 SIGKILL。
  - **docker compose**: `up -d [--build]` / `down`。**Pull** ボタンで `docker compose pull` を実行でき、出力は Logs で確認できます。状態は `docker ps` の compose ラベル（作業フォルダ・設定ファイル・プロジェクト名）で判定します。
- **起動状態の可視化**
  - Running（起動中）/ Working（処理中）/ Stopped（停止）/ Crashed（異常終了）
  - **Running (external)**（管理外で起動中）: ターミナルなど App Manager 以外で起動したプロセスでも、
    そのアプリのフォルダで動いていて定義ポートを使っていれば検出します
- **ポート一覧**（`lsof` と `docker ps` から、いま LISTEN している全 TCP ポート）
  - どのプロセス / コンテナが、どのフォルダで、どのコマンドで使っているか
  - 判定: `Note` 同じアプリの別コマンドで共用 / `Warning` 複数アプリで同じポートを定義・登録外プロセスが使用中 / `Conflict` 同時に起動中
  - 起動ボタンを押したとき、定義ポートが使用中なら確認ダイアログを出します
  - **Register as app**: 登録外で動いているプロセス / compose コンテナから、起動フォルダ・コマンド・使用ポートを入力済みの状態で登録画面を開きます。
    そのフォルダがすでに登録済みなら **Add to app** になります（OS のデーモンなど cwd が `/` のものは対象外）
- **Inspect folder** で `package.json` の scripts、`compose*.yml` の ports、`manage.py` / FastAPI などから起動コマンドの候補を提案
- `cd <フォルダ> && <コマンド>` をワンクリックでコピー
- Web アプリとして Dock に追加できます（Safari: ファイル > Dock に追加 / Chrome: App Manager をインストール）。専用のアイコンが付きます

## データ

- `data/apps.json` … アプリ・コマンドの定義（手で編集しても OK。編集後は App Manager を再起動）
- `data/state.json` … 起動した PID など
- `data/logs/` … ログ（5MB を超えると起動時に `.log.1` へローテーション）

## Docker で動かさない理由

App Manager 自体をコンテナで動かすと、ホストの bun / node / python を起動できず、
ホストのポートやプロセス（`lsof`）も見えなくなるため、ホスト上で Bun で動かす構成にしています。
常駐させたい場合は launchd（`~/Library/LaunchAgents`）や `bun start` をターミナルで動かしておく運用を想定しています。

## 動作環境

macOS で動作を確認しています。`lsof` と `ps` を使うので Linux でも動く想定ですが、未検証です。Windows には対応していません。

## 構成

```
src/
  server.ts   HTTP API と静的ファイル配信（CSRF / DNS rebinding 対策あり）
  store.ts    apps.json / state.json の読み書き
  runner.ts   起動・停止・ログ（process / compose）
  system.ts   lsof・ps・docker ps によるスナップショット
  status.ts   設定と実態の突き合わせ、ポート重複・衝突の判定
  inspect.ts  フォルダから起動コマンド候補を推測
public/       UI（ビルド不要の素の HTML/CSS/JS）
```
