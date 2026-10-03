/*
 * potbot 完整 App —— 任务与文件操作（APP-04，纯逻辑，无 DOM 依赖）
 *
 * 由来（能力目录 APP-04）：
 *   「任务与文件可搜索、查看历史版本、重命名、打开、另存、分享；URI 授权、取消、
 *     读回与失权正确；三种办公格式分别交接到正确消费者。」
 *
 * 这个模块存在的唯一理由，是**把「哪些操作算成功」钉死在纯函数里**，不让页面
 * 自己去猜。三条硬不变量：
 *   ① **失败 / 失权不显示成功**：取消、撤销、过期、未授权、读回失败一律
 *      `showsSuccess === false`；
 *   ② **`stale_revision` 不显示成功**：读回针对的版本已经不是当前版本时，
 *      即使字节核验通过也不能算成功（否则会把旧版本冒充成最新件）；
 *   ③ **未算 SHA 不得声称已核验**：读回判定**复用** download-verify.js 的分类器
 *      （`digest_unavailable` 只允许说「未核对校验值」），本模块**不另造一套**。
 *
 * 本文件不碰 DOM、不发请求、不读全局状态：浏览器挂 `window.PotbotAssetOps`，
 * 测试用 `node:vm` 直接加载线上这一份（不复制实现）。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md` R201（跨对象归属）、
 * R205（删除/撤销语义分开，不假称外部副作用被撤销）、R253（URI 权限与目标应用
 * 交接回执）。能力目录 APP-04。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotAssetOps = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /* ===================== 常量 ===================== */

  /** 扩展名 → 应当交接给哪个消费者（APP-04「三种办公格式分别交接到正确消费者」）。 */
  var HANDOFF_TARGETS = {
    docx: 'Word / WPS 文字',
    xlsx: 'Excel / WPS 表格',
    pptx: 'PowerPoint / WPS 演示',
    pdf: 'PDF 阅读器'
  };

  /** URI 授权状态机。**没有**「隐式授权」这一态：没申请过就是 not_requested。 */
  var URI_STATES = {
    not_requested: 'not_requested',
    requested: 'requested',
    granted_volatile: 'granted_volatile',     /* 授权只在本次会话有效，重启即失效 */
    granted_persisted: 'granted_persisted',   /* 持久授权（takePersistableUriPermission） */
    cancelled: 'cancelled',
    expired: 'expired',
    revoked: 'revoked'
  };

  /**
   * 一次 URI 动作的**机器可判结果码**。
   * 只有 `readback_ok` 允许 `showsSuccess === true`。
   */
  var OUTCOME = {
    readback_ok: 'readback_ok',
    readback_failed: 'readback_failed',
    digest_unavailable: 'digest_unavailable',
    digest_mismatch: 'digest_mismatch',
    digest_not_recorded: 'digest_not_recorded',
    length_mismatch: 'length_mismatch',
    stale_revision: 'stale_revision',
    cancelled: 'cancelled',
    revoked: 'revoked',
    expired: 'expired',
    not_granted: 'not_granted',
    unknown: 'unknown'
  };

  var MAX_NAME_LENGTH = 120;
  var ILLEGAL_NAME = /[\\/:*?"<>|]/;

  /* ===================== 小工具 ===================== */

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function trimText(value) {
    return textOf(value).replace(/^\s+|\s+$/g, '');
  }

  /** 小写扩展名（不含点）。无扩展名、以点结尾、或没有字母数字 ⇒ ''。 */
  function extensionOf(name) {
    var value = textOf(name);
    var slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    var base = slash >= 0 ? value.slice(slash + 1) : value;
    var dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    var ext = base.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]+$/.test(ext) ? ext : '';
  }

  /**
   * 这个文件该交接给谁。`known === false` 表示**没有登记消费者**——
   * 页面据此如实说「不认识这种格式」，不猜一个软件名。
   */
  function handoffTargetFor(name) {
    var ext = extensionOf(name);
    var target = Object.prototype.hasOwnProperty.call(HANDOFF_TARGETS, ext)
      ? HANDOFF_TARGETS[ext] : '';
    return { ext: ext, target: target, known: target !== '' };
  }

  /* ===================== APP-04：搜索 ===================== */

  /**
   * 在任务 / 文件条目里搜索。对 `filename` / `instruction` / `taskId` / `requestId`
   * 做**大小写不敏感**的子串匹配；空 query 返回全部（并如实标 `hasQuery:false`）。
   * 命中项带上 `matchedOn`（命中了哪个字段），方便页面高亮与测试断言。
   */
  function searchEntries(entries, query) {
    var list = Array.isArray(entries) ? entries : [];
    var needle = trimText(query).toLowerCase();
    if (needle === '') {
      return { query: textOf(query), hasQuery: false, matched: list.slice(), total: list.length };
    }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var entry = isObject(list[i]) ? list[i] : {};
      var fields = ['filename', 'instruction', 'taskId', 'requestId'];
      for (var f = 0; f < fields.length; f++) {
        var hay = textOf(entry[fields[f]]).toLowerCase();
        if (hay !== '' && hay.indexOf(needle) >= 0) {
          var copy = {};
          for (var key in entry) {
            if (Object.prototype.hasOwnProperty.call(entry, key)) copy[key] = entry[key];
          }
          copy.matchedOn = fields[f];
          out.push(copy);
          break;   /* 一个条目只算命中一次，避免同一项重复出现 */
        }
      }
    }
    return { query: textOf(query), hasQuery: true, matched: out, total: list.length };
  }

  /* ===================== APP-04：历史版本 ===================== */

  /**
   * 取一个条目的历史版本。**只回真实存在的 `versions` 数组**：没有就回空数组，
   * 绝不按「当前版本号」凭空生成 1..n（那会把没发生过的版本说成存在过）。
   * 结果按 revision 降序（最新在前），第一条标 `isLatest`。
   */
  function versionHistory(entry) {
    var source = isObject(entry) ? entry : {};
    var versions = Array.isArray(source.versions) ? source.versions : [];
    var rows = [];
    for (var i = 0; i < versions.length; i++) {
      var v = isObject(versions[i]) ? versions[i] : {};
      var revision = (typeof v.revision === 'number' && isFinite(v.revision)) ? v.revision : null;
      if (revision === null) continue;   /* 没有版本的记录不冒充成一行版本 */
      rows.push({
        revision: revision,
        label: textOf(v.label) || ('版本 ' + revision),
        note: textOf(v.note),
        createdAt: typeof v.createdAt === 'number' ? v.createdAt : null,
        isLatest: false
      });
    }
    rows.sort(function (a, b) { return b.revision - a.revision; });
    if (rows.length > 0) rows[0].isLatest = true;
    return rows;
  }

  /* ===================== APP-04：重命名 ===================== */

  /**
   * 校验一次重命名。**只是校验**：本函数不改任何状态、不声称服务端已改名。
   * 返回 `{ok, code, name, message}`；`code` 为 '' 表示通过。
   */
  function validateRename(name, existingNames) {
    var raw = textOf(name);
    var trimmed = trimText(raw);
    if (trimmed === '') {
      return { ok: false, code: 'empty_name', name: '', message: '名字不能为空。' };
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      return { ok: false, code: 'too_long', name: trimmed,
        message: '名字太长了（' + trimmed.length + ' 字，上限 ' + MAX_NAME_LENGTH + ' 字）。' };
    }
    if (ILLEGAL_NAME.test(trimmed)) {
      return { ok: false, code: 'illegal_char', name: trimmed,
        message: '名字里不能包含 \\ / : * ? " < > | 这些字符。' };
    }
    var taken = Array.isArray(existingNames) ? existingNames : [];
    for (var i = 0; i < taken.length; i++) {
      if (textOf(taken[i]) === trimmed) {
        return { ok: false, code: 'duplicate', name: trimmed, message: '这个名字已经被占用了。' };
      }
    }
    return { ok: true, code: '', name: trimmed, message: '' };
  }

  /* ===================== APP-04：URI 授权 + 读回判定 ===================== */

  /** 授予态是否「还能用」的**形式**判断（不含读回结论）。 */
  function isGrantLive(state) {
    return state === URI_STATES.granted_persisted || state === URI_STATES.granted_volatile;
  }

  /**
   * 判定一次 URI 动作的最终结果。输入（全部可选，缺省即「没做过」）：
   *   grantState        当前授权态（URI_STATES 之一）
   *   requestedRevision 本次读回针对的文档版本
   *   currentRevision   服务端当前版本
   *   verdict           download-verify.js `classifyDownload` 的返回值
   *   cancelled/revoked/expired  显式终态标志（优先于 grantState）
   * 返回 `{code, showsSuccess, message, action}`：
   *   **`showsSuccess` 只有 `readback_ok` 一种为 true**，其余一律 false。
   */
  function evaluateUriAction(input) {
    var got = isObject(input) ? input : {};
    var state = textOf(got.grantState) || URI_STATES.not_requested;

    function fail(code, message, action) {
      return { code: code, showsSuccess: false, message: message, action: action || '' };
    }

    if (got.cancelled === true || state === URI_STATES.cancelled) {
      return fail(OUTCOME.cancelled, '你取消了这次操作，没有读回任何文件。', '可以重新发起一次。');
    }
    if (got.revoked === true || state === URI_STATES.revoked) {
      return fail(OUTCOME.revoked, '这个文件的访问授权已被撤销，本次没有读回文件。',
        '到「设置」里重新授权，或重新选择文件。');
    }
    if (got.expired === true || state === URI_STATES.expired) {
      return fail(OUTCOME.expired, '这次授权已经过期，本次没有读回文件。', '请重新选择文件以获得新授权。');
    }
    if (state === URI_STATES.not_requested || state === URI_STATES.requested) {
      return fail(OUTCOME.not_granted, '还没有拿到这个文件的访问授权，本次没有读回文件。',
        '请先选择文件并允许访问。');
    }
    if (!isGrantLive(state)) {
      return fail(OUTCOME.unknown, '授权状态无法识别，为安全起见本次不算成功。', '请重新选择文件。');
    }

    /* 版本闸门：读回的版本必须就是当前版本，否则**任何**核验结果都不算成功。 */
    var requested = got.requestedRevision;
    var current = got.currentRevision;
    if (typeof requested === 'number' && typeof current === 'number' && requested !== current) {
      return fail(OUTCOME.stale_revision,
        '读回的是旧版本（版本 ' + requested + '，当前是 ' + current + '），本次不算成功。',
        '请重新打开当前版本再操作。');
    }

    var verdict = isObject(got.verdict) ? got.verdict : null;
    if (!verdict) {
      return fail(OUTCOME.readback_failed, '没有拿到读回结果，本次不算成功。', '请重试。');
    }
    if (verdict.verified === true) {
      return { code: OUTCOME.readback_ok, showsSuccess: true,
        message: '已读回文件，长度与校验值都和电脑端登记一致。', action: '' };
    }
    if (verdict.status === 'digest_unavailable') {
      return fail(OUTCOME.digest_unavailable,
        '已读回文件、长度一致，但当前环境算不出校验值：本次**未核对校验值**。',
        '在安全上下文（https 或 localhost）下重试可完成校验。');
    }
    if (verdict.status === 'digest_not_recorded') {
      return fail(OUTCOME.digest_not_recorded, '电脑端没有登记校验值，无法核对，本次不算成功。', '请联系电脑端补齐登记。');
    }
    if (verdict.status === 'length_mismatch') {
      return fail(OUTCOME.length_mismatch, '取回的文件长度与登记不一致，已放弃。', '请重试；若持续不符，请重新生成。');
    }
    if (verdict.status === 'digest_mismatch') {
      return fail(OUTCOME.digest_mismatch, '取回的文件校验值与登记不符，已放弃。', '请重试；若持续不符，请重新生成。');
    }
    return fail(OUTCOME.readback_failed, textOf(verdict.note) || '读回未通过核验，本次不算成功。', '请重试。');
  }

  /**
   * URI 授权台账。每条记录带 `operationId`，只终结一次；读回结论存在记录上，
   * 由 `evaluate` 复用 `evaluateUriAction`。
   * 注入 `now` / `makeId` 便于确定性测试。
   */
  function createUriGrantTracker(options) {
    var opt = isObject(options) ? options : {};
    var now = typeof opt.now === 'function' ? opt.now : function () { return Date.now(); };
    var seq = 0;
    var makeId = typeof opt.makeId === 'function' ? opt.makeId : function () { return 'uri-' + (++seq); };

    var store = {};
    var order = [];


    function request(request) {
      var req = isObject(request) ? request : {};
      var id = makeId();
      var rec = {
        operationId: id,
        documentId: textOf(req.documentId),
        uri: textOf(req.uri),
        revision: (typeof req.revision === 'number' && isFinite(req.revision)) ? req.revision : null,
        state: URI_STATES.requested,
        persisted: false,
        readback: null,
        requestedAt: now(),
        settledAt: null
      };
      store[id] = rec;
      order.push(id);
      return rec;
    }

    function withRecord(id, mutate) {
      var rec = store[textOf(id)];
      if (!rec) return null;
      mutate(rec);
      return rec;
    }

    function grant(id, info) {
      var details = isObject(info) ? info : {};
      return withRecord(id, function (rec) {
        rec.persisted = details.persisted === true;
        rec.state = rec.persisted ? URI_STATES.granted_persisted : URI_STATES.granted_volatile;
      });
    }

    function terminalize(id, state) {
      return withRecord(id, function (rec) {
        rec.state = state;
        rec.readback = null;      /* 终态后读回结论作废，不残留为「可用」 */
        rec.settledAt = now();
      });
    }

    function cancel(id) { return terminalize(id, URI_STATES.cancelled); }
    function revoke(id) { return terminalize(id, URI_STATES.revoked); }
    function expire(id) { return terminalize(id, URI_STATES.expired); }

    /**
     * 记一次读回。`info`：`{ ok, currentRevision, verdict }`。
     * 只落记录，不改授权态；结论由 `evaluate` 现算。
     */
    function readback(id, info) {
      var details = isObject(info) ? info : {};
      return withRecord(id, function (rec) {
        rec.readback = {
          ok: details.ok === true,
          currentRevision: (typeof details.currentRevision === 'number' && isFinite(details.currentRevision))
            ? details.currentRevision : null,
          verdict: isObject(details.verdict) ? details.verdict : null
        };
      });
    }

    function stateOf(id) {
      var rec = store[textOf(id)];
      return rec ? rec.state : null;
    }

    /** 现算一条记录的最终结论：撤销/取消/过期**永远**不是成功。 */
    function evaluate(id) {
      var rec = store[textOf(id)];
      if (!rec) return { code: OUTCOME.unknown, showsSuccess: false, message: '没有这条授权记录。', action: '' };
      var rb = rec.readback;
      return evaluateUriAction({
        grantState: rec.state,
        requestedRevision: rec.revision,
        currentRevision: rb ? rb.currentRevision : rec.revision,
        verdict: rb ? rb.verdict : null
      });
    }

    /**
     * 文件现在**是否可读**：只有「授权仍有效」且「结论是 readback_ok」才为真。
     * 取消 / 失权 / 过期 / stale_revision ⇒ 恒 false。
     */
    function usable(id) {
      var rec = store[textOf(id)];
      if (!rec || !isGrantLive(rec.state)) return false;
      return evaluate(id).showsSuccess === true;
    }

    function records() {
      var out = [];
      for (var i = 0; i < order.length; i++) out.push(store[order[i]]);
      return out;
    }

    return {
      request: request,
      grant: grant,
      cancel: cancel,
      revoke: revoke,
      expire: expire,
      readback: readback,
      stateOf: stateOf,
      evaluate: evaluate,
      usable: usable,
      records: records
    };
  }

  /* ===================== APP-04：可用动作 ===================== */

  /**
   * 一个条目上「打开 / 另存 / 分享 / 重命名 / 历史版本」哪些可用、哪些不可用及原因。
   * **不可用就明确说原因**，不把按钮留成能点但没反应的空壳。
   * ctx：`{ hasGrant, usable, hasVersions, readOnly }`。
   */
  function availableActions(entry, ctx) {
    var item = isObject(entry) ? entry : {};
    var context = isObject(ctx) ? ctx : {};
    var name = textOf(item.filename) || textOf(item.instruction);
    var handoff = handoffTargetFor(name);
    var readable = context.usable === true;

    function row(id, label, enabled, reason) {
      return { id: id, label: label, enabled: enabled === true, reason: enabled === true ? '' : textOf(reason) };
    }

    return [
      row('open', '打开',
        readable && handoff.known,
        !handoff.known ? '这个格式没有登记可打开它的应用，不猜一个给你。'
          : '还没有读回这个文件（授权或核验未通过），现在打开不了。'),
      row('saveAs', '另存',
        readable,
        '还没有读回这个文件，另存会拿不到内容，因此不可用。'),
      row('share', '分享',
        readable && handoff.known,
        !handoff.known ? '这个格式没有登记消费者，不猜一个给你。'
          : '还没有读回这个文件，没有可分享的内容。'),
      row('rename', '重命名',
        context.readOnly !== true,
        '这个条目是只读的（历史版本），不能改名。'),
      row('history', '历史版本',
        context.hasVersions === true,
        '服务端没有返回任何历史版本，本页不凭空列出。')
    ];
  }

  /** 结果码 → 页面可显示的一句话与「用户能做什么」。 */
  function describeOutcome(code) {
    var messages = {};
    messages[OUTCOME.readback_ok] = { text: '已完成并核对通过。', action: '' };
    messages[OUTCOME.cancelled] = { text: '已取消，没有产生任何结果。', action: '可重新发起。' };
    messages[OUTCOME.revoked] = { text: '授权已被撤销，操作没有完成。', action: '请到「设置」重新授权。' };
    messages[OUTCOME.expired] = { text: '授权已过期，操作没有完成。', action: '请重新选择文件。' };
    messages[OUTCOME.not_granted] = { text: '没有授权，操作没有完成。', action: '请先选择文件并允许访问。' };
    messages[OUTCOME.stale_revision] = { text: '针对的是旧版本，操作没有完成。', action: '请打开当前版本再试。' };
    messages[OUTCOME.digest_unavailable] = { text: '未核对校验值，不算已核验。', action: '在安全上下文下重试。' };
    messages[OUTCOME.readback_failed] = { text: '读回未通过核验，操作没有完成。', action: '请重试。' };
    var found = Object.prototype.hasOwnProperty.call(messages, textOf(code)) ? messages[code] : null;
    return found || { text: '结果未知，按未完成处理。', action: '请重试。' };
  }

  return {
    HANDOFF_TARGETS: HANDOFF_TARGETS,
    URI_STATES: URI_STATES,
    OUTCOME: OUTCOME,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    extensionOf: extensionOf,
    handoffTargetFor: handoffTargetFor,
    searchEntries: searchEntries,
    versionHistory: versionHistory,
    validateRename: validateRename,
    isGrantLive: isGrantLive,
    evaluateUriAction: evaluateUriAction,
    createUriGrantTracker: createUriGrantTracker,
    availableActions: availableActions,
    describeOutcome: describeOutcome
  };
});
