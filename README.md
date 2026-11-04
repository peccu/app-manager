# App Manager

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
| `HOST` | `127.0.0.1` | 待ち受けアドレス。任意のコマンドを実行できるため外部公開しないこと |
| `APP_MANAGER_DATA` | `./data` | 設定・状態・ログの保存先 |
| `ALLOWED_HOSTS` | — | `localhost:4949` 以外の Host ヘッダーを許可したい場合にカンマ区切りで指定 |

> ターミナルから `bun start` したときの環境変数（PATH など）が、管理下のコマンドにも引き継がれます。
> nvm / pyenv などはそのシェルで有効になっている前提です。

## できること

- **アプリ = フォルダ** 単位で登録し、その下に **複数の起動コマンド** を持てます
  （例: `dev` = `bun run dev`、`prod` = `docker compose -f compose.prod.yml up -d --build`）
- コマンドの種類
  - **コマンド**: `$SHELL -c` で detached 起動。出力は `data/logs/<id>.log` に保存。
    App Manager を再起動してもプロセスは生き続け、PID で追跡を再開します。停止はプロセスグループごと SIGTERM → 5 秒後 SIGKILL。
  - **docker compose**: `up -d [--build]` / `down`。状態は `docker ps` の compose ラベル（作業フォルダ・設定ファイル・プロジェクト名）で判定します。
- **起動状態の可視化**
  - Running（起動中）/ Working（処理中）/ Stopped（停止）/ Crashed（異常終了）
  - **Running (external)**（管理外で起動中）: ターミナルなど App Manager 以外で起動したプロセスでも、
    そのアプリのフォルダで動いていて定義ポートを使っていれば検出します
- **ポート一覧**（`lsof` と `docker ps` から、いま LISTEN している全 TCP ポート）
  - どのプロセス / コンテナが、どのフォルダで、どのコマンドで使っているか
  - 判定: `Note` 同じアプリの別コマンドで共用 / `Warning` 複数アプリで同じポートを定義・登録外プロセスが使用中 / `Conflict` 同時に起動中
  - 起動ボタンを押したとき、定義ポートが使用中なら確認ダイアログを出します
  - **Register as app**: 登録外で動いているプロセス / compose コンテナから、起動フォルダ・コマンド・使用ポートを入力済みの状態で登録画面を開きます。
    そのフォルダがすでに登録済みなら**Add to app** になります（OS のデーモンなど cwd が `/` のものは対象外）
- **Inspect folder** で `package.json` の scripts、`compose*.yml` の ports、`manage.py` / FastAPI などから起動コマンドの候補を提案
- `cd <フォルダ> && <コマンド>` をワンクリックでコピー

## データ

- `data/apps.json` … アプリ・コマンドの定義（手で編集しても OK。編集後は App Manager を再起動）
- `data/state.json` … 起動した PID など
- `data/logs/` … ログ（5MB を超えると起動時に `.log.1` へローテーション）

## Docker で動かさない理由

App Manager 自体をコンテナで動かすと、ホストの bun / node / python を起動できず、
ホストのポートやプロセス（`lsof`）も見えなくなるため、ホスト上で Bun で動かす構成にしています。
常駐させたい場合は launchd（`~/Library/LaunchAgents`）や `bun start` をターミナルで動かしておく運用を想定しています。

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
