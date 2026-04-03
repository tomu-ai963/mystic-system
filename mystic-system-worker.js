// ============================================
// MYSTIC SYSTEM — Worker.js (Full 30 endpoints)
// ============================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/") {
    return jsonResponse({ status: "MYSTIC SYSTEM Worker OK", endpoints: 30 });
  }

  try {
    if (path.startsWith("/mystic/")) {
      const userId = request.headers.get("X-User-Id");
      if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

      const isSubscribed = await checkSubscription(userId);
      if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

      // ① 〜 ③ (既存)
      if (path === "/mystic/star-reading")      return handleStarReading(request);
      if (path === "/mystic/numerology")         return handleNumerology(request);
      if (path === "/mystic/guardian-star")      return handleGuardianStar(request);

      // ④ 〜 ⑪ (新規)
      if (path === "/mystic/nine-star-ki")       return handleNineStarKi(request);
      if (path === "/mystic/maya-calendar")      return handleMayaCalendar(request);
      if (path === "/mystic/animal-fortune")     return handleAnimalFortune(request);
      if (path === "/mystic/name-fortune")       return handleNameFortune(request);
      if (path === "/mystic/biorhythm")          return handleBiorhythm(request);
      if (path === "/mystic/moon-sign")          return handleMoonSign(request);
      if (path === "/mystic/eastern-stars")      return handleEasternStars(request);
      if (path === "/mystic/horoscope-deep")     return handleHoroscopeDeep(request);

      // ⑫ 〜 ⑮ (既存・新規)
      if (path === "/mystic/tarot")              return handleTarot(request);
      if (path === "/mystic/rune-reading")       return handleRuneReading(request);
      if (path === "/mystic/oracle-cards")       return handleOracleCards(request);
      if (path === "/mystic/nine-palace")        return handleNinePalace(request);

      // ⑯ 〜 ㉑ (既存・新規)
      if (path === "/mystic/past-life")          return handlePastLife(request);
      if (path === "/mystic/past-profession")    return handlePastProfession(request);
      if (path === "/mystic/soul-mission")       return handleSoulMission(request);
      if (path === "/mystic/spirit-animal")      return handleSpiritAnimal(request);
      if (path === "/mystic/aura-reading")       return handleAuraReading(request);
      if (path === "/mystic/chakra-check")       return handleChakraCheck(request);

      // ㉒ 〜 ㉚ (既存・新規)
      if (path === "/mystic/oracle-message")     return handleOracleMessage(request);
      if (path === "/mystic/dream-decoder")      return handleDreamDecoder(request);
      if (path === "/mystic/soul-compatibility") return handleSoulCompatibility(request);
      if (path === "/mystic/dream-colors")       return handleDreamColors(request);
      if (path === "/mystic/moon-journal")       return handleMoonJournal(request);
      if (path === "/mystic/cosmic-message")     return handleCosmicMessage(request);
      if (path === "/mystic/lucky-color")        return handleLuckyColor(request);
      if (path === "/mystic/crystal-guide")      return handleCrystalGuide(request);
      if (path === "/mystic/palm-reading")       return handlePalmReading(request);

      return jsonResponse({ error: "Not Found" }, 404);
    }

    if (path === "/subscription/check")    return handleSubscriptionCheck(request);
    if (path === "/subscription/register") return handleSubscriptionRegister(request);

    return jsonResponse({ error: "Not Found" }, 404);

  } catch (err) {
    return jsonResponse({ error: "サーバーエラー: " + err.message }, 500);
  }
}

// ============================================
// サブスクリプション管理
// ============================================

async function checkSubscription(userId) {
  try {
    const data = await MYSTIC_SUBSCRIPTIONS.get(userId);
    if (!data) return false;
    const sub = JSON.parse(data);
    if (sub.expires && new Date(sub.expires) < new Date()) return false;
    return sub.active === true;
  } catch { return false; }
}

async function handleSubscriptionCheck(request) {
  const { userId } = await request.json();
  const isSubscribed = await checkSubscription(userId);
  return jsonResponse({ subscribed: isSubscribed });
}

async function handleSubscriptionRegister(request) {
  const { userId, plan } = await request.json();
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 1);
  await MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
    active: true,
    plan: plan || "mystic",
    expires: expires.toISOString(),
    createdAt: new Date().toISOString(),
  }));
  return jsonResponse({ success: true });
}

// ============================================
// Claude API 呼び出し共通関数
// ============================================

async function callClaude(systemPrompt, userMessage, maxTokens = 800) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API Error");
  return data.content[0].text;
}

async function callClaudeVision(systemPrompt, imageBase64, mimeType = "image/jpeg", maxTokens = 800) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: "この手のひらの手相を占ってください。" },
        ],
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API Error");
  return data.content[0].text;
}

// ============================================
// ① 今日の星読み
// ============================================
async function handleStarReading(request) {
  const { birthdate } = await request.json();
  const result = await callClaude(
    `あなたは神秘的な星読み師です。生年月日から星座を判定し、今日の星の配置に基づいたメッセージを、詩的で神秘的な文体で日本語で届けてください。200〜300文字程度で。`,
    `生年月日：${birthdate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ② 数秘術診断
// ============================================
async function handleNumerology(request) {
  const { name, birthdate } = await request.json();
  const result = await callClaude(
    `あなたは数秘術の達人です。名前と生年月日からライフパスナンバーを計算し、魂の使命と今世のテーマを神秘的な文体で日本語で伝えてください。300文字程度で。`,
    `名前：${name}、生年月日：${birthdate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ③ 守護星特定
// ============================================
async function handleGuardianStar(request) {
  const { birthdate } = await request.json();
  const result = await callClaude(
    `あなたは星の守護者です。生年月日から守護星を特定し、今週の指針と開運アドバイスを神秘的な文体で日本語で届けてください。300文字程度で。`,
    `生年月日：${birthdate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ④ 九星気学診断
// ============================================
async function handleNineStarKi(request) {
  const { birthdate } = await request.json();
  const result = await callClaude(
    `あなたは九星気学の達人です。生年月日から本命星（一白水星〜九紫火星）を算出し、その人の本質・人生テーマ・今年の運気を神秘的な文体で日本語で伝えてください。350文字程度で。`,
    `生年月日：${birthdate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑤ マヤ暦診断
// ============================================
async function handleMayaCalendar(request) {
  const { birthdate } = await request.json();
  const result = await callClaude(
    `あなたはマヤ暦の占い師です。生年月日からツォルキン暦の太陽の紋章（キン番号）を算出し、その魂のエネルギー・使命・才能を神秘的な文体で日本語で伝えてください。350文字程度で。`,
    `生年月日：${birthdate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑥ 動物占い
// ============================================
async function handleAnimalFortune(request) {
  const { birthdate, bloodType } = await request.json();
  const result = await callClaude(
    `あなたは動物占いの達人です。生年月日と血液型から守護動物（虎・狼・猿・羊・象・チーター・コアラ・ライオン・黒ヒョウ・狸・子鹿・ペガサスの12種）を特定し、その性格・恋愛・今月の運勢を神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `生年月日：${birthdate}、血液型：${bloodType}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑦ 姓名判断
// ============================================
async function handleNameFortune(request) {
  const { fullName } = await request.json();
  const result = await callClaude(
    `あなたは姓名判断の達人です。漢字の氏名から天格・人格・地格・外格・総格の五格を鑑定し、運命の流れと今後の指針を神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `氏名（漢字）：${fullName}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑧ バイオリズム
// ============================================
async function handleBiorhythm(request) {
  const { birthdate, targetDate, physical, emotional, intellectual } = await request.json();
  const result = await callClaude(
    `あなたはバイオリズムを読む占い師です。指定日における肉体・感情・知性の3つのリズム値を受け取り、その人の今日のコンディションと取るべき行動指針を神秘的な文体で日本語で伝えてください。300文字程度で。`,
    `対象日：${targetDate}、肉体リズム：${physical}%、感情リズム：${emotional}%、知性リズム：${intellectual}%`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑨ ムーンサイン診断
// ============================================
async function handleMoonSign(request) {
  const { birthdate } = await request.json();
  const result = await callClaude(
    `あなたは月星座の占い師です。生年月日からムーンサイン（月星座）を読み解き、その人の内面・感情パターン・本当の欲求を神秘的な文体で日本語で伝えてください。300文字程度で。`,
    `生年月日：${birthdate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑩ 東洋星座×干支診断
// ============================================
async function handleEasternStars(request) {
  const { birthdate } = await request.json();
  const result = await callClaude(
    `あなたは東洋占星術の達人です。生年月日から干支（十二支×十干）と東洋星座を読み解き、その人の宿命・才能・今年の運勢を神秘的な文体で日本語で伝えてください。350文字程度で。`,
    `生年月日：${birthdate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑪ ホロスコープ詳細
// ============================================
async function handleHoroscopeDeep(request) {
  const { birthdate, birthTime, birthPlace } = await request.json();
  const result = await callClaude(
    `あなたは本格的な西洋占星術師です。生年月日・出生時刻・出生地から太陽星座・月星座・アセンダントを読み解き、その人の本質・魂のテーマ・今後の流れを神秘的で詳しい文体で日本語で伝えてください。500文字程度で。`,
    `生年月日：${birthdate}、出生時刻：${birthTime}、出生地：${birthPlace}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑫ タロット一枚引き
// ============================================
async function handleTarot(request) {
  const { card } = await request.json();
  const result = await callClaude(
    `あなたは神秘的なタロット占い師です。引いたカードのエネルギーと意味を、今この瞬間のユーザーへのメッセージとして神秘的な文体で日本語で届けてください。300文字程度で。`,
    `引いたカード：${card}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑬ ルーン占い
// ============================================
async function handleRuneReading(request) {
  const { rune } = await request.json();
  const result = await callClaude(
    `あなたは北欧の神秘を伝えるルーン占い師です。引いたルーン文字の古代的な意味・エネルギー・今の状況へのメッセージを神秘的な文体で日本語で届けてください。300文字程度で。`,
    `引いたルーン：${rune}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑭ オラクルカード
// ============================================
async function handleOracleCards(request) {
  const { theme, card } = await request.json();
  const result = await callClaude(
    `あなたは宇宙のメッセージを伝えるオラクルカードリーダーです。テーマとカードを受け取り、今この瞬間の宇宙からの神秘的なメッセージを詩的な日本語で届けてください。300文字程度で。`,
    `テーマ：${theme}、カード：${card}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑮ 九宮格診断
// ============================================
async function handleNinePalace(request) {
  const { selectedPalace, birthdate } = await request.json();
  const result = await callClaude(
    `あなたは九宮格（風水×気学）の達人です。生年月日と直感で選んだ宮（方位・エネルギー）から、今のあなたの運気の流れと開運の鍵を神秘的な文体で日本語で伝えてください。350文字程度で。`,
    `生年月日：${birthdate}、直感で選んだ宮：${selectedPalace}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑯ 前世診断
// ============================================
async function handlePastLife(request) {
  const { answers } = await request.json();
  const result = await callClaude(
    `あなたは魂の記憶を読む前世占い師です。ユーザーの回答から前世の物語を読み解き、魂が歩んできた旅を神秘的で詩的な日本語で語ってください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑰ 前世の職業診断
// ============================================
async function handlePastProfession(request) {
  const { answers } = await request.json();
  const result = await callClaude(
    `あなたは魂の過去を読む前世職業占い師です。ユーザーの回答から前世で担っていた職業・役割（神官、騎士、薬師、吟遊詩人など）を特定し、その魂が持つスキルと今世への影響を神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑱ 魂の使命診断
// ============================================
async function handleSoulMission(request) {
  const { answers } = await request.json();
  const result = await callClaude(
    `あなたは魂の設計図を読む占い師です。ユーザーの回答から今世の魂の使命・ライフテーマ・与えるべきギフトを読み解き、宇宙からのメッセージとして神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑲ 精霊動物診断
// ============================================
async function handleSpiritAnimal(request) {
  const { answers } = await request.json();
  const result = await callClaude(
    `あなたはシャーマニックな精霊動物ガイドです。ユーザーの回答から守護精霊動物を特定し、その動物のエネルギー・もたらすメッセージ・今週の指針を神秘的な文体で日本語で届けてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ⑳ オーラカラー診断
// ============================================
async function handleAuraReading(request) {
  const { answers } = await request.json();
  const result = await callClaude(
    `あなたはオーラを視るスピリチュアルリーダーです。ユーザーの回答から現在のオーラカラーを特定し、そのエネルギーの意味・魂の状態・今週の開運カラーを神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉑ チャクラ診断
// ============================================
async function handleChakraCheck(request) {
  const { answers } = await request.json();
  const result = await callClaude(
    `あなたはチャクラを診るエネルギーヒーラーです。ユーザーの回答から滞っているチャクラを特定し、そのチャクラの意味・解放のための実践・魂のメッセージを神秘的な文体で日本語で伝えてください。400文字程度で。`,
    `回答：${JSON.stringify(answers)}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉒ オラクルメッセージ
// ============================================
async function handleOracleMessage(request) {
  const { feeling } = await request.json();
  const result = await callClaude(
    `あなたは宇宙のチャネラーです。ユーザーの今の気持ちや状況を受け取り、宇宙からの神秘的なメッセージを詩的な日本語で届けてください。150〜200文字程度で。`,
    `今の気持ち・状況：${feeling}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉓ 夢解読AI
// ============================================
async function handleDreamDecoder(request) {
  const { dream } = await request.json();
  const result = await callClaude(
    `あなたはスピリチュアルな夢解読師です。ユーザーが見た夢の内容を受け取り、象徴・潜在意識・スピリチュアルな意味を神秘的な文体で日本語で解説してください。300文字程度で。`,
    `夢の内容：${dream}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉔ 縁結び相性診断
// ============================================
async function handleSoulCompatibility(request) {
  const { birthdate1, birthdate2 } = await request.json();
  const result = await callClaude(
    `あなたは魂の縁を読む占い師です。2人の生年月日から魂レベルの相性を診断し、2人の絆の意味と共に成長するための鍵を神秘的な文体で日本語で届けてください。300文字程度で。`,
    `1人目の生年月日：${birthdate1}、2人目の生年月日：${birthdate2}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉕ 夢の色彩診断
// ============================================
async function handleDreamColors(request) {
  const { colors } = await request.json();
  const result = await callClaude(
    `あなたは色彩心理とスピリチュアルを組み合わせた夢解読師です。夢に現れた色の組み合わせから潜在意識のメッセージ・魂の状態・今必要なエネルギーを神秘的な文体で日本語で伝えてください。300文字程度で。`,
    `夢に出た色：${colors.join("、")}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉖ 月相ジャーナル
// ============================================
async function handleMoonJournal(request) {
  const today = new Date().toISOString().split("T")[0];
  const result = await callClaude(
    `あなたは月の神秘を語る案内人です。今日の月相に基づいた内省のための問いかけと、月からのメッセージを詩的な日本語で届けてください。250文字程度で。`,
    `今日の日付：${today}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉗ 今日の宇宙メッセージ
// ============================================
async function handleCosmicMessage(request) {
  const today = new Date().toISOString().split("T")[0];
  const result = await callClaude(
    `あなたは宇宙の意識とつながるチャネラーです。今日この日の宇宙的エネルギーを感じ取り、地球上のすべての魂へのメッセージを詩的で神秘的な日本語で届けてください。250文字程度で。`,
    `今日の日付：${today}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉘ 今日の開運カラー
// ============================================
async function handleLuckyColor(request) {
  const { birthdate, targetDate } = await request.json();
  const result = await callClaude(
    `あなたは色彩運気の占い師です。生年月日と今日の日付から今日最も開運をもたらすラッキーカラーを特定し、その色のエネルギー・使い方・今日のアドバイスを神秘的な文体で日本語で伝えてください。300文字程度で。`,
    `生年月日：${birthdate}、対象日：${targetDate}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉙ パワーストーン診断
// ============================================
async function handleCrystalGuide(request) {
  const { currentState } = await request.json();
  const result = await callClaude(
    `あなたはクリスタルヒーラーです。ユーザーの今の状態を受け取り、最も必要なパワーストーン（水晶、アメジスト、ローズクォーツなど）を特定し、その石のエネルギー・使い方・癒しのメッセージを神秘的な文体で日本語で伝えてください。350文字程度で。`,
    `今の状態：${currentState}`
  );
  return jsonResponse({ result });
}

// ============================================
// ㉚ 手相占い（ビジョンAPI使用）
// ============================================
async function handlePalmReading(request) {
  const { imageBase64, mimeType } = await request.json();
  const result = await callClaudeVision(
    `あなたは神秘的な手相占い師です。手のひらの画像を見て、生命線・感情線・頭脳線・運命線・太陽線を丁寧に読み取り、その人の生命力・感情パターン・知性・運命の流れを神秘的で詩的な日本語で伝えてください。400文字程度で。`,
    imageBase64,
    mimeType || "image/jpeg"
  );
  return jsonResponse({ result });
}

// ============================================
// ユーティリティ
// ============================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
