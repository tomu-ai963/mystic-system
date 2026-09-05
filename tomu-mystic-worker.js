// ============================================
// とむMYSTIC — Worker.js (Full 30 endpoints)
// ES Module format for Cloudflare Workers
//
// モジュール構成（wrangler 内蔵 esbuild でバンドル）:
//   tomu-mystic-worker.js … エントリ（ルーティング・入力検証・履歴・コミュニティ・メール配信・法務ページ）
//   shared.js             … 共通ユーティリティ（レスポンス生成・検証・レートリミット・暗号・Claude API）
//   auth.js               … マジックリンク認証・セッション
//   stripe.js             … サブスク照会/登録・Checkout・Webhook
//   readings-data.js      … READINGS テーブル（占い定義の唯一の定義源）・確定計算・静的データ
//   kanji-strokes.js      … 漢字画数テーブル・五格計算
//   mcp.js                … MCP サーバー（system プロンプトは READINGS を参照）
// ============================================

// --------------------------------------------------------------------------
// データストア集約スキーマ（READINGS集約・整理）
// 占い結果の履歴は D1 集約テーブル readings（1占い=1行）に正規化して集約する。
// 旧構成（KV history:<userId> のユーザー別JSON配列）からは Worker 側の
// 「読み取り時バックフィル」で無損失移行され、D1 未バインド/障害時は KV に
// フォールバックする。占い種別の定義は下記 READINGS コード表に一元化（cf. ab4badc）。
//
// D1: tomu-mystic-db / binding MYSTIC_DB（migrations/0001_create_readings.sql）
//   readings(id, user_id, action, result, extra(JSON), created_at)  ← 占い結果履歴（集約先）
//
// KV: MYSTIC_SUBSCRIPTIONS（id 5e1c00…）— セッション/設定/コミュニティ + 履歴の移行元
//   <userId>                         → サブスクリプション { active, plan, expires, createdAt }
//   session:<sessionId>              → ログインセッション
//   mail_pref:<userId>               → 毎朝メール設定 { enabled, hour, apps }
//   profile:<userId>                 → プロフィール { name, birthdate, ... }
//   history:<userId>                 → 旧・占い結果履歴（D1へ移行。フォールバック/移行元として保持）
//   rate:<type>:<id>:<YYYY-MM-DD-HH> → レートリミットカウンタ（expirationTtl=3600）
//   stripe_sub:<subscriptionId>      → userId（Stripe継続課金/解約イベントの逆引き）
//   stripe_event:<eventId>           → Webhookイベント冪等記録（expirationTtl=86400）
//   feed:index / post:<id> / like:<postId>:<userId> → コミュニティ（みんなの占い結果）
//
// 占い種別の正規名（action）は ALLOWED_ACTIONS / READINGS のキーが正、
// 履歴・メール表示名は DAILY_MAIL_APPS 等の表示テーブルが担う。
// --------------------------------------------------------------------------

import {
  CORS_HEADERS, jsonResponse, htmlResponse,
  validateInput,
  checkRateLimit, checkSubscription,
  callClaude, callClaudeVision, escapeHtml,
} from "./shared.js";
import { authenticate, handleRequestMagicLink, handleVerify, handleLogout, handleMe } from "./auth.js";
import { handleSubscriptionCheck, handleSubscriptionRegister, handleStripeCheckout, handleStripeWebhook } from "./stripe.js";
import {
  READINGS, DAILY_MAIL_APPS, MAIL_APP_TO_ACTION,
  getSunSign, TAROT_CARDS, RUNE_NAMES,
} from "./readings-data.js";
import { handleMcp } from "./mcp.js";
import {
  ALLOWED_ACTIONS, validateMysticBody,
} from "./mystic-validation.js";


export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      // プリフライト: クライアントが要求したヘッダーをそのまま許可（移行期の旧ヘッダーにも耐性）
      const reqHeaders = request.headers.get("Access-Control-Request-Headers");
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          ...(reqHeaders ? { "Access-Control-Allow-Headers": reqHeaders } : {}),
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return jsonResponse({ status: "とむMYSTIC Worker OK", endpoints: 30 });
    }

    try {
      // ── 認証（マジックリンク + Bearerセッション）
      if (path === "/auth/request-magic-link") return await handleRequestMagicLink(request, env);
      if (path === "/auth/verify")             return await handleVerify(request, env);
      if (path === "/auth/logout")             return await handleLogout(request, env);
      if (path === "/auth/me")                 return await handleMe(request, env);

      if (path.startsWith("/mystic/")) {
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

        const isSubscribed = await checkSubscription(userId, env);
        if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

        // 入力バリデーション（ハンドラ本体はオリジナルのbodyを再読込するためcloneで検証）
        const mysticAction = path.slice("/mystic/".length);
        let mysticBody;
        try { mysticBody = await request.clone().json(); } catch { mysticBody = {}; }
        if (!validateMysticBody(mysticAction, mysticBody)) {
          return jsonResponse({ error: "Invalid input" }, 400);
        }

        // レートリミット（AI呼び出し: ユーザーあたり 20回/時）
        if (!await checkRateLimit(env, "ai", userId)) {
          return jsonResponse({ error: "Too many requests" }, 429);
        }

        return await handleMysticRequest(mysticAction, mysticBody, env, userId);
      }

      if (path === "/api/mystic") {
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

        const isSubscribed = await checkSubscription(userId, env);
        if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

        const body = await request.json();
        const { action, ...rest } = body;
        if (!ALLOWED_ACTIONS.has(action)) return jsonResponse({ error: "Invalid input" }, 400);
        if (!validateMysticBody(action, rest)) return jsonResponse({ error: "Invalid input" }, 400);
        if (!await checkRateLimit(env, "ai", userId)) return jsonResponse({ error: "Too many requests" }, 429);
        return await handleMysticRequest(action, rest, env, userId);
      }

      if (path === "/subscription/check")    return await handleSubscriptionCheck(request, env);
      if (path === "/subscription/register") {
        if (request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) {
          return jsonResponse({ error: "Forbidden" }, 403);
        }
        return await handleSubscriptionRegister(request, env);
      }
      if (path === "/mail-pref")              return await handleMailPref(request, env);
      if (path === "/profile")                return await handleProfile(request, env);
      if (path === "/history" || path.startsWith("/history/")) return await handleHistory(request, env, path);
      if (path.startsWith("/community/")) return await handleCommunity(request, env, path);
      if (path === "/stripe/checkout")       return await handleStripeCheckout(request, env);
      if (path === "/webhook")               return await handleStripeWebhook(request, env);

      if (path === "/mcp")                   return await handleMcp(request, env);

      if (path === "/legal/tokushoho")       return htmlResponse(MYSTIC_TOKUSHOHO_HTML);
      if (path === "/legal/privacy")         return htmlResponse(MYSTIC_PRIVACY_HTML);

      return jsonResponse({ error: "Not Found" }, 404);

    } catch (err) {
      console.error("Unhandled error:", err && (err.stack || err.message));
      return jsonResponse({ error: "占いの取得に失敗しました。時間をおいて再度お試しください。" }, 500);
    }
  },

  // 毎時起動 → 全ユーザーをQueuesにジョブとして積む（配信本体はqueueコンシューマー）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyMail(env));
  },

  // Queueコンシューマー → 1ユーザーずつメール配信を処理
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const { userId, hour, today } = msg.body;
        await processDailyMailUser(userId, hour, today, env);
        msg.ack();
      } catch (err) {
        // 失敗時は自動リトライ（Queuesのデフォルト動作）
        console.error(`Queue処理失敗: ${err && err.message}`);
        msg.retry();
      }
    }
  },
};

// ============================================
// 毎朝の占いメール — 配信設定管理
// KVキー: mail_pref:<userId> → { enabled, apps, hour }
// ============================================

const MAIL_PREF_PREFIX = "mail_pref:";
const DEFAULT_MAIL_PREF = { enabled: false, apps: [], hour: 7 };

async function getMailPref(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(MAIL_PREF_PREFIX + userId);
    if (!data) return { ...DEFAULT_MAIL_PREF };
    const pref = JSON.parse(data);
    return {
      enabled: pref.enabled === true,
      apps: Array.isArray(pref.apps) ? pref.apps : [],
      hour: Number.isInteger(pref.hour) ? pref.hour : DEFAULT_MAIL_PREF.hour,
    };
  } catch {
    return { ...DEFAULT_MAIL_PREF };
  }
}

async function handleMailPref(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  if (request.method === "GET") {
    return jsonResponse({ pref: await getMailPref(userId, env) });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    // バリデーション: enabled=boolean / hour=0〜23整数 / apps=許可IDの配列
    if (!validateInput("bool", body.enabled)) return jsonResponse({ error: "Invalid input" }, 400);
    if (!validateInput("hour", body.hour)) return jsonResponse({ error: "Invalid input" }, 400);
    if (!Array.isArray(body.apps) || !body.apps.every(id => validateInput("appId", id))) {
      return jsonResponse({ error: "Invalid input" }, 400);
    }
    // レートリミット（ユーザーあたり 10回/時）
    if (!await checkRateLimit(env, "mailpref", userId)) {
      return jsonResponse({ error: "Too many requests" }, 429);
    }
    const pref = { enabled: body.enabled, apps: body.apps, hour: body.hour };
    await env.MYSTIC_SUBSCRIPTIONS.put(MAIL_PREF_PREFIX + userId, JSON.stringify(pref));
    return jsonResponse({ success: true, pref });
  }

  return jsonResponse({ error: "Method Not Allowed" }, 405);
}

// ============================================
// 占い履歴（集約テーブル D1 readings）
// 集約後: D1 テーブル readings に 1占い=1行で保存。
// 移行互換: D1 を主とし、未移行ユーザーは KV history:<userId> から読み取り時に
//          D1 へバックフィル（無損失）。D1 未バインド/障害時は KV にフォールバック。
// レスポンス形状（{action, result, createdAt, extra}）は旧構成と完全互換。
// ============================================

const HISTORY_PREFIX = "history:"; // 旧構成（KV）— フォールバック/移行元として保持
const HISTORY_MAX = 30;

function hasD1(env) { return !!(env && env.MYSTIC_DB); }
function safeJsonParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
function stripId(r) { return { action: r.action, result: r.result, createdAt: r.createdAt, extra: r.extra }; }

// D1 から新しい順に取得（id 付き・最大 HISTORY_MAX 件）
async function d1GetRows(env, userId) {
  const { results } = await env.MYSTIC_DB
    .prepare("SELECT id, action, result, extra, created_at FROM readings WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(userId, HISTORY_MAX).all();
  return (results || []).map(r => ({
    id: r.id, action: r.action, result: r.result, createdAt: r.created_at, extra: safeJsonParse(r.extra, {}),
  }));
}

// KV(旧構成)→D1 への読み取り時バックフィル（無損失移行）。list は新しい順。
async function d1Backfill(env, userId, list) {
  if (!list || !list.length) return;
  const stmt = env.MYSTIC_DB.prepare(
    "INSERT INTO readings (user_id, action, result, extra, created_at) VALUES (?, ?, ?, ?, ?)");
  // 古い順に INSERT して id 昇順＝時系列にそろえる
  const batch = [...list].reverse().map(e =>
    stmt.bind(userId, e.action, e.result, JSON.stringify(e.extra || {}), e.createdAt || new Date().toISOString()));
  await env.MYSTIC_DB.batch(batch);
}

// 旧 KV 構成の取得/保存（フォールバック用）
async function kvGetHistory(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(HISTORY_PREFIX + userId);
    if (!data) return [];
    const list = JSON.parse(data);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
async function kvSaveHistory(env, userId, entry) {
  try {
    const list = await kvGetHistory(userId, env);
    list.unshift(entry);
    if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
    await env.MYSTIC_SUBSCRIPTIONS.put(HISTORY_PREFIX + userId, JSON.stringify(list));
  } catch (err) {
    console.error(`履歴保存失敗(KV) (${userId}): ${err && err.message}`);
  }
}

async function getHistory(userId, env) {
  if (hasD1(env)) {
    try {
      const rows = await d1GetRows(env, userId);
      if (rows.length > 0) return rows.map(stripId);
      // D1 が空 → 未移行ユーザーの可能性。KV にあれば読み取り時バックフィル。
      const legacy = await kvGetHistory(userId, env);
      if (legacy.length > 0) {
        try { await d1Backfill(env, userId, legacy); } catch (e) { console.error("D1バックフィル失敗:", e && e.message); }
        return legacy;
      }
      return [];
    } catch (err) {
      console.error(`D1履歴取得失敗, KVフォールバック (${userId}): ${err && err.message}`);
      return await kvGetHistory(userId, env);
    }
  }
  return await kvGetHistory(userId, env);
}

// 占い結果を履歴へ追加（新しい順）。HISTORY_MAX 超過分は古いものから破棄。
// 保存失敗は占い結果の返却を妨げない（ベストエフォート）。
async function saveHistory(env, userId, entry) {
  if (hasD1(env)) {
    try {
      await env.MYSTIC_DB.prepare(
        "INSERT INTO readings (user_id, action, result, extra, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(userId, entry.action, entry.result, JSON.stringify(entry.extra || {}), entry.createdAt || new Date().toISOString())
        .run();
      // HISTORY_MAX 超過分（古い順）を削除してストレージ肥大を防止
      await env.MYSTIC_DB.prepare(
        "DELETE FROM readings WHERE user_id = ? AND id NOT IN (SELECT id FROM readings WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)")
        .bind(userId, userId, HISTORY_MAX).run();
      return;
    } catch (err) {
      console.error(`D1履歴保存失敗, KVフォールバック (${userId}): ${err && err.message}`);
    }
  }
  await kvSaveHistory(env, userId, entry);
}

// GET /history          → 履歴一覧
// DELETE /history/:index → index 番目（新しい順・0始まり）を1件削除
async function handleHistory(request, env, path) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  if (path === "/history") {
    if (request.method !== "GET") return jsonResponse({ error: "Method Not Allowed" }, 405);
    return jsonResponse({ history: await getHistory(userId, env) });
  }

  // /history/:index
  if (request.method !== "DELETE") return jsonResponse({ error: "Method Not Allowed" }, 405);

  const index = Number(path.slice("/history/".length));
  if (!Number.isInteger(index) || index < 0) return jsonResponse({ error: "Invalid input" }, 400);

  // レートリミット（ユーザーあたり 60回/時）
  if (!await checkRateLimit(env, "history", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }

  if (hasD1(env)) {
    try {
      let rows = await d1GetRows(env, userId);
      if (rows.length === 0) {
        // 未移行ユーザーは先に KV からバックフィルしてから削除
        const legacy = await kvGetHistory(userId, env);
        if (legacy.length > 0) { await d1Backfill(env, userId, legacy); rows = await d1GetRows(env, userId); }
      }
      if (index >= rows.length) return jsonResponse({ error: "Not Found" }, 404);
      await env.MYSTIC_DB.prepare("DELETE FROM readings WHERE id = ? AND user_id = ?")
        .bind(rows[index].id, userId).run();
      const after = (await d1GetRows(env, userId)).map(stripId);
      return jsonResponse({ success: true, history: after });
    } catch (err) {
      console.error(`D1履歴削除失敗, KVフォールバック (${userId}): ${err && err.message}`);
      // フォールスルー → KV
    }
  }

  const list = await kvGetHistory(userId, env);
  if (index >= list.length) return jsonResponse({ error: "Not Found" }, 404);
  list.splice(index, 1);
  try {
    await env.MYSTIC_SUBSCRIPTIONS.put(HISTORY_PREFIX + userId, JSON.stringify(list));
  } catch (err) {
    console.error(`履歴削除失敗 (${userId}): ${err && err.message}`);
    return jsonResponse({ error: "削除に失敗しました" }, 500);
  }
  return jsonResponse({ success: true, history: list });
}

// ============================================
// コミュニティ（みんなの占い結果）
// OriacleのSNS機能を移植。認証=既存Bearerセッション / サブスク必須。
// KV（MYSTIC_SUBSCRIPTIONS を流用）:
//   feed:index             → 投稿IDの配列（新しい順・最大 COMMUNITY_FEED_MAX 件）
//   post:<id>              → 投稿オブジェクト（TTL 90日）
//   like:<postId>:<userId> → いいね済みフラグ（TTL 90日・重複防止）
// 投稿IDは ULID（時系列ソート可能）。
// ============================================

const COMMUNITY_FEED_MAX = 100;
const COMMUNITY_POST_TTL = 90 * 24 * 60 * 60; // 90日
const COMMUNITY_APPNAME_MAX = 100;
const COMMUNITY_COMMENT_MAX = 200;

// Crockford base32（ULID用）
const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// 先頭10文字=50bitタイムスタンプ＋後16文字=80bitランダム
function generateULID() {
  let id = "";
  let t = Date.now();
  for (let i = 9; i >= 0; i--) {
    id = ULID_CHARS[t % 32] + id;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) {
    id += ULID_CHARS[Math.floor(Math.random() * 32)];
  }
  return id;
}

// 表示名（プロフィール登録名 → 無ければ匿名）。メールアドレスは公開しない。
function communityDisplayName(profile) {
  const name = (profile && typeof profile.name === "string") ? profile.name.trim() : "";
  return name || "匿名の旅人";
}

// /community/* 共通処理（認証＋サブスク必須）
async function handleCommunity(request, env, path) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  const isSubscribed = await checkSubscription(userId, env);
  if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

  const method = request.method;
  if (path === "/community/feed" && method === "GET")  return await handleCommunityFeed(env);
  if (path === "/community/post" && method === "POST") return await handleCommunityPost(request, env, userId);
  if (path === "/community/like" && method === "POST") return await handleCommunityLike(request, env, userId);
  if (path.startsWith("/community/post/") && method === "DELETE") {
    return await handleCommunityDelete(env, userId, path.slice("/community/post/".length));
  }
  return jsonResponse({ error: "Not Found" }, 404);
}

// GET /community/feed → 投稿一覧（新しい順）
async function handleCommunityFeed(env) {
  const feedRaw = await env.MYSTIC_SUBSCRIPTIONS.get("feed:index");
  if (!feedRaw) return jsonResponse({ posts: [] });
  let ids;
  try { ids = JSON.parse(feedRaw); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  const posts = await Promise.all(ids.map(async (id) => {
    const raw = await env.MYSTIC_SUBSCRIPTIONS.get(`post:${id}`);
    return raw ? JSON.parse(raw) : null;
  }));
  return jsonResponse({ posts: posts.filter(Boolean) });
}

// POST /community/post → 投稿作成
async function handleCommunityPost(request, env, userId) {
  if (!await checkRateLimit(env, "communityPost", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "Invalid input" }, 400);

  const appName = typeof body.appName === "string" ? body.appName.trim() : "";
  const resultText = typeof body.resultText === "string" ? body.resultText.trim() : "";
  const userComment = typeof body.userComment === "string" ? body.userComment.trim() : "";

  // appName: 非空・100文字以内 / resultText: 1〜1000文字（text検証を流用）/ userComment: 200文字以内
  if (!appName || appName.length > COMMUNITY_APPNAME_MAX) return jsonResponse({ error: "Invalid input" }, 400);
  if (!validateInput("text", resultText)) return jsonResponse({ error: "Invalid input" }, 400);
  if (userComment.length > COMMUNITY_COMMENT_MAX) return jsonResponse({ error: "Invalid input" }, 400);

  const profile = await getProfile(userId, env);
  const id = generateULID();
  const post = {
    id,
    userId,
    username: communityDisplayName(profile),
    appName,
    resultText,
    userComment,
    createdAt: new Date().toISOString(),
    likes: 0,
  };

  let feed;
  const feedRaw = await env.MYSTIC_SUBSCRIPTIONS.get("feed:index");
  try { feed = feedRaw ? JSON.parse(feedRaw) : []; } catch { feed = []; }
  if (!Array.isArray(feed)) feed = [];
  feed.unshift(id);
  if (feed.length > COMMUNITY_FEED_MAX) feed.length = COMMUNITY_FEED_MAX;

  await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.put(`post:${id}`, JSON.stringify(post), { expirationTtl: COMMUNITY_POST_TTL }),
    env.MYSTIC_SUBSCRIPTIONS.put("feed:index", JSON.stringify(feed)),
  ]);

  return jsonResponse({ post }, 201);
}

// POST /community/like → いいね（重複不可）
async function handleCommunityLike(request, env, userId) {
  if (!await checkRateLimit(env, "communityLike", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  const postId = (body && typeof body.postId === "string") ? body.postId : "";
  if (!postId) return jsonResponse({ error: "Invalid input" }, 400);

  const likeKey = `like:${postId}:${userId}`;
  const [alreadyLiked, postRaw] = await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.get(likeKey),
    env.MYSTIC_SUBSCRIPTIONS.get(`post:${postId}`),
  ]);
  if (alreadyLiked) return jsonResponse({ error: "すでにいいね済みです" }, 409);
  if (!postRaw) return jsonResponse({ error: "Not Found" }, 404);

  const post = JSON.parse(postRaw);
  post.likes = (post.likes || 0) + 1;

  await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.put(`post:${postId}`, JSON.stringify(post), { expirationTtl: COMMUNITY_POST_TTL }),
    env.MYSTIC_SUBSCRIPTIONS.put(likeKey, "1", { expirationTtl: COMMUNITY_POST_TTL }),
  ]);

  return jsonResponse({ likes: post.likes });
}

// DELETE /community/post/:id → 自分の投稿のみ削除
async function handleCommunityDelete(env, userId, id) {
  if (!id) return jsonResponse({ error: "Invalid input" }, 400);
  const raw = await env.MYSTIC_SUBSCRIPTIONS.get(`post:${id}`);
  if (!raw) return jsonResponse({ error: "Not Found" }, 404);
  const post = JSON.parse(raw);
  if (post.userId !== userId) return jsonResponse({ error: "Forbidden" }, 403);

  let feed = [];
  const feedRaw = await env.MYSTIC_SUBSCRIPTIONS.get("feed:index");
  try { feed = feedRaw ? JSON.parse(feedRaw) : []; } catch { feed = []; }
  feed = Array.isArray(feed) ? feed.filter((x) => x !== id) : [];

  await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.delete(`post:${id}`),
    env.MYSTIC_SUBSCRIPTIONS.put("feed:index", JSON.stringify(feed)),
  ]);

  return jsonResponse({ success: true });
}


// 占いリクエスト共通ハンドラ。
// READINGS を参照して「確定計算 → Claude 呼び出し → JSONレスポンス」を行う。
// 認証・サブスク・入力バリデーション・レートリミットは呼び出し側（fetch）で実施済み。
async function handleMysticRequest(action, body, env, userId) {
  const reading = READINGS[action];
  if (!reading) return jsonResponse({ error: "Not Found" }, 404);
  const built = reading.build(body);
  const system = built.system || reading.system;
  const result = reading.vision
    ? await callClaudeVision(env, system, built.imageBase64, built.mimeType)
    : await callClaude(env, system, built.user);

  // 占い結果を履歴に保存（result + extra のみ。imageBase64 等の入力は保存しない）
  if (userId) {
    await saveHistory(env, userId, {
      action,
      result,
      createdAt: new Date().toISOString(),
      extra: built.extra || {},
    });
  }

  return jsonResponse({ result, ...(built.extra || {}) });
}

// ============================================
// 毎朝の占いメール — 配信内容生成 & 送信
// ============================================


// ============================================
// プロフィール（生年月日・登録名）
// KVキー: profile:<userId> → { birthdate?, name? }
// メールのパーソナライズに使用。未設定でも占い配信は成立する。
// ============================================
const PROFILE_PREFIX = "profile:";

async function getProfile(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(PROFILE_PREFIX + userId);
    if (!data) return {};
    const p = JSON.parse(data);
    return (p && typeof p === "object" && !Array.isArray(p)) ? p : {};
  } catch {
    return {};
  }
}

const PROFILE_NAME_MAX = 50;

// GET  /profile → 現在のプロフィール（未設定なら {}）
// POST /profile → { birthdate?, name? } を検証して保存（既存値へマージ）
async function handleProfile(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  if (request.method === "GET") {
    return jsonResponse({ profile: await getProfile(userId, env) });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "Invalid input" }, 400);
    }

    // 提供されたフィールドのみ検証（birthdate は既存バリデーションを流用 / name は50文字以内・空文字NG）
    const update = {};
    if (body.birthdate !== undefined) {
      if (!validateInput("birthdate", body.birthdate)) return jsonResponse({ error: "Invalid input" }, 400);
      update.birthdate = body.birthdate;
    }
    if (body.name !== undefined) {
      if (typeof body.name !== "string") return jsonResponse({ error: "Invalid input" }, 400);
      const name = body.name.trim();
      if (name.length === 0 || name.length > PROFILE_NAME_MAX) return jsonResponse({ error: "Invalid input" }, 400);
      update.name = name;
    }
    if (Object.keys(update).length === 0) return jsonResponse({ error: "Invalid input" }, 400);

    // レートリミット（ユーザーあたり 10回/時）
    if (!await checkRateLimit(env, "profile", userId)) {
      return jsonResponse({ error: "Too many requests" }, 429);
    }

    const profile = { ...(await getProfile(userId, env)), ...update };
    await env.MYSTIC_SUBSCRIPTIONS.put(PROFILE_PREFIX + userId, JSON.stringify(profile));
    return jsonResponse({ success: true, profile });
  }

  return jsonResponse({ error: "Method Not Allowed" }, 405);
}

// プロフィール（登録名・生年月日→星座）からメール冒頭の挨拶文を組み立てる。
function buildMailGreeting(profile) {
  const name = (profile && typeof profile.name === "string") ? profile.name.trim() : "";
  const sign = (profile && validateInput("birthdate", profile.birthdate)) ? getSunSign(profile.birthdate) : "";
  const hello = name ? `${name}さん、おはようございます。` : "おはようございます。";
  const line = sign
    ? `今日の${sign}のあなたへ、星々からのメッセージをお届けします。`
    : "今日のあなたへ、星々からのメッセージをお届けします。";
  return `${hello}\n${line}`;
}

// メール用の占いを1件生成する。appId を READINGS のアクションへ対応づけ、
// 必要な入力（ランダムなカード/ルーン等）を組み立てて handleMysticRequest() で実行する。
// 履歴（history:<userId>）を汚さないため userId は渡さない。
async function generateMailReading(appId, today, env) {
  const action = MAIL_APP_TO_ACTION[appId];
  if (!action) return null;

  let title, body;
  switch (appId) {
    case "tarot_draw": {
      const card = TAROT_CARDS[Math.floor(Math.random() * TAROT_CARDS.length)];
      title = `タロット一枚引き — 「${card}」`;
      body = { card };
      break;
    }
    case "rune_reading": {
      const rune = RUNE_NAMES[Math.floor(Math.random() * RUNE_NAMES.length)];
      title = `ルーン占い — ${rune}`;
      body = { rune };
      break;
    }
    case "oracle_message":
      title = "今日のオラクルメッセージ";
      body = { feeling: `新しい一日（${today}）の始まりに、宇宙からのメッセージを受け取りたい。` };
      break;
    case "moon_journal":
      title = `月相ジャーナル — ${today}`;
      body = { today };
      break;
    default:
      return null;
  }

  const res = await handleMysticRequest(action, body, env);
  const data = await res.json().catch(() => ({}));
  if (!data || !data.result) throw new Error(data.error || "占い結果を取得できませんでした");
  return { title, body: data.result };
}

function buildDailyMailHtml(today, sections, greeting = "") {
  const sectionsHtml = sections.map(s => `
    <tr><td style="padding:0 28px 24px;">
      <div style="background:#11112a;border:1px solid #2a2a4a;border-radius:14px;padding:24px;">
        <p style="margin:0 0 10px;font-size:14px;letter-spacing:.08em;color:#f0d080;">${s.icon || "✦"} ${escapeHtml(s.title)}</p>
        <p style="margin:0;font-size:14px;line-height:1.9;color:#e8e0f0;white-space:pre-wrap;">${escapeHtml(s.body)}</p>
      </div>
    </td></tr>`).join("");

  const greetingHtml = greeting ? `
        <tr><td style="padding:0 28px 24px;">
          <p style="margin:0;font-size:14px;line-height:1.9;color:#e8e0f0;white-space:pre-wrap;text-align:center;">${escapeHtml(greeting)}</p>
        </td></tr>` : "";

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#05050f;font-family:'Hiragino Mincho ProN','Yu Mincho',Georgia,serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05050f;">
    <tr><td align="center" style="padding:36px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding:0 28px 28px;text-align:center;">
          <p style="margin:0;font-size:13px;letter-spacing:.3em;color:#c49bff;">✦ とむMYSTIC ✦</p>
          <p style="margin:8px 0 0;font-size:12px;letter-spacing:.15em;color:#8880a8;">${escapeHtml(today)} の占いをお届けします</p>
        </td></tr>
        ${greetingHtml}
        ${sectionsHtml}
        <tr><td style="padding:4px 28px 0;text-align:center;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:.1em;color:#8880a8;">配信設定の変更は とむMYSTIC マイページから行えます</p>
          <p style="margin:0;font-size:10px;letter-spacing:.15em;color:#8880a8;">© 2026 とむMYSTIC</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendDailyMail(env, to, today, sections, greeting = "") {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "とむMYSTIC <noreply@tomu-ai.dev>",
      to: [to],
      subject: `今日の占い ✨ ${today}`,
      html: buildDailyMailHtml(today, sections, greeting),
    }),
  });
  if (!res.ok) {
    console.error(`Resend送信失敗 (${to}): ${await res.text()}`);
  }
}

// ============================================
// 毎朝の占いメール — Cronによる配信処理
// Cronは全ユーザーを走査してQueuesにジョブを積むだけ。
// 実際のメール配信は queue コンシューマー（processDailyMailUser）が担う。
// hour / today は積んだ時点（Cron発火時刻）の値を各ジョブに含めて整合性を保つ。
// ============================================

function jstParts(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return { hour: jst.getUTCHours(), dateString: jst.toISOString().split("T")[0] };
}

async function runDailyMail(env) {
  if (!env.RESEND_API_KEY) return;

  const { hour: currentHour, dateString: today } = jstParts(new Date());

  let cursor;
  do {
    const list = await env.MYSTIC_SUBSCRIPTIONS.list({ prefix: MAIL_PREF_PREFIX, cursor });
    for (const key of list.keys) {
      const userId = key.name.slice(MAIL_PREF_PREFIX.length);
      await env.MAIL_QUEUE.send({ userId, hour: currentHour, today });
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

async function processDailyMailUser(userId, currentHour, today, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(MAIL_PREF_PREFIX + userId);
    if (!data) return;

    const pref = JSON.parse(data);
    if (!pref.enabled || pref.hour !== currentHour || !Array.isArray(pref.apps) || !pref.apps.length) return;

    const isSubscribed = await checkSubscription(userId, env);
    if (!isSubscribed) return;

    let email;
    try { email = atob(userId); } catch { return; }
    if (!email.includes("@")) return;

    // プロフィール（生年月日・登録名）を取得してパーソナライズ（未設定でも続行）
    const profile = await getProfile(userId, env);

    const sections = [];
    for (const appId of pref.apps) {
      const mailApp = DAILY_MAIL_APPS[appId];
      if (!mailApp) continue;
      try {
        const reading = await generateMailReading(appId, today, env);
        if (reading) sections.push({ ...reading, icon: mailApp.icon });
      } catch (err) {
        // AI生成失敗時はその占いをスキップし、他の占い・メール送信は続行
        console.error(`占い生成失敗 [${appId}] (${email}): ${err.message}`);
      }
    }
    if (!sections.length) return;

    await sendDailyMail(env, email, today, sections, buildMailGreeting(profile));
  } catch (err) {
    console.error(`メール配信処理エラー (${userId}): ${err.message}`);
  }
}

const MYSTIC_LEGAL_STYLE = `<style>
:root {
  --bg: #05050f;
  --surface: #0d0d1e;
  --card: #11112a;
  --border: #2a2a4a;
  --accent: #c49bff;
  --accent2: #7ec8e3;
  --gold: #f0d080;
  --text: #e8e0f0;
  --muted: #8880a8;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', Georgia, serif;
  line-height: 1.8;
}
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse at 20% 50%, rgba(100,60,180,.12) 0%, transparent 60%),
    radial-gradient(ellipse at 80% 20%, rgba(60,120,200,.10) 0%, transparent 50%);
  pointer-events: none;
  z-index: 0;
}
header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
  background: rgba(5,5,15,.9);
  backdrop-filter: blur(10px);
}
.logo {
  font-size: 1rem;
  letter-spacing: .25em;
  color: var(--accent);
  text-decoration: none;
  text-transform: uppercase;
}
main {
  position: relative;
  z-index: 1;
  max-width: 760px;
  margin: 0 auto;
  padding: 3rem 1.5rem 5rem;
}
h1 {
  font-size: 1.75rem;
  font-weight: 400;
  letter-spacing: 0.1em;
  color: var(--accent);
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
h2 {
  font-size: 1.05rem;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: var(--gold);
  margin: 2.5rem 0 0.75rem;
}
p { margin-bottom: 1rem; font-size: 0.875rem; color: var(--text); }
ul { margin: 0.5rem 0 1rem 1.4rem; font-size: 0.875rem; }
ul li { padding: 0.15rem 0; color: var(--text); }
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 3rem;
  font-size: 0.875rem;
}
th, td {
  padding: 1rem 1.2rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th {
  width: 34%;
  background: var(--card);
  font-weight: 400;
  color: var(--muted);
  letter-spacing: 0.04em;
}
td { background: var(--surface); color: var(--text); }
.effective-date { font-size: 0.8rem; color: var(--muted); margin-bottom: 2.5rem; }
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--accent);
  text-decoration: none;
  font-size: 0.85rem;
  letter-spacing: 0.04em;
  border-bottom: 1px solid transparent;
  transition: border-color .2s;
  margin-top: 2rem;
}
.back-link:hover { border-color: var(--accent); }
footer {
  position: relative;
  z-index: 1;
  border-top: 1px solid var(--border);
  padding: 2rem;
  text-align: center;
  font-size: 0.65rem;
  letter-spacing: 0.15em;
  color: var(--muted);
}
@media(max-width:640px){ main { padding: 2rem 1rem 4rem; } th { width: 40%; } }
</style>`;

const MYSTIC_LEGAL_NAV = `<header>
  <a href="https://tomu-ai963.github.io/tomu-mystic/" class="logo">✦ とむMYSTIC</a>
</header>`;

const MYSTIC_TOKUSHOHO_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>特定商取引法に基づく表記 — とむMYSTIC</title>
${MYSTIC_LEGAL_STYLE}
</head>
<body>
${MYSTIC_LEGAL_NAV}
<main>
  <h1>✦ 特定商取引法に基づく表記</h1>
  <table>
    <tr>
      <th>運営者・運営責任者</th>
      <td>藤山　博史</td>
    </tr>
    <tr>
      <th>所在地・電話番号</th>
      <td>請求があった場合には速やかに開示いたします</td>
    </tr>
    <tr>
      <th>メールアドレス</th>
      <td>Inverted.triangle.leef@gmail.com</td>
    </tr>
    <tr>
      <th>販売価格</th>
      <td>月額 780円（税込）</td>
    </tr>
    <tr>
      <th>支払方法</th>
      <td>クレジットカード（Stripe決済）</td>
    </tr>
    <tr>
      <th>サービス提供時期</th>
      <td>決済完了後即時</td>
    </tr>
    <tr>
      <th>返金・キャンセル</th>
      <td>月途中のキャンセルによる返金は行いません</td>
    </tr>
  </table>
  <a href="https://tomu-ai963.github.io/tomu-mystic/" class="back-link">← トップページに戻る</a>
</main>
<footer>© 2026 とむMYSTIC. All rights reserved.</footer>
</body>
</html>`;

const MYSTIC_PRIVACY_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>プライバシーポリシー — とむMYSTIC</title>
${MYSTIC_LEGAL_STYLE}
</head>
<body>
${MYSTIC_LEGAL_NAV}
<main>
  <h1>✦ プライバシーポリシー</h1>
  <p class="effective-date">制定日：2026年1月1日</p>

  <p>とむMYSTIC（以下「本サービス」）は、ユーザーの個人情報の取り扱いについて以下のとおり定めます。</p>

  <h2>1. 収集する個人情報</h2>
  <p>本サービスは、以下の情報を収集する場合があります。</p>
  <ul>
    <li>メールアドレス（ログイン・サブスクリプション管理・お問い合わせ時）</li>
    <li>決済関連情報（Stripe社を通じた処理。カード番号等はStripe社が管理し、本サービスは保持しません）</li>
    <li>サービス利用状況（AI機能の利用回数・プラン情報）</li>
  </ul>

  <h2>2. 利用目的</h2>
  <p>収集した個人情報は、以下の目的で利用します。</p>
  <ul>
    <li>本サービスの提供・運営・改善</li>
    <li>サブスクリプションプランの管理</li>
    <li>利用制限・不正利用の検知</li>
    <li>お問い合わせへの対応</li>
    <li>重要なお知らせの送信</li>
  </ul>

  <h2>3. 第三者への提供</h2>
  <p>本サービスは、以下の場合を除き、個人情報を第三者に提供しません。</p>
  <ul>
    <li>法令に基づき開示が必要な場合</li>
    <li>ユーザーの同意がある場合</li>
  </ul>
  <p>なお、本サービスは以下の外部サービスを利用しています。</p>
  <ul>
    <li>Stripe, Inc.（決済処理）</li>
    <li>Anthropic, PBC（AI機能）</li>
    <li>Cloudflare, Inc.（インフラ・ホスティング）</li>
  </ul>

  <h2>4. Cookie・アクセス解析</h2>
  <p>本サービス独自のアクセス解析ツールは現時点では導入していません。</p>

  <h2>5. 個人情報の管理</h2>
  <p>収集した個人情報は、Cloudflare Workers KVにて管理し、適切なアクセス制御を実施しています。サービス退会後、不要となった情報は速やかに削除します。</p>

  <h2>6. ポリシーの変更</h2>
  <p>本ポリシーの内容は、法令の改正やサービス変更に応じて予告なく変更する場合があります。変更後の内容は、本ページに掲載した時点から効力を生じます。</p>

  <h2>7. お問い合わせ</h2>
  <p>個人情報の取り扱いに関するお問い合わせは、下記メールアドレスまでご連絡ください。</p>
  <p>Inverted.triangle.leef@gmail.com</p>

  <a href="https://tomu-ai963.github.io/tomu-mystic/" class="back-link">← トップページに戻る</a>
</main>
<footer>© 2026 とむMYSTIC. All rights reserved.</footer>
</body>
</html>`;
