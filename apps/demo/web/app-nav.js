/*
 * potbot 完整 App —— 七视图导航与四态（APP-02，纯逻辑，无 DOM 依赖）
 *
 * 由来（能力目录 APP-02）：
 *   「首页对话、会话列表、任务列表、文件·产物、记忆管理、模板管理、权限与连接设置
 *     形成**完整导航**；空白/加载/失败/离线**四态可用**（不是只有「有数据」一态）。」
 *
 * 这个模块把四件事钉成纯函数（不碰 DOM、不发请求、不读全局）：
 *   ① **视图清单**：七个区域各一条，写明**条目来源**（数据从哪来）与**空态文案**
 *      （没数据时对用户说什么），是页面、状态机与独立验证器的唯一来源；
 *   ② **四态渲染**：`empty / loading / error / offline` 各有**可区分**的输出，
 *      每态都必须带用户可读的标题 + 说明 + 下一步；**错误态必须给可采取的动作**
 *      （重试 / 检查连接 / 查看原因），**不是只甩错误码**；
 *   ③ **导航可达**：从任一视图可达任一其它视图——由**声明式邻接**算出可达性矩阵并自检，
 *      不靠「大概是通的」；
 *   ④ **深链还原**：`#/view-id`（兼容 `/view-id` 主机路径形式）能还原到正确视图；
 *      认不出的深链**不猜**，交给调用方回退。
 *
 * 本文件不碰 DOM、不发请求：浏览器挂 `window.PotbotAppNav`，测试用 `node:vm`
 * 直接加载线上这一份。
 *
 * ⚠️ 四态文案必须互不相同（尤其**离线 ≠ 失败**：一个是「没连上」，一个是「连上了但没成」）。
 *    `verifyStateCoverage` 会把「四态渲染成同一串」判为不完整——测试里有反向对照。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md` R256（回到任务）、
 * R258（界面资源与断线状态完整）、R253（远程与本机工具边界明示）。能力目录 APP-02。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotAppNav = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /* ===================== 通用小工具 ===================== */

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  /* ===================== ① 七个视图：来源与空态文案 ===================== */

  /** 深链前缀，与 `nav.js` 的路由前缀保持一致（`#/view-id`）。 */
  var HASH_PREFIX = '#/';

  /**
   * 七个区域。每条写清三件事，缺一不可：
   *   - `label`   界面上的名字；
   *   - `source`  **条目来源**：这里的每一条数据是从哪来的（写给人看，便于定位）；
   *   - `empty`   **空态文案**：没有数据时告诉用户「为什么空、下一步做什么」。
   * 空态文案**逐视图不同**——七个区域空的原因各不相同，不能共用一句话。
   */
  var VIEWS = [
    {
      id: 'conversation',
      label: '首页对话',
      source: '当前会话的消息流（本机会话存储的活动会话，对应 /api/conversations/<id>）',
      empty: {
        title: '这里还没有对话',
        hint: '在下方输入框写下你的目标，例如「把这份合同改成三段式」，会直接开工。',
        cta: '开始第一句'
      }
    },
    {
      id: 'sessions',
      label: '会话列表',
      source: '本机保存的会话索引（会话存储里的会话目录，含上次更新时间）',
      empty: {
        title: '还没有任何会话',
        hint: '发起第一次对话后，每次会话都会按时间出现在这里，可以随时继续或删除。',
        cta: '去首页说第一句'
      }
    },
    {
      id: 'tasks',
      label: '任务列表',
      source: '任务台账（电脑端 app-index 的任务记录，含每次任务的阶段与产物指针）',
      empty: {
        title: '还没有任务记录',
        hint: '对话里提出目标后，它会拆成任务并逐步执行；每一次任务连同产物都会列在这里。',
        cta: '去首页提出目标'
      }
    },
    {
      id: 'files',
      label: '文件·产物',
      source: '已交付产物索引（产物清单：文件名、字节数、校验值与下载入口）',
      empty: {
        title: '还没有文件或产物',
        hint: '任务交付的文件会汇总到这里，可预览、下载，或另存到你选的位置。',
        cta: '去任务列表看看'
      }
    },
    {
      id: 'memory',
      label: '记忆管理',
      source: '记忆条目库（你让它长期记住的偏好、事实与约定）',
      empty: {
        title: '还没有记住任何东西',
        hint: '告诉它你的偏好和长期约定，或在对话里说「记住这条」；条目出现在这里，并可随时删除。',
        cta: '去首页告诉它'
      }
    },
    {
      id: 'templates',
      label: '模板管理',
      source: '模板目录（内置模板与历史业务模板的清单及适用说明）',
      empty: {
        title: '还没有可用模板',
        hint: '可以从内置模板起步，或把一份现有文档存成模板，以后一键套用同样的结构。',
        cta: '看内置模板'
      }
    },
    {
      id: 'settings',
      label: '权限与连接设置',
      source: '设置模型（授权台账、与电脑端的连接状态、额度与存储）',
      empty: {
        title: '设置项还没加载出来',
        hint: '这里汇总权限申请、电脑端连接、额度与存储；加载完成后会逐项显示当前状态。',
        cta: '重新加载设置'
      }
    }
  ];

  function idsOf(views) {
    var list = views || VIEWS;
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].id);
    return out;
  }

  function viewById(id, views) {
    var list = views || VIEWS;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function isKnownView(id, views) {
    if (typeof id !== 'string' || id === '') return false;
    return viewById(id, views) !== null;
  }

  /** 某视图的条目来源描述（未知视图返回 ''）。 */
  function entrySource(id, views) {
    var view = viewById(id, views);
    return view === null ? '' : view.source;
  }

  /** 某视图的空态文案（未知视图返回 null 的只读副本）。 */
  function emptyCopy(id, views) {
    var view = viewById(id, views);
    if (view === null) return null;
    return { title: view.empty.title, hint: view.empty.hint, cta: view.empty.cta };
  }

  /* ===================== ② 四态渲染 ===================== */

  /** 四态：空白 / 加载中 / 失败 / 离线。加载态是「进行中」，不是「空白」。 */
  var STATES = ['empty', 'loading', 'error', 'offline'];

  var STATE_LABEL = {
    empty: '空白',
    loading: '加载中',
    error: '失败',
    offline: '离线'
  };

  /** 每种状态的整体语气，供界面选色；四态取值互不相同。 */
  var STATE_TONE = {
    empty: 'neutral',
    loading: 'progress',
    error: 'danger',
    offline: 'warning'
  };

  /**
   * 可执行动作清单。**动作是面向用户的动词短语**，不是错误码的回显。
   * `kind` 是给界面绑处理函数用的：重试 / 检查连接 / 查看原因 / 回上一页 / 取消。
   */
  var ACTIONS = {
    retry: { id: 'retry', kind: 'retry', label: '重试' },
    checkConnection: { id: 'check-connection', kind: 'check-connection', label: '检查连接' },
    viewReason: { id: 'view-reason', kind: 'view-reason', label: '查看原因' },
    back: { id: 'back', kind: 'back', label: '返回上一页' },
    cancel: { id: 'cancel', kind: 'cancel', label: '取消这次加载' }
  };

  function action(id) {
    return Object.prototype.hasOwnProperty.call(ACTIONS, id) ? ACTIONS[id] : null;
  }

  /** 失败态**必须**给的动作：重试 / 检查连接 / 查看原因（顺序即推荐顺序）。 */
  var ERROR_ACTIONS = [
    ACTIONS.retry,
    ACTIONS.checkConnection,
    ACTIONS.viewReason,
    ACTIONS.back
  ];

  /** 离线态的动作：先查连接，再在恢复后重试。 **不给「查看原因」**——离线是没连上，没有服务端原因可看。 */
  var OFFLINE_ACTIONS = [
    ACTIONS.checkConnection,
    ACTIONS.retry
  ];

  /**
   * 错误码 → 人话。**已知码给人话，未知码也给通用人话**，绝不把码当正文甩出去。
   * 码本身留在 `technical.code` 里，「查看原因」时才展开。
   */
  var ERROR_MESSAGES = {
    network: '和电脑端的连接断了，这次没能取到内容。',
    timeout: '等待时间超出预期，电脑端没有在时限内回应。',
    model: '模型服务暂时不可用，这一步没能完成。',
    not_found: '这份内容已经不在了，可能已被删除或移动。',
    unreadable: '返回的数据看不懂，无法安全地展示。',
    storage: '本机存储写入失败，改动没有保存下来。',
    unknown: '取内容时遇到了问题，这次没有成功。'
  };

  function humanizeError(code, detail) {
    var key = textOf(code);
    var known = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, key);
    var base = known ? ERROR_MESSAGES[key] : ERROR_MESSAGES.unknown;
    var extra = textOf(detail);
    return extra === '' ? base : base + '（' + extra + '）';
  }

  /** 四态共用的「这一幕在说什么」的定位语，让用户知道是哪个区域在等/出错。 */
  function stateMessage(view, state) {
    var where = view.label;
    if (state === 'empty') {
      return view.empty.title + '：' + view.empty.hint;
    }
    if (state === 'loading') {
      return '正在加载「' + where + '」的内容，请稍候。';
    }
    return '';
  }

  /**
   * 渲染某一视图的某一态。
   *
   * `options`：
   *   - `code`   失败原因码（未知码也安全，映射为通用人话）；
   *   - `detail` 补充说明（可选，会附在人话后面，不覆盖人话）；
   *   - `pending`什么（可选）——加载态说明在等哪一步。
   *
   * 返回结构（**四态字段齐备**）：view / state / stateLabel / tone / title / message
   * / hint / actions / technical / signature。
   * 未知视图或未知状态**抛错**——宁可当场炸，也不静默渲染一个假视图。
   */
  function renderState(viewId, state, options) {
    var view = viewById(viewId);
    if (view === null) {
      throw new Error('未知视图：' + String(viewId));
    }
    if (STATES.indexOf(state) < 0) {
      throw new Error('未知状态：' + String(state));
    }
    var opts = isObject(options) ? options : {};
    var render = {
      view: view.id,
      viewLabel: view.label,
      state: state,
      stateLabel: STATE_LABEL[state],
      tone: STATE_TONE[state],
      title: '',
      message: '',
      hint: '',
      actions: [],
      technical: null
    };

    if (state === 'empty') {
      render.title = view.empty.title;
      render.message = view.empty.hint;
      render.hint = '这个区域现在没有内容，上面这句就是下一步。';
      render.actions = [{ id: 'open-target', kind: 'open-target', label: view.empty.cta, target: view.id }];
    } else if (state === 'loading') {
      render.title = '「' + view.label + '」正在加载';
      render.message = stateMessage(view, 'loading');
      render.hint = textOf(opts.pending) === ''
        ? '内容到齐后会自动出现；加载太久可以取消后重来。'
        : ('正在等：' + textOf(opts.pending) + '。到齐后会自动出现。');
      render.actions = [ACTIONS.cancel];
    } else if (state === 'error') {
      var code = textOf(opts.code) === '' ? 'unknown' : textOf(opts.code);
      render.title = '「' + view.label + '」加载失败';
      render.message = humanizeError(code, opts.detail);
      render.hint = '这是取内容时出的问题，不是你的输入有误。可以先重试；一直失败就检查与电脑端的连接，或看看具体原因。';
      render.actions = ERROR_ACTIONS.slice();
      render.technical = { code: code, detail: textOf(opts.detail) };
    } else {
      /* offline：没连上 ≠ 连上了没成——文案、语气、动作都区别于失败态。 */
      render.title = '现在处于离线状态';
      render.message = '和电脑端没有连通，「' + view.label + '」的内容暂时取不到最新的一份。';
      render.hint = '已经保存过的会话、文件与模板仍可浏览；需要联网的动作会排队，等恢复连接后继续。';
      render.actions = OFFLINE_ACTIONS.slice();
    }

    render.signature = renderSignature(render);
    return render;
  }

  /**
   * 归一化签名：用它判两态是否被渲染成了「同一串」。
   * **只看用户看得见的部分**（标题 / 说明 / 下一步 / 按钮），故意不含 `state` 标识——
   * 否则「标签不同但文案一模一样」的两态会靠标识蒙混过关。
   */
  function renderSignature(render) {
    if (!isObject(render)) return '';
    var labels = [];
    var actions = render.actions;
    for (var i = 0; actions && i < actions.length; i++) {
      labels.push(textOf(actions[i].label));
    }
    return [
      textOf(render.title),
      textOf(render.message),
      textOf(render.hint),
      labels.join('|')
    ].join(' ␟ ');
  }

  /* ===================== ③ 导航可达性 ===================== */

  /**
   * 默认邻接：外壳导航（底部/侧边）在七个区域之间**两两直达**，因此每个视图都
   * 指向其余六个。要改导航结构时改这里，可达性自检会跟着变。
   */
  function navigationEdges(views) {
    var list = views || VIEWS;
    var ids = idsOf(list);
    var edges = {};
    for (var i = 0; i < ids.length; i++) {
      var out = [];
      for (var j = 0; j < ids.length; j++) {
        if (i !== j) out.push(ids[j]);
      }
      edges[ids[i]] = out;
    }
    return edges;
  }

  /** 从某视图出发，界面上实际给出的可点项（用于渲染导航栏）。 */
  function navigationEntries(viewId, views) {
    var list = views || VIEWS;
    var edges = navigationEdges(list);
    var targets = edges[viewId];
    if (!targets) return [];
    var out = [];
    for (var i = 0; i < targets.length; i++) {
      var view = viewById(targets[i], list);
      out.push({ id: view.id, label: view.label, deepLink: deepLinkOf(view.id, list) });
    }
    return out;
  }

  /** BFS：算出从每个视图可达的全部视图（含自身，路径长度 0）。 */
  function reachabilityMatrix(views, edges) {
    var list = views || VIEWS;
    var graph = edges || navigationEdges(list);
    var ids = idsOf(list);
    var matrix = {};
    for (var i = 0; i < ids.length; i++) {
      var start = ids[i];
      var seen = {};
      seen[start] = true;
      var queue = [start];
      while (queue.length > 0) {
        var here = queue.shift();
        var next = graph[here] || [];
        for (var k = 0; k < next.length; k++) {
          var to = next[k];
          if (!isKnownView(to, list) || seen[to]) continue;
          seen[to] = true;
          queue.push(to);
        }
      }
      var reachable = [];
      for (var m = 0; m < ids.length; m++) {
        if (seen[ids[m]]) reachable.push(ids[m]);
      }
      matrix[start] = reachable;
    }
    return matrix;
  }

  /** 找出「从 A 到不了 B」的对（A≠B）；**自检靠它抓漏网的视图**。 */
  function unreachablePairs(views, edges) {
    var list = views || VIEWS;
    var matrix = reachabilityMatrix(list, edges);
    var ids = idsOf(list);
    var issues = [];
    for (var i = 0; i < ids.length; i++) {
      for (var j = 0; j < ids.length; j++) {
        if (i === j) continue;
        var from = ids[i];
        var to = ids[j];
        var reachable = matrix[from] || [];
        if (reachable.indexOf(to) < 0) {
          issues.push({ from: from, to: to, reason: '从「' + from + '」到不了「' + to + '」' });
        }
      }
    }
    return issues;
  }

  function verifyReachability(views, edges) {
    var issues = unreachablePairs(views, edges);
    return { ok: issues.length === 0, issues: issues };
  }

  /* ===================== ④ 深链还原 ===================== */

  /** 视图 id → 深链（未知 id 返回 ''：调用方据此决定不写地址）。 */
  function deepLinkOf(viewId, views) {
    if (!isKnownView(viewId, views)) return '';
    return HASH_PREFIX + viewId;
  }

  /**
   * 深链 → 视图 id。接受：`#/tasks`、`#tasks`、`/tasks`、`tasks`、
   * `tasks?x=1`、`https://host/app/#/tasks`、`#/tasks/`。
   * **只认清单里的 id**；空、格式不对、陌生视图一律返回 null——**不猜**。
   */
  function viewFromDeepLink(raw, views) {
    if (typeof raw !== 'string') return null;
    var value = raw.trim();
    if (value === '') return null;
    /* 去掉协议与主机，只留 fragment / path 部分。 */
    var hashIndex = value.indexOf('#');
    if (hashIndex >= 0) {
      value = value.slice(hashIndex + 1);
    } else {
      var schemeIndex = value.indexOf('://');
      if (schemeIndex >= 0) {
        var afterScheme = value.slice(schemeIndex + 3);
        var slash = afterScheme.indexOf('/');
        value = slash >= 0 ? afterScheme.slice(slash) : '';
      }
    }
    value = value.replace(/^\/+/, '');
    var q = value.indexOf('?');
    if (q >= 0) value = value.slice(0, q);
    q = value.indexOf('&');
    if (q >= 0) value = value.slice(0, q);
    value = value.replace(/\/+$/, '');
    if (value === '') return null;
    return isKnownView(value, views) ? value : null;
  }

  /**
   * 还原入口：深链认得出就用深链，否则回退到 `fallback`（默认第一个视图）。
   * 返回 `{ view, from: 'deep-link' | 'fallback', raw }`，让调用方能如实说明来源。
   */
  function resolveDeepLink(raw, fallback, views) {
    var list = views || VIEWS;
    var fromLink = viewFromDeepLink(raw, list);
    if (fromLink !== null) {
      return { view: fromLink, from: 'deep-link', raw: textOf(raw) };
    }
    var fallbackId = isKnownView(fallback, list) ? fallback : list[0].id;
    return { view: fallbackId, from: 'fallback', raw: textOf(raw) };
  }

  /* ===================== 自检：四态覆盖 ===================== */

  /** 只由码或短标识构成、没有一句人话的正文，判为「只甩了错误码」。 */
  function looksLikeBareCode(text) {
    var value = textOf(text).trim();
    if (value === '') return true;
    if (/^[A-Za-z0-9_\-.]+$/.test(value) && value.length <= 24) return true;
    if (/^\d{3,5}$/.test(value)) return true;
    return false;
  }

  /**
   * 对一份渲染器做四态自检。`renderFn(viewId, state)` 应当返回 `renderState` 的形状。
   * 抓四类不完整：
   *   1. 某一态没渲染出来（缺态，例如「只有有数据一态」的渲染器）；
   *   2. 文案缺失或**只甩了错误码**；
   *   3. **两态被渲染成同一串**（含离线态与失败态同文案——这是明确禁止的）；
   *   4. 失败态/离线态没有给用户可采取的动作。
   */
  function verifyStateCoverage(renderFn, views) {
    var list = views || VIEWS;
    var issues = [];
    if (typeof renderFn !== 'function') {
      return { ok: false, issues: [{ view: '*', state: '*', reason: '没有可用的渲染函数' }] };
    }
    for (var i = 0; i < list.length; i++) {
      var view = list[i];
      var renders = {};
      for (var s = 0; s < STATES.length; s++) {
        var state = STATES[s];
        var render = null;
        try {
          render = renderFn(view.id, state);
        } catch (err) {
          issues.push({ view: view.id, state: state, reason: '渲染抛错：' + (err && err.message ? err.message : String(err)) });
          continue;
        }
        renders[state] = render;
        if (!isObject(render)) {
          issues.push({ view: view.id, state: state, reason: '没有渲染结果（该态缺失）' });
          continue;
        }
        if (textOf(render.title) === '' || textOf(render.message) === '') {
          issues.push({ view: view.id, state: state, reason: '缺少用户可读的标题或说明' });
        } else if (looksLikeBareCode(render.message)) {
          issues.push({ view: view.id, state: state, reason: '正文只有错误码/标识，没有一句人话' });
        }
        if (textOf(render.hint) === '') {
          issues.push({ view: view.id, state: state, reason: '没有给出下一步提示' });
        }
        var actions = render.actions;
        var needsAction = state === 'error' || state === 'offline' || state === 'empty';
        if (needsAction && (!actions || actions.length === 0)) {
          issues.push({ view: view.id, state: state, reason: '没有给用户可采取的动作' });
        }
        if (actions && actions.length > 0) {
          var hasKind = false;
          for (var a = 0; a < actions.length; a++) {
            if (textOf(actions[a].label) !== '' && textOf(actions[a].kind) !== '') hasKind = true;
          }
          if (!hasKind) issues.push({ view: view.id, state: state, reason: '动作缺少可点的文案或类型' });
        }
      }
      /* 两两对比：四态必须互不相同。**重算签名**，不信任渲染结果自带的签名字段——
         否则「标签对得上但内容一样」的两态会蒙混过关。 */
      for (var x = 0; x < STATES.length; x++) {
        for (var y = x + 1; y < STATES.length; y++) {
          var left = renders[STATES[x]];
          var right = renders[STATES[y]];
          if (!isObject(left) || !isObject(right)) continue;
          var leftSig = renderSignature(left);
          var rightSig = renderSignature(right);
          if (leftSig === rightSig) {
            issues.push({
              view: view.id,
              state: STATES[x] + '/' + STATES[y],
              reason: '这两态被渲染成了同一串文案（不可区分）'
            });
          }
        }
      }
    }
    return { ok: issues.length === 0, issues: issues };
  }

  /** 一次性自检：四态覆盖 + 导航可达。 */
  function verify(renderFn, views, edges) {
    var coverage = verifyStateCoverage(renderFn || renderState, views);
    var reach = verifyReachability(views, edges);
    var issues = coverage.issues.concat(reach.issues);
    return { ok: issues.length === 0, coverage: coverage, reachability: reach, issues: issues };
  }

  /* ===================== 导出 ===================== */

  return {
    VIEWS: VIEWS,
    VIEW_IDS: idsOf(VIEWS),
    DEFAULT_VIEW: VIEWS[0].id,
    STATES: STATES,
    STATE_LABEL: STATE_LABEL,
    STATE_TONE: STATE_TONE,
    ACTIONS: ACTIONS,
    HASH_PREFIX: HASH_PREFIX,
    ids: idsOf,
    viewById: viewById,
    isKnownView: isKnownView,
    entrySource: entrySource,
    emptyCopy: emptyCopy,
    renderState: renderState,
    renderSignature: renderSignature,
    humanizeError: humanizeError,
    navigationEdges: navigationEdges,
    navigationEntries: navigationEntries,
    reachabilityMatrix: reachabilityMatrix,
    unreachablePairs: unreachablePairs,
    verifyReachability: verifyReachability,
    deepLinkOf: deepLinkOf,
    viewFromDeepLink: viewFromDeepLink,
    resolveDeepLink: resolveDeepLink,
    verifyStateCoverage: verifyStateCoverage,
    verify: verify
  };
});
