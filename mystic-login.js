// ============================================
// MYSTIC SYSTEM — mystic-login.js
// ============================================

const WORKER_URL = "https://mystic-system-worker.tomu-ai963.workers.dev";

const MysticAuth = {
  // ローカルストレージのキー
  USER_ID_KEY: "mystic_user_id",
  SUBSCRIPTION_KEY: "mystic_subscription",

  // 現在のユーザーIDを取得
  getUserId() {
    return localStorage.getItem(this.USER_ID_KEY);
  },

  // メールアドレスをユーザーIDとして登録・ログイン
  async login(email) {
    if (!email || !email.includes("@")) {
      throw new Error("有効なメールアドレスを入力してください");
    }
    const userId = btoa(email.toLowerCase().trim());
    localStorage.setItem(this.USER_ID_KEY, userId);

    const subscribed = await this.checkSubscription(userId);
    localStorage.setItem(this.SUBSCRIPTION_KEY, subscribed ? "active" : "inactive");
    return { userId, subscribed };
  },

  // ログアウト
  logout() {
    localStorage.removeItem(this.USER_ID_KEY);
    localStorage.removeItem(this.SUBSCRIPTION_KEY);
  },

  // サブスクリプション状態を確認（Workerに問い合わせ）
  async checkSubscription(userId) {
    try {
      const res = await fetch(`${WORKER_URL}/subscription/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      return data.subscribed === true;
    } catch {
      return false;
    }
  },

  // サブスクリプション登録
  async register(userId, plan = "mystic") {
    const res = await fetch(`${WORKER_URL}/subscription/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, plan }),
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem(this.SUBSCRIPTION_KEY, "active");
    }
    return data;
  },

  // ログイン状態かどうか
  isLoggedIn() {
    return !!this.getUserId();
  },

  // サブスクリプションがアクティブか（キャッシュ確認）
  isSubscribed() {
    return localStorage.getItem(this.SUBSCRIPTION_KEY) === "active";
  },

  // Worker APIを呼び出す共通関数
  async callApi(endpoint, body) {
    const userId = this.getUserId();
    if (!userId) throw new Error("ログインが必要です");

    const res = await fetch(`${WORKER_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": userId,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "APIエラーが発生しました");
    return data;
  },
};

// ============================================
// ログインUIの制御
// ============================================

function renderLoginModal() {
  const existing = document.getElementById("mystic-login-modal");
  if (existing) return;

  const modal = document.createElement("div");
  modal.id = "mystic-login-modal";
  modal.innerHTML = `
    <div class="mystic-modal-overlay">
      <div class="mystic-modal-box">
        <div class="mystic-modal-star">✦</div>
        <h2 class="mystic-modal-title">MYSTIC SYSTEM</h2>
        <p class="mystic-modal-subtitle">星の導きへ、メールアドレスで入場</p>
        <input
          id="mystic-email-input"
          type="email"
          placeholder="your@email.com"
          class="mystic-modal-input"
          autocomplete="email"
        />
        <button id="mystic-login-btn" class="mystic-modal-btn">
          星の扉を開く
        </button>
        <p id="mystic-login-error" class="mystic-modal-error"></p>
        <p class="mystic-modal-note">
          ※ メールアドレスはユーザーIDとして使用されます
        </p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("mystic-login-btn").addEventListener("click", handleLoginClick);
  document.getElementById("mystic-email-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLoginClick();
  });
}

async function handleLoginClick() {
  const email = document.getElementById("mystic-email-input").value.trim();
  const errorEl = document.getElementById("mystic-login-error");
  const btn = document.getElementById("mystic-login-btn");

  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "確認中...";

  try {
    const { subscribed } = await MysticAuth.login(email);
    document.getElementById("mystic-login-modal").remove();

    if (!subscribed) {
      renderSubscriptionModal();
    } else {
      onLoginSuccess();
    }
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "星の扉を開く";
  }
}

function renderSubscriptionModal() {
  const modal = document.createElement("div");
  modal.id = "mystic-sub-modal";
  modal.innerHTML = `
    <div class="mystic-modal-overlay">
      <div class="mystic-modal-box">
        <div class="mystic-modal-star">☽</div>
        <h2 class="mystic-modal-title">サブスクリプション</h2>
        <p class="mystic-modal-subtitle">月額プランで星の神秘へフルアクセス</p>
        <ul class="mystic-plan-list">
          <li>✦ 星読み・タロット・数秘術</li>
          <li>✦ 守護星・魂の相性診断</li>
          <li>✦ 前世リーディング・夢解読</li>
          <li>✦ 月のジャーナル・宇宙のお告げ</li>
        </ul>
        <button id="mystic-subscribe-btn" class="mystic-modal-btn">
          今すぐ始める（デモ登録）
        </button>
        <p id="mystic-sub-error" class="mystic-modal-error"></p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("mystic-subscribe-btn").addEventListener("click", async () => {
    const btn = document.getElementById("mystic-subscribe-btn");
    btn.disabled = true;
    btn.textContent = "登録中...";

    try {
      await MysticAuth.register(MysticAuth.getUserId());
      document.getElementById("mystic-sub-modal").remove();
      onLoginSuccess();
    } catch (err) {
      document.getElementById("mystic-sub-error").textContent = err.message;
      btn.disabled = false;
      btn.textContent = "今すぐ始める（デモ登録）";
    }
  });
}

// ログイン後に呼ばれるコールバック（index.htmlから上書き可）
function onLoginSuccess() {
  if (typeof window.onMysticLogin === "function") {
    window.onMysticLogin();
  } else {
    location.reload();
  }
}

// ============================================
// ページ読み込み時の認証チェック
// ============================================

document.addEventListener("DOMContentLoaded", async () => {
  if (!MysticAuth.isLoggedIn()) {
    renderLoginModal();
    return;
  }

  // サブスクリプション状態をWorkerで再確認
  const userId = MysticAuth.getUserId();
  const subscribed = await MysticAuth.checkSubscription(userId);
  localStorage.setItem("mystic_subscription", subscribed ? "active" : "inactive");

  if (!subscribed) {
    renderSubscriptionModal();
  } else {
    onLoginSuccess();
  }
});
