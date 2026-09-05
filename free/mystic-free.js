// ============================================
// とむMYSTIC 無料版 — free/mystic-free.js
//
// 有料版の mystic-login.js と同じ外部インターフェース（window.onMysticLogin /
// MysticAuth.callApi / MysticAuth.logout）を提供する差し替え用スクリプト。
// これにより apps/*.html を1行も書き換えずに無料版として動かせる
// （script src の書き換えは tools/build-free-pages.mjs が行う）。
//
// 有料版との差分:
//   - ログインなし。onMysticLogin は読み込み直後に呼ぶ
//   - 端末識別は localStorage の匿名ID（サーバ側の上限判定の主キー）
//   - 試した占いの進捗も localStorage。ログインがないためサーバには持てない
// ============================================

const FREE_WORKER_URL = "https://tomu-mystic-free-worker.inverted-triangle-leef.workers.dev";
const PAID_URL = "https://tomu-ai963.github.io/tomu-mystic/";

const ANON_KEY = "mystic_free_anon_id";
const TRIED_KEY = "mystic_free_tried";

// 無料版で提供する占いの総数（palm-reading を除く29）。
// 実数はサーバの /free/status が返す actions で上書きする
let totalActions = 29;

// ── 匿名ID。サーバ側の isValidAnonId が 32桁の16進を要求する
function getAnonId() {
  let id = null;
  try { id = localStorage.getItem(ANON_KEY); } catch { /* プライベートモード等 */ }
  if (!/^[0-9a-f]{32}$/.test(id || "")) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem(ANON_KEY, id); } catch { /* 保存できなくても1回は使える */ }
  }
  return id;
}

// ── 進捗（試した占い）。localStorage が使えない環境では進捗ゼロで動く
function getTried() {
  try {
    const v = JSON.parse(localStorage.getItem(TRIED_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function addTried(action) {
  const tried = getTried();
  if (tried.includes(action)) return tried;
  tried.push(action);
  try { localStorage.setItem(TRIED_KEY, JSON.stringify(tried)); } catch { /* 保存失敗は無視 */ }
  return tried;
}

// ── UI
function injectStyle() {
  const css = `
  .mf-bar{position:sticky;top:0;z-index:50;display:flex;gap:.75rem;align-items:center;
    justify-content:center;flex-wrap:wrap;padding:.5rem .9rem;font-size:.82rem;
    background:rgba(130,80,255,.10);border-bottom:1px solid rgba(130,80,255,.25);color:#b8a4ff}
  .mf-bar b{color:#e6dcff}
  .mf-overlay{position:fixed;inset:0;z-index:100;display:flex;align-items:center;
    justify-content:center;padding:1.2rem;background:rgba(8,4,20,.82)}
  .mf-modal{max-width:24rem;width:100%;padding:1.6rem;border-radius:.9rem;text-align:center;
    background:#150e2c;border:1px solid rgba(130,80,255,.35);color:#e6dcff;line-height:1.7}
  .mf-modal h2{margin:0 0 .8rem;font-size:1.05rem;color:#b8a4ff}
  .mf-modal p{margin:0 0 1.1rem;font-size:.88rem}
  .mf-btn{display:block;width:100%;padding:.7rem;margin-bottom:.5rem;border:0;cursor:pointer;
    border-radius:.5rem;font-size:.9rem;background:linear-gradient(135deg,#8250ff,#c04ad0);color:#fff}
  .mf-sub{display:block;width:100%;padding:.55rem;border:1px solid rgba(130,80,255,.35);
    cursor:pointer;border-radius:.5rem;font-size:.82rem;background:transparent;color:#b8a4ff}
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}

function renderBar(remaining, limit) {
  let bar = document.getElementById("mf-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "mf-bar";
    bar.className = "mf-bar";
    document.body.insertBefore(bar, document.body.firstChild);
  }
  const tried = getTried().length;
  bar.innerHTML =
    `<span>本日の残り <b>${remaining}</b> / ${limit} 回</span>` +
    `<span>試した占い <b>${tried}</b> / ${totalActions}</span>` +
    (tried >= totalActions ? `<span>🎉 全制覇</span>` : "");
}

// 上限に当たったときの案内。無料版には「明日を思い出させる手段」がないので、
// そこを有料版（毎朝メール）への導線にする
function showLimitModal(message, reason) {
  if (document.getElementById("mf-overlay")) return;
  const tried = getTried().length;
  const overlay = document.createElement("div");
  overlay.id = "mf-overlay";
  overlay.className = "mf-overlay";
  overlay.innerHTML = `
    <div class="mf-modal">
      <h2>✦ ${reason === "user" ? "本日分を使い切りました" : "ただいま受付を停止中です"}</h2>
      <p>${message}<br>ここまでで <b>${tried}</b> / ${totalActions} 個を試しました。</p>
      <p>続きを忘れずに受け取るなら、毎朝メールで届く有料版があります。</p>
      <button class="mf-btn" id="mf-go">とむMYSTIC を見る</button>
      <button class="mf-sub" id="mf-close">閉じる</button>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("mf-go").addEventListener("click", () => { location.href = PAID_URL; });
  document.getElementById("mf-close").addEventListener("click", () => overlay.remove());
}

// ── 有料版 mystic-login.js と同名・同シグネチャの公開API
const MysticAuth = {
  anonId: null,

  authHeaders() {
    return { "Content-Type": "application/json", "X-Anon-Id": this.anonId };
  },

  // apps/*.html は "/mystic/<action>" を渡してくる。無料版のパスへ読み替える
  async callApi(path, body) {
    const action = path.replace(/^\/mystic\//, "");
    const res = await fetch(`${FREE_WORKER_URL}/free/mystic/${action}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      renderBar(0, data.limit || 3);
      showLimitModal(data.error || "本日分を使い切りました。", data.reason || "user");
      throw new Error(data.error || "本日分を使い切りました");
    }
    if (!res.ok) throw new Error(data.error || `エラーが発生しました (${res.status})`);

    addTried(action);
    renderBar(data.remaining ?? 0, data.limit ?? 3);
    if ((data.remaining ?? 0) === 0) {
      showLimitModal(`本日分（${data.limit}回）を使い切りました。続きは明日また。`, "user");
    }
    return data;
  },

  // 有料版と同じ名前で存在させる（apps/*.html のログアウトボタンが呼ぶ）。
  // 無料版に「ログアウト」の概念はないため、進捗のリセットに割り当てる
  logout() {
    try { localStorage.removeItem(TRIED_KEY); } catch { /* 無視 */ }
  },
};

async function init() {
  injectStyle();
  MysticAuth.anonId = getAnonId();

  // 有料版のログアウトボタンは無料版では意味を持たないので隠す
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) logoutBtn.style.display = "none";

  let status = { remaining: 3, limit: 3, open: true };
  try {
    const res = await fetch(`${FREE_WORKER_URL}/free/status`, { headers: MysticAuth.authHeaders() });
    if (res.ok) status = await res.json();
  } catch { /* 取得失敗時は既定値で表示し、実際の判定はサーバ側に任せる */ }

  if (Array.isArray(status.actions) && status.actions.length) totalActions = status.actions.length;
  renderBar(status.remaining ?? 0, status.limit ?? 3);
  if (status.open === false) showLimitModal(status.message || "", status.reason || "user");

  // 無料版はログインを挟まないので、そのまま本体を表示させる
  if (typeof window.onMysticLogin === "function") window.onMysticLogin();
}

window.MysticAuth = MysticAuth;
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
