// js/core/tools/runner.js — tool-call 的执行器（与具体工具解耦）
// 三件事：挡重复调用（同工具同参数只跑一次）、并行但严格按 call 顺序落盘、把失败变成模型能读到的错误结果。
"use strict";

/** 稳定序列化：同参数不同键序也要算出同一个指纹 */
export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

/** 一份 tool-call 的指纹：工具名 + 参数（用于挡重复调用） */
export function toolFingerprint(name, args) {
  let body;
  try {
    body = stableJson(args === undefined ? null : args);
  } catch (e) {
    body = String(args);
  }
  return String(name) + ":" + body;
}

/** 工具结果永远是字符串化文本；结构化信息留在 details 里 */
export function stringifyResult(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** 把失败也变成「模型能读到的结果」：不静默、不冒充成功 */
export function errorResult(callId, code, message) {
  return {
    role: "tool",
    tool_call_id: callId,
    content: JSON.stringify({ error: { code, message } }),
    details: { isError: true, code, message },
  };
}

/** 组装成功回填给模型的 tool 消息 */
export function toolMessage(callId, text, details, terminate) {
  const row = { role: "tool", tool_call_id: callId, content: String(text == null ? "" : text) };
  if (details !== undefined) row.details = details;
  if (terminate) row.terminate = true;
  return row;
}

/**
 * 执行一批 tool-call。并行是允许的（默认），但只要有一个工具声明 sequential 就整批串行。
 * 结果数组的下标与 calls 一致，落盘顺序永远等于 assistant 里的 call 顺序。
 * @param {object} opts
 * @param {Array<{id:string,name:string,args:any,argsError?:string}>} opts.calls
 * @param {Array<object>} opts.tools
 * @param {AbortSignal} [opts.signal]
 * @param {(name: string, payload: object) => void} opts.emit
 * @param {Set<string>} opts.seen  跨轮共享的指纹集合
 * @returns {Promise<Array<{message: object, terminate: boolean}>>}
 */
export async function executeCalls({ calls, tools, signal, emit, seen }) {
  const byName = new Map((tools || []).map((t) => [t.name, t]));
  const results = new Array(calls.length);
  const sequential = calls.some((c) => {
    const tool = byName.get(c.name);
    return tool && tool.executionMode === "sequential";
  });

  const abortError = () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
  };

  const runOne = async (call, i) => {
    const tool = byName.get(call.name);
    const reject = (code, message) => {
      emit("tool_execution_start", { callId: call.id, name: call.name, args: call.args || null, i });
      emit("tool_execution_end", { callId: call.id, name: call.name, isError: true, error: message, code, i });
      results[i] = { message: errorResult(call.id, code, message), terminate: false };
    };

    if (!tool) {
      reject("unknown_tool", "未注册的工具：" + call.name);
      return;
    }
    // 参数解析失败不 abort：回填一条 isError 结果让模型自己重试
    if (call.argsError) {
      reject("bad_args", "工具参数不是合法 JSON：" + String(call.argsError).slice(0, 200));
      return;
    }
    // 相同 (toolName, args) 二次调用直接拒，不去打扰世界
    const fp = toolFingerprint(call.name, call.args);
    if (seen.has(fp)) {
      reject("duplicate_call", "重复调用：工具与参数与之前某次完全相同（fingerprint " + fp.slice(0, 80) + "）");
      return;
    }
    seen.add(fp);

    emit("tool_execution_start", { callId: call.id, name: call.name, args: call.args, i });
    try {
      const out = await tool.execute(call.id, call.args, signal, (update) => {
        emit("tool_execution_update", { callId: call.id, name: call.name, update, i });
      });
      const text = stringifyResult(out);
      const details = out && out.details !== undefined ? out.details : undefined;
      const terminate = !!(out && out.terminate);
      emit("tool_execution_end", { callId: call.id, name: call.name, isError: false, details, i });
      results[i] = { message: toolMessage(call.id, text, details, terminate), terminate };
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      const code = (err && err.code) || "tool_error";
      const message = err && err.message ? err.message : String(err);
      emit("tool_execution_end", { callId: call.id, name: call.name, isError: true, error: message, code, i });
      results[i] = { message: errorResult(call.id, code, message), terminate: false };
    }
  };

  if (sequential) {
    for (let i = 0; i < calls.length; i += 1) {
      if (signal && signal.aborted) throw abortError();
      await runOne(calls[i], i);
    }
  } else {
    await Promise.all(calls.map((c, i) => runOne(c, i)));
  }
  return results;
}

export default executeCalls;