// 顶栏组件：私聊卡与群聊卡共用这一份实现，不允许各写一份。
// DOM 与 C:\Meru\website\su\preview\styles.html 第 756-765 行一致（唯一的改动是把 ⋮ 从 span 换成 button，
// 这样它才真的可点、可聚焦、可键盘触发）；视觉值仍全部由 css/style-kit.css 的 .chat-head 提供，不新增 CSS。
// 调用：chatHead({ ava, avaColor, avaImage, name, sub, onBack, onMore }) -> HTMLElement（.chat-head）
import { el } from "../core/util.js";
// 字色必须跟底色走：白主题色（默认）下顶栏头像不能是白底白字。
// 唯一实现在 js/ui/avatar.js（dev-a），这里只调，不另写一份亮度判断。
import { applyAvatarInk } from "./avatar.js";

/** ⋮ 换成 button 后要清掉浏览器默认外观；只有这一处内联，不落 CSS */
const HEAD_ICO_RESET = "background:none;border:none;padding:0;font:inherit;color:inherit;cursor:pointer";

export function chatHead(opts) {
  const o = opts || {};

  const head = el("div", "chat-head");
  head.appendChild(el("span", "back", "‹"));
  const ava = el("div", "ava", o.ava == null ? "" : String(o.ava));
  // 头像底色由调用方给（主题色或会话头像色），有自定义图就用图；文字仍是首字，图会把它盖住
  // 字色一律按底色亮度自适应（亮底 → 深色字，不描边），见 js/ui/avatar.js
  if (o.avaImage) {
    ava.style.backgroundImage = 'url("' + String(o.avaImage) + '")';
    ava.style.backgroundSize = "cover";
    ava.style.backgroundPosition = "center";
    if (o.avaColor) ava.style.backgroundColor = String(o.avaColor);
  } else if (o.avaColor) {
    ava.style.backgroundColor = String(o.avaColor);
  }
  applyAvatarInk(ava, o.avaColor ? String(o.avaColor) : "");
  head.appendChild(ava);

  const who = el("div", "who");
  who.appendChild(el("span", "name", o.name == null ? "" : String(o.name)));
  who.appendChild(el("span", "sub", o.sub == null ? "" : String(o.sub)));
  head.appendChild(who);

  head.appendChild(el("div", "spacer"));

  const more = el("button", "head-ico", "⋮");
  more.type = "button";
  more.setAttribute("aria-label", "更多");
  more.setAttribute("style", HEAD_ICO_RESET);
  head.appendChild(more);

  // 事件绑在元素上；切页重建顶栏时整棵子树被替换，监听随之释放
  if (typeof o.onBack === "function") {
    head.querySelector(".back").addEventListener("click", () => o.onBack());
  }
  if (typeof o.onMore === "function") {
    more.addEventListener("click", () => o.onMore());
  }

  return head;
}

export default chatHead;