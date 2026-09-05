// ============================================
// 無料版 Worker のローカル動作確認 — tools/test-free-worker.mjs
//
// KV をインメモリで、Anthropic API をスタブで差し替えて上限まわりの状態機械を
// 検証する。API を叩かないので課金されない。
//
//   npm run test:free
//
// 確認するのは「無料版で新しく作った部分」= 上限・初日枠・全体枠・緊急停止・
// fail-closed・入力検証の6点。占いの生成内容そのものは有料版と同じ READINGS
// を通るため、ここでは見ない（モデル差の検証は check:free-fidelity が担う）。
// ============================================

import worker from "../free/worker.js";

// ── インメモリ KV
function makeKv(initial = {}, { failing = false } = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) {
      if (failing) throw new Error("KV unavailable");
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      if (failing) throw new Error("KV unavailable");
      store.set(key, value);
    },
  };
}

// ── Anthropic API のスタブ（呼ばれた回数も数える）
let apiCalls = 0;
globalThis.fetch = async () => {
  apiCalls++;
  return new Response(JSON.stringify({
    content: [{ type: "text", text: "（テスト応答）星の巡りは穏やかです。" }],
    usage: { input_tokens: 300, output_tokens: 400 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const ANON = "a".repeat(32);

function req(path, { method = "POST", anon = ANON, body = {} } = {}) {
  return new Request(`https://free.example.com${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Anon-Id": anon,
      "CF-Connecting-IP": "203.0.113.9",
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

const call = (path, kv, opts) =>
  worker.fetch(req(path, opts), { FREE_KV: kv, FREE_ANTHROPIC_API_KEY: "test-key" });

const TAROT = { card: "星", orientation: "正位置" };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const jstToday = () =>
  new Date(Date.now() + 9 * 3600 * 1000).toISOString().split("T")[0];

// ── 1. 初日は5回
console.log("\n[1] 初回訪問日の枠は5回");
{
  const kv = makeKv();
  const s = await (await call("/free/status", kv, { method: "GET" })).json();
  check("status が remaining=5 / isFirstDay=true", s.remaining === 5 && s.isFirstDay === true, JSON.stringify(s));
  check("提供数が29（palm-reading 除外）", s.actions.length === 29, `actions=${s.actions.length}`);
  check("palm-reading が含まれない", !s.actions.includes("palm-reading"));
}

// ── 2. 5回使い切ると6回目は 429
console.log("\n[2] 使い切り");
{
  const kv = makeKv();
  apiCalls = 0;
  const codes = [];
  for (let i = 0; i < 6; i++) {
    codes.push((await call("/free/mystic/tarot", kv, { body: TAROT })).status);
  }
  check("1〜5回目は200", codes.slice(0, 5).every(c => c === 200), codes.join(","));
  check("6回目は429", codes[5] === 429, codes.join(","));
  check("API 呼び出しは5回だけ（上限超過分は叩かない）", apiCalls === 5, `apiCalls=${apiCalls}`);
  const body = await (await call("/free/mystic/tarot", kv, { body: TAROT })).json();
  check("理由は user", body.reason === "user", JSON.stringify(body));
}

// ── 3. 2日目以降は3回
console.log("\n[3] 2日目以降の枠は3回");
{
  const kv = makeKv({ [`first:${ANON}`]: "2020-01-01" }); // 初回が過去日
  const s = await (await call("/free/status", kv, { method: "GET" })).json();
  check("remaining=3 / isFirstDay=false", s.remaining === 3 && s.isFirstDay === false, JSON.stringify(s));
}

// ── 4. 全体上限
console.log("\n[4] 全体上限 300回/日");
{
  const kv = makeKv({ [`g:${jstToday()}`]: "300" });
  const res = await call("/free/mystic/tarot", kv, { body: TAROT });
  const body = await res.json();
  check("429 で理由は global", res.status === 429 && body.reason === "global", `${res.status} ${JSON.stringify(body)}`);
  check("個人の枠が残っていても止まる", body.reason === "global");
}

// ── 5. 緊急停止スイッチ
console.log("\n[5] 緊急停止スイッチ（kill）");
{
  const kv = makeKv({ kill: "1" });
  const res = await call("/free/mystic/tarot", kv, { body: TAROT });
  const body = await res.json();
  check("429 で理由は closed", res.status === 429 && body.reason === "closed", `${res.status} ${JSON.stringify(body)}`);
}

// ── 6. KV 障害時は止まる（fail-closed）
console.log("\n[6] KV 障害時は通さない（fail-closed）");
{
  const kv = makeKv({}, { failing: true });
  apiCalls = 0;
  const res = await call("/free/mystic/tarot", kv, { body: TAROT });
  check("503 を返す", res.status === 503, `status=${res.status}`);
  check("API を叩かない", apiCalls === 0, `apiCalls=${apiCalls}`);
}

// ── 7. 入力検証
console.log("\n[7] 入力検証");
{
  const kv = makeKv();
  apiCalls = 0;
  check("匿名IDが不正なら400",
    (await call("/free/status", kv, { method: "GET", anon: "bad" })).status === 400);
  check("palm-reading は404",
    (await call("/free/mystic/palm-reading", kv, { body: { imageBase64: "x" } })).status === 404);
  check("未知の action は404",
    (await call("/free/mystic/not-a-reading", kv, { body: {} })).status === 404);
  check("必須項目が欠けていれば400",
    (await call("/free/mystic/tarot", kv, { body: {} })).status === 400);
  check("未来の生年月日は400",
    (await call("/free/mystic/star-reading", kv, { body: { birthdate: "2999-01-01" } })).status === 400);
  check("検証で弾いた分は API を叩かない", apiCalls === 0, `apiCalls=${apiCalls}`);
  check("検証で弾いた分は枠を消費しない",
    (await (await call("/free/status", kv, { method: "GET" })).json()).remaining === 5);
}

// ── 8. 正常系の応答
console.log("\n[8] 正常系");
{
  const kv = makeKv();
  const body = await (await call("/free/mystic/star-reading", kv, { body: { birthdate: "1990-05-15" } })).json();
  check("result が返る", typeof body.result === "string" && body.result.length > 0);
  check("確定値 extra が同梱される（星座）", body.sign === "牡牛座", `sign=${body.sign}`);
  check("残り回数を返す", body.remaining === 4, `remaining=${body.remaining}`);
}

console.log(`\n${"".padEnd(50, "-")}`);
console.log(`pass ${pass} / fail ${fail}`);
process.exit(fail > 0 ? 1 : 0);
