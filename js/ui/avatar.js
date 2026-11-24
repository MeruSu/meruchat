// js/ui/avatar.js — 头像渲染器（**唯一实现**）
//
// 形状口径（lead 定案，会话 / 成员 / 用户共用，见 docs/DEV.md §2.3）：
//   Avatar = { label: string, color: string|null, image?: string }
//   image 为 dataURL：有它优先显示图片；否则「label 首字 + 底色」。
//   底色解析走 store.resolveAvatarColor(avatar, accent)（显式 color 优先，否则跟随主题色）。
//
// 尺寸不由本函数管（宽高/字号/圆角全在 CSS 里），这里只写「内容」：
//   - 文本：首字（Array.from 取完整码位，中文/emoji 不会切半个代理对）
//   - 底色：resolveAvatarColor(avatar, opts.accent)
//   - 字色：按底色亮度自适应 —— **白色 / 近白底必须是深色字**（见 avatarInk）
//   - 图片：background-image = url(dataURL)
// 调用方：设置卡大头像、左栏会话头像、聊天卡顶栏头像、聊天/详情卡的成员与消息头像。
//
// 为什么字色要在这里算：主题色默认是白 #ffffff（用户定的），而 style-kit 给
// `.c-ava` / `.chat-head .ava` / `.big-ava` / `.m-ava` 的字色是白 —— 白底白字等于
// 一圈空气。CSS 没法按 inline background-color 反推字色，所以统一在本文件算一次；
// 阈值与字色常量都从 js/core/theme.js import，和 --accent-on 是同一份口径。
"use strict";

import { resolveAvatarColor } from "../core/store.js";
import {
  INK_DARK,
  INK_LIGHT,
  INK_LUMINANCE_THRESHOLD,
  parseColor,
  relativeLuminance,
} from "../core/theme.js";

export { INK_DARK, INK_LIGHT, INK_LUMINANCE_THRESHOLD };

/** 亮底描边：用户明确否掉了描边（「那个描边有点丑，我们不要描边了」），这里保留常量给
 *  需要临时试色的人，但 applyAvatarInk 不再写它 —— 浅灰主题靠 deriveTheme 的 soft 色差立住。 */
export const LIGHT_EDGE = "1px solid rgba(0, 0, 0, 0.16)";

/**
 * 背景 → 相对亮度。单色直接算；渐变（`linear-gradient(...)` / 多个色值）取所有色标的平均亮度。
 * 认不出任何颜色时返回 null（调用方按「深色字」处理，宁可深不可白）。
 */
export function backgroundLuminance(background) {
  const raw = String(background == null ? "" : background).trim();
  if (!raw) return null;

  const single = parseColor(raw);
  if (single) return relativeLuminance(single);

  // 渐变：把所有 #hex / rgb() / rgba() 色标都抠出来，按平均亮度判断
  const stops = [];
  let m;
  const hexRe = /#[0-9a-fA-F]{3,8}/g;
  while ((m = hexRe.exec(raw))) {
    const rgb = parseColor(m[0]);
    if (rgb) stops.push(rgb);
  }
  const rgbRe = /rgba?\([^)]*\)/g;
  while ((m = rgbRe.exec(raw))) {
    const rgb = parseColor(m[0]);
    if (rgb) stops.push(rgb);
  }
  if (!stops.length) return null;

  const sum = stops.reduce((acc, rgb) => acc + relativeLuminance(rgb), 0);
  return sum / stops.length;
}

/** 底色 → 字色：亮底用深色字 #1c1c1e，暗底用白字 #ffffff（认不出颜色时给深色字） */
export function avatarInk(background) {
  const L = backgroundLuminance(background);
  if (L == null) return INK_DARK;
  return L > INK_LUMINANCE_THRESHOLD ? INK_DARK : INK_LIGHT;
}

/**
 * 把字色落到元素上（**不写描边** —— 用户否掉了描边）。
 * 所有画头像的地方都必须调它，不要各自写死 #fff。
 * @param {HTMLElement} node
 * @param {string} background 该元素实际会用的底色（单色或渐变串）
 * @returns {string} 用上的字色
 */
export function applyAvatarInk(node, background) {
  if (!node || !node.style) return INK_DARK;
  const ink = avatarInk(background);
  node.style.color = ink;
  if (node.setAttribute) node.setAttribute("data-ink", ink === INK_DARK ? "dark" : "light");
  return ink;
}

/**
 * 把 avatar 渲染到一个已有元素上。
 * @param {HTMLElement} node  目标元素（一般带 .ava / .c-ava / .big-ava 之类的类）
 * @param {{label?: string, color?: string|null, image?: string}} avatar
 * @param {{accent?: string}} [opts]  accent = 该头像应跟随的主题色（用户自己的用 user.accent，
 *                                   会话/成员用 resolveAccent/resolveMemberAccent 的结果）
 * @returns {HTMLElement}
 */
export function renderAvatar(node, avatar, opts) {
  if (!node) return node;
  const a = avatar || {};
  const label = typeof a.label === "string" ? a.label.trim() : "";
  const image = typeof a.image === "string" ? a.image : "";
  const color = resolveAvatarColor(a, opts && opts.accent);

  node.style.backgroundColor = color;
  // 字色跟着底色走：亮底 → #1c1c1e，暗底 → #ffffff（不描边，描边已被用户否掉）
  applyAvatarInk(node, color);

  if (image) {
    // 有图就不写字，避免图片没加载出来时透出半个字
    node.textContent = "";
    node.style.backgroundImage = 'url("' + image.replace(/"/g, "%22") + '")';
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
    node.setAttribute("data-avatar", "image");
  } else {
    node.textContent = Array.from(label)[0] || "?";
    node.style.backgroundImage = "";
    node.setAttribute("data-avatar", "text");
  }
  return node;
}

/** label 的首字（给需要单独取字的地方用，避免各处再写 charAt(0)） */
export function initialOf(label) {
  return Array.from(String(label == null ? "" : label).trim())[0] || "?";
}

export default renderAvatar;
