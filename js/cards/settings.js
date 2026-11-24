// js/cards/settings.js — 全局设置卡片（主题色、默认聊天背景、API Base URL / 模型 / API Key）
// DOM 逐字照抄 C:\Meru\website\su\preview\styles.html 第 833-869 行（aside.sidebar-right），
// 只做三处调整：壁纸 <select> 换成 .seg 三按钮 + 上传图片按钮；不新增亮度/深浅/画幅；文字换成变量。
// 视觉全部交给 css/style-kit.css（该文件禁止修改）；本卡片只写外框。
// 背景的两层归属见 docs/DEV.md §2.2.1：这里改的是「全局默认」，单会话覆盖在详情卡。
"use strict";

import { el } from "../core/util.js";
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
};