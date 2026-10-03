/*
 * potbot 完整 App —— 管理面板公共层（四个管理面板的真实请求与四态分流）
 *
 * 由来（问题：**能力有、用户够不到**）：
 *   服务端已经有 `/api/documents/**`、`/api/research/**`、`/api/memory/**`、
 *   `/api/plugins/**` 等**已挂载且真服务实测 200** 的路由，但手机页面上没有任何入口
 *   能用到它们。本层与 `panel-*.js` 一起，把这些能力接到四个视图上：
 *   **文件·产物 / 记忆管理 / 模板管理 / 权限与连接设置**。
 *
 * 本层只做三件事，且**不另造状态系统**：
 *   ① **四态分流**：把「加载中 / 空 / 失败 / 离线」判成 `app-nav.js` 的四态
 *      （`empty` / `loading` / `error` / `offline`），交回页面由 `nav-view.js` 渲染
 *      —— `data-nav-state` / 语气色 / 动作按钮一律复用既有那套，本层**不复制**它的文案；
 *   ② **后端错误 → 人话 + 可采取的动作**：`documents_not_ready`、
 *      `injection_limit_violation`、`memory_not_ready`、`plugin_store_unwired` 这类
 *      **结构化错误码不当正文**——正文是一句人话，码收进「查看原因」里，
 *      服务端给的 `unlock`（解锁步骤）翻成「你可以：…」的可执行步骤；
 *   ③ **真实请求**：每个面板**真的发一次 `fetch`**（经宿主注入的 `request`），
 *      用响应体渲染成行；**不发占位请求、不拿假数据充数**。
 *
 * 第二批（问题：**看得见、动不了**）在本层之上只加**可操作**所需的三件事：
 *   ④ **二次确认层**（`askConfirm`）：危险动作（忘记一条记忆）先弹确认层；
 *      **点「取消」绝不发请求**，点「确认」才走下一步——确认层本身不落任何请求；
 *   ⑤ **真实写请求**（`runWrite`）：POST 一次，成功/失败都给人话；**没有请求通道
 *      就说没有，不假装发过**；失败按结构化码翻人话（未知码也有通用人话）；
 *   ⑥ **动作结果落在 `panel-<view>-status`**（`setActionStatus`），**不覆盖**四态条；
 *      写成功**不等于**生效——调用方（记忆面板）会**重新读取**清单再核对。
 *
 * ⚠️ 缺 `app-nav.js` / `nav-view.js` 时本层的四态分流**不降级成自造文案**：
 *    `onState` 仍如实上报四态名，由页面决定怎么画（`app.js` 有它自己的降级路径）。
 * ⚠️ 浏览器 / 真机渲染**未验证**：本层只把节点与状态建出来，没有浏览器自动化去点。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md` R258（界面资源与断线状态完整）、
 * R253（远程与本机工具边界明示）；能力目录 APP-02 / APP-04 / APP-05 / APP-06 / APP-07。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotPanels = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function defaultScope() {
    if (typeof globalThis !== 'undefined' && globalThis) return globalThis;
    if (typeof window !== 'undefined' && window) return window;
    return null;
  }

  function defaultDoc(options) {
    if (options && options.document) return options.document;
    if (typeof document !== 'undefined' && document) return document;
    return null;
  }

  /* ===================== ② 后端错误 → 人话 + 可采取的动作 ===================== */

  /**
   * 结构化错误码 → **用户能理解的一句人话** + **他能做的一步**。
   * 这里刻意**只写本层真正见过的码**；没见过的码走通用人话，**绝不把码当正文**
   * （码只出现在「查看原因」里，由 `nav-view.js` 的 `view-state-reason` 承载）。
   */
  var BACKEND_ERRORS = {
    documents_not_ready: {
      message: '电脑端的文档工作流还没接上，现在读不到它能做什么。',
      action: '在电脑端把文档端口接上后重试'
    },
    memory_not_ready: {
      message: '电脑端还没有接上记忆存储，现在读不到你让它记住的东西。',
      action: '在电脑端接上记忆存储后重试'
    },
    memory_unreadable: {
      message: '记忆存储里的内容读不出来，可能已损坏或权限不足。',
      action: '先在电脑端检查记忆存储文件是否可读，再重试'
    },
    injection_limit_violation: {
      message: '这次一次要读的条数超过了允许的上限，电脑端按纪律拒绝了整次读取。',
      action: '把一次要读的条数调小（≤ 50 条）后重试'
    },
    plugin_store_unwired: {
      message: '电脑端还没有接上模板的安装状态存储，现在读不到模板清单。',
      action: '在电脑端接上模板安装状态存储后重试'
    },
    research_not_ready: {
      message: '电脑端的检索端口还没接上，现在读不到联网与抓取能力。',
      action: '在电脑端接上检索端口后重试'
    },
    not_found: {
      message: '电脑端没有这个接口，可能页面与电脑端版本不一致。',
      action: '核对手机页面与电脑端服务是否为同一次构建'
    },
    /* --- 可操作（FA-WEB-PANEL-DEPTH）后新见的写侧码 ------------------------- */
    illegal_transition: {
      message: '电脑端不接受这次状态切换（例如模板还没安装就要启用）。',
      action: '按清单里的解锁动作补齐前置状态（安装 → 启用 → 授权）后再试'
    },
    unknown_plugin: {
      message: '电脑端的模板注册目录里已经没有这一项了，可能是清单变了。',
      action: '点「重新读取模板目录」拿到最新清单后再试'
    },
    invalid_action: {
      message: '这个动作电脑端不认，可能是页面与电脑端版本不一致。',
      action: '核对手机页面与电脑端服务是否为同一次构建'
    },
    memory_action_failed: {
      message: '电脑端没能完成这条记忆的变更。',
      action: '稍后重试；一直失败就检查电脑端的记忆存储是否可写'
    },
    artifact_unknown: {
      message: '电脑端没有这个产物，可能编号写错或产物已被清理。',
      action: '先在「任务」页生成一次，再点这边的「导出/下载」'
    },
    artifact_not_published: {
      message: '这个产物还没由电脑端发布，按纪律不提供下载。',
      action: '等这次生成在「任务」页走到完成，再点「导出/下载」'
    },
    artifact_file_missing: {
      message: '电脑端登记的产物文件已经不在磁盘上了。',
      action: '在「任务」页重新生成一次，再点「导出/下载」'
    },
    document_port_unavailable: {
      message: '电脑端的文档端口没接上，现在回读不了产物文件。',
      action: '在电脑端接上文档端口后重试'
    },
    method_not_allowed: {
      message: '这个接口不接受本页使用的请求方式，可能是版本不一致。',
      action: '核对手机页面与电脑端服务是否为同一次构建'
    },
    invalid_owner_id: {
      message: '这次读取缺少有效的归属标识，电脑端拒绝了。',
      action: '重新加载页面后再试'
    },
    not_ready: {
      message: '电脑端还没有准备好这一项能力。',
      action: '在电脑端接上对应端口后重试'
    }
  };

  var GENERIC_MESSAGE = '电脑端这次没能把内容取回来，原因不在你的操作。';
  var GENERIC_ACTION = '点「重试」再来一次；一直失败就检查与电脑端的连接';

  /** 某个后端码对用户说的话（未知码 → 通用人话，**不出现码本身**）。 */
  function backendMessage(code) {
    var key = textOf(code);
    if (hasOwn(BACKEND_ERRORS, key)) return BACKEND_ERRORS[key].message;
    return GENERIC_MESSAGE;
  }

  /** 某个后端码对应的「你能做什么」。 */
  function backendAction(code) {
    var key = textOf(code);
    if (hasOwn(BACKEND_ERRORS, key)) return BACKEND_ERRORS[key].action;
    return GENERIC_ACTION;
  }

  /**
   * 把结构化错误拼成给用户的一句话。
   * `detail`（服务端原文）与错误码一样**不当正文**——它们只在「查看原因」里出现；
   * 这里只用「人话 + 你能做什么 + 服务端给的 unlock 解锁步骤」。
   */
  function humanizeBackend(code, unlock) {
    var message = backendMessage(code);
    var steps = [];
    var action = backendAction(code);
    if (action !== '') steps.push(action);
    if (Array.isArray(unlock)) {
      for (var i = 0; i < unlock.length; i++) {
        var step = textOf(unlock[i]);
        if (step !== '' && steps.indexOf(step) < 0) steps.push(step);
      }
    }
    if (steps.length === 0) return message;
    return message + ' 你可以：' + steps.join('；') + '。';
  }

  /* ===================== ① 四态分流 ===================== */

  /** 把一次 HTTP 失败判成四态里的 `error`，并给出人话与原因码。 */
  function classifyHttp(status, body) {
    var rec = isObject(body) ? body : {};
    var code = textOf(rec.code);
    if (code === '') code = status === 404 ? 'not_found' : ('http_' + String(status || 0));
    var unlock = Array.isArray(rec.unlock) ? rec.unlock : [];
    return {
      kind: 'error',
      code: code,
      detail: textOf(rec.message),
      unlock: unlock,
      message: humanizeBackend(code, unlock),
      status: status
    };
  }

  /**
   * 把一次请求异常判成四态。`offline` 由宿主给的**真实信号**决定
   * （`app.js` 的 `/health` 探测结论 + `navigator.onLine`）：
   *   - 离线 ⇒ `offline`（没连上 ≠ 连上了没成）；
   *   - 否则 ⇒ `error`（连上了但这次没成）。
   */
  function classifyFailure(error, offline) {
    if (offline === true) {
      return {
        kind: 'offline',
        code: 'network',
        detail: error && error.message ? String(error.message) : '',
        unlock: [],
        message: '和电脑端没有连通，这次没能取到最新的一份。'
      };
    }
    var detail = error && error.message ? String(error.message) : '网络错误';
    return {
      kind: 'error',
      code: 'network',
      detail: detail,
      unlock: [],
      message: humanizeBackend('network') + ' 你可以：' + backendAction('network') + '。'
    };
  }

  /* ===================== ③ 真实请求 + 渲染 ===================== */

  function clearChildren(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function showNode(node, visible) {
    if (!node) return;
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  function setTextOf(node, text) {
    if (node) node.textContent = textOf(text);
  }

  /** 造一个**真绑了**处理函数的按钮；`id` 只用于驱动与自检（没有就不设）。 */
  function buttonNode(doc, id, className, label) {
    var btn = doc.createElement('button');
    btn.type = 'button';
    if (textOf(id) !== '') btn.id = textOf(id);
    btn.className = textOf(className);
    btn.textContent = textOf(label);
    return btn;
  }

  /**
   * 一行的动作按钮。**每个按钮都绑它自己的处理函数**——去掉绑定，点了就什么都没发生，
   * 这正是反向对照要抓的形态（不是恒真的假按钮）。
   */
  function renderRowActions(ctx, doc, row, index) {
    if (!isObject(row) || !Array.isArray(row.actions) || row.actions.length === 0) return null;
    var viewId = textOf(ctx ? ctx.viewId : '');
    var wrap = doc.createElement('span');
    wrap.className = 'panel-row-actions';
    for (var i = 0; i < row.actions.length; i++) {
      (function (action) {
        if (!isObject(action)) return;
        var actionId = textOf(action.id);
        if (actionId === '') return;
        var id = viewId === '' ? '' : ('panel-' + viewId + '-row-' + String(index) + '-' + actionId);
        var btn = buttonNode(doc, id, 'btn btn-secondary btn-small panel-row-action', action.label);
        btn.setAttribute('data-panel-action', actionId);
        if (textOf(action.entryId) !== '') btn.setAttribute('data-entry-id', textOf(action.entryId));
        btn.addEventListener('click', function () {
          if (typeof action.onClick === 'function') action.onClick();
        });
        wrap.appendChild(btn);
      })(row.actions[i]);
    }
    return wrap.children.length > 0 ? wrap : null;
  }

  function renderRows(ctx, rows) {
    var doc = defaultDoc(ctx);
    var host = ctx ? ctx.body : null;
    if (!host) return 0;
    clearChildren(host);
    if (!doc || !rows || rows.length === 0) return 0;
    var list = doc.createElement('ul');
    list.className = 'kv panel-kv';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var item = doc.createElement('li');
      item.className = 'kv-item';
      var key = doc.createElement('span');
      key.className = 'kv-key';
      key.textContent = textOf(row.label);
      var val = doc.createElement('span');
      val.className = 'kv-val' + (row.mono === true ? ' kv-mono kv-break' : '');
      val.textContent = textOf(row.value);
      item.appendChild(key);
      item.appendChild(val);
      var actions = renderRowActions(ctx, doc, row, i);
      if (actions) item.appendChild(actions);
      list.appendChild(item);
    }
    host.appendChild(list);
    return rows.length;
  }

  /**
   * 面板级动作（导出/下载、重新探测连接这类**不属于某一行**的动作）。
   * 渲染进 `ctx.actions` 这个**独立容器**——不塞进 `ctx.body`，
   * 免得把「行清单」撑出多余条目（空态判据会因此变假）。
   */
  function renderPanelActions(ctx, actions) {
    var doc = defaultDoc(ctx);
    var host = ctx ? ctx.actions : null;
    if (!host || !doc) return 0;
    clearChildren(host);
    if (!Array.isArray(actions) || actions.length === 0) return 0;
    var viewId = textOf(ctx.viewId);
    var count = 0;
    for (var i = 0; i < actions.length; i++) {
      (function (action) {
        if (!isObject(action)) return;
        var actionId = textOf(action.id);
        if (actionId === '') return;
        var id = viewId === '' ? '' : ('panel-' + viewId + '-action-' + actionId);
        var btn = buttonNode(doc, id, 'btn btn-secondary btn-small panel-action', action.label);
        btn.setAttribute('data-panel-action', actionId);
        btn.addEventListener('click', function () {
          if (typeof action.onClick === 'function') action.onClick();
        });
        host.appendChild(btn);
        count += 1;
      })(actions[i]);
    }
    return count;
  }

  /** 让 `spec.panelActions(ctx)` 决定这一轮要摆哪几个面板级按钮。 */
  function applyPanelActions(spec, ctx) {
    if (!spec || typeof spec.panelActions !== 'function') {
      renderPanelActions(ctx, []);
      return 0;
    }
    var actions = null;
    try {
      actions = spec.panelActions(ctx);
    } catch (err) {
      actions = null;
    }
    return renderPanelActions(ctx, actions);
  }


  function setNote(ctx, text) {
    var node = ctx ? ctx.note : null;
    if (node) node.textContent = textOf(text);
  }

  function notify(ctx, kind, payload) {
    if (ctx && typeof ctx.onState === 'function') ctx.onState(kind, payload || {});
  }

  /** 给行挂上 `spec.rowActions` 给出的动作（纯装饰；失败不影响清单）。 */
  function decorateRows(spec, rows, ctx) {
    if (!spec || typeof spec.rowActions !== 'function') return rows;
    for (var i = 0; i < rows.length; i++) {
      var actions = null;
      try {
        actions = spec.rowActions(rows[i], ctx);
      } catch (err) {
        actions = null;
      }
      if (Array.isArray(actions) && actions.length > 0) rows[i].actions = actions;
    }
    return rows;
  }

  /**
   * 跑一次面板刷新：置 `loading` → 真发 `GET` → 按四态分流 → 渲染行。
   * 返回 `{ kind, code, rows, data }`（`data` = 原始响应体，供「写完再读回核对」用）。
   */
  function runRefresh(spec, ctx) {
    var options = ctx || {};
    notify(options, 'loading', {
      message: '正在向电脑端读取「' + textOf(spec.label || spec.view) + '」的内容，请稍候。',
      pending: textOf(spec.pending) || textOf(spec.label || spec.view)
    });
    applyPanelActions(spec, options);

    /* 离线由宿主的真实信号先判：设备自己说没网时**不发请求**。 */
    if (typeof options.offline === 'function' && options.offline() === true) {
      var off = classifyFailure(null, true);
      renderRows(options, []);
      setNote(options, off.message);
      notify(options, 'offline', off);
      return Promise.resolve({ kind: 'offline', code: off.code, rows: [], data: null });
    }

    if (typeof options.request !== 'function') {
      var noReq = {
        kind: 'error', code: 'unavailable',
        message: '页面没有可用的请求通道，本次没有发出请求。'
      };
      renderRows(options, []);
      setNote(options, noReq.message);
      notify(options, 'error', noReq);
      return Promise.resolve({ kind: 'error', code: noReq.code, rows: [], data: null });
    }

    return Promise.resolve(options.request('GET', spec.endpoint)).then(function (res) {
      if (!res || res.ok !== true) {
        var fail = classifyHttp(res ? res.status : 0, res ? res.data : null);
        renderRows(options, []);
        setNote(options, fail.message);
        notify(options, 'error', fail);
        return { kind: 'error', code: fail.code, rows: [], data: res ? res.data : null };
      }
      var summary = null;
      try {
        summary = spec.summarize(res.data);
      } catch (err) {
        summary = null;
      }
      var rows = summary && Array.isArray(summary.rows) ? summary.rows : [];
      if (rows.length === 0) {
        var emptyText = textOf(spec.emptyMessage) || '电脑端这次没有返回可显示的内容。';
        renderRows(options, []);
        setNote(options, emptyText);
        notify(options, 'empty', { message: emptyText });
        return { kind: 'empty', code: '', rows: [], data: res.data };
      }
      decorateRows(spec, rows, options);
      renderRows(options, rows);
      setNote(options, summary && textOf(summary.note) !== '' ? summary.note : '');
      notify(options, 'ready', { rows: rows.length });
      return { kind: 'ready', code: '', rows: rows, data: res.data };
    })['catch'](function (err) {
      var offline = typeof options.offline === 'function' && options.offline() === true;
      var fail = classifyFailure(err, offline);
      renderRows(options, []);
      setNote(options, fail.message);
      notify(options, fail.kind, fail);
      return { kind: fail.kind, code: fail.code, rows: [], data: null };
    });
  }

  /* ===================== ④ 可操作：二次确认 + 真实写请求 ===================== */

  var CONFIRM_LAYER_ID = 'panel-confirm-layer';
  var CONFIRM_TITLE_ID = 'panel-confirm-title';
  var CONFIRM_MESSAGE_ID = 'panel-confirm-message';
  var CONFIRM_OK_ID = 'panel-confirm-ok';
  var CONFIRM_CANCEL_ID = 'panel-confirm-cancel';

  var pendingConfirm = null;   /* { resolve } —— 正等用户裁决的那一次确认 */
  var confirmDoc = null;       /* 建过确认层的文档（关层时要按它去关） */

  /**
   * 确认层**只建一次**，之后复用同一个节点（只改文案、只切显示）。
   * 这样按钮上的处理函数只在建层时绑一次，不会随着反复开合越积越多。
   */
  function buildConfirmLayer(doc) {
    var layer = doc.getElementById(CONFIRM_LAYER_ID);
    if (!layer) return null;
    if (layer.getAttribute && layer.getAttribute('data-built') === '1') return layer;
    layer.className = 'card panel-confirm';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', CONFIRM_TITLE_ID);
    var title = doc.createElement('p');
    title.id = CONFIRM_TITLE_ID;
    title.className = 'card-title';
    var message = doc.createElement('p');
    message.id = CONFIRM_MESSAGE_ID;
    message.className = 'note';
    var row = doc.createElement('div');
    row.className = 'btn-row';
    var cancel = buttonNode(doc, CONFIRM_CANCEL_ID, 'btn btn-secondary btn-small', '取消');
    var ok = buttonNode(doc, CONFIRM_OK_ID, 'btn btn-primary btn-small', '确认');
    cancel.addEventListener('click', function () { settleConfirm(false); });
    ok.addEventListener('click', function () { settleConfirm(true); });
    row.appendChild(cancel);
    row.appendChild(ok);
    layer.appendChild(title);
    layer.appendChild(message);
    layer.appendChild(row);
    layer.setAttribute('data-built', '1');
    layer.setAttribute('hidden', '');
    var host = doc.body || null;
    if (host && typeof host.appendChild === 'function') host.appendChild(layer);
    confirmDoc = doc;
    return layer;
  }

  /** 收起确认层并裁决：**取消就是取消，不发任何请求**。 */
  function settleConfirm(confirmed) {
    var pending = pendingConfirm;
    pendingConfirm = null;
    if (confirmDoc) {
      var layer = confirmDoc.getElementById(CONFIRM_LAYER_ID);
      if (layer) showNode(layer, false);
    }
    if (pending && typeof pending.resolve === 'function') pending.resolve(confirmed === true);
  }

  /**
   * 危险动作的二次确认。返回 `Promise<boolean>`：true = 用户按了「确认」。
   * 宿主可用 `ctx.confirm(opts)` 接管（返回布尔）；默认走本层自带的确认层。
   */
  function askConfirm(ctx, opts) {
    var options = ctx || {};
    var o = opts || {};
    if (typeof options.confirm === 'function') {
      return Promise.resolve(options.confirm(o) === true);
    }
    var doc = defaultDoc(options);
    if (!doc) return Promise.resolve(false);
    var layer = buildConfirmLayer(doc);
    if (!layer) return Promise.resolve(false);
    setTextOf(doc.getElementById(CONFIRM_TITLE_ID), textOf(o.title) || '请确认');
    setTextOf(doc.getElementById(CONFIRM_MESSAGE_ID), textOf(o.message));
    setTextOf(doc.getElementById(CONFIRM_OK_ID), textOf(o.confirmLabel) || '确认');
    setTextOf(doc.getElementById(CONFIRM_CANCEL_ID), textOf(o.cancelLabel) || '取消');
    /* 一次只裁决一件：上一件还没裁决就被新确认顶掉时，把上一件按「取消」结掉，
       绝不让它悬着（悬着 = 用户以为点了、其实什么都没发生）。 */
    if (pendingConfirm && typeof pendingConfirm.resolve === 'function') {
      pendingConfirm.resolve(false);
    }
    showNode(layer, true);
    return new Promise(function (resolve) {
      pendingConfirm = { resolve: resolve };
    });
  }

  /**
   * 真发一次写请求。**没有请求通道时如实说没有**，不假装发过。
   * 返回 `{ outcome, kind, code, message, status, data }`：
   *   `sent`      电脑端接受了（**还不等于生效**，调用方要自己再读回核对）
   *   `failed`    电脑端拒绝 / 网络失败（`message` 是人话）
   *   `no-channel` 页面没有可用的请求通道
   */
  function runWrite(ctx, spec) {
    var options = ctx || {};
    var s = spec || {};
    var method = textOf(s.method) || 'POST';
    var endpoint = textOf(s.endpoint);
    if (endpoint === '') {
      return Promise.resolve({
        outcome: 'failed', kind: 'error', code: 'invalid_request', status: 0,
        message: '这次动作缺少目标接口，没有发出请求。'
      });
    }
    if (typeof options.request !== 'function') {
      return Promise.resolve({
        outcome: 'no-channel', kind: 'error', code: 'unavailable', status: 0,
        message: '页面没有可用的请求通道，本次动作没有发出请求。'
      });
    }
    var body = s.body === undefined ? null : s.body;
    return Promise.resolve(options.request(method, endpoint, body)).then(
      function (res) {
        if (!res || res.ok !== true) {
          var fail = classifyHttp(res ? res.status : 0, res ? res.data : null);
          return {
            outcome: 'failed', kind: 'error', code: fail.code, status: res ? res.status : 0,
            message: fail.message, data: res ? res.data : null
          };
        }
        return {
          outcome: 'sent', kind: 'ready', code: '',
          status: res.status === undefined ? 200 : res.status, message: '', data: res.data
        };
      },
      function (err) {
        var offline = typeof options.offline === 'function' && options.offline() === true;
        var fail = classifyFailure(err, offline);
        return { outcome: 'failed', kind: fail.kind, code: fail.code, status: 0, message: fail.message };
      }
    );
  }

  /** 动作反馈写进 `panel-<view>-status`——**不覆盖**四态条（`view-state-<view>`）。 */
  function setActionStatus(ctx, text) {
    var node = ctx ? ctx.status : null;
    if (node) node.textContent = textOf(text);
  }

  /** 造一个面板。`spec.summarize(body)` 是**纯函数**：响应体 → `{ rows, note }`。 */
  function createPanel(spec) {
    var source = spec || {};
    return {
      view: textOf(source.view),
      label: textOf(source.label),
      endpoint: textOf(source.endpoint),
      emptyMessage: textOf(source.emptyMessage),
      /* 存一份原始 spec：面板要用同一个 spec 再跑一次 `runRefresh` 来做「写完再读回核对」。 */
      spec: source,
      summarize: function (body) { return source.summarize(body); },
      refresh: function (ctx) { return runRefresh(source, ctx); },
      runWrite: function (ctx, writeSpec) { return runWrite(ctx, writeSpec); },
      askConfirm: function (ctx, opts) { return askConfirm(ctx, opts); },
      setActionStatus: function (ctx, text) { setActionStatus(ctx, text); }
    };
  }

  /* ===================== 注册表 ===================== */

  var REGISTRY = [];

  function register(panel) {
    if (!isObject(panel) || textOf(panel.view) === '') return null;
    REGISTRY.push(panel);
    return panel;
  }

  function forView(viewId) {
    var id = textOf(viewId);
    for (var i = 0; i < REGISTRY.length; i++) {
      if (REGISTRY[i].view === id) return REGISTRY[i];
    }
    return null;
  }

  function all() {
    return REGISTRY.slice();
  }

  function views() {
    var out = [];
    for (var i = 0; i < REGISTRY.length; i++) out.push(REGISTRY[i].view);
    return out;
  }

  /* 供自检与测试：一次性把某面板在某「假响应」下的四态走一遍。 */
  function classifyResponse(kind, payload) {
    if (kind === 'offline') return classifyFailure(null, true);
    if (kind === 'loading') return { kind: 'loading', code: '', detail: '', message: '加载中' };
    if (kind === 'empty') return { kind: 'empty', code: '', detail: '', message: '空' };
    return classifyHttp(payload && payload.status, payload && payload.body);
  }

  return {
    BACKEND_ERRORS: BACKEND_ERRORS,
    GENERIC_MESSAGE: GENERIC_MESSAGE,
    GENERIC_ACTION: GENERIC_ACTION,
    backendMessage: backendMessage,
    backendAction: backendAction,
    humanizeBackend: humanizeBackend,
    classifyHttp: classifyHttp,
    classifyFailure: classifyFailure,
    classifyResponse: classifyResponse,
    renderRows: renderRows,
    renderPanelActions: renderPanelActions,
    buttonNode: buttonNode,
    askConfirm: askConfirm,
    settleConfirm: settleConfirm,
    runWrite: runWrite,
    setActionStatus: setActionStatus,
    CONFIRM_LAYER_ID: CONFIRM_LAYER_ID,
    CONFIRM_OK_ID: CONFIRM_OK_ID,
    CONFIRM_CANCEL_ID: CONFIRM_CANCEL_ID,
    createPanel: createPanel,
    runRefresh: runRefresh,
    register: register,
    forView: forView,
    all: all,
    views: views
  };
});
