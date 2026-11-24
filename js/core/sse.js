// js/core/sse.js — 手写 SSE 客户端（不用 EventSource：它不能 POST、不能带 Authorization）
// 只做传输与解析，不理解 OpenAI 语义：每个事件解成对象交给 onEvent，聚合交给 agent.js。
// 三条硬性行为：
//   1) 按空行（\n\n）切事件，不完整的尾巴留在 buffer 等下一块；多行 data: 按规范用 \n 拼接
//   2) `data: [DONE]` 与直接关流都算正常结束
//   3) 空闲看门狗（默认 45s，每收到一块重置）+ 总时长上限（默认 10 分钟），超时 abort 并抛带 code 的错误
"use strict";

/** 多久没有任何新分片就认为流已僵死 */
export const SSE_IDLE_TIMEOUT_MS = 45000;
/** 单次请求的总时长上限 */
export const SSE_MAX_TOTAL_MS = 600000;

/**
 * 带 code 的错误：调用方按 code 判断（stream_idle_timeout / stream_total_timeout / http_error / network_error / bad_json）
 * @param {string} code
 * @param {string} [message]
 * @returns {Error & {code: string}}
 */
function codeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/** 把 caller 的 signal 接到自己的 controller 上（AbortSignal.any 在老 WebView 里没有） */
function linkSignal(signal) {
  const ac = new AbortController();
  const state = { abortedBy: "" };
  const onAbort = () => {
    state.abortedBy = state.abortedBy || "caller";
    ac.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return { ac, state, onAbort };
}

/**
 * 解析一个完整的 SSE 事件块（不含分隔空行）。
 * @param {string} block
 * @returns {{event: string, data: string, id: string} | null}
 */
export function parseBlock(block) {
  if (!block) return null;
  const lines = String(block).split("\n");
  const data = [];
  let event = "";
  let id = "";
  let seen = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    if (line[0] === ":") continue; // 注释/心跳
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value[0] === " ") value = value.slice(1);
    if (field === "data") {
      data.push(value);
      seen = true;
    } else if (field === "event") {
      event = value;
      seen = true;
    } else if (field === "id") {
      id = value;
    }
  }
  if (!seen) return null;
  return { event, data: data.join("\n"), id };
}

/**
 * 向网关发一次流式请求，把每个 data 事件交给 onEvent。
 * onEvent 收到的对象：
 *   { type: "data", obj, raw }   —— 一个 JSON 事件
 *   { type: "done" }             —— data: [DONE]
 *   { type: "json", json }       —— 服务端没按 SSE 返回，而是整包 JSON（当作一次 done）
 *   { type: "raw", raw }         —— 数据不是 JSON（保底可见，不静默吞掉）
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string,string>} [opts.headers]
 * @param {any} opts.payload                    会被 JSON.stringify
 * @param {AbortSignal} [opts.signal]           用户取消
 * @param {(evt: object) => void} opts.onEvent
 * @param {number} [opts.idleTimeoutMs]
 * @param {number} [opts.maxTotalMs]
 * @param {number} [opts.firstByteTimeoutMs]   首字节超时（不给就不设）；群聊里用 15s
 * @returns {Promise<{ closed: string, json?: any }>} closed: done | eof | json
 */
export async function ssePost({
  url,
  headers,
  payload,
  signal,
  onEvent,
  idleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
  maxTotalMs = SSE_MAX_TOTAL_MS,
  firstByteTimeoutMs = 0,
} = {}) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const { ac, state } = linkSignal(signal);
  let idleTimer = null;
  let totalTimer = null;
  let firstByteTimer = null;

  const clearFirstByte = () => {
    if (firstByteTimer !== null) clearTimeout(firstByteTimer);
    firstByteTimer = null;
  };
  const armIdle = () => {
    clearFirstByte();
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      state.abortedBy = state.abortedBy || "idle";
      ac.abort();
    }, Math.max(1, idleTimeoutMs));
  };
  const cleanup = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (totalTimer !== null) clearTimeout(totalTimer);
    clearFirstByte();
    idleTimer = null;
    totalTimer = null;
  };
  const fail = () => {
    if (state.abortedBy === "first_byte") return codeError("stream_first_byte_timeout", "首字节超时（" + firstByteTimeoutMs + "ms 没收到任何数据）");
    if (state.abortedBy === "idle") return codeError("stream_idle_timeout", "读流空闲超时（" + idleTimeoutMs + "ms 无新分片）");
    if (state.abortedBy === "total") return codeError("stream_total_timeout", "请求总时长超限（" + maxTotalMs + "ms）");
    if (state.abortedBy === "caller") {
      const aborted = new Error("aborted");
      aborted.name = "AbortError";
      return aborted;
    }
    return null;
  };

  totalTimer = setTimeout(() => {
    state.abortedBy = state.abortedBy || "total";
    ac.abort();
  }, Math.max(1, maxTotalMs));
  armIdle();
  if (firstByteTimeoutMs > 0) {
    firstByteTimer = setTimeout(() => {
      state.abortedBy = state.abortedBy || "first_byte";
      ac.abort();
    }, Math.max(1, firstByteTimeoutMs));
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json", accept: "text/event-stream" }, headers || {}),
      body: JSON.stringify(payload === undefined ? {} : payload),
      signal: ac.signal,
    });
  } catch (err) {
    cleanup();
    const known = fail();
    if (known) throw known;
    throw codeError("network_error", "请求失败：" + (err && err.message ? err.message : err));
  }

  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch (e) {
      /* 读不到 body 就只报状态码 */
    }
    cleanup();
    const err = codeError("http_error", "HTTP " + res.status + (body ? "：" + body.slice(0, 300) : ""));
    err.status = res.status;
    err.body = body;
    throw err;
  }

  const ctype = String(res.headers.get("content-type") || "").toLowerCase();
  // 整包 JSON 回退：不是 text/event-stream 就当作一次 done，不按 SSE 切
  if (ctype.indexOf("text/event-stream") < 0) {
    let json = null;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      cleanup();
      throw codeError("bad_json", "服务端返回的既不是 SSE 也不是 JSON：" + (e && e.message ? e.message : e));
    }
    cleanup();
    emit({ type: "json", json });
    emit({ type: "done" });
    return { closed: "json", json };
  }

  if (!res.body || typeof res.body.getReader !== "function") {
    cleanup();
    emit({ type: "done" });
    return { closed: "eof" };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let closed = "";

  /** 消费 buffer 里已经完整的块；返回 true 表示收到 [DONE] */
  const drain = () => {
    for (;;) {
      const idx = buf.search(/\r?\n\r?\n/);
      if (idx < 0) return false;
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const parsed = parseBlock(block);
      if (!parsed) continue;
      const data = parsed.data;
      if (data === "[DONE]") {
        emit({ type: "done" });
        return true;
      }
      if (!data) continue;
      let obj;
      try {
        obj = JSON.parse(data);
      } catch (e) {
        emit({ type: "raw", raw: data });
        continue;
      }
      emit({ type: "data", obj, raw: data, event: parsed.event });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buf += dec.decode(value, { stream: true });
      if (drain()) {
        closed = "done";
        break;
      }
    }
    if (!closed) {
      buf += dec.decode();
      // 收尾：最后一帧可能没有结尾空行
      if (buf.trim()) {
        const tail = buf.replace(/\s+$/, "");
        const parsed = parseBlock(tail);
        if (parsed) {
          if (parsed.data === "[DONE]") emit({ type: "done" });
          else if (parsed.data) {
            try {
              emit({ type: "data", obj: JSON.parse(parsed.data), raw: parsed.data, event: parsed.event });
            } catch (e) {
              emit({ type: "raw", raw: parsed.data });
            }
          }
        }
      }
      closed = "eof";
    }
  } catch (err) {
    cleanup();
    const known = fail();
    if (known) throw known;
    throw codeError("network_error", "读流失败：" + (err && err.message ? err.message : err));
  } finally {
    cleanup();
    if (closed) {
      try {
        await reader.cancel();
      } catch (e) {
        /* 已关就算了 */
      }
    }
  }

  return { closed: closed || "eof" };
}

export default ssePost;