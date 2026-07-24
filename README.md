# とむMYSTIC

AI占いサービス。Cloudflare Worker＋静的フロントエンド（GitHub Pages）で構成。

Worker はモジュール分割されており、`tomu-mystic-worker.js`（エントリ）から
`shared.js` / `auth.js` / `stripe.js` / `readings-data.js` / `kanji-strokes.js` / `mcp.js`
を import し、デプロイ時に wrangler 内蔵の esbuild が1ファイルにバンドルする。
占いのプロンプト定義は `readings-data.js` の READINGS テーブルが唯一の定義源（MCPも参照）。

- Worker: `https://tomu-mystic-worker.inverted-triangle-leef.workers.dev`
- 構成の詳細（KV / D1 スキーマ）は `tomu-mystic-worker.js` 冒頭のコメントを参照

## デプロイ

デプロイは **wrangler 一本**（`wrangler.toml` が唯一の設定ソース）。

```powershell
npx wrangler deploy
# または
.\deploy_wrangler.ps1 -Token "your_cf_api_token"
```

> **注意**: 旧 `deploy.sh` / `deploy.ps1`（Cloudflare raw API への PUT）は廃止済み。
> raw API の PUT は `keep_bindings` / `keep_secrets` を指定しない限り既存の
> Secrets・バインディングを消してしまう事故リスクがあるため、復活させないこと。
> （関連: worker のリネームも新規 worker 扱いとなり Secrets が全消失する）

### デプロイ前後のシークレット確認手順

`wrangler deploy` は Secrets を保持するが、設定ドリフト検知のためデプロイ前後で一覧を確認する。

```powershell
npx wrangler secret list
```

以下のシークレットが揃っていること（`wrangler.toml` に書かず `wrangler secret put` で登録）:

| シークレット | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API（占い生成・Vision） |
| `AUTH_SECRET` | マジックリンク署名 |
| `RESEND_API_KEY` | メール送信（Resend） |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 署名検証 |
| `MYSTIC_PRICE_ID` | Stripe 価格ID |
| `MCP_TOKEN` | MCP エンドポイント認証 |
| `ADMIN_TOKEN` | 管理系エンドポイント認証 |

バインディング（KV `MYSTIC_SUBSCRIPTIONS` / D1 `MYSTIC_DB` / Queue `MAIL_QUEUE`）は
`wrangler.toml` に定義済みで、デプロイのたびに同内容が適用される。
デプロイ後は `npx wrangler deployments status` やダッシュボードで確認できる。

### Observability

`wrangler.toml` の `[observability] enabled = true` により Workers Logs（invocation logs）が有効。
Cloudflare Dashboard > Workers & Pages > tomu-mystic-worker > Logs で参照。

## コミュニティ機能について

コミュニティ（みんなの占い結果）は **独立した worker ではない**。

- API（`/community/feed|post|like` など）: `tomu-mystic-worker.js` 内に実装（本 `wrangler.toml` でデプロイされる）
- フロント: `community/index.html`（静的ページ、GitHub Pages 配信）

そのため community 用の個別 wrangler.toml / デプロイ手順は存在しない。
