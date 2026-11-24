// js/core/router.js — 卡片栈路由
// 宽屏栈最多 2 层（list 固定为底），窄屏任意深度（由 shell 决定是否裁剪）。
"use strict";

/**
 * @param {object} opts
 * @param {{emit:(n:string,p?:any)=>void, on:(n:string,f:Function)=>Function}} opts.events
 * @param {Record<string, any>} [opts.cards] 可选：可用卡片表，用于 push 时校验 id
 */
export function createRouter({ events, cards } = {}) {
  if (!events || typeof events.emit !== "function") {
    throw new TypeError("createRouter: 需要 events（createEvents() 的返回值）");
  }

  /** @type {Array<{id: string, params: any}>} */
  const stack = [{ id: "list", params: null }];

  function known(id) {
    // 没给 cards 表就不校验，交给 shell 动态 import 时报错
    if (!cards) return true;
    return Object.prototype.hasOwnProperty.call(cards, id);
  }

  function emitRoute(reason) {
    events.emit("route", { stack: stack.slice(), reason });
  }

  function current() {
    return stack[stack.length - 1];
  }

  function depth() {
    return stack.length;
  }

  /**
   * 压入一张卡片。
   * @param {string} id
   * @param {any} [params]
   */
  function push(id, params) {
    if (!id) throw new Error("router.push: 缺少卡片 id");
    if (!known(id)) throw new Error("router.push: 未知卡片 '" + id + "'");
    const top = current();
    if (top && top.id === id && JSON.stringify(top.params) === JSON.stringify(params || null)) {
      return current(); // 重复 push 同一张同一参数，直接忽略
    }
    stack.push({ id, params: params === undefined ? null : params });
    emitRoute("push");
    return current();
  }

  /** 弹出栈顶；栈底（list）不可弹。 */
  function back() {
    if (stack.length <= 1) return current();
    stack.pop();
    emitRoute("back");
    return current();
  }

  /**
   * 替换栈顶。
   * @param {string} id
   * @param {any} [params]
   */
  function replace(id, params) {
    if (!id) throw new Error("router.replace: 缺少卡片 id");
    if (!known(id)) throw new Error("router.replace: 未知卡片 '" + id + "'");
    if (stack.length <= 1) {
      stack.push({ id, params: params === undefined ? null : params });
    } else {
      stack[stack.length - 1] = { id, params: params === undefined ? null : params };
    }
    emitRoute("replace");
    return current();
  }

  /** 回到栈底（list）。 */
  function reset() {
    if (stack.length === 1) return current();
    stack.length = 1;
    emitRoute("reset");
    return current();
  }

  /**
   * 按宽屏规则裁剪栈：宽屏只保留「栈底 + 栈顶」两层。
   * 由 shell 在布局切换时调用（窄→宽）。
   */
  function clamp(maxDepth) {
    const limit = Math.max(1, Number(maxDepth) || 1);
    if (stack.length <= limit) return current();
    const bottom = stack[0];
    const top = stack[stack.length - 1];
    stack.length = 0;
    stack.push(bottom, top);
    emitRoute("clamp");
    return current();
  }

  return { stack, push, back, replace, reset, clamp, current, depth };
}

export default createRouter;
