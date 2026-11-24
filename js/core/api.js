// js/core/api.js — 网关调用（OpenAI 兼容 /chat/completions，流式）
// 逻辑原样搬自旧 js/app.js 的 callGateway / extractDelta / extractNonStream。
// 只用全局 fetch，不 import 旧文件。
"use strict";

export const DEFAULT_BASE_URL = "https://gw.ms7.pw/cors/v1";
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";
/** 读流空闲超时：这么多毫秒没有任何新分片，就认为流已僵死，收工返回已收内容 */
export const IDLE_TIMEOUT_MS = 20000;

/** 空闲超时哨兵（reader.read() 永远返回对象，用私有标记区分） */
const IDLE_HIT = Symbol("idle-timeout");

/**
 * 从流式分片里取增量文本（OpenAI：choices[0].delta.content）。
 * @param {any} obj
 * @returns {string}
 */
export function extractDelta(obj) {
  try {
    const ch = obj && obj.choices && obj.choices[0];
    if (!ch) return "";
    const d = ch.delta || ch.message || {};
    if (typeof d.content === "string") return d.content;
    if (Array.isArray(d.content)) {
      return d.content.map((p) => (p && p.text ? p.text : "")).join("");
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * 非流式回退解析（choices[0].message.content）。
 * @param {any} j
 * @returns {string}
 */
export function extractNonStream(j) {
  try {
    const ch = j && j.choices && j.choices[0];
    if (!ch) return "";
    if (ch.message && typeof ch.message.content === "string") return ch.message.content;
    if (typeof ch.text === "string") return ch.text;
    return "";
  } catch {
    return "";
  }
}

/**
 * 把 baseUrl 归一成完整的 chat/completions 地址。
 * @param {string} baseUrl
 * @returns {string}
 */
export function completionsUrl(baseUrl) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
}

/**
 * 流式对话。逐行解析 SSE 的 `data:` 行；无 response.body 时退回整体 JSON。
 * 读流带空闲超时兜底：idleTimeoutMs 内没有任何新分片就主动 cancel 读流，
 * 把已经收到的内容当正常结果返回（代理 keep-alive 不回 done 时不至于永久挂住）。
 * @param {object} opts
 * @param {string} opts.baseUrl        网关地址（可含或不含 /chat/completions）
 * @param {string} opts.apiKey         Bearer key
 * @param {string} opts.model          模型名
 * @param {Array<{role:string, content:string}>} opts.messages OpenAI 格式消息
 * @param {AbortSignal} [opts.signal]  取消信号
 * @param {(delta: string) => void} [opts.onDelta] 每个增量分片回调（空串不回调）
 * @param {number} [opts.idleTimeoutMs] 读流空闲超时，默认 20000
 * @returns {Promise<string>} 完整回复文本
 */
export async function streamChat({
  baseUrl,
  apiKey,
  model,
  messages,
  signal,
  onDelta,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
}) {
  if (!apiKey) throw new Error("缺少 API Key：请先在全局设置里填写");
  const url = completionsUrl(baseUrl);
  const useModel = model || DEFAULT_MODEL;
  const emit = typeof onDelta === "function" ? onDelta : () => {};
  // 空串分片对 UI 没有意义，且会让调用方反复重排，直接在源头丢掉
  const emitDelta = (piece) => {
    if (typeof piece === "string" && piece.length) emit(piece);
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({ model: useModel, messages, stream: true }),
      signal,
    });
  } catch (err) {
    // AbortError 原样抛，交给上层判定「已停止」
    if (err && err.name === "AbortError") throw err;
    throw new Error("请求网关失败：" + (err && err.message ? err.message : err));
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      /* 读不到 body 就只报状态码 */
    }
    throw new Error("HTTP " + res.status + (bodyText ? "：" + bodyText.slice(0, 200) : ""));
  }

  // 非流式回退：某些网关/代理会把流式请求整体返回 JSON
  if (!res.body || typeof res.body.getReader !== "function") {
    const j = await res.json();
    const txt = extractNonStream(j);
    emitDelta(txt);
    return txt;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  let finished = false; // 流里出现过 [DONE]
  let idleHit = false; // 因空闲超时收工

  /** 处理一行；返回 true 表示遇到 [DONE]（调用方据此收工） */
  const handleLine = (line) => {
    if (!line || line.indexOf("data:") !== 0) return false;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return true;
    if (!payload) return false;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return false; // 半行/心跳，跳过
    }
    const piece = extractDelta(obj);
    if (piece) {
      acc += piece;
      emitDelta(piece);
    }
    return false;
  };

  /** 把 buf 里已经完整的行全部消费掉 */
  const drain = () => {
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (handleLine(line)) return true;
    }
    return false;
  };

  // 逐块读，按 \n 切行；只处理 data: 开头的行。每次 read 都带空闲超时兜底。
  for (;;) {
    let timer = null;
    let res2;
    try {
      res2 = await Promise.race([
        reader.read(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(IDLE_HIT), idleTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    if (res2 === IDLE_HIT) {
      idleHit = true;
      try {
        await reader.cancel();
      } catch {
        /* 已经关掉就算了 */
      }
      break;
    }

    const { done, value } = res2;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (drain()) {
      finished = true;
      break;
    }
  }

  if (finished) return acc;

  // 收尾：最后一行可能没有换行符（正常 EOF 与空闲超时收工都走这里）
  if (!idleHit) {
    buf += dec.decode();
  }
  const tail = buf.trim();
  if (tail.indexOf("data:") === 0) handleLine(tail);

  return acc;
}

export default streamChat;
