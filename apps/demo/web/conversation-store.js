/*
 * potbot 完整 App —— 会话与消息状态机（纯逻辑，无 DOM 依赖）
 *
 * 交付的是**界面侧的连续对话**（APP-02 / CHAT-01–03）所需的确定性状态：
 *   - 会话：新建 / 切换 / 重命名 / 归档 / 删除（CHAT-02）；
 *   - 消息：稳定 id + 每会话**单调序号**，重试**复用同一条消息**（CHAT-03 / R207）；
 *   - 发送状态：发送中 / 已接收 / 失败 / 已取消（以及助手侧的等待 / 增量中）（R209）；
 *   - 断线续取游标：会话级游标，断线后从上次位置继续、不重放已消费内容（R208）。
 *
 * **边界（诚实）**：本模块**不**发任何网络请求，也**不**判断后端是否真的执行成功。
 * 它只做状态归位；「已接收」≠「业务完成」（R209）。真实执行由 B 流的会话/后台内核提供，
 * 页面通过可选注入 `window.PotbotChatTransport` 接入；缺失时界面降级为「未接入」，
 * **绝不**把旧的一次性生成接口接进来冒充连续对话（合同附一 H2）。
 *
 * 状态**写穿到注入的 storage**（默认 window.localStorage；不可用时退回内存），
 * 刷新页面后会话与消息仍在——这是 CHAT-02「历史持久化 / 重开恢复」的界面侧基础。
 */
(function () {
  'use strict';

  var ROLE_USER = 'user';
  var ROLE_ASSISTANT = 'assistant';
  var ROLE_SYSTEM = 'system';

  /* 发送状态全集。用户消息用 sending/received/failed/cancelled；
     助手消息用 pending/streaming/received/failed/cancelled。 */
  var SEND_STATES = {
    SENDING: 'sending',
    RECEIVED: 'received',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    PENDING: 'pending',
    STREAMING: 'streaming'
  };

  /* 终态：到达后不会再自行变化。 */
  var TERMINAL_STATES = { received: true, failed: true, cancelled: true };

  var STORAGE_KEY = 'potbot.demo.v1.conversations';
  var SCHEMA_VERSION = 1;

  var DEFAULT_MAX_SESSIONS = 50;
  var DEFAULT_MAX_MESSAGES = 200;

  function isObject(v) { return v !== null && typeof v === 'object'; }

  function textOf(v) {
    return (v === undefined || v === null) ? '' : String(v);
  }

  /** 名字归一：去掉首尾空白；空名回退到 fallback（**不静默接受空名**）。 */
  function normalizeName(name, fallback) {
    var trimmed = textOf(name).trim();
    return trimmed === '' ? fallback : trimmed;
  }

  function cloneMessage(m) {
    return {
      id: m.id, sessionId: m.sessionId, role: m.role, text: m.text,
      state: m.state, seq: m.seq, createdAt: m.createdAt, updatedAt: m.updatedAt,
      clientId: m.clientId, attempts: m.attempts,
      error: m.error === null ? null : { code: m.error.code, message: m.error.message, retryable: m.error.retryable === true }
    };
  }

  function cloneSession(s) {
    var out = {
      id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt,
      archived: s.archived === true, resumeCursor: s.resumeCursor, messages: []
    };
    for (var i = 0; i < s.messages.length; i++) out.messages.push(cloneMessage(s.messages[i]));
    return out;
  }

  /**
   * 发送结果的**唯一分类口径**（R209 / R226）。
   * 关键不变量：**只有 `ok === true` 且响应体里没有 error 时才判 `received`**；
   * 网络失败 / 非 2xx / 带 error 的响应一律 `failed`。任何情况下**不会**把失败读成成功。
   */
  function classifySendOutcome(res) {
    var r = isObject(res) ? res : {};
    var data = isObject(r.data) ? r.data : null;

    if (r.ok !== true) {
      var status = typeof r.status === 'number' ? r.status : 0;
      return {
        state: SEND_STATES.FAILED,
        cursor: null,
        error: {
          code: 'http_' + (status || 'unknown'),
          message: status === 0
            ? '没有连上对话后端，这条消息没有送达。'
            : ('对话后端拒绝了这次请求（HTTP ' + status + '）。'),
          retryable: true
        }
      };
    }
    if (data && isObject(data.error) && data.error.message) {
      return {
        state: SEND_STATES.FAILED,
        cursor: null,
        error: {
          code: textOf(data.error.code) || 'backend_error',
          message: textOf(data.error.message),
          retryable: data.error.retryable === true
        }
      };
    }
    var cursor = (data && typeof data.cursor === 'string' && data.cursor !== '') ? data.cursor : null;
    return { state: SEND_STATES.RECEIVED, cursor: cursor, error: null };
  }

  /**
   * 建立一份会话仓库。
   *
   * `opts`：`storage`（getItem/setItem；缺失用 localStorage；再不行用内存）、
   * `now()`、`makeId(prefix)`、`maxSessions`、`maxMessages`。
   */
  function createStore(opts) {
    var options = opts || {};
    var maxSessions = typeof options.maxSessions === 'number' ? options.maxSessions : DEFAULT_MAX_SESSIONS;
    var maxMessages = typeof options.maxMessages === 'number' ? options.maxMessages : DEFAULT_MAX_MESSAGES;

    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
    var makeId = typeof options.makeId === 'function' ? options.makeId : function (prefix) {
      return (prefix ? prefix + '-' : '') + Math.random().toString(36).slice(2, 10) + '-' + now().toString(36);
    };

    var storage = options.storage;
    var memory = { value: null };
    if (!storage) {
      if (typeof window !== 'undefined' && window && window.localStorage) storage = window.localStorage;
    }

    function readRaw() {
      if (storage && typeof storage.getItem === 'function') {
        try { return storage.getItem(STORAGE_KEY); } catch (e) { /* 落回内存 */ }
      }
      return memory.value;
    }

    function writeRaw(text) {
      memory.value = text;
      if (storage && typeof storage.setItem === 'function') {
        try { storage.setItem(STORAGE_KEY, text); } catch (e) { /* 内存里已经有一份 */ }
      }
    }

    /* ---- 内存态 ---- */
    var state = { version: SCHEMA_VERSION, current: null, sessions: [] };

    function normalizeMessage(raw, sessionId) {
      if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '') return null;
      var validRoles = [ROLE_USER, ROLE_ASSISTANT, ROLE_SYSTEM];
      return {
        id: raw.id,
        sessionId: sessionId,
        role: validRoles.indexOf(raw.role) >= 0 ? raw.role : ROLE_SYSTEM,
        text: textOf(raw.text),
        state: SEND_STATES[textOf(raw.state).toUpperCase()] || raw.state || SEND_STATES.RECEIVED,
        seq: typeof raw.seq === 'number' ? raw.seq : 0,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now(),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now(),
        clientId: typeof raw.clientId === 'string' ? raw.clientId : null,
        attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
        error: isObject(raw.error) ? { code: textOf(raw.error.code), message: textOf(raw.error.message), retryable: raw.error.retryable === true } : null
      };
    }

    function load() {
      var raw = readRaw();
      if (!raw) return;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { return; }
      if (!isObject(parsed) || !Array.isArray(parsed.sessions)) return;
      state = { version: SCHEMA_VERSION, current: null, sessions: [] };
      for (var i = 0; i < parsed.sessions.length; i++) {
        var s = parsed.sessions[i];
        if (!isObject(s) || typeof s.id !== 'string' || s.id === '') continue;
        var session = {
          id: s.id,
          name: normalizeName(s.name, '会话 ' + (i + 1)),
          createdAt: typeof s.createdAt === 'number' ? s.createdAt : now(),
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : now(),
          archived: s.archived === true,
          resumeCursor: typeof s.resumeCursor === 'string' ? s.resumeCursor : null,
          nextSeq: 1,
          messages: []
        };
        var list = Array.isArray(s.messages) ? s.messages : [];
        for (var m = 0; m < list.length; m++) {
          var msg = normalizeMessage(list[m], session.id);
          if (msg) session.messages.push(msg);
        }
        recomputeSeq(session);
        state.sessions.push(session);
      }
      state.current = typeof parsed.current === 'string' ? parsed.current : null;
      if (!findSession(state.current)) state.current = state.sessions.length > 0 ? state.sessions[0].id : null;
    }

    function recomputeSeq(session) {
      var maxSeq = 0;
      for (var i = 0; i < session.messages.length; i++) {
        if (session.messages[i].seq > maxSeq) maxSeq = session.messages[i].seq;
      }
      session.nextSeq = maxSeq + 1;
      session.messages.sort(function (a, b) { return a.seq - b.seq; });
    }

    function save() {
      var payload = { version: SCHEMA_VERSION, current: state.current, sessions: [] };
      for (var i = 0; i < state.sessions.length; i++) {
        var s = state.sessions[i];
        payload.sessions.push({
          id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt,
          archived: s.archived, resumeCursor: s.resumeCursor, messages: s.messages
        });
      }
      try { writeRaw(JSON.stringify(payload)); } catch (e) { /* 存储失败不改变内存态 */ }
    }

    function findSession(id) {
      if (typeof id !== 'string' || id === '') return null;
      for (var i = 0; i < state.sessions.length; i++) {
        if (state.sessions[i].id === id) return state.sessions[i];
      }
      return null;
    }

    function touch(session) {
      session.updatedAt = now();
    }

    function ok(patch) {
      var out = { ok: true };
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
      return out;
    }

    var api = {
      SEND_STATES: SEND_STATES,
      classifySendOutcome: classifySendOutcome,

      /** 会话列表（默认不含归档；按 updatedAt 降序）。 */
      sessions: function (includeArchived) {
        var out = [];
        for (var i = 0; i < state.sessions.length; i++) {
          if (state.sessions[i].archived === true && includeArchived !== true) continue;
          out.push(cloneSession(state.sessions[i]));
        }
        out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        return out;
      },

      current: function () { return state.current; },

      createSession: function (name) {
        var session = {
          id: makeId('sess'),
          name: normalizeName(name, '新会话 ' + (state.sessions.length + 1)),
          createdAt: now(), updatedAt: now(), archived: false,
          resumeCursor: null, nextSeq: 1, messages: []
        };
        state.sessions.push(session);
        /* 超出上限：**只从末尾（最旧）丢**，保护当前会话。 */
        if (state.sessions.length > maxSessions) {
          state.sessions.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
          var kept = [];
          for (var i = 0; i < state.sessions.length && kept.length < maxSessions; i++) {
            if (state.sessions[i].id === state.current || kept.length < maxSessions - 1) kept.push(state.sessions[i]);
          }
          state.sessions = kept;
        }
        state.current = session.id;
        save();
        return cloneSession(session);
      },

      selectSession: function (id) {
        if (!findSession(id)) return false;
        state.current = id;
        save();
        return true;
      },

      renameSession: function (id, name) {
        var session = findSession(id);
        if (!session) return { ok: false, code: 'no_such_session' };
        var trimmed = textOf(name).trim();
        if (trimmed === '') return { ok: false, code: 'empty_name' };
        session.name = trimmed;
        touch(session);
        save();
        return ok({ session: cloneSession(session) });
      },

      archiveSession: function (id, archived) {
        var session = findSession(id);
        if (!session) return { ok: false, code: 'no_such_session' };
        session.archived = archived === false ? false : true;
        touch(session);
        save();
        return ok({ session: cloneSession(session) });
      },

      deleteSession: function (id) {
        var found = -1;
        for (var i = 0; i < state.sessions.length; i++) {
          if (state.sessions[i].id === id) { found = i; break; }
        }
        if (found < 0) return { ok: false, code: 'no_such_session' };
        state.sessions.splice(found, 1);
        if (state.current === id) {
          state.current = state.sessions.length > 0 ? state.sessions[0].id : null;
        }
        save();
        return ok();
      },

      messages: function (sessionId) {
        var session = findSession(sessionId);
        if (!session) return [];
        var out = [];
        for (var i = 0; i < session.messages.length; i++) out.push(cloneMessage(session.messages[i]));
        out.sort(function (a, b) { return a.seq - b.seq; });
        return out;
      },

      /**
       * 追加一条消息。序号**每会话单调递增**（稳定顺序，R207）。
       * `clientId` 缺省时用消息 id 顶上：它就是重试时的幂等键。
       */
      appendMessage: function (sessionId, patch) {
        var session = findSession(sessionId);
        if (!session) return null;
        var p = isObject(patch) ? patch : {};
        var id = typeof p.id === 'string' && p.id !== '' ? p.id : makeId('msg');
        var msg = {
          id: id,
          sessionId: session.id,
          role: p.role === ROLE_USER || p.role === ROLE_ASSISTANT ? p.role : ROLE_SYSTEM,
          text: textOf(p.text),
          state: p.state || (p.role === ROLE_USER ? SEND_STATES.SENDING : SEND_STATES.PENDING),
          seq: session.nextSeq++,
          createdAt: now(), updatedAt: now(),
          clientId: typeof p.clientId === 'string' && p.clientId !== '' ? p.clientId : id,
          attempts: typeof p.attempts === 'number' ? p.attempts : 0,
          error: null
        };
        session.messages.push(msg);
        /* 每会话消息上限：从最旧开始截断，避免无限增长。 */
        while (session.messages.length > maxMessages) session.messages.shift();
        touch(session);
        save();
        return cloneMessage(msg);
      },

      getMessage: function (sessionId, messageId) {
        var session = findSession(sessionId);
        if (!session) return null;
        for (var i = 0; i < session.messages.length; i++) {
          if (session.messages[i].id === messageId) return cloneMessage(session.messages[i]);
        }
        return null;
      },

      updateMessage: function (sessionId, messageId, patch) {
        var session = findSession(sessionId);
        if (!session) return null;
        var msg = null;
        for (var i = 0; i < session.messages.length; i++) {
          if (session.messages[i].id === messageId) { msg = session.messages[i]; break; }
        }
        if (!msg) return null;
        var p = isObject(patch) ? patch : {};
        if (typeof p.text === 'string') msg.text = p.text;
        if (typeof p.state === 'string' && p.state !== '') msg.state = p.state;
        if (p.error === null) msg.error = null;
        else if (isObject(p.error)) msg.error = { code: textOf(p.error.code), message: textOf(p.error.message), retryable: p.error.retryable === true };
        if (typeof p.cursor === 'string' && p.cursor !== '') session.resumeCursor = p.cursor;
        msg.updatedAt = now();
        touch(session);
        save();
        return cloneMessage(msg);
      },

      /**
       * 重试一条**失败或已取消**的消息。
       * 不变量（R207）：复用**同一条消息 id 与 clientId**，attempts+1，状态回「发送中」；
       * **绝不**新建消息 —— 服务端据 clientId 去重，重试不会重复建任务。
       */
      retryMessage: function (sessionId, messageId) {
        var session = findSession(sessionId);
        if (!session) return { ok: false, code: 'no_such_session' };
        var msg = null;
        for (var i = 0; i < session.messages.length; i++) {
          if (session.messages[i].id === messageId) { msg = session.messages[i]; break; }
        }
        if (!msg) return { ok: false, code: 'no_such_message' };
        if (msg.state !== SEND_STATES.FAILED && msg.state !== SEND_STATES.CANCELLED) {
          return { ok: false, code: 'not_retryable' };
        }
        msg.state = SEND_STATES.SENDING;
        msg.attempts += 1;
        msg.error = null;
        msg.updatedAt = now();
        touch(session);
        save();
        return ok({ message: cloneMessage(msg) });
      },

      cancelMessage: function (sessionId, messageId) {
        var session = findSession(sessionId);
        if (!session) return { ok: false, code: 'no_such_session' };
        for (var i = 0; i < session.messages.length; i++) {
          if (session.messages[i].id === messageId) {
            if (TERMINAL_STATES[session.messages[i].state] === true && session.messages[i].state !== SEND_STATES.FAILED) {
              return { ok: false, code: 'already_terminal' };
            }
            session.messages[i].state = SEND_STATES.CANCELLED;
            session.messages[i].updatedAt = now();
            touch(session);
            save();
            return ok({ message: cloneMessage(session.messages[i]) });
          }
        }
        return { ok: false, code: 'no_such_message' };
      },

      resumeCursor: function (sessionId) {
        var session = findSession(sessionId);
        return session ? session.resumeCursor : null;
      },

      setResumeCursor: function (sessionId, cursor) {
        var session = findSession(sessionId);
        if (!session) return false;
        session.resumeCursor = (typeof cursor === 'string' && cursor !== '') ? cursor : null;
        touch(session);
        save();
        return true;
      },

      /** 断线续取入口的数据：上次游标 + 尚未定局的消息（续取时应重放的对象）。 */
      resumable: function (sessionId) {
        var session = findSession(sessionId);
        if (!session) return { cursor: null, pending: [] };
        var pending = [];
        for (var i = 0; i < session.messages.length; i++) {
          var st = session.messages[i].state;
          if (st === SEND_STATES.SENDING || st === SEND_STATES.PENDING || st === SEND_STATES.STREAMING) {
            pending.push(cloneMessage(session.messages[i]));
          }
        }
        return { cursor: session.resumeCursor, pending: pending };
      },

      /** 只读快照（调试接缝 / 验证器用）。 */
      snapshot: function () {
        var out = { version: SCHEMA_VERSION, current: state.current, sessions: [] };
        for (var i = 0; i < state.sessions.length; i++) out.sessions.push(cloneSession(state.sessions[i]));
        return out;
      }
    };

    load();
    return api;
  }

  var globalApi = {
    SEND_STATES: SEND_STATES,
    MESSAGE_ROLES: { USER: ROLE_USER, ASSISTANT: ROLE_ASSISTANT, SYSTEM: ROLE_SYSTEM },
    ROLES: { USER: ROLE_USER, ASSISTANT: ROLE_ASSISTANT, SYSTEM: ROLE_SYSTEM },
    STORAGE_KEY: STORAGE_KEY,
    createStore: createStore,
    classifySendOutcome: classifySendOutcome
  };

  if (typeof window !== 'undefined' && window) window.PotbotConversation = globalApi;
  if (typeof globalThis !== 'undefined') globalThis.PotbotConversation = globalApi;
})();
