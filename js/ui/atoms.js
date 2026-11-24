/**
 * MeruChat 共享原子组件（纯 DOM 工厂，零依赖）
 *
 * 职责：只负责「结构 + 交互」，不负责「颜色 + 尺寸」——视觉一律交给
 * css/theme.css 与 css/cards.css 的类名，本文件不写任何内联样式。
 *
 * 弹层复用 theme.css 的现成套件（不新增类名）：
 *   .modal-mask（fixed 遮罩）+ .modal / .modal-head / .modal-foot / .modal-x / .confirm-text / .btn
 * 按钮类串由调用方通过 opts.*Class 传入，这样同一套原子能同时服务
 * 「聊天卡片底部动作表」和「详情卡片确认弹窗」两种外观。
 *
 * 导出的函数签名：
 *   avatar({ seed, name, size, className })                 -> HTMLElement
 *   bubble({ text, mine, name, avatarSeed, ... })           -> HTMLElement
 *   menu({ items, sheetClass?, itemClass?, maskClass? })    -> Promise<key|null>
 *   confirmDialog({ title, message, danger, okText, cancelText,
 *                   maskClass?, dialogClass?, bodyClass?,
 *                   okClass?, cancelClass? })               -> Promise<boolean>
 *   promptDialog({ title, value, placeholder, okText, cancelText, ...same }) -> Promise<string|null>
 *   memberEditDialog({ name, persona, accent, accentColors, accentLabels, mount,
 *                      title?, okText?, cancelText?, ...same })     -> Promise<{name,persona,accent}|null>
 */

import { el, hashStr } from "../core/util.js";

var DEFAULT_MASK_CLASS = "modal-mask";
var DEFAULT_SHEET_CLASS = "sheet";
var DEFAULT_ITEM_CLASS = "sheet-item";

/* ---------------------------------------------------------------- 头像 */

/** 头像渐变组（与 js/app.js 的 AV_GRAD 同一套色，保证同一 seed 同色）— 头像专用视觉资产，只放这里 */
var AV_GRAD = [
  ["#f5a623", "#f76b1c"],
  ["#5ac8fa", "#007aff"],
  ["#35c759", "#10a37f"],
  ["#a06bff", "#6a4cff"],
  ["#ff6b9d", "#d97757"],
  ["#00b8a9", "#00a884"]
];

/** 取名字首字（空名给 ?） */
function initialOf(name, seed) {
  var src = String(name || seed || "").trim();
  if (!src) return "?";
  // Array.from 保证代理对（emoji）不被截断
  return Array.from(src)[0].toUpperCase();
}

/** 把 size（数字或 '28px'）统一成像素数，非法返回 0（0 = 交给 CSS 决定） */
function sizeToPx(size) {
  if (size == null || size === "") return 0;
  if (typeof size === "number") return size > 0 ? Math.round(size) : 0;
  var n = parseFloat(String(size));
  return isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 头像。类名由调用方给（如 .ava / .mava / 无类名），尺寸与配色交给 CSS。
 * size 只有调用方明确要求时才会以 CSS 变量形式下发（--ava-size），
 * 避免在 JS 里拼 style 属性。
 * @param {{seed?:string, name?:string, size?:number|string, className?:string}} [options]
 */
export function avatar(options) {
  var opts = options || {};
  var seed = opts.seed != null ? opts.seed : opts.name;
  var node = el("div", opts.className || "ava", initialOf(opts.name, seed));

  // 确定性渐变色用 data 属性交给 CSS：.ava[data-ava="0"] ~ [data-ava="5"]
  var gradIndex = hashStr(seed) % AV_GRAD.length;
  node.dataset.ava = String(gradIndex);
  node.dataset.avGrad = AV_GRAD[gradIndex].join(",");

  if (opts.name) node.title = String(opts.name);

  var px = sizeToPx(opts.size);
  // 尺寸是「调用方点名的定位参数」，只有显式传 size 才写一个 CSS 变量，
  // CSS 里 .ava / .mava 的固定像素仍是默认值。
  if (px) node.setAttribute("style", "--ava-size:" + px + "px");
  return node;
}

/* ---------------------------------------------------------------- 气泡 */

/**
 * 气泡。返回一条消息行：.msg（对方）/ .msg.me（自己）。
 * 结构按 css/cards.css 现有选择器来：.msg > .msg-ava + .msg-col{ .meta, .bubble{ .bubble-text } }
 * @param {{text?:string, mine?:boolean, name?:string, avatarSeed?:string}} [options]
 */
export function bubble(options) {
  var opts = options || {};
  var mine = !!opts.mine;

  var row = el("div", mine ? "msg me" : "msg");

  if (!mine) {
    row.appendChild(
      avatar({
        className: "msg-ava",
        seed: opts.avatarSeed != null ? opts.avatarSeed : opts.name,
        name: opts.name
      })
    );
  }

  var col = el("div", "msg-col");

  if (!mine && opts.name) col.appendChild(el("div", "meta", String(opts.name)));

  var bubbleEl = el("div", "bubble");
  bubbleEl.appendChild(el("div", "bubble-text", opts.text == null ? "" : String(opts.text)));
  col.appendChild(bubbleEl);

  row.appendChild(col);
  return row;
}

/* --------------------------------------------------------------- 弹层基础 */

/** 退场兜底：reduced-motion 下 animation 时长 0.01ms、animationend 可能不来，必须靠这个收尾 */
var OVERLAY_EXIT_MS = 300;

/**
 * 建遮罩并挂到 body；返回 { mask, close(result) }。点遮罩 / Esc = 取消。
 * 动效见 docs/DEV.md §2.5：遮罩淡入淡出、面板上滑进出；全部靠 css/motion.css 的
 * .anim-* 类，本文件不写任何内联样式与时长。
 */
function openOverlay(maskClass) {
  var mask = el("div", maskClass || DEFAULT_MASK_CLASS);

  /** 面板 = 遮罩里的第一个元素子节点（.sheet / .modal / 调用方自定义的类） */
  function panelOf() {
    for (var i = 0; i < mask.childNodes.length; i++) {
      var n = mask.childNodes[i];
      if (!n || n.nodeType === 3 || n.tagName === "#text") continue;
      return n;
    }
    return null;
  }

  function onKey(e) {
    if (e.key === "Escape") close(null);
  }

  var closing = false;

  function close(result) {
    // 幂等：Esc / 点遮罩 / 点按钮可能在同一帧里都触发，只认第一次
    if (closing || !mask.isConnected) return;
    closing = true;

    document.removeEventListener("keydown", onKey);

    var panel = panelOf();
    mask.classList.add("anim-fade-out");
    if (panel) panel.classList.add("anim-sheet-out");
    // 退场期间不再接受点击：靠 .anim-fade-out 自带的 pointer-events:none（不写内联样式）

    var settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      mask.removeEventListener("animationend", onEnd);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      var fn = mask.__resolve;
      mask.__resolve = null;
      if (typeof fn === "function") fn(result);
    }
    function onEnd(e) {
      if (e && e.target !== mask) return; // 面板的 animationend 不算数，只等遮罩那一条
      finish();
    }

    mask.addEventListener("animationend", onEnd);
    setTimeout(finish, OVERLAY_EXIT_MS); // 兜底：animationend 不保证来
  }

  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", function (e) {
    if (e.target === mask) close(null);
  });
  document.body.appendChild(mask);
  mask.classList.add("anim-fade-in"); // 入场：遮罩淡入

  return {
    mask: mask,
    close: close,
    /** 面板挂上之后由调用方调一次（面板是在 openOverlay 返回后才被 append 的） */
    animatePanel: function () {
      var panel = panelOf();
      if (panel) panel.classList.add("anim-sheet-in");
    },
  };
}

function button(label, cls, onClick) {
  var b = el("button", cls, String(label));
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/**
 * 底部动作菜单。items 支持字符串或 { key, label, danger }。
 * 默认外观是聊天卡片的底部动作表（.sheet > .sheet-item）；详情卡片想换成
 * 居中对话框，传 sheetClass:"modal" / itemClass:"sheet-item" 即可。
 * @returns {Promise<any|null>} 选中项的 key；取消返回 null
 */
export function menu(options) {
  var opts = options || {};
  var items = Array.isArray(opts.items) ? opts.items : [];
  var sheetClass = opts.sheetClass || DEFAULT_SHEET_CLASS;
  var itemClass = opts.itemClass || DEFAULT_ITEM_CLASS;

  return new Promise(function (resolve) {
    var overlay = openOverlay(opts.maskClass);
    overlay.mask.__resolve = resolve;

    if (opts.maskClass) overlay.mask.classList.add(opts.maskClass);
    var sheet = el("div", sheetClass);
    overlay.mask.appendChild(sheet);
    overlay.animatePanel();

    items.forEach(function (item) {
      var isObj = item && typeof item === "object";
      var key = isObj ? item.key : item;
      var label = isObj && item.label != null ? item.label : String(key == null ? "" : key);
      var danger = isObj ? !!item.danger : false;
      var cls = itemClass + (danger ? " danger" : "");
      sheet.appendChild(
        button(label, cls, function () {
          overlay.close(key);
        })
      );
    });
  });
}

/**
 * 确认框。默认外观 = theme.css 的 .modal（居中对话框）。
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options) {
  var opts = options || {};

  return new Promise(function (resolve) {
    var overlay = openOverlay(opts.maskClass);
    overlay.mask.__resolve = function (result) {
      resolve(result === true);
    };

    var dialog = el("div", opts.dialogClass || "modal");
    overlay.mask.appendChild(dialog);
    overlay.animatePanel();

    var head = el("div", "modal-head", String(opts.title || "确认"));
    dialog.appendChild(head);

    var body = el("div", opts.bodyClass || "modal-body");
    if (opts.message) body.appendChild(el("div", "confirm-text", String(opts.message)));
    dialog.appendChild(body);

    var foot = el("div", "modal-foot");
    foot.appendChild(
      button(opts.cancelText || "取消", opts.cancelClass || "btn", function () {
        overlay.close(false);
      })
    );
    foot.appendChild(
      button(
        opts.okText || "确定",
        (opts.okClass || "btn") + (opts.danger ? " row-danger" : ""),
        function () {
          overlay.close(true);
        }
      )
    );
    dialog.appendChild(foot);
  });
}

/**
 * 单行文本输入框。默认外观 = .modal 对话框（标题 + 输入 + 两个按钮）。
 * @returns {Promise<string|null>} 取消 → null；空串是合法结果
 */
export function promptDialog(options) {
  var opts = options || {};

  return new Promise(function (resolve) {
    var overlay = openOverlay(opts.maskClass);
    overlay.mask.__resolve = function (result) {
      resolve(result == null ? null : String(result));
    };

    var dialog = el("div", opts.dialogClass || "modal");
    overlay.mask.appendChild(dialog);
    overlay.animatePanel();

    dialog.appendChild(el("div", "modal-head", String(opts.title || "输入")));

    var body = el("div", opts.bodyClass || "modal-body");
    var field = el("div", "field");
    var input = document.createElement("input");
    input.type = "text";
    input.className = opts.inputClass || "detail-input";
    input.value = opts.value == null ? "" : String(opts.value);
    input.placeholder = opts.placeholder == null ? "" : String(opts.placeholder);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        overlay.close(input.value);
      }
    });
    field.appendChild(input);
    body.appendChild(field);
    dialog.appendChild(body);

    var foot = el("div", "modal-foot");
    foot.appendChild(
      button(opts.cancelText || "取消", opts.cancelClass || "btn", function () {
        overlay.close(null);
      })
    );
    foot.appendChild(
      button(opts.okText || "确定", opts.okClass || "btn", function () {
        overlay.close(input.value);
      })
    );
    dialog.appendChild(foot);

    // 同帧 append 之后聚焦在移动端也稳定；光标放到末尾
    setTimeout(function () {
      if (!input.isConnected) return;
      input.focus();
      if (input.setSelectionRange) {
        try {
          input.setSelectionRange(input.value.length, input.value.length);
        } catch (e) {
          /* 某些 WebView 不支持，忽略 */
        }
      }
    }, 0);
  });
}

/**
 * 成员编辑框：名字 + 人格 + 主题色（.seg 一排色块）。
 * 与 promptDialog 同一套弹层外观（.modal / .modal-head / .modal-body / .modal-foot）；
 * 色块值由调用方给（`accentColors`，一般是 store.ACCENT_COLORS），本文件不认识任何色值。
 * 「跟随默认」= 返回 accent:null。
 * @param {{title?:string, name?:string, persona?:string, accent?:string|null,
 *          accentLabel?:string, accentColors?:string[], idPrefix?:string,
 *          okText?:string, cancelText?:string, maskClass?:string,
 *          dialogClass?:string, bodyClass?:string, okClass?:string, cancelClass?:string}} [options]
 * @returns {Promise<{name:string, persona:string, accent:string|null}|null>} 取消 → null
 */
export function memberEditDialog(options) {
  var opts = options || {};

  return new Promise(function (resolve) {
    var overlay = openOverlay(opts.maskClass);
    // 让弹层落在卡片根内（.modal-mask 是 fixed，视觉不变；验收查询按卡片范围统计）
    if (opts.mount && opts.mount.appendChild) opts.mount.appendChild(overlay.mask);
    overlay.mask.__resolve = function (result) {
      resolve(result == null ? null : result);
    };

    var dialog = el("div", opts.dialogClass || "modal");
    overlay.mask.appendChild(dialog);
    overlay.animatePanel();
    dialog.appendChild(el("div", "modal-head", String(opts.title || "编辑成员")));

    var body = el("div", opts.bodyClass || "modal-body");

    // 名字
    var nameField = el("div", "field");
    nameField.appendChild(el("label", "lbl", "名字"));
    var input = document.createElement("input");
    input.type = "text";
    input.className = "detail-input";
    input.value = opts.name == null ? "" : String(opts.name);
    input.placeholder = "成员名字";
    nameField.appendChild(input);
    body.appendChild(nameField);

    // 人格
    var personaField = el("div", "field");
    personaField.appendChild(el("label", "lbl", "设定 / 人格"));
    var area = document.createElement("textarea");
    area.className = "detail-textarea";
    area.rows = 4;
    area.value = opts.persona == null ? "" : String(opts.persona);
    area.placeholder = "描述这个成员怎么说话、有什么设定";
    personaField.appendChild(area);
    body.appendChild(personaField);

    // 主题色：跟随默认 + 调用方给的色块
    var accentField = el("div", "field");
    accentField.appendChild(el("label", "lbl", String(opts.accentLabel || "主题色")));
    var seg = el("div", "seg");
    var colors = Array.isArray(opts.accentColors) ? opts.accentColors : [];
    var current = opts.accent == null || opts.accent === "" ? null : String(opts.accent);

    function addSwatch(key, label, attrs) {
      var b = button("", "", function () {
        current = key;
        markSwatches();
      });
      b.type = "button";
      b.setAttribute("data-member-accent", "1");
      if (key) {
        b.setAttribute("data-accent", key);
        // 色块 + 色名（色值只有调用方给的这份，本文件不内置任何颜色；不加描边，
        // 面与面之间只靠色差分辨，见 DEV.md 2.2）
        var dot = el("i", "");
        dot.setAttribute("style", "display:inline-block;width:10px;height:10px;border-radius:50%;" +
          "margin-right:6px;vertical-align:-1px;background:" + key);
        b.appendChild(dot);
        b.appendChild(document.createTextNode(String(label)));
      } else {
        b.setAttribute("data-accent-default", "1");
        b.textContent = String(label);
      }
      if (attrs) {
        for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) b.setAttribute(k, attrs[k]);
      }
      seg.appendChild(b);
      return b;
    }

    function markSwatches() {
      var btns = seg.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var isDef = btns[i].hasAttribute("data-accent-default");
        var want = current ? btns[i].getAttribute("data-accent") === current : isDef;
        btns[i].classList.toggle("active", !!want);
      }
    }

    addSwatch(null, "跟随默认");
    var labels = opts.accentLabels && typeof opts.accentLabels === "object" ? opts.accentLabels : {};
    colors.forEach(function (hex) {
      addSwatch(String(hex), labels[hex] || String(hex));
    });
    markSwatches();
    accentField.appendChild(seg);
    body.appendChild(accentField);

    dialog.appendChild(body);

    var foot = el("div", "modal-foot");
    foot.appendChild(
      button(opts.cancelText || "取消", opts.cancelClass || "btn", function () {
        overlay.close(null);
      })
    );
    foot.appendChild(
      button(opts.okText || "保存", opts.okClass || "btn", function () {
        overlay.close({
          name: input.value,
          persona: area.value,
          accent: current
        });
      })
    );
    dialog.appendChild(foot);

    setTimeout(function () {
      if (input.isConnected) input.focus();
    }, 0);
  });
}

export default {
  avatar: avatar,
  bubble: bubble,
  menu: menu,
  confirmDialog: confirmDialog,
  promptDialog: promptDialog,
  memberEditDialog: memberEditDialog
};