// js/core/util.js — 纯工具（零 DOM 组件、零业务）。
// 逻辑原样搬自旧 js/app.js 的 helpers（不改行为，只换导出形式），每段标来源行号。
// 分层约定：DOM 组件（头像/气泡/弹层）只在 js/ui/atoms.js 一份；这里不放。
"use strict";

/** 唯一 id。来源 js/app.js:11 */
export function uid() {
  var c = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 当前毫秒时间戳。来源 js/app.js:15 */
export function now() { return Date.now(); }

/** 稳定散列（djb2 变体），同一输入恒得同一值。来源 js/app.js:26 */
export function hashStr(s) {
  var h = 0; s = String(s || "");
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 建元素（tag, 类名, 文本）。来源 js/app.js:34 */
export function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 取错误文案：优先 err.message，否则 String(e)。 */
export function errorText(e) {
  return e && e.message ? e.message : String(e);
}

// ---------------------------------------------------------------- 图片压缩
// 用途：自定义聊天背景（docs/DEV.md §2.2.1）。上传图存成 dataURL，不存二进制。
// 规则：长边缩到 maxEdge → 逐档降 JPEG 质量 → 仍超 maxBytes 再按 0.7 缩一轮。

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_MAX_BYTES = 800000;
const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4];

/** 读成 <img>（用 ObjectURL，读完立刻释放） */
function loadImage(file) {
  return new Promise(function (resolve, reject) {
    if (typeof URL === "undefined" || !URL.createObjectURL) {
      reject(new Error("当前环境不支持图片读取"));
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("图片读不出来，换一张试试"));
    };
    img.src = url;
  });
}

/** 把 img 画进 canvas 并导出 JPEG dataURL */
function drawToDataUrl(img, maxEdge, quality) {
  var w = img.naturalWidth || img.width;
  var h = img.naturalHeight || img.height;
  var scale = Math.min(1, maxEdge / Math.max(w, h));
  var cw = Math.max(1, Math.round(w * scale));
  var ch = Math.max(1, Math.round(h * scale));

  var canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  var ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前环境不支持画布压缩");
  ctx.fillStyle = "#ffffff"; // PNG 透明区转 JPEG 会变黑底，先铺白
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, 0, 0, cw, ch);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * 压缩图片到 dataURL。长边 ≤ maxEdge，逐步降质直到 dataURL 长度 ≤ maxBytes。
 * @param {File|Blob} file
 * @param {{maxEdge?:number, maxBytes?:number, maxSourceBytes?:number}} [opts]
 * @returns {Promise<string>} dataURL
 */
export async function compressImage(file, opts) {
  var o = opts || {};
  var maxEdge = o.maxEdge || DEFAULT_MAX_EDGE;
  var maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
  var maxSourceBytes = o.maxSourceBytes || DEFAULT_MAX_SOURCE_BYTES;

  if (!file) throw new Error("没有选择图片");
  if (file.size > maxSourceBytes) {
    throw new Error("图片太大（上限 " + Math.round(maxSourceBytes / 1024 / 1024) + "MB）");
  }

  var img = await loadImage(file);

  // 第一轮：按 maxEdge 缩，质量逐档降
  for (var i = 0; i < QUALITY_LADDER.length; i++) {
    var dataUrl = drawToDataUrl(img, maxEdge, QUALITY_LADDER[i]);
    if (dataUrl.length <= maxBytes) return dataUrl;
  }

  // 第二轮：最低质量仍超体积，继续缩边（最多再缩 3 轮，避免死循环）
  var edge = maxEdge;
  for (var k = 0; k < 3; k++) {
    edge = Math.round(edge * 0.7);
    if (edge < 64) break;
    var small = drawToDataUrl(img, edge, QUALITY_LADDER[QUALITY_LADDER.length - 1]);
    if (small.length <= maxBytes) return small;
  }

  throw new Error("这张图压不下来，换一张小一点的试试");
}
