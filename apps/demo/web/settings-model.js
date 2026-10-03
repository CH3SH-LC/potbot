/*
 * potbot 完整 App —— 设置与授权（APP-07，纯逻辑，无 DOM 依赖）
 *
 * 由来（能力目录 APP-07）：
 *   「授权入口、撤销、账号/服务连接、额度与存储管理；错误给出用户能采取的动作；
 *     密钥不进 APK、网页或普通日志。」
 *
 * 这个模块把四件事钉成纯函数：
 *   ① **授权台账**：每个权限有一态（未申请/已申请/已授予/已拒绝/已撤销），撤销要有
 *      明确的「撤销了什么、没撤销什么」——**不假称已经发生的外部副作用被撤回**（R205）；
 *   ② **连接状态**：把「已配置」与「已实测通过」分开显示（沿用页面既有的诚实口径）；
 *   ③ **额度与存储**：电脑端没上报就是**未知**，绝不写成 0；
 *   ④ **密钥不外泄**：`redactSecrets` / `findSecrets` / `assertNoSecrets` 三层，
 *      供页面与测试共用同一份形态。
 *
 * ⚠️ 本文件源码**自身**不得包含任何密钥形态的字面量（否则会被
 * `tests/demo/demo-host-discipline.test.ts` 的页面泄漏扫描命中，也会让本模块的
 * 自我断言变成空断言）。因此所有形态都用**字符码拼接**构建，源码里看不到那些词。
 *
 * 本文件不碰 DOM、不发请求：浏览器挂 `window.PotbotSettingsModel`，测试用
 * `node:vm` 直接加载线上这一份。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md` R205（删除/撤销语义分开）、
 * R253（远程与本机工具边界明示）、R258（界面资源/认证/断线状态完整，密钥不进
 * APK、网页或普通日志）。能力目录 APP-07。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotSettingsModel = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /* ===================== 通用小工具 ===================== */

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function toInt(value) {
    return (typeof value === 'number' && isFinite(value)) ? value : null;
  }

  /* ===================== 密钥形态（字符码构建，避免源码自命中） ===================== */

  /** 把一串字符码还原成字符串。用它构建形态，源码里就不会出现那些关键词。 */
  function c() {
    return String.fromCharCode.apply(null, arguments);
  }

  var WORD_BOUNDARY = '\\b';
  var BODY = '[A-Za-z0-9_\\-]';

  var SECRET_SHAPES = [
    { id: 'vendor_prefix_key', label: '厂商密钥',
      re: new RegExp(WORD_BOUNDARY + c(115, 107) + '-' + BODY + '{12,}') },
    { id: 'aws_access_key', label: '云安全访问密钥',
      re: new RegExp(WORD_BOUNDARY + c(65, 75, 73, 65) + '[0-9A-Z]{16}' + WORD_BOUNDARY) },
    { id: 'google_browser_key', label: '浏览器密钥',
      re: new RegExp(WORD_BOUNDARY + c(65, 73, 122, 97) + '[A-Za-z0-9_\\-]{35}') },
    { id: 'github_token', label: '代码平台令牌',
      re: new RegExp(WORD_BOUNDARY + c(103, 104, 112, 95) + '[A-Za-z0-9]{36}' + WORD_BOUNDARY) },
    { id: 'auth_header_token', label: '授权头令牌',
      re: new RegExp(WORD_BOUNDARY + c(66, 101, 97, 114, 101, 114) + '\\s+[A-Za-z0-9._\\-]{8,}') },
    { id: 'private_key_pem', label: 'PEM 私钥块',
      re: new RegExp(c(45, 45, 45, 45, 45, 66, 69, 71, 73, 78) + '[A-Z ]*' +
        c(80, 82, 73, 86, 65, 84, 69, 32, 75, 69, 89)) },
    { id: 'assigned_secret', label: '赋值字面直写密钥',
      re: new RegExp('(?:' + c(97, 112, 105) + '[_-]?' + c(107, 101, 121) + '|' +
        c(115, 101, 99, 114, 101, 116) + '|' + c(116, 111, 107, 101, 110) + '|' +
        c(112, 97, 115, 115, 119, 111, 114, 100) + ')\\s*[:=]\\s*["\']' + '[^"\']{12,}["\']', 'i') }
  ];

  /** 找出文本里的密钥形态。preview 已打码（只留头 4 尾 2），不会把原文带出去。 */
  function findSecrets(text) {
    var value = textOf(text);
    var findings = [];
    for (var i = 0; i < SECRET_SHAPES.length; i++) {
      var shape = SECRET_SHAPES[i];
      var re = new RegExp(shape.re.source, shape.re.flags.indexOf('g') >= 0 ? shape.re.flags : shape.re.flags + 'g');
      var match;
      while ((match = re.exec(value)) !== null) {
        findings.push({
          id: shape.id,
          label: shape.label,
          index: match.index,
          preview: maskToken(match[0])
        });
        if (match.index === re.lastIndex) re.lastIndex += 1;   /* 防空转 */
      }
    }
    findings.sort(function (a, b) { return a.index - b.index; });
    return findings;
  }

  /** 把一段疑似密钥打码成 `前4…后2（共n字符）`。短串整体打码。 */
  function maskToken(token) {
    var value = textOf(token);
    if (value.length <= 6) return '[已打码]';
    return value.slice(0, 4) + '…' + value.slice(-2) + '（共 ' + value.length + ' 字符）';
  }

  /** 把文本里所有密钥形态替换成 `[已隐藏:标签]`。用于任何要写进日志的字符串。 */
  function redactSecrets(text) {
    var value = textOf(text);
    for (var i = 0; i < SECRET_SHAPES.length; i++) {
      var shape = SECRET_SHAPES[i];
      var re = new RegExp(shape.re.source, shape.re.flags.indexOf('g') >= 0 ? shape.re.flags : shape.re.flags + 'g');
      value = value.replace(re, '[已隐藏:' + shape.label + ']');
    }
    return value;
  }

  /**
   * 断言一段文本里没有密钥。返回 `{ok, findings}`。
   * 页面在渲染完设置页后调它自检：**发现即视为页面缺陷**。
   */
  function assertNoSecrets(text) {
    var findings = findSecrets(text);
    return { ok: findings.length === 0, findings: findings };
  }

  /** 写日志前的统一出口：**先脱敏再写**。 */
  function safeLogLine(message) {
    return redactSecrets(textOf(message));
  }

  /* ===================== 授权台账（APP-07） ===================== */

  var AUTHORIZATION_STATES = {
    not_requested: 'not_requested',
    requested: 'requested',
    granted: 'granted',
    denied: 'denied',
    revoked: 'revoked'
  };

  var STATE_LABEL = {};
  STATE_LABEL[AUTHORIZATION_STATES.not_requested] = '未申请';
  STATE_LABEL[AUTHORIZATION_STATES.requested] = '已申请（待你确认）';
  STATE_LABEL[AUTHORIZATION_STATES.granted] = '已授予';
  STATE_LABEL[AUTHORIZATION_STATES.denied] = '已拒绝';
  STATE_LABEL[AUTHORIZATION_STATES.revoked] = '已撤销';

  /**
   * 授权清单。`systemPath` 是**用户在安卓系统里的实际去处**——撤销入口不能只
   * 停在本页，必须告诉用户系统里在哪改（APP-07「错误给出用户能采取的动作」的同类要求）。
   */
  var AUTHORIZATION_ENTRIES = [
    { id: 'files', label: '文件与文档访问',
      scope: '通过系统文件选择器读入你挑中的文档',
      why: '导入 DOCX 等文件时需要', revocable: true,
      systemPath: '系统「设置 → 应用 → potbot → 权限」或直接重新选择文件' },
    { id: 'notifications', label: '通知',
      scope: '后台任务完成或需要你确认时提醒你', why: '前台关掉后仍能获知进度',
      revocable: true, systemPath: '系统「设置 → 应用 → potbot → 通知」' },
    { id: 'background', label: '后台运行',
      scope: '退后台/锁屏后继续推进任务', why: '长任务不必一直开着页面',
      revocable: true, systemPath: '系统「设置 → 应用 → potbot → 电池 → 不受限制」' },
    { id: 'calendar', label: '日历读写',
      scope: '按你的要求创建或修改日程', why: '涉及日程的任务需要',
      revocable: true, systemPath: '系统「设置 → 应用 → potbot → 权限 → 日历」' },
    { id: 'clock', label: '时钟与闹钟',
      scope: '按你的要求设定闹钟或计时', why: '涉及提醒的任务需要',
      revocable: true, systemPath: '系统「设置 → 应用 → potbot → 权限」或时钟应用' },
    { id: 'storage', label: '存储空间',
      scope: '在本机保存必要的运行数据', why: '缓存与临时文件',
      revocable: true, systemPath: '系统「设置 → 应用 → potbot → 存储」' },
    { id: 'network', label: '网络访问',
      scope: '连接你指定的电脑服务/后端', why: '生成与同步都走网络',
      revocable: false, systemPath: '（网络权限不可单独撤销，由系统管理）' }
  ];

  var REVOKE_NOTE =
    '撤销只影响**今后**的使用：已经生成、已经分享、已经交给其它应用的文件**不会被撤回**，' +
    '已经发生的外部动作也不会被撤销（R205）。';

  /**
   * 建一个授权台账。默认全部 `not_requested`——**不假定任何权限已经拿到**。
   */
  function createAuthorizationRegistry(initial) {
    var states = {};
    for (var i = 0; i < AUTHORIZATION_ENTRIES.length; i++) {
      states[AUTHORIZATION_ENTRIES[i].id] = AUTHORIZATION_STATES.not_requested;
    }
    if (isObject(initial)) {
      for (var key in initial) {
        if (Object.prototype.hasOwnProperty.call(states, key)) {
          var candidate = textOf(initial[key]);
          if (Object.prototype.hasOwnProperty.call(STATE_LABEL, candidate)) states[key] = candidate;
        }
      }
    }

    function descriptor(id) {
      for (var j = 0; j < AUTHORIZATION_ENTRIES.length; j++) {
        if (AUTHORIZATION_ENTRIES[j].id === id) return AUTHORIZATION_ENTRIES[j];
      }
      return null;
    }

    function setState(id, state) {
      var entry = descriptor(id);
      if (!entry) return { ok: false, code: 'unknown_entry', entry: null, note: '' };
      if (!Object.prototype.hasOwnProperty.call(STATE_LABEL, textOf(state))) {
        return { ok: false, code: 'unknown_state', entry: null, note: '' };
      }
      states[id] = state;
      return { ok: true, code: '', entry: view(entry), note: '' };
    }

    function view(entry) {
      var state = states[entry.id];
      return {
        id: entry.id, label: entry.label, scope: entry.scope, why: entry.why,
        systemPath: entry.systemPath, revocable: entry.revocable,
        state: state, stateLabel: STATE_LABEL[state],
        granted: state === AUTHORIZATION_STATES.granted,
        canRevoke: entry.revocable && state === AUTHORIZATION_STATES.granted,
        note: entry.revocable ? '' : '这个权限不能在本应用内撤销，需要在系统设置里管理。'
      };
    }

    /**
     * 撤销一项授权。返回 `{ok, code, entry, note}`。
     * - 不可撤销项（如网络）拒绝并说明原因；
     * - 已经是撤销态：`already_revoked`（幂等，不重复记一次）；
     * - **返回的 note 永远包含「没撤销什么」**，避免让人以为外部副作用被回滚。
     */
    function revoke(id) {
      var entry = descriptor(id);
      if (!entry) return { ok: false, code: 'unknown_entry', entry: null, note: '' };
      if (!entry.revocable) {
        return { ok: false, code: 'not_revocable', entry: view(entry),
          note: '这一项不能在本应用内撤销，请到系统设置里管理。' };
      }
      if (states[id] === AUTHORIZATION_STATES.revoked) {
        return { ok: false, code: 'already_revoked', entry: view(entry), note: REVOKE_NOTE };
      }
      states[id] = AUTHORIZATION_STATES.revoked;
      return { ok: true, code: '', entry: view(entry), note: REVOKE_NOTE };
    }

    function entries() {
      var out = [];
      for (var k = 0; k < AUTHORIZATION_ENTRIES.length; k++) out.push(view(AUTHORIZATION_ENTRIES[k]));
      return out;
    }

    function stateOf(id) {
      return Object.prototype.hasOwnProperty.call(states, textOf(id)) ? states[id] : null;
    }

    /** 已授予的项——页面据此显示「当前能做什么」。 */
    function granted() {
      return entries().filter(function (item) { return item.state === AUTHORIZATION_STATES.granted; });
    }

    return {
      entries: entries,
      stateOf: stateOf,
      granted: granted,
      setState: setState,
      request: function (id) { return setState(id, AUTHORIZATION_STATES.requested); },
      grant: function (id) { return setState(id, AUTHORIZATION_STATES.granted); },
      deny: function (id) { return setState(id, AUTHORIZATION_STATES.denied); },
      revoke: revoke
    };
  }

  /* ===================== 连接状态（APP-07 / R258） ===================== */

  /**
   * 连接摘要。**「已配置」与「已实测通过」分开**：没有真的调通过一次模型，
   * 就不写「可用」。`input`：`{service:{origin,configured,verified}, account:{signedIn,name}}`。
   */
  function connectionSummary(input) {
    var got = isObject(input) ? input : {};
    var service = isObject(got.service) ? got.service : {};
    var account = isObject(got.account) ? got.account : {};
    var rows = [];

    rows.push({
      key: 'service_origin', label: '服务地址',
      value: textOf(service.origin) || '未知（页面读不到地址）',
      tone: textOf(service.origin) ? 'ok' : 'unknown'
    });
    rows.push({
      key: 'service_reachable', label: '服务可达',
      value: service.reachable === true ? '是' : (service.reachable === false ? '否' : '未知'),
      tone: service.reachable === true ? 'ok' : (service.reachable === false ? 'bad' : 'unknown')
    });
    rows.push({
      key: 'model_configured', label: '模型已配置',
      value: service.configured === true ? '是' : (service.configured === false ? '否' : '未知'),
      tone: service.configured === true ? 'ok' : 'unknown'
    });
    rows.push({
      key: 'model_verified', label: '模型实调通过',
      value: service.verified === true ? '是（本机真的成功调过一次）' : '否 / 未知',
      tone: service.verified === true ? 'ok' : 'unknown'
    });
    rows.push({
      key: 'account', label: '账号',
      value: account.signedIn === true ? ('已登录' + (textOf(account.name) ? '：' + textOf(account.name) : '')) : '未登录',
      tone: account.signedIn === true ? 'ok' : 'unknown'
    });

    return {
      rows: rows,
      note: '「已配置」只表示电脑端填好了模型信息；**「实调通过」才是真的调用成功过一次模型**，两者不是一回事。'
    };
  }

  /* ===================== 额度与存储（APP-07） ===================== */

  /** 字节数 → 人类可读。**非法/缺失输入返回「未知」，绝不返回 0**。 */
  function formatBytes(value) {
    var n = toInt(value);
    if (n === null || n < 0) return '未知';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var size = n;
    var unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size = size / 1024; unit++; }
    var shown = unit === 0 ? String(size) : size.toFixed(size >= 100 ? 0 : 1);
    return shown + ' ' + units[unit];
  }

  /**
   * 额度摘要。电脑端没上报 ⇒ `known:false` 且值显示「未知」。
   * `input`：`{quotaBytes, usedBytes, unlimited}`。
   */
  function quotaSummary(input) {
    var got = isObject(input) ? input : {};
    var unlimited = got.unlimited === true;
    var quota = toInt(got.quotaBytes);
    var used = toInt(got.usedBytes);
    var known = unlimited || (quota !== null && used !== null);

    var rows = [];
    if (unlimited) {
      rows.push({ key: 'quota', label: '额度', value: '不限量', tone: 'ok' });
      rows.push({ key: 'used', label: '已用', value: formatBytes(used), tone: 'ok' });
    } else if (quota !== null && used !== null) {
      var left = quota - used;
      var percent = quota > 0 ? Math.round((used / quota) * 100) : null;
      rows.push({ key: 'quota', label: '总额度', value: formatBytes(quota), tone: 'ok' });
      rows.push({ key: 'used', label: '已用', value: formatBytes(used) + (percent === null ? '' : '（' + percent + '%）'),
        tone: percent !== null && percent >= 90 ? 'warn' : 'ok' });
      rows.push({ key: 'left', label: '剩余', value: formatBytes(left < 0 ? 0 : left),
        tone: left <= 0 ? 'bad' : 'ok' });
    } else {
      rows.push({ key: 'quota', label: '总额度', value: '未知', tone: 'unknown' });
      rows.push({ key: 'used', label: '已用', value: '未知', tone: 'unknown' });
    }

    return {
      known: known,
      rows: rows,
      note: known
        ? '额度由电脑端/服务端上报；本页只是显示，不在这里修改。'
        : '电脑端还没有上报额度信息，本页如实显示**未知**，不会替你填一个 0。'
    };
  }

  /** 本机存储摘要。`input`：`{records, sessions, files, bytes}`。 */
  function storageSummary(input) {
    var got = isObject(input) ? input : {};
    function count(value) { return toInt(value) === null ? '未知' : String(value); }
    return {
      rows: [
        { key: 'records', label: '本机任务记录', value: count(got.records) + ' 条' },
        { key: 'sessions', label: '本机会话', value: count(got.sessions) + ' 个' },
        { key: 'files', label: '本机缓存文件', value: count(got.files) + ' 个' },
        { key: 'bytes', label: '本机占用', value: formatBytes(got.bytes) }
      ],
      note: '清理本机记录只影响这台手机上的记录，**不会删除电脑上已生成的文件**，也不撤销任何已发生的外部动作。'
    };
  }

  /* ===================== 错误 → 用户能采取的动作（APP-07） ===================== */

  var ERROR_ACTIONS = {
    network_unreachable: {
      title: '连不上电脑服务', retryable: true,
      action: '确认手机和电脑在同一个网络、电脑端服务已启动，然后重试。'
    },
    backend_unavailable: {
      title: '对话后端尚未接入', retryable: false,
      action: '当前版本还不能连续对话；可以先到「任务」页用一次性生成。'
    },
    unauthorized: {
      title: '登录已失效', retryable: false,
      action: '到本页上方重新连接账号后再试。'
    },
    permission_denied: {
      title: '缺少必要授权', retryable: false,
      action: '在下面的授权清单里找到对应项并授予；系统里的开关位置也写在那里。'
    },
    uri_revoked: {
      title: '文件授权已失效', retryable: true,
      action: '重新选择一次这个文件，以获得新的访问授权。'
    },
    stale_revision: {
      title: '针对的是旧版本', retryable: true,
      action: '打开当前版本后重新操作；不要用旧版本继续改。'
    },
    quota_exceeded: {
      title: '额度已用尽', retryable: false,
      action: '等到额度恢复或联系服务提供方；本页只显示，不改额度。'
    },
    storage_full: {
      title: '本机存储已满', retryable: true,
      action: '清理本机缓存或删除不需要的本机记录后重试。'
    },
    model_not_configured: {
      title: '电脑端还没配置模型', retryable: false,
      action: '这是电脑端的配置问题，请在电脑上完成模型配置。'
    },
    unknown: {
      title: '发生了未知问题', retryable: true,
      action: '可以重试一次；若持续失败，请把「详细信息」里的请求编号提供给开发者。'
    }
  };

  /** 错误码 → `{code, title, action, retryable}`。未知码归到 `unknown`。 */
  function actionForError(code) {
    var key = textOf(code);
    var found = Object.prototype.hasOwnProperty.call(ERROR_ACTIONS, key) ? ERROR_ACTIONS[key] : ERROR_ACTIONS.unknown;
    return {
      code: Object.prototype.hasOwnProperty.call(ERROR_ACTIONS, key) ? key : 'unknown',
      title: found.title,
      action: found.action,
      retryable: found.retryable === true
    };
  }

  /** 面向用户的一句话：密钥永不进入页面、APK 与普通日志。 */
  var SECRET_POLICY_NOTE =
    '本页与手机应用里**不保存、不显示、不写入普通日志**任何服务密钥；' +
    '日志出口统一先脱敏（redactSecrets）再写。密钥只应留在你电脑端的配置里。';

  return {
    AUTHORIZATION_STATES: AUTHORIZATION_STATES,
    AUTHORIZATION_ENTRIES: AUTHORIZATION_ENTRIES,
    STATE_LABEL: STATE_LABEL,
    REVOKE_NOTE: REVOKE_NOTE,
    SECRET_POLICY_NOTE: SECRET_POLICY_NOTE,
    createAuthorizationRegistry: createAuthorizationRegistry,
    connectionSummary: connectionSummary,
    quotaSummary: quotaSummary,
    storageSummary: storageSummary,
    formatBytes: formatBytes,
    actionForError: actionForError,
    findSecrets: findSecrets,
    redactSecrets: redactSecrets,
    assertNoSecrets: assertNoSecrets,
    maskToken: maskToken,
    safeLogLine: safeLogLine
  };
});
