#!/usr/bin/env node
// ============================================
// とむMYSTIC — 未解決参照スキャナ
//
// 目的: モジュール分割・ファイル間のコード移動で export/import が張られず、
//       「別モジュールのトップレベル宣言を、import せずに参照している」状態を検出する。
//
// なぜ必要か:
//   wrangler 内蔵の esbuild は未解決識別子を「グローバル参照」として扱うため、
//   export/import が漏れていてもビルドは警告ゼロで通る（--dry-run も通る）。
//   破損は実行時 ReferenceError として本番で初めて顕在化する。
//   さらに広い try/catch がそれを握り潰すと、設定ミスや外部サービス起因の
//   エラーに化けて原因調査を大きく誤らせる。
//
//   実例: 6e556ce のモジュール分割で 4 箇所が未解決参照のまま本番稼働し、
//   ALLOWED_REDIRECT_ORIGINS の欠落によりサブスク決済導線が約6週間停止した
//   （catch が ReferenceError を飲み、400 "Invalid redirect URL" に化けていた）。
//   修正は 2fa2fae。
//
// 使い方: npm run scan:unresolved-refs
//   検出ゼロ → exit 0 / 1件以上 → exit 1（CI・pre-commit フックで使える）
//
// 走査対象は wrangler.toml の main から相対 import を再帰的に辿って決める。
// 将来モジュールを増やしても、import で繋がっていれば自動的に対象に入る。
// ============================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- wrangler.toml のエントリポイントを取得 ----------------------
function entryFromWrangler(configRel = "wrangler.toml") {
  const configPath = path.join(ROOT, configRel);
  const toml = fs.readFileSync(configPath, "utf8");
  // 先頭が [section] でない位置の main = "..." を拾う（[[queues]] 等の中は見ない）
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*main\s*=\s*["']([^"']+)["']/);
    // wrangler の main は「設定ファイルからの相対パス」。
    // free/wrangler.free.toml のように別ディレクトリの設定でも辿れるようにする。
    if (m) {
      return path
        .relative(ROOT, path.resolve(path.dirname(configPath), m[1]))
        .split(path.sep).join("/");
    }
  }
  throw new Error(`${configRel} に main が見つかりません`);
}

// ---- import 文の解析 --------------------------------------------
// 相対 import のパス（グラフ構築用）と、その文が束縛する名前（ローカル束縛用）を返す。
const IMPORT_RE = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*(?:from\s*)?["']([^"']+)["']/g;

function parseImports(src) {
  const specs = [];
  const bound = new Set();
  for (const m of src.matchAll(IMPORT_RE)) {
    const [, defaultWithNamed, named, namespace, bareDefault, spec] = m;
    specs.push(spec);
    if (defaultWithNamed) bound.add(defaultWithNamed);
    if (namespace) bound.add(namespace);
    if (bareDefault) bound.add(bareDefault);
    if (named) {
      for (const part of named.split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) bound.add(name);
      }
    }
  }
  return { specs, bound };
}

// ---- モジュールグラフを構築 --------------------------------------
function buildGraph(entry) {
  const modules = new Map(); // 相対パス → { src, imports }
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (modules.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error(`  ! import 先が見つかりません: ${rel}`);
      continue;
    }
    const src = fs.readFileSync(abs, "utf8");
    const { specs, bound } = parseImports(src);
    modules.set(rel, { src, bound });
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue; // node: / npm パッケージは対象外
      queue.push(path.normalize(path.join(path.dirname(rel), spec)).replace(/\\/g, "/"));
    }
  }
  return modules;
}

// ---- 宣言の収集 --------------------------------------------------
// トップレベル宣言（行頭）= 他モジュールから参照されうる「そのモジュールの持ち物」
const TOP_DECL_RE = /^(?:export\s+)?(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gm;

// ローカル束縛（インデントを問わない全宣言＋分割代入）
// 「このファイル内のどこにも宣言がない」ものだけを検出したいので、
// 束縛側は広めに拾って誤検知を抑える。
const ANY_DECL_RE = /(?:^|[^\w$.])(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/g;
const DESTRUCT_RE = /(?:const|let|var)\s*(?:\{([^}]*)\}|\[([^\]]*)\])\s*=/g;
const PARAM_RE = /(?:function\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([\w$]+)\s*=>)/g;

function collectLocalBindings(src) {
  const bound = new Set();
  for (const m of src.matchAll(ANY_DECL_RE)) bound.add(m[1]);
  for (const m of src.matchAll(DESTRUCT_RE)) {
    for (const part of (m[1] || m[2] || "").split(",")) {
      // { a, b: c, d = 1, ...rest } → 束縛される側の名前を拾う
      const name = part.split(":").pop().split("=")[0].replace(/[.\s]/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }
  for (const m of src.matchAll(PARAM_RE)) {
    for (const part of (m[1] || m[2] || m[3] || "").split(",")) {
      const name = part.split(":").pop().split("=")[0].replace(/[.\s]/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }
  return bound;
}

// コメント・文字列リテラル内の言及で誤検知しないよう、行頭コメントと
// 行コメント部分を落とした「コード面」を作る。
function codeSurface(src) {
  return src.split("\n").map(line => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return "";
    return line.replace(/\/\/.*$/, "");
  });
}

// ---- 走査 --------------------------------------------------------
// 引数で別の wrangler 設定を指定できる（例: 無料版 free/wrangler.free.toml）
const entry = entryFromWrangler(process.argv[2] || "wrangler.toml");
const modules = buildGraph(entry);

// 各モジュールのトップレベル宣言 = このリポジトリの自作シンボル
const topDecls = new Map();
for (const [rel, mod] of modules) {
  topDecls.set(rel, new Set([...mod.src.matchAll(TOP_DECL_RE)].map(m => m[1])));
}
const ownSymbols = new Map(); // シンボル名 → 定義元モジュール
for (const [rel, names] of topDecls) {
  for (const n of names) if (!ownSymbols.has(n)) ownSymbols.set(n, rel);
}

const findings = [];
for (const [rel, mod] of modules) {
  const localBound = collectLocalBindings(mod.src);
  const lines = codeSurface(mod.src);
  for (const [name, definedIn] of ownSymbols) {
    if (definedIn === rel) continue;
    if (localBound.has(name) || mod.bound.has(name)) continue;
    const re = new RegExp(String.raw`(?<![.\w$])` + name + String.raw`\b`);
    lines.forEach((line, i) => {
      if (re.test(line)) findings.push({ file: rel, line: i + 1, name, definedIn });
    });
  }
}

// ---- 報告 --------------------------------------------------------
console.log(`未解決参照スキャン: ${modules.size} モジュール（entry: ${entry}）`);
if (!findings.length) {
  console.log("✓ clean — 未解決の相互参照はありません");
  process.exit(0);
}

const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}
console.error(`\n✗ ${findings.length} 件の未解決参照を検出しました\n`);
for (const [file, items] of byFile) {
  console.error(`  ${file}`);
  for (const it of items) {
    console.error(`    ${file}:${it.line}  ${it.name}  → ${it.definedIn} のトップレベル宣言だが import されていない`);
  }
  console.error("");
}
console.error("実行時に ReferenceError になります。定義元で export し、参照側で import してください。");
console.error("（esbuild は未解決識別子をグローバル参照として扱うため、ビルドは通ってしまいます）");
process.exit(1);
