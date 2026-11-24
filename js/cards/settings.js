// js/cards/settings.js — 全局设置卡片（主题色、默认聊天背景、API Base URL / 模型 / API Key）
// DOM 逐字照抄 C:\Meru\website\su\preview\styles.html 第 833-869 行（aside.sidebar-right），
// 只做三处调整：壁纸 <select> 换成 .seg 三按钮 + 上传图片按钮；不新增亮度/深浅/画幅；文字换成变量。
// 视觉全部交给 css/style-kit.css（该文件禁止修改）；本卡片只写外框。
// 背景的两层归属见 docs/DEV.md §2.2.1：这里改的是「全局默认」，单会话覆盖在详情卡。
"use strict";

import { el, errorText } from "../core/util.js";
import { getSelf, DEFAULT_CONTEXT_BUDGET } from "../core/store.js";
import { renderAvatar } from "../ui/avatar.js";

const TITLE = "设置";

// 照 styles.html 854-857 行的四个 .sw + 用户新增的浅灰 = 5 个；色块下面不写文字，label 只给 title/aria-label。
// 主题色只有一个来源：settings.accent（色值）；浅灰 #e5e5ea（iOS systemGray5）是默认色（§2.3 DEFAULT_ACCENT）。
// 用户明确否掉过「白」：白气泡在纯白卡面上必隐形，而描边也一并被否，所以默认改成浅灰。
const ACCENTS = [
  { color: "#e5e5ea", label: "灰" },
  { color: "#0075de", label: "蓝" },
  { color: "#00a884", label: "绿" },
  { color: "#7c5cff", label: "紫" },
  { color: "#d97757", label: "橙" },
];

// 壁纸：唯一权威枚举在 store.js（WALLPAPERS = aurora/forest/dusk），这里只负责文案
const WALLS = [
  { key: "aurora", label: "极光" },
  { key: "forest", label: "深绿" },
  { key: "dusk", label: "暮紫" },
];

/** settings.accent 就是色值，直接对上色块 */
function accentKeyOf(settings) {
  const a = String((settings && settings.accent) || "");
  const hit = ACCENTS.filter((x) => x.color === a)[0];
  return hit ? hit.color : ACCENTS[0].color;
}

/** 预算输入框 → 数字：空/非法回落默认，负数归 0（0 = 不限，全量直喂） */
function parseBudget(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return DEFAULT_CONTEXT_BUDGET;
  const n = Number(s);
  if (!isFinite(n)) return DEFAULT_CONTEXT_BUDGET;
  return Math.max(0, Math.round(n));
}

// ---------------------------------------------------------------- 检查更新（卡底）
// 版本号唯一权威：android/app/build.gradle 的 versionName（真机上由 Capacitor App 插件的 getInfo() 报出来）。
// 浏览器里没有插件 → 回落下面这个常量。版本是只读展示，绝不写进 settings（settings 只放可改的偏好）。
const APP_VERSION = "0.1.0";
// 版本清单走 raw.githubusercontent（CORS 放开、无限流），不走 api.github.com：
// 后者匿名 60 次/小时/IP，且 /releases/latest 会排除 pre-release，我们首个版本就是 pre-release。
const VERSION_MANIFEST =
  "https://raw.githubusercontent.com/MeruSu/meruchat/main/version.json";
const RELEASES_PAGE = "https://github.com/MeruSu/meruchat/releases";

/** 当前 App 版本：Capacitor App 插件优先（try/catch + await），拿不到回落 APP_VERSION */
async function currentAppVersion() {
  try {
    const cap = typeof window !== "undefined" ? window.Capacitor : null;
    const app = cap && cap.Plugins ? cap.Plugins.App : null;
    if (app && typeof app.getInfo === "function") {
      const info = await app.getInfo();
      const v = info && info.version ? String(info.version).trim() : "";
      if (v) return v;
    }
  } catch (e) {
    // 插件缺失 / 桥接异常都算「拿不到」：静默回落常量，不往控制台外抛
  }
  return APP_VERSION;
}

/** "v0.1.10" → [0, 1, 10]：只取前缀数字段（-beta.1 这类后缀不参与比较，避免把 0.2.0-rc 判成 0.2.0.0.1） */
function versionParts(v) {
  const s = String(v == null ? "" : v).trim().replace(/^[vV]/, "");
  const core = s.match(/^\d+(?:\.\d+)*/);
  if (!core) return [0];
  return core[0].split(".").map((x) => parseInt(x, 10));
}

/** 语义化比较：逐位比数字（0.1.10 > 0.1.9），a>b → 1，a<b → -1，相等 → 0 */
function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = i < pa.length ? pa[i] : 0;
    const y = i < pb.length ? pb[i] : 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 拉版本清单 → { version: "0.1.1", url }；HTTP 非 2xx / 没有 version 都抛 Error（由调用方展示） */
async function fetchLatestRelease() {
  // raw.githubusercontent.com 带 Access-Control-Allow-Origin: *，且没有 API 限流
  const res = await fetch(VERSION_MANIFEST, { cache: "no-store" });
  if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "???"));
  const data = await res.json();
  const ver = data && data.version ? String(data.version).trim() : "";
  if (!ver) throw new Error("版本清单里没有 version");
  const url = data && data.downloadUrl ? String(data.downloadUrl) : RELEASES_PAGE;
  return { version: ver.replace(/^[vV]/, ""), url: url };
}

/** 照 styles.html 833-869 行，逐字（壁纸 select 换成 .seg；模型接口接在最后） */
function buildAsideHtml() {
  const swatches = ACCENTS.map(
    (a, i) =>
      '<button class="sw' +
      (i === 0 ? " active" : "") +
      '" type="button" data-accent="' +
      a.color +
      '" title="' +
      a.label +
      '"><i style="background:' +
      a.color +
      '"></i></button>'
  ).join("");
  const segs = WALLS.map(
    (w) => '<button type="button" data-wall="' + w.key + '">' + w.label + "</button>"
  ).join("");
  // 大头像 = 用户自己：内容由 js/ui/avatar.js 渲染器写入（这里只留空壳）
  return (
    '<button class="sr-back" id="srBack" type="button" aria-label="返回">‹</button>' +
    '<div class="sr-scroll">' +
    '<div class="avatar-block">' +
    '<div class="big-ava" id="bigAva"></div>' +
    "</div>" +
    '<div class="name-center">' +
    '<div class="name-text" id="nameText"></div>' +
    "</div>" +
    '<div class="section-title">外观</div>' +
    '<div class="field">' +
    '<label class="lbl">主题色</label>' +
    '<div class="swatches" id="accentSel">' +
    swatches +
    "</div>" +
    "</div>" +
    '<div class="field">' +
    '<label class="lbl" for="wallSel">壁纸</label>' +
    '<div class="seg" id="wallSel">' +
    segs +
    "</div>" +
    "</div>" +
    '<div class="section-title">模型与接口</div>' +
    '<div class="field">' +
    '<label class="lbl" for="baseUrlInput">API Base URL</label>' +
    '<input id="baseUrlInput" type="text" spellcheck="false" placeholder="http://127.0.0.1:3425/v1" />' +
    "</div>" +
    '<div class="field">' +
    '<label class="lbl" for="modelInput">模型</label>' +
    '<input id="modelInput" type="text" spellcheck="false" placeholder="group/meru" />' +
    "</div>" +
    '<div class="field">' +
    '<label class="lbl" for="apiKeyInput">API Key</label>' +
    '<input id="apiKeyInput" type="password" spellcheck="false" autocomplete="off" placeholder="Bearer key" />' +
    "</div>" +
    '<div class="field">' +
    '<button class="btn" id="saveBtn" type="button">保存</button>' +
    "</div>" +
    '<div class="section-title">上下文</div>' +
    '<div class="field">' +
    '<label class="lbl" for="contextBudgetInput">上下文预算（token）</label>' +
    '<input id="contextBudgetInput" type="number" min="2000" max="100000" step="1000" inputmode="numeric" />' +
    '<div class="lbl" id="budgetHint"></div>' +
    "</div>" +
    '<div class="field">' +
    '<label class="lbl">自动压缩</label>' +
    '<div class="seg" id="compressSel">' +
    '<button type="button" data-compress="1">开</button>' +
    '<button type="button" data-compress="0">关</button>' +
    "</div>" +
    "</div>" +
    '<div class="section-title">搜索</div>' +
    '<div class="field">' +
    '<label class="lbl" for="searchUrlInput">搜索地址</label>' +
    '<input id="searchUrlInput" type="text" spellcheck="false" placeholder="留空 = 未配置（工具会报 search_not_configured）" />' +
    "</div>" +
    '<div class="field">' +
    '<label class="lbl" for="searchKeyInput">搜索 Key</label>' +
    '<input id="searchKeyInput" type="password" spellcheck="false" autocomplete="off" placeholder="可空" />' +
    "</div>" +
    "</div>"
  );
}

export default {
  id: "settings",
  title: TITLE,

  async mount(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.disposers = [];

    const wrap = el("aside", "phone-win sidebar-right");
    wrap.id = "sidebarRight";
    wrap.innerHTML = buildAsideHtml();
    this.wrap = wrap;
    this.bodyEl = wrap.querySelector(".sr-scroll");

    const back = wrap.querySelector(".sr-back");
    const swatches = wrap.querySelector(".swatches");
    const seg = wrap.querySelector(".seg");
    const saveBtn = wrap.querySelector("#saveBtn");
    const baseInput = wrap.querySelector("#baseUrlInput");
    const modelInput = wrap.querySelector("#modelInput");
    const keyInput = wrap.querySelector("#apiKeyInput");
    const searchUrlInput = wrap.querySelector("#searchUrlInput");
    const searchKeyInput = wrap.querySelector("#searchKeyInput");
    const bigAvaEl = wrap.querySelector("#bigAva");
    const nameTextEl = wrap.querySelector("#nameText");
    this.bigAvaEl = bigAvaEl;
    this.nameTextEl = nameTextEl;

    this.swatchEls = Object.create(null);
    this.wallEls = Object.create(null);
    ACCENTS.forEach((a) => {
      const sw = swatches.querySelector('[data-accent="' + a.color + '"]');
      sw.addEventListener("click", () => this.apply({ accent: a.color }));
      this.swatchEls[a.color] = sw;
    });
    WALLS.forEach((w) => {
      const b = seg.querySelector('[data-wall="' + w.key + '"]');
      b.addEventListener("click", () => this.chooseWall(w.key));
      this.wallEls[w.key] = b;
    });

    this.baseInput = baseInput;
    this.modelInput = modelInput;
    this.keyInput = keyInput;
    this.searchUrlInput = searchUrlInput;
    this.searchKeyInput = searchKeyInput;

    // 上下文（§2.6）：预算 + 自动压缩开关
    const budgetInput = wrap.querySelector("#contextBudgetInput");
    const budgetHint = wrap.querySelector("#budgetHint");
    const compressSeg = wrap.querySelector("#compressSel");
    this.budgetInput = budgetInput;
    this.budgetHint = budgetHint;
    this.compressEls = Object.create(null);
    if (budgetInput) budgetInput.addEventListener("input", () => this.syncBudgetHint());
    if (compressSeg) {
      ["1", "0"].forEach((flag) => {
        const b = compressSeg.querySelector('[data-compress="' + flag + '"]');
        if (!b) return;
        b.addEventListener("click", () => this.apply({ contextCompress: flag === "1" }));
        this.compressEls[flag] = b;
      });
    }

    // 点自己的名字 = 改名（表单形态与设计稿一致：纯文本 + 点击弹输入）
    nameTextEl.addEventListener("click", () => this.renameSelf());
    saveBtn.addEventListener("click", () =>
      this.save({
        baseUrl: baseInput.value.trim(),
        model: modelInput.value.trim(),
        apiKey: keyInput.value.trim(),
        searchUrl: searchUrlInput.value.trim(),
        searchKey: searchKeyInput.value.trim(),
        contextBudget: budgetInput ? budgetInput.value : undefined,
        contextCompress: this.currentCompress(),
      })
    );

    // 说明文字接在可滚区末尾（属于设置内容，不另起一块）
    this.bodyEl.appendChild(el("div", null, "保存后立刻生效；聊天卡片里不再单独配置模型。"));

    // 检查更新（卡底，只读展示 + 一次网络检查）
    const upd = this.buildUpdateSection();
    this.updateBox = upd.box;
    this.updateVerEl = upd.verEl;
    this.updateBtn = upd.checkBtn;
    this.downloadBtn = upd.dlBtn;
    this.updateStatusEl = upd.statusEl;
    upd.checkBtn.addEventListener("click", () => this.checkUpdate());
    upd.dlBtn.addEventListener("click", () => {
      // Capacitor 里 window.open 交给系统浏览器
      window.open(this.downloadUrl || RELEASES_PAGE, "_blank");
    });
    this.bodyEl.appendChild(upd.box);
    // 真机 getInfo() 是异步的：先按常量渲染，拿到真版本再改文案（拿不到就保持常量）
    currentAppVersion()
      .then((v) => {
        if (this.updateVerEl) this.updateVerEl.textContent = "当前版本 " + v;
      })
      .catch(() => {});

    back.addEventListener("click", () => ctx.router.back());

    root.appendChild(wrap);
  },

  async onEnter() {
    const { store, events } = this.ctx;
    const s = await store.getSettings();
    this.ctx.settings = s;
    this.fill(s);
    events.emit("settings:applied", s);
  },

  async onLeave() {},

  async unmount() {
    (this.disposers || []).forEach((fn) => fn());
    this.disposers = [];
    this.root = null;
    this.bodyEl = null;
    // 检查更新的引用一起放掉：await 回来时元素已脱离，写文案也不该再碰（见 checkUpdate 的 finally）
    this.updateBox = null;
    this.updateVerEl = null;
    this.updateBtn = null;
    this.downloadBtn = null;
    this.updateStatusEl = null;
  },

  // ================================================================ 填值 / 高亮
  fill(s) {
    const st = s || {};
    // 大头像 = 用户自己（唯一入口 getSelf；内容交给统一渲染器）
    const self = getSelf(st);
    if (this.bigAvaEl) {
      // 颜色：显式 color 优先，否则跟随用户主题色（§2.3 resolveAvatarColor）
      renderAvatar(this.bigAvaEl, self.avatar, { accent: accentKeyOf(st) });
      this.bigAvaEl.setAttribute("title", self.name);
    }
    if (this.nameTextEl) this.nameTextEl.textContent = self.name;

    if (this.baseInput) this.baseInput.value = st.baseUrl || "";
    if (this.modelInput) this.modelInput.value = st.model || "";
    if (this.keyInput) this.keyInput.value = st.apiKey || "";
    if (this.searchUrlInput) this.searchUrlInput.value = st.searchUrl || "";
    if (this.searchKeyInput) this.searchKeyInput.value = st.searchKey || "";

    const accent = accentKeyOf(st);
    for (const key of Object.keys(this.swatchEls || {})) {
      this.swatchEls[key].classList.toggle("active", key === accent);
    }
    const wall = st.defaultWallpaper || "gradient";
    for (const key of Object.keys(this.wallEls || {})) {
      this.wallEls[key].classList.toggle("active", key === wall);
    }

    // 上下文（§2.6）：预算 / 自动压缩
    const budget = typeof st.contextBudget === "number" ? st.contextBudget : DEFAULT_CONTEXT_BUDGET;
    // 正在输入时不要用设置值盖掉用户的手输
    if (this.budgetInput && this.budgetInput !== document.activeElement) {
      this.budgetInput.value = String(budget);
    }
    const compressOn = st.contextCompress !== false;
    for (const key of Object.keys(this.compressEls || {})) {
      this.compressEls[key].classList.toggle("active", (key === "1") === compressOn);
    }
    this.syncBudgetHint();
  },

  /** 预算提示：0 → 不限（全量直喂）；否则说明超预算会折叠最旧的一批 */
  syncBudgetHint() {
    if (!this.budgetHint) return;
    const budget = parseBudget(this.budgetInput ? this.budgetInput.value : "");
    const on = this.ctx && this.ctx.settings ? this.ctx.settings.contextCompress !== false : true;
    if (!budget) {
      this.budgetHint.textContent = "不限（全量直喂）";
      return;
    }
    this.budgetHint.textContent =
      "超过 " + budget + " token 后折叠最旧的一批" + (on ? "" : "（自动压缩已关，暂不生效）");
  },

  /** 自动压缩开关当前选择（seg 高亮为准，回落设置值） */
  currentCompress() {
    const st = (this.ctx && this.ctx.settings) || {};
    return st.contextCompress !== false;
  },

  // ================================================================ 自己
  /** 点名字 = 改名；写回 User.name（settings.name），头像随之更新 */
  async renameSelf() {
    const cur = getSelf();
    const name = await this.ctx.prompt("你的名字", cur.name);
    if (name == null) return;
    const trimmed = String(name).trim();
    if (!trimmed) return;
    // avatar.color 留 null = 继续跟随主题色（写死色值就不再跟主题色走了）
    const avatar = { label: Array.from(trimmed)[0] || "?", color: null };
    await this.apply({ name: trimmed, avatar });
  },

  // ================================================================ 背景
  /** 点壁纸三项之一：写 settings.defaultWallpaper（单会话覆盖在详情卡） */
  async chooseWall(key) {
    await this.apply({ defaultWallpaper: key });
  },

  // ================================================================ 写设置
  async apply(patch) {
    const { store, events } = this.ctx;
    const next = await store.setSettings(patch);
    this.ctx.settings = next;
    this.fill(next);
    events.emit("settings:changed", patch);
    events.emit("settings:applied", next);
  },

  async save(patch) {
    const { store, events } = this.ctx;
    const cur = this.ctx.settings || {};
    // 空值不覆盖已有值：Base URL / 模型留空回退旧值；Key 允许清空
    const clean = {
      baseUrl: patch.baseUrl || cur.baseUrl,
      model: patch.model || cur.model,
      apiKey: patch.apiKey || "",
      searchUrl: patch.searchUrl || "",
      searchKey: patch.searchKey || "",
      // 上下文（§2.6）：预算输入框 → 数字（0 = 不限）；开关默认沿用当前值
      contextBudget: patch.contextBudget === undefined ? cur.contextBudget : parseBudget(patch.contextBudget),
      contextCompress: patch.contextCompress === undefined ? cur.contextCompress !== false : !!patch.contextCompress,
    };
    const next = await store.setSettings(clean);
    this.ctx.settings = next;
    this.fill(next);
    events.emit("settings:changed", clean);
    events.emit("settings:applied", next);
    events.emit("toast", { text: "设置已保存" });
  },

  // ================================================================ 检查更新
  /** 卡底区块骨架：标题 / 版本 + 两个按钮一行 / 三态提示 / 小字说明 */
  buildUpdateSection() {
    const box = el("div", "update-box");
    box.appendChild(el("div", "section-title", "检查更新"));

    const row = el("div", "update-row");
    const verEl = el("span", "update-ver", "当前版本 " + APP_VERSION);
    const checkBtn = el("button", "btn update-btn", "检查更新");
    checkBtn.type = "button";
    const dlBtn = el("button", "btn update-dl-btn", "下载");
    dlBtn.type = "button";
    dlBtn.hidden = true; // 只有发现新版本才出现
    row.appendChild(verEl);
    row.appendChild(checkBtn);
    row.appendChild(dlBtn);
    box.appendChild(row);

    const statusEl = el("div", "update-status");
    statusEl.hidden = true;
    box.appendChild(statusEl);
    box.appendChild(el("div", "update-note", "更新需要重新安装 APK"));
    return { box: box, verEl: verEl, checkBtn: checkBtn, dlBtn: dlBtn, statusEl: statusEl };
  },

  /** 三态提示（同一行）：new / ok / fail；kind 为空则清空并隐藏 */
  setUpdateStatus(text, kind) {
    const e = this.updateStatusEl;
    if (!e) return;
    e.textContent = text || "";
    e.classList.remove("update-status-new");
    e.classList.remove("update-status-ok");
    e.classList.remove("update-status-fail");
    if (kind) e.classList.add(kind);
    e.hidden = !text;
  },

  /** 下载按钮：有 url 才显示 */
  setDownloadUrl(url) {
    this.downloadUrl = url || "";
    const btn = this.downloadBtn;
    if (!btn) return;
    btn.hidden = !this.downloadUrl;
  },

  /** 点「检查更新」：禁用 → 取版本 → 拉 release → 语义化比较 → finally 复原 */
  async checkUpdate() {
    const btn = this.updateBtn;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "检查中…";
    this.setDownloadUrl(""); // 上一轮的下载按钮先收掉
    this.setUpdateStatus("", "");
    try {
      const cur = await currentAppVersion();
      if (this.updateVerEl) this.updateVerEl.textContent = "当前版本 " + cur;
      const rel = await fetchLatestRelease();
      if (compareVersions(rel.version, cur) > 0) {
        this.setUpdateStatus("发现新版本 " + rel.version, "update-status-new");
        this.setDownloadUrl(rel.url);
      } else {
        this.setUpdateStatus("已是最新（" + cur + "）", "update-status-ok");
      }
    } catch (err) {
      // 离线 / 404 / 没有 release 全落到这里：err.message 或 HTTP 状态码
      this.setUpdateStatus("检查失败：" + errorText(err), "update-status-fail");
    } finally {
      // 无论成败都恢复可点（unmount 后 btn 已脱离文档，写属性也无害）
      btn.disabled = false;
      btn.textContent = "检查更新";
    }
  },
};