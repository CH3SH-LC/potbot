/* =============================================================================
 * PB.screens.chat + PB.screens.conversations —— 真·多轮对话主入口与会话列表
 * -----------------------------------------------------------------------------
 * 本轮改造要点（旧的"一句话 → /api/documents 一次性转换"已被替换）：
 *   - 发送走通用 agent 循环 /api/conversations/**（驱动在 word-flow.js）：
 *       ① 新会话：POST /api/conversations {name} 建会话，conversationId 存进 PB.state
 *          （并尽力写入 localStorage），重开页面继续同一个会话 —— 这就是"记忆"。
 *       ② 发消息：POST /api/conversations/<cid>/messages {text, clientId<幂等键>}
 *       ③ 跟踪：GET /api/conversations/<cid>/events?cursor=... 逐条渲染运行轨迹
 *          （message_accepted / run_requested / run_started{provider,model} /
 *           assistant_turn / tool_invoked / tool_result / tool_failed / run_*）
 *       ④ 终局：GET /api/conversations/<cid> 取**权威** messages 与 currentDocument，
 *          完成态显示真实产物卡（filename / byteLength / sha256 短码 + 打开）。
 *   - 多轮：第二条消息进入**同一个** conversationId，显示在第一条下方。
 *   - conversations 屏：GET /api/conversations?include_archived=true，列表是真的。
 *
 * 运行环境：WebView file:///android_asset/ui/index.html，CLASSIC script，
 * 无 import/export、无 fetch/XHR、无外部资源。后端只经 PB.host（window.PotbotHost）。
 *
 * 诚实边界（不编造）：
 *   - 只渲染后端**真实回执**。读取失败 / 通道缺失 / 状态未知：如实报错附服务端原话。
 *   - 只有拿到真实 artifact 引用（artifactId + filename）才显示产物卡；
 *     "服务端说完成但没有文件引用"不当作成功。
 *   - 停止 = "已请求取消"，等电脑端确认；不假装任务已撤销。
 *   - 起始为空：没有历史会话就显示空态，不预填示例内容。
 * ========================================================================== */
(function () {
  "use strict";

  window.PB = window.PB || {};
  window.PB.screens = window.PB.screens || {};

  /* ------------------------------------------------------------------ 样式 */
  var STYLE_ID = "pbc-style";
  var CSS = [
    ":root{--pb-accent:#E9A66D;--pb-accent-soft:#FFF0E2;--pb-bg:#fff;--pb-ink:#28231F;--pb-muted:#77716B}",
    ".pbc-screen{--pbc-line:#E8E4DF;--pbc-surface:#FAFAF9;--pbc-ok:#306A4B;--pbc-danger:#A73729;--pbc-strong:#825034;--pbc-touch:48px;--pbc-r:12px;--pbc-rc:16px;",
    "display:flex;flex-direction:column;height:100%;min-height:0;position:relative;background:var(--pb-bg);color:var(--pb-ink);",
    "font:16px/24px -apple-system,\"Noto Sans CJK SC\",\"Source Han Sans SC\",\"Microsoft YaHei\",system-ui,sans-serif;",
    "padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}",
    ".pbc-screen *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}",
    ".pbc-screen button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}",
    ".pbc-screen button:focus-visible,.pbc-screen textarea:focus-visible,.pbc-screen input:focus-visible{outline:2px solid var(--pbc-strong);outline-offset:2px}",
    ".pbc-screen h1{font-size:24px;line-height:32px;font-weight:600;margin:12px 0 8px}",
    ".pbc-screen h2{font-size:20px;line-height:28px;font-weight:600;margin:0}",
    ".pbc-screen p{margin:0}",

    ".pbc-head{flex:none;display:flex;align-items:center;gap:8px;min-height:56px;padding:6px 16px 2px}",
    ".pbc-headtitle{flex:1;min-width:0;font-size:17px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".pbc-iconbtn{min-width:var(--pbc-touch);min-height:var(--pbc-touch);display:flex;align-items:center;justify-content:center;border-radius:var(--pbc-r);font-size:15px;padding:0 10px}",
    ".pbc-iconbtn:active{background:var(--pb-accent-soft)}",
    ".pbc-back{display:flex;align-items:center;gap:2px;min-height:var(--pbc-touch);padding:0 8px 0 0;font-size:15px}",
    ".pbc-wordmark{font-size:20px;font-weight:600;letter-spacing:.02em;flex:1}",

    ".pbc-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 16px 12px}",
    ".pbc-note{display:block;font-size:13px;line-height:20px;color:var(--pb-muted)}",
    ".pbc-mini{display:block;font-size:12px;line-height:18px;color:var(--pb-muted)}",
    ".pbc-time{font-size:11px;color:var(--pb-muted);white-space:nowrap;flex:none}",

    ".pbc-sectionhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 0 6px}",
    ".pbc-sectionhead h2{font-size:14px;color:var(--pb-muted);font-weight:500;letter-spacing:.4px}",
    ".pbc-sectionhead button{color:var(--pbc-strong);font-size:13px;min-height:var(--pbc-touch);padding:0 6px}",

    ".pbc-rows{display:flex;flex-direction:column}",
    ".pbc-row{display:flex;align-items:center;gap:12px;width:100%;min-height:var(--pbc-touch);padding:12px 0;border-bottom:1px solid var(--pbc-line)}",
    ".pbc-rows .pbc-row:last-child{border-bottom:0}",
    ".pbc-row:active{background:var(--pb-accent-soft)}",
    ".pbc-rowmain{flex:1;min-width:0}",
    ".pbc-title{display:block;font-size:16px;font-weight:500;line-height:24px;overflow-wrap:anywhere}",
    ".pbc-chev{color:var(--pb-muted);font-size:18px;flex:none}",

    ".pbc-msg{max-width:88%;padding:10px 14px;border-radius:16px;margin:10px 0;font-size:15px;line-height:24px;white-space:pre-wrap;word-break:break-word}",
    ".pbc-msg.user{margin-left:auto;background:var(--pb-accent-soft);border-bottom-right-radius:4px}",
    ".pbc-msg.bot{background:var(--pbc-surface);border:1px solid var(--pbc-line);border-bottom-left-radius:4px;max-width:100%}",
    ".pbc-msg.sys{max-width:100%;background:none;border:1px dashed var(--pbc-line);color:var(--pb-muted);font-size:12px;line-height:18px}",
    ".pbc-caret{display:inline-block;width:8px;height:16px;background:var(--pbc-strong);vertical-align:-3px;",
    "margin-left:3px;animation:pbc-blink 1s steps(2,start) infinite}",
    "@keyframes pbc-blink{to{visibility:hidden}}",
    ".pbc-talk{padding:2px 0}",
    ".pbc-state{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:12px;line-height:18px;color:var(--pb-muted)}",
    ".pbc-state.err{color:var(--pbc-danger)}.pbc-state.warn{color:var(--pbc-strong)}.pbc-state.ok{color:var(--pbc-ok)}",
    ".pbc-state .pbc-btn{min-height:36px;padding:0 12px;font-size:12px}",
    ".pbc-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--pbc-strong);animation:pbc-pulse 1.2s ease-in-out infinite}",
    "@keyframes pbc-pulse{0%,100%{opacity:.25}50%{opacity:1}}",
    ".pbc-chip-model{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--pbc-strong);",
    "background:var(--pb-accent-soft);border-radius:999px;padding:2px 10px;margin-top:8px}",

    ".pbc-process{background:var(--pbc-surface);border-radius:var(--pbc-r);margin-top:12px;overflow:hidden}",
    ".pbc-process summary{padding:12px 14px;font-size:12px;color:var(--pb-muted);min-height:var(--pbc-touch);display:flex;align-items:center;gap:6px;list-style:none}",
    ".pbc-process summary::-webkit-details-marker{display:none}",
    ".pbc-process summary:before{content:\"▸\";font-size:10px;transition:transform .15s}",
    ".pbc-process[open] summary:before{transform:rotate(90deg)}",
    ".pbc-process ol{margin:0;padding:0 16px 14px 34px;font-size:12px;line-height:20px;color:var(--pb-muted)}",
    ".pbc-process li{margin:4px 0;overflow-wrap:anywhere}",

    ".pbc-empty{padding:40px 0;text-align:center;color:var(--pb-muted)}",
    ".pbc-empty h2{font-size:20px;color:var(--pb-ink);margin-bottom:6px}",
    ".pbc-loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:32px 0;color:var(--pb-muted);font-size:14px}",

    ".pbc-home{padding:44px 4px 8px;text-align:left}",
    ".pbc-home h1{font-size:28px;line-height:38px;font-weight:600;letter-spacing:-.5px;margin:0 0 10px}",
    ".pbc-home .pbc-note{font-size:15px;line-height:24px;color:var(--pb-muted)}",
    ".pbc-eg{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px}",
    ".pbc-eg span{border:1px solid var(--pbc-line);border-radius:999px;padding:9px 14px;font-size:13px;color:var(--pb-muted)}",

    ".pbc-resume{display:flex;align-items:center;gap:12px;width:100%;margin-top:18px;padding:12px 14px;",
    "border:1px solid #F3DFCB;border-radius:var(--pbc-r);background:var(--pb-accent-soft);min-height:var(--pbc-touch)}",
    ".pbc-resume .pbc-title{color:var(--pbc-strong)}",

    ".pbc-file{display:flex;align-items:center;gap:12px;margin-top:12px;padding:12px;border:1px solid var(--pbc-line);",
    "border-radius:var(--pbc-r);background:var(--pb-bg)}",
    ".pbc-fileicon{width:44px;height:44px;flex:none;border-radius:10px;background:var(--pb-accent-soft);color:var(--pbc-strong);",
    "display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;letter-spacing:.4px}",
    ".pbc-filemain{flex:1;min-width:0;display:flex;flex-direction:column}",
    ".pbc-filemain .pbc-title{font-weight:600}",
    ".pbc-fileopen{flex:none;min-height:var(--pbc-touch);padding:0 18px;border-radius:var(--pbc-r);background:var(--pb-accent);",
    "color:#241A14;font-size:15px;font-weight:600;display:flex;align-items:center;justify-content:center}",
    ".pbc-fileopen:disabled{opacity:.5}",
    ".pbc-docbar{display:flex;align-items:center;gap:10px;margin:6px 0 2px;padding:9px 12px;border:1px solid var(--pbc-line);",
    "border-radius:var(--pbc-r);background:var(--pbc-surface)}",
    ".pbc-docbar .pbc-fileicon{width:36px;height:36px;font-size:9px}",

    /* 版本真相：变更提示 + 版本历史（紧凑，不喧宾夺主） */
    ".pbc-versnote{display:block;font-size:12px;line-height:18px;margin-top:4px;overflow-wrap:anywhere}",
    ".pbc-versnote.same{color:var(--pb-muted)}",
    ".pbc-versnote.diff{color:var(--pbc-strong)}",
    ".pbc-versnote.unknown{color:var(--pb-muted)}",
    ".pbc-vers{margin-top:8px;border-top:1px dashed var(--pbc-line);padding-top:6px}",
    ".pbc-vers summary{list-style:none;display:flex;align-items:center;gap:4px;font-size:12px;line-height:18px;color:var(--pb-muted);min-height:32px}",
    ".pbc-vers summary::-webkit-details-marker{display:none}",
    ".pbc-vers summary:before{content:\"▸\";font-size:10px}",
    ".pbc-vers[open] summary:before{content:\"▾\"}",
    ".pbc-vers ol{margin:2px 0 0;padding-left:18px;font-size:12px;line-height:18px;color:var(--pb-muted)}",
    ".pbc-vers li{margin:3px 0;overflow-wrap:anywhere}",
    ".pbc-vers li.cur{color:var(--pbc-strong);font-weight:600}",
    ".pbc-verssrc{display:block;margin-top:4px;font-size:11px;line-height:16px;color:var(--pb-muted)}",

    ".pbc-err{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid #F0D6D0;background:#FBEDE9;",
    "border-radius:var(--pbc-r);color:var(--pbc-danger);font-size:13px;line-height:20px;margin:10px 0}",
    ".pbc-err strong{font-size:14px}",
    ".pbc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}",
    ".pbc-badge{font-size:11px;color:var(--pb-muted);overflow-wrap:anywhere}",

    ".pbc-composer{flex:none;position:sticky;bottom:0;z-index:5;background:var(--pb-bg);border-top:1px solid var(--pbc-line);",
    "padding:8px 16px calc(8px + env(safe-area-inset-bottom))}",
    ".pbc-inputbubble{display:flex;align-items:flex-end;gap:8px;background:var(--pbc-surface);border:1px solid var(--pbc-line);border-radius:var(--pbc-r);padding:6px 6px 6px 10px}",
    ".pbc-ta{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--pb-ink);resize:none;padding:10px 2px;",
    "font:16px/24px inherit;max-height:96px;min-height:46px}",
    ".pbc-ta::placeholder{color:#8b847b}",
    ".pbc-send{flex:none;min-width:var(--pbc-touch);height:var(--pbc-touch);border-radius:var(--pbc-r);background:var(--pb-accent);",
    "color:#241A14;font-size:15px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 14px}",
    ".pbc-send.stop{background:var(--pbc-surface);border:1px solid var(--pbc-line);color:var(--pb-ink)}",
    ".pbc-send:disabled{opacity:.45}",
    ".pbc-hint{font-size:12px;line-height:18px;color:var(--pb-muted);margin:6px 2px 0}",

    ".pbc-search{display:flex;align-items:center;gap:8px;background:var(--pbc-surface);border:1px solid var(--pbc-line);",
    "border-radius:var(--pbc-r);padding:0 12px;margin:12px 0}",
    ".pbc-search input{flex:1;min-width:0;border:0;outline:0;background:none;height:var(--pbc-touch);font:15px inherit}",
    ".pbc-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}",
    ".pbc-filter{padding:0 14px;font-size:13px;color:var(--pb-muted);border:1px solid var(--pbc-line);border-radius:9px;min-height:var(--pbc-touch)}",
    ".pbc-filter[aria-pressed=\"true\"]{background:var(--pb-accent-soft);color:var(--pbc-strong);border-color:#F3DFCB;font-weight:500}",
    ".pbc-archtag{display:inline-block;font-size:10px;line-height:16px;padding:1px 6px;border-radius:6px;background:var(--pbc-surface);border:1px solid var(--pbc-line);color:var(--pb-muted);margin-left:6px;vertical-align:middle}",

    ".pbc-sheetwrap{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(40,35,31,.35)}",
    ".pbc-sheet{background:var(--pb-bg);border-radius:18px 18px 0 0;padding:14px 18px calc(18px + env(safe-area-inset-bottom));max-height:80%;overflow-y:auto;box-shadow:0 -2px 16px rgba(0,0,0,.08)}",
    ".pbc-sheethead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}",
    ".pbc-sheethead h2{font-size:17px}",
    ".pbc-menurow{display:flex;align-items:center;gap:12px;width:100%;min-height:var(--pbc-touch);padding:12px 0;border-bottom:1px solid var(--pbc-line);font-size:15px}",
    ".pbc-menurow:last-of-type{border-bottom:0}",
    ".pbc-btn{min-height:var(--pbc-touch);padding:0 16px;border-radius:var(--pbc-r);font-weight:500;display:inline-flex;align-items:center;justify-content:center}",
    ".pbc-btn-primary{background:var(--pb-accent);color:#241A14}",
    ".pbc-btn-secondary{background:var(--pbc-surface);border:1px solid var(--pbc-line)}",
    ".pbc-btn.block{width:100%;margin-top:10px}",

    ".pbc-toast{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(120px + env(safe-area-inset-bottom));",
    "background:#28231F;color:#fff;font-size:13px;line-height:18px;padding:8px 14px;border-radius:10px;max-width:80%;",
    "opacity:0;transition:opacity .18s ease;pointer-events:none;z-index:30}",
    ".pbc-toast.show{opacity:1}"
  ].join("\n");

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------- 基础工具 */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k === "html") n.innerHTML = v;
        else if (k === "on") { for (var e in v) n.addEventListener(e, v[e]); }
        else if (v === true) n.setAttribute(k, "");
        else n.setAttribute(k, v);
      }
    }
    if (kids != null) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c == null || c === false || c === "") return;
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function uid(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
  function fmtBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) return "";
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    return (v / (1024 * 1024)).toFixed(1) + " MB";
  }
  function extLabel(name) {
    var m = /\.([a-z0-9]{2,5})$/i.exec(String(name || ""));
    return m ? m[1].toUpperCase() : "FILE";
  }
  function firstLine(s, max) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    var m = max || 44;
    return t.length > m ? t.slice(0, m) + "…" : t;
  }
  /* 后端 sha256 是不带前缀的 64 位十六进制；格式不对就不拿它做任何判断。 */
  function isDigest(s) { return typeof s === "string" && /^[0-9a-f]{64}$/i.test(s); }
  function shortSha(s) { return isDigest(s) ? String(s).slice(0, 8) + "…" : "（摘要缺失）"; }

  /* 版本行：号只从后端 artifact 引用里读，缺哪个就不写哪个（不补零、不推算）。
     契约 R141：editRevision / taskRevision / artifactVersion 是**三个号**，分别显示。 */
  function versionLabel(a) {
    if (!a) return "";
    var bits = [];
    if (typeof a.editRevision === "number") bits.push("版本 r" + a.editRevision);
    if (typeof a.artifactVersion === "number") bits.push("第 " + a.artifactVersion + " 版");
    if (typeof a.taskRevision === "number" && a.taskRevision !== a.editRevision) bits.push("任务 r" + a.taskRevision);
    return bits.join(" · ");
  }

  /**
   * 版本史：只从**本会话真实消息里的 artifact 引用**（外加 currentDocument）构建。
   * 按出现顺序、按 artifactId 去重 —— 后端每个版本是一条独立的产物记录（artifact_id 不同）。
   * 变更判定**只做一次等值比较**：本版与前一个同文件名版本的 sha256 是否逐字相同。
   *   sameAsPrev === true  ⇒ 摘要一致，文件内容并未改变（后端可以只把版本号 +1）
   *   sameAsPrev === false ⇒ 摘要不同，确实产生了新内容
   *   sameAsPrev === null  ⇒ 任一侧缺合法摘要，**不做判断**（不猜）
   */
  function versionHistory(st, cid) {
    var msgs = st.messages[cid] || [];
    var list = [], byId = {}, i, a, e;
    for (i = 0; i < msgs.length; i++) {
      a = msgs[i] && msgs[i].artifact;
      if (!a || !a.artifactId || byId[a.artifactId]) continue;
      e = { artifact: a, messageIndex: i, prev: null, sameAsPrev: null, chainIndex: 0, chainLength: 1, isNewest: false };
      byId[a.artifactId] = e;
      list.push(e);
    }
    var cur = st.currentDoc[cid];
    if (cur && cur.artifactId && !byId[cur.artifactId]) {
      /* currentDocument 可能比消息列表更早/更新地被回读到；它是一份**真实引用**，照样列进来。 */
      e = { artifact: cur, messageIndex: -1, prev: null, sameAsPrev: null, chainIndex: 0, chainLength: 1, isNewest: false };
      byId[cur.artifactId] = e;
      list.push(e);
    }
    /* 同文件名才算同一条版本链：不同文件名是两份不同的文件，绝不互相比较。 */
    var prevOfFile = {}, countOfFile = {};
    for (i = 0; i < list.length; i++) {
      var en = list[i];
      var k = String(en.artifact.filename || "");
      en.prev = prevOfFile[k] || null;
      if (en.prev) {
        var ps = String(en.prev.artifact.sha256 || "");
        var cs = String(en.artifact.sha256 || "");
        if (isDigest(ps) && isDigest(cs)) en.sameAsPrev = (ps.toLowerCase() === cs.toLowerCase());
      }
      countOfFile[k] = (countOfFile[k] || 0) + 1;
      en.chainIndex = countOfFile[k];
      prevOfFile[k] = en;
    }
    var lastOfFile = {}, lastInMessageOfFile = {};
    for (i = 0; i < list.length; i++) {
      var kk = String(list[i].artifact.filename || "");
      list[i].chainLength = countOfFile[kk];
      list[i].showChain = false;
      lastOfFile[kk] = list[i];
      if (list[i].messageIndex >= 0) lastInMessageOfFile[kk] = list[i];
    }
    for (var key in lastOfFile) {
      if (!Object.prototype.hasOwnProperty.call(lastOfFile, key)) continue;
      lastOfFile[key].isNewest = true;
      /* 版本列表挂在**能画出来的那张卡**上：优先最新一版，若最新一版只存在于
         currentDocument（还没有对应消息），就退到消息里最新的那一版，避免链无处显示。 */
      var anchor = lastInMessageOfFile[key] || lastOfFile[key];
      if (anchor.chainLength > 1) anchor.showChain = true;
    }
    return { list: list, byId: byId };
  }
  function chainOfFile(hist, a) {
    if (!hist || !a) return [];
    var out = [];
    for (var i = 0; i < hist.list.length; i++) {
      if (String(hist.list[i].artifact.filename || "") === String(a.filename || "")) out.push(hist.list[i]);
    }
    return out;
  }

  /** 一行变更真相，只在本版存在**上一版**时出现。 */
  function changeNote(info) {
    if (!info || !info.prev) return null;
    if (info.sameAsPrev === true) {
      return { kind: "same", text: "内容与上一版相同：sha256 与上一版逐字一致（" + shortSha(info.artifact.sha256) + "），这次修订没有改变文件内容。" };
    }
    if (info.sameAsPrev === false) {
      return { kind: "diff", text: "较上一版有更新：sha256 " + shortSha(info.prev.artifact.sha256) + " → " + shortSha(info.artifact.sha256) + "。" };
    }
    return { kind: "unknown", text: "无法与上一版比对：任一侧缺少完整的 sha256，不做判断。" };
  }

  /** 版本历史列表：把**实际存在**的版本列出来（文件名 / 大小 / 摘要 / 修订号），不虚构。 */
  function versionList(hist, a) {
    var chain = chainOfFile(hist, a);
    var det = h("details", { class: "pbc-vers" });
    det.appendChild(h("summary", { text: "版本历史 · 共 " + chain.length + " 版" }));
    var ol = h("ol", {});
    chain.forEach(function (e) {
      var art = e.artifact;
      var bits = [];
      if (art.byteLength != null) bits.push(fmtBytes(art.byteLength));
      if (art.sha256) bits.push("sha256 " + shortSha(art.sha256));
      var vl = versionLabel(art);
      if (vl) bits.push(vl);
      if (e.sameAsPrev === true) bits.push("与上一版内容相同");
      else if (e.sameAsPrev === false) bits.push("较上一版有更新");
      if (e.isNewest) bits.push("最新一版");
      var li = h("li", { class: e.isNewest ? "cur" : null, text: "第 " + e.chainIndex + " 版 · " + (art.filename || "未命名") + " · " + bits.join(" · ") });
      ol.appendChild(li);
    });
    det.appendChild(ol);
    det.appendChild(h("span", { class: "pbc-verssrc", text: "版本号、大小与摘要均取自后端回读的 artifact 引用；本页不做推断。" }));
    return det;
  }

  /* --------------------------------------------------------- 挂载点与上下文 */
  var LIVE_ROOT = null;
  var CTX = null;
  var TOAST = function () {};
  var _renderTimer = null;
  var pendingOpen = null;

  function rerender(ctx) {
    if (!LIVE_ROOT) return;
    ctx = ctx || CTX;
    var key = ctx && ctx.state && ctx.state.key;
    /* 只重画本模块登记的两屏；用户已切到别的屏时不动（别的 lane 的屏由它自己画）。 */
    if (key === "chat") chatRender(LIVE_ROOT, ctx);
    else if (key === "conversations") conversationsRender(LIVE_ROOT, ctx);
  }
  function scheduleRender(ctx) {
    if (_renderTimer !== null) return;
    _renderTimer = setTimeout(function () { _renderTimer = null; rerender(ctx); }, 16);
  }

  function flowOf(ctx) {
    ctx = ctx || CTX;
    return (ctx && ctx.wordFlow) || (window.PB && window.PB.wordFlow) || null;
  }
  function nav(ctx, key) {
    if (ctx && typeof ctx.navigate === "function") ctx.navigate(key);
  }

  /* ------------------------------------------------------------ 状态仓 */
  /* 起始为空：没有历史会话、没有成果。会话只由用户真实操作与真实后端回执产生。 */
  var FALLBACK = {};

  function readPersistedActive() {
    var rec = null;
    try { if (window.PB && window.PB.state && window.PB.state.pbcActiveConv) rec = window.PB.state.pbcActiveConv; } catch (e) { rec = null; }
    if (rec && rec.conversationId) return rec;
    try {
      var raw = window.localStorage && window.localStorage.getItem("pbcActiveConv");
      if (raw) rec = JSON.parse(raw);
    } catch (e) { rec = null; }
    return (rec && rec.conversationId) ? rec : null;
  }
  function persistActive(cid, name, cursor, updatedAt) {
    var rec = { conversationId: cid, name: name || "", cursor: cursor || "", updatedAt: updatedAt || null };
    try { if (window.PB && window.PB.state) window.PB.state.pbcActiveConv = rec; } catch (e) { /* 忽略 */ }
    try { if (window.localStorage) window.localStorage.setItem("pbcActiveConv", JSON.stringify(rec)); } catch (e) { /* 存储不可用则跳过，不谎称已持久化 */ }
  }
  function clearPersistedActive() {
    try { if (window.PB && window.PB.state) window.PB.state.pbcActiveConv = null; } catch (e) { /* 忽略 */ }
    try { if (window.localStorage) window.localStorage.removeItem("pbcActiveConv"); } catch (e) { /* 忽略 */ }
  }

  function ensureStore(ctx) {
    ctx = ctx || CTX || {};
    var holder = (ctx.state && typeof ctx.state === "object") ? ctx.state : FALLBACK;
    if (!holder.__pbcChat) {
      var persisted = readPersistedActive();
      holder.__pbcChat = {
        view: "home",
        activeCid: null,
        convs: {},        // cid -> {cid,name,createdAt,updatedAt,archived,messageCount}
        messages: {},     // cid -> [msg]
        cursors: {},      // cid -> headCursor
        traces: {},       // cid -> { userClientId: [lines] }
        currentDoc: {},   // cid -> artifact ref | null
        models: {},       // cid -> {model, provider}（来自 run_started 事件）
        homeError: null,  // 首页发送失败时刻的诚实说明（常驻，非一闪而过的 toast）
        drafts: {},       // key -> string
        loading: {},      // cid -> bool
        loadError: {},    // cid -> {code,message,retryable}
        busy: {},         // cid -> bool
        handles: {},      // cid -> {cancel}
        list: null,       // 真实会话列表
        listLoading: false,
        listError: null,
        query: "",
        filter: "active"
      };
      if (persisted) { holder.__pbcChat.activeCid = persisted.conversationId; holder.__pbcChat.view = "conversation"; }
    }
    return holder.__pbcChat;
  }
  function store() { return ensureStore(CTX); }

  /* -------------------------------------------------------- 数据归一化 */
  function normalizeArtifact(a) {
    if (!a || typeof a !== "object") return null;
    var id = typeof a.artifactId === "string" ? a.artifactId : "";
    var fn = typeof a.filename === "string" ? a.filename : "";
    if (!id || !fn) return null;                    /* 缺一即不算"有文件" */
    return {
      artifactId: id,
      filename: fn,
      sha256: typeof a.sha256 === "string" ? a.sha256 : "",
      byteLength: (typeof a.byteLength === "number") ? a.byteLength : null,
      editRevision: (typeof a.editRevision === "number") ? a.editRevision : null,
      taskRevision: (typeof a.taskRevision === "number") ? a.taskRevision : null,
      artifactVersion: (typeof a.artifactVersion === "number") ? a.artifactVersion : null,
      downloadPath: (typeof a.downloadPath === "string" && a.downloadPath) ? a.downloadPath : ""
    };
  }
  function normalizeMessage(m) {
    if (!m || typeof m !== "object") return null;
    var role = m.role === "user" ? "user" : (m.role === "assistant" ? "assistant" : (m.role === "sys" ? "sys" : "assistant"));
    return {
      messageId: (typeof m.messageId === "string") ? m.messageId : null,
      clientId: (typeof m.clientId === "string") ? m.clientId : null,
      role: role,
      text: (typeof m.text === "string") ? m.text : "",
      state: String(m.state || ""),
      phase: String(m.phase || ""),
      seq: m.seq,
      error: (m.error && typeof m.error === "object") ? m.error
        : (typeof m.error === "string" && m.error ? { code: "error", message: m.error, retryable: true } : null),
      artifact: normalizeArtifact(m.artifact),
      trace: null
    };
  }
  function isRunning(m) {
    if (!m) return false;
    var s = String(m.state || ""), p = String(m.phase || "");
    return s === "received" || s === "streaming" || p === "accepted" || p === "running";
  }

  function applyConversation(cid, data, attachTrace) {
    var st = store();
    var c = st.convs[cid] || (st.convs[cid] = { cid: cid, name: "对话" });
    c.cid = cid;
    if (data.name) c.name = data.name;
    if (data.createdAt) c.createdAt = data.createdAt;
    if (data.updatedAt) c.updatedAt = data.updatedAt;
    c.archived = !!data.archived;

    var msgs = (data.messages || []).map(normalizeMessage).filter(Boolean);
    if (attachTrace) {
      var tr = st.traces[cid] || {};
      var lastUserClientId = null;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m.role === "user") lastUserClientId = m.clientId;
        else if (m.role === "assistant" && lastUserClientId && tr[lastUserClientId]) m.trace = tr[lastUserClientId];
      }
    }
    st.messages[cid] = msgs;
    c.messageCount = msgs.length;
    st.cursors[cid] = data.headCursor || st.cursors[cid] || "";
    st.currentDoc[cid] = normalizeArtifact(data.currentDocument);
    persistActive(cid, c.name, st.cursors[cid], c.updatedAt);
  }

  /* ---------------------------------------------------------- 加载与轮询 */
  function loadConversation(ctx, cid) {
    var wf = flowOf(ctx);
    var st = store();
    if (!wf || typeof wf.getConversation !== "function" || !wf.available()) {
      st.loading[cid] = false;
      st.loadError[cid] = { code: "host_absent", message: "当前没有连接到电脑端服务，无法读取会话。", retryable: false };
      scheduleRender(ctx);
      return;
    }
    st.loading[cid] = true;
    st.loadError[cid] = null;
    scheduleRender(ctx);
    wf.getConversation(cid).then(function (res) {
      st.loading[cid] = false;
      if (!res.ok) {
        var err = res.error || { code: "error", message: "读取会话失败。", retryable: true };
        /* 自愈：本地"记忆"指向的会话在服务端已不存在（后端被清空、换了运行目录、
           或会话被删）。此时**不能**把用户卡在一张报错页上——清掉本地记忆、回到
           首页空态，让用户直接重新开始。这才是"干净起点"该有的行为。 */
        if (err.code === "conversation_not_found" || err.status === 404) {
          st.loadError[cid] = null;
          st.messages[cid] = undefined;
          if (st.activeCid === cid) st.activeCid = null;
          st.view = "home";
          clearPersistedActive();
          scheduleRender(ctx);
          return;
        }
        st.loadError[cid] = err;
        scheduleRender(ctx);
        return;
      }
      applyConversation(cid, res.data, true);
      scheduleRender(ctx);
      resumeTrackingIfRunning(ctx, cid);
    });
  }

  function loadList(ctx) {
    var wf = flowOf(ctx);
    var st = store();
    if (!wf || typeof wf.listConversations !== "function" || !wf.available()) {
      st.listError = { code: "host_absent", message: "当前没有连接到电脑端服务，无法读取会话列表。", retryable: false };
      scheduleRender(ctx);
      return;
    }
    if (st.listLoading) return;
    st.listLoading = true;
    st.listError = null;
    wf.listConversations(true).then(function (res) {
      st.listLoading = false;
      if (!res.ok) { st.listError = res.error || { code: "error", message: "读取会话列表失败。", retryable: true }; scheduleRender(ctx); return; }
      var arr = (res.data && res.data.conversations) || [];
      st.list = arr.slice().sort(function (a, b) {
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      });
      scheduleRender(ctx);
    });
  }

  function ensureLoaded(ctx, st) {
    var cid = st.activeCid;
    if (!cid) return;
    if (st.messages[cid] !== undefined) return;   /* 已有真实消息 */
    if (st.loading[cid]) return;
    if (st.loadError[cid]) return;                /* 等用户点重试 */
    loadConversation(ctx, cid);
  }

  /* 页面重开/切回时，若后端仍在跑，接着看 */
  function resumeTrackingIfRunning(ctx, cid) {
    var st = store();
    if (st.handles[cid]) return;
    var list = st.messages[cid] || [];
    var idx = -1;
    for (var i = list.length - 1; i >= 0; i--) { if (list[i].role === "assistant") { idx = i; break; } }
    if (idx < 0) return;
    var asst = list[idx];
    if (!isRunning(asst)) return;
    var user = null;
    for (var j = idx - 1; j >= 0; j--) { if (list[j].role === "user") { user = list[j]; break; } }
    if (!asst.trace) asst.trace = [];
    st.traces[cid] = st.traces[cid] || {};
    if (user && user.clientId) st.traces[cid][user.clientId] = asst.trace;
    st.busy[cid] = true;
    watchTurn(ctx, st, cid, st.cursors[cid] || "", asst, user);
  }

  function pushTrace(msg, line) {
    if (!msg || !line) return;
    if (!msg.trace) msg.trace = [];
    if (msg.trace[msg.trace.length - 1] === line) return;
    msg.trace.push(line);
  }

  function handleEvent(st, cid, asstMsg, ev) {
    if (!ev) return;
    var d = ev.detail || {};
    switch (ev.kind) {
      case "message_accepted":
        pushTrace(asstMsg, "已接收消息"); break;
      case "run_requested":
        pushTrace(asstMsg, "已加入执行队列"); break;
      case "run_started":
        st.models[cid] = { model: d.model || null, provider: d.provider || null };
        pushTrace(asstMsg, "开始运行 · " + (d.model || "模型") + (d.provider ? "（" + d.provider + "）" : "") + (d.attempt ? " · 第 " + d.attempt + " 次尝试" : ""));
        break;
      case "assistant_turn":
        if (typeof ev.text === "string" && ev.text) {
          asstMsg.text = ev.text;
          pushTrace(asstMsg, "助手：" + firstLine(ev.text, 60));
        } else {
          pushTrace(asstMsg, "助手回合（" + (d.stopReason || "…") + "）");
        }
        if (d.toolCallCount) pushTrace(asstMsg, "计划调用 " + d.toolCallCount + " 个工具");
        break;
      case "tool_invoked":
        pushTrace(asstMsg, "调用工具：" + toolLine(d)); break;
      case "tool_result":
        pushTrace(asstMsg, "工具完成：" + toolLine(d)); break;
      case "tool_failed":
        pushTrace(asstMsg, "工具失败：" + toolLine(d)); break;
      case "run_completed":
        asstMsg.state = "completed"; asstMsg.phase = "completed";
        pushTrace(asstMsg, "本轮完成" + (typeof d.turns === "number" ? " · " + d.turns + " 轮" : "") + (typeof d.byteLength === "number" ? " · " + fmtBytes(d.byteLength) : ""));
        break;
      case "run_failed":
        asstMsg.state = "failed"; asstMsg.phase = "failed";
        asstMsg.error = {
          code: d.code || "run_failed",
          message: d.detail || d.reason || "执行失败。",
          retryable: d.retryable !== false
        };
        pushTrace(asstMsg, "执行失败：" + (d.code || "run_failed"));
        break;
      case "run_cancelled":
        asstMsg.state = "cancelled"; asstMsg.phase = "cancelled";
        pushTrace(asstMsg, "已取消");
        break;
      default:
        if (ev.kind) pushTrace(asstMsg, String(ev.kind));
    }
  }

  function toolLine(d) {
    d = d || {};
    var s = d.tool || "工具";
    var bits = [];
    if (d.title) bits.push(firstLine(d.title, 40));
    if (typeof d.paragraphCount === "number") bits.push(d.paragraphCount + " 段");
    if (d.code) bits.push(d.code + (d.detail ? "：" + firstLine(d.detail, 60) : ""));
    if (d.artifactId) bits.push("产物 " + String(d.artifactId).slice(0, 12) + "…");
    if (typeof d.byteLength === "number") bits.push(fmtBytes(d.byteLength));
    if (typeof d.sha256 === "string" && d.sha256) bits.push("sha " + d.sha256.slice(0, 8) + "…");
    return s + (bits.length ? " · " + bits.join(" · ") : "");
  }

  function handlePending(st, cid, asstMsg, userMsg, pending) {
    if (!pending || !pending.length) return;
    var a = null, u = null;
    for (var i = 0; i < pending.length; i++) {
      var p = normalizeMessage(pending[i]);
      if (!p) continue;
      if (p.role === "assistant") a = p;
      else if (p.role === "user") u = p;
    }
    if (u && userMsg) {
      userMsg.state = u.state || userMsg.state;
      userMsg.phase = u.phase || userMsg.phase;
      if (u.messageId) userMsg.messageId = u.messageId;
    }
    if (a && asstMsg) {
      asstMsg.state = a.state || asstMsg.state;
      asstMsg.phase = a.phase || asstMsg.phase;
      /* pending 的 assistant.text 在运行中多为空，别用它清掉已有增量文本 */
      if (a.text) asstMsg.text = a.text;
    }
  }

  function watchTurn(ctx, st, cid, cursor, asstMsg, userMsg) {
    var wf = flowOf(ctx);
    if (!wf || typeof wf.trackTurn !== "function") {
      if (asstMsg) {
        asstMsg.state = "failed"; asstMsg.phase = "failed";
        asstMsg.error = { code: "no_track", message: "当前环境无法跟踪运行进度。", retryable: false };
      }
      st.busy[cid] = false;
      scheduleRender(ctx);
      return;
    }
    if (st.handles[cid]) { try { st.handles[cid].cancel(); } catch (e) { /* 忽略 */ } }
    st.busy[cid] = true;

    var handle = wf.trackTurn(cid, cursor, {
      onEvent: function (ev) { handleEvent(st, cid, asstMsg, ev); scheduleRender(ctx); },
      onPending: function (pending) { handlePending(st, cid, asstMsg, userMsg, pending); },
      onCursor: function (cur) {
        if (typeof cur === "string" && cur) {
          st.cursors[cid] = cur;
          var cc = st.convs[cid];
          persistActive(cid, cc && cc.name, cur, cc && cc.updatedAt);
        }
      },
      onFinal: function (conv) {
        st.handles[cid] = null;
        st.busy[cid] = false;
        applyConversation(cid, conv, true);
        announceFinal(st, cid);
        rerender(ctx);
      },
      onError: function (err) {
        st.handles[cid] = null;
        st.busy[cid] = false;
        if (asstMsg && asstMsg.state !== "completed" && asstMsg.state !== "cancelled") {
          asstMsg.state = "failed"; asstMsg.phase = "failed";
          asstMsg.error = err || { code: "track_error", message: "读取运行进度失败。", retryable: true };
          pushTrace(asstMsg, "读取进度失败：" + ((err && err.message) || "原因未知"));
        }
        TOAST((err && err.message) || "与电脑端的连接中断。");
        rerender(ctx);
      }
    });
    st.handles[cid] = handle;
  }

  function announceFinal(st, cid) {
    var list = st.messages[cid] || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].role !== "assistant") continue;
      var m = list[i];
      if (m.state === "completed" && m.artifact) { TOAST("已完成：" + m.artifact.filename); return; }
      if (m.state === "completed") { TOAST("本轮已完成。"); return; }
      if (m.state === "failed") { TOAST("执行失败：" + ((m.error && m.error.message) || "原因未知")); return; }
      if (m.state === "cancelled") { TOAST("已取消。"); return; }
      return;
    }
  }

  /* ------------------------------------------------------------ 发送 */
  function sendFailure(ctx, st, toast, message) {
    st.homeError = { code: "send_failed", message: message, retryable: true };
    TOAST(message);
    rerender(ctx);
  }

  function ensureAndSend(ctx, st, toast, text) {
    var wf = flowOf(ctx);
    if (!wf || typeof wf.sendMessage !== "function" || !wf.available()) {
      sendFailure(ctx, st, toast, "当前没有连接到电脑端服务，无法发送消息。");
      return;
    }
    st.homeError = null;
    var clientId = (typeof wf.newClientId === "function") ? wf.newClientId("ui") : uid("ui");
    var reuseCid = (st.view === "conversation") ? st.activeCid : null;

    if (reuseCid) { sendNow(ctx, st, toast, reuseCid, text, clientId); return; }

    var name = firstLine(text, 24) || "新对话";
    wf.createConversation(name).then(function (res) {
      if (!res.ok) {
        sendFailure(ctx, st, toast, "新建会话失败：" + ((res.error && res.error.message) || "原因未知"));
        return;
      }
      var d = res.data || {};
      if (!d.conversationId) {
        sendFailure(ctx, st, toast, "新建会话失败：服务端没有返回会话编号。");
        return;
      }
      var cid = d.conversationId;
      st.activeCid = cid;
      st.view = "conversation";
      st.convs[cid] = { cid: cid, name: d.name || name, createdAt: d.createdAt, archived: false, messageCount: 0 };
      st.messages[cid] = st.messages[cid] || [];
      st.cursors[cid] = d.headCursor || "";
      persistActive(cid, st.convs[cid].name, st.cursors[cid]);
      sendNow(ctx, st, toast, cid, text, clientId);
    });
  }

  function sendNow(ctx, st, toast, cid, text, clientId) {
    var wf = flowOf(ctx);
    /* 从**发送前**的游标开始读：这样本轮的 message_accepted / run_requested /
       run_started（含 provider/model）不会被 POST 回执里那个"已过掉"的游标跳过去。 */
    var preCursor = st.cursors[cid] || "";
    var list = st.messages[cid] = st.messages[cid] || [];
    var userMsg = { messageId: null, clientId: clientId, role: "user", text: text, state: "received", phase: "accepted", error: null, artifact: null, trace: null, local: true };
    var asstMsg = { messageId: null, clientId: clientId + "-assistant", role: "assistant", text: "", state: "streaming", phase: "running", error: null, artifact: null, trace: [], local: true };
    list.push(userMsg);
    list.push(asstMsg);
    st.traces[cid] = st.traces[cid] || {};
    st.traces[cid][clientId] = asstMsg.trace;
    st.busy[cid] = true;
    rerender(ctx);

    wf.sendMessage(cid, text, clientId).then(function (res) {
      if (!res.ok) {
        asstMsg.state = "failed"; asstMsg.phase = "failed";
        asstMsg.error = res.error || { code: "send_failed", message: "发送失败。", retryable: true };
        st.busy[cid] = false;
        TOAST((res.error && res.error.message) || "发送失败");
        rerender(ctx);
        return;
      }
      var d = res.data || {};
      if (d.messageId) userMsg.messageId = d.messageId;
      userMsg.state = d.state || userMsg.state;
      userMsg.phase = d.phase || userMsg.phase;
      if (d.duplicate) pushTrace(asstMsg, "服务端判定为重复提交（幂等命中），不会新建任务");
      watchTurn(ctx, st, cid, preCursor, asstMsg, userMsg);
      scheduleRender(ctx);
    });
  }

  function cancelTurn(ctx, st, cid, toast) {
    var wf = flowOf(ctx);
    var list = st.messages[cid] || [];
    var userMsg = null;
    for (var i = list.length - 1; i >= 0; i--) { if (list[i].role === "user") { userMsg = list[i]; break; } }
    var mid = userMsg && userMsg.messageId;
    if (wf && typeof wf.cancelMessage === "function" && mid) {
      TOAST("正在请求取消…");
      wf.cancelMessage(cid, mid).then(function (res) {
        if (!res.ok) TOAST("取消失败：" + ((res.error && res.error.message) || "原因未知"));
        else TOAST("已请求取消。");
      });
    } else {
      TOAST("已停止本页面的等待（电脑端任务未获取消请求）。");
    }
    if (st.handles[cid]) { try { st.handles[cid].cancel(); } catch (e) { /* 忽略 */ } st.handles[cid] = null; }
    st.busy[cid] = false;
    var asst = null;
    for (var j = list.length - 1; j >= 0; j--) { if (list[j].role === "assistant") { asst = list[j]; break; } }
    if (asst && isRunning(asst)) {
      asst.state = "cancelled"; asst.phase = "cancelled";
      pushTrace(asst, "已请求取消（等待电脑端确认）");
    }
    rerender(ctx);
  }

  /* ------------------------------------------------------------ 打开产物 */
  /* 宿主保存回执：window.PotbotBridgeResult(ok, message)，由原生经 evaluateJavascript 调用。 */
  window.PotbotBridgeResult = function (ok, message) {
    var cb = pendingOpen;
    if (typeof cb === "function") {
      pendingOpen = null;
      cb(ok === true, String(message == null ? "" : message));
    }
  };

  function downloadPathFor(a, conv) {
    if (a.downloadPath) return a.downloadPath;
    if (conv && conv.cid) {
      return "/api/conversations/" + encodeURIComponent(conv.cid) + "/documents/" + encodeURIComponent(a.artifactId) + "/download";
    }
    return "";
  }

  function openArtifact(a, conv, toast, btn) {
    var native = window.PotbotNative;
    if (!native || typeof native.saveDocx !== "function") {
      toast("这个环境暂不支持在应用内打开文件。");
      return;
    }
    var path = downloadPathFor(a, conv);
    if (!path) { toast("缺少下载路径，无法打开。"); return; }
    if (btn) btn.disabled = true;
    pendingOpen = function (ok, message) {
      if (btn) btn.disabled = false;
      if (ok) toast("已保存到手机：" + (message || a.filename));
      else toast("保存未完成：" + (message || "原因未知"));
    };
    try {
      native.saveDocx(path, a.filename, a.sha256, (a.byteLength == null ? 0 : a.byteLength));
      toast("正在保存到手机…");
    } catch (e) {
      pendingOpen = null;
      if (btn) btn.disabled = false;
      toast("调用手机保存失败：" + ((e && e.message) || e));
    }
  }

  /**
   * 产物卡：文件名 / 大小 / 版本行 / sha256 短码 + 打开。
   * 当本版存在**上一版**时，附一行变更真相（摘要一致 = 内容其实没变，如实说）。
   * 当本版是其版本链的最新一版且链上不止一版时，展开版本历史（只列真实存在的版本）。
   */
  function artifactCard(a, conv, toast, info, hist) {
    var card = h("div", { class: "pbc-file" });
    card.appendChild(h("span", { class: "pbc-fileicon", text: extLabel(a.filename) }));
    var main = h("div", { class: "pbc-filemain" });
    main.appendChild(h("span", { class: "pbc-title", text: a.filename }));
    var bits = [];
    if (a.byteLength != null) bits.push(fmtBytes(a.byteLength));
    var vl = versionLabel(a);
    if (vl) bits.push(vl);
    if (a.sha256) bits.push("sha256 " + a.sha256.slice(0, 8) + "…");
    if (bits.length) main.appendChild(h("span", { class: "pbc-mini", text: bits.join(" · ") }));

    var note = changeNote(info);
    if (note) main.appendChild(h("span", { class: "pbc-versnote " + note.kind, text: note.text }));

    if (info && hist && info.showChain) main.appendChild(versionList(hist, a));

    card.appendChild(main);
    var open = h("button", { class: "pbc-fileopen", "aria-label": "打开 " + a.filename, text: "打开" });
    open.addEventListener("click", function () { openArtifact(a, conv, toast, open); });
    card.appendChild(open);
    return card;
  }

  /* ------------------------------------------------------------ 顶栏 */
  function makeToast(screen) {
    var t = h("div", { class: "pbc-toast", role: "status", "aria-live": "polite" });
    screen.appendChild(t);
    var timer = null;
    return function (msg) {
      t.textContent = msg; t.classList.add("show");
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { t.classList.remove("show"); }, 2400);
    };
  }

  function newConversation(ctx, st) {
    clearPersistedActive();
    st.activeCid = null;
    st.view = "home";
    rerender(ctx);
  }

  function openConversation(ctx, st, cid, name) {
    st.activeCid = cid;
    st.view = "conversation";
    if (!st.convs[cid]) st.convs[cid] = { cid: cid, name: name || "对话" };
    if (name) st.convs[cid].name = name;
    persistActive(cid, st.convs[cid].name, st.cursors[cid]);
    if (ctx && typeof ctx.navigate === "function" && ctx.state && ctx.state.key === "chat") rerender(ctx);
    else nav(ctx, "chat");
  }

  function renderHead(screen, ctx, st, toast) {
    var head = h("header", { class: "pbc-head" });
    if (st.view === "conversation") {
      var back = h("button", { class: "pbc-back", "aria-label": "返回", text: "‹ 返回" });
      back.addEventListener("click", function () { st.view = "home"; rerender(ctx); });
      head.appendChild(back);
      var conv = st.convs[st.activeCid];
      head.appendChild(h("span", { class: "pbc-headtitle", text: (conv && conv.name) || "对话" }));
      var all = h("button", { class: "pbc-iconbtn", "aria-label": "全部对话", text: "全部" });
      all.addEventListener("click", function () { nav(ctx, "conversations"); });
      var add = h("button", { class: "pbc-iconbtn", "aria-label": "新建对话", text: "＋" });
      add.addEventListener("click", function () { newConversation(ctx, st); });
      head.appendChild(all); head.appendChild(add);
    } else {
      head.appendChild(h("span", { class: "pbc-wordmark", text: "potbot" }));
      var all2 = h("button", { class: "pbc-iconbtn", "aria-label": "全部对话", text: "全部" });
      all2.addEventListener("click", function () { nav(ctx, "conversations"); });
      head.appendChild(all2);
    }
    return head;
  }

  /* ===================== 屏一：chat（对话）============================= */

  function chatRender(root, ctx) {
    injectStyle();
    LIVE_ROOT = root;
    CTX = ctx;
    clear(root);
    var st = ensureStore(ctx);
    var screen = h("div", { class: "pbc-screen" });
    var toast = makeToast(screen);
    TOAST = toast;

    screen.appendChild(renderHead(screen, ctx, st, toast));

    var scroll = h("div", { class: "pbc-scroll", tabindex: "-1" });
    if (st.view === "conversation") renderConversation(scroll, ctx, st, toast, screen);
    else renderHome(scroll, ctx, st, toast, screen);
    screen.appendChild(scroll);

    screen.appendChild(renderComposer(screen, ctx, st, toast));
    root.appendChild(screen);
    scroll.scrollTop = scroll.scrollHeight;

    ensureLoaded(ctx, st);
    /* 列表只自动拉一次：失败时保留错误面板等用户重试，避免"渲染→再拉→再渲染"的死循环。 */
    if (st.view === "home" && st.list === null && !st.listLoading && !st.listError) loadList(ctx);
  }

  /* ------------------------------------------------------------ 首页 */
  function renderHome(scroll, ctx, st, toast, screen) {
    var hero = h("section", { class: "pbc-home" });
    hero.appendChild(h("h1", { text: "把任务交给我" }));
    hero.appendChild(h("p", { class: "pbc-note", text: "说出你想要的文件，剩下的我来做。" }));
    var eg = h("div", { class: "pbc-eg" });
    ["写一份本周工作周报", "整理一份会议纪要", "起草一份活动通知"].forEach(function (t) {
      eg.appendChild(h("span", {
        text: t,
        role: "button",
        tabindex: "0",
        "aria-label": "示例任务：" + t,
        on: { click: function () { ensureAndSend(ctx, st, toast, t); } }
      }));
    });
    hero.appendChild(eg);
    scroll.appendChild(hero);

    if (st.homeError) {
      scroll.appendChild(errorPanel("无法开始这次任务", st.homeError, [
        { label: "知道了", primary: false, on: function () { st.homeError = null; rerender(ctx); } }
      ]));
    }

    /* 记忆：上次那个会话（PB.state / 持久化里记着 conversationId） */
    if (st.activeCid) {
      var conv = st.convs[st.activeCid] || { cid: st.activeCid, name: "上次的对话" };
      var resume = h("button", { class: "pbc-resume", "aria-label": "继续上次对话 " + (conv.name || "") });
      var main = h("span", { class: "pbc-rowmain" });
      main.appendChild(h("span", { class: "pbc-title", text: "继续上次对话" }));
      main.appendChild(h("span", { class: "pbc-mini", text: conv.name || "（未命名）" }));
      resume.appendChild(main);
      resume.appendChild(h("span", { class: "pbc-chev", text: "›" }));
      resume.addEventListener("click", function () { openConversation(ctx, st, st.activeCid, conv.name); });
      scroll.appendChild(resume);
    }

    /* 真实会话列表 */
    var head = h("div", { class: "pbc-sectionhead" }, [h("h2", { text: "最近对话" })]);
    var more = h("button", { text: "全部 ›" });
    more.addEventListener("click", function () { nav(ctx, "conversations"); });
    head.appendChild(more);
    scroll.appendChild(head);

    if (st.listError) {
      scroll.appendChild(errorPanel("读取会话列表失败", st.listError, [{ label: "重试", primary: false, on: function () { st.list = null; st.listError = null; loadList(ctx); } }]));
      return;
    }
    if (!st.list) { scroll.appendChild(loadingNode("正在读取会话…")); return; }
    var active = st.list.filter(function (c) { return !c.archived; });
    if (!active.length) {
      scroll.appendChild(h("div", { class: "pbc-empty" }, [
        h("p", { class: "pbc-note", text: "还没有对话。在下方输入一句话即可开始。" })
      ]));
      return;
    }
    var rows = h("div", { class: "pbc-rows" });
    active.slice(0, 6).forEach(function (c) { rows.appendChild(convRow(c, function () { openConversation(ctx, st, c.conversationId, c.name); })); });
    scroll.appendChild(rows);
  }

  function convRow(c, onOpen) {
    var row = h("button", { class: "pbc-row", "aria-label": "打开对话 " + (c.name || "") });
    var main = h("span", { class: "pbc-rowmain" });
    main.appendChild(h("span", { class: "pbc-title", text: c.name || "（未命名）" }));
    var bits = [];
    if (typeof c.messageCount === "number") bits.push(c.messageCount + " 条消息");
    if (c.updatedAt) bits.push(shortTime(c.updatedAt));
    main.appendChild(h("span", { class: "pbc-mini", text: bits.join(" · ") || "空会话" }));
    row.appendChild(main);
    row.appendChild(h("span", { class: "pbc-chev", text: "›" }));
    row.addEventListener("click", onOpen);
    return row;
  }

  function shortTime(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var d = new Date(t);
    var now = new Date();
    var same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var hh = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    if (same) return hh;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hh;
  }

  /* ---------------------------------------------------------- 会话视图 */
  function renderConversation(scroll, ctx, st, toast, screen) {
    var cid = st.activeCid;
    if (!cid) { st.view = "home"; renderHome(scroll, ctx, st, toast, screen); return; }
    var conv = st.convs[cid] || { cid: cid, name: "对话" };

    if (st.loadError[cid]) {
      scroll.appendChild(errorPanel("读取会话失败", st.loadError[cid], [
        { label: "重试", primary: false, on: function () { st.loadError[cid] = null; st.messages[cid] = undefined; loadConversation(ctx, cid); } },
        { label: "开始新对话", primary: true, on: function () { newConversation(ctx, st); } }
      ]));
      return;
    }
    var list = st.messages[cid];
    if (list === undefined) { scroll.appendChild(loadingNode("正在读取会话…")); return; }
    if (!list.length) {
      scroll.appendChild(h("div", { class: "pbc-empty" }, [
        h("h2", { text: "新对话" }),
        h("p", { class: "pbc-note", text: "从一句话开始。同一个会话里的消息会连在一起。" })
      ]));
      return;
    }

    /* 版本史在**整段会话**范围内只算一次：消息里的真实引用 + currentDocument。 */
    var hist = versionHistory(st, cid);

    var doc = st.currentDoc[cid];
    if (doc) {
      var bar = h("div", { class: "pbc-docbar" });
      bar.appendChild(h("span", { class: "pbc-fileicon", text: extLabel(doc.filename) }));
      var dm = h("span", { class: "pbc-rowmain" });
      dm.appendChild(h("span", { class: "pbc-title", text: "当前文档 · " + doc.filename }));
      var dbits = [];
      if (doc.byteLength != null) dbits.push(fmtBytes(doc.byteLength));
      var dv = versionLabel(doc);
      if (dv) dbits.push(dv);
      dm.appendChild(h("span", { class: "pbc-mini", text: dbits.join(" · ") }));
      var dnote = changeNote(hist.byId[doc.artifactId]);
      if (dnote) dm.appendChild(h("span", { class: "pbc-versnote " + dnote.kind, text: dnote.text }));
      bar.appendChild(dm);
      scroll.appendChild(bar);
    }

    list.forEach(function (m) { scroll.appendChild(renderMessage(m, ctx, st, toast, screen, conv, hist)); });
  }

  function renderMessage(m, ctx, st, toast, screen, conv, hist) {
    var role = m.role === "user" ? "user" : (m.role === "sys" ? "sys" : "bot");
    var box = h("div", { class: "pbc-msg " + role });
    var target = box;
    if (role === "bot") { target = h("div", { class: "pbc-talk" }); box.appendChild(target); }

    var text = m.text || "";
    if (text) target.appendChild(document.createTextNode(text));

    var running = role === "bot" && isRunning(m);
    if (running) {
      if (!text) target.appendChild(document.createTextNode("正在思考…"));
      target.appendChild(h("span", { class: "pbc-caret", "aria-hidden": "true" }));
    }
    if (role !== "bot") return box;

    if (running) {
      var line = h("div", { class: "pbc-state warn", role: "status", "aria-live": "polite" });
      line.appendChild(h("span", { class: "pbc-dot" }));
      line.appendChild(h("span", { text: "正在处理…" }));
      var cb = h("button", { class: "pbc-btn pbc-btn-secondary", text: "停止" });
      cb.addEventListener("click", function () { cancelTurn(ctx, st, conv.cid, toast); });
      line.appendChild(cb);
      target.appendChild(line);
    } else if (m.state === "failed") {
      var em = h("div", { class: "pbc-state err" }, [(m.error && m.error.message) || "未能完成。"]);
      if (!m.error || m.error.retryable !== false) em.appendChild(retryBtn(m, ctx, st, toast, screen, conv));
      target.appendChild(em);
    } else if (m.state === "cancelled") {
      var cw = h("div", { class: "pbc-state" }, ["已取消"]);
      cw.appendChild(retryBtn(m, ctx, st, toast, screen, conv));
      target.appendChild(cw);
    } else if (m.state === "completed") {
      target.appendChild(h("div", { class: "pbc-state ok" }, ["已完成"]));
    } else if (m.state) {
      target.appendChild(h("div", { class: "pbc-state" }, ["状态：" + m.state]));
    }

    /* 模型 chip：run_started 里的 provider + model */
    var mm = st.models && st.models[conv.cid];
    if (mm && (mm.model || mm.provider) && (running || (m.trace && m.trace.length))) {
      target.appendChild(h("span", { class: "pbc-chip-model", text: (mm.model || "模型") + (mm.provider ? " · " + mm.provider : "") }));
    }

    if (m.artifact) {
      target.appendChild(artifactCard(m.artifact, conv, toast, hist ? hist.byId[m.artifact.artifactId] : null, hist));
    }

    if (m.trace && m.trace.length) {
      var label = running ? "正在执行" : (m.state === "cancelled" ? "已取消" : "执行过程");
      var det = h("details", { class: "pbc-process" });
      if (running) det.setAttribute("open", "");
      det.appendChild(h("summary", { text: label + " · " + m.trace.length + " 步" }));
      var ol = h("ol", {});
      m.trace.forEach(function (p) { ol.appendChild(h("li", { text: p })); });
      det.appendChild(ol);
      target.appendChild(det);
    }
    return box;
  }

  function retryBtn(m, ctx, st, toast, screen, conv) {
    var b = h("button", { class: "pbc-btn pbc-btn-secondary", text: "重试" });
    b.addEventListener("click", function () {
      var wf = flowOf(ctx);
      var cid = conv.cid;
      if (!wf || typeof wf.retryMessage !== "function") { toast("当前无法重试。"); return; }
      var list = st.messages[cid] || [];
      var idx = list.indexOf(m);
      var user = null;
      for (var i = idx - 1; i >= 0; i--) { if (list[i].role === "user") { user = list[i]; break; } }
      var mid = user && user.messageId;
      if (!mid) { toast("找不到可重试的用户消息。"); return; }
      b.disabled = true; b.textContent = "重试中…";
      wf.retryMessage(cid, mid).then(function (res) {
        b.disabled = false; b.textContent = "重试";
        if (!res.ok) { toast("重试失败：" + ((res.error && res.error.message) || "原因未知")); return; }
        /* 重试后由后端推进；重新拉一次权威状态，并继续跟踪 */
        st.messages[cid] = undefined;
        st.loadError[cid] = null;
        if (user && user.clientId && st.traces[cid]) st.traces[cid][user.clientId] = [];
        loadConversation(ctx, cid);
        toast("已请求重试。");
      });
    });
    return b;
  }

  /* ------------------------------------------------------------- 输入区 */
  function renderComposer(screen, ctx, st, toast) {
    var key = st.view === "conversation" && st.activeCid ? st.activeCid : "__new__";
    var wrap = h("div", { class: "pbc-composer" });
    var busy = st.view === "conversation" && st.activeCid && st.busy[st.activeCid];

    var bubble = h("div", { class: "pbc-inputbubble" });
    var ta = h("textarea", {
      class: "pbc-ta", rows: "1", maxlength: "1000",
      placeholder: st.view === "conversation" ? "继续说…" : "说点什么…",
      "aria-label": "发给 Potbot 的消息"
    });
    ta.value = st.drafts[key] || "";
    ta.addEventListener("input", function () {
      st.drafts[key] = ta.value;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 96) + "px";
      if (sendBtn) sendBtn.disabled = !ta.value.trim();
    });

    var sendBtn;
    if (busy) {
      sendBtn = h("button", { class: "pbc-send stop", "aria-label": "停止", text: "停止" });
      sendBtn.addEventListener("click", function () { cancelTurn(ctx, st, st.activeCid, toast); });
    } else {
      sendBtn = h("button", { class: "pbc-send", "aria-label": "发送", text: "↑" });
      sendBtn.disabled = !ta.value.trim();
      var doSend = function () {
        var text = ta.value.trim();
        if (!text) return;
        st.drafts[key] = "";
        ta.value = "";
        ta.style.height = "auto";
        ensureAndSend(ctx, st, toast, text);
      };
      sendBtn.addEventListener("click", doSend);
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
      });
    }
    bubble.appendChild(ta); bubble.appendChild(sendBtn);
    wrap.appendChild(bubble);
    wrap.appendChild(h("p", {
      class: "pbc-hint",
      text: busy ? "正在执行 · 可输入，发送按钮在完成后恢复" : "说出你的目标，我来把它做成文件。"
    }));
    return wrap;
  }

  /* ------------------------------------------------------------ 通用块 */
  function loadingNode(text) {
    var n = h("div", { class: "pbc-loading", role: "status", "aria-live": "polite" });
    n.appendChild(h("span", { class: "pbc-dot" }));
    n.appendChild(h("span", { text: text || "正在加载…" }));
    return n;
  }
  function errorPanel(title, err, actions) {
    var box = h("div", { class: "pbc-err" });
    box.appendChild(h("strong", { text: title }));
    box.appendChild(h("span", { text: (err && err.message) || "原因未知。" }));
    if (err && err.code) box.appendChild(h("span", { class: "pbc-badge", text: "错误码：" + err.code }));
    if (actions && actions.length) {
      var row = h("div", { class: "pbc-actions" });
      actions.forEach(function (a) {
        var b = h("button", { class: "pbc-btn " + (a.primary ? "pbc-btn-primary" : "pbc-btn-secondary"), text: a.label });
        b.addEventListener("click", a.on);
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    return box;
  }

  /* ===================== 屏二：conversations（会话列表）================ */
  function conversationsRender(root, ctx) {
    injectStyle();
    LIVE_ROOT = root;
    CTX = ctx;
    clear(root);
    var st = ensureStore(ctx);
    var screen = h("div", { class: "pbc-screen" });
    var toast = makeToast(screen);
    TOAST = toast;

    var head = h("header", { class: "pbc-head" });
    head.appendChild(h("span", { class: "pbc-wordmark", text: "全部对话" }));
    var add = h("button", { class: "pbc-iconbtn", "aria-label": "新建对话", text: "＋ 新建" });
    add.addEventListener("click", function () { newConversation(ctx, st); nav(ctx, "chat"); });
    head.appendChild(add);
    screen.appendChild(head);

    var scroll = h("div", { class: "pbc-scroll" });

    var search = h("div", { class: "pbc-search" });
    var input = h("input", { type: "search", placeholder: "搜索对话", "aria-label": "搜索对话" });
    input.value = st.query;
    input.addEventListener("input", function () { st.query = input.value; refresh(); });
    search.appendChild(h("span", { text: "⌕", "aria-hidden": "true" }));
    search.appendChild(input);
    scroll.appendChild(search);

    var filters = h("div", { class: "pbc-filters" });
    [["active", "进行中"], ["archived", "已归档"], ["all", "全部"]].forEach(function (f) {
      var b = h("button", { class: "pbc-filter", "aria-pressed": st.filter === f[0] ? "true" : "false", text: f[1] });
      b.addEventListener("click", function () { st.filter = f[0]; refresh(); });
      filters.appendChild(b);
    });
    scroll.appendChild(filters);

    var listWrap = h("div", {});
    scroll.appendChild(listWrap);
    var note = h("p", { class: "pbc-mini", text: "列表来自电脑端真实会话（GET /api/conversations）。归档与会话状态由后端给出。" });
    scroll.appendChild(note);
    screen.appendChild(scroll);
    root.appendChild(screen);

    refresh();
    if (st.list === null && !st.listLoading && !st.listError) loadList(ctx);

    function refresh() {
      clear(listWrap);
      if (st.listError) {
        listWrap.appendChild(errorPanel("读取会话列表失败", st.listError, [
          { label: "重试", primary: false, on: function () { st.list = null; st.listError = null; loadList(ctx); } }
        ]));
        return;
      }
      if (!st.list) { listWrap.appendChild(loadingNode("正在读取会话…")); return; }
      var q = (st.query || "").trim().toLowerCase();
      var items = st.list.filter(function (c) {
        if (st.filter === "active" && c.archived) return false;
        if (st.filter === "archived" && !c.archived) return false;
        if (!q) return true;
        return String(c.name || "").toLowerCase().indexOf(q) >= 0;
      });
      if (!items.length) {
        listWrap.appendChild(h("div", { class: "pbc-empty" }, [
          h("h2", { text: q ? "没有匹配的对话" : (st.filter === "archived" ? "没有已归档对话" : "还没有对话") }),
          h("p", { class: "pbc-note", text: q ? "换个关键词试试。" : "在对话页输入一句话即可开始。" })
        ]));
        return;
      }
      var rows = h("div", { class: "pbc-rows" });
      items.forEach(function (c) {
        var row = h("button", { class: "pbc-row", "aria-label": "打开对话 " + (c.name || "") });
        var main = h("span", { class: "pbc-rowmain" });
        main.appendChild(h("span", { class: "pbc-title", text: c.name || "（未命名）" }));
        if (c.archived) main.appendChild(h("span", { class: "pbc-archtag", text: "已归档" }));
        var bits = [];
        if (typeof c.messageCount === "number") bits.push(c.messageCount + " 条消息");
        if (c.updatedAt) bits.push(shortTime(c.updatedAt));
        main.appendChild(h("span", { class: "pbc-mini", text: bits.join(" · ") || "空会话" }));
        row.appendChild(main);
        row.appendChild(h("span", { class: "pbc-chev", text: "›" }));
        row.addEventListener("click", function () { openConversation(ctx, st, c.conversationId, c.name); });
        rows.appendChild(row);
      });
      listWrap.appendChild(rows);
    }
  }

  /* ------------------------------------------------------------- 注册 */
  window.PB.screens.chat = {
    title: "对话",
    render: function (root, ctx) {
      try { chatRender(root, ctx); }
      catch (e) {
        clear(root);
        var err = h("div", { class: "pbc-screen" });
        err.style.padding = "20px";
        err.appendChild(h("h1", { text: "对话" }));
        err.appendChild(h("p", { class: "pbc-note", text: "界面渲染异常：" + (e && e.message ? e.message : String(e)) }));
        root.appendChild(err);
      }
    }
  };

  window.PB.screens.conversations = {
    title: "会话列表",
    render: function (root, ctx) {
      try { conversationsRender(root, ctx); }
      catch (e) {
        clear(root);
        var err = h("div", { class: "pbc-screen" });
        err.style.padding = "20px";
        err.appendChild(h("h1", { text: "会话列表" }));
        err.appendChild(h("p", { class: "pbc-note", text: "界面渲染异常：" + (e && e.message ? e.message : String(e)) }));
        root.appendChild(err);
      }
    }
  };
})();
