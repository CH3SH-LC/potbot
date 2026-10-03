/*
 * potbot 手机 Word Demo —— 应用内桥请求/回执跟踪（bridge-ops.js）
 *
 * 由来（design-05-P10 缺口 1）：
 *   旧 app.js 只有一个 `pendingBridge` 变量，既没有操作身份，也没有把「哪次请求」
 *   和「哪次回执」绑在一起。于是会出现三类事故：
 *     1) 并发两次应用内保存时，后一次直接覆盖前一次的 pending；
 *     2) 90 秒旧计时器在 pending 被清空/换人之后才触发，会清掉**别人的** pending
 *        并把界面状态错写成「本次结果未知」；
 *     3) 回执没有操作身份，无法判断它到底属于哪一次请求，迟到回执会串单。
 *
 * 本模块只做一件事：把每次应用内（交给系统软件 / 另存副本）请求登记为一条带
 * **operationId + documentId + revision** 的操作记录，并保证：
 *   - 回执只能按 operationId 归位；对不上号的回执**不产生副作用**；
 *   - 单条操作**只终结一次**（第二次回执/超时/取消一律 ignored）；
 *   - 每条操作有**自己的**计时器，超时只终结自己，不碰别人、也不发任何迟到请求；
 *   - 同一时刻多条操作并存时，各自的记录互不覆盖。
 *
 * 载入方式：浏览器 `<script src="./bridge-ops.js">` ⇒ 挂到全局 `PotbotBridgeOps`；
 * 测试用 `node:vm` 直接加载本文件（不复制实现，测的就是线上这一份）。
 * 依赖注入（now/makeId/schedule/cancel/timeoutMs）全部可选，便于确定性测试。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotBridgeOps = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /** 旧实现的 90 秒无回执判定，保持同一数量级（但现在是**每条操作各自**的计时器）。 */
  var DEFAULT_TIMEOUT_MS = 90000;

  function defaultMakeId() {
    var tail;
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      tail = crypto.randomUUID();
    } else {
      tail = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    return 'bop-' + tail;
  }

  function identityError(documentId, artifactId, revision, method) {
    var missing = [];
    if (!documentId) missing.push('documentId');
    if (!artifactId) missing.push('artifactId');
    if (revision === null) missing.push('revision');
    if (!method) missing.push('method');
    if (missing.length === 0) return null;
    return new Error('缺少操作身份字段：' + missing.join('、'));
  }

  /**
   * 建一个跟踪器。options（全部可选）：
   *   now / makeId / schedule / cancel / timeoutMs
   * 返回的对象方法：
   *   begin(request)                 → op 记录；身份不全**直接抛错**（宁可拒绝，不发匿名请求）
   *   settle(operationId, outcome)   → { accepted, reason, op }
   *   cancel(operationId, message)   → { accepted, reason, op }
   *   markLegacy(operationId)        → 标记「本次回执可能没有操作身份」
   *   resolveLegacy(ok, message)     → 无身份回执的兜底归位（0 条或 >1 条待决时**拒绝归位**）
   *   get / pending / records / lastTerminal / onSettle
   */
  function createBridgeOps(options) {
    var opt = options || {};
    var now = typeof opt.now === 'function' ? opt.now : function () { return Date.now(); };
    var makeId = typeof opt.makeId === 'function' ? opt.makeId : defaultMakeId;
    var schedule = typeof opt.schedule === 'function' ? opt.schedule : function (fn, ms) { return setTimeout(fn, ms); };
    var cancelTimer = typeof opt.cancel === 'function' ? opt.cancel : function (handle) { clearTimeout(handle); };
    var timeoutMs = (typeof opt.timeoutMs === 'number' && isFinite(opt.timeoutMs) && opt.timeoutMs > 0)
      ? opt.timeoutMs : DEFAULT_TIMEOUT_MS;

    var ops = {};      /* operationId -> 记录 */
    var order = [];    /* 登记顺序，用于「最近一条」与稳定输出 */
    var listeners = [];

    function notify(op) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](op); } catch (e) { /* 监听器自身出错不得影响跟踪器状态 */ }
      }
    }

    function finalize(op, outcome) {
      if (op.terminal) return false;
      op.terminal = true;
      op.terminalReason = outcome.reason;
      op.ok = outcome.ok === true;
      op.message = typeof outcome.message === 'string' ? outcome.message : '';
      op.settledAt = now();
      if (op.timer !== null && op.timer !== undefined) {
        try { cancelTimer(op.timer); } catch (e) { /* 取消失败不影响状态机 */ }
        op.timer = null;
      }
      notify(op);
      return true;
    }

    function begin(request) {
      var req = request || {};
      var documentId = typeof req.documentId === 'string' ? req.documentId : '';
      var artifactId = typeof req.artifactId === 'string' ? req.artifactId : '';
      var revision = (typeof req.revision === 'number' && isFinite(req.revision)) ? req.revision : null;
      var method = typeof req.method === 'string' ? req.method : '';

      var problem = identityError(documentId, artifactId, revision, method);
      if (problem) throw problem;   /* 不登记匿名操作：没有身份的回执无法归位 */

      var operationId = makeId();
      var op = {
        operationId: operationId,
        documentId: documentId,
        revision: revision,
        artifactId: artifactId,
        method: method,
        legacy: false,
        startedAt: now(),
        terminal: false,
        terminalReason: null,
        ok: null,
        message: '',
        settledAt: null,
        timer: null
      };
      ops[operationId] = op;
      order.push(operationId);
      op.timer = schedule(function () { expire(operationId); }, timeoutMs);
      return op;
    }

    function expire(operationId) {
      var op = ops[operationId];
      if (!op || op.terminal) return { accepted: false, reason: 'noop', op: op || null };
      /* 只终结自己：不查、不清、不改任何其他操作的记录或计时器。 */
      finalize(op, { reason: 'timeout', ok: false, message: '' });
      return { accepted: true, reason: 'timeout', op: op };
    }

    function settle(operationId, outcome) {
      var op = ops[operationId];
      if (!op) return { accepted: false, reason: 'unknown_operation', op: null };
      if (op.terminal) return { accepted: false, reason: 'already_settled', op: op };
      var o = outcome || {};
      var reason = typeof o.reason === 'string' && o.reason ? o.reason : 'callback';
      finalize(op, { reason: reason, ok: o.ok === true, message: o.message });
      return { accepted: true, reason: reason, op: op };
    }

    function cancel(operationId, message) {
      var op = ops[operationId];
      if (!op) return { accepted: false, reason: 'unknown_operation', op: null };
      if (op.terminal) return { accepted: false, reason: 'already_settled', op: op };
      finalize(op, {
        reason: 'cancelled',
        ok: false,
        message: typeof message === 'string' ? message : ''
      });
      return { accepted: true, reason: 'cancelled', op: op };
    }

    function markLegacy(operationId) {
      var op = ops[operationId];
      if (op && !op.terminal) op.legacy = true;
      return op || null;
    }

    /**
     * 旧签名回执（只有 ok/message，没有 operationId）的兜底：
     * 恰好只有一条待决操作时归给它；0 条 ⇒ no_pending（不新建、不改状态）；
     * 多于 1 条 ⇒ ambiguous（**拒绝归位**，绝不猜一条填上，避免串单）。
     */
    function resolveLegacy(ok, message) {
      var live = pending();
      if (live.length === 0) return { accepted: false, reason: 'no_pending', op: null };
      if (live.length > 1) return { accepted: false, reason: 'ambiguous', op: null };
      return settle(live[0].operationId, { reason: 'callback_legacy', ok: ok === true, message: message });
    }

    function get(operationId) { return ops[operationId] || null; }

    function records() {
      var out = [];
      for (var i = 0; i < order.length; i++) out.push(ops[order[i]]);
      return out;
    }

    function pending() {
      var out = [];
      for (var i = 0; i < order.length; i++) {
        if (!ops[order[i]].terminal) out.push(ops[order[i]]);
      }
      return out;
    }

    function lastTerminal() {
      for (var i = order.length - 1; i >= 0; i--) {
        if (ops[order[i]].terminal) return ops[order[i]];
      }
      return null;
    }

    function onSettle(listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.push(listener);
      return function () {
        listeners = listeners.filter(function (fn) { return fn !== listener; });
      };
    }

    return {
      timeoutMs: timeoutMs,
      begin: begin,
      settle: settle,
      cancel: cancel,
      markLegacy: markLegacy,
      resolveLegacy: resolveLegacy,
      get: get,
      records: records,
      pending: pending,
      lastTerminal: lastTerminal,
      onSettle: onSettle
    };
  }

  return {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    createBridgeOps: createBridgeOps
  };
});
