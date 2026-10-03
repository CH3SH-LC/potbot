/* ============================================================================
 * files.js —— 「文件」屏（**真实产物列表**） window.PB.screens.files
 * ----------------------------------------------------------------------------
 * 真相来源：电脑端后端的连续对话接口，**只经宿主原生通道 window.PotbotHost**
 *   （页面侧封装 window.PB.host，见 host-api.js）。页面在 file:// 下不能 fetch。
 *
 *   GET /api/conversations                      -> { conversations:[...] }
 *   GET /api/conversations/<cid>                -> { messages:[{artifact:{...}}], currentDocument:{...} }
 *   下载：artifact.downloadPath（形如 /api/conversations/<cid>/documents/<artifactId>/download）
 *         真机保存走 window.PotbotNative.saveDocx(downloadPath, filename, sha256, byteLength)
 *
 * 注意：`/api/deliverables` **只接受 POST**（开会话的写接口，http.ts 约 1799 行），
 *   不是文件列表接口，因此本屏**不**用它列举文件；文件清单只认会话里真实回读的 artifact。
 *
 * 诚实边界（I1，不编造）：
 *   - 只有 artifact 同时具备 artifactId + filename + byteLength>0 + 合法 sha256（64 位十六进制）
 *     才标「已生成」；缺任一只能如实显示「证据不足」。
 *   - 不显示任何未来自后端的文件；没有文件就是空态。
 *   - 保存到手机无原生能力时如实说明并给出下载路径，绝不假装已保存。
 *
 * 运行环境：file:///android_asset/ui/index.html（Android WebView，经典脚本；
 *   无 import/export、无 type=module、无 fetch/XHR）。只写本文件，不触碰其它文件。
 * ========================================================================== */
(function () {
  "use strict";

  var PB = (window.PB = window.PB || {});
  PB.screens = PB.screens || {};

  /* ---------------------------------------------------------------------------
   * 0. 共享数据加载器 window.PB.convData（groups.js 先加载则此处直接复用；否则此处定义）
   * ------------------------------------------------------------------------ */
  if (!PB.convData) {
    PB.convData = (function () {
      function host() { return (PB.host && PB.host.available) ? PB.host : null; }
      function enc(s) { return encodeURIComponent(String(s)); }
      function absent() {
        return { ok: false, data: null, error: { code: "host_absent", message: "当前环境没有连接到电脑端服务，无法读取真实数据。", retryable: false } };
      }
      function fmtBytes(n) {
        var v = Number(n);
        if (!isFinite(v) || v <= 0) return "";
        if (v < 1024) return v + " B";
        if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
        return (v / 1048576).toFixed(1) + " MB";
      }
      function pad2(n) { return (n < 10 ? "0" : "") + n; }
      function when(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso || "");
        var hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
        var now = new Date();
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return "今天 " + hm;
        var y = new Date(now.getTime() - 86400000);
        if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return "昨天 " + hm;
        return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
      }
      function clock(iso) { var d = new Date(iso); if (isNaN(d.getTime())) return ""; return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
      var PHASE_LABEL = { accepted: "排队中", running: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消" };
      var STATE_LABEL = { sending: "发送中", received: "已接收", streaming: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消" };
      function phaseLabel(p) { return PHASE_LABEL[p] || (p ? String(p) : "未知"); }
      function stateLabel(s) { return STATE_LABEL[s] || (s ? String(s) : "未知"); }
      function isActivePhase(p) { return p === "accepted" || p === "running"; }
      function isTerminalPhase(p) { return p === "completed" || p === "failed" || p === "cancelled"; }
      function isDigest(s) { return typeof s === "string" && /^[0-9a-f]{64}$/i.test(s); }
      function pickActive(list) {
        if (!list || !list.length) return null;
        var copy = list.slice().sort(function (a, b) {
          var au = (a && a.updatedAt) || "", bu = (b && b.updatedAt) || "";
          if (au === bu) return 0;
          return au < bu ? 1 : -1;
        });
        for (var i = 0; i < copy.length; i++) if (copy[i] && typeof copy[i].messageCount === "number" && copy[i].messageCount > 0) return copy[i];
        return copy[0];
      }
      function listConversations() { var h = host(); return h ? h.get("/api/conversations") : Promise.resolve(absent()); }
      function getConversation(cid) { var h = host(); return h ? h.get("/api/conversations/" + enc(cid)) : Promise.resolve(absent()); }
      function getEvents(cid, cursor) {
        var h = host(); if (!h) return Promise.resolve(absent());
        var p = "/api/conversations/" + enc(cid) + "/events";
        if (cursor) p += "?cursor=" + enc(cursor);
        return h.get(p);
      }
      function cancelMessage(cid, mid) { var h = host(); return h ? h.post("/api/conversations/" + enc(cid) + "/messages/" + enc(mid) + "/cancel", {}) : Promise.resolve(absent()); }
      function retryMessage(cid, mid) { var h = host(); return h ? h.post("/api/conversations/" + enc(cid) + "/messages/" + enc(mid) + "/retry", {}) : Promise.resolve(absent()); }
      function messagesOf(conv) { return (conv && typeof conv === "object" && conv.messages) ? conv.messages : []; }
      function artifactsOf(conv) {
        var out = [], seen = {}, msgs = messagesOf(conv);
        for (var i = 0; i < msgs.length; i++) {
          var a = msgs[i] && msgs[i].artifact;
          if (a && typeof a === "object" && a.artifactId && !seen[a.artifactId]) { seen[a.artifactId] = true; out.push(a); }
        }
        var cur = conv && conv.currentDocument;
        if (cur && typeof cur === "object" && cur.artifactId && !seen[cur.artifactId]) { seen[cur.artifactId] = true; out.unshift(cur); }
        return out;
      }
      function lastUserMessage(conv) {
        var msgs = messagesOf(conv);
        for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === "user") return msgs[i];
        return null;
      }
      function activeMessage(conv) {
        var msgs = messagesOf(conv);
        for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i] && isActivePhase(msgs[i].phase)) return msgs[i];
        return null;
      }
      function lastFailedMessage(conv) {
        var msgs = messagesOf(conv);
        for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i] && (msgs[i].phase === "failed" || msgs[i].phase === "cancelled")) return msgs[i];
        return null;
      }
      function runModel(events) {
        var list = (events && events.events) || [];
        for (var i = list.length - 1; i >= 0; i--) {
          var ev = list[i];
          if (!ev || ev.kind !== "run_started" || !ev.detail) continue;
          var prov = ev.detail.provider != null ? String(ev.detail.provider) : "";
          var model = ev.detail.model != null ? String(ev.detail.model) : "";
          if (prov || model) return { provider: prov, model: model };
        }
        return null;
      }
      return {
        host: host, fmtBytes: fmtBytes, when: when, clock: clock,
        phaseLabel: phaseLabel, stateLabel: stateLabel,
        isActivePhase: isActivePhase, isTerminalPhase: isTerminalPhase, isDigest: isDigest,
        pickActive: pickActive, listConversations: listConversations, getConversation: getConversation, getEvents: getEvents,
        cancelMessage: cancelMessage, retryMessage: retryMessage,
        messagesOf: messagesOf, artifactsOf: artifactsOf,
        lastUserMessage: lastUserMessage, activeMessage: activeMessage, lastFailedMessage: lastFailedMessage, runModel: runModel
      };
    })();
  }
  var CD = PB.convData;

  /* ---------------------------------------------------------------------------
   * 0b. 样式（内联 <style>；全部限定在 .pb-files 之下）
   * ------------------------------------------------------------------------ */
  var STYLE_ID = "pbf-style";
  var CSS = [
    ".pb-files{--pf-line:#E8E4DF;--pf-surface:#FAFAF9;--pf-soft:#FFF0E2;--pf-strong:#825034;--pf-ok:#306A4B;",
    "--pf-warn:#A73729;--pf-touch:48px;--pf-r:12px;",
    "color:var(--pb-ink,#28231F);padding:0 0 calc(24px + env(safe-area-inset-bottom))}",
    ".pb-files *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}",
    ".pb-files h1{font-size:24px;line-height:32px;font-weight:600;margin:12px 0 8px}",
    ".pb-files h2{font-size:18px;line-height:26px;font-weight:600;margin:0}",
    ".pb-files h3{font-size:16px;line-height:24px;font-weight:600;margin:10px 0 4px}",
    ".pb-files p{margin:4px 0}",
    ".pb-files .pf-note{display:block;font-size:14px;line-height:20px;color:var(--pb-muted,#77716B);overflow-wrap:anywhere}",
    ".pb-files .pf-mini{display:block;font-size:12px;line-height:18px;color:var(--pb-muted,#77716B);overflow-wrap:anywhere}",
    ".pb-files .pf-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all}",
    ".pb-files .pf-honest{font-size:12px;line-height:18px;color:var(--pb-muted,#77716B);border-left:3px solid var(--pf-line);padding:2px 0 2px 10px;margin:12px 0}",
    ".pb-files .pf-banner{display:flex;flex-direction:column;gap:2px;margin:10px 0;padding:10px 12px;border-radius:12px;font-size:13px;line-height:19px;",
    "background:var(--pf-surface);border:1px solid var(--pf-line)}",
    ".pb-files .pf-banner.ok{background:#EDF6F0;border-color:#D3E7DB;color:var(--pf-ok)}",
    ".pb-files .pf-banner.warn{background:#FBEDE9;border-color:#F0D6D0;color:var(--pf-warn)}",
    ".pb-files .pf-banner-title{font-weight:600}",
    ".pb-files .pf-search{display:flex;align-items:center;gap:8px;margin:10px 0;padding:0 12px;background:var(--pf-surface);",
    "border:1px solid var(--pf-line);border-radius:var(--pf-r);min-height:var(--pf-touch)}",
    ".pb-files .pf-search input{flex:1;min-width:0;border:0;outline:0;background:none;font:inherit;font-size:16px;height:44px}",
    ".pb-files .pf-convbar{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:2px 0 6px}",
    ".pb-files .pf-filters{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}",
    ".pb-files .pf-filter{flex:none;min-height:40px;padding:0 16px;border-radius:20px;font:inherit;font-size:14px;background:var(--pf-surface);",
    "border:1px solid var(--pf-line);color:var(--pb-ink,#28231F)}",
    ".pb-files .pf-filter.on{background:var(--pf-soft);border-color:#F3DFCB;color:var(--pf-strong);font-weight:600}",
    ".pb-files .pf-date{font-size:13px;color:var(--pb-muted,#77716B);margin:16px 0 4px}",
    ".pb-files .pf-list{display:flex;flex-direction:column}",
    ".pb-files .pf-file{display:flex;align-items:center;gap:12px;min-height:60px;padding:8px 4px;width:100%;background:none;border:0;",
    "border-bottom:1px solid var(--pf-line);font:inherit;color:inherit;text-align:left;border-radius:10px}",
    ".pb-files .pf-list .pf-file:last-child{border-bottom:0}",
    ".pb-files .pf-file:active{background:var(--pf-soft)}",
    ".pb-files .pf-badge{flex:none;width:48px;height:30px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.04em;display:flex;",
    "align-items:center;justify-content:center;border:1px solid var(--pf-line);background:var(--pf-surface);color:var(--pb-muted,#77716B)}",
    ".pb-files .pf-badge.word{background:#E9F0FA;border-color:#CFE0F4;color:#2E5A8A}",
    ".pb-files .pf-badge.excel{background:#E9F6EC;border-color:#CFE8D5;color:#2F6A44}",
    ".pb-files .pf-badge.ppt{background:#FBEEDF;border-color:#F3DFCB;color:#8A5A2E}",
    ".pb-files .pf-grow{flex:1;min-width:0}",
    ".pb-files .pf-title{display:block;font-size:16px;font-weight:500;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pb-files .pf-sub{display:block;font-size:12px;line-height:18px;color:var(--pb-muted,#77716B);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pb-files .pf-chip{flex:none;font-size:12px;line-height:18px;font-weight:500;padding:2px 8px;border-radius:8px}",
    ".pb-files .pf-chip.generated{background:#EDF6F0;color:var(--pf-ok)}",
    ".pb-files .pf-chip.draft{background:var(--pf-surface);color:var(--pb-muted,#77716B);border:1px solid var(--pf-line)}",
    ".pb-files .pf-chev{color:var(--pb-muted,#77716B);flex:none;font-size:20px;padding-left:2px}",
    ".pb-files .pf-empty{padding:40px 8px;text-align:center;color:var(--pb-muted,#77716B)}",
    ".pb-files .pf-empty h2{font-size:18px;color:var(--pb-ink,#28231F);margin-bottom:6px}",
    ".pb-files .pf-back{min-height:var(--pf-touch);background:none;border:0;font:inherit;font-size:15px;color:var(--pf-strong);padding:0;display:flex;align-items:center}",
    ".pb-files .pf-filehead{display:flex;align-items:center;gap:12px;margin:8px 0 12px}",
    ".pb-files .pf-fname{font-size:20px;line-height:26px;font-weight:600;margin:0;overflow-wrap:anywhere}",
    ".pb-files .pf-kvlist{margin:8px 0}",
    ".pb-files .pf-kv{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--pf-line);font-size:15px}",
    ".pb-files .pf-kv:last-child{border-bottom:0}",
    ".pb-files .pf-kv-k{color:var(--pb-muted,#77716B);flex:none}",
    ".pb-files .pf-kv-v{text-align:right;word-break:break-word;min-width:0}",
    ".pb-files .pf-btn{min-height:var(--pf-touch);padding:0 16px;border-radius:var(--pf-r);border:0;font:inherit;font-size:15px;font-weight:500;",
    "background:none;color:var(--pb-ink,#28231F);display:inline-flex;align-items:center;justify-content:center}",
    ".pb-files .pf-btn.primary{background:var(--pb-accent,#E9A66D);color:#241A14}",
    ".pb-files .pf-btn.sec{background:#fff;border:1px solid var(--pf-line);color:var(--pb-ink,#28231F)}",
    ".pb-files .pf-btn.block{width:100%;margin:8px 0}",
    ".pb-files .pf-btn:disabled{opacity:.45}",
    ".pb-files .pf-btn:active:not(:disabled){filter:brightness(.97)}",
    ".pb-files .pf-versnote{display:block;font-size:12px;line-height:18px;margin-top:2px;overflow-wrap:anywhere}",
    ".pb-files .pf-versnote.same{color:var(--pb-muted,#77716B)}",
    ".pb-files .pf-versnote.diff{color:var(--pf-strong)}",
    ".pb-files .pf-versnote.unknown{color:var(--pb-muted,#77716B)}",
    ".pb-files .pf-chain{margin:6px 0 0;padding:0;list-style:none}",
    ".pb-files .pf-chainitem{display:flex;align-items:center;gap:10px;width:100%;min-height:var(--pf-touch);padding:8px 4px;border:0;border-bottom:1px solid var(--pf-line);",
    "background:none;font:inherit;color:inherit;text-align:left;border-radius:10px}",
    ".pb-files .pf-chainitem:last-child{border-bottom:0}",
    ".pb-files .pf-chainitem:active{background:var(--pf-soft)}",
    ".pb-files .pf-chainitem[aria-current=\"true\"]{background:var(--pf-soft)}",
    ".pb-files .pf-chainitem .pf-title{font-size:15px;white-space:normal}",
    ".pb-files .pf-verstag{flex:none;font-size:12px;line-height:18px;font-weight:600;color:var(--pf-strong);background:var(--pf-soft);",
    "border-radius:8px;padding:2px 8px}",
    ".pb-files .pf-actions{margin-top:18px;padding-top:12px;border-top:1px solid var(--pf-line)}",
    ".pb-files button:focus-visible,.pb-files input:focus-visible{outline:2px solid var(--pf-strong);outline-offset:2px}"
  ].join("");
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------------------------------------------------------------------------
   * 1. DOM 工具
   * ------------------------------------------------------------------------ */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function btn(cls, text, on) {
    var b = el("button", cls, text);
    b.type = "button";
    if (on) b.addEventListener("click", on);
    return b;
  }
  var KIND_LABEL = { word: "DOCX", excel: "XLSX", ppt: "PPTX" };
  var KIND_NAME = { word: "Word 文档", excel: "Excel 表格", ppt: "PPT 演示" };
  function kindOf(filename) {
    var m = /\.([a-z0-9]{2,5})$/i.exec(String(filename || ""));
    var e = m ? m[1].toLowerCase() : "";
    if (e === "xlsx" || e === "xls" || e === "csv") return "excel";
    if (e === "pptx" || e === "ppt") return "ppt";
    if (e === "docx" || e === "doc") return "word";
    return "word";
  }
  /** I1：有字节证据 = artifactId + filename + byteLength>0 + 合法 sha256。 */
  function evidenceOf(a) {
    return !!(a && a.artifactId && a.filename && typeof a.byteLength === "number" && a.byteLength > 0 && CD.isDigest(a.sha256));
  }

  /* ---------------------------------------------------------------------------
   * 1b. 版本链（只从真实消息 / currentDocument 里取，不虚构任何版本）
   *     后端每个版本是一条独立的产物记录（artifact_id 不同），因此：
   *       链 = 本会话消息里出现过的 artifact（按出现顺序、按 artifactId 去重）+ currentDocument
   *     变更判定只做一次等值比较：本版与前一个**同文件名**版本的 sha256 是否逐字相同。
   *       sameAsPrev === true  ⇒ 摘要一致：版本号涨了，但文件内容其实没变（如实说）
   *       sameAsPrev === false ⇒ 摘要不同：确实产生了新内容
   *       sameAsPrev === null  ⇒ 任一侧缺合法摘要：不判断
   * ------------------------------------------------------------------------ */
  function buildChain(conv) {
    var msgs = CD.messagesOf(conv);
    var list = [], byId = {}, i, e;
    for (i = 0; i < msgs.length; i++) {
      var a = msgs[i] && msgs[i].artifact;
      if (!a || typeof a !== "object" || !a.artifactId || byId[a.artifactId]) continue;
      e = { artifact: a, messageIndex: i, prev: null, sameAsPrev: null, chainIndex: 0, chainLength: 1, isNewest: false };
      byId[a.artifactId] = e;
      list.push(e);
    }
    var cur = conv && conv.currentDocument;
    if (cur && typeof cur === "object" && cur.artifactId && !byId[cur.artifactId]) {
      e = { artifact: cur, messageIndex: -1, prev: null, sameAsPrev: null, chainIndex: 0, chainLength: 1, isNewest: false };
      byId[cur.artifactId] = e;
      list.push(e);
    }
    var prevOfFile = {}, countOfFile = {};
    for (i = 0; i < list.length; i++) {
      var en = list[i];
      var k = String(en.artifact.filename || "");
      en.prev = prevOfFile[k] || null;
      if (en.prev) {
        var ps = String(en.prev.artifact.sha256 || "");
        var cs = String(en.artifact.sha256 || "");
        if (CD.isDigest(ps) && CD.isDigest(cs)) en.sameAsPrev = (ps.toLowerCase() === cs.toLowerCase());
      }
      countOfFile[k] = (countOfFile[k] || 0) + 1;
      en.chainIndex = countOfFile[k];
      prevOfFile[k] = en;
    }
    var lastOfFile = {};
    for (i = 0; i < list.length; i++) {
      var kk = String(list[i].artifact.filename || "");
      list[i].chainLength = countOfFile[kk];
      lastOfFile[kk] = list[i];
    }
    for (var key in lastOfFile) {
      if (!Object.prototype.hasOwnProperty.call(lastOfFile, key)) continue;
      lastOfFile[key].isNewest = true;
    }
    return { list: list, byId: byId };
  }
  function chainOfFile(chain, a) {
    var out = [];
    if (!chain || !a) return out;
    for (var i = 0; i < chain.list.length; i++) {
      if (String(chain.list[i].artifact.filename || "") === String(a.filename || "")) out.push(chain.list[i]);
    }
    return out;
  }
  function versionBits(a) {
    var bits = [];
    if (typeof a.editRevision === "number") bits.push("版本 r" + a.editRevision);
    if (typeof a.artifactVersion === "number") bits.push("第 " + a.artifactVersion + " 版");
    if (typeof a.taskRevision === "number" && a.taskRevision !== a.editRevision) bits.push("任务 r" + a.taskRevision);
    return bits;
  }
  function shortSha(s) { return CD.isDigest(s) ? String(s).slice(0, 8) + "…" : ""; }
  /** 变更真相文本（只在存在上一版时给）。 */
  function changeTruth(info) {
    if (!info || !info.prev) return null;
    if (info.sameAsPrev === true) {
      return { cls: "same", text: "内容与上一版相同：sha256 与上一版逐字一致（" + shortSha(info.artifact.sha256) + "），这次修订没有改变文件内容。" };
    }
    if (info.sameAsPrev === false) {
      return { cls: "diff", text: "较上一版有更新：sha256 " + shortSha(info.prev.artifact.sha256) + " → " + shortSha(info.artifact.sha256) + "。" };
    }
    return { cls: "unknown", text: "无法与上一版比对：任一侧缺少完整的 sha256，不做判断。" };
  }
  /** 列表行用的短版（完整说明在详情里）。 */
  function changeTruthShort(info) {
    if (!info || !info.prev) return null;
    if (info.sameAsPrev === true) return { cls: "same", text: "内容与上一版相同（摘要一致）" };
    if (info.sameAsPrev === false) return { cls: "diff", text: "较上一版有更新（摘要已变）" };
    return { cls: "unknown", text: "无法与上一版比对（摘要缺失）" };
  }

  /* ---------------------------------------------------------------------------
   * 2. 屏内状态
   * ------------------------------------------------------------------------ */
  var S = {
    root: null, ctx: null,
    phase: "loading",     // nohost | loading | error | empty | ready
    err: null,
    conversations: [],
    convId: null,
    conv: null,
    files: [],
    chain: null,          // {list,byId} 版本链（真实版本，见 buildChain）
    view: "list",         // list | detail
    fileId: null,
    query: "",
    kind: "all",
    notice: null,
    loading: false,
    hostTimer: null
  };

  function keyIsMine() {
    if (!S.ctx || !S.ctx.state) return true;
    var k = S.ctx.state.key;
    return !k || k === "files";
  }
  function ensureHost() {
    if (PB.host && typeof PB.host.detect === "function") { try { PB.host.detect(); } catch (e) {} }
    return !!(PB.host && PB.host.available);
  }

  /* ---- 原生保存回执：window.PotbotBridgeResult(ok, message)（与 chat.js 同一契约，链式不抢） */
  var pendingSave = null;
  (function installResultHook() {
    var prev = window.PotbotBridgeResult;
    var hook = function (ok, message) {
      if (pendingSave) {
        var cb = pendingSave; pendingSave = null;
        cb(ok === true, String(message == null ? "" : message));
      } else if (typeof prev === "function") {
        prev(ok, message);
      }
    };
    hook.__pbFiles = true;
    window.PotbotBridgeResult = hook;
  })();

  function notice(text) {
    S.notice = { text: text, at: Date.now() };
    paint();
    setTimeout(function () {
      if (S.notice && Date.now() - S.notice.at >= 2500) { S.notice = null; if (keyIsMine()) paint(); }
    }, 2600);
  }

  /* ---------------------------------------------------------------------------
   * 3. 数据加载（只经 PB.host）
   * ------------------------------------------------------------------------ */
  function render(root, ctx) {
    S.root = root;
    S.ctx = ctx || {};
    injectStyles();

    if (!ensureHost()) {
      S.phase = "nohost";
      paint();
      if (S.hostTimer) clearTimeout(S.hostTimer);
      S.hostTimer = setTimeout(function () {
        if (!keyIsMine()) return;
        if (ensureHost()) { S.phase = "loading"; render(S.root, S.ctx); }
      }, 900);
      return;
    }
    if (S.phase === "nohost") S.phase = "loading";
    paint();
    if (!S.loading) bootstrap();
  }

  function bootstrap() {
    S.loading = true;
    if (!CD.host()) { S.loading = false; S.phase = "nohost"; paint(); return; }
    CD.listConversations().then(function (res) {
      if (!keyIsMine()) { S.loading = false; return; }
      if (!res.ok) { S.err = res.error; S.phase = "error"; S.loading = false; paint(); return; }
      S.conversations = (res.data && res.data.conversations) || [];
      if (!S.conversations.length) { S.phase = "empty"; S.loading = false; paint(); return; }
      var chosen = S.convId || (S.ctx.state && S.ctx.state.convId) || null;
      if (!chosen) { var p = CD.pickActive(S.conversations); chosen = p ? p.conversationId : null; }
      S.convId = chosen;
      if (!S.convId) { S.phase = "ready"; S.files = []; S.chain = null; S.loading = false; paint(); return; }
      loadConv();
    });
  }

  function loadConv() {
    if (!S.convId) { S.loading = false; return; }
    S.loading = true;
    CD.getConversation(S.convId).then(function (res) {
      if (!keyIsMine()) { S.loading = false; return; }
      if (!res.ok) { S.err = res.error; S.phase = "error"; S.loading = false; paint(); return; }
      S.conv = res.data;
      S.files = CD.artifactsOf(res.data);
      S.chain = buildChain(res.data);
      S.err = null;
      S.phase = "ready";
      S.loading = false;
      paint();
    });
  }

  function selectConv(id) {
    S.convId = id;
    if (S.ctx && S.ctx.state) S.ctx.state.convId = id;
    S.conv = null; S.files = []; S.chain = null; S.view = "list"; S.fileId = null;
    S.phase = "loading";
    paint();
    loadConv();
  }

  function refresh() {
    S.loading = false;
    if (ensureHost()) bootstrap(); else { S.phase = "nohost"; paint(); }
  }

  /* ---------------------------------------------------------------------------
   * 4. 下载 / 保存
   * ------------------------------------------------------------------------ */
  function download(a, button) {
    if (!a || !a.downloadPath) { notice("缺少下载路径，无法保存。"); return; }
    var native = window.PotbotNative;
    if (!native || typeof native.saveDocx !== "function") {
      notice("这个环境不支持保存到手机；下载路径：" + a.downloadPath);
      return;
    }
    if (button) button.disabled = true;
    pendingSave = function (ok, message) {
      if (button) button.disabled = false;
      if (ok) notice("已保存到手机：" + (message || a.filename));
      else notice("保存未完成：" + (message || "原因未知"));
    };
    notice("正在保存到手机…");
    try {
      native.saveDocx(a.downloadPath, a.filename, a.sha256, (typeof a.byteLength === "number") ? a.byteLength : 0);
    } catch (e) {
      pendingSave = null;
      if (button) button.disabled = false;
      notice("调用手机保存失败：" + ((e && e.message) || e));
    }
  }

  /* ---------------------------------------------------------------------------
   * 5. 渲染
   * ------------------------------------------------------------------------ */
  function panel(title, body, withRefresh) {
    var box = el("div", "pf-empty");
    box.appendChild(el("h2", null, title));
    if (body) box.appendChild(el("p", "pf-note", body));
    if (withRefresh) box.appendChild(btn("pf-btn sec", "重新读取", function () { refresh(); }));
    return box;
  }
  function errorPanel(err) {
    var box = el("div", "pf-banner warn");
    box.appendChild(el("span", "pf-banner-title", "读取失败"));
    box.appendChild(el("span", null, (err && err.message) || "本地服务没有返回可用的内容。"));
    if (err && err.code) box.appendChild(el("span", "pf-mono", "错误码 " + err.code));
    box.appendChild(btn("pf-btn sec", "重新读取", function () { refresh(); }));
    return box;
  }

  function paint() {
    if (!S.root || !keyIsMine()) return;
    var root = S.root;
    root.textContent = "";
    var wrap = el("div", "pb-files");
    if (S.notice) {
      var n = el("div", "pf-banner");
      n.appendChild(el("span", "pf-banner-title", S.notice.text));
      wrap.appendChild(n);
    }

    if (S.phase === "nohost") {
      wrap.appendChild(panel("本地服务通道不可用",
        "当前环境没有连接到电脑端服务（window.PotbotHost 未注入）。文件清单只来自真实后端，未接入时不显示任何文件。", false));
      root.appendChild(wrap);
      return;
    }
    if (S.phase === "error") {
      wrap.appendChild(el("h1", null, "文件"));
      wrap.appendChild(errorPanel(S.err));
      root.appendChild(wrap);
      return;
    }
    if (S.phase === "empty") {
      wrap.appendChild(el("h1", null, "文件"));
      wrap.appendChild(panel("还没有文件", "完成一个任务后，真实产出的文件会出现在这里。", true));
      root.appendChild(wrap);
      return;
    }
    if (S.phase === "loading" && !S.conv) {
      wrap.appendChild(el("h1", null, "文件"));
      wrap.appendChild(panel("正在读取文件…", "正在从电脑端服务读取真实产物清单。", false));
      root.appendChild(wrap);
      return;
    }

    if (S.view === "detail") {
      var f = findFile(S.fileId);
      if (f) buildDetail(wrap, f);
      else S.view = "list";
    }
    if (S.view === "list") buildList(wrap);
    root.appendChild(wrap);
  }

  function findFile(id) {
    for (var i = 0; i < S.files.length; i++) if (S.files[i].artifactId === id) return S.files[i];
    /* 兜底：版本链里存在、但产物清单没并进来的引用，同样按真实引用展示。 */
    var e = S.chain && S.chain.byId[id];
    return e ? e.artifact : null;
  }

  /* ---------- 列表 ---------- */

  function buildList(wrap) {
    wrap.appendChild(el("h1", null, "文件"));

    var conv = S.conv;
    if (conv) {
      var bar = el("div", "pf-banner ok");
      bar.appendChild(el("span", "pf-banner-title", conv.name || conv.conversationId));
      bar.appendChild(el("span", null, S.files.length + " 份真实产物 · 会话 " + conv.conversationId));
      wrap.appendChild(bar);
    }

    /* 会话切换（只在有多个候选会话时出现） */
    var cands = [];
    for (var i = 0; i < S.conversations.length; i++) {
      var c = S.conversations[i];
      if (c && typeof c.messageCount === "number" && c.messageCount > 0) cands.push(c);
    }
    if (cands.length > 1) {
      var convbar = el("div", "pf-convbar");
      for (var j = 0; j < cands.length; j++) {
        (function (c) {
          var on = c.conversationId === S.convId;
          var b = btn("pf-filter" + (on ? " on" : ""), c.name || c.conversationId, function () { selectConv(c.conversationId); });
          b.setAttribute("aria-pressed", on ? "true" : "false");
          convbar.appendChild(b);
        })(cands[j]);
      }
      wrap.appendChild(convbar);
    }

    if (!S.files.length) {
      wrap.appendChild(panel("这个会话还没有文件", "在对话页说一句话，产出文件后会出现在这里。", true));
      wrap.appendChild(el("p", "pf-honest", "本屏只显示后端回读到的真实产物；没有产物就是空。"));
      return;
    }

    /* 搜索 */
    var search = el("label", "pf-search");
    var input = el("input", null, null);
    input.type = "search";
    input.setAttribute("placeholder", "搜索文件");
    input.setAttribute("aria-label", "搜索文件");
    input.value = S.query;
    input.addEventListener("input", function () { S.query = input.value; applyFilter(wrap); });
    search.appendChild(el("span", null, "⌕"));
    search.appendChild(input);
    wrap.appendChild(search);

    /* 格式筛选 */
    var filters = el("div", "pf-filters");
    filters.setAttribute("role", "tablist");
    [["all", "全部"], ["word", "DOCX"], ["excel", "XLSX"], ["ppt", "PPTX"]].forEach(function (pair) {
      var b = btn("pf-filter" + (S.kind === pair[0] ? " on" : ""), pair[1], function () {
        S.kind = pair[0];
        var all = filters.querySelectorAll(".pf-filter");
        for (var k = 0; k < all.length; k++) all[k].classList.remove("on");
        b.classList.add("on");
        applyFilter(wrap);
      });
      b.setAttribute("data-kind", pair[0]);
      b.setAttribute("aria-pressed", S.kind === pair[0] ? "true" : "false");
      filters.appendChild(b);
    });
    wrap.appendChild(filters);

    wrap.appendChild(el("div", "pf-date", "最近更新 · 共 " + S.files.length + " 份"));
    var list = el("div", "pf-list");
    list.setAttribute("role", "list");
    for (var m = 0; m < S.files.length; m++) list.appendChild(fileRow(S.files[m]));
    wrap.appendChild(list);

    var empty = el("div", "pf-empty");
    empty.appendChild(el("h2", null, "没有匹配的文件"));
    empty.appendChild(el("p", "pf-note", "换个关键词或格式试试。"));
    empty.hidden = true;
    wrap.appendChild(empty);

    wrap.appendChild(btn("pf-btn sec", "重新读取", function () { refresh(); }));
    wrap.appendChild(el("p", "pf-honest", "文件名、大小与摘要均由后端回读；本屏不解析文件字节，也不伪造预览。"));
    applyFilter(wrap);
  }

  function fileRow(a) {
    var kind = kindOf(a.filename);
    var b = btn("pf-file", null, null);
    b.setAttribute("role", "listitem");
    b.setAttribute("data-kind", kind);
    b.setAttribute("data-title", a.filename || "");
    b.setAttribute("aria-label", "打开 " + a.filename);
    b.appendChild(el("span", "pf-badge " + kind, KIND_LABEL[kind]));

    var info = S.chain && S.chain.byId[a.artifactId];

    var grow = el("div", "pf-grow");
    grow.appendChild(el("span", "pf-title", a.filename || "未命名文件"));
    var bits = [];
    var sz = CD.fmtBytes(a.byteLength);
    if (sz) bits.push(sz);
    if (info && info.chainLength > 1) bits.push("版本链第 " + info.chainIndex + "/" + info.chainLength + " 版");
    if (typeof a.editRevision === "number") bits.push("版本 r" + a.editRevision);
    else if (typeof a.artifactVersion === "number") bits.push("第 " + a.artifactVersion + " 版");
    bits.push(evidenceOf(a) ? "摘要 " + String(a.sha256).slice(0, 10) + "…" : "证据不足");
    grow.appendChild(el("span", "pf-sub", bits.join(" · ")));

    /* 诚实变更信号：摘要与上一版逐字相同 ⇒ 版本号涨了但内容其实没变。 */
    var truth = changeTruthShort(info);
    if (truth) grow.appendChild(el("span", "pf-versnote " + truth.cls, truth.text));
    b.appendChild(grow);

    b.appendChild(el("span", "pf-chip " + (evidenceOf(a) ? "generated" : "draft"), evidenceOf(a) ? "已生成" : "证据不足"));
    b.appendChild(el("span", "pf-chev", "›"));
    b.addEventListener("click", function () { S.view = "detail"; S.fileId = a.artifactId; paint(); });
    return b;
  }

  function applyFilter(wrap) {
    var q = (S.query || "").trim().toLowerCase();
    var visible = 0;
    var rows = wrap.querySelectorAll(".pf-file");
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var okKind = S.kind === "all" || r.getAttribute("data-kind") === S.kind;
      var hay = String(r.getAttribute("data-title") || "").toLowerCase();
      var show = okKind && (!q || hay.indexOf(q) >= 0);
      r.hidden = !show;
      if (show) visible++;
    }
    var empty = wrap.querySelector(".pf-empty");
    if (empty) empty.hidden = visible > 0;
  }

  /* ---------- 详情 ---------- */

  function buildDetail(wrap, a) {
    wrap.appendChild(btn("pf-back", "‹ 文件", function () { S.view = "list"; paint(); }));

    var kind = kindOf(a.filename);
    var head = el("div", "pf-filehead");
    head.appendChild(el("span", "pf-badge " + kind, KIND_LABEL[kind]));
    var grow = el("div", "pf-grow");
    grow.appendChild(el("h2", "pf-fname", a.filename || "未命名文件"));
    var headInfo = S.chain && S.chain.byId[a.artifactId];
    var headSub = KIND_NAME[kind] + " · " + (evidenceOf(a) ? "已生成" : "证据不足");
    if (headInfo && headInfo.chainLength > 1) headSub += " · 版本链第 " + headInfo.chainIndex + "/" + headInfo.chainLength + " 版";
    grow.appendChild(el("span", "pf-sub", headSub));
    head.appendChild(grow);
    wrap.appendChild(head);

    var kv = el("div", "pf-kvlist");
    kv.appendChild(kvRow("文件格式", KIND_NAME[kind]));
    var chainPos = "";
    if (headInfo && headInfo.chainLength > 1) chainPos = "（本会话第 " + headInfo.chainIndex + " 个版本）";
    kv.appendChild(kvRow("大小", CD.fmtBytes(a.byteLength) || "未知"));
    kv.appendChild(kvRow("版本", (typeof a.artifactVersion === "number" ? "第 " + a.artifactVersion + " 版" : "未知") + chainPos));
    kv.appendChild(kvRow("编辑修订", (typeof a.editRevision === "number" ? "r" + a.editRevision : "未知")));
    kv.appendChild(kvRow("任务修订", (typeof a.taskRevision === "number" ? "r" + a.taskRevision : "未知")));
    var info = S.chain && S.chain.byId[a.artifactId];
    if (info && info.chainLength > 1) kv.appendChild(kvRow("版本链", "第 " + info.chainIndex + " / " + info.chainLength + " 版"));
    if (a.artifactId) kv.appendChild(kvRow("产物 ID", a.artifactId, true));
    wrap.appendChild(kv);

    /* 诚实变更信号：与**上一版**的 sha256 逐字比对（只做等值判断）。 */
    var truth = changeTruth(info);
    if (truth) {
      var tBox = el("div", "pf-banner");
      tBox.appendChild(el("span", "pf-banner-title", truth.cls === "same" ? "内容与上一版相同" : (truth.cls === "diff" ? "较上一版有更新" : "无法比对版本变化")));
      tBox.appendChild(el("span", null, truth.text));
      wrap.appendChild(tBox);
    }

    var shaBox = el("div", "pf-banner");
    shaBox.appendChild(el("span", "pf-banner-title", "SHA-256 摘要"));
    shaBox.appendChild(el("span", "pf-mono", CD.isDigest(a.sha256) ? a.sha256 : ("（摘要格式异常：" + String(a.sha256 || "缺失") + "）")));
    wrap.appendChild(shaBox);

    var pathBox = el("div", "pf-banner");
    pathBox.appendChild(el("span", "pf-banner-title", "下载路径（本地服务）"));
    pathBox.appendChild(el("span", "pf-mono", a.downloadPath || "（后端未提供）"));
    wrap.appendChild(pathBox);

    /* 版本链：把这条文件链上**实际存在**的版本逐个列出来，可跳转查看。 */
    var chain = chainOfFile(S.chain, a);
    if (chain.length > 1) {
      wrap.appendChild(el("h3", null, "版本链 · 共 " + chain.length + " 版"));
      var ul = el("div", "pf-chain");
      for (var ci = 0; ci < chain.length; ci++) {
        (function (entry) {
          var art = entry.artifact;
          var cur = art.artifactId === a.artifactId;
          var item = btn("pf-chainitem", null, null);
          item.setAttribute("aria-current", cur ? "true" : "false");
          item.setAttribute("aria-label", "查看第 " + entry.chainIndex + " 版 " + (art.filename || ""));
          item.appendChild(el("span", "pf-verstag", "第 " + entry.chainIndex + " 版"));
          var g = el("div", "pf-grow");
          g.appendChild(el("span", "pf-title", art.filename || "未命名文件"));
          var sub = [];
          sub.push(CD.fmtBytes(art.byteLength) || "大小未知");
          sub.push(CD.isDigest(art.sha256) ? "摘要 " + shortSha(art.sha256) : "摘要缺失");
          var vb = versionBits(art);
          if (vb.length) sub.push(vb.join(" · "));
          if (entry.sameAsPrev === true) sub.push("与上一版内容相同");
          else if (entry.sameAsPrev === false) sub.push("较上一版有更新");
          if (cur) sub.push("当前查看");
          g.appendChild(el("span", "pf-sub", sub.join(" · ")));
          item.appendChild(g);
          item.addEventListener("click", function () { S.fileId = art.artifactId; paint(); });
          ul.appendChild(item);
        })(chain[ci]);
      }
      wrap.appendChild(ul);
      wrap.appendChild(el("p", "pf-honest", "版本号、大小与摘要全部取自后端回读的 artifact 引用；本屏不生成、不补全任何版本。"));
    }

    var actions = el("div", "pf-actions");
    var canSave = !!(a.downloadPath && a.filename);
    var saveBtn = btn("pf-btn primary block", "保存到手机", function () { download(a, saveBtn); });
    saveBtn.disabled = !canSave;
    actions.appendChild(saveBtn);

    var nativeOk = !!(window.PotbotNative && typeof window.PotbotNative.saveDocx === "function");
    if (!nativeOk) {
      actions.appendChild(el("p", "pf-honest", "当前环境没有原生保存能力（window.PotbotNative.saveDocx 不可用）；可复制上面的下载路径由宿主取回。"));
    }
    wrap.appendChild(actions);

    wrap.appendChild(el("p", "pf-honest", "以上字段全部来自后端回读的 artifact 引用；本屏不解析文件内容、不伪造预览。"));

    /* 会话上下文 */
    if (S.conv) {
      var ctxBox = el("div", "pf-banner");
      ctxBox.appendChild(el("span", "pf-banner-title", "所属会话"));
      ctxBox.appendChild(el("span", null, (S.conv.name || S.conv.conversationId) + " · " + S.conv.conversationId));
      wrap.appendChild(ctxBox);
    }
  }

  function kvRow(k, v, mono) {
    var r = el("div", "pf-kv");
    r.appendChild(el("span", "pf-kv-k", k));
    r.appendChild(el("span", "pf-kv-v" + (mono ? " pf-mono" : ""), v));
    return r;
  }

  /* ---------------------------------------------------------------------------
   * 6. 注册
   * ------------------------------------------------------------------------ */
  window.PB.screens.files = {
    title: "文件",
    render: function (root, ctx) {
      try {
        render(root, ctx);
      } catch (e) {
        root.textContent = "";
        var box = el("div", "pb-files");
        box.appendChild(el("h1", null, "文件"));
        var err = el("div", "pf-banner warn");
        err.appendChild(el("span", "pf-banner-title", "界面渲染异常"));
        err.appendChild(el("span", null, (e && e.message) || String(e)));
        box.appendChild(err);
        root.appendChild(box);
      }
    }
  };
})();
