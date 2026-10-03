/* bridge.js —— Potbot v6 手机内核桥（window.PB.bridge）
 *
 * 加载方式：file:///android_asset/ui/bridge.js（经典脚本，非模块；无 import/export、无 fetch）。
 * 设计依据：
 *   - apps/android/app/src/main/java/com/potbot/kernel/runtime/KernelLocalUiBridge.java
 *   - apps/android/app/src/main/java/com/potbot/demo/MainActivity.java
 *   - apps/android/MAINACTIVITY-KERNEL-WIRING.md
 *   - contracts/mobile-v1/types.ts（命令 / 事件结构）
 *
 * 真实原生面（MainActivity 注入，名字即 Java 方法名）：
 *   window.PotbotKernel.submit(origin, commandJson)     -> String（mobile-v1 事件 JSON 或拒绝 JSON）
 *   window.PotbotKernel.subscribe(origin)               -> String（{"status":"subscribed","subscriptionId":"sub-N"}）
 *   window.PotbotKernel.unsubscribe(origin, subId)      -> boolean
 *   window.PotbotKernel.cancel(origin, commandId)       -> boolean
 *   下行（宿主 → 页面）：window.PotbotKernelEvent(subscriptionId, eventJson)
 *   就绪（宿主 → 页面，可选）：window.PotbotKernelReady()
 *   origin 必须命中 Java 白名单：file:///android_asset / app://local / https://localhost
 *
 * 对外面（shell 通过 ctx.bridge 使用）：
 *   PB.bridge.available        —— 只读布尔：真实内核桥是否已就绪（有真实 submit 才算 true）
 *   PB.bridge.submit(op)       —— 提交一条命令，返回 Promise，解析为规范化「回执」对象
 *   PB.bridge.subscribe(fn)    —— 订阅事件，返回 { unsubscribe() }
 *   PB.bridge.cancel(id)       —— 中止在飞命令，返回 boolean
 *   PB.bridge.available        —— 只读布尔（=有真实 submit 才算 true）
 *   PB.bridge.source           —— 来源标签：'window.PotbotKernel' 或 '（无内核桥）'
 *   PB.bridge.mode             —— 'kernel' | 'none'
 *   PB.bridge.describe()       —— 一行状态文字
 *   PB.bridge.statusInfo()     —— 结构化状态对象
 *   PB.bridge.detect()         —— host 补挂后重新探测一次（返回 boolean）
 *   PB.bridge.refresh()        —— detect 的别名（返回 statusInfo）
 *
 * 事件通道（与真实内核架构一致）：
 *   - submit(op) 的 Promise 是**回执通道**：真实内核的终局事件经它返回。
 *   - subscribe(fn) 是**流式通道**：只在真实内核经宿主下行 window.PotbotKernelEvent 推送时触发。
 *     submit 不再向订阅者重复广播（否则「等待 submit」与「订阅」两条路会各渲染一次，界面重复）。
 *
 * 诚实边界（不编造）：
 *   - 桥在 → 只把**真实返回**解析后交给界面；submit 成功仍须带 resultRef 才算成功（fail-closed）。
 *   - 桥不在 → 如实拒绝（code = NO_KERNEL_CHANNEL）：**绝不**在本地构造事件、绝不用示例
 *     内容冒充内核输出。页面要访问电脑端后端时走 window.PotbotHost（见 host-api.js）。
 *   - 本文件不新增任何原生能力，只调用既有四个 JS 入口；不读任意文件 / 不执行任意代码 / 不联网。
 */
(function () {
  "use strict";

  window.PB = window.PB || {};

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------

  /** Java 白名单里的本地三态（KernelLocalUiBridge.DEFAULT_ALLOWED_ORIGINS）。 */
  var ALLOWED_ORIGINS = ["file:///android_asset", "app://local", "https://localhost"];
  /** 本页部署在 file:///android_asset 下，默认用它；允许外部在加载本脚本前覆盖。 */
  var ORIGIN = (typeof window.__PB_KERNEL_ORIGIN === "string" && window.__PB_KERNEL_ORIGIN)
    ? window.__PB_KERNEL_ORIGIN
    : "file:///android_asset";

  /**
   * 防御式探测的候选全局名。正式名是 MainActivity 里的 "PotbotKernel"；
   * 其余是同一契约的兼容写法。**只有真的带 submit 函数才算命中**。
   */
  var KERNEL_BRIDGE_NAMES = [
    "PotbotKernel",       // 正式名（MainActivity.JS_KERNEL_BRIDGE_NAME）
    "__potbotKernel",
    "potbotKernel",
    "PotbotKernelBridge"
  ];

  /** 探测放弃窗口：与 index.html 同口径（500ms × 20 ≈ 10s）。 */
  var DETECT_INTERVAL_MS = 500;
  var DETECT_MAX_TRIES = 20;

  // ---------------------------------------------------------------------------
  // 内部状态
  // ---------------------------------------------------------------------------

  var kernel = null;          // 命中的真实内核桥对象
  var kernelName = null;      // 命中的全局名（状态行显示用）
  var kernelReady = false;    // 是否收到过宿主 PotbotKernelReady（仅用于状态文案）
  var gaveUp = false;         // 探测窗口用尽仍未命中
  var subscribedId = null;    // 真实 subscribe 返回的订阅 id
  var listeners = [];         // 事件订阅者
  var seenEventIds = {};      // 去重（submit 返回值与下行可能重叠）
  var pollTimer = null;
  var pollTries = 0;
  var cmdSeq = 0;             // 命令 id 序号
  var SESSION = "" + Date.now().toString(36);

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  function parse(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch (e) { return null; }
  }

  function trimText(value) {
    if (typeof value !== "string") return "";
    var t = value.replace(/\s+/g, " ").trim();
    return t;
  }

  function copyObject(src) {
    var out = {};
    if (src && typeof src === "object") {
      for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k]; }
    }
    return out;
  }

  function nextCommandId() {
    cmdSeq += 1;
    return "ui-cmd-" + SESSION + "-" + cmdSeq;
  }

  function nextIdempotencyKey() {
    return "ui-idem-" + SESSION + "-" + cmdSeq;
  }

  // ---------------------------------------------------------------------------
  // 探测真实内核桥
  // ---------------------------------------------------------------------------

  function resolveKernel() {
    for (var i = 0; i < KERNEL_BRIDGE_NAMES.length; i++) {
      var name = KERNEL_BRIDGE_NAMES[i];
      var candidate = null;
      try { candidate = window[name]; } catch (e) { candidate = null; }
      if (candidate && typeof candidate.submit === "function") {
        return { name: name, obj: candidate };
      }
    }
    return null;
  }

  function detect() {
    var found = resolveKernel();
    if (found) {
      if (kernel !== found.obj) {
        kernel = found.obj;
        kernelName = found.name;
      }
      gaveUp = false;
      return true;
    }
    return false;
  }

  function ensureSubscription() {
    if (!kernel || subscribedId) return;
    var raw = null;
    try { raw = kernel.subscribe(ORIGIN); } catch (e) { raw = null; }
    var res = parse(raw);
    if (res && typeof res.subscriptionId === "string" && res.subscriptionId) {
      subscribedId = res.subscriptionId;
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function announce() {
    // 同时广播两个事件名：app.js（外壳）监听 DOM 事件 "PBKernelReady" 来重画状态行。
    var names = ["PBKernelReady", "pb-bridge-mode"];
    for (var i = 0; i < names.length; i++) {
      try {
        if (typeof window.CustomEvent === "function") {
          window.dispatchEvent(new CustomEvent(names[i], { detail: statusInfo() }));
        }
      } catch (e) { /* 老 WebView 无 CustomEvent：静默，壳仍可轮询 */ }
    }
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      pollTries += 1;
      if (detect()) {
        stopPolling();
        ensureSubscription();
        announce();
        return;
      }
      if (pollTries >= DETECT_MAX_TRIES) {
        stopPolling();
        gaveUp = true;
        announce();
      }
    }, DETECT_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // 宿主下行回调（先挂上，避免页面加载后的事件丢失）
  // ---------------------------------------------------------------------------

  var prevEventFn = (typeof window.PotbotKernelEvent === "function") ? window.PotbotKernelEvent : null;
  window.PotbotKernelEvent = function (subscriptionId, eventJson) {
    try { handleDownlink(eventJson); } catch (e) { /* 不让单条事件拖垮页面 */ }
    if (prevEventFn && prevEventFn !== window.PotbotKernelEvent) {
      try { prevEventFn(subscriptionId, eventJson); } catch (e) { /* 隔离 */ }
    }
  };

  var prevReadyFn = (typeof window.PotbotKernelReady === "function") ? window.PotbotKernelReady : null;
  window.PotbotKernelReady = function () {
    kernelReady = true;
    detect();
    ensureSubscription();
    stopPolling();
    announce();
    if (prevReadyFn && prevReadyFn !== window.PotbotKernelReady) {
      try { prevReadyFn(); } catch (e) { /* 隔离 */ }
    }
  };

  // ---------------------------------------------------------------------------
  // 事件规范化
  // ---------------------------------------------------------------------------

  function extractText(ev) {
    if (!ev) return null;
    if (typeof ev.text === "string" && ev.text) return ev.text;
    var p = ev.payload;
    if (p && typeof p === "object") {
      if (typeof p.text === "string" && p.text) return p.text;
      if (typeof p.summary === "string" && p.summary) return p.summary;
    }
    return null;
  }

  /** 规范化真实内核事件（fail-closed：succeeded 无 resultRef 不得当作成功）。 */
  function normalizeKernelEvent(ev) {
    var status = (ev && typeof ev.status === "string") ? ev.status : "unknown";
    var error = null;
    var resultRef = null;
    var ok = false;

    if (ev && ev.error && typeof ev.error === "object") {
      error = { code: ev.error.code || "KERNEL_ERROR", message: ev.error.message || "" };
      status = (typeof ev.status === "string") ? ev.status : "failed";
    } else if (status === "succeeded") {
      if (typeof ev.resultRef === "string" && ev.resultRef) {
        resultRef = ev.resultRef;
        ok = true;
      } else {
        // 契约：succeeded 必须带 resultRef。缺了就是坏终局，按进度未知处理，不升级为成功。
        status = "progressUnknown";
        error = { code: "invalid-terminal", message: "内核返回 succeeded 但没有 resultRef：按契约不得当作成功。" };
      }
    }

    return {
      mode: "kernel",
      ok: ok,
      status: status,
      commandId: (ev && ev.commandId) ? ev.commandId : null,
      eventId: (ev && ev.eventId) ? ev.eventId : null,
      seq: (ev && typeof ev.seq === "number") ? ev.seq : null,
      revision: (ev && typeof ev.revision === "number") ? ev.revision : 0,
      resultRef: resultRef,
      error: error,
      verificationMode: (ev && ev.verificationMode) ? ev.verificationMode : "real",
      text: extractText(ev),
      event: ev || null
    };
  }

  // ---------------------------------------------------------------------------
  // 事件派发
  // ---------------------------------------------------------------------------

  function emit(outcome) {
    if (outcome && outcome.eventId) {
      if (seenEventIds[outcome.eventId]) return;
      seenEventIds[outcome.eventId] = true;
    }
    var snapshot = listeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](outcome); } catch (e) { /* 单个订阅者抛错不影响其他订阅者 */ }
    }
  }

  function handleDownlink(eventJson) {
    var ev = parse(eventJson);
    if (!ev || typeof ev !== "object") return;
    emit(normalizeKernelEvent(ev));
  }

  function rejectOutcome(command, code, message) {
    return {
      mode: kernel ? "kernel" : "none",
      ok: false,
      status: "failed",
      commandId: (command && command.commandId) ? command.commandId : null,
      eventId: null,
      seq: null,
      revision: 0,
      resultRef: null,
      error: { code: code, message: message },
      verificationMode: kernel ? "real" : "none",
      text: null,
      event: null
    };
  }

  // ---------------------------------------------------------------------------
  // 命令规范化（兼容完整 mobile-v1 命令与简写）
  // ---------------------------------------------------------------------------

  function normalizeCommand(op) {
    if (op && typeof op === "object" && op.schemaVersion === "mobile-v1"
        && op.commandId && op.operation && op.idempotencyKey) {
      var full = {
        schemaVersion: "mobile-v1",
        commandId: String(op.commandId),
        operation: op.operation,
        idempotencyKey: String(op.idempotencyKey),
        payload: (op.payload && typeof op.payload === "object") ? copyObject(op.payload) : {}
      };
      if (op.metadata && typeof op.metadata === "object") full.metadata = copyObject(op.metadata);
      return full;
    }

    var text = null;
    var payload = {};
    var operation = "query";
    if (typeof op === "string") {
      text = op;
    } else if (op && typeof op === "object") {
      if (typeof op.text === "string") text = op.text;
      if (op.operation) operation = op.operation;
      else if (op.goal) operation = "create";
      if (op.payload && typeof op.payload === "object") payload = copyObject(op.payload);
      if (op.args && typeof op.args === "object" && !payload.args) payload.args = copyObject(op.args);
      if (typeof op.goal === "string" && typeof payload.goal !== "string") payload.goal = op.goal;
    }
    if (text !== null && typeof payload.text !== "string") payload.text = text;

    var commandId = nextCommandId();
    return {
      schemaVersion: "mobile-v1",
      commandId: commandId,
      operation: operation,
      idempotencyKey: nextIdempotencyKey(),
      payload: payload
    };
  }

  // ---------------------------------------------------------------------------
  // 提交
  // ---------------------------------------------------------------------------

  /** 标记 eventId 已处理，并确定性地把回执交给调用方（不经订阅通道，避免双渲染）。 */
  function settle(outcome) {
    if (outcome && outcome.eventId) {
      seenEventIds[outcome.eventId] = true;
    }
    return Promise.resolve(outcome);
  }

  function submitKernel(command) {
    ensureSubscription();
    var raw = null;
    try {
      raw = kernel.submit(ORIGIN, JSON.stringify(command));
    } catch (e) {
      return settle(rejectOutcome(command, "BRIDGE_THREW",
        "桥调用抛出异常：" + (e && e.message ? e.message : String(e))));
    }

    var parsed = parse(raw);
    if (!parsed) {
      return settle(rejectOutcome(command, "BRIDGE_BAD_JSON", "桥返回的不是可解析的 JSON。"));
    }

    var outcome;
    if (parsed.error || parsed.status === "failed") {
      var err = parsed.error || {};
      outcome = rejectOutcome(command, err.code || "KERNEL_FAILED", err.message || "");
      outcome.status = parsed.status || "failed";
      outcome.commandId = parsed.commandId || command.commandId;
      outcome.event = parsed;
    } else {
      outcome = normalizeKernelEvent(parsed);
    }
    return settle(outcome);
  }

  function submit(op) {
    var command = null;
    try {
      command = normalizeCommand(op);
    } catch (e) {
      return Promise.resolve(rejectOutcome(null, "INVALID_OPERATION",
        "submit(op) 收到无法识别的参数：" + (e && e.message ? e.message : String(e))));
    }
    if (!kernel) {
      /* 没有真实内核桥：如实拒绝。页面**不构造**任何假事件。 */
      return settle(rejectOutcome(command, "NO_KERNEL_CHANNEL",
        "本地内核桥不可用：本次提交没有发出。"));
    }
    return submitKernel(command);
  }

  // ---------------------------------------------------------------------------
  // 订阅 / 取消
  // ---------------------------------------------------------------------------

  function subscribe(fn) {
    if (typeof fn === "function") {
      listeners.push(fn);
      if (kernel) ensureSubscription();
    }
    return {
      unsubscribe: function () {
        for (var i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i] === fn) listeners.splice(i, 1);
        }
        if (kernel && subscribedId && listeners.length === 0) {
          try { kernel.unsubscribe(ORIGIN, subscribedId); } catch (e) { /* 忽略 */ }
          subscribedId = null;
        }
      }
    };
  }

  function cancel(commandId) {
    if (commandId === null || commandId === undefined || commandId === "") return false;
    if (kernel) {
      try { return !!kernel.cancel(ORIGIN, String(commandId)); } catch (e) { return false; }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  function statusInfo() {
    var isKernel = !!kernel;
    return {
      mode: isKernel ? "kernel" : "none",
      available: isKernel,
      bridgeName: kernelName,
      origin: ORIGIN,
      ready: kernelReady,
      gaveUp: gaveUp,
      label: isKernel
        ? ("内核桥 window." + kernelName + " · 已就绪")
        : "本地内核桥不可用"
    };
  }

  function describe() {
    if (kernel) return "内核桥 window." + kernelName + "：已就绪";
    return "本地内核桥不可用";
  }

  function refresh() {
    var changed = !kernel;
    detect();
    if (kernel) {
      ensureSubscription();
      if (changed) announce();
    }
    return statusInfo();
  }

  // ---------------------------------------------------------------------------
  // 对外对象
  // ---------------------------------------------------------------------------

  var bridge = {
    /** 提交一条命令（完整 mobile-v1 命令或 {text}/{goal} 简写），返回 Promise<回执>。 */
    submit: submit,
    /** 订阅事件；返回 { unsubscribe() }。回调收到规范化回执对象。 */
    subscribe: subscribe,
    /** 中止在飞命令；返回 boolean。 */
    cancel: cancel,
    /** 一行状态文字，供壳状态行显示当前模式。 */
    describe: describe,
    /** 结构化状态对象。 */
    statusInfo: statusInfo,
    /** 重新探测一次桥（宿主补挂后壳可主动调用）。返回 boolean：是否命中。 */
    detect: function () {
      var found = detect();
      if (found) { ensureSubscription(); announce(); }
      return found;
    },
    /** detect 的别名，返回结构化状态。 */
    refresh: refresh,
    /** 允许外部覆盖 origin（默认 file:///android_asset）。 */
    setOrigin: function (value) {
      if (typeof value === "string" && value) ORIGIN = value;
      return ORIGIN;
    },
    /** 白名单（只读展示）。 */
    allowedOrigins: ALLOWED_ORIGINS.slice(),
    /** 探测的候选全局名（诊断用）。 */
    candidateNames: KERNEL_BRIDGE_NAMES.slice()
  };

  Object.defineProperty(bridge, "available", {
    enumerable: true,
    get: function () { return !!kernel; }
  });
  Object.defineProperty(bridge, "mode", {
    enumerable: true,
    get: function () { return kernel ? "kernel" : "none"; }
  });
  Object.defineProperty(bridge, "bridgeName", {
    enumerable: true,
    get: function () { return kernelName; }
  });
  Object.defineProperty(bridge, "origin", {
    enumerable: true,
    get: function () { return ORIGIN; }
  });
  /** 来源标签（app.js 状态行在「已连接」时显示 "来源 xxx"）。 */
  Object.defineProperty(bridge, "source", {
    enumerable: true,
    get: function () { return kernel ? ("window." + kernelName) : "（无内核桥）"; }
  });

  window.PB.bridge = bridge;

  // ---------------------------------------------------------------------------
  // 启动探测：立即一次 + 就绪回调 + 有界轮询（不做永久轮询）
  // ---------------------------------------------------------------------------

  detect();
  if (kernel) { ensureSubscription(); announce(); }
  startPoll();

  // 暴露给排障用（只读快照，不构成新的原生能力）。
  window.PB.bridge.__debug = function () { return statusInfo(); };
})();
