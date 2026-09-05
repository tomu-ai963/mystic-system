// ============================================
// とむMYSTIC — mystic-validation.js
// 占いリクエストの入力バリデーション。有料版 Worker（tomu-mystic-worker.js）と
// 無料版 Worker（free/worker.js）の両方から import する共有モジュール。
//
// ここを唯一の定義源とする理由: 無料版は認証を持たない分、入力検証が
// コスト増幅攻撃に対する最初の防御線になる。有料版と別実装にすると
// 片方だけ緩い状態が生まれ、緩いほうが必ず狙われる。
// ============================================

import { validateInput, MAX_TEXT_LEN } from "./shared.js";

// ============================================
// 入力バリデーション
// 失敗時は 400 { error: "Invalid input" } を返し、詳細理由は開示しない。
// ============================================

// /api/mystic で受理する action（appId）の許可リスト
const ALLOWED_ACTIONS = new Set([
  "star-reading", "numerology", "guardian-star", "nine-star-ki", "maya-calendar",
  "animal-fortune", "name-fortune", "biorhythm", "moon-sign", "eastern-stars",
  "horoscope-deep", "tarot", "rune-reading", "oracle-cards", "nine-palace",
  "past-life", "past-profession", "soul-mission", "spirit-animal", "aura-reading",
  "chakra-check", "oracle-message", "dream-decoder", "soul-compatibility", "dream-colors",
  "moon-journal", "cosmic-message", "lucky-color", "crystal-guide", "palm-reading",
]);

// action ごとの「必須かつ空文字NGのテキスト項目」
const REQUIRED_TEXT_FIELDS = {
  "animal-fortune": ["animal"],
  "name-fortune": ["fullName"],
  "tarot": ["card"],
  "rune-reading": ["rune"],
  "oracle-cards": ["theme", "card"],
  "oracle-message": ["feeling"],
  "dream-decoder": ["dream"],
  "crystal-guide": ["currentState"],
};

// palm-reading の画像入力上限（デコード後バイト数）と MIME ホワイトリスト。
// Vision API へのコスト増幅攻撃対策のため、必ず AI 呼び出し前（validateMysticBody）で検証する。
// ホワイトリストは Claude Vision API が受理する media_type に一致させる。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// palm-reading の画像ペイロード検証。
// サイズ（デコード後 5MB 以下）→ base64 文字種（data URL 接頭辞・空白は不可）→ MIME の順にチェック。
function isValidImagePayload(imageBase64, mimeType) {
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) return false;
  // デコード後サイズ = 文字数×3/4 − パディング（O(1)で算出し、巨大文字列への正規表現適用を避ける）
  const padding = imageBase64.endsWith("==") ? 2 : imageBase64.endsWith("=") ? 1 : 0;
  if (imageBase64.length * 3 / 4 - padding > MAX_IMAGE_BYTES) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return false;
  // mimeType 未指定時は image/jpeg として扱う（READINGS["palm-reading"].build の既定値と一致）
  return ALLOWED_IMAGE_MIME_TYPES.includes(mimeType === undefined ? "image/jpeg" : mimeType);
}

// 占いリクエスト（/api/mystic・/mystic/*）のボディ検証
function validateMysticBody(action, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;

  // すべての文字列フィールドは MAX_TEXT_LEN 以内（手相の画像データ imageBase64 は isValidImagePayload で別途検証）
  for (const [key, v] of Object.entries(body)) {
    if (key === "imageBase64") continue;
    if (typeof v === "string" && v.length > MAX_TEXT_LEN) return false;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.length > MAX_TEXT_LEN) return false;
      }
    }
  }

  // 生年月日（存在する場合のみ・未来日／不正形式NG）
  for (const key of ["birthdate", "birthdate1", "birthdate2"]) {
    if (body[key] !== undefined && !validateInput("birthdate", body[key])) return false;
  }

  // 必須テキスト（空文字NG・1000文字以上NG）
  const requiredText = REQUIRED_TEXT_FIELDS[action];
  if (requiredText) {
    for (const field of requiredText) {
      if (!validateInput("text", body[field])) return false;
    }
  }

  // 夢の色彩：colors は非空の文字列配列
  if (action === "dream-colors") {
    if (!Array.isArray(body.colors) || body.colors.length === 0) return false;
    if (!body.colors.every(c => validateInput("text", c))) return false;
  }

  // 手相：画像データ必須（デコード後 5MB 以下・MIME ホワイトリスト）
  if (action === "palm-reading") {
    if (!isValidImagePayload(body.imageBase64, body.mimeType)) return false;
  }

  return true;
}

export {
  ALLOWED_ACTIONS, REQUIRED_TEXT_FIELDS,
  MAX_IMAGE_BYTES, ALLOWED_IMAGE_MIME_TYPES,
  isValidImagePayload, validateMysticBody,
};
