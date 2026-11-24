// js/core/theme.js — 主题色的**唯一派生实现** + 把设置重播到 DOM（主题 / 主题色 / 默认壁纸 / 亮度）
//
// 口径（用户 2026-11-24 定，见 docs/DEV.md §2.3）：**一个主题 = 三件套**
//   --accent         本色            发送键、群名/发言人名、选中态、logo mask、头像底
//   --accent-soft    浅色版          气泡底色
//   --accent-surface 该主题下的「白」 卡片底、聊天区底、输入框底
//   --accent-on      压在本色上的字  深/浅自适应（亮底 #1c1c1e / 暗底 #ffffff）
// 三个色值全部从 settings.accent 一个 hex 派生：**任何地方都不许自己 color-mix**，
// 一律调 deriveTheme() / applyTheme()。
//
// 这里只写 CSS 变量与 data-* 属性，不碰任何卡片内部 DOM。
"use strict";

import { DEFAULT_SETTINGS, WALLPAPERS, resolveWallpaper } from "./store.js";

const DIM_MAX = 0.8;
/** 亮度超过它就算「白色主题」（白底混白还是白，需要中立三件套 + 描边立住） */
const WHITEISH_LUMINANCE = 0.95;
/** 亮/暗分界：压在本色上的字色（与 js/ui/avatar.js 的 INK_LUMINANCE_THRESHOLD 同一阈值） */
export const INK_LUMINANCE_THRESHOLD = 0.6;
/** 压在本色上的两个字色（js/ui/avatar.js 也 import 这两个常量，保证只有一份口径） */
export const INK_DARK = "#1c1c1e";
export const INK_LIGHT = "#ffffff";
/** 浅色主题判据：亮度超过它就当「浅色主题」（#e5e5ea 约 0.78 → 浅色分支；四个彩色都 < 0.3） */
export const LIGHT_THEME_LUMINANCE = 0.7;
/** 气泡浅色版的权重：彩色混白 12%；浅色主题必须 45%，否则 #e5e5ea 出来是 #fcfcfc，在白卡上看不见 */
const SOFT_ACCENT_WEIGHT = 0.12;
const SOFT_ACCENT_WEIGHT_LIGHT = 0.45;
/** 卡片底的权重（彩色混白 97%；浅色主题就是纯白） */
const SURFACE_ACCENT_WEIGHT = 0.03;

/* ---------------------------------------------------------------- 颜色原语 */

/** 颜色串 → [r,g,b]（0-255）：支持 #rgb/#rgba/#rrggbb/#rrggbbaa/rgb()/rgba()/white/black */
export function parseColor(input) {
  const raw = String(input == null ? "" : input).trim().toLowerCase();
  if (!raw) return null;

  if (raw.charAt(0) === "#") {
    let hex = raw.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    } else if (hex.length === 8) {
      hex = hex.slice(0, 6);
    }
    if (hex.length !== 6 || !/^[0-9a-f]{6}$/.test(hex)) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  const m = raw.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = parts.slice(0, 3).map((p) => {
      const n = parseFloat(p);
      if (isNaN(n)) return NaN;
      return p.indexOf("%") >= 0 ? Math.round((n / 100) * 255) : Math.round(n);
    });
    if (ch.some((n) => isNaN(n))) return null;
    return ch.map((n) => Math.max(0, Math.min(255, n)));
  }

  if (raw === "white") return [255, 255, 255];
  if (raw === "black") return [0, 0, 0];
  return null;
}

/** [r,g,b] → "#rrggbb" */
export function toHex(rgb) {
  if (!rgb) return "";
  return (
    "#" +
    rgb
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** sRGB 单通道归一化（WCAG 2.x 相对亮度） */
function channelToLinear(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * 相对亮度 0..1（0 纯黑、1 纯白）。
 * @param {string|[number,number,number]|null} color 颜色串或 [r,g,b]
 * @returns {number|null} 认不出返回 null
 */
export function relativeLuminance(color) {
  const rgb = Array.isArray(color) ? color : parseColor(color);
  if (!rgb || rgb.length < 3) return null;
  return (
    0.2126 * channelToLinear(rgb[0]) +
    0.7152 * channelToLinear(rgb[1]) +
    0.0722 * channelToLinear(rgb[2])
  );
}

/** 标准 sRGB 线性插值：t=0 得 a，t=1 得 b */
export function mix(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return toHex(ca || cb || [255, 255, 255]);
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  return toHex([
    ca[0] + (cb[0] - ca[0]) * k,
    ca[1] + (cb[1] - ca[1]) * k,
    ca[2] + (cb[2] - ca[2]) * k,
  ]);
}

/** 白/近白（亮度 > 0.95）：本色是白的时候混白还是白，必须走中立三件套 */
export function isWhiteish(accent) {
  const L = relativeLuminance(accent);
  return L != null && L > WHITEISH_LUMINANCE;
}

/** 压在本色上的字色：亮底深字、暗底白字 */
export function inkOn(accent) {
  const L = relativeLuminance(accent);
  if (L == null) return INK_DARK;
  return L > INK_LUMINANCE_THRESHOLD ? INK_DARK : INK_LIGHT;
}

/* ------------------------------------------------------------ 三件套派生 */

/**
 * 主题三件套的**唯一派生函数**：一个 accent hex → {base, soft, surface, on}。
 * 分支只有两条：
 *   - 浅色主题（亮度 > 0.7，含默认浅灰 #e5e5ea）：本色不动，气泡混白 **45%** 才看得见，
 *     卡面纯白，压在本色上的字用深色。白色主题已下线（用户：主题色不要有白色），
 *     描边也一并取消，所以浅色主题必须靠 soft 的色差立住。
 *   - 彩色主题：本色 / 混白 12% 得 soft / 混白 97% 得 surface / 字色按亮度。
 * @param {string} accent
 * @returns {{base:string, soft:string, surface:string, on:string}}
 */
export function deriveTheme(accent) {
  const rgb = parseColor(accent);
  if (!rgb) return deriveTheme(DEFAULT_SETTINGS.accent);
  const base = toHex(rgb);

  const L = relativeLuminance(base);
  if (L != null && L > LIGHT_THEME_LUMINANCE) {
    return {
      base: base,
      soft: mix("#ffffff", base, SOFT_ACCENT_WEIGHT_LIGHT),
      surface: INK_LIGHT, // 浅色主题下卡片/聊天区/输入框就是纯白
      on: INK_DARK,
    };
  }

  return {
    base: base,
    // 本色掺进白里：soft 留 12% 本色（气泡），surface 只留 3% 本色（卡片/聊天区/输入框底）
    soft: mix("#ffffff", base, SOFT_ACCENT_WEIGHT),
    surface: mix("#ffffff", base, SURFACE_ACCENT_WEIGHT),
    on: inkOn(base),
  };
}

/** 三件套 → CSS 变量名（写与复位都用这一份清单，避免漏一个） */
export const THEME_VARS = ["--accent", "--accent-soft", "--accent-surface", "--accent-on", "--send-bg"];

/**
 * 把三件套写到某个元素（默认 document.documentElement），五个变量一起落。
 * @param {string} accent
 * @param {HTMLElement} [target] 默认 document.documentElement
 * @returns {{base:string, soft:string, surface:string, on:string}}
 */
export function applyTheme(accent, target) {
  const th = deriveTheme(accent);
  const el = target || (typeof document !== "undefined" ? document.documentElement : null);
  if (el && el.style) {
    el.style.setProperty("--accent", th.base);
    el.style.setProperty("--accent-soft", th.soft);
    el.style.setProperty("--accent-surface", th.surface);
    el.style.setProperty("--accent-on", th.on);
    el.style.setProperty("--send-bg", th.base);
  }
  return th;
}

/** 从元素上撤掉三件套（卡片卸载时用） */
export function clearTheme(target) {
  const el = target || (typeof document !== "undefined" ? document.documentElement : null);
  if (!el || !el.style) return;
  for (let i = 0; i < THEME_VARS.length; i++) el.style.removeProperty(THEME_VARS[i]);
}

/* ------------------------------------------------------------- 设置重播 */

/** 主题色只有 settings.accent 一处（色值） */
function accentColor(settings) {
  const a = String((settings && settings.accent) || "");
  return a || DEFAULT_SETTINGS.accent;
}

/** 色值 → 皮肤名（theme.css 里的 7 套 token 靠 data-skin 选中） */
const SKIN_BY_ACCENT = {
  "#0075de": "notion",
  "#00a884": "wa",
  "#10a37f": "gpt",
  "#d97757": "claude",
  "#0088cc": "tg",
  "#34c759": "imessage",
  "#7c5cff": "purple",
};

function skinOf(settings) {
  return SKIN_BY_ACCENT[accentColor(settings)] || "notion";
}

/**
 * 应用设置到 body（并派生三件套写到根）。
 * @param {{accent?:string, defaultWallpaper?:string, dim?:number}} settings
 */
export function applySettings(settings) {
  const body = typeof document !== "undefined" ? document.body : null;
  if (!body) return;

  const s = settings || {};
  body.setAttribute("data-skin", skinOf(s));

  // 三件套：唯一派生 + 一次写全五个变量（--accent / --accent-soft / --accent-surface / --accent-on / --send-bg）
  applyTheme(accentColor(s));

  // 全局默认壁纸（单会话覆盖由卡片自己按 resolveWallpaper(conv, settings) 决定）
  const wallpaper = WALLPAPERS.indexOf(s.defaultWallpaper) >= 0 ? s.defaultWallpaper : "aurora";
  body.setAttribute("data-wallpaper", wallpaper);

  const raw = Number(s.dim);
  const dim = isFinite(raw) ? Math.min(DIM_MAX, Math.max(0, raw)) : 0;
  body.style.setProperty("--dim-opacity", String(dim));
}

/**
 * 把「某个会话实际生效的壁纸」挂到壁纸层元素上（#wallpaper）。
 * 颜色/图案全在 css/cards.css 的 `#wallpaper[data-wall=...]` 里，这里只负责打标记
 * 并清掉卡片以前写过（或自己写的）内联背景，避免内联样式盖住 CSS。
 * @param {HTMLElement|null} el
 * @param {string} wallpaper 必须是 WALLPAPERS 之一（用 resolveWallpaper 得到）
 */
export function applyWallpaperLayer(el, wallpaper) {
  if (!el) return null;
  const w = WALLPAPERS.indexOf(wallpaper) >= 0 ? wallpaper : "aurora";
  const changed = el.getAttribute("data-wall") !== w;
  el.setAttribute("data-wall", w);
  el.style.backgroundImage = "";
  el.style.backgroundColor = "";
  // 换图才淡入一次（§2.5 第 12 项）；同类值重复调用不重放（硬规则 4）
  if (changed && !el.classList.contains("anim-wall-fade")) {
    el.classList.add("anim-wall-fade");
    const off = (ev) => {
      if (ev && ev.target !== el) return;
      el.classList.remove("anim-wall-fade");
      el.removeEventListener("animationend", off);
    };
    el.addEventListener("animationend", off);
  }
  return el;
}

export { resolveWallpaper };
export default applySettings;
