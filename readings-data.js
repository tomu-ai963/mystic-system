// ============================================
// とむMYSTIC — readings-data.js
// 占い定義の一元管理:
//   確定計算ユーティリティ・READINGS テーブル（30占いの system/build）・
//   メール表示ラベル・MCP と共有する静的データ（タロット/ルーン/易 等）
// ============================================

import { calcGoKaku } from "./kanji-strokes.js";

// ============================================
// 確定計算ユーティリティ
// ============================================

function getSunSign(birthdate) {
  const [, m, d] = birthdate.split('-').map(Number);
  if ((m===3&&d>=21)||(m===4&&d<=19)) return '牡羊座';
  if ((m===4&&d>=20)||(m===5&&d<=20)) return '牡牛座';
  if ((m===5&&d>=21)||(m===6&&d<=21)) return '双子座';
  if ((m===6&&d>=22)||(m===7&&d<=22)) return '蟹座';
  if ((m===7&&d>=23)||(m===8&&d<=22)) return '獅子座';
  if ((m===8&&d>=23)||(m===9&&d<=22)) return '乙女座';
  if ((m===9&&d>=23)||(m===10&&d<=23)) return '天秤座';
  if ((m===10&&d>=24)||(m===11&&d<=22)) return '蠍座';
  if ((m===11&&d>=23)||(m===12&&d<=21)) return '射手座';
  if ((m===12&&d>=22)||(m===1&&d<=19)) return '山羊座';
  if ((m===1&&d>=20)||(m===2&&d<=18)) return '水瓶座';
  return '魚座';
}

function getNineStarKi(birthdate) {
  const [y, m, d] = birthdate.split('-').map(Number);
  const ay = (m===1||(m===2&&d<=3)) ? y-1 : y;
  let s = String(ay).split('').reduce((a,b)=>a+parseInt(b),0);
  while(s>=10) s=String(s).split('').reduce((a,b)=>a+parseInt(b),0);
  const n = (11-s)%9||9;
  const names=['','一白水星','二黒土星','三碧木星','四緑木星','五黄土星','六白金星','七赤金星','八白土星','九紫火星'];
  return {num:n, name:names[n]};
}

function getMayaKin(birthdate) {
  const base = Date.UTC(2000,0,1);
  const [y,m,d] = birthdate.split('-').map(Number);
  const diff = Math.round((Date.UTC(y,m-1,d)-base)/86400000);
  const kin = ((143+diff)%260+260)%260+1;
  const tones=['磁気','月','電気','自己存在','倍音','リズム','共鳴','銀河','太陽','惑星','スペクトル','水晶','宇宙'];
  const seals=['赤い龍','白い風','青い夜','黄色い種','赤い蛇','白い世界の橋渡し','青い手','黄色い星','赤い月','白い犬','青い猿','黄色い人','赤い空歩く者','白い魔法使い','青い鷲','黄色い戦士','赤い地球','白い鏡','青い嵐','黄色い太陽'];
  return {kin, tone:tones[(kin-1)%13], seal:seals[(kin-1)%20]};
}

function getLifePathNumber(birthdate) {
  let n = birthdate.replace(/-/g,'').split('').reduce((a,b)=>a+parseInt(b),0);
  while(n>9&&n!==11&&n!==22&&n!==33) n=String(n).split('').reduce((a,b)=>a+parseInt(b),0);
  return n;
}

function getEto(birthdate) {
  const y = parseInt(birthdate.split('-')[0]);
  const junishi=['申','酉','戌','亥','子','丑','寅','卯','辰','巳','午','未'];
  const jikkan=['庚','辛','壬','癸','甲','乙','丙','丁','戊','己'];
  return {kan:jikkan[y%10], eto:junishi[y%12]};
}


// ============================================
// 占い種別テーブル（READINGS）
// 30種の占いを「データ」として一元管理する。各エントリ:
//   system : 既定のシステムプロンプト
//   vision : true なら画像（Vision API）を使う占い
//   build(body) : 入力 body から以下のいずれかを返す
//     { user, extra }                  … 通常占い（user=ユーザーメッセージ / extra=追加レスポンス項目）
//     { system, user, extra }          … システムプロンプトを動的生成する占い（system が優先）
//     { imageBase64, mimeType, extra } … vision の占い
// ※ プロンプト内容・レスポンス形状は従来の個別ハンドラと完全一致させること。
// ============================================
const READINGS = {
  // ① 今日の星読み
  "star-reading": {
    system: `あなたは神秘的な星読み師です。以下の確定済みデータを元に、今日の星の配置に基づいたメッセージを詩的で神秘的な文体で日本語で届けてください。星座の判定は変えないでください。本日の日付に基づいた実際の季節感を反映し、誕生日周辺の季節（例:山羊座なら冬至前後）と混同しないでください。200〜300文字程度で。`,
    build(body) {
      const sign = getSunSign(body.birthdate);
      const today = new Date().toISOString().split("T")[0];
      return { user: `本日の日付：${today}\n生年月日：${body.birthdate}\n太陽星座：${sign}`, extra: { sign } };
    },
  },

  // ② 数秘術診断
  "numerology": {
    system: `あなたは数秘術の達人です。以下の確定済みライフパスナンバーを元に、魂の使命と今世のテーマを神秘的な文体で日本語で伝えてください。ライフパスナンバーの数値は変えないでください。300文字程度で。`,
    build(body) {
      const lpn = getLifePathNumber(body.birthdate);
      return { user: `名前：${body.name}\n生年月日：${body.birthdate}\nライフパスナンバー：${lpn}`, extra: { lifePathNumber: lpn } };
    },
  },

  // ③ 守護星特定
  "guardian-star": {
    system: `あなたは星の守護者です。以下の確定済みデータを元に、守護星の性質と今週の指針・開運アドバイスを神秘的な文体で日本語で届けてください。星座は変えないでください。本日の日付に基づいた実際の季節感を反映し、誕生日周辺の季節（例:山羊座なら冬至前後）と混同しないでください。300文字程度で。`,
    build(body) {
      const sign = getSunSign(body.birthdate);
      const today = new Date().toISOString().split("T")[0];
      return { user: `本日の日付：${today}\n生年月日：${body.birthdate}\n太陽星座：${sign}`, extra: { sign } };
    },
  },

  // ④ 九星気学診断
  "nine-star-ki": {
    system: `あなたは九星気学の達人です。以下の確定済みデータを元に、その人の本質・人生テーマ・今年の運気を神秘的な文体で日本語で伝えてください。本命星の名前と番号は変えないでください。350文字程度で。`,
    build(body) {
      const ki = getNineStarKi(body.birthdate);
      return { user: `生年月日：${body.birthdate}\n本命星：${ki.name}（${ki.num}）`, extra: { honmeisei: ki.name, honmeiseiNum: ki.num } };
    },
  },

  // ⑤ マヤ暦診断
  "maya-calendar": {
    system: `ユーザーのKIN番号・太陽の紋章・ウェーブスペル・音はすでに正確に計算済みです。
あなたが再計算する必要は一切ありません。
必ず渡された値（KIN・紋章・ウェーブスペル・音）をそのまま使ってメッセージを作成してください。
絶対に別のKIN番号や紋章を提示しないでください。

あなたはマヤ暦の占い師です。以下の確定済みデータを元に、その魂のエネルギー・使命・才能を神秘的な文体で日本語で伝えてください。350文字程度で。`,
    build(body) {
      const { birthdate, kin, tone, toneNumber, seal, wavespell, wavespellSeal } = body;
      return {
        user: `生年月日：${birthdate}\nKIN番号：${kin}\n音（トーン）：${tone}（${toneNumber}）\n太陽の紋章：${seal}\nウェーブスペル：${wavespellSeal}のウェーブスペル（第${wavespell}ウェーブスペル）`,
        extra: { kin, tone, toneNumber, seal, wavespell, wavespellSeal },
      };
    },
  },

  // ⑥ 動物占い（システムプロンプトを動的生成）
  "animal-fortune": {
    build(body) {
      const { birthdate, animal } = body;
      return {
        system: `あなたは動物キャラナビの占い師です。「${animal}」タイプの人の性格・運勢・対人関係をスピリチュアルな観点で200字程度で鑑定してください。`,
        user: `生年月日：${birthdate}、守護動物：${animal}`,
        extra: { animal },
      };
    },
  },

  // ⑦ 姓名判断
  "name-fortune": {
    system: `あなたは姓名判断の達人です。以下の画数は確定値です。この数値を使って運命の流れと今後の指針を神秘的な文体で日本語で伝えてください。絶対に画数を再計算しないでください。400文字程度で。`,
    build(body) {
      const { fullName, tenkaku: clientTk, jinkaku: clientJk, chikaku: clientCk, sotokaku: clientGk, soukaku: clientSk, confirmedGoKaku } = body;

      // クライアントから確定値が送られている場合はそれを優先（再計算しない）
      let tk, jk, ck, gk, sk, unknownNote;
      if (confirmedGoKaku && clientTk !== undefined) {
        tk = clientTk; jk = clientJk; ck = clientCk; gk = clientGk; sk = clientSk;
        unknownNote = (tk === '?' || jk === '?' || ck === '?' || gk === '?' || sk === '?')
          ? '\n※一部の漢字の画数が未登録のため「?」としています。' : '';
      } else {
        const calc = calcGoKaku(fullName);
        tk = calc.tenkaku; jk = calc.jinkaku; ck = calc.chikaku; gk = calc.sotokaku; sk = calc.soukaku;
        unknownNote = calc.unknown ? '\n※一部の漢字の画数が未登録のため「?」としています。' : '';
      }

      return {
        user: `氏名：${fullName}
【確定済み五格 — 絶対に再計算しないでください】
天格：${tk}（確定値）
人格：${jk}（確定値）
地格：${ck}（確定値）
外格：${gk}（確定値）
総格：${sk}（確定値）${unknownNote}
以上の数値をそのまま使い、独自に画数を算出・修正しないでください。`,
        extra: { goKaku: { tenkaku: tk, jinkaku: jk, chikaku: ck, sotokaku: gk, soukaku: sk } },
      };
    },
  },

  // ⑧ バイオリズム
  "biorhythm": {
    system: `あなたはバイオリズムを読む占い師です。指定日における肉体・感情・知性の3つのリズム値を受け取り、その人の今日のコンディションと取るべき行動指針を神秘的な文体で日本語で伝えてください。300文字程度で。`,
    build(body) {
      const { targetDate, physical, emotional, intellectual } = body;
      return { user: `対象日：${targetDate}、肉体リズム：${physical}%、感情リズム：${emotional}%、知性リズム：${intellectual}%` };
    },
  },

  // ⑨ ムーンサイン診断
  "moon-sign": {
    system: `あなたは月星座の占い師です。以下の確定済みデータを元に、その人の内面・感情パターン・本当の欲求を神秘的な文体で日本語で伝えてください。太陽星座・月星座・ライフパスナンバーは変えないでください。300文字程度で。`,
    build(body) {
      const { birthdate, zodiacSign, lifePathNumber, moonSign } = body;
      const sign = zodiacSign || getSunSign(birthdate);
      const lpn = lifePathNumber || getLifePathNumber(birthdate);
      return {
        user: `生年月日：${birthdate}\n太陽星座：${sign}\n月星座：${moonSign}\nライフパスナンバー：${lpn}`,
        extra: { sunSign: sign, moonSign, lifePathNumber: lpn },
      };
    },
  },

  // ⑩ 東洋星座×干支診断
  "eastern-stars": {
    system: `あなたは東洋占星術の達人です。以下の確定済みデータを元に、その人の宿命・才能・今年の運勢を神秘的な文体で日本語で伝えてください。干支・本命星は変えないでください。350文字程度で。`,
    build(body) {
      const eto = getEto(body.birthdate);
      const ki = getNineStarKi(body.birthdate);
      return {
        user: `生年月日：${body.birthdate}\n干支：${eto.kan}${eto.eto}\n本命星：${ki.name}`,
        extra: { eto: `${eto.kan}${eto.eto}`, honmeisei: ki.name },
      };
    },
  },

  // ⑪ ホロスコープ詳細
  "horoscope-deep": {
    system: `あなたは本格的な西洋占星術師です。以下の確定済みデータを元に、その人の本質・魂のテーマ・今後の流れを神秘的で詳しい文体で日本語で伝えてください。太陽星座・月星座は変えないでください。出生時刻・出生地からアセンダントの考察も加えてください。500文字程度で。`,
    build(body) {
      const { birthdate, birthTime, birthPlace, zodiacSign, moonSign } = body;
      const sign = zodiacSign || getSunSign(birthdate);
      return {
        user: `生年月日：${birthdate}\n太陽星座：${sign}\n月星座：${moonSign}\n出生時刻：${birthTime}\n出生地：${birthPlace}`,
        extra: { sunSign: sign, moonSign },
      };
    },
  },

  // ⑫ タロット一枚引き
  "tarot": {
    system: `あなたは神秘的なタロット占い師です。引いたカードのエネルギーと意味を、今この瞬間のユーザーへのメッセージとして神秘的な文体で日本語で届けてください。300文字程度で。`,
    build(body) {
      return { user: `引いたカード：${body.card}` };
    },
  },

  // ⑬ ルーン占い
  "rune-reading": {
    system: `あなたは北欧の神秘を伝えるルーン占い師です。引いたルーン文字の古代的な意味・エネルギー・今の状況へのメッセージを神秘的な文体で日本語で届けてください。300文字程度で。`,
    build(body) {
      return { user: `引いたルーン：${body.rune}` };
    },
  },

  // ⑭ オラクルカード
  "oracle-cards": {
    system: `あなたは宇宙のメッセージを伝えるオラクルカードリーダーです。テーマとカードを受け取り、今この瞬間の宇宙からの神秘的なメッセージを詩的な日本語で届けてください。300文字程度で。`,
    build(body) {
      return { user: `テーマ：${body.theme}、カード：${body.card}` };
    },
  },

  // ⑮ 九宮格診断
  "nine-palace": {
    system: `あなたは九宮格（風水×気学）の達人です。以下の確定済みデータを元に、今のあなたの運気の流れと開運の鍵を神秘的な文体で日本語で伝えてください。本命星は変えないでください。本日の日付に基づいた実際の季節感を反映し、誕生日周辺の季節（例:山羊座なら冬至前後）と混同しないでください。350文字程度で。`,
    build(body) {
      const { selectedPalace, birthdate, honmeisei: clientHonmei, honmeiseiNum: clientNum } = body;
      const ki = clientHonmei ? { name: clientHonmei, num: clientNum } : getNineStarKi(birthdate);
      const today = new Date().toISOString().split("T")[0];
      return {
        user: `本日の日付：${today}\n生年月日：${birthdate}、本命星：${ki.name}（${ki.num}）、直感で選んだ宮：${selectedPalace}`,
        extra: { honmeisei: ki.name, honmeiseiNum: ki.num },
      };
    },
  },

  // ⑯ 前世診断
  "past-life": {
    system: `あなたは魂の記憶を読む前世占い師です。ユーザーの回答から前世の物語を読み解き、魂が歩んできた旅を神秘的で詩的な日本語で語ってください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑰ 前世の職業診断
  "past-profession": {
    system: `あなたは魂の過去を読む前世職業占い師です。ユーザーの回答から前世で担っていた職業・役割（神官、騎士、薬師、吟遊詩人など）を特定し、その魂が持つスキルと今世への影響を神秘的な文体で日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑱ 魂の使命診断
  "soul-mission": {
    system: `あなたは魂の設計図を読む占い師です。ユーザーの回答から今世の魂の使命・ライフテーマ・与えるべきギフトを読み解き、宇宙からのメッセージとして神秘的な文体で日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑲ 精霊動物診断
  "spirit-animal": {
    system: `あなたはシャーマニックな精霊動物ガイドです。ユーザーの回答から守護精霊動物を特定し、その動物のエネルギー・もたらすメッセージ・今週の指針を神秘的な文体で日本語で届けてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑳ オーラカラー診断
  "aura-reading": {
    system: `あなたはオーラを視るスピリチュアルリーダーです。ユーザーの回答から現在のオーラカラーを特定し、そのエネルギーの意味・魂の状態・今週の開運カラーを神秘的な文体で日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ㉑ チャクラ診断
  "chakra-check": {
    system: `あなたはチャクラを診るエネルギーヒーラーです。以下の確定済みデータを元に、そのチャクラの意味・滞りの原因・解放のための実践・魂のメッセージを神秘的な文体で日本語で伝えてください。チャクラ名は変えないでください。400文字程度で。`,
    build(body) {
      const { answers, chakra, chakraNum } = body;
      const chakraDesc = chakra ? `特定チャクラ：${chakra}（${chakraNum}）` : `回答：${JSON.stringify(answers)}`;
      return {
        user: `${chakraDesc}\n感情の詰まり：${answers.q2}\n意識したいテーマ：${answers.q3}`,
        extra: { chakra, chakraNum },
      };
    },
  },

  // ㉒ オラクルメッセージ
  "oracle-message": {
    system: `あなたは宇宙のチャネラーです。ユーザーの今の気持ちや状況を受け取り、宇宙からの神秘的なメッセージを詩的な日本語で届けてください。150〜200文字程度で。`,
    build(body) {
      return { user: `今の気持ち・状況：${body.feeling}` };
    },
  },

  // ㉓ 夢解読AI
  "dream-decoder": {
    system: `あなたはスピリチュアルな夢解読師です。ユーザーが見た夢の内容を受け取り、象徴・潜在意識・スピリチュアルな意味を神秘的な文体で日本語で解説してください。300文字程度で。`,
    build(body) {
      return { user: `夢の内容：${body.dream}` };
    },
  },

  // ㉔ 縁結び相性診断
  "soul-compatibility": {
    system: `あなたは魂の縁を読む占い師です。以下の確定済みデータを元に、2人の魂レベルの相性・絆の意味・共に成長するための鍵を神秘的な文体で日本語で届けてください。星座とライフパスナンバーは変えないでください。300文字程度で。`,
    build(body) {
      const { birthdate1, birthdate2 } = body;
      const s1 = getSunSign(birthdate1), s2 = getSunSign(birthdate2);
      const l1 = getLifePathNumber(birthdate1), l2 = getLifePathNumber(birthdate2);
      return {
        user: `1人目：生年月日${birthdate1}・${s1}・ライフパスナンバー${l1}\n2人目：生年月日${birthdate2}・${s2}・ライフパスナンバー${l2}`,
        extra: { person1: { sign: s1, lpn: l1 }, person2: { sign: s2, lpn: l2 } },
      };
    },
  },

  // ㉕ 夢の色彩診断
  "dream-colors": {
    system: `あなたは色彩心理とスピリチュアルを組み合わせた夢解読師です。夢に現れた色の組み合わせから潜在意識のメッセージ・魂の状態・今必要なエネルギーを神秘的な文体で日本語で伝えてください。300文字程度で。`,
    build(body) {
      return { user: `夢に出た色：${body.colors.join("、")}` };
    },
  },

  // ㉖ 月相ジャーナル
  "moon-journal": {
    system: `あなたは月の神秘を語る案内人です。以下の確定済み月相データを元に、内省のための問いかけと月からのメッセージを詩的な日本語で届けてください。月相名は変えないでください。250文字程度で。`,
    build(body) {
      const today = body.today || new Date().toISOString().split("T")[0];
      const moonPhase = body.moonPhase || null;
      const moonAge = body.moonAge ?? null;
      const phaseDesc = moonPhase ? `月相：${moonPhase}（月齢約${moonAge}日）` : `今日の日付：${today}`;
      return { user: `今日の日付：${today}\n${phaseDesc}`, extra: { moonPhase, moonAge } };
    },
  },

  // ㉗ 今日の宇宙メッセージ
  "cosmic-message": {
    system: `あなたは宇宙の意識とつながるチャネラーです。以下の確定済み日付データを元に、今日この日の宇宙的エネルギーと地球上のすべての魂へのメッセージを詩的で神秘的な日本語で届けてください。宇宙数は変えないでください。250文字程度で。`,
    build(body) {
      const today = body.today || new Date().toISOString().split("T")[0];
      const cosmicNumber = body.cosmicNumber ?? null;
      const numDesc = cosmicNumber !== null ? `\n今日の宇宙数：${cosmicNumber}` : '';
      return { user: `今日の日付：${today}${numDesc}`, extra: { cosmicNumber } };
    },
  },

  // ㉘ 今日の開運カラー
  "lucky-color": {
    system: `あなたは色彩運気の占い師です。以下の確定済みデータを元に、今日最も開運をもたらすラッキーカラーを特定し、その色のエネルギー・使い方・今日のアドバイスを神秘的な文体で日本語で伝えてください。本命星・星座・数字は変えないでください。300文字程度で。`,
    build(body) {
      const { birthdate, targetDate } = body;
      const ki = getNineStarKi(birthdate);
      const sign = getSunSign(birthdate);
      const lpn = getLifePathNumber(birthdate);
      return {
        user: `生年月日：${birthdate}\n対象日：${targetDate}\n本命星：${ki.name}\n太陽星座：${sign}\nライフパスナンバー：${lpn}`,
        extra: { honmeisei: ki.name, sign, lifePathNumber: lpn },
      };
    },
  },

  // ㉙ パワーストーン診断
  "crystal-guide": {
    system: `あなたはクリスタルヒーラーです。ユーザーの今の状態を受け取り、最も必要なパワーストーン（水晶、アメジスト、ローズクォーツなど）を特定し、その石のエネルギー・使い方・癒しのメッセージを神秘的な文体で日本語で伝えてください。350文字程度で。`,
    build(body) {
      return { user: `今の状態：${body.currentState}` };
    },
  },

  // ㉚ 手相占い（Vision API使用）
  "palm-reading": {
    vision: true,
    system: `あなたは神秘的な手相占い師です。手のひらの画像を見て、生命線・感情線・頭脳線・運命線・太陽線を丁寧に読み取り、その人の生命力・感情パターン・知性・運命の流れを神秘的で詩的な日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { imageBase64: body.imageBase64, mimeType: body.mimeType || "image/jpeg" };
    },
  },
};

// メール配信対象の占い（mail-pref で選択可能な appId と表示用 label/icon）。
// 占い本文は generateMailReading() が READINGS（handleMysticRequest）で都度生成する。
const DAILY_MAIL_APPS = {
  tarot_draw:     { label: "タロット一枚引き",   icon: "🃏" },
  rune_reading:   { label: "ルーン占い",         icon: "ᚱ" },
  oracle_message: { label: "オラクルメッセージ", icon: "🌌" },
  moon_journal:   { label: "月相ジャーナル",     icon: "📔" },
};

// mail-pref の appId → READINGS のアクション。
const MAIL_APP_TO_ACTION = {
  tarot_draw:     "tarot",
  rune_reading:   "rune-reading",
  oracle_message: "oracle-message",
  moon_journal:   "moon-journal",
};

// ============================================
// MCP 用追加定数・ユーティリティ
// ============================================

const RUNE_NAMES = [
  "フェフ（富と繁栄）","ウルズ（力と野性）","スリサズ（保護と試練）",
  "アンサズ（知恵と啓示）","ライゾ（旅と変化）","ケナズ（創造と洞察）",
  "ゲボ（贈り物と交換）","ウィンジョ（喜びと調和）","ハガラズ（破壊と変革）",
  "ナウシズ（必要性と抵抗）","イサズ（静止と内省）","イェラ（収穫と循環）",
  "イワズ（永続と保護）","ペルズ（秘密と神秘）","アルギズ（守護と高次意識）",
  "ソウィロ（太陽と勝利）","ティワズ（正義と犠牲）","ベルカノ（成長と誕生）",
  "エワズ（変化と忠誠）","マンナズ（人類と自己）","ラグズ（水と直感）",
  "イングワズ（豊穣と完成）","ダガズ（夜明けと変容）","オシラ（家と遺産）",
];

const I_CHING_HEXAGRAMS = [
  "乾（けん）- 天の創造力","坤（こん）- 大地の受容","屯（ちゅん）- 草創の困難",
  "蒙（もう）- 若さと教育","需（じゅ）- 待つこと","訟（しょう）- 争い",
  "師（し）- 軍と大衆","比（ひ）- 結束","小畜（しょうちく）- 小さな蓄積",
  "履（り）- 行為","泰（たい）- 平和","否（ひ）- 停滞",
  "同人（どうじん）- 人との結合","大有（たいゆう）- 大きな豊かさ","謙（けん）- 謙虚",
  "豫（よ）- 喜び","随（ずい）- 従う","蟲（こ）- 腐敗の修正",
  "臨（りん）- 接近","観（かん）- 観察","噬嗑（ぜいこう）- 咬み砕く",
  "賁（ひ）- 飾り","剥（はく）- 剥落","復（ふく）- 回帰",
  "無妄（むぼう）- 無邪気","大畜（たいちく）- 大きな蓄積","頤（い）- 養育",
  "大過（たいか）- 大きな過ぎること","坎（かん）- 深淵","離（り）- 火と光",
  "咸（かん）- 感応","恒（こう）- 永続","遯（とん）- 退却",
  "大壮（たいそう）- 大きな力","晋（しん）- 前進","明夷（めいい）- 光の傷",
  "家人（かじん）- 家族","睽（けい）- 対立","蹇（けん）- 障害",
  "解（かい）- 解放","損（そん）- 減少","益（えき）- 増加",
  "夬（かい）- 決断","姤（こう）- 出会い","萃（すい）- 集合",
  "升（しょう）- 上昇","困（こん）- 困窮","井（せい）- 井戸",
  "革（かく）- 革命","鼎（てい）- 鍋","震（しん）- 雷",
  "艮（ごん）- 山","漸（ぜん）- 徐々に","帰妹（きまい）- 花嫁",
  "豊（ほう）- 豊かさ","旅（りょ）- 旅人","巽（そん）- 風",
  "兌（だ）- 喜び","渙（かん）- 分散","節（せつ）- 節制",
  "中孚（ちゅうふ）- 内なる真実","小過（しょうか）- 小さな過ぎること","既済（きせい）- 完成",
  "未済（みせい）- 未完成",
];

const MERCURY_RETROGRADE_PERIODS = [
  ["2024-08-05","2024-08-28"],
  ["2024-11-25","2024-12-15"],
  ["2025-01-25","2025-02-15"],
  ["2025-05-29","2025-06-22"],
  ["2025-09-21","2025-10-15"],
  ["2026-01-25","2026-02-14"],
  ["2026-05-16","2026-06-09"],
  ["2026-09-11","2026-10-04"],
];

function checkMercuryRetrograde(dateStr) {
  const d = new Date(dateStr);
  for (const [start, end] of MERCURY_RETROGRADE_PERIODS) {
    if (d >= new Date(start) && d <= new Date(end)) {
      return { retrograde: true, period: `${start} 〜 ${end}` };
    }
  }
  return { retrograde: false };
}

function calcBiorhythm(birthdate, targetDate) {
  const days = Math.floor((new Date(targetDate) - new Date(birthdate)) / 86400000);
  return {
    physical:     Math.round(Math.sin(2 * Math.PI * days / 23) * 100),
    emotional:    Math.round(Math.sin(2 * Math.PI * days / 28) * 100),
    intellectual: Math.round(Math.sin(2 * Math.PI * days / 33) * 100),
  };
}

const TAROT_CARDS = [
  "愚者", "魔術師", "女教皇", "女帝", "皇帝", "教皇", "恋人たち",
  "戦車", "力", "隠者", "運命の輪", "正義", "吊るされた男", "死神",
  "節制", "悪魔", "塔", "星", "月", "太陽", "審判", "世界",
];

export {
  READINGS,
  getSunSign, getNineStarKi, getMayaKin, getLifePathNumber, getEto,
  DAILY_MAIL_APPS, MAIL_APP_TO_ACTION,
  RUNE_NAMES, I_CHING_HEXAGRAMS, checkMercuryRetrograde, calcBiorhythm,
  TAROT_CARDS,
};
