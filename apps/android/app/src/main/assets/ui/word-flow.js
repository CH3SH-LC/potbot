/*
 * word-flow.js —— 「一句话 → 真实 Word 文档」的线性流程（经 window.PB.host）。
 *
 * 路由序列**逐字复用**旧电脑端页面 apps/demo/web/app.js 已在跑的那一条（不另发明端点）：
 *
 *   1. POST /api/documents            body {requestId, instruction}
 *        ← apps/demo/web/app.js:962  request('POST', ROUTES.documents, {requestId, instruction}, 30000)
 *        ← apps/demo/web/app.js:20   ROUTES.documents = '/api/documents'
 *        服务端：apps/demo/server/http.ts:1335-1371 → 202 {requestId, taskId, status}
 *
 *   2. GET  /api/tasks/:taskId        （每 1500ms 轮询一次，直到终态）
 *        ← apps/demo/web/app.js:1093 request('GET', ROUTES.task(rec.taskId), null, 12000)
 *        ← apps/demo/web/app.js:22   ROUTES.task = '/api/tasks/' + encodeURIComponent(id)
 *        ← apps/demo/web/app.js:1085 setInterval(tick, 1500)
 *        服务端：apps/demo/server/http.ts:1419-1430；响应形状见 apps/demo/server/jobs.ts:505-515
 *          { requestId, taskId, status, stage, draft?, artifact?, error? }
 *
 *   3. 产物下载路径由任务响应里的 artifact.downloadPath 给出（服务端生成，不拼路径）。
 *        服务端：apps/demo/server/kernel.ts:2406  downloadPath: ROUTES.download(artifactId)
 *        形状：  apps/demo/contracts.ts:77-86  ArtifactRef
 *
 * 诚实边界（本项目硬规则）：
 *   - 只有拿到**真实 artifact 引用**（有 artifactId + filename）才算成功；
 *     status=ready 但没有 artifact ⇒ 报失败，绝不把"完成"渲染成"有文件"。
 *   - failed / interrupted / unknown 一律如实报错，附服务端原话（error.message）。
 *   - 不轮询超时上限：到顶如实报"仍在进行"，不假装完成，也不无限占用页面。
 *   - 不伪造文件名、字节数或摘要。
 *
 * 对外面：window.PB.wordFlow
 *   available()                      -> boolean（PotbotHost 是否可用）
 *   stageText(stage, status)         -> 一行中文进度说明
 *   formatBytes(n)                   -> 人类可读体积
 *   start(goal, handlers)            -> { cancel() }
 *     handlers: { onProgress(step), onDone(artifact), onError(err) }
 *       step   = { status, stage, text, attempt }
 *       artifact = { artifactId, filename, byteSize, sizeText, sha256, downloadPath, version, revision }
 *       err    = { code, message, retryable }
 */
(function () {
  "use strict";

  var PB = (window.PB = window.PB || {});

  var POLL_INTERVAL_MS = 1500;
  var POLL_MAX_ATTEMPTS = 240;   /* ≈6 分钟；到顶如实报"仍在进行" */

  /* 阶段文案：TaskStage -> 一行中文（与 apps/demo/web/app.js:60-70 同口径） */
  var STAGE_TEXT = {
    accepted: "已接收，正在排队",
    model_pending: "正在生成正文",
    model_done: "正在校验内容",
    kernel_pending: "正在提交处理",
    kernel_done: "正在写入文件",
    materialized: "正在回读校验",
    ready: "文件已就绪",
    failed: "生成失败",
    interrupted: "任务已中断"
  };

  var STATUS_TEXT = {
    accepted: "已接收",
    running: "处理中",
    ready: "已完成",
    failed: "失败",
    interrupted: "已中断",
    unknown: "结果未知"
  };

  function host() {
    return (PB.host && PB.host.available) ? PB.host : null;
  }

  function available() { return !!host(); }

  function stageText(stage, status) {
    if (status === "failed") return "生成失败";
    if (status === "interrupted") return "任务已中断";
    if (status === "unknown") return "结果未知";
    return STAGE_TEXT[stage] || "正在处理";
  }

  function formatBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) return "";
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    return (v / (1024 * 1024)).toFixed(1) + " MB";
  }

  function newRequestId() {
    return "ui-req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function errOf(code, message, retryable) {
    return { code: code, message: message, retryable: retryable !== false };
  }

  /** 终局失败态的文案：优先用服务端原话，不编造原因。 */
  function terminalError(data) {
    var e = data && data.error;
    if (e && typeof e === "object") {
      return errOf(e.code || "task_failed", e.message || "生成失败。", e.retryable !== false);
    }
    if (typeof e === "string" && e) return errOf("task_failed", e, true);
    var status = String((data && data.status) || "unknown");
    if (status === "interrupted") {
      return errOf("task_interrupted", "任务已中断：电脑端服务可能重启过，未完成的生成不会被自动重放。", true);
    }
    if (status === "unknown") {
      return errOf("task_unknown", "电脑端不认识这个任务编号（可能是服务重启后丢失了在途记录）。", true);
    }
    return errOf("task_failed", "生成失败：" + status + "。", true);
  }

  /**
   * 把任务响应里的 artifact 归一化；没有真实引用就返回 null（fail-closed）。
   */
  function artifactOf(data) {
    var a = data && data.artifact;
    if (!a || typeof a !== "object") return null;
    var artifactId = typeof a.artifactId === "string" ? a.artifactId : "";
    var filename = typeof a.filename === "string" ? a.filename : "";
    if (!artifactId || !filename) return null;      /* 缺一即不算"有文件" */
    return {
      artifactId: artifactId,
      filename: filename,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : "",
      byteSize: (typeof a.byteLength === "number") ? a.byteLength : null,
      sizeText: formatBytes(a.byteLength),
      sha256: typeof a.sha256 === "string" ? a.sha256 : "",
      downloadPath: (typeof a.downloadPath === "string" && a.downloadPath)
        ? a.downloadPath
        : "/api/artifacts/" + encodeURIComponent(artifactId) + "/download",
      version: (typeof a.artifactVersion === "number") ? a.artifactVersion : null,
      revision: (typeof a.taskRevision === "number") ? a.taskRevision : null,
      taskId: (data && typeof data.taskId === "string") ? data.taskId : ""
    };
  }

  /**
   * 提交一个目标并跟踪到终态。
   *
   * @param {string} goal 用户写的自然语言目标
   * @param {{onProgress?:Function, onDone?:Function, onError?:Function}} handlers
   * @returns {{cancel:Function}} cancel() 只停止本页面的等待，**不**宣称任务已取消。
   */
  function start(goal, handlers) {
    var h = handlers || {};
    var instruction = String(goal == null ? "" : goal).trim();
    var cancelled = false;
    var timer = null;
    var attempts = 0;
    var taskId = null;

    function stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    }

    function emitProgress(status, stage) {
      if (cancelled) return;
      if (typeof h.onProgress === "function") {
        h.onProgress({
          status: status,
          stage: stage,
          text: stageText(stage, status),
          stageLabel: STATUS_TEXT[status] || status
        });
      }
    }

    function emitError(err) {
      if (cancelled) return;
      stop();
      if (typeof h.onError === "function") h.onError(err);
    }

    function emitDone(artifact) {
      if (cancelled) return;
      stop();
      if (typeof h.onDone === "function") h.onDone(artifact);
    }

    /* 终态判定 + 渲染：ready 必须带真实 artifact，否则按失败处理。返回 true = 已到终态。 */
    function settleTask(data) {
      var status = String((data && data.status) || "unknown");
      if (status === "ready") {
        var artifact = artifactOf(data);
        if (!artifact) {
          emitError(errOf("missing_artifact",
            "服务端报告已完成，但没有给出可下载的文件引用；不当作成功。", true));
          return true;
        }
        emitProgress("ready", "ready");
        emitDone(artifact);
        return true;
      }
      if (status === "failed" || status === "interrupted" || status === "unknown") {
        emitError(terminalError(data));
        return true;
      }
      /* accepted / running：继续轮询 */
      emitProgress(status, (data && data.stage) || status);
      return false;
    }

    function poll() {
      timer = null;
      if (cancelled) { stop(); return; }
      attempts += 1;
      if (attempts > POLL_MAX_ATTEMPTS) {
        stop();
        emitError(errOf("poll_timeout",
          "等待超过 " + Math.round((POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 60000) +
          " 分钟仍未结束；文件可能还在生成，请稍后重试。", true));
        return;
      }
      var h2 = host();
      if (!h2) {
        emitError(errOf("host_absent", "本地服务通道已断开，无法继续等待结果。", false));
        return;
      }
      h2.get("/api/tasks/" + encodeURIComponent(taskId)).then(function (res) {
        if (cancelled) return;
        if (!res.ok) {
          /* 单次读取失败不立即判死：网络抖动时继续轮询，直到到顶才如实报错。 */
          if (attempts >= POLL_MAX_ATTEMPTS) { emitError(errOf("task_unreadable", res.error.message, true)); return; }
          schedulePoll();
          return;
        }
        if (!settleTask(res.data)) schedulePoll();
      });
    }

    var h0 = host();
    if (!h0) {
      /* 没有通道：如实报错，绝不返回假成功。 */
      emitError(errOf("host_absent",
        "当前环境没有连接到电脑端服务，无法生成文件。", false));
      return { cancel: function () { cancelled = true; } };
    }
    if (!instruction) {
      emitError(errOf("empty_goal", "请先写下你的目标。", false));
      return { cancel: function () { cancelled = true; } };
    }

    var requestId = newRequestId();
    emitProgress("accepted", "accepted");

    /* 桥调用是**同步**的（见 apps/android/HOST-HTTP-BRIDGE.md §3）：那一行会冻住 JS
       直到响应回来（最长约 10 秒）。因此先让调用方把加载态画出来，再发这一枪。 */
    timer = setTimeout(function fireSubmit() {
      timer = null;
      if (cancelled) return;
      h0.post("/api/documents", { requestId: requestId, instruction: instruction }).then(function (res) {
        if (cancelled) return;
        if (!res.ok) {
          emitError(errOf(res.error.code || "submit_failed", res.error.message, res.error.retryable !== false));
          return;
        }
        var data = res.data;
        taskId = (data && typeof data.taskId === "string") ? data.taskId : "";
        if (!taskId) {
          emitError(errOf("missing_task_id", "服务端接受了请求，但没有返回任务编号；不当作已开始。", true));
          return;
        }
        emitProgress(String(data.status || "accepted"), "accepted");
        if (typeof data.status === "string" && data.status !== "accepted" && data.status !== "running") {
          /* 服务端可能直接回终态（幂等复用） */
          settleTask(data);
          return;
        }
        poll();      /* 立刻读一次，尽早把真实进度显示出来 */
      });
    }, 0);

    /* 轮询用「上一次回来之后再排下一次」的链，而不是 setInterval：
       同步桥调用可能比间隔还长，setInterval 会把回调堆起来反复冻结界面。 */
    function schedulePoll() {
      if (cancelled) { stop(); return; }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    return {
      cancel: function () {
        cancelled = true;
        stop();
      },
      requestId: function () { return requestId; }
    };
  }

  /* ===========================================================================
   * 多轮对话驱动（通用 agent 循环 /api/conversations/**）
   * ---------------------------------------------------------------------------
   * 与上面的 legacy `start`（一次性 /api/documents）并存：`start` 保留给外壳兜底，
   * 本段是对话屏真正使用的**真·多轮**通路。端点形状以 apps/demo/server/http.ts
   * 的 handleConversationRoute 为准，逐条实测过：
   *
   *   POST /api/conversations                    {name}            -> {conversationId,name,createdAt,headCursor}
   *   GET  /api/conversations?include_archived=1                   -> {conversations:[{conversationId,name,createdAt,updatedAt,archived,messageCount,lastEventSeq}]}
   *   POST /api/conversations/<cid>/messages     {text,clientId}   -> 202 {conversationId,messageId,state,phase,duplicate,cursor}
   *   GET  /api/conversations/<cid>/events?cursor=<cur>            -> {events:[{seq,eventId,at,kind,messageId,state,phase,text,detail}],cursor,more,pending:[message]}
   *   GET  /api/conversations/<cid>                                -> {...,messages:[message],headCursor,currentDocument:artifact|null}
   *   POST /api/conversations/<cid>/messages/<mid>/retry           -> 202 {...}
   *   POST /api/conversations/<cid>/messages/<mid>/cancel          -> 200 {...}
   *
   * message = {messageId,role,text,state,phase,seq,clientId,attempts,createdAt,updatedAt,error,artifact}
   * artifact = {artifactId,filename,sha256,byteLength,editRevision,taskRevision,artifactVersion,downloadPath}
   * 终止类事件：run_completed / run_failed / run_cancelled（判据见 conversation-host.ts）。
   *
   * 诚实边界：只渲染后端真实回执；读取失败如实报错，不伪造进度、不假装完成。
   * 轮询用「上一次回来之后再排下一次」的 setTimeout 链（原生调用同步阻塞，绝不用 setInterval）。
   * ======================================================================== */

  var CONV_ROOT = "/api/conversations";
  var TRACK_INTERVAL_MS = 1200;
  var TRACK_QUIET_PROBES = 3;
  var TRACK_MAX_TICKS = 900;        /* ≈18 分钟；到顶如实报"仍在进行" */

  var TERMINAL_RUN_KINDS = { run_completed: true, run_failed: true, run_cancelled: true };

  function enc(s) { return encodeURIComponent(String(s == null ? "" : s)); }

  function hostFail(code, message, retryable) {
    return { ok: false, data: null, error: errOf(code, message, retryable) };
  }

  function newClientId(prefix) {
    return (prefix || "ui") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function listConversations(includeArchived) {
    var h = host();
    if (!h) return Promise.resolve(hostFail("host_absent", "当前环境没有连接到电脑端服务，无法读取会话列表。", false));
    return h.get(CONV_ROOT + (includeArchived ? "?include_archived=true" : ""));
  }

  function createConversation(name) {
    var h = host();
    if (!h) return Promise.resolve(hostFail("host_absent", "当前环境没有连接到电脑端服务，无法新建会话。", false));
    return h.post(CONV_ROOT, { name: String(name == null ? "" : name) });
  }

  function sendMessage(cid, text, clientId) {
    var h = host();
    if (!h) return Promise.resolve(hostFail("host_absent", "当前环境没有连接到电脑端服务，无法发送消息。", false));
    return h.post(CONV_ROOT + "/" + enc(cid) + "/messages", { text: String(text == null ? "" : text), clientId: clientId });
  }

  function getConversation(cid) {
    var h = host();
    if (!h) return Promise.resolve(hostFail("host_absent", "当前环境没有连接到电脑端服务，无法读取会话。", false));
    return h.get(CONV_ROOT + "/" + enc(cid));
  }

  function getEvents(cid, cursor) {
    var h = host();
    if (!h) return Promise.resolve(hostFail("host_absent", "当前环境没有连接到电脑端服务，无法读取进度。", false));
    return h.get(CONV_ROOT + "/" + enc(cid) + "/events?cursor=" + enc(cursor == null ? "" : cursor));
  }

  function retryMessage(cid, messageId) {
    var h = host();
    if (!h) return Promise.resolve(hostFail("host_absent", "当前环境没有连接到电脑端服务，无法重试。", false));
    return h.post(CONV_ROOT + "/" + enc(cid) + "/messages/" + enc(messageId) + "/retry", {});
  }

  function cancelMessage(cid, messageId) {
    var h = host();
    if (!h) return Promise.resolve(hostFail("host_absent", "当前环境没有连接到电脑端服务，无法取消。", false));
    return h.post(CONV_ROOT + "/" + enc(cid) + "/messages/" + enc(messageId) + "/cancel", {});
  }

  /** 一条 assistant 消息是否已到终态（completed/failed/cancelled）。 */
  function messageTerminal(m) {
    if (!m || m.role !== "assistant") return false;
    var s = String(m.state || ""), p = String(m.phase || "");
    return s === "completed" || s === "failed" || s === "cancelled" ||
           p === "completed" || p === "failed" || p === "cancelled";
  }

  function conversationTerminal(conv) {
    var msgs = (conv && conv.messages) || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return messageTerminal(msgs[i]);
    }
    return false;
  }

  /**
   * 跟踪一轮运行：从 startCursor 起持续读事件，直到出现终止事件或消息进入终态。
   *
   * handlers:
   *   onEvent(ev)         每条**新**事件（按 seq 去重）
   *   onPending(messages) 当前在途消息快照
   *   onCursor(cursor)    已读到的游标（调用方据此持久化，多轮续读不重放）
   *   onFinal(conversation) 终局：**权威**会话对象（含 messages 与 currentDocument）
   *   onError(err)        读取失败 / 通道断开（{code,message,retryable}）
   *
   * @returns {{cancel:Function}} cancel() 停止本页面的轮询，不宣称任务已取消。
   */
  function trackTurn(cid, startCursor, handlers) {
    var hh = handlers || {};
    var cursor = (typeof startCursor === "string") ? startCursor : "";
    var stopped = false;
    var timer = null;
    var ticks = 0;
    var quiet = 0;
    var lastSeq = 0;

    function emit(name, arg) {
      var fn = hh[name];
      if (typeof fn !== "function") return;
      try { fn(arg); } catch (e) { if (window.console && console.error) console.error("[wordFlow.track] " + name, e); }
    }
    function stop() {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }
    function schedule(ms) {
      if (stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(tick, ms == null ? TRACK_INTERVAL_MS : ms);
    }
    function fail(err) { stop(); emit("onError", err); }

    function finalize() {
      var h = host();
      if (!h) { fail(errOf("host_absent", "本地服务通道已断开，无法读取最终结果。", false)); return; }
      h.get(CONV_ROOT + "/" + enc(cid)).then(function (res) {
        if (stopped) return;
        stop();
        if (!res.ok) { emit("onError", res.error); return; }
        emit("onFinal", res.data);
      });
    }

    function tick() {
      timer = null;
      if (stopped) return;
      ticks += 1;
      if (ticks > TRACK_MAX_TICKS) {
        fail(errOf("poll_timeout",
          "等待超过 " + Math.round((TRACK_MAX_TICKS * TRACK_INTERVAL_MS) / 60000) + " 分钟仍未结束；任务可能还在运行。", true));
        return;
      }
      var h = host();
      if (!h) { fail(errOf("host_absent", "本地服务通道已断开，无法继续等待结果。", false)); return; }

      h.get(CONV_ROOT + "/" + enc(cid) + "/events?cursor=" + enc(cursor)).then(function (res) {
        if (stopped) return;
        if (!res.ok) {
          fail(errOf((res.error && res.error.code) || "events_unreadable",
            (res.error && res.error.message) || "读取运行进度失败。", true));
          return;
        }
        var d = res.data || {};
        var events = d.events || [];
        var pending = d.pending || [];
        if (typeof d.cursor === "string" && d.cursor) cursor = d.cursor;
        emit("onCursor", cursor);          /* 让调用方记住"读到哪了"，多轮续读不重放 */

        var fresh = 0;
        var terminal = false;
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          if (ev && typeof ev.seq === "number") {
            if (ev.seq <= lastSeq) continue;
            lastSeq = ev.seq;
          }
          fresh += 1;
          emit("onEvent", ev);
          if (ev && TERMINAL_RUN_KINDS[ev.kind]) terminal = true;
        }
        emit("onPending", pending);

        if (d.more) { schedule(150); return; }            /* 还有更多事件：尽快续取 */
        if (terminal) { finalize(); return; }
        if (fresh > 0) { quiet = 0; schedule(); return; }

        /* 没有新事件、也没有在途消息：直接核对会话终态，避免漏终止事件时死等。 */
        quiet += 1;
        if (quiet >= TRACK_QUIET_PROBES) {
          quiet = 0;
          h.get(CONV_ROOT + "/" + enc(cid)).then(function (r2) {
            if (stopped) return;
            if (r2.ok && conversationTerminal(r2.data)) { stop(); emit("onFinal", r2.data); return; }
            schedule();
          });
          return;
        }
        schedule();
      });
    }

    schedule(0);

    return {
      cancel: function () { stop(); }
    };
  }

  PB.wordFlow = {
    available: available,
    stageText: stageText,
    formatBytes: formatBytes,
    start: start,
    STAGE_TEXT: STAGE_TEXT,
    POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    POLL_MAX_ATTEMPTS: POLL_MAX_ATTEMPTS,

    /* —— 多轮对话驱动（对话屏使用） —— */
    CONV_ROOT: CONV_ROOT,
    TRACK_INTERVAL_MS: TRACK_INTERVAL_MS,
    newClientId: newClientId,
    listConversations: listConversations,
    createConversation: createConversation,
    sendMessage: sendMessage,
    getConversation: getConversation,
    getEvents: getEvents,
    retryMessage: retryMessage,
    cancelMessage: cancelMessage,
    trackTurn: trackTurn,
    messageTerminal: messageTerminal,
    conversationTerminal: conversationTerminal
  };
})();
