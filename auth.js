// ============================================
// とむMYSTIC — auth.js
// ============================================

import {
  CORS_HEADERS, jsonResponse, htmlResponse,
  hmacHex, timingSafeEqual, b64urlEncode, b64urlDecode,
  validateInput, checkRateLimit, checkSubscription,
  ALLOWED_REDIRECT_ORIGINS, escapeHtml,
} from "./shared.js";

// ============================================
// 認証 — マジックリンク + Bearerセッション
// KVキー: session:<sessionId> → { userId, expiry }
// userId は既存と互換の btoa(email)。サブスク/メール設定のKVキーと一致させる。
// クロスサイト構成（フロント=github.io / API=workers.dev）のため Cookie ではなく
// Authorization: Bearer <sessionId> でセッションを伝送する。
// ============================================

const SESSION_PREFIX = "session:";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;   // 7日
const MAGIC_TOKEN_TTL_SECONDS = 15 * 60;        // 15分
// ALLOWED_REDIRECT_ORIGINS は shared.js が唯一の定義源（Stripe checkout と共用）
const DEFAULT_REDIRECT_URL = "https://tomu-ai963.github.io/tomu-mystic/";

// リダイレクト先を許可originに限定（オープンリダイレクト＋セッション漏洩の防止）
function sanitizeRedirect(raw) {
  try {
    if (!raw) return DEFAULT_REDIRECT_URL;
    const u = new URL(raw);
    if (ALLOWED_REDIRECT_ORIGINS.includes(u.origin)) return u.origin + u.pathname;
  } catch { /* ignore */ }
  return DEFAULT_REDIRECT_URL;
}

// HMAC署名付きマジックトークン（ステートレス、15分有効）
async function createMagicToken(env, email, redirect) {
  const payload = b64urlEncode(JSON.stringify({
    email,
    redirect,
    exp: Math.floor(Date.now() / 1000) + MAGIC_TOKEN_TTL_SECONDS,
  }));
  const sig = await hmacHex(env.AUTH_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifyMagicToken(env, token) {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmacHex(env.AUTH_SECRET, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  let obj;
  try { obj = JSON.parse(b64urlDecode(payload)); } catch { return null; }
  if (!obj || typeof obj.email !== "string" || !obj.email.includes("@")) return null;
  if (!obj.exp || obj.exp < Math.floor(Date.now() / 1000)) return null;
  return obj;
}

async function createSession(env, userId) {
  const sessionId = crypto.randomUUID();
  const expiry = Date.now() + SESSION_TTL_SECONDS * 1000;
  await env.MYSTIC_SUBSCRIPTIONS.put(
    SESSION_PREFIX + sessionId,
    JSON.stringify({ userId, expiry }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
  return sessionId;
}

function getBearer(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 全保護ルート共通の認証。成功時は userId（btoa(email)）を返す。
async function authenticate(request, env) {
  const sessionId = getBearer(request);
  if (!sessionId) return null;
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(SESSION_PREFIX + sessionId);
    if (!data) return null;
    const session = JSON.parse(data);
    if (session.expiry && session.expiry < Date.now()) {
      await env.MYSTIC_SUBSCRIPTIONS.delete(SESSION_PREFIX + sessionId);
      return null;
    }
    return session.userId || null;
  } catch {
    return null;
  }
}

// POST /auth/request-magic-link { email, redirect }
async function handleRequestMagicLink(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method Not Allowed" }, 405);
  if (!env.AUTH_SECRET) {
    console.error("AUTH_SECRET が未設定のため認証を実行できません");
    return jsonResponse({ error: "認証が正しく設定されていません" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
  if (!validateInput("email", email)) {
    return jsonResponse({ error: "Invalid input" }, 400);
  }
  // レートリミット（IPあたり 5回/時）— メアドを変えながらの発行乱用をIP単位で遮断
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (!await checkRateLimit(env, "magicIp", clientIp)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  // レートリミット（メアドあたり 5回/時）— メール送信前に確認
  if (!await checkRateLimit(env, "magic", email)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  const redirect = sanitizeRedirect(body.redirect);
  const token = await createMagicToken(env, email, redirect);
  const link = `${new URL(request.url).origin}/auth/verify?token=${encodeURIComponent(token)}`;
  await sendMagicLinkEmail(env, email, link);
  return jsonResponse({ success: true });
}

// GET /auth/verify?token=xxx → セッション発行 & フロントへリダイレクト
async function handleVerify(request, env) {
  if (!env.AUTH_SECRET) {
    console.error("AUTH_SECRET が未設定のため認証を実行できません");
    return htmlResponse(authResultPage("認証が正しく設定されていません。", false));
  }
  const token = new URL(request.url).searchParams.get("token");
  const obj = await verifyMagicToken(env, token);
  if (!obj) {
    return htmlResponse(authResultPage("リンクが無効か、有効期限が切れています。お手数ですが、もう一度ログインしてください。", false));
  }
  const userId = btoa(obj.email);            // 既存 identity と互換（KVキー一致）
  const sessionId = await createSession(env, userId);
  const redirect = sanitizeRedirect(obj.redirect);
  const dest = `${redirect}#mystic_sid=${encodeURIComponent(sessionId)}`;
  return new Response(null, { status: 302, headers: { Location: dest, ...CORS_HEADERS } });
}

// POST /auth/logout（Bearer）→ KVからセッション削除
async function handleLogout(request, env) {
  const sessionId = getBearer(request);
  if (sessionId) {
    try { await env.MYSTIC_SUBSCRIPTIONS.delete(SESSION_PREFIX + sessionId); } catch { /* ignore */ }
  }
  return jsonResponse({ success: true });
}

// GET /auth/me（Bearer）→ 現在のログイン状態とサブスク状態
async function handleMe(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);
  const subscribed = await checkSubscription(userId, env);
  let email = null;
  try { email = atob(userId); } catch { /* ignore */ }
  return jsonResponse({ userId, email, subscribed });
}

async function sendMagicLinkEmail(env, to, link) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "とむMYSTIC <noreply@tomu-ai.dev>",
      to: [to],
      subject: "✦ とむMYSTIC ログインリンク",
      html: buildMagicLinkHtml(link),
    }),
  });
  if (!res.ok) {
    console.error(`マジックリンク送信失敗 (${to}): ${await res.text()}`);
    throw new Error("メール送信に失敗しました");
  }
}

function buildMagicLinkHtml(link) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#05050f;font-family:'Hiragino Mincho ProN','Yu Mincho',Georgia,serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05050f;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="padding:0 28px 24px;text-align:center;">
          <p style="margin:0;font-size:13px;letter-spacing:.3em;color:#c49bff;">✦ とむMYSTIC ✦</p>
        </td></tr>
        <tr><td style="padding:0 28px 24px;">
          <div style="background:#11112a;border:1px solid #2a2a4a;border-radius:14px;padding:28px;text-align:center;">
            <p style="margin:0 0 20px;font-size:14px;line-height:1.9;color:#e8e0f0;">下のボタンから、とむMYSTICにログインできます。<br/>このリンクの有効期限は15分です。</p>
            <a href="${link}" style="display:inline-block;background:#c49bff;color:#05050f;text-decoration:none;font-size:14px;letter-spacing:.08em;padding:14px 32px;border-radius:10px;">星の扉を開く</a>
            <p style="margin:20px 0 0;font-size:11px;line-height:1.8;color:#8880a8;">このメールに心当たりがない場合は、破棄してください。</p>
          </div>
        </td></tr>
        <tr><td style="padding:4px 28px 0;text-align:center;">
          <p style="margin:0;font-size:10px;letter-spacing:.15em;color:#8880a8;">© 2026 とむMYSTIC</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function authResultPage(message, ok) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>とむMYSTIC</title></head>
<body style="margin:0;background:#05050f;color:#e8e0f0;font-family:'Hiragino Mincho ProN','Yu Mincho',Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
  <div style="max-width:420px;padding:2rem;text-align:center;">
    <p style="font-size:13px;letter-spacing:.3em;color:#c49bff;margin:0 0 1.5rem;">✦ とむMYSTIC ✦</p>
    <p style="font-size:14px;line-height:1.9;color:${ok ? "#e8e0f0" : "#ffb3b3"};">${escapeHtml(message)}</p>
    <p style="margin-top:2rem;"><a href="${DEFAULT_REDIRECT_URL}" style="color:#c49bff;font-size:13px;">トップへ戻る</a></p>
  </div>
</body></html>`;
}

export { authenticate, handleRequestMagicLink, handleVerify, handleLogout, handleMe };
