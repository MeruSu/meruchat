// js/core/agent.js — 一轮对话里的 agent 循环（骨架照 pi，事件名照抄 pi）
// 每轮做四件事：拼上下文 → 流式请求 → 收口（用权威结果覆盖增量）→ 有 tool-call 就执行并回填，然后继续。
// 终止只看「有没有 tool_calls」，不看 finish_reason（很多兼容网关回 stop 或者压根不回）。
// 落盘规则：assistant 消息在收到第一个增量之前就落库（status:'streaming'），之后按 250ms / 32 delta 合并写，
// 结束写 complete / aborted / error；启动时把遗留的 streaming 降级成 aborted（recoverStreaming）。
"use strict";

import { ssePost } from "./sse.js";
import { now, uid } from "./util.js";
import { errorResult, executeCalls } from "./tools/runner.js";

/** pi 的事件名，顺序即典型时序 */
export const AGENT_EVENTS = [
  "agent_start",
  "turn_start",
  "message_start",
  "text_delta",
  "reasoning_delta",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "agent_end",
];

/** 默认最多跑多少轮（一轮 = 一次请求 + 一次工具回填） */
export const DEFAULT_MAX_STEPS = 12;
/** 增量落库节流：先到者触发 */
export const FLUSH_INTERVAL_MS = 250;
export const FLUSH_DELTA_COUNT = 32;

/** 把 baseUrl 归一成 chat/completions 地址（与 api.js 同语义） */
function completionsUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return "/gw/v1/chat/completions";
  return /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** 从 parts 里取出发回给模型的内容（reasoning 不带回） */
function partsToOpenAI(parts) {
  const text = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("");
  const calls = parts.filter((p) => p.type === "tool-call");
  const msg = { role: "assistant", content: text };
  if (calls.length) {
    msg.tool_calls = calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.argsRaw || "{}" },
    }));
  }
  return msg;
}

/**
 * 跑一个 agent 循环。
 * 关键参数：messages（全量直喂的 OpenAI 格式上下文）、tools（见 js/core/tools/）、
 * signal、maxSteps（默认 12）、onEvent（pi 事件名）、persist（{start,update} 落盘适配器）、
 * abortStatus / errorStatus（群聊传 canceled / failed）、seq（起始序号）。
 * @returns {Promise<{status: string, text: string, steps: number, messages: object[], error?: Error}>}
 */
export async function runAgent(opts = {}) {
  const {
    baseUrl,
    apiKey,
    model,
    messages = [],
    tools = [],
    signal,
    maxSteps = DEFAULT_MAX_STEPS,
    onEvent,
    persist = null,
    convId = null,
    memberId = null,
    idleTimeoutMs,
    maxTotalMs,
    firstByteTimeoutMs = 0,
    abortStatus = "aborted",
    errorStatus = "error",
    seq = null,
  } = opts;

  const emit = (name, payload) => {
    if (typeof onEvent === "function") {
      try {
        onEvent(name, payload || {});
      } catch (e) {
        /* UI 回调自己的异常不能打断循环 */
      }
    }
  };
  // 没有 apiKey 就不发 Authorization，交给服务端判（本地网关不需要 key）：
  // 真 401 会走下面的失败路径，用户能看到具体原因，比在客户端静默拦掉好。

  const url = completionsUrl(baseUrl);
  const transcript = messages.slice();
  const seen = new Set();
  const records = [];
  let lastText = "";
  let steps = 0;
  let status = "complete";
  let failure = null;

  const save = (rec, patch) => {
    if (!persist) return Promise.resolve();
    const job = patch ? persist.update(rec.id, patch) : persist.start(rec);
    return Promise.resolve(job).catch(() => {});
  };

  emit("agent_start", { url, model, maxSteps });
  try {
    for (;;) {
      if (signal && signal.aborted) throw abortError();
      if (steps >= maxSteps) {
        status = "max_steps";
        break;
      }
      steps += 1;
      emit("turn_start", { step: steps });

      // ---- 拼请求体 ----
      const payload = { model: model || undefined, messages: transcript, stream: true };
      if (tools.length) {
        payload.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      // ---- assistant 记录先落库（status: streaming），再开流 ----
      const rec = {
        id: uid(),
        convId: convId || undefined,
        memberId: memberId || undefined,
        role: "assistant",
        parts: [],
        content: "",
        status: "streaming",
        ts: now(),
        seq: typeof seq === "number" ? seq + steps - 1 : undefined,
        step: steps,
      };
      records.push(rec);
      emit("message_start", { id: rec.id, step: steps });
      await save(rec);

      // ---- 聚合器 ----
      const acc = { text: "", reasoning: "", calls: [], finish: "", authoritative: null };
      let deltas = 0;
      let dirty = false;
      let flushTimer = null;
      const flush = () => {
        if (!dirty) return;
        dirty = false;
        rec.content = acc.text;
        rec.parts = buildParts(rec, acc, false);
        save(rec, { parts: rec.parts, content: rec.content });
      };
      const bump = () => {
        deltas += 1;
        if (deltas % FLUSH_DELTA_COUNT === 0) flush();
        else if (flushTimer === null) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_INTERVAL_MS);
      };

      const callByIndex = new Map();
      const absorb = (obj) => {
        const ch = obj && obj.choices && obj.choices[0];
        if (!ch) return;
        if (ch.finish_reason) acc.finish = String(ch.finish_reason);
        const d = ch.delta || ch.message || null;
        if (!d) return;
        if (typeof d.content === "string" && d.content) {
          acc.text += d.content;
          rec.content = acc.text;
          dirty = true;
          emit("text_delta", { id: rec.id, delta: d.content, text: acc.text, step: steps });
          bump();
        }
        const reasoning = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : "";
        if (reasoning) {
          acc.reasoning += reasoning;
          dirty = true;
          emit("reasoning_delta", { id: rec.id, delta: reasoning, step: steps });
          bump();
        }
        if (Array.isArray(d.tool_calls)) {
          d.tool_calls.forEach((tc, position) => {
            const index = typeof tc.index === "number" ? tc.index : callByIndex.size + position;
            let call = callByIndex.get(index);
            if (!call) {
              call = { index, id: tc.id || "call_" + index + "_" + rec.id.slice(0, 6), name: "", argsRaw: "" };
              callByIndex.set(index, call);
              acc.calls.push(call);
              emit("toolcall_start", { id: rec.id, callId: call.id, index, step: steps });
            }
            const fn = tc.function || {};
            if (tc.id) call.id = tc.id;
            if (fn.name) call.name = fn.name;
            if (typeof fn.arguments === "string" && fn.arguments) {
              call.argsRaw += fn.arguments;
              dirty = true;
              emit("toolcall_delta", { id: rec.id, callId: call.id, index, delta: fn.arguments, step: steps });
              bump();
            } else if (fn.arguments && typeof fn.arguments === "object") {
              call.argsRaw = JSON.stringify(fn.arguments);
            }
          });
        }
      };

      try {
        const res = await ssePost({
          url,
          headers: apiKey ? { authorization: "Bearer " + apiKey } : {},
          payload,
          signal,
          idleTimeoutMs,
          maxTotalMs,
          firstByteTimeoutMs,
          onEvent: (evt) => {
            if (evt.type === "json") acc.authoritative = evt.json;
            else if (evt.type === "data") absorb(evt.obj);
            else if (evt.type === "raw" && evt.raw) emit("text_delta", { id: rec.id, delta: "", text: acc.text, raw: evt.raw, step: steps });
          },
        });
        void res;
      } catch (err) {
        if (flushTimer !== null) clearTimeout(flushTimer);
        if (err && err.name === "AbortError") {
          rec.parts = buildParts(rec, acc, true);
          rec.content = acc.text;
          rec.status = abortStatus;
          await save(rec, { parts: rec.parts, content: rec.content, status: abortStatus });
          emit("message_end", { id: rec.id, status: abortStatus, step: steps });
          status = abortStatus;
          throw err;
        }
        rec.parts = buildParts(rec, acc, true);
        rec.content = acc.text;
        rec.status = errorStatus;
        rec.error = { code: (err && err.code) || "request_error", message: err && err.message ? err.message : String(err) };
        await save(rec, { parts: rec.parts, content: rec.content, status: errorStatus, error: rec.error });
        emit("message_end", { id: rec.id, status: errorStatus, error: rec.error, step: steps });
        failure = err;
        status = "error";
        throw err;
      }
      if (flushTimer !== null) clearTimeout(flushTimer);
      flush();

      // ---- 收口：整包 JSON 是权威结果，覆盖增量拼出来的东西 ----
      if (acc.authoritative) {
        const ch = acc.authoritative.choices && acc.authoritative.choices[0];
        const msg = ch && (ch.message || ch.delta);
        if (msg) {
          if (typeof msg.content === "string") acc.text = msg.content;
          if (msg.reasoning_content) acc.reasoning = String(msg.reasoning_content);
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            acc.calls = msg.tool_calls.map((tc, i) => ({
              index: i,
              id: tc.id || "call_" + i,
              name: (tc.function && tc.function.name) || "",
              argsRaw: typeof (tc.function && tc.function.arguments) === "string" ? tc.function.arguments : JSON.stringify((tc.function && tc.function.arguments) || {}),
            }));
          }
          if (ch.finish_reason) acc.finish = String(ch.finish_reason);
        }
      }

      // ---- 参数解析（先排好序，落盘永远按 call 顺序） ----
      const calls = acc.calls
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((c) => {
          const call = { index: c.index, id: c.id, name: c.name || "(未命名工具)", argsRaw: c.argsRaw || "", args: null, argsError: null };
          if (!call.argsRaw.trim()) call.args = {};
          else {
            try {
              const parsed = JSON.parse(call.argsRaw);
              call.args = parsed && typeof parsed === "object" ? parsed : { value: parsed };
            } catch (e) {
              call.argsError = e && e.message ? e.message : String(e);
            }
          }
          emit("toolcall_end", { id: rec.id, callId: call.id, name: call.name, args: call.args, argsError: call.argsError, step: steps });
          return call;
        });

      const truncated = acc.finish === "length";
      rec.parts = buildParts(rec, acc, truncated);
      rec.content = acc.text;
      rec.status = "complete";
      rec.finishReason = acc.finish || null;
      await save(rec, { parts: rec.parts, content: rec.content, status: "complete", finishReason: rec.finishReason });
      emit("message_end", { id: rec.id, status: "complete", finishReason: rec.finishReason, toolCalls: calls.length, step: steps });

      transcript.push(partsToOpenAI(rec.parts));
      lastText = acc.text;

      // ---- 判据只看有没有 tool_calls ----
      if (!calls.length) break;

      if (truncated) {
        // finish_reason==='length'：这条消息里的 tool-call 一个都不执行，全部标失败
        calls.forEach((call) => {
          const message = "未执行：上一条消息被截断（finish_reason=length），本轮所有工具调用作废";
          emit("tool_execution_start", { callId: call.id, name: call.name, args: call.args, truncated: true });
          emit("tool_execution_end", { callId: call.id, name: call.name, isError: true, error: message, truncated: true });
          transcript.push(errorResult(call.id, "truncated_length", message));
        });
        emit("turn_end", { step: steps, executed: 0, truncated: true });
        continue;
      }

      // ---- 执行并回填 ----
      const outcomes = await executeCalls({ calls, tools, signal, emit, seen });
      let terminated = false;
      outcomes.forEach((o) => {
        transcript.push(o.message);
        if (o.terminate) terminated = true;
      });
      emit("turn_end", { step: steps, executed: calls.length, terminated });
      if (terminated) {
        status = "terminated";
        break;
      }
    }
  } catch (err) {
    if (err && err.name !== "AbortError") {
      failure = failure || err;
      if (status === "complete") status = "error";
    }
  }

  emit("agent_end", { status, steps, text: lastText, error: failure ? { code: failure.code || "error", message: failure.message } : null });
  return { status, text: lastText, steps, messages: records, error: failure || undefined };
}

/** 把聚合器状态变成可落盘的 parts（reasoning 只在 parts 里，回传模型时不带） */
function buildParts(rec, acc, sealed) {
  const parts = [];
  if (acc.reasoning) parts.push({ type: "reasoning", text: acc.reasoning });
  if (acc.text) parts.push({ type: "text", text: acc.text });
  acc.calls
    .slice()
    .sort((a, b) => a.index - b.index)
    .forEach((c) => {
      const part = { type: "tool-call", id: c.id, name: c.name, argsRaw: c.argsRaw };
      if (sealed) {
        try {
          part.args = JSON.parse(c.argsRaw || "{}");
        } catch (e) {
          part.argsError = e && e.message ? e.message : String(e);
        }
      }
      parts.push(part);
    });
  if (!parts.length) parts.push({ type: "text", text: "" });
  return parts;
}

/**
 * 启动时把遗留的 streaming 消息降级成 aborted（上次进程被杀/页面刷新留下的半截）。
 * 传 convId 只修一个会话；不传就扫全部会话（会话不多，够用）。
 * @param {object} store
 * @param {string} [convId]
 * @returns {Promise<number>} 修了几条
 */
export async function recoverStreaming(store, convId) {
  if (!store || typeof store.listMessages !== "function") return 0;
  const convIds = convId
    ? [convId]
    : ((await store.listConversations()).map((c) => c && c.id).filter(Boolean) || []);
  let fixed = 0;
  for (const id of convIds) {
    const list = await store.listMessages(id).catch(() => []);
    const stuck = (list || []).filter((m) => m && m.status === "streaming");
    for (const m of stuck) {
      await store.updateMessage(m.id, { status: "aborted" }).catch(() => {});
      fixed += 1;
    }
  }
  return fixed;
}

export default runAgent;