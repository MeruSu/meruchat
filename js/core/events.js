// js/core/events.js — 极简事件总线（卡片之间唯一的通信方式）
"use strict";

/**
 * @returns {{emit:(name:string, payload?:any)=>void, on:(name:string, fn:Function)=>()=>void, off:(name:string, fn:Function)=>void, clear:()=>void}}
 */
export function createEvents() {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();

  function on(name, fn) {
    if (typeof fn !== "function") throw new TypeError("events.on: fn 必须是函数");
    let set = map.get(name);
    if (!set) {
      set = new Set();
      map.set(name, set);
    }
    set.add(fn);
    return () => off(name, fn);
  }

  function off(name, fn) {
    const set = map.get(name);
    if (!set) return;
    set.delete(fn);
    if (!set.size) map.delete(name);
  }

  function emit(name, payload) {
    const set = map.get(name);
    if (!set || !set.size) return;
    // 拷贝一份，允许回调里解绑自己
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error("[events] 回调失败:", name, err);
      }
    }
  }

  function clear() {
    map.clear();
  }

  return { emit, on, off, clear };
}

export default createEvents;