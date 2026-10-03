/*
 * potbot 完整 App —— 七视图导航与四态的「渲染层」（APP-02 的真实 DOM 落点）
 *
 * 由来（能力目录 APP-02）：
 *   `app-nav.js` 把七视图清单、四态文案、可达性与深链还原**钉成纯逻辑**（不碰 DOM），
 *   但它自己没有画过任何一个节点——页面加载了它也没人用。本文件就是那层「画出来」：
 *   **把 `PotbotAppNav` 的输出变成真实可点的 DOM**，沿用页面既有的 class 命名
 *   （`nav-bar` / `nav-btn` / `is-active` / `view-state`），不另造一套设计语言。
 *
 * 本模块只做四件事，且**只依赖 `PotbotAppNav`，不复制它的清单与文案**：
 *   ① `buildNavModel` / `renderNav`：七个区域各一个真按钮（带 `data-view` 与
 *      `data-deep-link`），当前视图标 `is-active` + `aria-current`，点击切视图；
 *   ② `renderViewState`：把四态（空白/加载/失败/离线）画成**互不相同**的节点
 *      （class 带 `view-state--<tone>`、`data-nav-state`、标题/说明/下一步/动作按钮）；
 *      `ready`（有数据）**隐藏**状态条——有内容时不该顶着一句「这次没成」；
 *   ③ `probeConnection`：**真实的连接探测**——先看 `navigator.onLine`，再真的去 `GET
 *      /health`（带超时）。离线态由这个探测结果驱动，**不是写死的常量**；
 *   ④ `mount`：把导航条、hashchange 深链与 online/offline 事件接起来。
 *
 * ⚠️ 缺 `app-nav.js` 时**不伪造**：`available()` 为 false，`buildNavModel()` 与
 *    `renderNav()` 返回空，导航条上留一个 `data-nav-unavailable` 标记，
 *    由调用方（app.js）退回它自己的导航渲染，绝不当场编七个按钮出来。
 * ⚠️ 浏览器/真机渲染**未验证**：本层只把节点建出来，没有浏览器自动化去点。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md` R256（回到任务）、
 * R258（界面资源与断线状态完整）；能力目录 APP-02。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotNavView = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /** 本层依赖的纯逻辑模块名（挂在全局上，见 `app-nav.js`）。 */
  var REQUIRES = 'PotbotAppNav';
  /** 连接探测的目标；与 app.js 的健康检查同一路径。 */
  var HEALTH_PATH = '/health';
  var DEFAULT_TIMEOUT_MS = 8000;

  /**
   * app.js 的视图状态词汇（blank/loading/failure/offline/ready）→ APP-02 的四态。
   * 两边都保留：`data-state` 仍写 app.js 的词汇（既有用例靠它读回），
   * `data-nav-state` 写 APP-02 的四态。`ready`（有数据）**不在四态里**。
   */
  var KIND_TO_STATE = { blank: 'empty', loading: 'loading', failure: 'error', offline: 'offline' };
  var STATE_TO_KIND = { empty: 'blank', loading: 'loading', error: 'failure', offline: 'offline' };
  var READY_KIND = 'ready';

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function defaultScope() {
    if (typeof globalThis !== 'undefined' && globalThis) return globalThis;
    if (typeof window !== 'undefined' && window) return window;
    return null;
  }

  /** 取全局上的 `PotbotAppNav`（纯逻辑那一份）；没有就是 null，不兜底造一个。 */
  function navModule(scope) {
    var s = scope || defaultScope();
    if (!s) return null;
    var lib = s[REQUIRES];
    return isObject(lib) ? lib : null;
  }

  /** 本层能不能干活：纯逻辑模块在、且关键函数齐备。 */
  function available(scope) {
    var nav = navModule(scope);
    if (!nav) return false;
    return typeof nav.renderState === 'function' &&
      typeof nav.deepLinkOf === 'function' &&
      typeof nav.viewById === 'function' &&
      typeof nav.ids === 'function' &&
      typeof nav.resolveDeepLink === 'function' &&
      typeof nav.viewFromDeepLink === 'function';
  }

  /** app.js 的 kind → APP-02 四态；`ready` 与未知 kind 都返回 null。 */
  function stateForKind(kind) {
    return Object.prototype.hasOwnProperty.call(KIND_TO_STATE, kind) ? KIND_TO_STATE[kind] : null;
  }

  /** APP-02 四态 → app.js 的 kind。 */
  function kindForState(state) {
    return Object.prototype.hasOwnProperty.call(STATE_TO_KIND, state) ? STATE_TO_KIND[state] : null;
  }

  /** 这一层认不认这个状态名（`ready` 也算认——它表示「不画状态条」）。 */
  function handlesKind(kind) {
    return kind === READY_KIND || stateForKind(kind) !== null;
  }

  /* ===================== ① 导航模型与导航条 ===================== */

  /**
   * 七个区域的导航模型（**顺序与文案全部取自 `PotbotAppNav`**）。
   * 缺纯逻辑模块时返回 `[]`——不猜、不编。
   */
  function buildNavModel(currentId, scope) {
    if (!available(scope)) return [];
    var nav = navModule(scope);
    var ids = nav.ids();
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var view = nav.viewById(id);
      out.push({
        id: id,
        index: i,
        label: view ? view.label : id,
        deepLink: nav.deepLinkOf(id),
        active: id === currentId
      });
    }
    return out;
  }

  function clearChildren(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setAttr(node, name, value) {
    if (node && typeof node.setAttribute === 'function') node.setAttribute(name, String(value));
  }

  function showNode(node, visible) {
    if (!node || typeof node.setAttribute !== 'function') return;
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  function currentHashOf(scope, opts) {
    var s = scope || defaultScope();
    var loc = opts.location || (s && s.location) || (typeof location !== 'undefined' ? location : null);
    if (loc && typeof loc.hash === 'string') return loc.hash;
    return '';
  }

  /** 直接改地址（没有 goTo 时的兜底；只写认得出的深链）。 */
  function writeDeepLink(id, scope, opts) {
    var nav = navModule(scope);
    var link = nav && typeof nav.deepLinkOf === 'function' ? nav.deepLinkOf(id) : '';
    if (!link) return false;
    try {
      var s = scope || defaultScope();
      var history = opts.history || (s && s.history);
      if (history && typeof history.replaceState === 'function') {
        history.replaceState(null, '', link);
        return true;
      }
      var loc = opts.location || (s && s.location) || (typeof location !== 'undefined' ? location : null);
      if (loc) { loc.hash = link; return true; }
    } catch (e) { /* 地址写失败不影响视图切换 */ }
    return false;
  }

  function bindNavSelect(button, id, opts) {
    if (!button || typeof button.addEventListener !== 'function') return;
    button.addEventListener('click', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      var handled = false;
      if (typeof opts.goTo === 'function') handled = opts.goTo(id) !== false;
      if (!handled) writeDeepLink(id, opts.scope, opts);
    });
  }

  /**
   * 把七个区域画成导航条上的真按钮，返回**建出来的节点**（调用方拿去缓存引用）。
   * 缺纯逻辑模块时返回 `[]`，并在 host 上留 `data-nav-unavailable` 标记。
   */
  function renderNav(host, currentId, options) {
    if (!host) return [];
    var opts = options || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var model = buildNavModel(currentId, opts.scope);
    if (!doc) return [];
    if (model.length === 0) {
      setAttr(host, 'data-nav-unavailable', 'app-nav-missing');
      return [];
    }
    if (typeof host.removeAttribute === 'function') host.removeAttribute('data-nav-unavailable');
    clearChildren(host);
    var created = [];
    for (var i = 0; i < model.length; i++) {
      var entry = model[i];
      var button = doc.createElement('button');
      button.type = 'button';
      button.id = 'nav-' + entry.id;
      button.className = 'nav-btn' + (entry.active ? ' is-active' : '');
      setAttr(button, 'data-view', entry.id);
      setAttr(button, 'data-deep-link', entry.deepLink);
      if (entry.active) setAttr(button, 'aria-current', 'page');
      else if (typeof button.removeAttribute === 'function') button.removeAttribute('aria-current');
      button.textContent = entry.label;
      bindNavSelect(button, entry.id, opts);
      host.appendChild(button);
      created.push(button);
    }
    return created;
  }

  /* ===================== ② 四态渲染 ===================== */

  function actionLabels(actions) {
    var out = [];
    for (var i = 0; actions && i < actions.length; i++) out.push(textOf(actions[i].label));
    return out;
  }

  /**
   * 四态模型：把 app.js 的 kind 映射到 APP-02 四态，取回 `PotbotAppNav.renderState` 的
   * 文案，并算一份**只含可见部分**的签名（用来证明四态在页面上确实互不相同）。
   *
   * `options.message` 是**调用方带来的真实细节**（例如服务端给的原因）：有它就用它当正文，
   * 不拿通用文案把真原因盖掉；标题 / 下一步 / 动作仍按四态各自渲染。
   *
   * `ready`（有数据）或未知 kind 返回 null —— 这两种情况没有「异常态」要画。
   */
  function buildStateModel(viewId, kind, options, scope) {
    if (!available(scope)) return null;
    var state = stateForKind(kind);
    if (state === null) return null;
    var nav = navModule(scope);
    if (typeof nav.isKnownView === 'function' && !nav.isKnownView(viewId)) return null;
    var opts = options || {};
    var render = nav.renderState(viewId, state, {
      code: opts.code,
      detail: opts.detail,
      pending: opts.pending
    });
    var override = textOf(opts.message);
    var model = {
      view: viewId,
      kind: kind,
      state: state,
      stateLabel: render.stateLabel,
      tone: render.tone,
      where: render.viewLabel,
      title: render.title,
      message: override !== '' ? override : render.message,
      hint: render.hint,
      actions: render.actions.slice(),
      technical: render.technical
    };
    model.visibleSignature = [model.title, model.message, model.hint, actionLabels(model.actions).join('|')].join(' ␟ ');
    return model;
  }

  function textNode(doc, tag, className, text) {
    var node = doc.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function makeActionButton(doc, action) {
    var button = doc.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-small view-state-action';
    button.textContent = action.label;
    setAttr(button, 'data-action-kind', action.kind);
    setAttr(button, 'data-action-id', action.id);
    if (action.target) setAttr(button, 'data-action-target', action.target);
    return button;
  }

  /**
   * 把某一视图的某一态画到 `node` 上（四态 class / 属性 / 文案 / 动作都可区分）。
   * 返回四态模型；`ready` 或未知 kind → 隐藏并返回 null。
   *
   * 动作：`查看原因` 由本层自理（把原因码收在可展开的诊断里，**不把码当正文**），
   * 其余（重试 / 检查连接 / 返回上一页 / 取消 / 空白态 CTA）交给 `options.onAction`。
   * 每次点动作都在节点上留 `data-last-action`，便于离线自检「按钮真的接了事件」。
   */
  function renderViewState(node, viewId, kind, options) {
    if (!node) return null;
    var opts = options || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var model = buildStateModel(viewId, kind, opts, opts.scope);
    if (model === null) {
      clearViewState(node, opts);
      return null;
    }
    node.className = 'view-state view-state-' + model.kind + ' view-state--' + model.tone;
    setAttr(node, 'data-state', model.kind);
    setAttr(node, 'data-nav-state', model.state);
    setAttr(node, 'data-tone', model.tone);
    clearChildren(node);
    if (typeof node.removeAttribute === 'function') node.removeAttribute('data-last-action');

    var reasonNode = null;
    if (doc) {
      node.appendChild(textNode(doc, 'p', 'view-state-title', model.title));
      node.appendChild(textNode(doc, 'p', 'view-state-message', model.message));
      node.appendChild(textNode(doc, 'p', 'view-state-hint', model.hint));

      if (model.technical && textOf(model.technical.code) !== '') {
        reasonNode = textNode(doc, 'p', 'view-state-reason', '原因码：' + model.technical.code +
          (textOf(model.technical.detail) === '' ? '' : '（' + model.technical.detail + '）'));
        showNode(reasonNode, false);
        node.appendChild(reasonNode);
      }

      if (model.actions.length > 0) {
        var bar = doc.createElement('div');
        bar.className = 'view-state-actions';
        for (var i = 0; i < model.actions.length; i++) {
          (function (action) {
            var button = makeActionButton(doc, action);
            button.addEventListener('click', function (ev) {
              if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
              setAttr(node, 'data-last-action', action.kind);
              /* 「查看原因」在本层展开，其余交给调用方；两边都不做就什么都不发生。 */
              if (action.kind === 'view-reason') {
                if (reasonNode) showNode(reasonNode, reasonNode.hasAttribute && reasonNode.hasAttribute('hidden'));
                return;
              }
              if (typeof opts.onAction === 'function') {
                opts.onAction(action, model);
                return;
              }
              if (action.kind === 'open-target' && action.target) writeDeepLink(action.target, opts.scope, opts);
            });
            bar.appendChild(button);
          })(model.actions[i]);
        }
        node.appendChild(bar);
      }
    }
    showNode(node, true);
    return model;
  }

  /** 「有数据」态：状态条收起，但留下 `data-nav-state="ready"` 供离线自检读回。 */
  function clearViewState(node, options) {
    if (!node) return;
    node.className = 'view-state view-state-' + READY_KIND;
    setAttr(node, 'data-state', READY_KIND);
    setAttr(node, 'data-nav-state', READY_KIND);
    if (typeof node.removeAttribute === 'function') {
      node.removeAttribute('data-last-action');
      node.removeAttribute('data-tone');
    }
    clearChildren(node);
    showNode(node, false);
  }

  /* ===================== ③ 真实的连接探测 ===================== */

  /**
   * 探测「电脑端服务是否连得上」。**不是写死**：
   *   1. `navigator.onLine === false`（设备自己说没网）→ 直接判离线，不发请求；
   *   2. 否则真的 `GET /health`（带超时）——只有服务回 2xx 才算在线。
   *
   * 返回 `{ online, source, detail, status }`；`source` 如实标出结论从哪来
   * （`navigator` / `health` / `timeout` / `unavailable`）。
   */
  function probeConnection(options) {
    var opts = options || {};
    var scope = opts.scope || defaultScope();
    var nav = opts.navigator || (scope && scope.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
    var fetchFn = opts.fetch || (scope && scope.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    var setT = opts.setTimeout || (scope && scope.setTimeout) || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    var clearT = opts.clearTimeout || (scope && scope.clearTimeout) || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    var path = textOf(opts.healthPath) || HEALTH_PATH;

    if (nav && nav.onLine === false) {
      return Promise.resolve({ online: false, source: 'navigator', detail: '设备报告当前离线。', status: 0 });
    }
    if (typeof fetchFn !== 'function') {
      return Promise.resolve({ online: false, source: 'unavailable', detail: '页面无法发起连接探测。', status: 0 });
    }
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer !== null && typeof clearT === 'function') clearT(timer);
        resolve(result);
      }
      if (typeof setT === 'function') {
        timer = setT(function () {
          finish({ online: false, source: 'timeout', detail: '探测超时（' + timeoutMs + ' 毫秒）。', status: 0 });
        }, timeoutMs);
      }
      try {
        Promise.resolve(fetchFn(path, { method: 'GET', cache: 'no-store', headers: { 'Accept': 'application/json' } }))
          .then(function (res) {
            var status = res && typeof res.status === 'number' ? res.status : 0;
            var ok = !!(res && res.ok === true);
            finish({
              online: ok,
              source: 'health',
              detail: ok ? '电脑服务已响应。' : '电脑服务返回 ' + status + '，暂时用不了。',
              status: status
            });
          })['catch'](function (err) {
            finish({
              online: false,
              source: 'health',
              detail: '连不上电脑服务（' + (err && err.message ? err.message : '网络错误') + '）。',
              status: 0
            });
          });
      } catch (err) {
        finish({ online: false, source: 'health', detail: '探测请求没有发出去。', status: 0 });
      }
    });
  }

  /* ===================== ④ 挂载：深链 + 连接事件 ===================== */

  /** 深链 → 视图（不猜：认不出就回退），供调用方在初始化时用。 */
  function resolveView(raw, fallback, scope) {
    var nav = navModule(scope);
    if (!nav || typeof nav.resolveDeepLink !== 'function') {
      return { view: textOf(fallback), from: 'fallback', raw: textOf(raw) };
    }
    return nav.resolveDeepLink(raw, fallback, nav.VIEWS);
  }

  /**
   * 把导航条、hashchange 深链、online/offline 事件与连接探测接起来。
   *
   * `options`：`scope` / `document` / `host`（默认取 `#nav-bar`）/ `currentId` /
   * `goTo(id)` / `onAction(action, model)` / `onConnection(probe)` /
   * `fetch` / `navigator` / `setTimeout` / `clearTimeout` / `timeoutMs` /
   * `probe:false`（只接事件不探测）/ `render:false`（不在这里画导航条，交给调用方）。
   *
   * 返回 `{ renderNav, setCurrent, refresh, lastProbe, lastResolve, onHashChange, teardown }`。
   */
  function mount(options) {
    var opts = options || {};
    var scope = opts.scope || defaultScope();
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var teardowns = [];
    var state = {
      current: textOf(opts.currentId),
      probe: null,
      lastAction: '',
      lastResolve: null
    };
    var host = opts.host || (doc && typeof doc.getElementById === 'function' ? doc.getElementById('nav-bar') : null);
    var created = opts.render === false
      ? []
      : renderNav(host, state.current, { document: doc, scope: scope, goTo: opts.goTo });

    function applyProbe(result) {
      state.probe = result;
      if (typeof opts.onConnection === 'function') opts.onConnection(result);
      return result;
    }

    function refresh() {
      return probeConnection({
        scope: scope,
        navigator: opts.navigator,
        fetch: opts.fetch,
        setTimeout: opts.setTimeout,
        clearTimeout: opts.clearTimeout,
        timeoutMs: opts.timeoutMs,
        healthPath: opts.healthPath
      }).then(applyProbe);
    }

    /** hashchange：只认清单里的视图才切——**认不出不猜**，停在原地。 */
    function onHashChange() {
      var nav = navModule(scope);
      if (!nav || typeof nav.viewFromDeepLink !== 'function') return null;
      var hash = currentHashOf(scope, opts);
      var target = nav.viewFromDeepLink(hash, nav.VIEWS);
      state.lastResolve = { raw: hash, view: target };
      if (!target || target === state.current) return null;
      if (typeof opts.goTo === 'function') { opts.goTo(target); state.current = target; }
      return target;
    }

    if (scope && typeof scope.addEventListener === 'function') {
      scope.addEventListener('hashchange', onHashChange);
      teardowns.push(function () {
        if (typeof scope.removeEventListener === 'function') scope.removeEventListener('hashchange', onHashChange);
      });
      var onOnline = function () { applyProbe({ online: true, source: 'event', detail: '设备报告网络已恢复。', status: 0 }); };
      var onOffline = function () { applyProbe({ online: false, source: 'event', detail: '设备报告网络已断开。', status: 0 }); };
      scope.addEventListener('online', onOnline);
      scope.addEventListener('offline', onOffline);
      teardowns.push(function () {
        if (typeof scope.removeEventListener === 'function') {
          scope.removeEventListener('online', onOnline);
          scope.removeEventListener('offline', onOffline);
        }
      });
    }

    if (opts.probe !== false) refresh();

    return {
      /** 重新画导航条（当前视图变了之后调用即可刷新高亮）。 */
      renderNav: function (currentId) {
        if (currentId) state.current = currentId;
        created = renderNav(host, state.current, { document: doc, scope: scope, goTo: opts.goTo });
        return created;
      },
      setCurrent: function (id) { state.current = textOf(id); },
      refresh: refresh,
      lastProbe: function () { return state.probe; },
      lastResolve: function () { return state.lastResolve; },
      onHashChange: onHashChange,
      teardown: function () {
        for (var i = 0; i < teardowns.length; i++) teardowns[i]();
        teardowns.length = 0;
      }
    };
  }

  return {
    REQUIRES: REQUIRES,
    HEALTH_PATH: HEALTH_PATH,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    KIND_TO_STATE: KIND_TO_STATE,
    STATE_TO_KIND: STATE_TO_KIND,
    READY_KIND: READY_KIND,
    navModule: navModule,
    available: available,
    handlesKind: handlesKind,
    stateForKind: stateForKind,
    kindForState: kindForState,
    buildNavModel: buildNavModel,
    renderNav: renderNav,
    buildStateModel: buildStateModel,
    renderViewState: renderViewState,
    clearViewState: clearViewState,
    probeConnection: probeConnection,
    resolveView: resolveView,
    mount: mount
  };
});
