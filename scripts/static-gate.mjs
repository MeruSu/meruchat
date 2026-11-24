// scripts/static-gate.mjs — 静态门禁（dev-a 负责的壳层与 list/settings 卡片）
// 跑法：node scripts/static-gate.mjs（在 webapp 目录）
// 检查项：
//   1) index.html 引用的 css/js 都存在
//   2) shell.js 的 CARDS 表里每个模块文件都存在，且该文件 export default 带 mount()
//   3) list.js / settings.js / shell.js 里出现的 class 名，都能在 css/*.css 里找到规则
//   4) 我写的文件里没有残留的 {{...}} 占位符
//   5) index.html 有卡片容器 #cards
"use strict";

import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let failed = 0;
function ok(msg) {
  console.log("  ok   " + msg);
}
function bad(msg) {
  failed++;
  console.log("  FAIL " + msg);
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// ---------------------------------------------------------------- 1. index.html 引用
const html = read("index.html");
const refs = [];
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) refs.push(m[1]);
console.log("[1] index.html 引用的资源");
for (const r of refs) {
  if (/^https?:|^data:/.test(r)) continue;
  if (existsSync(join(ROOT, r))) ok(r);
  else bad("缺文件：" + r);
}

// ---------------------------------------------------------------- 5. 容器
console.log("[5] 卡片容器");
if (/id="cards"/.test(html)) ok('#cards 存在');
else bad('index.html 里没有 id="cards"');

// ---------------------------------------------------------------- 2. shell 的卡片表
const shellSrc = read("js/shell.js");
const cardsBlock = shellSrc.match(/const CARDS = \{([\s\S]*?)\n\};/);
console.log("[2] shell CARDS 表");
if (!cardsBlock) {
  bad("shell.js 里找不到 CARDS 常量");
} else {
  const entries = [...cardsBlock[1].matchAll(/"?([\w-]+)"?:\s*\{\s*module:\s*"([^"]+)"/g)];
  if (!entries.length) bad("CARDS 表里没解析出条目");
  for (const [, id, mod] of entries) {
    const rel = mod.replace(/^\.\//, "js/");
    if (!existsSync(join(ROOT, rel))) {
      bad("卡片 " + id + " 缺模块：" + rel);
      continue;
    }
    const src = read(rel);
    if (!/export\s+default/.test(src)) bad("卡片 " + id + " 没有 export default：" + rel);
    else if (!/async\s+mount\s*\(|mount\s*\(/.test(src)) bad("卡片 " + id + " 没有 mount()：" + rel);
    else ok(id + " → " + rel);
  }
}

// ---------------------------------------------------------------- 3. class 覆盖
console.log("[3] 卡片用到的 class 是否都有 CSS 规则");
// 视觉基准 style-kit.css（照搬 su/preview/styles.html，禁止修改）也算数：.conv / .sidebar-* /
// .sw / .seg / .section-title 这些组件样式都在里面。其余按卡片划分（末尾两个是共用层与申请页）。
const CSS_FILES = [
  "css/style-kit.css",
  "css/theme.css",
  "css/motion.css",
  "css/cards.css",
  "css/card-list.css",
  "css/card-chat.css",
  "css/card-detail.css",
  "css/card-settings.css",
  "css/components.css",
  "css/card-request.css",
];
const cssAll = CSS_FILES.filter((p) => existsSync(join(ROOT, p)))
  .map(read)
  .join("\n");

// 只取我负责的三个文件里「字面量 class 列表」；别的卡片的 class 由它们各自的 CSS 负责
const sources = ["js/shell.js", "js/cards/list.js", "js/cards/settings.js"];
const used = new Set();
for (const rel of sources) {
  const src = read(rel);
  // el("div", "a b") / className = "a b" / classList.add("a") / classList.toggle("a"
  for (const m of src.matchAll(/\bel\(\s*"[^"]*"\s*,\s*"([^"]+)"/g)) {
    m[1].split(/\s+/).forEach((c) => c && used.add(c));
  }
  for (const m of src.matchAll(/className\s*=\s*"([^"]+)"/g)) {
    m[1].split(/\s+/).forEach((c) => c && used.add(c));
  }
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*"([^"]+)"/g)) {
    m[1].split(/\s+/).forEach((c) => c && used.add(c));
  }
}

// 允许的例外：纯结构包装 / 由 JS 动态拼的前缀 / theme.css 里确实没有的语义钩子
const ALLOW = new Set([
  "card", // 由 cardClass() 动态拼：card-<kind>
  "card-error",
  "card-empty-tip",
  "card-fill",
  "cards-wide",
  "cards-narrow",
]);

const missing = [];
for (const c of Array.from(used).sort()) {
  if (ALLOW.has(c)) continue;
  const re = new RegExp("\\." + c.replace(/[-]/g, "\\-") + "(?![\\w-])");
  if (re.test(cssAll)) continue;
  // card-<kind> 这一族由 .card 提供外观，逐个确认
  if (/^card-/.test(c) && /\.card\s*\{/.test(cssAll)) {
    if (new RegExp("\\." + c + "\\b").test(cssAll)) continue;
  }
  missing.push(c);
}
if (missing.length) bad("CSS 里找不到这些 class 规则：" + missing.join(", "));
else ok(used.size + " 个 class 全部有规则");

// ---------------------------------------------------------------- 4. 占位符残留
console.log("[4] 占位符残留");
const mine = [
  "index.html",
  "css/cards.css",
  "js/shell.js",
  "js/core/events.js",
  "js/core/router.js",
  "js/core/theme.js",
  "js/cards/list.js",
  "js/cards/settings.js",
];
for (const rel of mine) {
  const src = read(rel);
  // JSDoc 里的对象字面量类型也会写成 {{a:...}}（小写开头），那不是占位符。
  // 占位符的形态是 {{UPPER_NAME}}（大写开头）。
  const placeholder = (src.match(/\{\{[A-Z]/g) || []).length;
  const passwordish = (src.match(/\{\{PASSWORD_/g) || []).length;
  const real = placeholder - passwordish;
  if (real > 0) bad(rel + " 有 " + real + " 处未解析占位符");
  else ok(rel);
}

// ---------------------------------------------------------------- 6. 每个 js 都能按 ES module 解析
// `node --check foo.js` 按 CommonJS 脚本解析：顶层重复的 function 声明在脚本里合法，
// 到了浏览器按 module 加载就是 `SyntaxError: Identifier 'x' has already been declared`。
// 所以这里复制成 .mjs 再 check，走的是模块解析路径（漏过一次重复声明，才加的这条）。
console.log("[6] js 按 ES module 解析");
{
  const jsFiles = [];
  const walk = (dir) => {
    for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + "/" + ent.name;
      if (ent.isDirectory()) walk(rel);
      else if (ent.name.endsWith(".js")) jsFiles.push(rel);
    }
  };
  if (existsSync(join(ROOT, "js"))) walk("js");
  const tmpDir = mkdtempSync(join(tmpdir(), "gate-mod-"));
  let broken = 0;
  jsFiles.forEach((rel, i) => {
    const probe = join(tmpDir, "f" + i + ".mjs");
    writeFileSync(probe, read(rel));
    // stdio: "ignore" 是必须的：沙箱里带管道的子进程会 EPERM，只要退出码就别接管道
    const r = spawnSync(process.execPath, ["--check", probe], { stdio: "ignore" });
    if (r.status !== 0) {
      broken++;
      const msg = r.error ? String(r.error.code || r.error.message) : "exit " + r.status;
      bad(rel + " 不是合法模块（" + msg + "）");
    }
  });
  rmSync(tmpDir, { recursive: true, force: true });
  if (!broken) ok(jsFiles.length + " 个 js 文件均为合法模块");
}

// ---------------------------------------------------------------- 汇总
console.log("");
if (failed) {
  console.log(failed + " 项未通过");
  process.exitCode = 1;
} else {
  console.log("静态门禁全部通过");
}