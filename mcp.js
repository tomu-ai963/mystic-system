// ============================================
// とむMYSTIC — mcp.js
// ============================================

import { CORS_HEADERS, callClaude } from "./shared.js";
import {
  READINGS,
  getSunSign, getLifePathNumber, getNineStarKi,
  RUNE_NAMES, I_CHING_HEXAGRAMS, checkMercuryRetrograde, calcBiorhythm,
  TAROT_CARDS,
} from "./readings-data.js";

// ============================================
// MCP サーバー実装 (POST /mcp)
// JSON-RPC 2.0 ベース、@modelcontextprotocol/sdk 不使用
// ============================================

const MCP_TOOLS = [
  {
    name: "star_reading",
    description: "今日の星読み。生年月日から太陽星座を計算し、今日の宇宙エネルギーと星のメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "tarot_draw",
    description: "タロット一枚引き。ランダムにカードを引き、今この瞬間のメッセージを届けます。引数は不要です。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "numerology",
    description: "数秘術診断。生年月日からライフパスナンバーを計算し、魂の使命と今世のテーマを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        name:      { type: "string", description: "名前（任意）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "lucky_color",
    description: "今日の開運カラー。生年月日と対象日から最もラッキーなカラーを特定し、開運アドバイスを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:   { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        target_date: { type: "string", description: "対象日（YYYY-MM-DD形式）。省略時は今日。" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "oracle_message",
    description: "宇宙メッセージ。今の気持ちや状況・悩みを伝えると、宇宙からの神秘的なメッセージが届きます。",
    inputSchema: {
      type: "object",
      properties: {
        feeling: { type: "string", description: "今の気持ちや状況・悩み" },
      },
      required: ["feeling"],
    },
  },
  {
    name: "past_life",
    description: "前世診断。自己描写や好み・傾向を入力すると、AIが前世の物語を神秘的に語ります。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "あなたの特徴・好み・傾向・直感的に惹かれるものなど（自由記述）" },
      },
      required: ["description"],
    },
  },
  {
    name: "guardian_star",
    description: "守護星特定。生年月日から守護星を特定し、今週の指針と開運アドバイスを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "dream_reading",
    description: "夢解読AI。夢の内容を入力すると、スピリチュアルな視点から象徴と潜在意識のメッセージを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        dream: { type: "string", description: "見た夢の内容を詳しく記述してください" },
      },
      required: ["dream"],
    },
  },
  {
    name: "compatibility",
    description: "縁結び相性占い。2人の生年月日から魂レベルの相性・絆の意味・共に成長するための鍵を読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate1: { type: "string", description: "1人目の生年月日（YYYY-MM-DD形式）" },
        birthdate2: { type: "string", description: "2人目の生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate1", "birthdate2"],
    },
  },
  {
    name: "soul_mission",
    description: "魂の使命診断。今世のテーマ・使命・ライフギフトをAIが読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "自分が大切にしていること・繰り返すパターン・情熱を感じることなど（自由記述）" },
        birthdate:   { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["description"],
    },
  },
  {
    name: "moon_journal",
    description: "月相ジャーナル。今日の月相に合わせた内省プロンプトと月からのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        date:       { type: "string", description: "対象日（YYYY-MM-DD形式、省略時は今日）" },
        moon_phase: { type: "string", description: "月相名（例：新月、三日月、上弦の月、満月、下弦の月）省略可" },
      },
    },
  },
  {
    name: "aura_reading",
    description: "オーラ診断。今の状態・気分・エネルギーを入力すると、現在のオーラカラーを特定し読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        current_state: { type: "string", description: "今の気分・体の感覚・心の状態・最近の出来事など（自由記述）" },
      },
      required: ["current_state"],
    },
  },
  {
    name: "chakra_check",
    description: "チャクラバランス診断。気になる体の部位や感情・悩みを入力すると、滞っているチャクラを特定し解放メッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        concern: { type: "string", description: "気になる体の症状・感情・悩み・テーマ（自由記述）" },
      },
      required: ["concern"],
    },
  },
  {
    name: "power_stone",
    description: "パワーストーン診断。生年月日と今の状態から相性の良いパワーストーンを特定し、癒しのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:     { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
        current_state: { type: "string", description: "今の状態・悩み・求めているエネルギー（任意）" },
      },
    },
  },
  {
    name: "angel_number",
    description: "エンジェルナンバー解読。繰り返し見る数字や気になる数字を入力すると、天使からのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "気になる数字（例：111、1234、777など）" },
      },
      required: ["number"],
    },
  },
  {
    name: "spirit_animal",
    description: "スピリットアニマル診断。自分の特徴・傾向・好みを入力すると、守護精霊動物とそのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "自分の性格・好きな場所・本能的に惹かれる動物・傾向など（自由記述）" },
      },
      required: ["description"],
    },
  },
  {
    name: "mandala_reading",
    description: "マンダラ占い。1〜9の数字を直感で選ぶと、そのマンダラポジションのエネルギーと今のメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        position: { type: "number", description: "直感で選んだ数字（1〜9）" },
        question:  { type: "string", description: "今のテーマや質問（任意）" },
      },
      required: ["position"],
    },
  },
  {
    name: "rune_reading",
    description: "ルーン占い（一文字引き）。質問を入力するとルーン文字をランダムに引き、その意味とメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "今の質問・テーマ・悩み（任意）" },
      },
    },
  },
  {
    name: "i_ching",
    description: "易占い。質問を入力すると六十四卦からランダムに一卦を引き、今この瞬間の宇宙の答えを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "今の質問・悩み・判断を迫られていること" },
      },
      required: ["question"],
    },
  },
  {
    name: "biorhythm",
    description: "バイオリズム診断。生年月日から今日の肉体・感情・知性の3サイクルを計算し、コンディションと行動指針を届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:   { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        target_date: { type: "string", description: "診断したい日付（YYYY-MM-DD形式、省略時は今日）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "celtic_cross",
    description: "ケルト十字スプレッド。タロット10枚展開で状況・障害・過去・未来・深層など多面的な読みを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "占いたいテーマや質問" },
      },
      required: ["question"],
    },
  },
  {
    name: "yearly_forecast",
    description: "年間運勢予測。生年月日と対象年から総合運・愛情運・仕事運・金運の年間の流れを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        year:      { type: "number", description: "対象年（例：2026、省略時は今年）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "monthly_fortune",
    description: "月間運勢。生年月日と対象月からその月の運勢の流れ・注目時期・テーマを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:  { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        year_month: { type: "string", description: "対象年月（YYYY-MM形式、省略時は今月）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "love_oracle",
    description: "恋愛オラクル。恋愛に関する悩みや状況を入力すると、愛の神秘的なメッセージと指針を届けます。",
    inputSchema: {
      type: "object",
      properties: {
        situation: { type: "string", description: "今の恋愛状況・悩み・質問（自由記述）" },
      },
      required: ["situation"],
    },
  },
  {
    name: "career_reading",
    description: "仕事・キャリア占い。仕事の悩みや方向性の迷いを入力すると、魂の視点から最善のキャリアパスを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        concern:   { type: "string", description: "仕事・キャリアの悩みや質問（自由記述）" },
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["concern"],
    },
  },
  {
    name: "health_energy",
    description: "健康エネルギー診断。今の体の状態や気になる症状を入力すると、エネルギー的な視点から健康の指針を届けます。",
    inputSchema: {
      type: "object",
      properties: {
        concern:   { type: "string", description: "体の状態・気になる症状・疲れ感など（自由記述）" },
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["concern"],
    },
  },
  {
    name: "wealth_flow",
    description: "金運診断。生年月日から金運のサイクル・お金との関係性・今の流れと開運アクションを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "mercury_retrograde",
    description: "水星逆行チェック。指定した日が水星逆行期間中かどうかを確認し、その時期に合わせたアドバイスを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "確認したい日付（YYYY-MM-DD形式、省略時は今日）" },
      },
    },
  },
  {
    name: "numerology_name",
    description: "姓名判断。氏名の漢字画数から五格（天格・人格・地格・外格・総格）を計算し、運命の流れを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        full_name: { type: "string", description: "氏名（姓と名をスペースで区切って入力。例：山田 花子）" },
      },
      required: ["full_name"],
    },
  },
  {
    name: "cosmic_timing",
    description: "宇宙のタイミング診断。今取り組もうとしていることを入力すると、今が行動すべき時かどうか宇宙の流れを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        action:    { type: "string", description: "今取り組もうとしていること・決断しようとしていること（自由記述）" },
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["action"],
    },
  },
];

async function handleMcp(request, env) {
  // MCP_TOKEN が未設定の場合は認証スキップせず拒否（誤設定によるAPI無料垂れ流しを防止）
  if (!env.MCP_TOKEN) {
    return mcpError(null, -32001, "Unauthorized", 401);
  }

  // Streamable HTTP: GET リクエストにはサーバー情報を返す
  if (request.method === "GET") {
    return new Response(JSON.stringify({
      name: "tomu-mystic",
      version: "1.0.0",
      protocolVersion: "2024-11-05",
    }), {
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  // トークン照合（未設定ケースは上で401済み）
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ??
    request.headers.get("X-MCP-Token") ??
    (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token !== env.MCP_TOKEN) {
    return mcpError(null, -32001, "Unauthorized", 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return mcpError(null, -32700, "Parse error");
  }

  const { jsonrpc, id = null, method, params } = body;

  if (jsonrpc !== "2.0") {
    return mcpError(id, -32600, "Invalid Request: jsonrpc must be '2.0'");
  }

  // 通知メッセージ（レスポンス不要）
  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  switch (method) {
    case "initialize":
      return mcpResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tomu-mystic", version: "1.0.0" },
      });

    case "tools/list":
      return mcpResponse(id, { tools: MCP_TOOLS });

    case "tools/call":
      return handleMcpToolCall(id, params, env);

    default:
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

// ============================================
// READINGS 連携ブリッジ
// READINGS に対応する占いがある MCP ツールは、system プロンプトを
// READINGS テーブルを唯一の定義源として参照する（プロンプト二重管理の解消）。
// - toBody: MCP引数 → READINGS.build() の body へ変換（user/extra も共用）
// - user:   入力形状が READINGS と異なるツール専用の user メッセージ生成
//           （system のみ READINGS を参照。ctx は user→prefix 間の値共有用）
// - prefix: 結果テキスト先頭の確定データ表示（従来の MCP 出力形式を維持）
// - validate: 必須引数チェック。エラー文字列を返すと -32602 で応答
// ============================================
const MCP_READINGS_TOOLS = {
  star_reading: {
    action: "star-reading",
    validate: (a) => (!a.birthdate ? "birthdate は必須です" : null),
    toBody: (a) => ({ birthdate: a.birthdate }),
    prefix: (a, extra) => `【太陽星座：${extra.sign}】\n\n`,
  },
  tarot_draw: {
    action: "tarot",
    // カードはサーバー側で抽選（クライアント指定の READINGS 版とのフロー差は従来どおり）
    toBody: () => ({ card: TAROT_CARDS[Math.floor(Math.random() * TAROT_CARDS.length)] }),
    prefix: (a, extra, body) => `【引いたカード：${body.card}】\n\n`,
  },
  numerology: {
    action: "numerology",
    validate: (a) => (!a.birthdate ? "birthdate は必須です" : null),
    toBody: (a) => ({ birthdate: a.birthdate, name: a.name !== undefined ? a.name : "（名前未入力）" }),
    prefix: (a, extra) => `【ライフパスナンバー：${extra.lifePathNumber}】\n\n`,
  },
  lucky_color: {
    action: "lucky-color",
    validate: (a) => (!a.birthdate ? "birthdate は必須です" : null),
    toBody: (a) => ({ birthdate: a.birthdate, targetDate: a.target_date || new Date().toISOString().split("T")[0] }),
    prefix: (a, extra, body) => `【${body.targetDate}の開運カラー診断】\n\n`,
  },
  oracle_message: {
    action: "oracle-message",
    validate: (a) => (!a.feeling ? "feeling は必須です" : null),
    toBody: (a) => ({ feeling: a.feeling }),
  },
  past_life: {
    action: "past-life",
    validate: (a) => (!a.description ? "description は必須です" : null),
    user: (a) => `自己描写・傾向：${a.description}`,
  },
  guardian_star: {
    action: "guardian-star",
    validate: (a) => (!a.birthdate ? "birthdate は必須です" : null),
    toBody: (a) => ({ birthdate: a.birthdate }),
    prefix: (a, extra) => `【守護星診断：${extra.sign}】\n\n`,
  },
  dream_reading: {
    action: "dream-decoder",
    validate: (a) => (!a.dream ? "dream は必須です" : null),
    toBody: (a) => ({ dream: a.dream }),
  },
  compatibility: {
    action: "soul-compatibility",
    validate: (a) => (!a.birthdate1 || !a.birthdate2 ? "birthdate1・birthdate2 は必須です" : null),
    toBody: (a) => ({ birthdate1: a.birthdate1, birthdate2: a.birthdate2 }),
    prefix: (a, extra) =>
      `【相性診断】1人目：${extra.person1.sign}（LP:${extra.person1.lpn}）× 2人目：${extra.person2.sign}（LP:${extra.person2.lpn}）\n\n`,
  },
  soul_mission: {
    action: "soul-mission",
    validate: (a) => (!a.description ? "description は必須です" : null),
    user: (a) => `自己描写：${a.description}${a.birthdate ? `\n生年月日：${a.birthdate}\nライフパスナンバー：${getLifePathNumber(a.birthdate)}` : ""}`,
  },
  moon_journal: {
    action: "moon-journal",
    user: (a, ctx) => {
      ctx.date = a.date || new Date().toISOString().split("T")[0];
      const phaseDesc = a.moon_phase ? `月相：${a.moon_phase}` : `今日の日付：${ctx.date}`;
      return `今日の日付：${ctx.date}\n${phaseDesc}`;
    },
    prefix: (a, extra, body, ctx) => `【月相ジャーナル：${ctx.date}${a.moon_phase ? "・" + a.moon_phase : ""}】\n\n`,
  },
  aura_reading: {
    action: "aura-reading",
    validate: (a) => (!a.current_state ? "current_state は必須です" : null),
    user: (a) => `今の状態：${a.current_state}`,
  },
  power_stone: {
    action: "crystal-guide",
    validate: (a) => (!a.birthdate && !a.current_state ? "birthdate または current_state のいずれかは必須です" : null),
    user: (a) => `${a.birthdate ? `生年月日：${a.birthdate}\n太陽星座：${getSunSign(a.birthdate)}\n` : ""}${a.current_state ? `今の状態：${a.current_state}` : ""}`,
  },
  spirit_animal: {
    action: "spirit-animal",
    validate: (a) => (!a.description ? "description は必須です" : null),
    user: (a) => `自己描写・傾向：${a.description}`,
  },
  rune_reading: {
    action: "rune-reading",
    user: (a, ctx) => {
      ctx.rune = RUNE_NAMES[Math.floor(Math.random() * RUNE_NAMES.length)];
      return `引いたルーン：${ctx.rune}${a.question ? `\n質問：${a.question}` : ""}`;
    },
    prefix: (a, extra, body, ctx) => `【引いたルーン：${ctx.rune}】\n\n`,
  },
  biorhythm: {
    action: "biorhythm",
    validate: (a) => (!a.birthdate ? "birthdate は必須です" : null),
    user: (a, ctx) => {
      ctx.targetDate = a.target_date || new Date().toISOString().split("T")[0];
      ctx.bio = calcBiorhythm(a.birthdate, ctx.targetDate);
      return `生年月日：${a.birthdate}\n対象日：${ctx.targetDate}\n肉体リズム：${ctx.bio.physical}%\n感情リズム：${ctx.bio.emotional}%\n知性リズム：${ctx.bio.intellectual}%`;
    },
    prefix: (a, extra, body, ctx) =>
      `【バイオリズム（${ctx.targetDate}）】肉体：${ctx.bio.physical}% 感情：${ctx.bio.emotional}% 知性：${ctx.bio.intellectual}%\n\n`,
  },
  numerology_name: {
    action: "name-fortune",
    validate: (a) => (!a.full_name ? "full_name は必須です" : null),
    toBody: (a) => ({ fullName: a.full_name }),
    prefix: (a, extra) => {
      const g = extra.goKaku;
      return `【姓名判断：${a.full_name}】天格:${g.tenkaku} 人格:${g.jinkaku} 地格:${g.chikaku} 外格:${g.sotokaku} 総格:${g.soukaku}\n\n`;
    },
  },
};

async function handleMcpToolCall(id, params, env) {
  const { name, arguments: args = {} } = params || {};

  try {
    // READINGS 連携ツール: system（および toBody 系は user/extra も）を READINGS から取得
    const bridge = MCP_READINGS_TOOLS[name];
    if (bridge) {
      const invalid = bridge.validate ? bridge.validate(args) : null;
      if (invalid) return mcpError(id, -32602, invalid);
      const reading = READINGS[bridge.action];
      const ctx = {};
      let user, extra, body;
      if (bridge.toBody) {
        body = bridge.toBody(args);
        const built = reading.build(body);
        user = built.user;
        extra = built.extra || {};
      } else {
        user = bridge.user(args, ctx);
      }
      let text = await callClaude(env, reading.system, user);
      if (bridge.prefix) text = bridge.prefix(args, extra, body, ctx) + text;
      return mcpResponse(id, { content: [{ type: "text", text }] });
    }

    let text;

    // MCP 専用ツール（READINGS に対応する占いが無いもの。chakra_check のみ対応占いは
    // 存在するがフローが異なる[AIがチャクラを特定 vs クライアントが確定済みチャクラを送信]ため統一対象外）
    switch (name) {
      case "chakra_check": {
        const { concern: ccConcern } = args;
        if (!ccConcern) return mcpError(id, -32602, "concern は必須です");
        text = await callClaude(
          env,
          `あなたはチャクラを診るエネルギーヒーラーです。ユーザーの悩みや症状から滞っているチャクラを特定し、そのチャクラの意味・滞りの原因・解放のための実践・魂のメッセージを神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `気になる症状・悩み：${ccConcern}`
        );
        break;
      }

      case "angel_number": {
        const { number: anNum } = args;
        if (!anNum) return mcpError(id, -32602, "number は必須です");
        text = await callClaude(
          env,
          `あなたは天使のメッセージを伝えるエンジェルナンバーリーダーです。ユーザーが繰り返し見る数字の意味・天使からのメッセージ・今この瞬間に必要な行動を神秘的な文体で日本語で届けてください。300文字程度で。`,
          `エンジェルナンバー：${anNum}`
        );
        text = `【エンジェルナンバー：${anNum}】\n\n${text}`;
        break;
      }

      case "mandala_reading": {
        const { position: mPos, question: mQuestion } = args;
        if (!mPos || mPos < 1 || mPos > 9) return mcpError(id, -32602, "position は1〜9の数字で入力してください");
        const mandalaPositions = [
          "中央（自己の核心・今の本質）","上（意識・理想・目標）","右（外の世界・行動・現実）",
          "下（潜在意識・基盤・過去）","左（内なる世界・直感・感情）","右上（光・才能・可能性）",
          "右下（現実化・物質・安定）","左下（影・課題・変容）","左上（夢・霊性・高次意識）",
        ];
        const mPosDesc = mandalaPositions[mPos - 1];
        const mQInfo = mQuestion ? `\n質問：${mQuestion}` : '';
        text = await callClaude(
          env,
          `あなたはマンダラ占いの達人です。ユーザーが直感で選んだポジションのエネルギーと意味、今この瞬間のメッセージを神秘的な文体で日本語で伝えてください。300文字程度で。`,
          `選んだポジション：${mPos}番（${mPosDesc}）${mQInfo}`
        );
        text = `【マンダラ第${mPos}番：${mPosDesc}】\n\n${text}`;
        break;
      }

      case "i_ching": {
        const { question: icQuestion } = args;
        if (!icQuestion) return mcpError(id, -32602, "question は必須です");
        const hexagram = I_CHING_HEXAGRAMS[Math.floor(Math.random() * I_CHING_HEXAGRAMS.length)];
        text = await callClaude(
          env,
          `あなたは易経の達人です。引いた卦の意味・象意・今この質問への宇宙の答えを神秘的で深い文体で日本語で伝えてください。400文字程度で。`,
          `質問：${icQuestion}\n引いた卦：${hexagram}`
        );
        text = `【引いた卦：${hexagram}】\n\n${text}`;
        break;
      }

      case "celtic_cross": {
        const { question: ccQ } = args;
        if (!ccQ) return mcpError(id, -32602, "question は必須です");
        const ccShuffled = [...TAROT_CARDS].sort(() => Math.random() - 0.5);
        const ccPositions = [
          "現在の状況","交差（障害・助力）","遠い過去","近い過去",
          "可能性・最善策","近い未来","あなた自身","外的環境",
          "希望と恐れ","最終結果",
        ];
        const ccSpread = ccPositions.map((p, i) => `${p}：${ccShuffled[i]}`).join("\n");
        text = await callClaude(
          env,
          `あなたは深遠なタロット占い師です。ケルト十字スプレッドの10枚展開の意味を統合的に読み解き、状況・障害・過去・未来・深層を織り交ぜた神秘的なリーディングを日本語で届けてください。500文字程度で。`,
          `質問：${ccQ}\n\n${ccSpread}`,
          1000
        );
        text = `【ケルト十字スプレッド】\n${ccSpread}\n\n${text}`;
        break;
      }

      case "yearly_forecast": {
        const { birthdate: yfBd, year: yfYear } = args;
        if (!yfBd) return mcpError(id, -32602, "birthdate は必須です");
        const yfTargetYear = yfYear || new Date().getFullYear();
        const yfSign = getSunSign(yfBd);
        const yfLpn  = getLifePathNumber(yfBd);
        const yfKi   = getNineStarKi(yfBd);
        text = await callClaude(
          env,
          `あなたは年間運勢を読む占い師です。以下の確定済みデータを元に、対象年の総合運・愛情運・仕事運・金運・開運のポイントを神秘的な文体で日本語で伝えてください。星座・数字・本命星は変えないでください。500文字程度で。`,
          `生年月日：${yfBd}\n太陽星座：${yfSign}\nライフパスナンバー：${yfLpn}\n本命星：${yfKi.name}\n対象年：${yfTargetYear}年`,
          1000
        );
        text = `【${yfTargetYear}年の年間運勢】\n\n${text}`;
        break;
      }

      case "monthly_fortune": {
        const { birthdate: mfBd, year_month: mfYm } = args;
        if (!mfBd) return mcpError(id, -32602, "birthdate は必須です");
        const mfToday = new Date();
        const mfTargetYm = mfYm || `${mfToday.getFullYear()}-${String(mfToday.getMonth() + 1).padStart(2, '0')}`;
        const mfSign = getSunSign(mfBd);
        const mfLpn  = getLifePathNumber(mfBd);
        text = await callClaude(
          env,
          `あなたは月間運勢を読む占い師です。以下の確定済みデータを元に、対象月の全体的な流れ・注目すべき時期・テーマ・開運アクションを神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `生年月日：${mfBd}\n太陽星座：${mfSign}\nライフパスナンバー：${mfLpn}\n対象月：${mfTargetYm}`
        );
        text = `【${mfTargetYm}の月間運勢】\n\n${text}`;
        break;
      }

      case "love_oracle": {
        const { situation: loSit } = args;
        if (!loSit) return mcpError(id, -32602, "situation は必須です");
        text = await callClaude(
          env,
          `あなたは愛のスピリチュアルリーダーです。ユーザーの恋愛状況を受け取り、愛の神秘的なメッセージ・心の扉を開く鍵・今この恋に必要な行動を詩的で神秘的な日本語で届けてください。350文字程度で。`,
          `恋愛状況・悩み：${loSit}`
        );
        break;
      }

      case "career_reading": {
        const { concern: crConcern, birthdate: crBd } = args;
        if (!crConcern) return mcpError(id, -32602, "concern は必須です");
        const crBdInfo = crBd ? `\n生年月日：${crBd}\n太陽星座：${getSunSign(crBd)}\nライフパスナンバー：${getLifePathNumber(crBd)}` : '';
        text = await callClaude(
          env,
          `あなたは魂の使命とキャリアを読む占い師です。ユーザーの仕事の悩みを受け取り、魂が本当に求める働き方・天職への道筋・今行動すべきことを神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `仕事・キャリアの悩み：${crConcern}${crBdInfo}`
        );
        break;
      }

      case "health_energy": {
        const { concern: heConcern, birthdate: heBd } = args;
        if (!heConcern) return mcpError(id, -32602, "concern は必須です");
        const heBdInfo = heBd ? `\n生年月日：${heBd}\n太陽星座：${getSunSign(heBd)}` : '';
        text = await callClaude(
          env,
          `あなたはエネルギーメディシンとスピリチュアルヒーリングの専門家です。ユーザーの体の状態や症状を受け取り、エネルギー的な視点から健康の指針・必要なケア・魂からのメッセージを神秘的な文体で日本語で伝えてください。※医療的診断ではなくスピリチュアルな観点でのアドバイスです。400文字程度で。`,
          `体の状態・気になること：${heConcern}${heBdInfo}`
        );
        break;
      }

      case "wealth_flow": {
        const { birthdate: wfBd } = args;
        if (!wfBd) return mcpError(id, -32602, "birthdate は必須です");
        const wfSign = getSunSign(wfBd);
        const wfLpn  = getLifePathNumber(wfBd);
        const wfKi   = getNineStarKi(wfBd);
        text = await callClaude(
          env,
          `あなたは金運と豊かさの流れを読む占い師です。以下の確定済みデータを元に、その人の金運サイクル・お金との魂レベルの関係性・今の金運の流れ・開運アクションを神秘的な文体で日本語で伝えてください。本命星・星座・数字は変えないでください。400文字程度で。`,
          `生年月日：${wfBd}\n太陽星座：${wfSign}\nライフパスナンバー：${wfLpn}\n本命星：${wfKi.name}`
        );
        text = `【金運診断】\n\n${text}`;
        break;
      }

      case "mercury_retrograde": {
        const { date: mrDate } = args;
        const mrTargetDate = mrDate || new Date().toISOString().split("T")[0];
        const mrResult = checkMercuryRetrograde(mrTargetDate);
        const mrStatus = mrResult.retrograde
          ? `水星逆行中（期間：${mrResult.period}）`
          : "水星は順行中";
        text = await callClaude(
          env,
          `あなたは占星術師です。水星の状態に合わせたアドバイス・注意点・この時期の過ごし方を神秘的な文体で日本語で伝えてください。250文字程度で。`,
          `確認日：${mrTargetDate}\n水星の状態：${mrStatus}`
        );
        text = `【水星逆行チェック：${mrTargetDate}】\n${mrStatus}\n\n${text}`;
        break;
      }

      case "cosmic_timing": {
        const { action: ctAction, birthdate: ctBd } = args;
        if (!ctAction) return mcpError(id, -32602, "action は必須です");
        const ctToday = new Date().toISOString().split("T")[0];
        const ctBdInfo = ctBd ? `\n生年月日：${ctBd}\n太陽星座：${getSunSign(ctBd)}\nライフパスナンバー：${getLifePathNumber(ctBd)}` : '';
        text = await callClaude(
          env,
          `あなたは宇宙のタイミングを読む占い師です。ユーザーが取り組もうとしていることと今の宇宙の流れを照らし合わせ、今が行動すべき時かどうか・最適なタイミング・宇宙からのアドバイスを神秘的な文体で日本語で伝えてください。350文字程度で。`,
          `今日の日付：${ctToday}\n取り組もうとしていること：${ctAction}${ctBdInfo}`
        );
        break;
      }

      default:
        return mcpError(id, -32602, `Unknown tool: ${name}`);
    }

    return mcpResponse(id, {
      content: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("MCP tool execution error:", err && (err.stack || err.message));
    return mcpError(id, -32603, "占いの取得に失敗しました。時間をおいて再度お試しください。");
  }
}

function mcpResponse(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function mcpError(id, code, message, httpStatus = 200) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
    { status: httpStatus, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}

export { handleMcp };
