// ============================================
// 無料版フロントの生成 — tools/build-free-pages.mjs
//
// apps/*.html と index.html を「唯一の定義源」として free/ 以下を生成する。
// 無料版のためにページを手でコピーすると、有料版のUI修正が無料版に届かなくなる。
// 生成物（free/apps/ と free/index.html）は手で編集しないこと。
//
//   npm run build:free
//
// 変換内容:
//   1. script src の ../mystic-login.js → ../mystic-free.js（差し替えの本体）
//   2. ../mystic.css → ../../mystic.css（free/apps/ は1階層深いため）
//   3. palm-reading（Vision）は無料版の対象外なので除外
//   4. *-manifest.json を併せてコピー
// ============================================

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = join(ROOT, "apps");
const OUT = join(ROOT, "free", "apps");

// 無料版から外す占い（Vision はコスト増幅と濫用リスクが別格）
const EXCLUDED = new Set(["palm-reading"]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const pages = readdirSync(APPS).filter(f => f.endsWith(".html"));
let written = 0;
const skipped = [];

for (const file of pages) {
  const id = file.replace(/\.html$/, "");
  if (EXCLUDED.has(id)) { skipped.push(id); continue; }

  const src = readFileSync(join(APPS, file), "utf8");
  if (!src.includes("../mystic-login.js")) {
    throw new Error(`${file}: ../mystic-login.js が見つかりません（構造が変わった可能性）`);
  }

  const out = src
    .replaceAll("../mystic-login.js", "../mystic-free.js")
    .replaceAll("../mystic.css", "../../mystic.css");

  writeFileSync(join(OUT, file), out);

  // マニフェストがあれば併せてコピー
  const manifest = `${id}-manifest.json`;
  try {
    writeFileSync(join(OUT, manifest), readFileSync(join(APPS, manifest), "utf8"));
  } catch { /* マニフェストが無いページは無視 */ }

  written++;
}

// ── free/index.html を index.html の hub-card 行から生成する。
// カード一覧を手書きすると、占いを増やしたときに無料版だけ古くなる。
const indexSrc = readFileSync(join(ROOT, "index.html"), "utf8");
const cards = indexSrc
  .split("\n")
  .map(l => l.trim())
  .filter(l => l.startsWith('<a href="apps/') && l.includes("hub-card"))
  .filter(l => ![...EXCLUDED].some(id => l.includes(`apps/${id}.html`)));

if (cards.length !== written) {
  throw new Error(`index.html のカード数(${cards.length})と生成ページ数(${written})が一致しません`);
}

const freeIndex = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>とむMYSTIC 無料版 — ${written}種類の占いを毎日お試し</title>
<meta name="description" content="とむMYSTICの占い${written}種類を無料でお試し。1日3回まで、登録不要ですぐ使えます。"/>
<link rel="stylesheet" href="../mystic.css"/>
<style>
  .mf-hero{text-align:center;padding:1.6rem 1rem .4rem}
  .mf-hero h1{font-size:1.25rem;margin:0 0 .5rem}
  .mf-hero p{font-size:.86rem;color:#b8a4ff;margin:0 auto;max-width:32rem;line-height:1.8}
  .mf-done{opacity:.45}
  .mf-foot{text-align:center;padding:1.6rem 1rem 2.4rem;font-size:.82rem;color:#b8a4ff;line-height:1.9}
  .mf-foot a{color:#e6dcff}
</style>
</head>
<body>
<header>
  <a href="./index.html" class="logo">✦ とむMYSTIC 無料版</a>
</header>
<main id="app">
  <div class="mf-hero">
    <h1>${written}種類の占いを、毎日すこしずつ</h1>
    <p>登録不要。1日3回まで（初日は5回）お試しいただけます。
       ぜんぶ試すには約9日かかります——明日もぜひ。</p>
  </div>
  <div class="hub-grid">
${cards.map(c => "    " + c).join("\n")}
  </div>
  <div class="mf-foot">
    無料版は予告なく終了する場合があります。<br>
    毎朝メール・履歴保存・回数無制限は
    <a href="https://tomu-ai963.github.io/tomu-mystic/">とむMYSTIC（有料版）</a>で。
  </div>
</main>
<script src="./mystic-free.js"></script>
<script>
// 試した占いを控えめに示す（進捗が見えないと「3回で止められた」体験になる）
document.addEventListener("DOMContentLoaded", () => {
  let tried = [];
  try { tried = JSON.parse(localStorage.getItem("mystic_free_tried") || "[]"); } catch {}
  if (!Array.isArray(tried)) return;
  for (const a of document.querySelectorAll('a[href^="apps/"]')) {
    const id = a.getAttribute("href").replace("apps/", "").replace(".html", "");
    if (tried.includes(id)) a.classList.add("mf-done");
  }
});
</script>
</body>
</html>
`;

writeFileSync(join(ROOT, "free", "index.html"), freeIndex);

console.log(`無料版フロント生成: ${written} ページ + index.html`);
console.log(`除外: ${skipped.join(", ") || "なし"}`);
