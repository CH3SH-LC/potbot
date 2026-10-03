/*
 * potbot 手机 Word Demo —— **连续对话后端接线**（chat-transport.js；FA-N）
 *
 * 由来（合同 H2 / R207–R209）：
 *   `conversation-store.js`（FA-A）把界面侧的会话 / 消息 / 状态 / 续取游标定义好了，
 *   并且诚实地留了一句「`PotbotChatTransport` 由 B 流提供，当前无后端时消息如实标失败」。
 *   本文件就是那个**提供者**：把该模块约定的三个接缝接到真实 HTTP 后端上。
 *
 * ## 接口（与 `conversation-store.js` 的约定**逐字对齐**，不改它的既有语义）
 *
 * ```js
 * window.PotbotChatTransport = {
 *   available: true,                          // 必须显式为 true，页面才认为后端可用
 *   send({sessionId, clientId, text})         // → Promise<{ok, status, data}>
 *   resume({sessionId, cursor, onEvent})      // → Promise<{ok, error?}>
 * };
 * ```
 *
 * `send` 的返回形状是 `classifySendOutcome` 直接吃的：`ok === true` 且响应体里没有
 * `error` 才算「已接收」；网络失败 / 非 2xx / 带 error 的响应一律「失败」。
 *
 * ## 「已接收」不等于「业务完成」（R209）——这条在数据里就是这么长的
 *
 * 后端 `POST /api/conversations/:id/messages` 回的是 **202**，只表示"收下了"。
 * 业务结局（完成 / 失败 / 取消）是**之后**由事件流推过来的，字段是 `phase`：
 *   `accepted` → `running` → `completed` / `failed` / `cancelled`
 * 因此本文件**从不**在 `send` 返回时把消息说成"完成了"。
 *
 * ## 续取（R208）：只取**严格大于**游标的事件
 *
 * `resume` 轮询 `GET /api/conversations/:id/events?cursor=<上次游标>`，把返回的每一条
 * 事件原样交给 `onEvent`（并给每条补上它自己的 `cursor`，让页面**逐条**前移游标）。
 * 服务端保证"严格大于"，所以**已消费的内容不会被重放**——这不是靠页面去重。
 * 轮询有次数与时长上限；到顶时如实返回 `ok:false`，不假装"已经全部续上了"。
 *
 * ## 边界（诚实）
 *
 * - 本文件**不判断**业务是否成功，只搬运与归位信号；成功与否由事件的 `phase` 说话。
 * - 它**不碰**文档编辑链（`/api/sessions/**`），也不伪造文件。
 * - 密钥不进这里：服务地址就是同源相对路径。
 *
 * 载入方式：`<script src="./chat-transport.js">`（在 `app.js` **之前**）⇒ 全局
 * `window.PotbotChatTransport`。若宿主已自行注入同名对象，本文件**不覆盖**它。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') {
    // 已经有人注入过就不再覆盖：显式注入优先（例如将来换成手机原生桥）。
    if (!root.PotbotChatTransport) root.PotbotChatTransport = api;
  }
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 60000;
  /** 续取轮询：每次间隔与总次数上限（到顶如实报"还没续完"，不假装完整）。 */
  var RESUME_INTERVAL_MS = 700;
  var RESUME_MAX_ROUNDS = 40;

  function encodeId(value) {
    return encodeURIComponent(String(value));
  }

  function routes(sessionId) {
    return {
      messages: '/api/conversations/' + encodeId(sessionId) + '/messages',
      events: '/api/conversations/' + encodeId(sessionId) + '/events',
      retry: function (messageId) {
        return '/api/conversations/' + encodeId(sessionId) + '/messages/' + encodeId(messageId) + '/retry';
      },
      cancel: function (messageId) {
        return '/api/conversations/' + encodeId(sessionId) + '/messages/' + encodeId(messageId) + '/cancel';
      }
    };
  }

  /** 一次带超时的 fetch；**任何**失败（网络 / 超时 / 坏 JSON）都归成结构化结果，不抛。 */
  function requestJson(method, path, body, timeoutMs) {
    var controller = null;
    var timer = null;
    var options = { method: method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      options.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || DEFAULT_TIMEOUT_MS);
    }
    return fetch(path, options)
      .then(function (response) {
        return response.json()
          ['catch'](function () { return null; })
          .then(function (data) { return { ok: response.ok, status: response.status, data: data }; });
      })
      ['catch'](function (error) {
        return {
          ok: false,
          status: 0,
          data: null,
          networkError: (error && error.name === 'AbortError') ? '请求超时' : '没有连上对话后端'
        };
      })
      .then(function (result) {
        if (timer !== null) clearTimeout(timer);
        return result;
      });
  }

  /**
   * 发一条消息。
   *
   * 返回 `{ok, status, data}`：`data` 在成功时带 `{cursor, messageId, phase, ...}`，
   * 失败时带 `{code, message, retryable}`（与 `classifySendOutcome` 的读法一致）。
   */
  function send(input) {
    var payload = input || {};
    var sessionId = payload.sessionId;
    var clientId = payload.clientId;
    var text = payload.text;
    if (typeof sessionId !== 'string' || sessionId === '') {
      return Promise.resolve({
        ok: false, status: 0,
        data: { error: { code: 'no_session', message: '页面没有可用的会话 id，这条消息没有发出。', retryable: false } }
      });
    }
    if (typeof clientId !== 'string' || clientId === '') {
      return Promise.resolve({
        ok: false, status: 0,
        data: { error: { code: 'no_client_id', message: '这条消息缺少幂等键（clientId）：不发出（重试必须复用同一个键）。', retryable: false } }
      });
    }
    return requestJson('POST', routes(sessionId).messages, { clientId: clientId, text: text }, DEFAULT_TIMEOUT_MS)
      .then(function (result) {
        if (result.status === 0) {
          return {
            ok: false, status: 0,
            data: { error: { code: 'network', message: (result.networkError || '没有连上对话后端') + '，这条消息没有送达。', retryable: true } }
          };
        }
        return { ok: result.ok, status: result.status, data: result.data };
      });
  }

  /**
   * 断线续取。
   *
   * @param {{sessionId:string, cursor:(string|null), onEvent:function}} input
   * @returns {Promise<{ok:boolean, cursor?:string, error?:object, rounds?:number}>}
   */
  function resume(input) {
    var payload = input || {};
    var sessionId = payload.sessionId;
    var onEvent = typeof payload.onEvent === 'function' ? payload.onEvent : function () {};
    if (typeof sessionId !== 'string' || sessionId === '') {
      return Promise.resolve({ ok: false, error: { code: 'no_session', message: '页面没有可用的会话 id。' } });
    }
    var cursor = (typeof payload.cursor === 'string' && payload.cursor !== '') ? payload.cursor : null;
    var rounds = 0;

    function step() {
      rounds += 1;
      var path = routes(sessionId).events + (cursor === null ? '' : ('?cursor=' + encodeURIComponent(cursor)));
      return requestJson('GET', path, undefined, DEFAULT_TIMEOUT_MS).then(function (result) {
        if (result.status === 0) {
          return { ok: false, error: { code: 'network', message: (result.networkError || '没有连上对话后端') } };
        }
        if (!result.ok || !result.data) {
          var body = result.data || {};
          return {
            ok: false,
            error: {
              code: typeof body.code === 'string' ? body.code : ('http_' + String(result.status)),
              message: typeof body.message === 'string' ? body.message : '对话后端拒绝了这次续取。'
            }
          };
        }
        var data = result.data;
        var events = Array.isArray(data.events) ? data.events : [];
        for (var i = 0; i < events.length; i++) {
          var event = events[i];
          // 逐条补上它自己的游标：页面据此**逐条**前移，而不是拿到整页后一次跳到底。
          var enriched = {};
          for (var key in event) {
            if (Object.prototype.hasOwnProperty.call(event, key)) enriched[key] = event[key];
          }
          enriched.cursor = 'conv:' + sessionId + ':' + String(event.seq);
          onEvent(enriched);
          cursor = enriched.cursor;
        }
        if (typeof data.cursor === 'string' && data.cursor !== '') cursor = data.cursor;
        var pending = Array.isArray(data.pending) ? data.pending : [];
        if (data.more === true) return step();
        if (events.length === 0 && pending.length === 0) {
          return { ok: true, cursor: cursor, rounds: rounds };
        }
        if (rounds >= RESUME_MAX_ROUNDS) {
          // **不假装续完了**：如实说"还有在途的动作，本次没有等到它定局"。
          return {
            ok: false, rounds: rounds, cursor: cursor,
            error: { code: 'resume_incomplete', message: '还有在途的消息没有定局，本次续取在轮询上限处停下（不是"已全部续上"）。' }
          };
        }
        return new Promise(function (resolvePromise) {
          setTimeout(function () { resolvePromise(step()); }, RESUME_INTERVAL_MS);
        });
      });
    }

    return step();
  }

  /** 重试一条失败的消息（复用同一条消息与同一个幂等键；服务端不会新建任务）。 */
  function retry(input) {
    var payload = input || {};
    return requestJson('POST', routes(payload.sessionId).retry(payload.messageId), {}, DEFAULT_TIMEOUT_MS)
      .then(function (result) { return { ok: result.ok, status: result.status, data: result.data }; });
  }

  /** 取消一条在途的消息。 */
  function cancel(input) {
    var payload = input || {};
    return requestJson('POST', routes(payload.sessionId).cancel(payload.messageId), {}, DEFAULT_TIMEOUT_MS)
      .then(function (result) { return { ok: result.ok, status: result.status, data: result.data }; });
  }

  return {
    available: true,
    provider: 'demo-http',
    send: send,
    resume: resume,
    retry: retry,
    cancel: cancel
  };
});
