/* =============================================================================
 * groups.js —— 群组 / 任务（**真实会话运行视图**） window.PB.screens.groups
 * -----------------------------------------------------------------------------
 * 真相来源：电脑端后端的连续对话接口，**只经宿主原生通道 window.PotbotHost**
 *   （页面侧封装 window.PB.host，见 host-api.js）。页面在 file:// 下不能 fetch，
 *   因此一律走 PB.host.get/post；通道缺失时如实报错，绝不伪造数据。
 *
 *    GET  /api/conversations                              -> { conversations:[...] }
 *    GET  /api/conversations/<cid>                        -> { messages:[{state,phase,artifact,...}], currentDocument, ... }
 *    GET  /api/conversations/<cid>/events?cursor=<c>       -> { events:[{kind,detail,...}], cursor }
 *    POST /api/conversations/<cid>/messages/<mid>/cancel   -> { messageId, state, phase, cursor }
 *    POST /api/conversations/<cid>/messages/<mid>/retry    -> { messageId, state, phase, attempts, cursor }
 *
 * 权威形状（不发明字段）：apps/demo/server/http.ts matchConversationRoute（约 719 行）、
 *   handleConversationRoute（约 871 行）；消息形状见 conversation-store.ts
 *   （state: sending|received|streaming|completed|failed|cancelled；
 *    phase: accepted|running|completed|failed|cancelled）。
 *
 * 诚实边界（本文件不编造）：
 *   - 「正在处理」只在**真实**消息 phase 为 accepted/running 时出现；没有活动运行就是空态。
 *   - 取消 / 重试只发真实 POST；回执按服务端原话渲染（失败就显示失败，未知就显示未知）。
 *   - 不预填示例群组、不预填示例任务。
 *
 * 运行环境：file:///android_asset/ui/index.html（Android WebView，经典脚本；
 *   无 import/export、无 type=module、无 fetch/XHR）。只写本文件，不触碰其它文件。
 * ========================================================================== */
(function () {
  "use strict";

  var PB = (window.PB = window.PB || {});
  PB.screens = PB.screens || {};

  /* ---------------------------------------------------------------------------
   * 0. 共享数据加载器 window.PB.convData（groups.js 先加载则此处定义；files.js 复用）
   *    唯一的后端读取面：一律经 PB.host，绝不 fetch、绝不编造。
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
      function clock(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
      }

      /* 合同 R209 的 phase 五态 + 界面 state 六态（真实枚举，不臆造） */
      var PHASE_LABEL = { accepted: "排队中", running: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消" };
      var STATE_LABEL = { sending: "发送中", received: "已接收", streaming: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消" };
      function phaseLabel(p) { return PHASE_LABEL[p] || (p ? String(p) : "未知"); }
      function stateLabel(s) { return STATE_LABEL[s] || (s ? String(s) : "未知"); }
      function isActivePhase(p) { return p === "accepted" || p === "running"; }
      function isTerminalPhase(p) { return p === "completed" || p === "failed" || p === "cancelled"; }
      /* 字节证据：后端 sha256 是不带前缀的 64 位小写十六进制 */
      function isDigest(s) { return typeof s === "string" && /^[0-9a-f]{64}$/i.test(s); }

      /** 选一个"当前会话"：updatedAt 最新、且优先有消息的那一个（纯确定性，不猜内容）。 */
      function pickActive(list) {
        if (!list || !list.length) return null;
        var copy = list.slice().sort(function (a, b) {
          var au = (a && a.updatedAt) || "";
          var bu = (b && b.updatedAt) || "";
          if (au === bu) return 0;
          return au < bu ? 1 : -1;
        });
        for (var i = 0; i < copy.length; i++) {
          if (copy[i] && typeof copy[i].messageCount === "number" && copy[i].messageCount > 0) return copy[i];
        }
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
      function cancelMessage(cid, mid) {
        var h = host(); return h ? h.post("/api/conversations/" + enc(cid) + "/messages/" + enc(mid) + "/cancel", {}) : Promise.resolve(absent());
      }
      function retryMessage(cid, mid) {
        var h = host(); return h ? h.post("/api/conversations/" + enc(cid) + "/messages/" + enc(mid) + "/retry", {}) : Promise.resolve(absent());
      }

      function messagesOf(conv) {
        return (conv && typeof conv === "object" && conv.messages) ? conv.messages : [];
      }

      /** 真实产物清单：消息里的 artifact（按 artifactId 去重）+ currentDocument。绝不编造。 */
      function artifactsOf(conv) {
        var out = [];
        var seen = {};
        var msgs = messagesOf(conv);
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
      /** 当前活动运行：最后一条 phase ∈ {accepted, running} 的消息。 */
      function activeMessage(conv) {
        var msgs = messagesOf(conv);
        for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i] && isActivePhase(msgs[i].phase)) return msgs[i];
        return null;
      }
      /** 最近一条失败 / 取消的消息（只有它可重试）。 */
      function lastFailedMessage(conv) {
        var msgs = messagesOf(conv);
        for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i] && (msgs[i].phase === "failed" || msgs[i].phase === "cancelled")) return msgs[i];
        return null;
      }
      /** 从事件流里取运行时的 provider / model（真实 detail 字段，取不到就 null）。 */
      function runModel(events) {
        var list = (events && events.events) || [];
        for (var i = list.length - 1; i >= 0; i--) {
          var ev = list[i];
          if (!ev || ev.kind !== "run_started" || !ev.detail) continue;
          var d = ev.detail;
          var prov = d.provider != null ? String(d.provider) : "";
          var model = d.model != null ? String(d.model) : "";
          if (prov || model) return { provider: prov, model: model };
        }
        return null;
      }

      return {
        host: host, fmtBytes: fmtBytes, when: when, clock: clock,
        phaseLabel: phaseLabel, stateLabel: stateLabel,
        isActivePhase: isActivePhase, isTerminalPhase: isTerminalPhase, isDigest: isDigest,
        pickActive: pickActive,
        listConversations: listConversations, getConversation: getConversation, getEvents: getEvents,
        cancelMessage: cancelMessage, retryMessage: retryMessage,
        messagesOf: messagesOf, artifactsOf: artifactsOf,
        lastUserMessage: lastUserMessage, activeMessage: activeMessage, lastFailedMessage: lastFailedMessage,
        runModel: runModel
      };
    })();
  }
  var CD = PB.convData;

  /* ---------------------------------------------------------------------------
   * 0b. 样式（内联 <style>；每个选择器限定在 .pb-groups / .pbg-* 之下）
   * ------------------------------------------------------------------------ */
  var STYLE_ID = "pbg-style";
  var CSS = [
    ".pb-groups{--pbg-line:#E8E4DF;--pbg-surface:#FAFAF9;--pbg-soft:#FFF0E2;--pbg-strong:#825034;",
    "--pbg-green:#306A4B;--pbg-danger:#A73729;--pbg-touch:48px;--pbg-r:12px;",
    "color:var(--pb-ink,#28231F);padding:0 0 calc(24px + env(safe-area-inset-bottom))}",
    ".pb-groups *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}",
    ".pb-groups h1{font-size:24px;line-height:32px;font-weight:600;margin:12px 0 8px;overflow-wrap:anywhere}",
    ".pb-groups h2{font-size:18px;line-height:26px;font-weight:600;margin:0}",
    ".pb-groups h3{font-size:16px;line-height:24px;font-weight:600;margin:10px 0 4px}",
    ".pb-groups p{margin:4px 0}",
    ".pb-groups .pbg-note{display:block;font-size:14px;line-height:20px;color:var(--pb-muted,#77716B);overflow-wrap:anywhere}",
    ".pb-groups .pbg-mini{display:block;font-size:12px;line-height:18px;color:var(--pb-muted,#77716B);overflow-wrap:anywhere}",
    ".pb-groups .pbg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all}",
    ".pb-groups .pbg-banner{display:flex;gap:8px;align-items:flex-start;margin:10px 0;padding:10px 12px;border-radius:10px;",
    "background:var(--pbg-soft);color:var(--pbg-strong);border:1px solid #F3DFCB;font-size:13px;line-height:19px}",
    ".pb-groups .pbg-warn{margin:10px 0;padding:10px 12px;border-radius:10px;background:#FBF3E4;color:#8A5A18;",
    "border:1px solid #EEDDBE;font-size:13px;line-height:20px}",
    ".pb-groups .pbg-err{margin:10px 0;padding:12px;border-radius:12px;background:#FBEDE9;border:1px solid #F0D6D0;color:var(--pbg-danger);",
    "font-size:13px;line-height:20px}",
    ".pb-groups .pbg-empty{padding:48px 8px;text-align:center;color:var(--pb-muted,#77716B)}",
    ".pb-groups .pbg-empty h2{font-size:18px;color:var(--pb-ink,#28231F);margin-bottom:6px}",
    ".pb-groups .pbg-sectionhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:20px 0 8px}",
    ".pb-groups .pbg-sectionhead h2{font-size:14px;color:var(--pb-muted,#77716B);font-weight:500;letter-spacing:.4px}",
    ".pb-groups .pbg-btn{min-height:var(--pbg-touch);padding:0 16px;border-radius:var(--pbg-r);border:0;font:inherit;",
    "font-weight:500;background:none;color:var(--pb-ink,#28231F);display:inline-flex;align-items:center;justify-content:center}",
    ".pb-groups .pbg-btn.primary{background:var(--pb-accent,#E9A66D);color:#241A14}",
    ".pb-groups .pbg-btn.secondary{background:#fff;border:1px solid var(--pbg-line);color:var(--pb-ink,#28231F)}",
    ".pb-groups .pbg-btn.danger{background:#FBEDE9;color:var(--pbg-danger);border:1px solid #F0D6D0}",
    ".pb-groups .pbg-btn.text{color:var(--pbg-strong);padding:0 6px}",
    ".pb-groups .pbg-btn:disabled{opacity:.45}",
    ".pb-groups .pbg-btn:active:not(:disabled){filter:brightness(.97)}",
    ".pb-groups button:focus-visible{outline:2px solid var(--pbg-strong);outline-offset:2px}",
    ".pb-groups .pbg-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center}",
    ".pb-groups .pbg-status{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;white-space:nowrap;color:var(--pb-ink,#28231F)}",
    ".pb-groups .pbg-status:before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}",
    ".pb-groups .pbg-status.running{color:var(--pbg-strong)}",
    ".pb-groups .pbg-status.done{color:var(--pbg-green)}",
    ".pb-groups .pbg-status.failed{color:var(--pbg-danger)}",
    ".pb-groups .pbg-status.cancelled{color:var(--pb-muted,#77716B)}",
    ".pb-groups .pbg-status.running:before{animation:pbg-pulse 1.2s ease-in-out infinite}",
    "@keyframes pbg-pulse{50%{opacity:.35}}",
    ".pb-groups .pbg-run{border:1px solid var(--pbg-line);border-radius:16px;padding:14px 16px;margin:12px 0;background:#fff}",
    ".pb-groups .pbg-run.active{border-color:#F3DFCB;background:var(--pbg-soft)}",
    ".pb-groups .pbg-row{display:flex;align-items:flex-start;gap:12px;width:100%}",
    ".pb-groups .pbg-grow{flex:1;min-width:0}",
    ".pb-groups .pbg-chev{color:var(--pb-muted,#77716B);flex:none;font-size:20px}",
    ".pb-groups .pbg-list{display:flex;flex-direction:column}",
    ".pb-groups .pbg-item{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--pbg-line);",
    "font:inherit;color:inherit;padding:14px 0;border-radius:10px}",
    ".pb-groups .pbg-list .pbg-item:last-child{border-bottom:0}",
    ".pb-groups .pbg-item:active{background:var(--pbg-soft)}",
    ".pb-groups .pbg-ititle{display:block;font-size:17px;line-height:24px;font-weight:600;margin:4px 0;overflow-wrap:anywhere}",
    ".pb-groups .pbg-msg{padding:12px 0;border-bottom:1px solid var(--pbg-line)}",
    ".pb-groups .pbg-msg:last-child{border-bottom:0}",
    ".pb-groups .pbg-msgtext{font-size:14px;line-height:21px;margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap}",
    ".pb-groups .pbg-file{display:flex;align-items:center;gap:12px;min-height:56px;width:100%;text-align:left;background:none;border:0;",
    "border-top:1px solid var(--pbg-line);font:inherit;color:inherit;padding:10px 0}",
    ".pb-groups .pbg-fbadge{flex:none;width:44px;height:28px;border-radius:6px;font-size:11px;font-weight:700;display:flex;align-items:center;",
    "justify-content:center;border:1px solid var(--pbg-line);background:var(--pbg-surface);color:var(--pb-muted,#77716B)}",
    ".pb-groups .pbg-overlay{position:fixed;inset:0;background:rgba(40,35,31,.35);display:flex;align-items:flex-end;justify-content:center;z-index:20}",
    ".pb-groups .pbg-sheet{width:100%;max-width:520px;background:#fff;border-radius:16px 16px 0 0;padding:18px 20px calc(18px + env(safe-area-inset-bottom));",
    "color:var(--pb-ink,#28231F);max-height:86vh;overflow-y:auto}",
    ".pb-groups .pbg-sheet-title{font-size:18px;font-weight:600;margin:0 0 8px}",
    ".pb-groups .pbg-sheet-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}"
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
  function extLabel(name) {
    var m = /\.([a-z0-9]{2,5})$/i.exec(String(name || ""));
    return m ? m[1].toUpperCase() : "FILE";
  }

  /* ---------------------------------------------------------------------------
   * 2. 屏内状态
   * ------------------------------------------------------------------------ */
  var S = {
    root: null, ctx: null,
    phase: "loading",        // nohost | loading | error | empty | ready
    err: null,
    view: "detail",          // detail | list
    convList: [],
    convId: null,
    conv: null,
    events: null, eventsCid: null,
    loading: false,
    notice: null,
    sheet: null,
    busy: false,
    timer: null,
    hostTimer: null
  };

  function keyIsMine() {
    if (!S.ctx || !S.ctx.state) return true;
    var k = S.ctx.state.key;
    return !k || k === "groups";
  }
  function ensureHost() {
    if (PB.host && typeof PB.host.detect === "function") { try { PB.host.detect(); } catch (e) {} }
    return !!(PB.host && PB.host.available);
  }
  function toast(msg) { if (typeof PB.toast === "function") PB.toast(msg); }
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
      /* 宿主可能晚于页面脚本注入：稍后重探一次（对齐 app.js 的做法） */
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
    var h = CD.host();
    if (!h) { S.loading = false; S.phase = "nohost"; paint(); return; }
    CD.listConversations().then(function (res) {
      if (!keyIsMine()) { S.loading = false; return; }
      if (!res.ok) { S.err = res.error; S.phase = "error"; S.loading = false; paint(); return; }
      var list = (res.data && res.data.conversations) || [];
      S.convList = list;
      if (!list.length) { S.phase = "empty"; S.loading = false; paint(); return; }
      var chosen = S.convId || (S.ctx.state && S.ctx.state.convId) || null;
      if (!chosen) {
        var p = CD.pickActive(list);
        chosen = p ? p.conversationId : null;
        if (p && typeof p.messageCount === "number" && p.messageCount > 0) S.view = "detail";
        else S.view = "list";
      }
      S.convId = chosen;
      if (!S.convId) { S.phase = "empty"; S.loading = false; paint(); return; }
      S.phase = "loading";
      paint();
      loadConv();
    });
  }

  function loadConv() {
    if (!S.convId) { S.loading = false; return; }
    var cid = S.convId;
    S.loading = true;
    CD.getConversation(cid).then(function (res) {
      if (!keyIsMine()) { S.loading = false; return; }
      if (!res.ok) { S.err = res.error; S.phase = "error"; S.loading = false; paint(); return; }
      S.conv = res.data;
      S.err = null;
      S.phase = "ready";
      S.loading = false;
      paint();
      if (S.eventsCid !== cid) loadEvents(cid);
      schedulePoll();
    });
  }

  function loadEvents(cid) {
    CD.getEvents(cid, null).then(function (res) {
      if (!keyIsMine() || S.convId !== cid) return;
      if (res.ok) { S.events = res.data; S.eventsCid = cid; paint(); }
    });
  }

  /** 只在有真实活动运行时轮询；用 setTimeout 链（一次回来再排下一次），避免堆叠冻结。 */
  function schedulePoll() {
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    if (!S.conv) return;
    if (!CD.activeMessage(S.conv)) return;
    S.timer = setTimeout(function () {
      S.timer = null;
      if (!keyIsMine()) return;
      loadConv();
    }, 2200);
  }

  function selectConv(id) {
    S.convId = id;
    if (S.ctx && S.ctx.state) S.ctx.state.convId = id;
    S.conv = null; S.events = null; S.eventsCid = null;
    S.view = "detail"; S.phase = "loading"; S.sheet = null;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    paint();
    loadConv();
  }

  /* ---------------------------------------------------------------------------
   * 4. 动作：取消 / 重试（真实 POST，回执按服务端原话）
   * ------------------------------------------------------------------------ */
  function doCancel(mid) {
    if (S.busy) return;
    S.busy = true; S.sheet = null; paint();
    CD.cancelMessage(S.convId, mid).then(function (res) {
      S.busy = false;
      if (!keyIsMine()) return;
      if (!res.ok) { notice("取消未完成：" + (res.error.message || res.error.code || "未知")); paint(); return; }
      var d = res.data || {};
      notice("已请求取消 · 消息状态 " + CD.stateLabel(d.state) + " / " + CD.phaseLabel(d.phase));
      loadConv();
    });
  }

  function doRetry(mid) {
    if (S.busy) return;
    S.busy = true; paint();
    CD.retryMessage(S.convId, mid).then(function (res) {
      S.busy = false;
      if (!keyIsMine()) return;
      if (!res.ok) { notice("重试未发出：" + (res.error.message || res.error.code || "未知")); paint(); return; }
      var d = res.data || {};
      notice("已重试 · " + CD.stateLabel(d.state) + " / " + CD.phaseLabel(d.phase) + "（第 " + (d.attempts != null ? d.attempts : "?") + " 次尝试）");
      loadConv();
    });
  }

  function doRefresh() {
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    S.events = null; S.eventsCid = null;
    S.loading = false;
    if (ensureHost()) bootstrap(); else { S.phase = "nohost"; paint(); }
  }

  /* ---------------------------------------------------------------------------
   * 5. 渲染
   * ------------------------------------------------------------------------ */
  function statusChip(phase) {
    var mod = phase === "completed" ? "done"
      : phase === "failed" ? "failed"
      : phase === "cancelled" ? "cancelled"
      : "running";
    var s = el("span", "pbg-status " + mod, CD.phaseLabel(phase));
    return s;
  }

  function panel(title, body, retryable) {
    var box = el("div", "pbg-empty");
    box.appendChild(el("h2", null, title));
    if (body) box.appendChild(el("p", "pbg-note", body));
    if (retryable) {
      var b = btn("pbg-btn secondary", "重新读取", function () { doRefresh(); });
      box.appendChild(b);
    }
    return box;
  }

  function errorPanel(err) {
    var box = el("div", "pbg-err");
    box.appendChild(el("h2", null, "读取失败"));
    box.appendChild(el("p", null, (err && err.message) || "本地服务没有返回可用的内容。"));
    if (err && err.code) box.appendChild(el("p", "pbg-mini", "错误码：" + err.code));
    box.appendChild(btn("pbg-btn secondary", "重新读取", function () { doRefresh(); }));
    return box;
  }

  function paint() {
    if (!S.root || !keyIsMine()) return;
    var root = S.root;
    root.textContent = "";
    var screen = el("div", "pb-groups");
    if (S.notice) screen.appendChild(el("div", "pbg-banner", S.notice.text));

    if (S.phase === "nohost") {
      screen.appendChild(panel("本地服务通道不可用",
        "当前环境没有连接到电脑端服务（window.PotbotHost 未注入）。群组与任务状态只来自真实后端，未接入时不预填内容。", false));
      root.appendChild(screen);
      return;
    }
    if (S.phase === "loading" && !S.conv && !S.convList.length) {
      screen.appendChild(panel("正在读取群组…", "正在从电脑端服务读取真实会话与任务状态。", false));
      root.appendChild(screen);
      return;
    }
    if (S.phase === "error") {
      screen.appendChild(errorPanel(S.err));
      root.appendChild(screen);
      renderSheet(screen);
      return;
    }
    if (S.phase === "empty") {
      screen.appendChild(panel("还没有群组", "完成一个任务后，会话与运行状态会出现在这里。", true));
      root.appendChild(screen);
      return;
    }

    var body = el("div", "pbg-body");
    if (S.view === "detail" && S.conv) renderDetail(body);
    else renderList(body);
    screen.appendChild(body);
    renderSheet(screen);
    root.appendChild(screen);
  }

  /* ---------- 群组列表 ---------- */

  function renderList(frag) {
    frag.appendChild(el("h1", null, "群组"));
    frag.appendChild(el("p", "pbg-note", "每个群组对应一个真实会话；打开可查看当前运行与操作。"));
    var list = el("div", "pbg-list");
    var i;
    for (i = 0; i < S.convList.length; i++) {
      list.appendChild(convRow(S.convList[i]));
    }
    frag.appendChild(list);
    frag.appendChild(btn("pbg-btn secondary", "重新读取", function () { doRefresh(); }));
    frag.appendChild(el("p", "pbg-mini", "以上来自电脑端服务的真实会话列表；未回读前不推断任务结果。"));
  }

  function convRow(c) {
    var item = btn("pbg-item", null, null);
    item.setAttribute("aria-label", "打开群组 " + (c.name || c.conversationId));
    var row = el("div", "pbg-row");
    var main = el("div", "pbg-grow");
    main.appendChild(el("span", "pbg-ititle", c.name || "未命名会话"));
    var n = typeof c.messageCount === "number" ? c.messageCount : 0;
    main.appendChild(el("span", "pbg-mini", n + " 条消息 · 更新 " + CD.when(c.updatedAt)));
    row.appendChild(main);
    row.appendChild(el("span", "pbg-chev", "›"));
    item.appendChild(row);
    item.addEventListener("click", function () { selectConv(c.conversationId); });
    return item;
  }

  /* ---------- 运行详情 ---------- */

  function renderDetail(frag) {
    var conv = S.conv;
    var back = btn("pbg-btn text", "‹ 全部群组", function () { S.view = "list"; S.sheet = null; paint(); });
    frag.appendChild(back);

    frag.appendChild(el("h1", null, conv.name || "未命名会话"));
    frag.appendChild(el("p", "pbg-mini", "会话 " + conv.conversationId + " · 更新 " + CD.when(conv.updatedAt)));

    var run = CD.activeMessage(conv);
    var failed = CD.lastFailedMessage(conv);
    var lastUser = CD.lastUserMessage(conv);
    var arts = CD.artifactsOf(conv);
    var model = CD.runModel(S.events);

    var card = el("section", "pbg-run" + (run ? " active" : ""));

    if (run) {
      card.appendChild(statusChip(run.phase));
      card.appendChild(el("h3", null, "正在处理"));
      card.appendChild(el("p", "pbg-msgtext", lastUser ? lastUser.text : "（该运行没有对应的用户指令）"));
      var meta = "阶段：" + CD.phaseLabel(run.phase) + " · 消息 " + run.messageId;
      if (run.attempts) meta += " · 第 " + run.attempts + " 次尝试";
      card.appendChild(el("p", "pbg-mini", meta));
      if (model) card.appendChild(el("p", "pbg-mini", "运行模型：" + (model.provider || "provider? ") + (model.model ? " · " + model.model : "")));
      var acts = el("div", "pbg-actions");
      var cancel = btn("pbg-btn danger", "取消任务", function () { S.sheet = { type: "cancel", mid: run.messageId }; paint(); });
      cancel.disabled = S.busy;
      acts.appendChild(cancel);
      card.appendChild(acts);
    } else if (failed) {
      card.appendChild(statusChip(failed.phase));
      card.appendChild(el("h3", null, "上一次运行" + CD.phaseLabel(failed.phase)));
      var emsg = (failed.error && failed.error.message) ? failed.error.message
        : (failed.phase === "cancelled" ? "这条运行已被取消。" : "服务端未提供失败原因。");
      card.appendChild(el("p", "pbg-msgtext", emsg));
      if (failed.error && failed.error.code) card.appendChild(el("p", "pbg-mini", "错误码：" + failed.error.code + (failed.error.retryable === false ? " · 不可重试" : "")));
      var acts2 = el("div", "pbg-actions");
      var retry = btn("pbg-btn primary", "重试", function () { doRetry(failed.messageId); });
      retry.disabled = S.busy || (failed.error && failed.error.retryable === false);
      acts2.appendChild(retry);
      card.appendChild(acts2);
    } else {
      card.appendChild(statusChip("completed"));
      card.appendChild(el("h3", null, "当前没有正在执行的任务"));
      if (arts.length) card.appendChild(el("p", "pbg-note", "最近完成：" + arts[0].filename));
      else card.appendChild(el("p", "pbg-note", "该会话还没有产出文件。在对话页说一句话即可开始。"));
    }

    var cardActs = el("div", "pbg-actions");
    cardActs.appendChild(btn("pbg-btn secondary", "刷新", function () { doRefresh(); }));
    card.appendChild(cardActs);
    frag.appendChild(card);

    /* 产物（真实文件引用） */
    if (arts.length) {
      var head = el("div", "pbg-sectionhead");
      head.appendChild(el("h2", null, "成果 · " + arts.length + " 份"));
      frag.appendChild(head);
      for (var i = 0; i < arts.length; i++) frag.appendChild(artifactRow(arts[i]));
    }

    /* 活动（真实消息） */
    var msgs = CD.messagesOf(conv);
    if (msgs.length) {
      var h2 = el("div", "pbg-sectionhead");
      h2.appendChild(el("h2", null, "活动 · " + msgs.length + " 条"));
      frag.appendChild(h2);
      var shown = msgs.slice(-12);
      for (var j = 0; j < shown.length; j++) frag.appendChild(messageRow(shown[j]));
    }
  }

  function artifactRow(a) {
    var b = btn("pbg-file", null, null);
    b.setAttribute("aria-label", "在文件中查看 " + a.filename);
    b.appendChild(el("span", "pbg-fbadge", extLabel(a.filename)));
    var main = el("div", "pbg-grow");
    main.appendChild(el("span", "pbg-ititle", a.filename));
    var bits = [];
    var sz = CD.fmtBytes(a.byteLength);
    if (sz) bits.push(sz);
    if (typeof a.artifactVersion === "number") bits.push("第 " + a.artifactVersion + " 版");
    main.appendChild(el("span", "pbg-mini", bits.join(" · ") || "真实产出文件"));
    b.appendChild(main);
    b.appendChild(el("span", "pbg-chev", "›"));
    b.addEventListener("click", function () {
      if (S.ctx && S.ctx.state) S.ctx.state.convId = S.convId;
      if (S.ctx && typeof S.ctx.navigate === "function") S.ctx.navigate("files");
      else toast("无法切换：navigate 不可用。");
    });
    return b;
  }

  function messageRow(m) {
    var box = el("div", "pbg-msg");
    var role = m.role === "user" ? "我" : (m.role === "assistant" ? "Potbot" : "系统");
    var head = el("div", "pbg-row");
    head.appendChild(el("span", "pbg-mini", role + " · " + CD.when(m.createdAt) + (m.updatedAt && m.updatedAt !== m.createdAt ? " · " + CD.clock(m.updatedAt) : "")));
    head.appendChild(el("span", "pbg-mini", CD.stateLabel(m.state) + "/" + CD.phaseLabel(m.phase)));
    box.appendChild(head);
    if (m.text) box.appendChild(el("p", "pbg-msgtext", m.text.length > 300 ? m.text.slice(0, 300) + "…" : m.text));
    if (m.error && m.error.message) box.appendChild(el("p", "pbg-mini", "错误：" + m.error.message));
    return box;
  }

  /* ---------- 确认弹层 ---------- */

  function renderSheet(screen) {
    if (!S.sheet || S.sheet.type !== "cancel") return;
    var wrap = el("div", "pbg-overlay");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    var sheet = el("div", "pbg-sheet");
    sheet.appendChild(el("h2", "pbg-sheet-title", "取消这个任务？"));
    sheet.appendChild(el("p", "pbg-note", "将向后端发出取消请求；结果以服务端回执为准（取消 ≠ 一定已停止）。"));
    var acts = el("div", "pbg-sheet-actions");
    acts.appendChild(btn("pbg-btn secondary", "保留", function () { S.sheet = null; paint(); }));
    var go = btn("pbg-btn danger", "确认取消", function () { doCancel(S.sheet.mid); });
    go.disabled = S.busy;
    acts.appendChild(go);
    sheet.appendChild(acts);
    wrap.appendChild(sheet);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) { S.sheet = null; paint(); } });
    screen.appendChild(wrap);
  }

  /* ---------------------------------------------------------------------------
   * 6. 注册
   * ------------------------------------------------------------------------ */
  window.PB.screens.groups = {
    title: "群组",
    render: function (root, ctx) {
      try {
        render(root, ctx);
      } catch (e) {
        root.textContent = "";
        var box = el("div", "pb-groups");
        box.appendChild(el("h1", null, "群组"));
        box.appendChild(el("div", "pbg-err", "界面渲染异常：" + ((e && e.message) || String(e))));
        root.appendChild(box);
      }
    }
  };
})();
