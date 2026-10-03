/*!
 * screens/me.js —— 「我的」设置中心 + 模版目录 + 记忆检索（K-UI 经典脚本，无模块、无网络）。
 *
 * 注册键：window.PB.screens.me / window.PB.screens.templates / window.PB.screens.memory
 *
 * 数据来源（全部经 window.PotbotHost，即 PB.host；页面自身不发 fetch/XHR）：
 *   - 连接与密钥状态：GET /health、GET /api/identity（不显示任何密钥值，只显示是否配置）
 *   - 模版目录：      GET /api/plugins、GET /api/plugins/<id>（真实清单 + 五态 + 解锁动作）
 *   - 记忆：          GET /api/memory/status、GET /api/conversations、
 *                     GET /api/memory/entries?owner_id=…
 *
 * 诚实地基（不得编造）：
 *   - 起始为空；没有真实回执时一律如实说明，绝不冒充成功。
 *   - 没有后端回包就渲染「读取失败/通道不可用」的真实错误，不用假数据填充。
 *   - 记忆是**按会话隔离**的（一个会话 = 一个记忆主体）。本页对每个真实会话，
 *     用与内核一致的口径派生 owner：`conv-` + sha256(conversationId).slice(0,32)
 *     （见 apps/demo/server/conversation-host.ts ownerIdForConversation；
 *     页面侧 sha256 是只读镜像，若口径变更，本页会如实显示「查不到」而不是编造条目）。
 *   - 密钥（KeyRef）：任何位置都不收集明文；本页只显示「已配置/未配置」状态。
 *   - 模版的五态（已安装/启用/授权/依赖就绪/实测支持）分开呈现，未就绪给真实原因与解锁动作。
 *   - 未实测的能力一律标「未实测」，不以模拟结果代替实测结论。
 *
 * 只读镜像 F 线视图模型：apps/mobile-ui/src/settings/**、/templates/**、/memory/**。
 */
(function () {
  "use strict";

  window.PB = window.PB || {};
  window.PB.screens = window.PB.screens || {};

  // =========================================================================
  // 样式（全部作用域在 .pbme 之下，避免与其他屏幕冲突）
  // =========================================================================
  var STYLE_ID = "pbme-style";
  var CSS = [
    ":root{--pb-accent:#E9A66D;--pb-accent-soft:#FFF0E2;--pb-bg:#fff;--pb-ink:#28231F;--pb-muted:#77716B}",
    ".pbme{box-sizing:border-box;width:100%;color:var(--pb-ink,#28231F);",
    "  background:var(--pb-bg,#fff);font-size:16px;line-height:24px;",
    "  padding:8px 20px calc(28px + env(safe-area-inset-bottom)) 20px}",
    ".pbme *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}",
    ".pbme h1{font-size:24px;line-height:32px;font-weight:600;margin:8px 0 12px}",
    ".pbme h2{font-size:18px;line-height:26px;font-weight:600;margin:0}",
    ".pbme .pbme-meta{font-size:12px;line-height:18px;color:var(--pb-muted,#77716B)}",
    ".pbme .pbme-note{font-size:14px;line-height:20px;color:var(--pb-muted,#77716B)}",

    /* 返回 / 顶部条 */
    ".pbme .pbme-top{display:flex;align-items:center;gap:8px;min-height:48px;margin:-8px 0 4px}",
    ".pbme .pbme-back{min-height:48px;min-width:48px;display:flex;align-items:center;gap:4px;",
    "  background:none;border:0;font:inherit;color:var(--pb-ink,#28231F);padding:0 8px 0 0}",
    ".pbme .pbme-back:active{background:var(--pb-accent-soft,#FFF0E2);border-radius:10px}",
    ".pbme .pbme-head{flex:1;font-size:17px;font-weight:600;overflow:hidden;",
    "  text-overflow:ellipsis;white-space:nowrap}",

    /* 个人资料块 */
    ".pbme .pbme-profile{display:flex;align-items:center;gap:12px;margin:4px 0 16px}",
    ".pbme .pbme-avatar{width:48px;height:48px;flex:none;border-radius:50%;background:#28231F;color:#fff;",
    "  display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600}",

    /* 分区标题 */
    ".pbme .pbme-sec{font-size:13px;line-height:18px;font-weight:600;color:var(--pb-muted,#77716B);",
    "  margin:22px 0 6px;letter-spacing:.02em}",

    /* 卡片 */
    ".pbme .pbme-card{border:1px solid #E8E4DF;border-radius:16px;padding:4px 14px;margin:0 0 4px;background:#fff}",
    ".pbme .pbme-card.open{padding-bottom:12px}",

    /* 行 */
    ".pbme .pbme-row{display:flex;align-items:center;gap:12px;min-height:48px;width:100%;padding:10px 0;",
    "  border-bottom:1px solid #E8E4DF;background:none;border-left:0;border-right:0;border-top:0;",
    "  font:inherit;color:inherit;text-align:left}",
    ".pbme .pbme-row:last-child{border-bottom:0}",
    "button.pbme-row:active{background:var(--pb-accent-soft,#FFF0E2);border-radius:10px}",
    ".pbme .pbme-rmain{flex:1;min-width:0}",
    ".pbme .pbme-rtitle{display:block;font-size:16px;line-height:24px}",
    ".pbme .pbme-rsub{display:block;font-size:12px;line-height:18px;color:var(--pb-muted,#77716B);",
    "  word-break:break-word}",
    ".pbme .pbme-rval{flex:none;font-size:14px;line-height:20px;max-width:46%;text-align:right;",
    "  word-break:break-word}",
    ".pbme .pbme-rval.ok{color:#306A4B}.pbme .pbme-rval.warn{color:#825034}",
    ".pbme .pbme-rval.danger{color:#A73729}.pbme .pbme-rval.muted{color:var(--pb-muted,#77716B)}",
    ".pbme .pbme-chev{flex:none;color:var(--pb-muted,#77716B);font-size:18px}",

    /* 状态片 */
    ".pbme .pbme-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}",
    ".pbme .pbme-chip{display:inline-block;font-size:12px;line-height:18px;font-weight:500;",
    "  padding:2px 8px;border-radius:8px;background:#F2F0EE;color:var(--pb-muted,#77716B)}",
    ".pbme .pbme-chip.on{background:#EDF6F0;color:#306A4B}",
    ".pbme .pbme-chip.warn{background:var(--pb-accent-soft,#FFF0E2);color:#825034}",
    ".pbme .pbme-chip.danger{background:#FBE9E6;color:#A73729}",

    /* 按钮 */
    ".pbme .pbme-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 2px}",
    ".pbme .pbme-btn{min-height:48px;min-width:48px;padding:0 16px;border-radius:12px;border:0;",
    "  font:inherit;font-weight:500;font-family:inherit}",
    ".pbme .pbme-btn.primary{background:var(--pb-accent,#E9A66D);color:#241A14}",
    ".pbme .pbme-btn.secondary{background:#fff;color:var(--pb-ink,#28231F);border:1px solid #E8E4DF}",
    ".pbme .pbme-btn.danger{background:#fff;color:#A73729;border:1px solid #E4C6C1}",
    ".pbme .pbme-btn:disabled{opacity:.45}",
    ".pbme .pbme-btn:active:not(:disabled){filter:brightness(.97)}",

    /* 提示 / 反馈行 */
    ".pbme .pbme-feedback{margin:8px 0;padding:8px 10px;border-radius:10px;font-size:13px;line-height:19px;",
    "  background:#EDF6F0;color:#306A4B;border:1px solid #D3E7DB}",
    ".pbme .pbme-feedback.warn{background:var(--pb-accent-soft,#FFF0E2);color:#825034;border-color:#F3DFCB}",
    ".pbme .pbme-feedback.danger{background:#FBE9E6;color:#A73729;border-color:#E4C6C1}",

    /* 空 / 未知 / 失败 态 */
    ".pbme .pbme-state{margin:16px 0;padding:20px 16px;border-radius:14px;border:1px dashed #E8E4DF;",
    "  text-align:center;color:var(--pb-muted,#77716B)}",
    ".pbme .pbme-state h2{color:var(--pb-ink,#28231F)}",
    ".pbme .pbme-state.warn{border-color:#F3DFCB;background:#FFFCF8}",
    ".pbme .pbme-state.fail{border-color:#E4C6C1;background:#FEF9F8}",
    ".pbme .pbme-state .pbme-note{margin:6px 0 0}",

    /* 搜索框 */
    ".pbme .pbme-search{display:flex;align-items:center;gap:8px;min-height:48px;padding:0 12px;",
    "  border:1px solid #E8E4DF;border-radius:12px;background:#FAFAF9;margin:4px 0 10px}",
    ".pbme .pbme-search input{flex:1;min-width:0;border:0;outline:0;background:none;font:inherit;",
    "  color:var(--pb-ink,#28231F);min-height:46px}",

    /* 过滤器 */
    ".pbme .pbme-filters{display:flex;gap:8px;overflow-x:auto;padding:2px 0 8px}",
    ".pbme .pbme-filter{flex:none;min-height:44px;padding:0 14px;border-radius:22px;border:1px solid #E8E4DF;",
    "  background:#fff;color:var(--pb-ink,#28231F);font:inherit;font-size:14px}",
    ".pbme .pbme-filter[aria-pressed='true']{background:var(--pb-accent-soft,#FFF0E2);",
    "  border-color:#F3DFCB;color:#825034;font-weight:600}",

    /* 正文块（编辑） */
    ".pbme .pbme-edit{margin:8px 0 2px}",
    ".pbme .pbme-edit textarea{width:100%;min-height:72px;border:1px solid #E8E4DF;border-radius:12px;",
    "  padding:10px 12px;font:inherit;color:var(--pb-ink,#28231F);background:#FAFAF9;resize:vertical}",
    ".pbme .pbme-edit label{display:block;font-size:13px;color:var(--pb-muted,#77716B);margin:0 0 4px}",

    /* 选项 */
    ".pbme .pbme-option{display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 0;",
    "  border-bottom:1px solid #E8E4DF;font-size:14px}",
    ".pbme .pbme-option:last-child{border-bottom:0}",
    ".pbme .pbme-option input{width:20px;height:20px;flex:none;accent-color:#E9A66D}",
    ".pbme .pbme-option span{flex:1}",

    /* 代码 / 诊断预览 */
    ".pbme .pbme-pre{margin:8px 0 2px;padding:10px 12px;border-radius:10px;background:#FAFAF9;",
    "  border:1px solid #E8E4DF;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;",
    "  font-family:ui-monospace,Menlo,Consolas,monospace;color:#3C3733}",

    ".pbme .pbme-kv{display:flex;gap:8px;padding:6px 0;font-size:14px}",
    ".pbme .pbme-kv > b{font-weight:500;flex:none;min-width:88px;color:var(--pb-muted,#77716B)}",
    ".pbme .pbme-group{margin:18px 0 2px}",
    ".pbme .pbme-group > .pbme-meta{margin:0 0 4px}",
    ".pbme .pbme-foot{margin:20px 0 0;font-size:12px;line-height:18px;color:var(--pb-muted,#77716B)}",
    ".pbme .pbme-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}",
    ".pbme button:focus-visible,.pbme input:focus-visible,.pbme textarea:focus-visible{",
    "  outline:2px solid #825034;outline-offset:2px}",
    ".pbme .pbme-loading{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px;",
    "  color:var(--pb-muted,#77716B)}",
    ".pbme .pbme-dot{width:8px;height:8px;border-radius:50%;background:var(--pb-accent,#E9A66D);flex:none;",
    "  animation:pbme-pulse 1s ease-in-out infinite}",
    "@keyframes pbme-pulse{0%,100%{opacity:.35}50%{opacity:1}}"
  ].join("\n");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // =========================================================================
  // DOM 小工具
  // =========================================================================
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function el(tag, cls, html, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) {
      if (Array.isArray(html)) {
        for (var i = 0; i < html.length; i++) { if (html[i]) n.appendChild(html[i]); }
      } else {
        n.innerHTML = html;
      }
    }
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function bridgeOk(ctx) { return !!(ctx && ctx.bridge && ctx.bridge.available); }

  function sectionTitle(text) { return el("div", "pbme-sec", esc(text)); }
  function card(children) {
    var c = el("div", "pbme-card");
    (children || []).forEach(function (x) { if (x) c.appendChild(x); });
    return c;
  }
  function row(label, value, valueTone, detail) {
    var r = el("div", "pbme-row");
    r.appendChild(el("span", "pbme-rmain",
      '<span class="pbme-rtitle">' + esc(label) + "</span>" +
      (detail ? '<span class="pbme-rsub">' + esc(detail) + "</span>" : "")));
    if (value != null) r.appendChild(el("span", "pbme-rval " + (valueTone || "muted"), esc(value)));
    return r;
  }
  function navRow(label, value, detail, act) {
    var b = el("button", "pbme-row",
      '<span class="pbme-rmain"><span class="pbme-rtitle">' + esc(label) + "</span>" +
      (detail ? '<span class="pbme-rsub">' + esc(detail) + "</span>" : "") + "</span>" +
      (value ? '<span class="pbme-rval muted">' + esc(value) + "</span>" : "") +
      '<span class="pbme-chev" aria-hidden="true">›</span>',
      { type: "button", "data-act": act });
    return b;
  }
  function button(label, act, kind, disabled, disabledReason, data) {
    var attrs = { type: "button", "data-act": act };
    if (data) for (var k in data) attrs["data-" + k] = data[k];
    var b = el("button", "pbme-btn " + (kind || "secondary"), esc(label), attrs);
    if (disabled) {
      b.disabled = true;
      if (disabledReason) b.setAttribute("title", disabledReason);
    } else if (disabledReason) {
      b.setAttribute("title", disabledReason);
    }
    return b;
  }
  function actions(list) { var w = el("div", "pbme-actions"); list.forEach(function (b) { if (b) w.appendChild(b); }); return w; }
  function chips(list) {
    var w = el("div", "pbme-chips");
    list.forEach(function (c) { if (c) w.appendChild(el("span", "pbme-chip " + (c.tone || ""), esc(c.text))); });
    return w;
  }
  function kv(k, v) { return el("div", "pbme-kv", "<b>" + esc(k) + "</b><span>" + esc(v) + "</span>"); }
  function loadingLine(text) {
    var n = el("div", "pbme-loading");
    n.appendChild(el("span", "pbme-dot", null, { "aria-hidden": "true" }));
    n.appendChild(el("span", null, esc(text)));
    return n;
  }
  function stateBox(title, note, tone) {
    var b = el("div", "pbme-state" + (tone ? " " + tone : ""));
    b.appendChild(el("h2", null, esc(title)));
    if (note) b.appendChild(el("p", "pbme-note", esc(note)));
    return b;
  }
  function feedbackNode(store, key) {
    var f = store.feedback && store.feedback[key];
    if (!f) return null;
    var n = el("div", "pbme-feedback" + (f.tone ? " " + f.tone : ""));
    n.setAttribute("role", "status");
    n.setAttribute("aria-live", "polite");
    n.textContent = f.text;
    return n;
  }
  function setFeedback(store, key, text, tone) { store.feedback[key] = { text: text, tone: tone || "" }; }

  // =========================================================================
  // 后端通道（只经 PB.host；不可用即如实失败）
  // =========================================================================
  function hostOf(ctx) {
    if (ctx && ctx.host && typeof ctx.host.get === "function") return ctx.host;
    if (window.PB && window.PB.host && typeof window.PB.host.get === "function") return window.PB.host;
    return null;
  }
  function errOf(res) {
    if (res && res.error) return res.error;
    return { code: "unknown", message: "本地服务没有返回可识别的结果。" };
  }
  function errText(res) {
    var e = errOf(res);
    return (e.message || "请求失败") + (e.code ? "（" + e.code + "）" : "");
  }
  function apiGet(ctx, path) {
    var h = hostOf(ctx);
    if (!h) {
      return Promise.resolve({ ok: false, data: null, error: {
        code: "host_absent", message: "本地服务通道不可用（PB.host 未就绪）：本页无法连接电脑端后端。" } });
    }
    try { return Promise.resolve(h.get(path)); }
    catch (e) {
      return Promise.resolve({ ok: false, data: null, error: { code: "host_threw", message: String((e && e.message) || e) } });
    }
  }
  function apiPost(ctx, path, body) {
    var h = hostOf(ctx);
    if (!h || typeof h.post !== "function") {
      return Promise.resolve({ ok: false, data: null, error: {
        code: "host_absent", message: "本地服务通道不可用（PB.host 未就绪）：本次操作未提交。" } });
    }
    try { return Promise.resolve(h.post(path, body)); }
    catch (e) {
      return Promise.resolve({ ok: false, data: null, error: { code: "host_threw", message: String((e && e.message) || e) } });
    }
  }
  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms || 0); });
  }

  // =========================================================================
  // owner 派生（与内核 ownerIdForConversation 同口径的只读镜像）
  //   conv-<sha256(conversationId).hex.slice(0,32)>
  // =========================================================================
  function toUtf8Bytes(str) {
    var out = "";
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0x800) out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  function sha256hex(str) {
    function rot(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32), result = "", ascii = toUtf8Bytes(str);
    var words = [], asciiBitLength = ascii.length * 8;
    var hash = sha256hex.h = sha256hex.h || [], k = sha256hex.k = sha256hex.k || [];
    var primeCounter = k.length, isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (var ci = 0; ci < 313; ci += candidate) isComposite[ci] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while (ascii.length % 64 - 56) ascii += "\x00";
    for (var i = 0; i < ascii.length; i++) {
      var j = ascii.charCodeAt(i);
      if (j >> 8) return "";
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
              w[i - 16] + (rot(w15, 7) ^ rot(w15, 18) ^ (w15 >>> 3))
              + w[i - 7] + (rot(w2, 17) ^ rot(w2, 19) ^ (w2 >>> 10))) | 0);
        var temp2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (var b = 3; b + 1; b--) {
        var byte = (hash[i] >> (b * 8)) & 255;
        result += (byte < 16 ? "0" : "") + byte.toString(16);
      }
    }
    return result;
  }
  function ownerForConversation(conversationId) {
    var hex = sha256hex(String(conversationId));
    return hex ? "conv-" + hex.slice(0, 32) : "";
  }

  // =========================================================================
  // 脱敏（镜像 settings/diagnostics.ts；用于「诊断（脱敏）」预览）
  // =========================================================================
  var REDACT_VALUE_RULES = [
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "api-key"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "api-key"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "auth-header"],
    [/\b1[3-9]\d{9}\b/g, "phone"],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "email"],
    [/[A-Za-z]:\\[^\s"';,)]+/g, "path"],
    [/[A-Za-z]:\/(?!\/)[^\s"';,)]+/g, "path"],
    [/\/(?:home|Users|root|sdcard)\/[^\s"';,)]+/g, "path"]
  ];
  var REDACT_FIELD_RULES = [
    [/^(api_?key|apikey|secret|password|passwd|rawkey|keymaterial|credential)$/, "api-key"],
    [/^(authorization|auth_?header|bearer)$/, "auth-header"],
    [/token/, "token"],
    [/^(phone|mobile|tel|telephone|contact)$/, "phone"],
    [/^(email|mail|email_?address)$/, "email"],
    [/^(path|filepath|file_?path|directory|dir|desktop_?path|local_?path)$/, "path"]
  ];
  function redactText(text) {
    var out = String(text), count = 0, kinds = {};
    REDACT_VALUE_RULES.forEach(function (rule) {
      out = out.replace(rule[0], function () { count += 1; kinds[rule[1]] = true; return "[redacted:" + rule[1] + "]"; });
    });
    return { text: out, count: count, kinds: kinds };
  }
  function redactObject(value) {
    var count = 0, kinds = {};
    function walk(v, name) {
      var fieldKind = null, norm = String(name).toLowerCase().replace(/[^a-z_]/g, "");
      for (var i = 0; i < REDACT_FIELD_RULES.length; i++) {
        if (REDACT_FIELD_RULES[i][0].test(norm)) { fieldKind = REDACT_FIELD_RULES[i][1]; break; }
      }
      if (fieldKind) { count += 1; kinds[fieldKind] = true; return "[redacted:" + fieldKind + "]"; }
      if (typeof v === "string") {
        var r = redactText(v); count += r.count;
        for (var k in r.kinds) kinds[k] = true;
        return r.text;
      }
      if (Array.isArray(v)) return v.map(function (x) { return walk(x, name); });
      if (v && typeof v === "object") {
        var o = {};
        for (var key in v) o[key] = walk(v[key], key);
        return o;
      }
      return v;
    }
    var out = walk(value, "");
    return { value: out, redactedFields: count, redactedKinds: Object.keys(kinds).sort(), clean: count === 0 };
  }

  // =========================================================================
  // 状态存储（挂在 ctx.state 上，跨导航保持）
  // =========================================================================
  function getStore(ctx) {
    if (!ctx.state) ctx.state = {};
    if (!ctx.state.pbMe) {
      ctx.state.pbMe = {
        conn: { health: null, identity: null, loading: false, error: null },
        templates: { list: null, counts: null, loading: false, error: null, details: {}, expanded: null, busy: null },
        memory: { status: null, ready: null, reason: "", convs: null, byConv: {}, loading: false, progress: "",
                  error: null, query: "", filter: "all", openId: null, editId: null, forgetId: null, busy: null },
        feedback: {},
        meShowDiag: false
      };
    }
    if (!ctx.state.pbMe.feedback) ctx.state.pbMe.feedback = {};
    return ctx.state.pbMe;
  }

  // =========================================================================
  // 记忆标签
  // =========================================================================
  var KIND_LABELS = { session_message: "会话消息", task_fact: "任务事实", preference: "用户偏好", template_experience: "模板经验" };
  var SOURCE_LABELS = { user_statement: "用户陈述", user_confirmation: "用户确认", document: "文档", tool_result: "工具结果", inference: "系统推断", external: "外部内容" };
  var STATUS_LABELS = { active: "生效中", disabled: "已停用", deleted: "已删除" };
  var CONFIRM_LABELS = { unconfirmed: "未确认", confirmed: "已确认", rejected: "已否定" };
  var MEMORY_FILTERS = [
    { id: "all", label: "全部" },
    { id: "session_message", label: "会话消息" },
    { id: "task_fact", label: "任务事实" },
    { id: "preference", label: "用户偏好" },
    { id: "template_experience", label: "模板经验" }
  ];
  function kindLabel(k) { return KIND_LABELS[k] || k; }
  function sourceLabel(s) {
    if (!s) return "—";
    var base = SOURCE_LABELS[s.kind] || s.kind || "—";
    return s.detail ? base + "（" + s.detail + "）" : base;
  }
  function scopeLabel(scope) {
    if (!scope) return "—";
    if (scope.kind === "task") return "任务:" + (scope.task_id || "—");
    if (scope.kind === "template") return "模板:" + (scope.template_id || "—");
    return "用户";
  }
  function injectable(e) { return e.status === "active" && e.confirmation !== "rejected"; }

  // =========================================================================
  // 连接与密钥状态（真实读取 /health 与 /api/identity）
  // =========================================================================
  function refreshConn(ctx, force) {
    var store = getStore(ctx), c = store.conn;
    if (c.loading) return;
    if (!force && (c.health || c.identity || c.error)) return;
    c.loading = true; c.error = null;
    repaint(ctx, "me");
    /* 数据与屏无关：即使中途切走也读到底并落 store（repaint 自身会跳过非当前屏），
       回来时直接就是结果，不会卡在「读取中」。 */
    apiGet(ctx, "/health").then(function (health) {
      c.health = health.ok ? health.data : null;
      if (!health.ok) c.error = errText(health);
      return delay(0);
    }).then(function () {
      return apiGet(ctx, "/api/identity");
    }).then(function (ident) {
      if (ident && ident.ok) c.identity = ident.data;
      else if (ident && !ident.ok && !c.error) c.error = errText(ident);
      c.loading = false;
      repaint(ctx, "me");
    });
  }

  // =========================================================================
  // 「我的」设置中心
  // =========================================================================
  function renderMe(root, ctx) {
    begin(root, ctx, "me");
    var store = getStore(ctx);
    var c = store.conn;
    if (!c.health && !c.identity && !c.loading && !c.error) refreshConn(ctx, false);
    if (!store.templates.list && !store.templates.loading && !store.templates.error) refreshTemplates(ctx, false);

    var wrap = el("div", "pbme");
    wrap.appendChild(el("div", "pbme-profile",
      '<span class="pbme-avatar" aria-hidden="true">我</span>' +
      '<span><h2>我的空间</h2><span class="pbme-meta">Potbot · 本地内核交互层</span></span>'));
    var fb = feedbackNode(store, "me"); if (fb) wrap.appendChild(fb);

    // ---- 连接与密钥状态（真实）----
    wrap.appendChild(sectionTitle("连接与密钥状态"));
    if (c.loading) {
      wrap.appendChild(loadingLine(c.health ? "正在读取运行实例身份…" : "正在读取服务健康状态…"));
    }
    if (c.error && !c.health && !c.identity) {
      wrap.appendChild(stateBox("读取连接状态失败", c.error, "fail"));
      wrap.appendChild(actions([button("重试", "me.refresh-conn", "secondary")]));
    } else {
      var health = c.health, ident = c.identity;
      var ready = health ? (health.ready === true) : null;
      wrap.appendChild(card([
        row("服务连接", ready == null ? "未知" : (ready ? "已就绪" : "未就绪"),
          ready == null ? "muted" : (ready ? "ok" : "danger"),
          health ? ("buildId " + (health.buildId || "—")) : (c.error ? c.error : "尚未读取")),
        row("模型", ident ? (ident.model || "未配置") : (health && health.modelConfigured ? "已配置" : "未知"),
          ident ? "ok" : "muted",
          ident ? ("provider " + (ident.provider || "—")) : "尚未读取运行实例身份"),
        row("模型密钥", health == null ? "未知" : (health.modelConfigured ? "已配置（仅状态）" : "未配置"),
          health == null ? "muted" : (health.modelConfigured ? "ok" : "warn"),
          "本页只显示是否配置，不显示任何密钥值；密钥不进入普通页面或日志"),
        row("模型连通", health == null ? "未知" : (health.modelVerified ? "已实测" : "未实测"),
          health == null ? "muted" : (health.modelVerified ? "ok" : "warn"),
          "「已实测」来自真实调用账本；未实测不冒充可用")
      ]));
      if (ident) {
        wrap.appendChild(card([
          row("运行实例", ident.runId || "—", "muted", "runId（由运行目录派生）"),
          row("进程启动", ident.bootId || "—", "muted", "bootId（每次启动唯一）"),
          row("监听", (ident.bind || "?") + ":" + (ident.port == null ? "?" : ident.port), "muted",
            "电脑端本机回环地址，仅本机可访问")
        ]));
      }
      wrap.appendChild(actions([button("刷新连接状态", "me.refresh-conn", "secondary")]));
    }
    wrap.appendChild(el("p", "pbme-note",
      "密钥只以「是否配置」呈现；本页没有、也不接受任何密钥明文输入框。"));

    // ---- 模版与记忆 ----
    wrap.appendChild(sectionTitle("模版与记忆"));
    var tplCount = store.templates.counts ? (store.templates.counts.business_templates + " 个模板") : "点开查看";
    var memCount = store.memory.convs ? (memEntryCount(store.memory) + " 条") : "点开查看";
    wrap.appendChild(card([
      navRow("模版", tplCount, "真实清单：版本 / 能力 / 五态（安装·启用·授权·依赖·实测）", "go:templates"),
      navRow("记忆", memCount, "按会话隔离；分四类：会话消息 / 任务事实 / 用户偏好 / 模板经验", "go:memory")
    ]));

    // ---- 预算与存储 ----
    wrap.appendChild(sectionTitle("预算与存储"));
    wrap.appendChild(card([
      row("额度", "未知（非真实用量）", "muted", "尚未接入真实计费；不用 0 冒充真实花费"),
      row("存储", "未知（未测量）", "warn", "存储用量未测量；未测量不用 0 冒充空")
    ]));
    wrap.appendChild(el("p", "pbme-note", "额度展示用户可理解的费用/次数/时长及来源；用尽后如实报部分结果，不暗增费用。"));

    // ---- 权限与通知（未核实：不用假状态）----
    wrap.appendChild(sectionTitle("权限与通知"));
    wrap.appendChild(card([
      row("权限状态", "未核实", "muted", "本页未读取设备权限；须在「系统设置 → 应用 → 权限」核实"),
      row("通知与提醒", "未核实", "muted", "通知权限未在本页读取；不可用时不能冒充已开启")
    ]));
    wrap.appendChild(actions([button("管理权限与通知", "go:permissions", "secondary")]));

    // ---- 诊断（脱敏，取自真实 health/identity）----
    wrap.appendChild(sectionTitle("诊断（脱敏）"));
    var diagSrc = diagSource(c);
    var diag = redactObject(diagSrc.value);
    wrap.appendChild(card([
      row("应用版本", (c.health && c.health.buildId) || "未读取", "muted", "来自 GET /health 的 buildId"),
      row("诊断导出", diag.clean ? "无敏感项" : "已脱敏", diag.clean ? "ok" : "warn",
        "替换 " + diag.redactedFields + " 处" + (diag.redactedKinds.length ? "（" + diag.redactedKinds.join(", ") + "）" : ""))
    ]));
    wrap.appendChild(actions([
      button(store.meShowDiag ? "收起脱敏预览" : "预览脱敏诊断", "me.toggle-diag", "secondary",
        !diagSrc.available, diagSrc.available ? "" : "尚未读取到身份/健康信息")
    ]));
    if (store.meShowDiag && diagSrc.available) {
      wrap.appendChild(el("div", "pbme-pre", esc(JSON.stringify(diag.value, null, 2))));
      wrap.appendChild(el("p", "pbme-note", "导出内容默认脱敏，密钥/手机号/地址/邮箱/路径替换为 [redacted:<kind>]；凭证不进入普通页面、分享文案或日志。"));
    } else if (store.meShowDiag) {
      wrap.appendChild(stateBox("暂无可脱敏内容", "尚未读取到 /health 与 /api/identity 的真实响应。", ""));
    }

    wrap.appendChild(el("p", "pbme-foot", bridgeFooter(ctx)));
    root.appendChild(wrap);
  }

  function memEntryCount(m) {
    var n = 0;
    for (var k in m.byConv) {
      var rec = m.byConv[k];
      if (rec && rec.ok && rec.entries) n += rec.entries.length;
    }
    return n;
  }
  function diagSource(c) {
    if (!c.identity && !c.health) return { available: false, value: {} };
    var ident = c.identity || {};
    var health = c.health || {};
    return {
      available: true,
      value: {
        buildId: health.buildId || ident.buildId || null,
        bootId: health.bootId || ident.bootId || null,
        runId: ident.runId || null,
        endpoint: ident.bind && ident.port ? (ident.bind + ":" + ident.port) : null,
        provider: ident.provider || null,
        model: ident.model || null,
        modelConfigured: health.modelConfigured === true,
        modelVerified: health.modelVerified === true,
        repoRoot: ident.repoRoot || null,
        kernelStorePath: ident.kernelStorePath || null,
        conversationDir: ident.conversationDir || null
      }
    };
  }
  function bridgeFooter(ctx) {
    return bridgeOk(ctx)
      ? "已连接处理服务：本页数据来自真实的本地后端。"
      : "本地服务通道未就绪：本页显示的是真实错误，未调用模型、未写文件、未发起外部动作。";
  }

  // =========================================================================
  // 模版目录（真实清单 GET /api/plugins）
  // =========================================================================
  function refreshTemplates(ctx, force) {
    var store = getStore(ctx), t = store.templates;
    if (t.loading) return;
    if (!force && t.list) return;
    t.loading = true; t.error = null;
    repaintTplScreens(ctx);
    apiGet(ctx, "/api/plugins").then(function (res) {
      /* 本加载由「我的」或「模版」屏任一发起，结果与屏无关：先落数据，再刷新当前所在屏。 */
      t.loading = false;
      if (!res.ok) { t.error = errText(res); repaintTplScreens(ctx); return; }
      t.list = (res.data && res.data.plugins) || [];
      t.counts = (res.data && res.data.counts) || { business_templates: 0, base_roles: 0, total: t.list.length };
      repaintTplScreens(ctx);
    });
  }
  function repaintTplScreens(ctx) {
    var k = ctx && ctx.state && ctx.state.key;
    if (k === "templates") repaint(ctx, "templates");
    else if (k === "me") repaint(ctx, "me");
  }
  function loadTemplateDetail(ctx, id) {
    var store = getStore(ctx), t = store.templates;
    if (t.details[id] || t.busy === id) return;
    t.busy = id; t.feedback = null;
    repaint(ctx, "templates");
    apiGet(ctx, "/api/plugins/" + encodeURIComponent(id)).then(function (res) {
      t.busy = null;
      if (!res.ok) { setFeedback(store, "templates", "读取 " + id + " 详情失败：" + errText(res), "danger"); }
      else t.details[id] = res.data;
      repaint(ctx, "templates");
    });
  }
  function pluginAction(ctx, id, action) {
    var store = getStore(ctx), t = store.templates;
    if (t.busy) return;
    t.busy = id; t.feedback = null;
    repaint(ctx, "templates");
    var path = "/api/plugins/" + encodeURIComponent(id) + "/" + action;
    var body = action === "uninstall" ? {} : {};
    apiPost(ctx, path, body).then(function (res) {
      t.busy = null;
      if (res.ok) {
        var note = (res.data && res.data.note) || "";
        setFeedback(store, "templates", actionLabel(action) + "成功：" + (note || "后端已返回回执。"), "");
        delete t.details[id];
        t.list = null;   // 强制重取清单，五态以真实回包为准
        refreshTemplates(ctx, true);
      } else {
        var d = res.data || {};
        var extra = d.blocking_reasons ? ("：" + d.blocking_reasons.join("；")) : "";
        setFeedback(store, "templates", actionLabel(action) + "未完成（" + errText(res) + "）" + extra, "danger");
        repaint(ctx, "templates");
      }
    });
  }
  function actionLabel(a) {
    return { install: "安装", enable: "启用", disable: "停用", authorize: "授权", revoke: "撤权",
      uninstall: "卸载", "uninstall/plan": "卸载预检" }[a] || a;
  }

  function renderTemplates(root, ctx) {
    begin(root, ctx, "templates");
    var store = getStore(ctx), t = store.templates;
    if (!t.list && !t.loading && !t.error) refreshTemplates(ctx, false);

    var wrap = el("div", "pbme");
    wrap.appendChild(el("div", "pbme-top", [
      button("‹ 返回", "back", "secondary"),
      el("span", "pbme-head", "模版")
    ]));
    var fb = feedbackNode(store, "templates"); if (fb) wrap.appendChild(fb);
    wrap.appendChild(el("p", "pbme-note",
      "「已安装 / 已启用 / 已授权 / 依赖就绪 / 实测支持」五个状态分别展示；未就绪给真实原因与解锁动作。"));

    if (t.loading) {
      wrap.appendChild(loadingLine("正在读取真实插件清单…"));
    } else if (t.error) {
      wrap.appendChild(stateBox("无法读取模板清单", t.error, "fail"));
      wrap.appendChild(actions([button("重试", "tpl.refresh", "secondary")]));
    } else if (t.list) {
      var templates = t.list.filter(function (p) { return p.kind === "business_template"; });
      var roles = t.list.filter(function (p) { return p.kind === "base_role"; });
      if (t.counts) {
        wrap.appendChild(el("p", "pbme-meta",
          "真实清单：业务模板 " + t.counts.business_templates + " 个 · 基础角色 " + t.counts.base_roles +
          " 个（来自 GET /api/plugins）"));
      }
      wrap.appendChild(sectionTitle("业务模板"));
      if (!templates.length) wrap.appendChild(stateBox("没有业务模板", "后端清单里没有 kind=business_template 的插件。", ""));
      templates.forEach(function (p) { wrap.appendChild(pluginCard(ctx, p)); });
      if (roles.length) {
        wrap.appendChild(sectionTitle("基础角色"));
        roles.forEach(function (p) { wrap.appendChild(pluginCard(ctx, p)); });
      }
      wrap.appendChild(actions([button("刷新清单", "tpl.refresh", "secondary", !!t.busy, t.busy ? "正在处理中" : "")]));
    }
    wrap.appendChild(el("p", "pbme-foot", bridgeFooter(ctx)));
    root.appendChild(wrap);
  }

  var STATE_LABELS = {
    installed: "已安装", enabled: "已启用", authorized: "已授权",
    dependencies_ready: "依赖就绪", actually_supported: "实测支持"
  };
  function tplStateChips(p) {
    var fs = (p.five_state && p.five_state.states) || {};
    var list = [];
    ["installed", "enabled", "authorized", "dependencies_ready", "actually_supported"].forEach(function (key) {
      var v = fs[key] === true;
      list.push({ text: STATE_LABELS[key], tone: v ? "on" : (key === "actually_supported" ? "warn" : "") });
    });
    if (p.is_stub) list.push({ text: "stub 实现", tone: "danger" });
    return chips(list);
  }

  function pluginCard(ctx, p) {
    var store = getStore(ctx), t = store.templates;
    var expanded = t.expanded === p.plugin_id;
    var c = el("div", "pbme-card" + (expanded ? " open" : ""));
    c.setAttribute("data-tpl", p.plugin_id);

    var head = el("button", "pbme-row", null, {
      type: "button", "data-act": "tpl.toggle", "data-id": p.plugin_id,
      "aria-expanded": expanded ? "true" : "false"
    });
    head.appendChild(el("span", "pbme-rmain",
      '<span class="pbme-rtitle">' + esc(p.display_name || p.plugin_id) + "</span>" +
      '<span class="pbme-rsub">' + esc(p.plugin_id) + " · v" + esc(p.version) + " · " +
        esc(p.implementation === "real" ? "真实实现" : "stub 实现") + "</span>"));
    head.appendChild(el("span", "pbme-chev", expanded ? "⌄" : "›"));
    c.appendChild(head);
    c.appendChild(tplStateChips(p));

    if (expanded) {
      var det = t.details[p.plugin_id];
      if (t.busy === p.plugin_id) {
        c.appendChild(loadingLine("正在读取 " + p.plugin_id + " 详情…"));
      } else if (!det) {
        c.appendChild(el("p", "pbme-note", "详情尚未读取。"));
        c.appendChild(actions([button("读取详情", "tpl.detail", "secondary", false, "", { id: p.plugin_id })]));
      } else {
        c.appendChild(pluginDetail(ctx, p, det));
      }
    }
    return c;
  }

  function pluginDetail(ctx, p, det) {
    var store = getStore(ctx), t = store.templates;
    var wrap = el("div");
    var inv = det.inventory || {};
    var five = det.five_state || {};

    // 未就绪原因
    if (five.not_ready_reasons && five.not_ready_reasons.length) {
      var rw = el("div");
      five.not_ready_reasons.forEach(function (r) {
        rw.appendChild(el("div", "pbme-feedback warn", "<b>未就绪</b> · " + esc(r)));
      });
      wrap.appendChild(rw);
    } else if (five.ready) {
      wrap.appendChild(el("div", "pbme-feedback", "五态均就绪。"));
    }
    // 解锁动作
    if (five.unlock_actions && five.unlock_actions.length) {
      var uw = el("div");
      uw.appendChild(el("div", "pbme-sec", "解锁动作"));
      five.unlock_actions.forEach(function (u) {
        uw.appendChild(el("div", "pbme-kv",
          "<b>" + esc(STATE_LABELS[u.state] || u.state) + "</b><span>" + esc(u.action) + " · " + esc(u.reason) + "</span>"));
      });
      wrap.appendChild(uw);
    }

    var det2 = el("div");
    det2.appendChild(kv("清单版本", "v" + (inv.version || p.version)));
    det2.appendChild(kv("内核兼容", inv.kernel_compatibility ?
      (inv.kernel_compatibility.min_version + " ~ " + (inv.kernel_compatibility.max_version || "不限")) : "—"));
    det2.appendChild(kv("安装来源", inv.install_source_kind || "—"));
    det2.appendChild(kv("数据范围", inv.data_scope ? (inv.data_scope.level + "：" + inv.data_scope.detail) : "—"));
    det2.appendChild(kv("经验策略", inv.experience ? (inv.experience.strategy + "：" + inv.experience.detail) : "—"));
    det2.appendChild(kv("产出格式", (inv.produces_file_formats && inv.produces_file_formats.length) ? inv.produces_file_formats.join("、") : "—"));
    det2.appendChild(kv("读取格式", (inv.consumes_formats && inv.consumes_formats.length) ? inv.consumes_formats.join("、") : "—"));
    det2.appendChild(kv("权限", (inv.permission_ids && inv.permission_ids.length) ? inv.permission_ids.join("、") : "—"));
    det2.appendChild(kv("必需适配器", (inv.required_adapter_ids && inv.required_adapter_ids.length) ? inv.required_adapter_ids.join("、") : "（无）"));
    det2.appendChild(kv("指令条数", inv.instruction_count == null ? "—" : String(inv.instruction_count)));
    if (inv.is_stub) det2.appendChild(kv("stub 原因", inv.stub_reason || "未给出"));
    wrap.appendChild(det2);

    // 能力清单（标签，不倒出指令全文）
    if (inv.capabilities && inv.capabilities.length) {
      wrap.appendChild(el("div", "pbme-sec", "能力（标签）"));
      var cw = el("div", "pbme-chips");
      inv.capabilities.forEach(function (cap) { cw.appendChild(el("span", "pbme-chip", esc(cap.label))); });
      wrap.appendChild(cw);
    }

    // 依赖明细
    if (five.dependencies && five.dependencies.length) {
      wrap.appendChild(el("div", "pbme-sec", "依赖明细"));
      five.dependencies.forEach(function (d) {
        wrap.appendChild(el("div", "pbme-kv",
          "<b>" + (d.ready ? "就绪" : "缺失") + "</b><span>" + esc(d.adapter_id) + (d.required ? "（必需）" : "（可选）") + "</span>"));
      });
    }

    // 操作按钮
    var fs = five.states || {};
    var acts = [];
    acts.push(button("安装", "tpl.act", "secondary", fs.installed === true, fs.installed ? "已安装" : "", { id: p.plugin_id, action: "install" }));
    acts.push(button(fs.enabled ? "停用" : "启用", "tpl.act", "secondary", fs.installed !== true,
      fs.installed ? "" : "需先安装", { id: p.plugin_id, action: fs.enabled ? "disable" : "enable" }));
    acts.push(button(fs.authorized ? "撤权" : "授权", "tpl.act", "secondary", fs.installed !== true,
      fs.installed ? "" : "需先安装", { id: p.plugin_id, action: fs.authorized ? "revoke" : "authorize" }));
    acts.push(button("卸载", "tpl.uninstall", "danger", fs.installed !== true,
      fs.installed ? "卸载前须声明活动任务与产出的处置范围" : "未安装", { id: p.plugin_id }));
    wrap.appendChild(actions(acts));
    wrap.appendChild(el("p", "pbme-note",
      "写操作会真实提交到本地后端（安装 ≠ 启用 ≠ 授权，分开发生）；失败时按后端原话如实显示。"));
    return wrap;
  }

  // =========================================================================
  // 记忆检索（真实：GET /api/memory/status + /api/conversations + /api/memory/entries）
  // =========================================================================
  function refreshMemory(ctx, force) {
    var store = getStore(ctx), m = store.memory;
    if (m.loading) return;
    if (!force && m.convs) return;
    m.loading = true; m.error = null; m.progress = "正在读取记忆就绪状态…";
    m.convs = null; m.byConv = {};
    repaint(ctx, "memory");

    apiGet(ctx, "/api/memory/status").then(function (st) {
      if (!st.ok) { m.loading = false; m.error = errText(st); repaint(ctx, "memory"); return null; }
      m.status = st.data;
      if (st.data && st.data.ready === false) {
        m.loading = false; m.ready = false; m.reason = st.data.reason || "";
        repaint(ctx, "memory"); return null;
      }
      m.ready = true;
      m.progress = "正在读取会话列表…";
      repaint(ctx, "memory");
      return delay(0);
    }).then(function (go) {
      if (go === null) return null;
      return apiGet(ctx, "/api/conversations");
    }).then(function (list) {
      if (list == null) return;
      if (!list.ok) { m.loading = false; m.error = errText(list); repaint(ctx, "memory"); return; }
      var convs = (list.data && list.data.conversations) || [];
      convs = convs.slice().sort(function (a, b) {
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      }).slice(0, 8);
      m.convs = convs;
      if (!convs.length) { m.loading = false; repaint(ctx, "memory"); return; }
      var i = 0;
      function step() {
        if (i >= convs.length) { m.loading = false; m.progress = ""; repaint(ctx, "memory"); return; }
        var conv = convs[i];
        var owner = ownerForConversation(conv.conversationId);
        m.progress = "正在读取会话 " + (i + 1) + "/" + convs.length + " 的记忆…";
        repaint(ctx, "memory");
        if (!owner) {
          m.byConv[conv.conversationId] = { ok: false, conv: conv, owner: "",
            error: "无法从会话 id 派生主体（非 ASCII 会话 id）。" };
          i += 1; setTimeout(step, 0); return;
        }
        apiGet(ctx, "/api/memory/entries?owner_id=" + encodeURIComponent(owner) +
          "&include_disabled=true&include_rejected=true&limit=50").then(function (res) {
          if (res.ok) {
            m.byConv[conv.conversationId] = {
              ok: true, conv: conv, owner: owner, status: res.data.status,
              entries: res.data.entries || [], isolation: res.data.isolation, detail: res.data.detail
            };
          } else {
            m.byConv[conv.conversationId] = { ok: false, conv: conv, owner: owner, error: errText(res) };
          }
          i += 1;
          setTimeout(step, 0);
        });
      }
      step();
    });
  }

  function filteredEntries(store) {
    var out = [];
    for (var cid in store.memory.byConv) {
      var rec = store.memory.byConv[cid];
      if (!rec || !rec.ok) continue;
      rec.entries.forEach(function (e) { out.push({ entry: e, conv: rec.conv, owner: rec.owner }); });
    }
    var q = (store.memory.query || "").trim().toLowerCase();
    var f = store.memory.filter;
    return out.filter(function (x) {
      var e = x.entry;
      if (f !== "all" && e.kind !== f) return false;
      if (q) {
        var hay = (e.text || "") + "\n" + (e.source && e.source.detail ? e.source.detail : "");
        if (hay.toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function renderMemory(root, ctx) {
    begin(root, ctx, "memory");
    var store = getStore(ctx), m = store.memory;
    if (!m.convs && !m.loading && !m.error && m.ready !== false) refreshMemory(ctx, false);

    var wrap = el("div", "pbme");
    wrap.appendChild(el("div", "pbme-top", [
      button("‹ 返回", "back", "secondary"),
      el("span", "pbme-head", "记忆")
    ]));
    var fb = feedbackNode(store, "memory"); if (fb) wrap.appendChild(fb);
    wrap.appendChild(el("p", "pbme-note",
      "记忆按会话隔离（一个会话 = 一个记忆主体）；来源、范围、确认态、版本均可见。"));

    // 检索框与筛选（仅在有可查数据时给出）
    if (m.convs && m.convs.length) {
      var search = el("label", "pbme-search");
      search.appendChild(el("span", "pbme-sr", "搜索记忆"));
      var input = el("input", null, null, {
        type: "search", placeholder: "搜索记忆正文与来源", "aria-label": "搜索记忆", value: m.query || "" });
      input.setAttribute("data-role", "mem-search");
      search.appendChild(input);
      wrap.appendChild(search);

      var filters = el("div", "pbme-filters");
      MEMORY_FILTERS.forEach(function (f) {
        filters.appendChild(el("button", "pbme-filter", esc(f.label), {
          type: "button", "data-act": "mem.filter", "data-value": f.id,
          "aria-pressed": (m.filter === f.id) ? "true" : "false"
        }));
      });
      wrap.appendChild(filters);
    }

    // 加载 / 错误 / 未就绪 / 空
    if (m.loading) {
      wrap.appendChild(loadingLine(m.progress || "正在读取记忆…"));
    } else if (m.error) {
      wrap.appendChild(stateBox("读取记忆失败", m.error, "fail"));
      wrap.appendChild(actions([button("重试", "mem.refresh", "secondary")]));
    } else if (m.ready === false) {
      wrap.appendChild(stateBox("记忆未就绪", m.reason || "后端报告记忆持久端口未就绪。", "warn"));
      if (m.status && m.status.unlock && m.status.unlock.length) {
        wrap.appendChild(card(m.status.unlock.map(function (u) { return kv("解锁", u); })));
      }
      wrap.appendChild(actions([button("重试", "mem.refresh", "secondary")]));
    } else if (m.convs && !m.convs.length) {
      wrap.appendChild(stateBox("暂无会话", "后端还没有任何会话，因此没有可读取的记忆。先在对话里说一句话，记忆会在真实回执后出现。", ""));
      wrap.appendChild(actions([button("刷新", "mem.refresh", "secondary")]));
    } else if (m.convs) {
      var rows = filteredEntries(store);
      if (!rows.length) {
        var anyLoaded = memEntryCount(m);
        wrap.appendChild(stateBox("没有匹配的记忆",
          anyLoaded === 0 ? "已读取的会话都还没有记忆条目（查不到就是查不到，不编造）。"
                          : "当前筛选/关键词下没有匹配条目，换个条件再试。", ""));
      } else {
        // 按会话分组
        var groupOrder = m.convs.map(function (c) { return c.conversationId; });
        groupOrder.forEach(function (cid) {
          var rec = m.byConv[cid];
          if (!rec || !rec.ok) return;
          var mine = rows.filter(function (x) { return x.conv.conversationId === cid; });
          if (!mine.length) return;
          var g = el("div", "pbme-group");
          g.appendChild(el("div", "pbme-meta",
            "会话「" + (rec.conv.name || rec.conv.conversationId) + "」 · 可见 " + rec.entries.length +
            " 条" + (rec.isolation && rec.isolation.foreign_excluded != null ?
              " · 隔离排除他主体 " + rec.isolation.foreign_excluded + " 条" : "")));
          mine.forEach(function (x) { g.appendChild(memoryCard(ctx, x.entry, rec)); });
          wrap.appendChild(g);
        });
      }
      // 失败的会话如实单列
      var failed = [];
      for (var cid2 in m.byConv) { if (m.byConv[cid2] && !m.byConv[cid2].ok) failed.push(m.byConv[cid2]); }
      if (failed.length) {
        wrap.appendChild(sectionTitle("未能读取的会话"));
        failed.forEach(function (rec) {
          wrap.appendChild(el("div", "pbme-feedback danger",
            "<b>" + esc(rec.conv.name || rec.conv.conversationId) + "</b> · " + esc(rec.error)));
        });
      }
      wrap.appendChild(actions([button("刷新记忆", "mem.refresh", "secondary", !!m.busy, m.busy ? "正在处理中" : "")]));
    }

    wrap.appendChild(el("p", "pbme-foot",
      "记忆分四类：会话消息 / 任务事实 / 用户偏好 / 模板经验；任务条件不自动成为全局偏好。" +
      " 修改 / 停用 / 忘记会真实提交到本地后端，未获回执前不显示为已生效。" + " " + bridgeFooter(ctx)));
    root.appendChild(wrap);
  }

  function memoryCard(ctx, m, rec) {
    var store = getStore(ctx);
    var expanded = store.memory.openId === m.memory_id;
    var c = el("div", "pbme-card" + (expanded || store.memory.editId === m.memory_id ? " open" : ""));
    c.setAttribute("data-mem", m.memory_id);

    var head = el("button", "pbme-row", null, {
      type: "button", "data-act": "mem.toggle", "data-id": m.memory_id, "data-owner": rec.owner,
      "aria-expanded": expanded ? "true" : "false"
    });
    var title = m.text.length > 60 ? m.text.slice(0, 60) + "…" : m.text;
    head.appendChild(el("span", "pbme-rmain",
      '<span class="pbme-rtitle">' + esc(title) + "</span>" +
      '<span class="pbme-rsub">' + esc(kindLabel(m.kind)) + " · " + esc(scopeLabel(m.scope)) +
        " · 来源：" + esc(SOURCE_LABELS[(m.source && m.source.kind) || ""] || (m.source && m.source.kind) || "—") + "</span>"));
    head.appendChild(el("span", "pbme-rval " + (m.status === "active" ? "ok" : "muted"), esc(STATUS_LABELS[m.status] || m.status)));
    c.appendChild(head);

    c.appendChild(chips([
      { text: CONFIRM_LABELS[m.confirmation] || m.confirmation,
        tone: m.confirmation === "confirmed" ? "on" : m.confirmation === "rejected" ? "danger" : "warn" },
      { text: STATUS_LABELS[m.status] || m.status, tone: m.status === "active" ? "" : "warn" },
      { text: "v" + m.version, tone: "" },
      { text: injectable(m) ? "会进入注入" : "不进入注入", tone: injectable(m) ? "" : "warn" }
    ]));

    if (expanded) {
      var det = el("div");
      det.appendChild(kv("种类", kindLabel(m.kind)));
      det.appendChild(kv("适用范围", scopeLabel(m.scope)));
      det.appendChild(kv("来源", sourceLabel(m.source)));
      det.appendChild(kv("确认状态", CONFIRM_LABELS[m.confirmation] || m.confirmation));
      det.appendChild(kv("状态", STATUS_LABELS[m.status] || m.status));
      det.appendChild(kv("版本", "v" + m.version + "（乐观并发：编辑须带 expectedVersion）"));
      det.appendChild(kv("更新时间", "逻辑时钟 #" + m.updated_at + "（内核 LogicalTime，不换算墙钟）"));
      det.appendChild(kv("主体", rec.owner));

      if (store.memory.editId === m.memory_id) {
        var edit = el("div", "pbme-edit");
        edit.appendChild(el("label", null, "编辑正文（身份字段 kind / scope / source 不可改）"));
        var ta = el("textarea", null, null, { "aria-label": "编辑记忆正文", maxlength: "200",
          "data-role": "mem-edit", "data-id": m.memory_id });
        ta.value = m.text;
        edit.appendChild(ta);
        edit.appendChild(actions([
          button("保存", "mem.save", "primary", !!store.memory.busy, "", { id: m.memory_id, owner: rec.owner }),
          button("取消", "mem.cancel-edit", "secondary", false, "", { id: m.memory_id })
        ]));
        det.appendChild(edit);
      }
      if (store.memory.forgetId === m.memory_id) {
        det.appendChild(el("div", "pbme-feedback warn",
          "忘记是终态移除（不可恢复），会真实提交到本地后端；未获回执前不显示为已忘记。"));
      }
      c.appendChild(det);

      if (store.memory.busy === m.memory_id) {
        c.appendChild(loadingLine("正在提交到本地后端…"));
      } else {
        var acts = [];
        acts.push(button("编辑", "mem.edit", "secondary", m.status === "deleted", "已删除不可编辑", { id: m.memory_id }));
        acts.push(button("停用", "mem.toggle-status", "secondary",
          m.status !== "active",
          m.status === "active" ? "停用后保存内容，不再进入注入" : "后端未提供重新启用入口（不静默改写状态）",
          { id: m.memory_id, owner: rec.owner }));
        if (store.memory.forgetId === m.memory_id) {
          acts.push(button("确认忘记", "mem.forget-confirm", "danger", false, "终态移除，不可恢复",
            { id: m.memory_id, owner: rec.owner }));
          acts.push(button("取消", "mem.cancel-forget", "secondary", false, "", { id: m.memory_id }));
        } else if (m.status !== "deleted") {
          acts.push(button("忘记…", "mem.forget", "danger", false, "终态移除，不可恢复", { id: m.memory_id }));
        }
        c.appendChild(actions(acts));
      }
    }
    return c;
  }

  function findEntry(ctx, id) {
    var m = getStore(ctx).memory;
    for (var cid in m.byConv) {
      var rec = m.byConv[cid];
      if (!rec || !rec.ok) continue;
      for (var i = 0; i < rec.entries.length; i++) {
        if (rec.entries[i].memory_id === id) return { entry: rec.entries[i], rec: rec };
      }
    }
    return null;
  }
  function memoryAction(ctx, id, act, owner) {
    var store = getStore(ctx), m = store.memory;
    var found = findEntry(ctx, id);
    var entry = found ? found.entry : null;
    var own = owner || (found ? found.rec.owner : "");
    var body;
    if (act === "disable") body = { owner_id: own, action: "disable" };
    else if (act === "modify") {
      var ta = document.querySelector('.pbme textarea[data-role="mem-edit"][data-id="' + cssEsc(id) + '"]');
      var val = ta ? String(ta.value || "").trim() : "";
      if (!val) { setFeedback(store, "memory", "正文不能为空。", "danger"); repaint(ctx, "memory"); return; }
      body = { owner_id: own, action: "modify", patch: { text: val } };
    } else if (act === "forget") body = { owner_id: own, action: "forget" };
    else return;

    m.busy = id;
    repaint(ctx, "memory");
    apiPost(ctx, "/api/memory/entries/" + encodeURIComponent(id), body).then(function (res) {
      m.busy = null;
      if (res.ok) {
        var d = res.data || {};
        var cascade = d.cascade && d.cascade.invalidated ? d.cascade.invalidated.length : 0;
        setFeedback(store, "memory",
          (act === "modify" ? "已保存正文" : act === "disable" ? "已停用" : "已忘记") +
          "（后端回执）" + (cascade ? " · 联动失效 " + cascade + " 条" : "") +
          (d.persisted === true ? " · 已落盘" : ""), "");
        m.editId = null; m.forgetId = null; m.openId = null;
        refreshMemory(ctx, true);   // 以真实回包为准重取
      } else {
        setFeedback(store, "memory", "操作未完成：" + errText(res), "danger");
        repaint(ctx, "memory");
      }
    });
  }
  function cssEsc(v) { return String(v).replace(/["\\]/g, "\\$&"); }

  // =========================================================================
  // 事件绑定
  // =========================================================================
  function begin(root, ctx, screenKey) {
    ensureStyle();
    clear(root);
    if (root.className && root.className.indexOf("pbme-root") < 0) root.className += " pbme-root";
    else if (!root.className) root.className = "pbme-root";
    root.__pbme_ctx = ctx;
    root.__pbme_screen = screenKey;
    if (!root.__pbme_bound) {
      root.__pbme_bound = true;
      root.addEventListener("click", onRootClick);
      root.addEventListener("input", onRootInput);
    }
  }
  function repaint(ctx, screenKey) {
    if (ctx && ctx.state && ctx.state.key !== screenKey) return;   // 用户已切走：不覆盖他屏
    var root = document.querySelector(".pbme-root") || document.getElementById("pb-root") || document.body;
    if (!root) return;
    if (screenKey === "templates") renderTemplates(root, ctx);
    else if (screenKey === "memory") renderMemory(root, ctx);
    else renderMe(root, ctx);
  }

  function onRootClick(e) {
    var root = e.currentTarget;
    var ctx = root.__pbme_ctx;
    if (!ctx) return;
    if (ctx.state && ctx.state.key !== root.__pbme_screen) return;   // 屏已切换：本屏不接管
    var node = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!node) return;
    var act = node.getAttribute("data-act");
    var id = node.getAttribute("data-id");
    var store = getStore(ctx);

    if (act === "back") { if (ctx.navigate) ctx.navigate("me"); return; }
    if (act === "go:templates") { if (ctx.navigate) ctx.navigate("templates"); return; }
    if (act === "go:memory") { if (ctx.navigate) ctx.navigate("memory"); return; }
    if (act === "go:permissions") {
      setFeedback(store, "me", "权限详情须在系统设置核实；本页未读取设备权限，不作断言。", "warn");
      repaint(ctx, "me"); return;
    }
    if (act === "me.toggle-diag") { store.meShowDiag = !store.meShowDiag; repaint(ctx, "me"); return; }
    if (act === "me.refresh-conn") { refreshConn(ctx, true); return; }

    if (act === "tpl.refresh") { refreshTemplates(ctx, true); return; }
    if (act === "tpl.toggle") {
      var t = store.templates;
      t.expanded = t.expanded === id ? null : id;
      if (t.expanded && !t.details[id]) loadTemplateDetail(ctx, id);
      else repaint(ctx, "templates");
      return;
    }
    if (act === "tpl.detail") { loadTemplateDetail(ctx, id); return; }
    if (act === "tpl.act") { pluginAction(ctx, id, node.getAttribute("data-action")); return; }
    if (act === "tpl.uninstall") { pluginAction(ctx, id, "uninstall"); return; }

    if (act === "mem.refresh") { refreshMemory(ctx, true); return; }
    if (act === "mem.filter") { store.memory.filter = node.getAttribute("data-value"); repaint(ctx, "memory"); return; }
    if (act === "mem.toggle") {
      store.memory.openId = store.memory.openId === id ? null : id;
      if (store.memory.openId !== id) { store.memory.editId = null; store.memory.forgetId = null; }
      repaint(ctx, "memory"); return;
    }
    if (act === "mem.edit") {
      var m = store.memory;
      m.openId = id; m.editId = id; m.forgetId = null;
      setFeedback(store, "memory", "编辑仅允许修改正文；kind / scope / source / owner_id 等身份字段不可改。", "warn");
      repaint(ctx, "memory"); return;
    }
    if (act === "mem.cancel-edit") { store.memory.editId = null; setFeedback(store, "memory", "已取消编辑。", "warn"); repaint(ctx, "memory"); return; }
    if (act === "mem.save") { memoryAction(ctx, id, "modify", node.getAttribute("data-owner")); return; }
    if (act === "mem.toggle-status") { memoryAction(ctx, id, "disable", node.getAttribute("data-owner")); return; }
    if (act === "mem.forget") {
      store.memory.openId = id; store.memory.forgetId = id;
      setFeedback(store, "memory", "选择「确认忘记」后提交；未获后端回执前不显示为已忘记。", "warn");
      repaint(ctx, "memory"); return;
    }
    if (act === "mem.cancel-forget") { store.memory.forgetId = null; setFeedback(store, "memory", "已取消遗忘。", "warn"); repaint(ctx, "memory"); return; }
    if (act === "mem.forget-confirm") { memoryAction(ctx, id, "forget", node.getAttribute("data-owner")); return; }
  }

  function onRootInput(e) {
    var root = e.currentTarget;
    var ctx = root.__pbme_ctx;
    if (!ctx) return;
    if (ctx.state && ctx.state.key !== root.__pbme_screen) return;
    var store = getStore(ctx);
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var role = t.getAttribute("data-role");
    if (role === "mem-search") {
      store.memory.query = t.value;
      var rootEl = document.querySelector(".pbme-root") || document.getElementById("pb-root");
      if (rootEl) {
        var caret = t.selectionStart;
        repaint(ctx, "memory");
        var again = rootEl.querySelector('input[data-role="mem-search"]');
        if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (err) {} }
      }
    }
  }

  // =========================================================================
  // 注册
  // =========================================================================
  window.PB.screens.me = { title: "我的", render: renderMe };
  window.PB.screens.templates = { title: "模版", render: renderTemplates };
  window.PB.screens.memory = { title: "记忆", render: renderMemory };
})();
