// ============================================
// とむMYSTIC — stripe.js
// サブスクリプション照会/登録・Stripe Checkout・Webhook（署名検証/冪等化）
// ============================================

import {
  jsonResponse, checkRateLimit, checkSubscription,
  isValidUserId, isValidPlan, isAllowedRedirectUrl,
  hmacHex, timingSafeEqual,
} from "./shared.js";
import { authenticate } from "./auth.js";

// POST /subscription/check（Bearer認証必須）
// 認証ユーザー自身の課金状況のみ返す。無認証時代の互換で body.userId を受けるが、
// 本人以外を指定した場合は 403（他人の課金状況を照会できるプライバシーリークの防止）。
async function handleSubscriptionCheck(request, env) {
  const authedUserId = await authenticate(request, env);
  if (!authedUserId) return jsonResponse({ error: "認証が必要です" }, 401);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  if (body && typeof body === "object" && body.userId !== undefined && body.userId !== authedUserId) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }
  const isSubscribed = await checkSubscription(authedUserId, env);
  return jsonResponse({ subscribed: isSubscribed });
}

async function handleSubscriptionRegister(request, env) {
  let parsed;
  try { parsed = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  if (!parsed || typeof parsed !== "object" || !isValidUserId(parsed.userId)) {
    return jsonResponse({ error: "Invalid userId" }, 400);
  }
  if (!isValidPlan(parsed.plan)) {
    return jsonResponse({ error: "Invalid plan" }, 400);
  }
  const { userId, plan } = parsed;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 1);
  await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
    active: true,
    plan: plan || "mystic",
    expires: expires.toISOString(),
    createdAt: new Date().toISOString(),
  }));
  return jsonResponse({ success: true });
}

// ============================================
// Stripe Checkout セッション作成
// ============================================

async function handleStripeCheckout(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);
  // レートリミット（外部Stripe API呼び出し: ユーザーあたり 10回/時）
  if (!await checkRateLimit(env, "stripe", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  const { successUrl, cancelUrl } = body || {};
  // success/cancel は外部リダイレクト先。許可オリジン以外はオープンリダイレクト/XSS防止のため弾く。
  const selfOrigin = new URL(request.url).origin;
  if (!isAllowedRedirectUrl(successUrl, selfOrigin) || !isAllowedRedirectUrl(cancelUrl, selfOrigin)) {
    return jsonResponse({ error: "Invalid redirect URL" }, 400);
  }

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "payment_method_types[]": "card",
      "mode": "subscription",
      "line_items[0][price]": env.MYSTIC_PRICE_ID,
      "line_items[0][quantity]": "1",
      "metadata[userId]": userId,
      "success_url": successUrl,
      "cancel_url": cancelUrl,
    }),
  });

  const session = await res.json();
  if (!res.ok) return jsonResponse({ error: session.error?.message || "Stripe エラー" }, 500);
  return jsonResponse({ url: session.url });
}

// ============================================
// Stripe Webhook 受信・サブスクのライフサイクル管理
// 対応イベント（STRIPE_EVENT_HANDLERS）:
//   checkout.session.completed  → 初回決済: サブスク有効化＋逆引きキー保存
//   invoice.payment_succeeded   → 継続課金: expires を課金期間終了日に同期
//   customer.subscription.deleted → 解約: active=false で即失効
// invoice/subscription イベントには userId が載らないため、
// stripe_sub:<subscriptionId> → userId の逆引きキーで突合する。
// 逆引きキー導入前の既存サブスクは KV 走査（無プレフィックスの userId キーのみ）
// で突合し、見つかれば逆引きキーを書いて自己修復する。
// ============================================

const STRIPE_SUB_PREFIX = "stripe_sub:";

// Webhook イベントの冪等記録: stripe_event:<eventId> → "1"（TTL 24時間）
const STRIPE_EVENT_PREFIX = "stripe_event:";
const STRIPE_EVENT_TTL_SECONDS = 24 * 60 * 60;

// 既存のサブスクリプション情報（userId 直キー）を読む。壊れていれば {}。
async function getKvSubscription(env, userId) {
  try {
    const raw = await env.MYSTIC_SUBSCRIPTIONS.get(userId);
    const sub = raw ? JSON.parse(raw) : null;
    return (sub && typeof sub === "object" && !Array.isArray(sub)) ? sub : {};
  } catch {
    return {};
  }
}

// invoice からサブスクリプションIDを取り出す。
// 旧APIバージョンは invoice.subscription（文字列）、
// 2025年以降のAPIバージョンは invoice.parent.subscription_details.subscription。
function stripeInvoiceSubscriptionId(invoice) {
  if (typeof invoice?.subscription === "string" && invoice.subscription) return invoice.subscription;
  const nested = invoice?.parent?.subscription_details?.subscription;
  if (typeof nested === "string" && nested) return nested;
  if (nested && typeof nested.id === "string") return nested.id; // expand されている場合
  return null;
}

// invoice の明細行から課金期間の終了日（unix秒）を取り出す。
// 継続課金のinvoiceでは行の period.end がサブスクの current_period_end と一致する。
function stripeInvoicePeriodEnd(invoice) {
  const lines = invoice?.lines?.data;
  if (!Array.isArray(lines) || !lines.length) return null;
  const ends = lines.map(l => l?.period?.end).filter(e => Number.isFinite(e) && e > 0);
  return ends.length ? Math.max(...ends) : null;
}

// subscriptionId → userId の突合。逆引きキー優先、なければKV走査で自己修復。
async function findUserIdByStripeSub(env, subscriptionId) {
  if (!subscriptionId) return null;
  const cached = await env.MYSTIC_SUBSCRIPTIONS.get(STRIPE_SUB_PREFIX + subscriptionId);
  if (cached) return cached;

  // 逆引きキー導入前のサブスク: userId キーは btoa(email) で ":" を含まない。
  // プレフィックス付きキー（session:/history:/rate: 等）は ":" を含むので除外できる。
  let cursor;
  do {
    const list = await env.MYSTIC_SUBSCRIPTIONS.list({ cursor });
    for (const key of list.keys) {
      if (key.name.includes(":")) continue;
      const sub = await getKvSubscription(env, key.name);
      if (sub.stripeSubscriptionId === subscriptionId) {
        // 自己修復: 次回以降は逆引きキーで即解決
        await env.MYSTIC_SUBSCRIPTIONS.put(STRIPE_SUB_PREFIX + subscriptionId, key.name);
        return key.name;
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return null;
}

const STRIPE_EVENT_HANDLERS = {
  // 初回決済完了 → サブスク有効化（従来ロジック）＋逆引きキー保存
  "checkout.session.completed": async (session, env) => {
    const userId = session.metadata?.userId;
    if (!userId) return;
    const expires = new Date();
    expires.setMonth(expires.getMonth() + 1);
    await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
      active: true,
      plan: "mystic",
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription,
      expires: expires.toISOString(),
      createdAt: new Date().toISOString(),
    }));
    if (session.subscription) {
      await env.MYSTIC_SUBSCRIPTIONS.put(STRIPE_SUB_PREFIX + session.subscription, userId);
    }
  },

  // 継続課金成功 → expires を課金期間の終了日に同期（期間が取れない場合は+1ヶ月）
  // 初回invoiceが checkout.session.completed より先に届いた場合は userId 未解決で
  // スキップされ得るが、checkout 側が有効化するので実害はない（次回更新で同期される）。
  "invoice.payment_succeeded": async (invoice, env) => {
    const subscriptionId = stripeInvoiceSubscriptionId(invoice);
    if (!subscriptionId) return; // サブスク由来でない invoice は対象外
    const userId = await findUserIdByStripeSub(env, subscriptionId);
    if (!userId) {
      console.error(`invoice.payment_succeeded: userId 未解決 (subscription=${subscriptionId})`);
      return;
    }
    const periodEnd = stripeInvoicePeriodEnd(invoice);
    const expires = periodEnd ? new Date(periodEnd * 1000) : new Date();
    if (!periodEnd) expires.setMonth(expires.getMonth() + 1);
    const sub = await getKvSubscription(env, userId);
    await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
      ...sub,
      active: true,
      plan: sub.plan || "mystic",
      stripeSubscriptionId: subscriptionId,
      expires: expires.toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  },

  // 解約（期間終了時・即時解約とも Stripe から届く）→ 即失効
  "customer.subscription.deleted": async (subscription, env) => {
    const userId = await findUserIdByStripeSub(env, subscription?.id);
    if (!userId) {
      console.error(`customer.subscription.deleted: userId 未解決 (subscription=${subscription?.id})`);
      return;
    }
    const sub = await getKvSubscription(env, userId);
    await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
      ...sub,
      active: false,
      canceledAt: new Date().toISOString(),
    }));
  },
};

async function handleStripeWebhook(request, env) {
  const signature = request.headers.get("stripe-signature");
  const body = await request.text();

  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET が未設定のため Webhook を拒否しました");
    return jsonResponse({ error: "Webhook が正しく設定されていません" }, 500);
  }
  const valid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return jsonResponse({ error: "署名が無効です" }, 400);

  const event = JSON.parse(body);

  // 冪等化: 同一イベントID（Stripeの再送・リプレイ）は再処理しない。
  // KV障害時は通過（各ハンドラは同一キーへの上書き書き込みなので二重処理しても実害が小さい）。
  const eventKey = typeof event.id === "string" && event.id ? STRIPE_EVENT_PREFIX + event.id : null;
  if (eventKey) {
    try {
      if (await env.MYSTIC_SUBSCRIPTIONS.get(eventKey)) {
        return jsonResponse({ received: true, duplicate: true });
      }
    } catch { /* ignore */ }
  }

  // ハンドラ内の例外はグローバルcatchで500になり、Stripe側の自動再送に乗る。
  const handler = STRIPE_EVENT_HANDLERS[event.type];
  if (handler) await handler(event.data?.object, env);

  // 既読マークは処理成功後に書く（処理前に書くとハンドラ失敗→再送時にイベントを取りこぼす）
  if (eventKey) {
    try {
      await env.MYSTIC_SUBSCRIPTIONS.put(eventKey, "1", { expirationTtl: STRIPE_EVENT_TTL_SECONDS });
    } catch { /* ignore */ }
  }

  return jsonResponse({ received: true });
}

// Stripe-Signature の許容時刻ずれ（前後5分）。超過した古い署名はリプレイとして拒否。
const STRIPE_SIG_TOLERANCE_SECONDS = 300;

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    // ヘッダー形式: "t=<unix秒>,v1=<hex>,v1=<hex>,..."（シークレットのローテーション中は v1 が複数並ぶ）
    const parts = sigHeader.split(",").map(p => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
    const t = parts.find(([k]) => k === "t")?.[1];
    const v1s = parts.filter(([k]) => k === "v1").map(([, v]) => v);
    if (!t || v1s.length === 0) return false;

    // リプレイ対策: タイムスタンプが許容幅を超えていたら署名計算前に拒否
    const ts = parseInt(t, 10);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > STRIPE_SIG_TOLERANCE_SECONDS) return false;

    const computed = await hmacHex(secret, `${t}.${payload}`);
    // 複数署名は全て検証し、いずれか一致でOK。比較はタイミングセーフ。
    return v1s.some(v1 => timingSafeEqual(computed, v1));
  } catch {
    return false;
  }
}

export { handleSubscriptionCheck, handleSubscriptionRegister, handleStripeCheckout, handleStripeWebhook };
