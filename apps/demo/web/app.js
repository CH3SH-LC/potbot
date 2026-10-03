/*
 * potbot 手机 Word Demo —— 页面逻辑
 *
 * 纯 HTML/CSS/JS：无框架、无打包器、无 npm 依赖、无外部网络请求。
 * 页面由同一台电脑上的 potbot 服务同源提供（默认 http://127.0.0.1:8765/）。
 *
 * 本文件下方的「共享合同镜像」段落是对 apps/demo/contracts.ts 的**只读镜像**：
 * 该 TS 文件是接口形状的唯一来源，由主协调者独占维护；页面在浏览器里无法直接
 * import TypeScript，因此这里只镜像路由字面量、状态/阶段枚举与上限数值。
 * 合同变更时，本镜像必须跟着改（由页面负责人执行，不得改 contracts.ts 本身）。
 */
(function () {
  'use strict';

  /* ===================== 共享合同镜像（来源：apps/demo/contracts.ts） ===================== */

  var CONTRACT_VERSION = 'demo-v1';

  var ROUTES = {
    health: '/health',
    documents: '/api/documents',
    task: function (taskId) { return '/api/tasks/' + encodeURIComponent(taskId); },
    download: function (artifactId) {
      return '/api/artifacts/' + encodeURIComponent(artifactId) + '/download';
    },
    observations: function (artifactId) {
      return '/api/artifacts/' + encodeURIComponent(artifactId) + '/observations';
    },
    /* --- 文档会话（编辑链；WCF-D07 的接口，本页只读消费） ----------------- */
    sessions: '/api/sessions',
    session: function (sessionId) { return '/api/sessions/' + encodeURIComponent(sessionId); },
    sessionEdits: function (sessionId) {
      return '/api/sessions/' + encodeURIComponent(sessionId) + '/edits';
    },
    sessionVersion: function (sessionId, editRevision) {
      return '/api/sessions/' + encodeURIComponent(sessionId) + '/versions/' + String(editRevision) + '/download';
    }
  };

  var LIMITS = {
    minParagraphs: 2,
    maxParagraphs: 4,
    maxDraftChars: 2000,
    maxInstructionChars: 4000
  };

  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  /* 阶段文案：TaskStage -> 中文说明（只用于显示「现在在哪一步」） */
  var STAGE_TEXT = {
    accepted: '服务已接收你的要求，等待排队。',
    model_pending: '正在调用模型生成正文。',
    model_done: '模型已返回草稿，正在做内容校验。',
    kernel_pending: '正在提交给 potbot 内核处理。',
    kernel_done: '内核已发布产物，正在写入文件。',
    materialized: '文件已写入，正在回读校验。',
    ready: '文件已就绪。',
    failed: '本次生成失败。',
    interrupted: '任务已中断。'
  };

  var STATUS_TEXT = {
    accepted: '已接收',
    running: '生成中',
    ready: '已完成',
    failed: '失败',
    interrupted: '已中断',
    unknown: '状态未知'
  };

  /* 步骤条：0 已接收 / 1 模型生成 / 2 内核发布 / 3 文件就绪 */
  var STAGE_STEP = {
    accepted: 0,
    model_pending: 1,
    model_done: 1,
    kernel_pending: 2,
    kernel_done: 2,
    materialized: 3,
    ready: 4,
    failed: -1,
    interrupted: -1
  };

  var TERMINAL_STATUS = { ready: true, failed: true, interrupted: true, unknown: true };

  /* ===================== 本机状态（localStorage：刷新后保留） ===================== */

  var STORE_RECORDS = 'potbot.demo.v1.records';
  var STORE_ACTIVE = 'potbot.demo.v1.active';
  var MAX_RECORDS = 12;

  var memoryFallback = { records: null, active: null };

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      if (key === STORE_RECORDS) return memoryFallback.records;
      return memoryFallback.active;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      if (key === STORE_RECORDS) memoryFallback.records = value;
      else memoryFallback.active = value;
    }
  }

  function loadRecords() {
    var raw = storageGet(STORE_RECORDS);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (r) {
        return r && typeof r.requestId === 'string';
      });
    } catch (e) {
      return [];
    }
  }

  function saveRecords() {
    try {
      storageSet(STORE_RECORDS, JSON.stringify(records.slice(0, MAX_RECORDS)));
    } catch (e) { /* 存储不可用时忽略：本机记录丢失，但不影响任务本身 */ }
  }

  function findRecord(requestId) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].requestId === requestId) return records[i];
    }
    return null;
  }

  function upsertRecord(patch) {
    var rec = findRecord(patch.requestId);
    if (!rec) {
      rec = {
        requestId: patch.requestId,
        taskId: patch.taskId || '',
        instruction: patch.instruction || '',
        createdAt: patch.createdAt || Date.now(),
        lastStatus: '',
        lastStage: ''
      };
      records.unshift(rec);
    }
    if (patch.taskId) rec.taskId = patch.taskId;
    if (typeof patch.instruction === 'string' && patch.instruction !== '') {
      rec.instruction = patch.instruction;
    }
    if (patch.createdAt) rec.createdAt = patch.createdAt;
    if (patch.lastStatus) rec.lastStatus = patch.lastStatus;
    if (patch.lastStage) rec.lastStage = patch.lastStage;
    records.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
    saveRecords();
    return rec;
  }

  /* ===================== 运行态 ===================== */

  /* 桥回执跟踪与下载校验模块（见 ./bridge-ops.js、./download-verify.js）。
     两者都是**可选依赖**：缺失时降级为「拒绝发起应用内保存 / 永不声称已核验」，
     绝不回退到没有操作身份的旧行为。 */
  var BridgeOpsLib = (window && typeof window.PotbotBridgeOps === 'object' && window.PotbotBridgeOps !== null)
    ? window.PotbotBridgeOps : null;
  var VerifyLib = (window && typeof window.PotbotDownloadVerify === 'object' && window.PotbotDownloadVerify !== null)
    ? window.PotbotDownloadVerify : null;

  /* 每次应用内桥调用都登记成一条带 operationId/documentId/revision 的操作。
     终结事件（回执/超时/取消）统一驱动状态区重绘，超时不再需要另一条裸 setTimeout。 */
  var bridgeOps = BridgeOpsLib ? BridgeOpsLib.createBridgeOps({ timeoutMs: 90000 }) : null;
  if (bridgeOps) bridgeOps.onSettle(function (op) {
    renderBridgeStatus();
    settleUriOp(op);
  });

  /* 文档预览读取与直接控件意图（见 ./doc-read.js、./edit-intent.js）。
     两者都是**可选依赖**：缺失时编辑区整体降级为"不可用并说明原因"，
     绝不回退成"假装能改"的旧行为。 */
  var DocReadLib = (window && typeof window.PotbotDocRead === 'object' && window.PotbotDocRead !== null)
    ? window.PotbotDocRead : null;
  var EditIntentLib = (window && typeof window.PotbotEditIntent === 'object' && window.PotbotEditIntent !== null)
    ? window.PotbotEditIntent : null;
  /* 节意图（见 ./section-intent.js）与列表能力登记（见 ./list-intent.js）。
     同样是**可选依赖**：缺失时对应的面板整块降级为"不可用并说明原因"，
     绝不回退成"假装能改"。 */
  var SectionIntentLib = (window && typeof window.PotbotSectionIntent === 'object' && window.PotbotSectionIntent !== null)
    ? window.PotbotSectionIntent : null;
  var ListIntentLib = (window && typeof window.PotbotListIntent === 'object' && window.PotbotListIntent !== null)
    ? window.PotbotListIntent : null;

  /* 导航骨架（见 ./nav.js）与连续对话状态机（见 ./conversation-store.js）。
     两者同样是**可选依赖**：缺失时导航退化为「只显示对话视图」、对话退化为
     「未接入并说明原因」，绝不假装能导航、绝不假装消息已送达。 */
  var NavLib = (window && typeof window.PotbotNav === 'object' && window.PotbotNav !== null)
    ? window.PotbotNav : null;
  /* APP-02 的导航渲染层（见 ./nav-view.js）与它依赖的纯逻辑（见 ./app-nav.js）。
     **同样是可选依赖**：缺任何一个时，导航条与状态条退回本文件原有的渲染，
     页面照常可用——绝不假装已经接上了 APP-02 的四态与深链。 */
  var NavViewLib = (window && typeof window.PotbotNavView === 'object' && window.PotbotNavView !== null)
    ? window.PotbotNavView : null;
  var navViewMount = null;
  function navViewReady() {
    return !!(NavViewLib && typeof NavViewLib.available === 'function' && NavViewLib.available(window));
  }
  var ConvLib = (window && typeof window.PotbotConversation === 'object' && window.PotbotConversation !== null)
    ? window.PotbotConversation : null;
  var AssetLib = (window && typeof window.PotbotAssetOps === 'object' && window.PotbotAssetOps !== null)
    ? window.PotbotAssetOps : null;
  var SettingsLib = (window && typeof window.PotbotSettingsModel === 'object' && window.PotbotSettingsModel !== null)
    ? window.PotbotSettingsModel : null;
  /* 四个管理面板（见 ./panel-core.js 与 ./panel-*.js）：把服务端**已挂载**的
     文档 / 检索 / 记忆 / 模板路由接到四个视图上。**可选依赖**：缺失时这四个视图
     维持本文件原有的渲染，绝不假装某个面板已经接上。 */
  var PanelsLib = (window && typeof window.PotbotPanels === 'object' && window.PotbotPanels !== null)
    ? window.PotbotPanels : null;

  /* 编辑会话状态：全部来自服务端回执 / 服务端返回的 DOCX 字节，不在本地编造版本号。 */
  var session = null;        /* { sessionId, documentId, filename, editRevision, contentDigest } */
  var preview = null;        /* PotbotDocRead 解析出的段落 / 表格结构 */
  var selection = null;      /* 从真实 DOM 选区读出的 {text, startPara, startOffset, endPara, endOffset} */
  var selectionExpression = null;
  var staging = EditIntentLib ? EditIntentLib.createStaging() : null;
  var versionEntry = null;   /* 最近一次成功发布的版本行（下载与展示用） */
  var lastVerdict = null;    /* 最近一次提交的分类结果（供调试接缝读取） */

  var records = [];
  var activeRequestId = '';
  var taskState = null;          /* 当前展示的 GET /api/tasks 响应 */
  var postedObservations = {};   /* 本次会话去重，避免重复提交同一条观察 */
  var lastArtifactKey = '';      /* 换文件时清空下载区文案 */
  var lastStepIndex = 0;         /* 失败时用来标出停在哪一步 */
  var stickyNote = '';           /* 本次提交的提示（例如复用了请求编号），轮询刷新时保留 */
  var pollTimer = null;
  var clockTimer = null;
  var healthTimer = null;
  var connected = false;

  /* --- APP-04 / APP-07 状态（FA-K） ------------------------------------- */
  var taskQuery = '';        /* 任务搜索词 */
  var fileQuery = '';        /* 文件搜索词 */
  var uriTracker = AssetLib ? AssetLib.createUriGrantTracker({}) : null;
  var uriByBridgeOp = {};    /* bridgeOps.operationId → URI 台账 operationId */
  var authRegistry = SettingsLib ? SettingsLib.createAuthorizationRegistry({}) : null;
  var lastBridgeOutcome = null;   /* 最近一次应用内交接的终态（供 URI 面板显示真实原因） */
  var settingsErrorCode = '';     /* 设置页演示「错误 → 你能做什么」的当前码 */
  var pageSecretFindings = null;  /* 渲染设置页后对页面文本做一次密钥自检的结果 */
  var lastHealth = null;          /* 最近一次 GET /health 的响应（连接摘要用） */

  /* --- 会话列表的服务端一致性（FA-WEB-CONSUME-LIFECYCLE，加法） ---------
     接上对话后端时，会话清单**以电脑端为准**：列表读自 `GET /api/conversations`，
     改名 / 归档 / 删除分别打 `PATCH /api/conversations/:id`、
     `POST /api/conversations/:id/archive`、`DELETE /api/conversations/:id`，
     且**每次写成功后都重新读回服务端清单再渲染**——不做"本地先改、服务端随后"。
     后端不可用时退回本机存储（`conversation-store.js`），与接线前逐字一致。 */
  var remoteSessions = null;       /* 服务端返回的会话摘要数组；null = 尚未成功读到过 */
  var remoteSessionsReady = false; /* 是否成功从服务端读到过清单（"服务端为准"是否成立） */
  var remoteSessionsError = null;  /* 最近一次读失败的结构化原因（{code,message,retryable}） */
  var sessionQuery = '';           /* 会话搜索词（服务端 `?q=`） */
  var showArchived = false;        /* 是否显示已归档（服务端 `?include_archived=true`） */
  var sessSelectedId = '';         /* 列表里被选中的会话（改名 / 归档 / 删除的目标） */
  var sessionBusy = false;         /* 一次会话写操作进行中：期间不接受第二次 */

  /* ===================== DOM 工具（禁止把模型文本交给 innerHTML） ===================== */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setText(node, text) {
    if (node) node.textContent = (text === undefined || text === null) ? '' : String(text);
  }

  function show(node, visible) {
    if (!node) return;
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  var dom = {};

  function cacheDom() {
    var ids = [
      'conn-pill', 'conn-hint',
      'health-ready', 'health-configured', 'health-verified', 'health-note',
      'instruction', 'char-count', 'clear-btn', 'submit-hint', 'form-error', 'submit-btn',
      'task-section', 'task-empty', 'task-body', 'task-status', 'task-elapsed',
      'task-stage', 'steps', 'task-note',
      'error-panel', 'error-message', 'error-code', 'error-retryable', 'retry-btn',
      'draft-panel', 'draft-title', 'draft-paras', 'draft-meta',
      'artifact-panel', 'artifact-filename', 'artifact-size', 'artifact-sha', 'artifact-version',
      'save-native-btn', 'save-copy-btn', 'save-native-note', 'save-browser-btn', 'save-browser-note',
      'download-status', 'opened-btn',
      'meta-request', 'meta-task', 'meta-contract', 'meta-build', 'meta-boot',
      'history-section', 'history-list', 'forget-btn',
      'editor-section', 'docx-file', 'import-btn', 'editor-error', 'editor-body',
      'session-id', 'session-revision', 'session-digest',
      'preview-meta', 'doc-preview',
      'selection-text', 'selection-expr', 'refresh-selection-btn',
      'format-state', 'format-source',
      'format-toolbar', 'toolbar-note',
      'section-summary', 'section-toolbar', 'section-note',
      'list-toolbar', 'list-note',
      'staged-empty', 'staged-list', 'undo-btn', 'redo-btn', 'clear-staged-btn',
      'save-edit-btn', 'edit-status',
      'version-panel', 'version-list', 'download-version-btn', 'version-download-status',
      /* --- 导航骨架 / 连续对话（FA-A） ------------------------------------- */
      'nav-bar', 'nav-note', 'nav-back', 'nav-forward', 'offline-banner', 'nav-view-note',
      'conv-session-name', 'conv-messages', 'conv-input', 'conv-send', 'conv-note',
      'conv-new-btn', 'conv-resume-btn', 'conv-resume-note',
      'sess-list', 'sess-note', 'sess-new-btn', 'sess-rename-input', 'sess-rename-btn',
      /* --- 会话列表服务端一致性（FA-WEB-CONSUME-LIFECYCLE）：搜索与归档可见性 --- */
      'sess-search', 'sess-search-btn', 'sess-search-note', 'sess-show-archived',
      'task-list', 'file-list', 'files-note', 'settings-summary',
      /* --- APP-04 任务与文件 / APP-07 设置（FA-K） -------------------------- */
      /* --- 表格 / 演示的交付入口（design-06 P8/P9 的网页侧） ----------------- */
      'deliverable-format', 'deliverable-filename', 'deliverable-edit-input', 'deliverable-edit-hint',
      'deliverable-form-error', 'deliverable-submit-btn', 'deliverable-status',
      'deliverable-result', 'deliverable-result-filename', 'deliverable-result-format',
      'deliverable-result-mime', 'deliverable-result-size', 'deliverable-result-sha',
      'deliverable-download-btn', 'deliverable-download-status',
      'deliverable-completion', 'deliverable-completion-completed', 'deliverable-completion-success',
      'deliverable-completion-detail', 'deliverable-pred-work', 'deliverable-pred-runs',
      'deliverable-pred-actions',
      'task-search', 'task-search-note',
      'task-actions-note', 'task-action-bar', 'task-uri-status', 'task-version-list',
      'file-search', 'file-search-note', 'file-action-bar', 'file-uri-note',
      'settings-connection', 'settings-auth-list', 'settings-auth-note',
      'settings-quota', 'settings-quota-note', 'settings-storage', 'settings-storage-note',
      'settings-error-code', 'settings-error-hint', 'settings-secret-note',
      /* --- 四个管理面板（FA-PRODUCT-WEB-UI）的宿主与控件 -------------------- */
      'panel-files', 'panel-files-refresh', 'panel-files-status', 'panel-files-body', 'panel-files-note',
      'panel-memory', 'panel-memory-refresh', 'panel-memory-status', 'panel-memory-body', 'panel-memory-note',
      'panel-templates', 'panel-templates-refresh', 'panel-templates-status', 'panel-templates-body', 'panel-templates-note',
      'panel-settings', 'panel-settings-refresh', 'panel-settings-status', 'panel-settings-body', 'panel-settings-note',
      /* --- 可操作（FA-WEB-PANEL-DEPTH）：面板级动作容器与导出目标输入 -------- */
      'panel-files-actions', 'panel-memory-actions', 'panel-templates-actions', 'panel-settings-actions',
      'panel-files-export-id'
    ];
    /* 七个视图的容器与状态节点由导航模块的清单派生，避免两处手写视图列表而漂移。 */
    if (NavLib && typeof NavLib.ids === 'function') {
      var viewIds = NavLib.ids();
      for (var v = 0; v < viewIds.length; v++) {
        ids.push('view-' + viewIds[v]);
        ids.push('view-state-' + viewIds[v]);
      }
    }
    for (var i = 0; i < ids.length; i++) {
      dom[ids[i]] = $(ids[i]);
    }
  }

  /* ===================== 导航骨架与视图状态（APP-02） ===================== */

  var VIEW_STATE = {
    blank: 'blank', loading: 'loading', failure: 'failure', offline: 'offline', ready: 'ready'
  };

  var router = null;
  var activeViewId = '';
  var offlineNow = false;
  var conversation = ConvLib ? ConvLib.createStore({}) : null;

  function chatTransport() {
    if (typeof window.PotbotChatTransport === 'object' && window.PotbotChatTransport !== null) {
      return window.PotbotChatTransport;
    }
    return null;
  }

  /** 对话后端是否可用：**必须显式声明 available 且有 send**，不做任何乐观假设。 */
  function chatBackendReady() {
    var transport = chatTransport();
    return !!(transport && transport.available === true && typeof transport.send === 'function');
  }

  /**
   * 写某个视图的状态条。四种「异常可见」状态（空白/加载/失败/离线）**显示**，
   * `ready` **隐藏**。这是 APP-02「状态可用」的落点。
   *
   * 接了 nav-view.js 时，这里把四态交给 APP-02 的渲染层（`app-nav.js` 的文案 +
   * `data-nav-state` / tone class / 动作按钮）；传进来的 `text` 当作**真实细节**
   * 交给它，不让通用文案把服务端给的原因盖掉。节点与 `data-state` 仍与原来同一套。
   */
  function setViewState(viewId, kind, text) {
    var node = dom['view-state-' + viewId];
    if (!node) return;
    if (navViewReady() && typeof NavViewLib.renderViewState === 'function' &&
        typeof NavViewLib.handlesKind === 'function' && NavViewLib.handlesKind(kind)) {
      NavViewLib.renderViewState(node, viewId, kind, {
        document: document, scope: window, message: text || '', onAction: onViewStateAction
      });
      return;
    }
    node.className = 'view-state view-state-' + kind;
    setText(node, text || '');
    if (typeof node.setAttribute === 'function') node.setAttribute('data-state', kind);
    show(node, kind !== VIEW_STATE.ready);
  }

  /**
   * 四态节点上的动作按钮（重试 / 检查连接 / 查看原因 / 空白态的「下一步」）。
   * **每个按钮都要有真结果**，不做点了没反应的假按钮；
   * 「查看原因」由 nav-view 自己展开，不会走到这里。
   */
  function onViewStateAction(action, model) {
    var kind = action && action.kind ? action.kind : '';
    if (kind === 'open-target') {
      if (action.target && action.target !== activeViewId) { goView(action.target); return; }
      /* 自指的 CTA（例如「重新加载设置」）：就把当前区域重新拉一次。 */
      if (activeViewId === 'conversation' && dom['conv-input'] && typeof dom['conv-input'].focus === 'function') {
        dom['conv-input'].focus();
      } else {
        renderActiveView();
      }
      return;
    }
    if (kind === 'retry') { renderActiveView(); pollHealth(); return; }
    if (kind === 'check-connection') { probeConnectionNow(); return; }
    if (kind === 'back') { if (router) router.back(); return; }
    if (kind === 'cancel') { renderActiveView(); return; }
  }

  /* ===================== 四个管理面板（FA-PRODUCT-WEB-UI） ===================== */

  /**
   * 四态落点（带原因码）。与 `setViewState` 同一套渲染（`nav-view.js`），
   * 区别只是**多带 `code` / `detail`**：正文仍是人话（面板已把后端码翻成人话），
   * 码收进「查看原因」里——**绝不把 `documents_not_ready` 这类码当正文**。
   */
  function setViewStateDetailed(viewId, kind, payload) {
    var node = dom['view-state-' + viewId];
    if (!node) return;
    var p = payload || {};
    if (navViewReady() && typeof NavViewLib.renderViewState === 'function' &&
        typeof NavViewLib.handlesKind === 'function' && NavViewLib.handlesKind(kind)) {
      NavViewLib.renderViewState(node, viewId, kind, {
        document: document, scope: window,
        message: p.message || '', code: p.code || '', detail: p.detail || '',
        pending: p.pending || '', onAction: onViewStateAction
      });
      return;
    }
    /* 没有 APP-02 渲染层时退回本文件原有的写法（不伪造四态文案）。 */
    node.className = 'view-state view-state-' + kind;
    setText(node, p.message || '');
    if (typeof node.setAttribute === 'function') node.setAttribute('data-state', kind);
    show(node, kind !== VIEW_STATE.ready);
  }

  /** 面板判离线的**真实信号**：既看 `/health` 探测结论，也看设备自己的网络状态。 */
  function panelOffline() {
    if (offlineNow === true) return true;
    try {
      if (window.navigator && window.navigator.onLine === false) return true;
    } catch (e) { /* 受限环境读不到 navigator */ }
    return false;
  }

  /** 当前视图有没有面板模块；没有就返回 null（不假装接上）。 */
  function panelFor(viewId) {
    if (!PanelsLib || typeof PanelsLib.forView !== 'function') return null;
    var panel = PanelsLib.forView(viewId);
    return panel && typeof panel.refresh === 'function' ? panel : null;
  }

  /**
   * 跑一次某视图的面板：**真发请求**由面板内的 `runRefresh` 完成，这里只把
   * 宿主对象（请求函数 / 真实离线信号 / 四态落点 / DOM 容器）交给它。
   * 返回 true 表示这个视图确有面板在场（用于反向对照：去掉面板文件即为 false）。
   *
   * 面板按 APP-02 的四态词汇上报（`empty` / `loading` / `error` / `offline`）；
   * 状态落点仍用本文件的 kind 词汇（`blank` / `failure` …），由 `nav-view.js` 的
   * `kindForState` 做**唯一一处**换算——两边都不各写一份四态。
   */
  /**
   * 「文件·产物」的下载目标：**产品里真实存在的那一个**。
   *   ① 当前任务已经有产物 ⇒ 用它服务端给的下载口（`artifact.downloadPath`）；
   *   ② 否则看用户在面板里填的产物编号 ⇒ 拼 `/api/artifacts/<id>/download`；
   *   ③ 都没有 ⇒ 返回 null，面板**不发请求**，只给人话。
   * 绝不在这里编造一个 URL。
   */
  function panelExportTarget() {
    var artifact = currentArtifact();
    if (artifact && artifact.downloadPath) {
      return { url: String(artifact.downloadPath), filename: String(artifact.filename || '') };
    }
    var input = dom['panel-files-export-id'];
    var typed = (input && typeof input.value === 'string') ? input.value.replace(/^\s+|\s+$/g, '') : '';
    if (typed !== '') {
      return { url: '/api/artifacts/' + encodeURIComponent(typed) + '/download', filename: '' };
    }
    return null;
  }

  function renderPanel(viewId) {
    var panel = panelFor(viewId);
    if (!panel) return false;
    panel.refresh({
      document: document, scope: window,
      request: request,
      /* 二进制下载要走裸 fetch：`request` 会把响应体当 JSON 解，取不到字节。 */
      fetch: (typeof fetch === 'function' ? fetch : null),
      offline: panelOffline,
      onState: function (state, payload) {
        var kind = state;
        if (NavViewLib && typeof NavViewLib.kindForState === 'function') {
          var mapped = NavViewLib.kindForState(state);
          if (mapped !== null) kind = mapped;
        }
        setViewStateDetailed(viewId, kind, payload);
      },
      body: dom['panel-' + viewId + '-body'] || null,
      note: dom['panel-' + viewId + '-note'] || null,
      status: dom['panel-' + viewId + '-status'] || null,
      actions: dom['panel-' + viewId + '-actions'] || null,
      viewId: viewId,
      exportTarget: panelExportTarget
    });
    return true;
  }

  /** 「重新读取」按钮与四态里的「重试」都走这里——**真的会再发一次请求**。 */
  function refreshPanel(viewId) {
    if (!renderPanel(viewId)) return false;
    return true;
  }

  function bindPanelButtons() {
    if (!PanelsLib) return;
    var views = typeof PanelsLib.views === 'function' ? PanelsLib.views() : [];
    for (var i = 0; i < views.length; i++) {
      (function (viewId) {
        var button = dom['panel-' + viewId + '-refresh'];
        if (button && typeof button.addEventListener === 'function') {
          button.addEventListener('click', function () { refreshPanel(viewId); });
        }
      })(views[i]);
    }
  }

  function currentHash() {
    try {
      if (window.location && typeof window.location.hash === 'string') return window.location.hash;
    } catch (e) { /* 沙箱 / 受限环境里可能没有 location */ }
    return '';
  }

  function writeHash(id) {
    var hash = NavLib ? NavLib.hashFor(id) : '';
    if (!hash) return;
    try {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', hash);
      }
    } catch (e) { /* 地址栏改写失败不影响视图切换 */ }
  }

  function renderNav() {
    var host = dom['nav-bar'];
    if (!NavLib || !host) return;
    /* APP-02 的渲染层在场时，导航条由它按 `app-nav.js` 的清单重建（带 data-deep-link）；
       它缺任一个纯逻辑模块时会返回空，这时才退回下面这份自带渲染。 */
    if (navViewReady()) {
      var currentId = router ? router.current() : activeViewId;
      var built = (navViewMount && typeof navViewMount.renderNav === 'function')
        ? navViewMount.renderNav(currentId)
        : (typeof NavViewLib.renderNav === 'function'
          ? NavViewLib.renderNav(host, currentId, { document: document, scope: window, goTo: goView })
          : []);
      if (built && built.length > 0) {
        for (var b = 0; b < built.length; b++) dom[built[b].id] = built[b];
        updateNavHistoryButtons();
        return;
      }
    }
    clearNode(host);
    var views = NavLib.VIEWS;
    for (var i = 0; i < views.length; i++) {
      (function (view) {
        var button = el('button', 'nav-btn');
        button.type = 'button';
        button.id = 'nav-' + view.id;
        button.setAttribute('data-view', view.id);
        setText(button, view.label);
        button.addEventListener('click', function () { goView(view.id); });
        host.appendChild(button);
        dom['nav-' + view.id] = button;
      })(views[i]);
    }
    updateNavHistoryButtons();
  }

  function updateNavHistoryButtons() {
    if (!router) return;
    if (dom['nav-back']) {
      if (router.canBack()) dom['nav-back'].removeAttribute('disabled');
      else dom['nav-back'].setAttribute('disabled', '');
    }
    if (dom['nav-forward']) {
      if (router.canForward()) dom['nav-forward'].removeAttribute('disabled');
      else dom['nav-forward'].setAttribute('disabled', '');
    }
  }

  /** 切到一个视图；未知 id 与重复 id 都不改状态（**不猜、不空转**）。 */
  function goView(id) {
    if (!router || !router.isKnown(id)) return false;
    if (id === router.current()) { renderActiveView(); return true; }
    router.go(id);
    return true;
  }

  function applyView(next, prev) {
    activeViewId = next;
    if (navViewMount && typeof navViewMount.setCurrent === 'function') navViewMount.setCurrent(next);
    var ids = NavLib ? NavLib.ids() : [];
    for (var i = 0; i < ids.length; i++) {
      var node = dom['view-' + ids[i]];
      if (node) show(node, ids[i] === next);
      var button = dom['nav-' + ids[i]];
      if (button) {
        button.className = 'nav-btn' + (ids[i] === next ? ' is-active' : '');
        if (ids[i] === next) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    }
    renderActiveView();
    updateNavHistoryButtons();
  }

  var VIEW_RENDERERS = {
    conversation: function () { renderConversation(); },
    /* 会话清单以电脑端为准：进这个视图就重读一次（没有后端时这一步退回本机渲染）。 */
    sessions: function () { reloadSessions(); },
    tasks: function () { renderTaskList(); renderDeliverablePanel(); },
    files: function () { renderFilesView(); },
    memory: function () {
      setViewState('memory', 'blank',
        '记忆管理（查看 / 修改 / 停用 / 删除 / 忘记）由 C 流的记忆平台提供。本页已预留入口；' +
        '接入后在这里显示**真实条目**。现在这里没有任何条目，也**不代表"已经记住"**。');
    },
    templates: function () {
      setViewState('templates', 'blank',
        '模板管理（安装 / 启用 / 停用 / 卸载 / 能力发现）由 C 流的模板平台提供。本页已预留入口；' +
        '接入后在这里显示真实模板清单与五态能力（已安装 / 启用 / 授权 / 依赖就绪 / 实测支持）。');
    },
    settings: function () { renderSettingsView(); }
  };

  function renderActiveView() {
    if (!activeViewId) return;
    var render = VIEW_RENDERERS[activeViewId];
    if (render) render();
    /* 四个管理面板：基础渲染之后再让面板**真发一次请求**（没有面板的视图这一步是空转）。 */
    renderPanel(activeViewId);
  }

  function setOffline(value) {
    var next = value === true;
    var changed = next !== offlineNow;
    offlineNow = next;
    show(dom['offline-banner'], offlineNow);
    if (activeViewId === 'conversation') renderConversation();
    updateSendability();
    /* 离线状态**变化**时，当前视图的管理面板要跟着换四态（离线 ≠ 失败）。 */
    if (changed && activeViewId && activeViewId !== 'conversation') renderPanel(activeViewId);
  }

  function updateSendability() {
    var button = dom['conv-send'];
    if (!button) return;
    if (offlineNow) button.setAttribute('disabled', '');
    else button.removeAttribute('disabled');
  }

  /* --- APP-02：离线态由**真实的连接探测**驱动（见 ./nav-view.js 的 probeConnection） --- */

  /** 把探测结论如实写进页面：结论是什么、从哪来，一并说明。 */
  function reportProbe(probe) {
    var note = dom['nav-view-note'];
    if (!note) return;
    if (!probe) { setText(note, ''); return; }
    var source = probe.source === 'health' ? '电脑服务 /health'
      : probe.source === 'navigator' ? '设备网络状态'
        : probe.source === 'event' ? '网络状态变化事件'
          : probe.source === 'timeout' ? '探测超时'
            : String(probe.source || '未知来源');
    setText(note, '连接状态：' + (probe.online ? '在线' : '离线') +
      '（来自 ' + source + '）。' + (probe.detail || ''));
  }

  /**
   * 用探测结果更新离线态。**结论没变就不重复渲染**（避免每轮轮询都重画对话区），
   * 但每次都会刷新那行来源说明。
   */
  function applyProbe(probe) {
    var next = !!(probe && probe.online === false);
    if (next !== offlineNow) setOffline(next);
    reportProbe(probe);
  }

  /** 「检查连接」按钮：立刻重探一次，不等下一轮轮询。 */
  function probeConnectionNow() {
    if (navViewMount && typeof navViewMount.refresh === 'function') {
      navViewMount.refresh();
      return;
    }
    pollHealth();
  }

  function serviceOrigin() {
    try {
      if (window.location && window.location.origin) return String(window.location.origin);
    } catch (e) { /* 忽略 */ }
    return '未知（页面无法读取地址）';
  }

  /* ===================== 通用工具 ===================== */

  function newId(prefix) {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return prefix ? prefix + '-' + crypto.randomUUID() : crypto.randomUUID();
    }
    return (prefix ? prefix + '-' : '') + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10);
  }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '未知';
    if (n < 1024) return n + ' 字节';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB（' + n + ' 字节）';
    return (n / 1024 / 1024).toFixed(2) + ' MB（' + n + ' 字节）';
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      return '';
    }
  }

  function formatDuration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  /* 与 S3 的 normalizeInstruction 保持一致：CRLF/CR 归一为 LF 后 trim。
     这样客户端的「相同要求」判定与服务端的摘要判定不会因换行符差异而不一致。 */
  function trimText(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\r\n?/g, '\n').trim();
  }

  /* ===================== 连接与健康状态 ===================== */

  function setConnection(state, hint) {
    var pill = dom['conn-pill'];
    if (!pill) return;
    pill.className = 'pill pill-' + state;
    setText(pill, state === 'ok' ? '已连接电脑服务' : (state === 'warn' ? '服务未就绪' : '未连接'));
    setText(dom['conn-hint'], hint || '');
  }

  function setHealthFlag(node, ok, okText, badText) {
    if (!node) return;
    node.className = 'kv-val ' + (ok ? 'kv-ok' : 'kv-err');
    setText(node, ok ? okText : badText);
  }

  function applyHealth(health) {
    lastHealth = health || null;
    var ready = health && health.ready === true;
    var configured = health && health.modelConfigured === true;
    var verified = health && health.modelVerified === true;

    setHealthFlag(dom['health-ready'], ready, '就绪', '未就绪');
    setHealthFlag(dom['health-configured'], configured, '已配置', '未配置');
    setHealthFlag(dom['health-verified'], verified, '已实调通过', '尚未实调通过');

    if (dom['meta-build']) setText(dom['meta-build'], health && health.buildId ? health.buildId : '未知');
    if (dom['meta-boot']) setText(dom['meta-boot'], health && health.bootId ? health.bootId : '未知');

    if (ready && verified) {
      setConnection('ok', '电脑服务可用，模型已实调通过。');
    } else if (ready) {
      setConnection('warn', '电脑服务可用，但模型尚未实调通过；生成可能失败。');
    } else {
      setConnection('warn', '电脑服务已响应，但报告未就绪。');
    }
    if (activeViewId === 'settings') renderSettingsView();
  }

  function healthFailure() {
    connected = false;
    lastHealth = null;
    setConnection('err', '连不上电脑服务。请确认电脑上的 potbot 服务正在运行，且手机与电脑连通。');
    setHealthFlag(dom['health-ready'], false, '', '未知（连不上）');
    setHealthFlag(dom['health-configured'], false, '', '未知（连不上）');
    setHealthFlag(dom['health-verified'], false, '', '未知（连不上）');
    dom['health-ready'].className = 'kv-val kv-unknown';
    dom['health-configured'].className = 'kv-val kv-unknown';
    dom['health-verified'].className = 'kv-val kv-unknown';
    setText(dom['health-ready'], '未知');
    setText(dom['health-configured'], '未知');
    setText(dom['health-verified'], '未知');
    if (activeViewId === 'settings') renderSettingsView();
  }

  function pollHealth() {
    request('GET', ROUTES.health, null, 8000).then(function (res) {
      if (!res.ok || !res.data || typeof res.data !== 'object') {
        connected = false;
        setConnection('err', '电脑服务返回了无法识别的内容。');
        return;
      }
      connected = true;
      applyHealth(res.data);
    })['catch'](function () {
      healthFailure();
    });
  }

  /* ===================== HTTP 封装 ===================== */

  /* 统一返回 { ok, status, data, raw }；网络失败时 reject。 */
  function request(method, path, body, timeoutMs) {
    var controller = null;
    var timer = null;
    var opts = {
      method: method,
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    };
    if (body !== null && body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || 20000);
    }

    return fetch(path, opts).then(function (resp) {
      if (timer) clearTimeout(timer);
      return resp.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { data = null; }
        }
        return { ok: resp.ok, status: resp.status, data: data, raw: text };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /* 从服务端错误响应里取中文说明；取不到时给中性文案，不编造原因。 */
  function describeHttpError(res) {
    if (res && res.data && typeof res.data === 'object') {
      var d = res.data;
      if (d.error && typeof d.error === 'object' && d.error.message) {
        return { code: d.error.code || ('http_' + res.status), message: String(d.error.message), retryable: d.error.retryable === true };
      }
      if (typeof d.message === 'string' && d.message) {
        return { code: d.code ? String(d.code) : ('http_' + res.status), message: d.message, retryable: d.retryable === true };
      }
    }
    return {
      code: 'http_' + (res ? res.status : 'unknown'),
      message: '电脑服务拒绝了这次请求（HTTP ' + (res ? res.status : '?') + '）。',
      retryable: true
    };
  }

  /* ===================== 提交 ===================== */

  function setFormError(msg) {
    if (!dom['form-error']) return;
    if (msg) {
      setText(dom['form-error'], msg);
      show(dom['form-error'], true);
    } else {
      setText(dom['form-error'], '');
      show(dom['form-error'], false);
    }
  }

  /* 复用判定：同样要求 + 已有「未失败」的任务 => 复用同一 requestId（服务端据此去重，不重复扣模型预算）。 */
  function findReusable(instruction) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (trimText(r.instruction) !== instruction) continue;
      if (r.lastStatus === 'failed' || r.lastStatus === 'interrupted' || r.lastStatus === 'unknown') continue;
      return r;
    }
    return null;
  }

  function updateCharCount() {
    var len = dom['instruction'].value.length;
    setText(dom['char-count'], len + ' / ' + LIMITS.maxInstructionChars);
    if (dom['char-count']) {
      dom['char-count'].className = len > LIMITS.maxInstructionChars ? 'char-count over' : 'char-count';
    }
  }

  function submitInstruction(forceNewId) {
    var instruction = trimText(dom['instruction'].value);
    setFormError('');

    if (!instruction) {
      setFormError('请先写下你的写作要求。');
      return;
    }
    if (instruction.length > LIMITS.maxInstructionChars) {
      setFormError('要求太长了：最多 ' + LIMITS.maxInstructionChars + ' 个字，当前 ' + instruction.length + ' 个字。');
      return;
    }

    var reusable = (!forceNewId) ? findReusable(instruction) : null;
    var requestId = reusable ? reusable.requestId : newId('req');
    var noteText = reusable
      ? '这条要求在本机已有任务，已复用同一请求编号：电脑端会直接返回既有任务，不会重复调用模型。'
      : '已生成新的请求编号。相同要求再次提交会复用该编号，不会重复调用模型。';

    var rec = upsertRecord({
      requestId: requestId,
      taskId: reusable ? reusable.taskId : '',
      instruction: instruction,
      createdAt: reusedCreatedAt(reusable)
    });
    stickyNote = noteText;
    taskState = null;
    clearTaskPanels();
    setActive(rec.requestId);
    showTaskShell();
    setText(dom['task-note'], noteText);
    setText(dom['task-stage'], '正在提交到电脑服务…');
    setText(dom['task-status'], '提交中');
    dom['task-status'].className = 'status-chip status-running';
    setBusy(true);

    request('POST', ROUTES.documents, { requestId: requestId, instruction: instruction }, 30000)
      .then(function (res) {
        if (res.ok && res.data && res.data.taskId) {
          var taskId = String(res.data.taskId);
          var patch = { requestId: rec.requestId, taskId: taskId, lastStatus: String(res.data.status || 'accepted') };
          upsertRecord(patch);
          ensurePolling();
          return null;
        }

        if (res.status === 409) {
          /* 同一请求编号被用于不同内容：换新编号重投一次，只重投一次。 */
          if (!forceNewId) {
            var fresh = newId('req');
            records = records.filter(function (r) { return r.requestId !== rec.requestId; });
            saveRecords();
            var oldText = dom['instruction'].value;
            dom['instruction'].value = oldText;
            setText(dom['task-note'], '该请求编号此前已用于不同内容，已自动更换请求编号后重新提交。');
            submitInstructionWithId(fresh, instruction);
            return null;
          }
          throw { demoError: { code: 'request_conflict', message: '这个请求编号已被用于不同内容，请稍后重试。', retryable: true } };
        }

        throw { demoError: describeHttpError(res) };
      })
      ['catch'](function (err) {
        setBusy(false);
        var msg = err && err.demoError ? err.demoError.message
          : (err && err.name === 'AbortError'
            ? '提交超时：电脑服务没有及时响应。'
            : '提交失败：连不上电脑服务，请确认电脑上的服务仍在运行。');
        setFormError(msg);
        setText(dom['task-status'], '提交失败');
        dom['task-status'].className = 'status-chip status-failed';
        setText(dom['task-stage'], msg);
        showTaskShell();
      });
  }

  function reusedCreatedAt(reusable) {
    return reusable ? reusable.createdAt : Date.now();
  }

  /* 用指定 requestId 提交（用于 409 后换号重投）。 */
  function submitInstructionWithId(requestId, instruction) {
    var rec = upsertRecord({
      requestId: requestId,
      instruction: instruction,
      createdAt: Date.now()
    });
    setActive(rec.requestId);
    request('POST', ROUTES.documents, { requestId: requestId, instruction: instruction }, 30000)
      .then(function (res) {
        if (res.ok && res.data && res.data.taskId) {
          upsertRecord({ requestId: requestId, taskId: String(res.data.taskId), lastStatus: String(res.data.status || 'accepted') });
          ensurePolling();
          return;
        }
        throw { demoError: describeHttpError(res) };
      })
      ['catch'](function (err) {
        setBusy(false);
        var msg = err && err.demoError ? err.demoError.message : '提交失败：连不上电脑服务。';
        setFormError(msg);
        setText(dom['task-stage'], msg);
      });
  }

  function setBusy(busy) {
    if (!dom['submit-btn']) return;
    if (busy) dom['submit-btn'].setAttribute('disabled', '');
    else dom['submit-btn'].removeAttribute('disabled');
  }

  function showTaskShell() {
    show(dom['task-empty'], false);
    show(dom['task-body'], true);
  }

  /* ===================== 任务轮询与渲染 ===================== */

  function ensurePolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      tick();
    }, 1500);
    tick();
  }

  function stopPollingIfIdle() {
    var live = records.some(function (r) {
      return r.lastStatus !== 'ready' && r.lastStatus !== 'failed' &&
        r.lastStatus !== 'interrupted' && r.lastStatus !== 'unknown';
    });
    if (!live && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function tick() {
    var targets = records.filter(function (r) {
      return r.taskId && r.lastStatus !== 'ready' && r.lastStatus !== 'failed' &&
        r.lastStatus !== 'interrupted' && r.lastStatus !== 'unknown';
    });
    var active = activeRequestId ? findRecord(activeRequestId) : null;
    if (active && active.taskId && targets.indexOf(active) === -1) targets.push(active);

    if (targets.length === 0) {
      stopPollingIfIdle();
      return;
    }
    for (var i = 0; i < targets.length; i++) {
      fetchTask(targets[i]);
    }
  }

  function fetchTask(rec) {
    if (!rec || !rec.taskId) return;
    request('GET', ROUTES.task(rec.taskId), null, 12000)
      .then(function (res) {
        if (!res.ok || !res.data || typeof res.data !== 'object') {
          if (!connected) healthFailure();
          return;
        }
        connected = true;
        upsertRecord({
          requestId: rec.requestId,
          lastStatus: String(res.data.status || ''),
          lastStage: String(res.data.stage || '')
        });
        if (rec.requestId === activeRequestId) {
          taskState = res.data;
          renderTask(res.data);
        }
        renderHistory();
        stopPollingIfIdle();
      })
      ['catch'](function () {
        healthFailure();
      });
  }

  function setStatusChip(status) {
    var chip = dom['task-status'];
    if (!chip) return;
    var cls = TERMINAL_STATUS[status] ? status : (status === 'accepted' || status === 'running' ? 'running' : 'unknown');
    chip.className = 'status-chip status-' + cls;
    setText(chip, STATUS_TEXT[status] || '状态未知');
  }

  function renderSteps(stage) {
    var steps = dom['steps'];
    if (!steps) return;
    var current = STAGE_STEP[stage];
    var stopped = (stage === 'failed' || stage === 'interrupted');
    if (typeof current === 'number' && current >= 0) lastStepIndex = current;
    var shown = stopped ? lastStepIndex : current;

    var items = steps.querySelectorAll('.step');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var idx = Number(item.getAttribute('data-step'));
      var cls = 'step';
      if (stopped) {
        if (idx < shown) cls += ' done';
        else if (idx === shown) cls += ' stopped';
      } else if (typeof shown === 'number' && shown >= 0) {
        if (idx < shown) cls += ' done';
        else if (idx === shown) cls += ' active';
      }
      item.className = cls;
    }
  }

  function renderDraft(draft) {
    if (!draft || !dom['draft-panel']) {
      show(dom['draft-panel'], false);
      return;
    }
    var paras = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
    if (!draft.title && paras.length === 0) {
      show(dom['draft-panel'], false);
      return;
    }

    setText(dom['draft-title'], draft.title || '（无标题）');

    var list = dom['draft-paras'];
    clearNode(list);
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i] || {};
      /* 纯文本渲染：模型文本只经 textContent 进入 DOM，绝不用 innerHTML。 */
      list.appendChild(el('li', 'para', p.text === undefined || p.text === null ? '' : String(p.text)));
    }
    if (paras.length === 0) {
      list.appendChild(el('li', 'para', '（没有正文段落）'));
    }

    var total = 0;
    for (var j = 0; j < paras.length; j++) {
      total += String((paras[j] || {}).text || '').length;
    }
    setText(dom['draft-meta'],
      '草稿为模型生成（未经你确认为事实），共 ' + paras.length + ' 段、' + total + ' 字。' +
      '正文按纯文本展示，页面不会执行其中的任何标记或代码。');
    show(dom['draft-panel'], true);
  }

  function renderError(error) {
    if (!error || !dom['error-panel']) {
      show(dom['error-panel'], false);
      return;
    }
    setText(dom['error-message'], error.message || '本次生成失败。');
    setText(dom['error-code'], error.code ? ('错误代码：' + error.code) : '');
    setText(dom['error-retryable'],
      error.retryable === true
        ? '这次失败可以重试（会以新的请求编号重新生成，可能再次消耗模型调用额度）。'
        : '这次失败被判定为不可重试，请先按上面的说明修改要求或电脑端配置。');
    show(dom['retry-btn'], error.retryable === true);
    show(dom['error-panel'], true);
  }

  function renderArtifact(artifact) {
    if (!artifact || !artifact.artifactId || !dom['artifact-panel']) {
      show(dom['artifact-panel'], false);
      lastArtifactKey = '';
      return;
    }

    var key = artifact.artifactId + '|' + artifact.artifactVersion + '|' + artifact.taskRevision;
    var changed = key !== lastArtifactKey;
    lastArtifactKey = key;

    setText(dom['artifact-filename'], artifact.filename || '未知');
    setText(dom['artifact-size'], formatBytes(artifact.byteLength));
    setText(dom['artifact-sha'], artifact.sha256 || '未知');
    setText(dom['artifact-version'], '第 ' + (artifact.artifactVersion === undefined ? '?' : artifact.artifactVersion) +
      ' 版（任务第 ' + (artifact.taskRevision === undefined ? '?' : artifact.taskRevision) + ' 次修订）');

    /* 桥由 S1 的安卓壳注入；两个方法各自独立判断，不假设一定同时存在。 */
    var api = (typeof window.PotbotNative === 'object' && window.PotbotNative !== null)
      ? window.PotbotNative : null;
    var hasSaveDocx = !!api && typeof api.saveDocx === 'function';
    var hasSaveCopy = !!api && typeof api.saveCopy === 'function';

    show(dom['save-native-btn'], hasSaveDocx);
    show(dom['save-copy-btn'], hasSaveCopy);
    show(dom['save-native-note'], hasSaveDocx || hasSaveCopy);
    if (!hasSaveDocx && !hasSaveCopy) {
      setText(dom['save-browser-note'],
        '当前在普通手机浏览器里打开：文件由本页下载。应用内的保存与打开能力在本页不可用，' +
        '浏览器路径的安装与保存能力尚未验证。');
    } else {
      setText(dom['save-browser-note'], '浏览器下载路径作为备用（不经过应用内的保存能力）。');
    }

    if (changed) {
      setText(dom['download-status'], '');
      dom['download-status'].className = 'download-status';
      dom['download-status'].dataset.artifactId = artifact.artifactId;
    }
    show(dom['artifact-panel'], true);
  }

  function renderTask(state) {
    if (!state || typeof state !== 'object') return;

    showTaskShell();
    var status = String(state.status || 'unknown');
    var stage = String(state.stage || '');
    setStatusChip(status);

    var stageText = STAGE_TEXT[stage] || '正在处理…';
    if (status === 'failed' && stage !== 'failed') stageText = '本次生成失败。';
    if (status === 'interrupted') stageText = '任务已中断：电脑服务可能重启过。未完成的生成不会被自动重放。';
    if (status === 'unknown') stageText = '电脑服务不认识这个任务编号（可能是服务重启后丢失了在途记录）。';
    setText(dom['task-stage'], stageText);

    renderSteps(stage);

    if (status === 'failed') renderError(state.error || null);
    else show(dom['error-panel'], false);

    renderDraft(state.draft || null);
    renderArtifact(state.artifact || null);

    setText(dom['meta-request'], state.requestId || '');
    setText(dom['meta-task'], state.taskId || '');

    if (status === 'accepted' || status === 'running') {
      setText(dom['task-note'], stickyNote ||
        '正在等待电脑生成。可以刷新页面或离开再回来，本机保留了请求编号。');
      setBusy(true);
    } else if (stickyNote) {
      setText(dom['task-note'], stickyNote);
      setBusy(false);
    } else {
      setText(dom['task-note'], '');
      setBusy(false);
    }

    if (status === 'interrupted' && !state.error) {
      setText(dom['task-note'], '该任务在电脑服务重启后无法继续，不会自动重放模型调用；如需文件请重新提交要求。');
    }
  }

  function renderElapsed() {
    var rec = activeRequestId ? findRecord(activeRequestId) : null;
    if (!rec || !dom['task-elapsed']) return;
    var status = (taskState && taskState.status) || rec.lastStatus || '';
    if (status === '' || status === 'accepted' || status === 'running') {
      setText(dom['task-elapsed'], '已等待 ' + formatDuration(Date.now() - (rec.createdAt || Date.now())));
    } else {
      setText(dom['task-elapsed'], '提交于 ' + formatTime(rec.createdAt || Date.now()));
    }
  }

  function renderHistory() {
    var list = dom['history-list'];
    if (!list) return;
    if (records.length === 0) {
      show(dom['history-section'], false);
      return;
    }
    clearNode(list);
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var item = el('button', 'history-item' + (rec.requestId === activeRequestId ? ' is-active' : ''));
      item.type = 'button';
      item.setAttribute('data-request-id', rec.requestId);

      var text = el('p', 'history-text', rec.instruction || '（无要求文本）');
      var meta = el('p', 'history-meta',
        (STATUS_TEXT[rec.lastStatus] || '未取到状态') + ' · ' + formatTime(rec.createdAt || Date.now()) +
        ' · 请求编号 ' + rec.requestId);
      item.appendChild(text);
      item.appendChild(meta);
      list.appendChild(item);
    }
    show(dom['history-section'], true);
  }

  function setActive(requestId) {
    activeRequestId = requestId || '';
    storageSet(STORE_ACTIVE, activeRequestId);
    var rec = activeRequestId ? findRecord(activeRequestId) : null;
    if (rec) {
      if (dom['instruction'] && trimText(dom['instruction'].value) === '') {
        dom['instruction'].value = rec.instruction || '';
        updateCharCount();
      }
      setText(dom['meta-request'], rec.requestId);
      setText(dom['meta-task'], rec.taskId || '');
      if (!rec.taskId) {
        showTaskShell();
        setText(dom['task-stage'], '本机保留了这条请求的编号，但还没有从电脑服务取回任务编号。');
      }
    } else {
      show(dom['task-empty'], true);
      show(dom['task-body'], false);
    }
    renderHistory();
  }

  /* 切换任务前清掉上一个任务的草稿/文件/错误面板，避免把上一个任务的东西显示成本次结果。 */
  function clearTaskPanels() {
    show(dom['draft-panel'], false);
    show(dom['artifact-panel'], false);
    show(dom['error-panel'], false);
    setText(dom['draft-title'], '');
    if (dom['draft-paras']) clearNode(dom['draft-paras']);
    lastArtifactKey = '';
    setDownloadStatus('', '');
  }

  function openRecord(requestId) {
    var rec = findRecord(requestId);
    if (!rec) return;
    taskState = null;
    stickyNote = '';
    clearTaskPanels();
    setActive(requestId);
    if (rec.taskId) {
      ensurePolling();
      fetchTask(rec);
    } else {
      showTaskShell();
      setText(dom['task-stage'], '这条请求已在本机保留，但在电脑上没有拿到任务编号；可重新提交同样的要求。');
    }
    if (dom['instruction']) {
      dom['instruction'].value = rec.instruction || '';
      updateCharCount();
    }
  }

  /* ===================== 取回文件 ===================== */

  function digestSha256(bytes) {
    var subtle = (typeof crypto !== 'undefined' && crypto) ? crypto.subtle : undefined;
    if (!subtle || typeof subtle.digest !== 'function') return Promise.resolve(null);
    return subtle.digest('SHA-256', bytes).then(function (buf) {
      var view = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < view.length; i++) {
        hex += ('0' + view[i].toString(16)).slice(-2);
      }
      return hex;
    }, function () { return null; });
  }

  function setDownloadStatus(text, kind) {
    if (!dom['download-status']) return;
    setText(dom['download-status'], text);
    dom['download-status'].className = 'download-status' + (kind ? ' ' + kind : '');
  }

  function currentArtifact() {
    return (taskState && taskState.artifact) ? taskState.artifact : null;
  }

  /* 未加载校验模块时的兜底分类：**永远不会**返回 verified。 */
  function fallbackClassify(input) {
    var got = input || {};
    if (typeof got.expectedByteLength === 'number' && isFinite(got.expectedByteLength) &&
        got.actualByteLength !== got.expectedByteLength) {
      return {
        status: 'length_mismatch', verified: false, fatal: true,
        note: '取回的文件长度与登记不一致（' + got.actualByteLength + ' / ' + got.expectedByteLength + '），已放弃保存。'
      };
    }
    if (VerifyLib && typeof VerifyLib.fallbackClassify === 'function') return VerifyLib.fallbackClassify(got);
    return {
      status: 'digest_unavailable', verified: false, fatal: false,
      note: '长度一致；校验模块未加载，本次**未核对校验值**。'
    };
  }

  /**
   * 取回字节 → 分级核对 → 触发浏览器保存 → 发布观察事件。
   *
   * **判据的落点**（WCF-D08 缺口 3 / R155，本包只复用、不放宽）：
   *   - 只有 `verified`（摘要已算出且与登记一致）才映射到 `download_verified`；
   *   - `digest_unavailable`（算不出摘要）只记交接观察，文案写明"未核对校验值"；
   *   - `digest_mismatch` / `length_mismatch` / `digest_not_recorded` 一律**放弃保存**，
   *     不触发下载、不发布任何事件。
   *
   * 本函数被两条路径复用：任务产物下载（`browserSave`）与编辑会话的新版本下载
   * （`downloadSessionVersion`）——**同一条核对逻辑，不允许新路径绕过它**。
   */
  function verifyAndSaveBytes(bytes, descriptor, setStatus) {
    return digestSha256(bytes).then(function (hex) {
      var classify = (VerifyLib && typeof VerifyLib.classifyDownload === 'function')
        ? VerifyLib.classifyDownload
        : fallbackClassify;
      var verdict = classify({
        expectedByteLength: descriptor.byteLength,
        actualByteLength: bytes.byteLength,
        expectedSha256: descriptor.sha256,
        actualSha256: hex
      });

      /* 长度不符 / 校验值不符 / 电脑端未登记校验值 ⇒ 放弃保存，不发布任何事件。 */
      if (verdict.fatal === true) throw new Error(verdict.note);

      var blob = new Blob([bytes], { type: descriptor.mimeType || DOCX_MIME });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = descriptor.filename || 'document.docx';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 60000);

      setStatus('已交给手机浏览器保存：' + (descriptor.filename || '') + '。' + verdict.note +
        '请在手机的「下载」或文件管理器里确认文件已出现。', 'ok');

      /* 只有 verified 才发 download_verified；未核验时只记一次交接/下载观察。 */
      var kind = (VerifyLib && typeof VerifyLib.observationKindFor === 'function')
        ? VerifyLib.observationKindFor(verdict.status)
        : (verdict.verified === true ? 'download_verified' : 'handoff_requested');
      if (kind) {
        var detail = (VerifyLib && typeof VerifyLib.observationDetailFor === 'function')
          ? VerifyLib.observationDetailFor(verdict.status, descriptor.filename || '')
          : '页面下载路径观察（未加载校验模块，未核对校验值）：' + (descriptor.filename || '');
        postObservation(descriptor, kind, detail);
      }
      return verdict;
    });
  }

  /* 浏览器下载：把字节取回来按上面的分级核对流程处理。 */
  function browserSave() {
    var artifact = currentArtifact();
    if (!artifact) return;
    setDownloadStatus('正在从电脑取回文件…', '');
    if (dom['save-browser-btn']) dom['save-browser-btn'].setAttribute('disabled', '');

    fetch(artifact.downloadPath, { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('电脑服务返回 HTTP ' + resp.status);
        return resp.arrayBuffer();
      })
      .then(function (buf) {
        return verifyAndSaveBytes(new Uint8Array(buf), artifact, setDownloadStatus);
      })
      ['catch'](function (err) {
        setDownloadStatus((err && err.message ? err.message : '取回文件失败。') +
          ' 没有保存任何文件；上一次的成功文件不会在这里被冒充成本次结果。', 'err');
      })
      .then(function () {
        if (dom['save-browser-btn']) dom['save-browser-btn'].removeAttribute('disabled');
      });
  }

  function methodLabel(method) {
    return method === 'saveCopy' ? '另存副本' : '交给系统软件';
  }

  function shortOpId(operationId) {
    var s = String(operationId === undefined || operationId === null ? '' : operationId);
    return s.length > 12 ? s.slice(0, 12) + '…' : s;
  }

  /* 当前展示的任务对应的文档身份：优先任务编号，其次请求编号。 */
  function currentDocumentId() {
    if (taskState && typeof taskState.taskId === 'string' && taskState.taskId) return taskState.taskId;
    if (taskState && typeof taskState.requestId === 'string' && taskState.requestId) return taskState.requestId;
    var rec = activeRequestId ? findRecord(activeRequestId) : null;
    if (!rec) return '';
    if (rec.taskId) return String(rec.taskId);
    return rec.requestId || '';
  }

  /* 状态区文案**只由跟踪器台账推导**：某次回执不会覆盖别人的待决状态；
     属于其他文件的操作不回写当前文件的状态区。 */
  function renderBridgeStatus() {
    if (!bridgeOps || !dom['download-status']) return;
    var artifact = currentArtifact();
    var artifactId = artifact ? artifact.artifactId : '';

    var live = bridgeOps.pending();
    for (var i = live.length - 1; i >= 0; i--) {
      if (live[i].artifactId === artifactId) {
        setDownloadStatus('已请求' + methodLabel(live[i].method) + '（操作 ' +
          shortOpId(live[i].operationId) + '），等待回执…', '');
        return;
      }
    }

    var last = bridgeOps.lastTerminal();
    if (!last || last.artifactId !== artifactId) return;
    var opTag = '（操作 ' + shortOpId(last.operationId) + '）';
    if (last.terminalReason === 'timeout') {
      setDownloadStatus('已把请求交给应用，但一直没有收到完成回执' + opTag +
        '；本次结果未知，请到手机文件管理器确认。', 'err');
      return;
    }
    if (last.ok === true) {
      setDownloadStatus('已交给系统软件处理' + opTag +
        (last.message ? '：' + last.message : '') +
        '。这不表示办公软件已经打开或内容可编辑，打开与编辑的结果以真机验收为准。', 'ok');
      return;
    }
    setDownloadStatus('应用内路径没有完成' + opTag + '：' + (last.message || '应用没有给出原因') +
      '。本次没有拿到文件，可改用下面的浏览器下载路径。', 'err');
  }

  function looksLikeArityError(e) {
    var text = (e && e.message ? String(e.message) : '') + ' ' + (e && e.name ? String(e.name) : '');
    return /argument|arity|parameter|IllegalArgument|参数个数/i.test(text);
  }

  /* 应用内路径：调用 S1 提供的桥；结果由 window.PotbotBridgeResult 回传。
     saveDocx = 下载并交给系统打开；saveCopy = 走系统选择器另存副本。
     前 4 个参数顺序固定为 (downloadPath, filename, sha256, byteLength)，由 S1 的桥校验
     长度与摘要；第 5 个参数是本页生成的 **operationId（本次操作身份）**，原生实现应
     原样回传，回执据此归位。不接收第 5 参数的原生实现仍可工作，但那种回执没有身份，
     只能在不产生歧义时归位（见 bridge-ops.js 的 resolveLegacy）。 */
  function nativeSave(method) {
    var artifact = currentArtifact();
    if (!artifact) return;
    var api = window.PotbotNative;
    if (!api || typeof api[method] !== 'function') return;

    var isCopy = (method === 'saveCopy');

    if (!bridgeOps) {
      setDownloadStatus('页面未加载桥回执跟踪模块（bridge-ops.js），为避免产生无法归属的回执，' +
        '本次不发起应用内保存。可改用下面的浏览器下载路径。', 'err');
      return;
    }

    var op;
    try {
      op = bridgeOps.begin({
        documentId: currentDocumentId(),
        revision: Number(artifact.taskRevision),
        artifactId: artifact.artifactId,
        method: method
      });
    } catch (e) {
      setDownloadStatus('无法为本次应用内保存建立操作身份（' +
        (e && e.message ? e.message : '未知原因') + '），已放弃发起，避免回执串单。' +
        '可改用下面的浏览器下载路径。', 'err');
      return;
    }

    /* 应用内交接走的就是 content:// URI 授权：这里起一条 URI 台账记录，
       它的终态由桥回执决定（见 settleUriOp）。此时**还没有读回**，所以不可用。 */
    if (uriTracker) {
      var uriOp = uriTracker.request({
        documentId: currentDocumentId(),
        uri: artifact.downloadPath,
        revision: Number(artifact.taskRevision)
      });
      uriByBridgeOp[op.operationId] = uriOp.operationId;
    }

    renderBridgeStatus();
    postObservation(artifact, 'handoff_requested',
      (isCopy ? '页面请求应用内另存副本：' : '页面请求应用内交给系统打开：') + (artifact.filename || '') +
      '（操作 ' + op.operationId + '）');

    var firstError = null;
    try {
      api[method](
        artifact.downloadPath,
        artifact.filename,
        artifact.sha256,
        artifact.byteLength,
        op.operationId
      );
      return;
    } catch (e) {
      firstError = e;
    }

    if (looksLikeArityError(firstError)) {
      /* 兼容拒不接收第 5 参数的原生实现：退回旧签名，并标记本次回执没有身份。 */
      try {
        api[method](artifact.downloadPath, artifact.filename, artifact.sha256, artifact.byteLength);
        bridgeOps.markLegacy(op.operationId);
        return;
      } catch (e2) {
        bridgeOps.settle(op.operationId, {
          reason: 'bridge_throw', ok: false,
          message: (e2 && e2.message ? e2.message : '未知原因')
        });
        renderBridgeStatus();
        return;
      }
    }

    bridgeOps.settle(op.operationId, {
      reason: 'bridge_throw', ok: false,
      message: (firstError && firstError.message ? firstError.message : '未知原因')
    });
    renderBridgeStatus();
  }

  /* 桥回调：约定由 S1 的原生实现调用。
     新签名（推荐）：window.PotbotBridgeResult(operationId, ok, message)
     旧签名（兼容）：window.PotbotBridgeResult(ok, message)
     ok 只表示「已交给系统 / 选择器已唤起」，不代表办公软件已打开，也不代表内容可编辑。
     回执严格按 operationId 归位：对不上号、已终结、或身份不明的回执**不产生任何副作用**。 */
  window.PotbotBridgeResult = function (a, b, c) {
    if (!bridgeOps) return;
    var operationId = null;
    var ok;
    var message;
    if (typeof a === 'string' && a !== '') {
      operationId = a;
      ok = (b === true);
      message = c;
    } else {
      ok = (a === true);
      message = b;
    }
    var msg = (message === undefined || message === null || message === '') ? '' : String(message);

    if (operationId !== null) {
      bridgeOps.settle(operationId, { reason: 'callback', ok: ok, message: msg });
    } else {
      /* 旧签名回执没有身份：只有恰好一条待决操作时才归位，否则拒绝（不猜）。 */
      bridgeOps.resolveLegacy(ok, msg);
    }
    renderBridgeStatus();
  };

  /* 只读调试接缝：给自动化测试读取操作台账用，不接受任何写操作。 */
  window.PotbotWebDebug = {
    bridgeRecords: function () {
      if (!bridgeOps) return [];
      return bridgeOps.records().map(function (op) {
        return {
          operationId: op.operationId, documentId: op.documentId, revision: op.revision,
          artifactId: op.artifactId, method: op.method, legacy: op.legacy,
          terminal: op.terminal, terminalReason: op.terminalReason, ok: op.ok, message: op.message
        };
      });
    },
    pendingCount: function () { return bridgeOps ? bridgeOps.pending().length : 0; },
    downloadStatusText: function () { return dom['download-status'] ? dom['download-status'].textContent : ''; },

    /* --- 编辑区（全部只读；唯一使用者是 tests/demo/word-ui/**） -------- */
    selectionText: function () { return selection ? selection.text : ''; },
    selectionExpression: function () { return selectionExpression || ''; },
    stagedSteps: function () { return staging ? staging.steps() : []; },
    stagedSize: function () { return staging ? staging.size() : 0; },
    undoneSize: function () { return staging ? staging.undoneCount() : 0; },
    editStatusText: function () { return dom['edit-status'] ? dom['edit-status'].textContent : ''; },
    editorErrorText: function () { return dom['editor-error'] ? dom['editor-error'].textContent : ''; },
    versionDownloadStatusText: function () {
      return dom['version-download-status'] ? dom['version-download-status'].textContent : '';
    },
    session: function () {
      return session === null ? null : {
        sessionId: session.sessionId,
        editRevision: session.editRevision,
        contentDigest: session.contentDigest
      };
    },
    lastVerdict: function () {
      return lastVerdict === null ? null : { kind: lastVerdict.kind, showsSuccess: lastVerdict.showsSuccess === true };
    },
    previewParagraphCount: function () { return preview ? preview.paragraphCount : 0; },
    previewTableCount: function () { return preview ? preview.tables.length : 0; },
    previewTexts: function () {
      return preview ? preview.paragraphs.map(function (paragraph) { return paragraph.text; }) : [];
    },
    formatState: function () {
      return (preview && selection && DocReadLib) ? DocReadLib.formatStateOf(preview, selection) : null;
    },

    /* --- 节 / 列表（WCF-D72；全部只读） --------------------------------- */
    sections: function () { return previewSections(); },
    sectionCount: function () { return previewSections().length; },
    sectionScopeValue: function () { return readValue('ctl-section-scope', ''); },
    sectionScopeLabel: function () {
      if (!SectionIntentLib) return '';
      return SectionIntentLib.scopeLabel(sectionScopeFromUi());
    },
    /** 每个暂存步骤的域（`'paragraph'` / `'section'` / `'list'`）——保存分流靠它。 */
    stagedDomains: function () {
      if (!staging) return [];
      return staging.steps().map(function (step) {
        if (ListIntentLib && ListIntentLib.isListStep(step)) return 'list';
        return (SectionIntentLib && SectionIntentLib.isSectionStep(step)) ? 'section' : 'paragraph';
      });
    },
    sectionStatusText: function () { return dom['section-note'] ? dom['section-note'].textContent : ''; },
    listStatusText: function () { return dom['list-note'] ? dom['list-note'].textContent : ''; },
    /**
     * 最近一次列表控件尝试。
     * `ok:true` = 已经**加入暂存**（还没提交，更没保存）；`ok:false` = 结构化拒绝 + 原因。
     */
    lastListAttempt: function () { return lastListAttempt === null ? null : lastListAttempt; },

    /* --- 导航骨架与连续对话（FA-A；全部只读，不接受任何写操作） --------- */
    activeView: function () { return activeViewId; },
    viewIds: function () { return NavLib ? NavLib.ids() : []; },
    navTrail: function () { return router ? router.trail() : []; },
    /** 某视图状态条的**机器可判状态名**（blank/loading/failure/offline/ready）。 */
    viewStateName: function (id) {
      var node = dom['view-state-' + id];
      return node && node.getAttribute ? String(node.getAttribute('data-state') || '') : '';
    },
    isOffline: function () { return offlineNow === true; },
    /* --- APP-02 接线（只读）：证明导航条/四态/离线确实由 app-nav.js + nav-view.js 驱动 --- */
    /** APP-02 渲染层是否真的接上（缺 app-nav.js 或 nav-view.js 时为 false）。 */
    navViewWired: function () { return navViewReady(); },
    /** 导航条上由渲染层建出的七个入口（id / 深链 / 是否当前），没接上时为空数组。 */
    navViewEntries: function () {
      if (!navViewReady() || typeof NavViewLib.buildNavModel !== 'function') return [];
      return NavViewLib.buildNavModel(activeViewId, window);
    },
    /** 某视图状态条的 APP-02 四态名（empty/loading/error/offline/ready）。 */
    navStateName: function (id) {
      var node = dom['view-state-' + id];
      return node && node.getAttribute ? String(node.getAttribute('data-nav-state') || '') : '';
    },
    /** 最近一次连接探测的结论（含来源），没探过时为 null。 */
    lastProbe: function () { return navViewMount && typeof navViewMount.lastProbe === 'function' ? navViewMount.lastProbe() : null; },
    chatBackendReady: function () { return chatBackendReady(); },
    /** 发送若被挡住，原因码；可发时为空串。 */
    sendBlockedReason: function () {
      if (offlineNow) return 'offline';
      if (!conversation) return 'no_conversation_module';
      if (!chatBackendReady()) return 'backend_unavailable';
      return '';
    },
    sessionNames: function () {
      return conversation ? conversation.sessions(true).map(function (s) { return s.name; }) : [];
    },
    messageStates: function (sessionId) {
      if (!conversation) return [];
      var sid = sessionId || conversation.current();
      return conversation.messages(sid).map(function (m) { return m.state; });
    },
    messageCount: function (sessionId) {
      if (!conversation) return 0;
      var sid = sessionId || conversation.current();
      return conversation.messages(sid).length;
    },
    /** 只读：切视图（等价于点导航按钮）。仅供独立验证器驱动，不写任何业务状态。 */
    renderView: function (id) { return goView(id); },

    /* --- 四个管理面板（FA-PRODUCT-WEB-UI；只读，唯一动作是一次 GET 重读） --- */
    /** 注册进来的面板视图（缺面板文件时为空——反向对照靠它）。 */
    panelViews: function () {
      return (PanelsLib && typeof PanelsLib.views === 'function') ? PanelsLib.views() : [];
    },
    /** 每个面板真的会打的那个接口（只读快照）。 */
    panelEndpoints: function () {
      if (!PanelsLib || typeof PanelsLib.all !== 'function') return [];
      return PanelsLib.all().map(function (p) { return { view: p.view, endpoint: p.endpoint }; });
    },
    /** 只读：重读某视图的面板（等价于点「重新读取」按钮，只发 GET）。 */
    panelRefresh: function (viewId) { return refreshPanel(viewId); },

    /* --- 会话列表的服务端一致性（FA-WEB-CONSUME-LIFECYCLE；只读 + 一次 GET 重读） ---
       `server` = 接上后端且已成功读到清单（写操作走电脑端）；`server-unread` = 接上后端但
       这次没读到（写操作仍走电脑端，只是列表暂无）；`local` = 没有对话后端，退回本机存储。 */
    sessionsMode: function () {
      if (!serverSessionMode()) return 'local';
      return remoteSessionsReady ? 'server' : 'server-unread';
    },
    sessionsError: function () {
      return remoteSessionsError
        ? { code: String(remoteSessionsError.code || ''), message: String(remoteSessionsError.message || '') }
        : null;
    },
    sessionQuery: function () { return sessionQuery; },
    showArchived: function () { return showArchived; },
    selectedSession: function () { return sessSelectedId; },
    /** 列表当前渲染出的行（id / 名字 / 是否已归档）。 */
    sessionItems: function () {
      var rows = sessionRows();
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        out.push({ id: rows[i].id, name: rows[i].name, archived: rows[i].archived });
      }
      return out;
    },
    sessionRowCount: function () {
      return (dom['sess-list'] && dom['sess-list'].children) ? dom['sess-list'].children.length : 0;
    },
    sessionNote: function () { return dom['sess-note'] ? String(dom['sess-note'].textContent || '') : ''; },
    sessionSearchNote: function () {
      return dom['sess-search-note'] ? String(dom['sess-search-note'].textContent || '') : '';
    },
    /** 只读：重读一次服务端会话清单（等价于点「搜索」或勾选「显示已归档」）。 */
    sessionRefresh: function () { return reloadSessions(); },

    /* --- APP-04 任务与文件 / APP-07 设置（FA-K；全部只读） ---------------- */
    taskQuery: function () { return taskQuery; },
    fileQuery: function () { return fileQuery; },
    /** 任务列表当前渲染出的条目数（搜索后）。 */
    taskItemCount: function () { return (dom['task-list'] && dom['task-list'].children) ? dom['task-list'].children.length : 0; },
    fileItemCount: function () { return (dom['file-list'] && dom['file-list'].children) ? dom['file-list'].children.length : 0; },
    searchNote: function (view) { return (dom[(view || 'task') + '-search-note'] || {}).textContent || ''; },
    /** 当前任务操作条上每个动作的可用性（机器可判）。 */
    taskActionStates: function () {
      var bar = dom['task-action-bar'];
      if (!bar || !bar.children) return [];
      var out = [];
      for (var i = 0; i < bar.children.length; i++) {
        var node = bar.children[i];
        if (node.getAttribute) {
          out.push({ id: String(node.getAttribute('data-task-action') || ''), enabled: node.getAttribute('data-enabled') === 'true' });
        }
      }
      return out;
    },
    taskUriStatusText: function () { return (dom['task-uri-status'] || {}).textContent || ''; },
    taskActionsNote: function () { return (dom['task-actions-note'] || {}).textContent || ''; },
    /** URI 台账摘要（本机真实记录，不是模拟）。 */
    uriRecords: function () {
      if (!uriTracker) return [];
      return uriTracker.records().map(function (rec) {
        var verdict = uriTracker.evaluate(rec.operationId);
        return { operationId: rec.operationId, state: rec.state, code: verdict.code,
          showsSuccess: verdict.showsSuccess, usable: uriTracker.usable(rec.operationId) };
      });
    },
    /** 授权清单及状态。 */
    authEntries: function () {
      return authRegistry ? authRegistry.entries().map(function (item) {
        return { id: item.id, state: item.state, canRevoke: item.canRevoke };
      }) : [];
    },
    authNote: function () { return (dom['settings-auth-note'] || {}).textContent || ''; },
    connectionRows: function () {
      return dom['settings-connection'] && dom['settings-connection'].children
        ? dom['settings-connection'].children.length : 0;
    },
    settingsSecretCheck: function () {
      return pageSecretFindings === null ? null : { ok: pageSecretFindings.ok, count: pageSecretFindings.findings.length };
    },
    /** 只读：设置页上显示的错误动作文案。 */
    settingsErrorHint: function () { return (dom['settings-error-hint'] || {}).textContent || ''; }
  };

  function postObservation(artifact, kind, detail) {
    if (!artifact || !artifact.artifactId) return;
    var key = artifact.artifactId + '|' + kind + '|' + detail;
    if (postedObservations[key]) return;
    postedObservations[key] = true;
    var body = { observationId: newId('obs'), kind: kind, detail: detail };
    request('POST', ROUTES.observations(artifact.artifactId), body, 12000)['catch'](function () {
      /* 观察记录失败不影响用户，也不改变任务状态；不在此处伪造成功。 */
    });
  }

  /* ===================== 文档编辑：导入 → 选区 → 控件 → 保存 ===================== */

  var toolbarButtons = [];   /* [{ node, control, alwaysEnabled }]，供状态刷新 */
  var sessionVersions = [];  /* GET /api/sessions/:id 返回的版本映射（服务端权威） */

  function editorUnavailableReason() {
    if (!DocReadLib) return '页面没有加载文档预览模块（doc-read.js），本次不提供编辑入口。';
    if (!EditIntentLib) return '页面没有加载编辑意图模块（edit-intent.js），本次不提供编辑入口。';
    return '';
  }

  function setEditorError(msg) {
    if (!dom['editor-error']) return;
    if (msg) {
      setText(dom['editor-error'], msg);
      show(dom['editor-error'], true);
    } else {
      setText(dom['editor-error'], '');
      show(dom['editor-error'], false);
    }
  }

  function setEditorStatus(text, kind) {
    if (!dom['edit-status']) return;
    setText(dom['edit-status'], text);
    dom['edit-status'].className = 'edit-status' + (kind ? ' ' + kind : '');
  }

  function setVersionDownloadStatus(text, kind) {
    if (!dom['version-download-status']) return;
    setText(dom['version-download-status'], text);
    dom['version-download-status'].className = 'download-status' + (kind ? ' ' + kind : '');
  }

  function renderSessionIdentity() {
    setText(dom['session-id'], session ? session.sessionId : '');
    setText(dom['session-revision'], session
      ? ('第 ' + session.editRevision + ' 版（一次事务 +1）')
      : '');
    setText(dom['session-digest'], session ? session.contentDigest : '');
  }

  /* ---------- 导入 ---------- */

  function importDocument() {
    setEditorError('');
    var reason = editorUnavailableReason();
    if (reason) {
      setEditorError(reason);
      return;
    }
    var input = dom['docx-file'];
    var file = (input && input.files && input.files.length > 0) ? input.files[0] : null;
    if (!file) {
      setEditorError('请先选择一个 .docx 文件。');
      return;
    }
    var name = file.name || 'document.docx';
    if (typeof file.arrayBuffer !== 'function') {
      setEditorError('这个浏览器不能直接读取所选文件；请改用支持文件读取的浏览器。');
      return;
    }

    setEditorStatus('正在读取所选文件…', '');
    if (dom['import-btn']) dom['import-btn'].setAttribute('disabled', '');
    var bytesHolder = null;

    file.arrayBuffer()
      .then(function (buf) {
        var bytes = new Uint8Array(buf);
        if (bytes.byteLength === 0) throw new Error('这个文件是空的，没有可导入的内容。');
        bytesHolder = bytes;
        var base64;
        try {
          base64 = DocReadLib.bytesToBase64(bytes);
        } catch (e) {
          throw new Error('无法把文件编码成上传格式：' + (e && e.message ? e.message : '未知原因'));
        }
        return request('POST', ROUTES.sessions, {
          sessionId: newId('sess'),
          filename: name,
          mode: 'import',
          docxBase64: base64
        }, 60000);
      })
      .then(function (res) {
        if (!res.ok || !res.data || !res.data.sessionId) throw { demoError: describeHttpError(res) };
        session = {
          sessionId: String(res.data.sessionId),
          documentId: res.data.documentId ? String(res.data.documentId) : '',
          filename: res.data.filename ? String(res.data.filename) : name,
          editRevision: typeof res.data.editRevision === 'number' ? res.data.editRevision : 0,
          contentDigest: res.data.contentDigest ? String(res.data.contentDigest) : ''
        };
        versionEntry = null;
        sessionVersions = [];
        if (staging) staging.clear();
        selection = null;
        selectionExpression = null;
        renderSessionIdentity();
        renderSelection();
        renderStaged();
        renderVersions();
        renderToolbar();
        show(dom['editor-body'], true);
        setEditorStatus('已导入会话。请在下面的预览里选中文字，再点格式控件。', 'ok');
        return loadPreviewFromBytes(bytesHolder);
      })
      ['catch'](function (err) {
        var msg = err && err.demoError
          ? err.demoError.message
          : (err && err.message ? err.message : '导入失败：连不上电脑服务。');
        setEditorError(msg);
        setEditorStatus('本次没有导入成功，文档没有被改动。', 'err');
      })
      .then(function () {
        if (dom['import-btn']) dom['import-btn'].removeAttribute('disabled');
      });
  }

  /* ---------- 预览（读服务端返回的 DOCX 字节） ---------- */

  function loadPreviewFromBytes(bytes) {
    if (!DocReadLib) return Promise.resolve(null);
    return DocReadLib.readDocxStructure(bytes).then(function (result) {
      if (!result || result.ok !== true) {
        preview = null;
        if (dom['doc-preview']) clearNode(dom['doc-preview']);
        setEditorStatus((result && result.message) || '无法预览这份文档。', 'err');
        renderPreviewMeta();
        renderSectionPanel();
        return null;
      }
      preview = result.preview;
      renderPreview();
      renderPreviewMeta();
      renderSelection();
      renderFormatCheck();
      return preview;
    }, function (error) {
      preview = null;
      setEditorStatus('预览失败：' + (error && error.message ? error.message : '未知原因'), 'err');
      return null;
    });
  }

  function renderPreviewMeta() {
    if (!dom['preview-meta']) return;
    if (!preview) {
      setText(dom['preview-meta'], '还没有可预览的文档。');
      return;
    }
    setText(dom['preview-meta'],
      '共 ' + preview.paragraphCount + ' 段（含表格单元格内的段落）、' + preview.tables.length +
      ' 个表格。预览文字与格式状态都读自服务端返回的 DOCX 字节；**只读直接格式，未展开样式继承**。');
  }

  function paragraphElement(index) {
    var paragraph = preview.paragraphs[index - 1];
    var node = el('p', 'doc-para');
    node.setAttribute('data-para', String(index));
    /* 文档文字**只经文本节点**进入 DOM，绝不用 innerHTML。 */
    node.appendChild(document.createTextNode(paragraph.text));
    return node;
  }

  function renderPreview() {
    var host = dom['doc-preview'];
    if (!host) return;
    clearNode(host);
    /* R114：文档换了内容，**旧选区一律作废**——不把旧偏移硬套到新文本上。
       重新渲染预览时清空选区，让用户在新文本上重新选。 */
    selection = null;
    selectionExpression = null;
    /* 文档换了 ⇒ 节列表也可能变了（每一版都重读返回的字节），面板跟着重画。 */
    renderSectionPanel();
    if (!preview) return;
    for (var i = 0; i < preview.blocks.length; i++) {
      var block = preview.blocks[i];
      if (block.kind === 'paragraph') host.appendChild(paragraphElement(block.paragraphIndex));
      else host.appendChild(tableElement(block.index));
    }
  }

  function tableElement(tableIndex) {
    var table = null;
    for (var t = 0; t < preview.tables.length; t++) {
      if (preview.tables[t].index === tableIndex) table = preview.tables[t];
    }
    var element = el('table', 'doc-table');
    var body = el('tbody', '');
    element.appendChild(body);
    if (!table) return element;
    for (var r = 0; r < table.rows.length; r++) {
      var row = el('tr', '');
      var cells = table.rows[r].cells;
      for (var c = 0; c < cells.length; c++) {
        var td = el('td', '');
        td.setAttribute('data-table', String(tableIndex));
        td.setAttribute('data-row', String(cells[c].row));
        td.setAttribute('data-column', String(cells[c].column));
        for (var p = 0; p < cells[c].paragraphIndexes.length; p++) {
          td.appendChild(paragraphElement(cells[c].paragraphIndexes[p]));
        }
        row.appendChild(td);
      }
      body.appendChild(row);
    }
    return element;
  }

  /* ---------- 选区 → 范围表达式 ---------- */

  function paragraphIndexOfNode(node) {
    var current = node;
    while (current) {
      if (typeof current.getAttribute === 'function') {
        var raw = current.getAttribute('data-para');
        if (raw !== null && raw !== undefined && raw !== '') {
          var index = Number(raw);
          if (isFinite(index) && index >= 1) return index;
        }
      }
      current = current.parentNode || null;
    }
    return null;
  }

  function offsetForPoint(container, offset, paraIndex, edge) {
    if (container && container.nodeType === 3 && typeof offset === 'number') return offset;
    if (paraIndex !== null && preview && preview.paragraphs[paraIndex - 1]) {
      return edge === 'start' ? 0 : DocReadLib.codePointLength(preview.paragraphs[paraIndex - 1].text);
    }
    return null;
  }

  function currentSelectionObject() {
    if (typeof window.getSelection === 'function') {
      var fromWindow = window.getSelection();
      if (fromWindow) return fromWindow;
    }
    if (typeof document.getSelection === 'function') return document.getSelection();
    return null;
  }

  function readSelectionFromDom() {
    if (!preview || !DocReadLib) return null;
    var sel = currentSelectionObject();
    if (!sel || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    if (!range) return null;

    var startPara = paragraphIndexOfNode(range.startContainer);
    var endPara = paragraphIndexOfNode(range.endContainer);
    if (startPara === null || endPara === null) return null;

    var startOffset = offsetForPoint(range.startContainer, range.startOffset, startPara, 'start');
    var endOffset = offsetForPoint(range.endContainer, range.endOffset, endPara, 'end');
    if (endPara < startPara) {
      var swapPara = startPara; startPara = endPara; endPara = swapPara;
      var swapOffset = startOffset; startOffset = endOffset; endOffset = swapOffset;
    }

    var text = '';
    try {
      text = String(typeof sel.toString === 'function' ? sel.toString() : '');
    } catch (e) {
      text = '';
    }
    return {
      text: text,
      startPara: startPara,
      startOffset: startOffset,
      endPara: endPara,
      endOffset: endOffset
    };
  }

  function applySelectionFromDom() {
    if (!preview || !DocReadLib) return;
    var next = readSelectionFromDom();
    if (next === null || next.text.replace(/\s+/g, '') === '') {
      selection = null;
      selectionExpression = null;
      renderSelection();
      return;
    }
    selection = next;
    var translated = DocReadLib.selectionToRangeExpression(preview, selection);
    selectionExpression = translated ? translated.expression : null;
    renderSelection();
    renderFormatCheck();
  }

  function renderSelection() {
    setText(dom['selection-text'], selection ? selection.text : '还没有选中文字。');
    var node = dom['selection-expr'];
    if (!node) return;
    if (!selection) {
      setText(node, '');
      node.className = 'selection-expr';
    } else if (selectionExpression) {
      setText(node, '范围表达式：' + selectionExpression +
        '（第 ' + selection.startPara + ' 段起、第 ' + selection.endPara + ' 段止）');
      node.className = 'selection-expr is-ok';
    } else {
      setText(node,
        '这段选中无法用内核的固定范围语法表达（例如跨段但两端没对齐到段落边界）。' +
        '请改成整段或整段区间再试——页面不会用近似表达式替你猜。');
      node.className = 'selection-expr is-warn';
    }
    renderToolbarState();
  }

  var TOGGLE_LABEL = {
    bold: '加粗', italic: '斜体', strike: '删除线',
    doubleStrike: '双删除线', caps: '全部大写', smallCaps: '小型大写'
  };
  var PARAGRAPH_LABEL = {
    alignment: '对齐', lineSpacing: '行距', spacingBefore: '段前间距', spacingAfter: '段后间距',
    firstLineIndent: '首行缩进', hangingIndent: '悬挂缩进', leftIndent: '左缩进', rightIndent: '右缩进'
  };

  function toggleStateText(state) {
    if (state === 'on') return '统一：已开启';
    if (state === 'off') return '统一：已显式关闭';
    if (state === 'unset') return '未指定（继承样式）';
    return '混合（选区里不一致）';
  }

  function paragraphStateText(entry) {
    if (!entry) return '未知';
    if (entry.state === 'mixed') return '混合（选区里不一致）';
    if (entry.state === 'unset') return '未指定（继承样式）';
    try {
      return '已设置：' + JSON.stringify(entry.value);
    } catch (e) {
      return '已设置';
    }
  }

  function renderFormatCheck() {
    var list = dom['format-state'];
    if (!list) return;
    clearNode(list);
    if (!preview || !selection || !DocReadLib) {
      setText(dom['format-source'], '选中一段文字后这里会显示它的当前状态。');
      return;
    }
    var state = DocReadLib.formatStateOf(preview, selection);
    var keys = Object.keys(TOGGLE_LABEL);
    for (var i = 0; i < keys.length; i++) {
      list.appendChild(stateRow(TOGGLE_LABEL[keys[i]], toggleStateText(state.toggles[keys[i]])));
    }
    var fields = Object.keys(PARAGRAPH_LABEL);
    for (var f = 0; f < fields.length; f++) {
      list.appendChild(stateRow(PARAGRAPH_LABEL[fields[f]], paragraphStateText(state.paragraph[fields[f]])));
    }
    setText(dom['format-source'],
      '状态读自服务端返回的 DOCX 字节（共 ' + state.paragraphCount +
      ' 段）。这是**直接格式**：显示"未指定（继承样式）"表示该属性没有直接设置，实际外观由样式决定，本页不展开样式继承。');
  }

  function stateRow(key, value) {
    var item = el('li', 'kv-item');
    item.appendChild(el('span', 'kv-key', key));
    item.appendChild(el('span', 'kv-val', value));
    return item;
  }

  /* ---------- 格式控件 ---------- */

  function toolButton(id, label, className) {
    var button = el('button', 'tool-btn' + (className ? ' ' + className : ''));
    button.type = 'button';
    button.id = id;
    setText(button, label);
    return button;
  }

  function toolSelect(id, options) {
    var select = el('select', 'tool-select');
    select.id = id;
    for (var i = 0; i < options.length; i++) {
      var option = el('option', '');
      option.value = options[i].value;
      setText(option, options[i].label);
      select.appendChild(option);
    }
    /* 显式给出默认值：浏览器会默认选第一项，但把这件事写出来，读值与测试都不依赖隐式行为。 */
    if (options.length > 0) select.value = options[0].value;
    return select;
  }

  function toolNumber(id, value) {
    var input = el('input', 'tool-input');
    input.type = 'number';
    input.id = id;
    input.setAttribute('min', '0');
    input.value = String(value);
    return input;
  }

  /** 文本输入（字体名等）。`placeholder` 说明"留空 = 该槽不改"。 */
  function toolText(id, value, placeholder) {
    var input = el('input', 'tool-input');
    input.type = 'text';
    input.id = id;
    if (placeholder) input.setAttribute('placeholder', placeholder);
    input.value = value === undefined || value === null ? '' : String(value);
    return input;
  }

  function renderToolbar() {
    var host = dom['format-toolbar'];
    if (!host) return;
    clearNode(host);
    toolbarButtons = [];
    if (!EditIntentLib) {
      setText(dom['toolbar-note'], editorUnavailableReason());
      return;
    }
    setText(dom['toolbar-note'],
      '点一下就把这一步加进「待保存的步骤」。**字体（中西文四槽）与字号**已接上内核的 setValue 通道，' +
      '可用下面两组控件设置；颜色 / 高亮 / 下划线样式 / 上标下标在内核意图层仍未开写入通道，' +
      '本页不提交注定被拒的请求，因此它们标为暂不可用（点一下会说明原因）。');

    /* --- 字符格式 ------------------------------------------------------- */
    var characterGroup = el('div', 'toolbar-group');
    characterGroup.appendChild(el('span', 'toolbar-label', '字符格式'));
    for (var i = 0; i < EditIntentLib.CONTROLS.length; i++) {
      var control = EditIntentLib.CONTROLS[i];
      if (control.group !== 'character') continue;
      /* 字体 / 字号有专属的多字段控件，单独成组，见下。 */
      if (control.input === 'font' || control.input === 'size') continue;
      characterGroup.appendChild(toolbarNodeFor(control));
    }
    host.appendChild(characterGroup);

    /* --- 字体（WF-006：中西文四槽分设）与字号（WF-007）----------------- */
    host.appendChild(renderFontGroup());
    host.appendChild(renderSizeGroup());

    /* --- 段落排版 ------------------------------------------------------- */
    var paragraphGroup = el('div', 'toolbar-group');
    paragraphGroup.appendChild(el('span', 'toolbar-label', '段落排版'));
    var alignment = EditIntentLib.controlById('alignment');
    for (var a = 0; a < alignment.values.length; a++) {
      paragraphGroup.appendChild(choiceButton('ctl-alignment-' + alignment.values[a],
        alignmentLabel(alignment.values[a]), 'alignment', alignment.values[a]));
    }

    paragraphGroup.appendChild(toolSelect('ctl-lineSpacing-select', [
      { value: 'single', label: '单倍行距' },
      { value: 'oneAndHalf', label: '1.5 倍行距' },
      { value: 'double', label: '双倍行距' },
      { value: 'multiple', label: '自定义倍数' },
      { value: 'exact', label: '固定值' },
      { value: 'atLeast', label: '最小值' }
    ]));
    paragraphGroup.appendChild(toolNumber('ctl-lineSpacing-value', 1.5));
    paragraphGroup.appendChild(toolSelect('ctl-lineSpacing-unit', unitOptions()));
    paragraphGroup.appendChild(applyButton('ctl-lineSpacing-apply', '行距', function () {
      applyControl('lineSpacing', lineSpacingValueFromUi());
    }));

    var spacingModes = [
      { value: 'pt', label: '磅' },
      { value: 'lines', label: '行' },
      { value: 'auto', label: '自动' }
    ];
    paragraphGroup.appendChild(el('span', 'toolbar-label', '段间距'));
    paragraphGroup.appendChild(toolSelect('ctl-spacingBefore-mode', spacingModes));
    paragraphGroup.appendChild(toolNumber('ctl-spacingBefore-value', 0));
    paragraphGroup.appendChild(applyButton('ctl-spacingBefore-apply', '段前', function () {
      applyControl('spacingBefore', spacingValueFromUi('spacingBefore'));
    }));
    paragraphGroup.appendChild(toolSelect('ctl-spacingAfter-mode', spacingModes));
    paragraphGroup.appendChild(toolNumber('ctl-spacingAfter-value', 0));
    paragraphGroup.appendChild(applyButton('ctl-spacingAfter-apply', '段后', function () {
      applyControl('spacingAfter', spacingValueFromUi('spacingAfter'));
    }));

    paragraphGroup.appendChild(el('span', 'toolbar-label', '缩进（字符 / 长度分开）'));
    paragraphGroup.appendChild(toolNumber('ctl-firstLineIndent-value', 2));
    paragraphGroup.appendChild(toolSelect('ctl-firstLineIndent-unit', indentUnitOptions()));
    paragraphGroup.appendChild(applyButton('ctl-firstLineIndent-apply', '首行缩进', function () {
      applyControl('firstLineIndent', indentValueFromUi('firstLineIndent'));
    }));
    paragraphGroup.appendChild(toolNumber('ctl-hangingIndent-value', 2));
    paragraphGroup.appendChild(toolSelect('ctl-hangingIndent-unit', indentUnitOptions()));
    paragraphGroup.appendChild(applyButton('ctl-hangingIndent-apply', '悬挂缩进', function () {
      applyControl('hangingIndent', indentValueFromUi('hangingIndent'));
    }));
    paragraphGroup.appendChild(toolNumber('ctl-leftIndent-value', 0));
    paragraphGroup.appendChild(toolSelect('ctl-leftIndent-unit', indentUnitOptions()));
    paragraphGroup.appendChild(applyButton('ctl-leftIndent-apply', '左缩进', function () {
      applyControl('leftIndent', indentValueFromUi('leftIndent'));
    }));
    paragraphGroup.appendChild(toolNumber('ctl-rightIndent-value', 0));
    paragraphGroup.appendChild(toolSelect('ctl-rightIndent-unit', indentUnitOptions()));
    paragraphGroup.appendChild(applyButton('ctl-rightIndent-apply', '右缩进', function () {
      applyControl('rightIndent', indentValueFromUi('rightIndent'));
    }));

    var clearParagraph = EditIntentLib.controlById('clearParagraphFormat');
    paragraphGroup.appendChild(quickButton('ctl-clearParagraphFormat', clearParagraph.label, function () {
      applyControl('clearParagraphFormat', undefined);
    }));
    host.appendChild(paragraphGroup);

    renderToolbarState();
  }

  function alignmentLabel(value) {
    if (value === 'left') return '左对齐';
    if (value === 'center') return '居中';
    if (value === 'right') return '右对齐';
    if (value === 'justify') return '两端对齐';
    return '分散对齐';
  }

  function unitOptions() {
    return [
      { value: 'pt', label: '磅' }, { value: 'cm', label: '厘米' },
      { value: 'mm', label: '毫米' }, { value: 'inch', label: '英寸' },
      { value: 'twips', label: '缇' }
    ];
  }

  function indentUnitOptions() {
    return [{ value: 'chars', label: '字符' }].concat(unitOptions());
  }

  /**
   * 字体组（WF-006）：**四槽分设**——西文 `ascii` / 西文扩展 `hAnsi` / 中文 `eastAsia` /
   * 复杂文种 `cs`。留空的槽位**不带进 payload**（= 该槽不指定），与内核 `IntentFontSet`
   * 的语义一致；四槽全留空时本地拒绝（`edit-intent.js` 的 `checkFontsValue`），不发请求。
   */
  function renderFontGroup() {
    var group = el('div', 'toolbar-group');
    group.appendChild(el('span', 'toolbar-label', '字体（中西文分设；留空 = 该槽不改）'));
    var slots = [
      { slot: 'ascii', label: '西文', value: 'Times New Roman' },
      { slot: 'hAnsi', label: '西文扩展', value: '' },
      { slot: 'eastAsia', label: '中文', value: '宋体' },
      { slot: 'cs', label: '复杂文种', value: '' }
    ];
    for (var i = 0; i < slots.length; i++) {
      group.appendChild(el('span', 'toolbar-label', slots[i].label));
      group.appendChild(toolText('ctl-fonts-' + slots[i].slot, slots[i].value, '留空不改'));
    }
    group.appendChild(applyButton('ctl-fonts-apply', '字体', function () {
      applyControl('fonts', fontsValueFromUi());
    }));
    return group;
  }

  /**
   * 字号组（WF-007）：**中文字号名**（十六项，来自内核表）或 **pt 精确值**二选一。
   * pt 必须是 0.5 的整数倍——`12.3` 之类在本地就被拒（`checkSizeValue`），不四舍五入。
   */
  function renderSizeGroup() {
    var group = el('div', 'toolbar-group');
    group.appendChild(el('span', 'toolbar-label', '字号'));
    group.appendChild(toolSelect('ctl-size-mode', [
      { value: 'chinese', label: '中文字号' },
      { value: 'pt', label: '磅值 (pt)' }
    ]));
    var names = [];
    for (var i = 0; i < EditIntentLib.CHINESE_FONT_SIZE_NAMES.length; i++) {
      var name = EditIntentLib.CHINESE_FONT_SIZE_NAMES[i];
      names.push({ value: name, label: name });
    }
    group.appendChild(toolSelect('ctl-size-name', names));
    group.appendChild(toolNumber('ctl-size-pt', 12));
    group.appendChild(applyButton('ctl-size-apply', '字号', function () {
      applyControl('size', sizeValueFromUi());
    }));
    return group;
  }

  /** 从四槽输入读字体值：**只带非空槽位**，字符串**不裁剪**（与内核逐字一致）。 */
  function fontsValueFromUi() {
    var value = {};
    for (var i = 0; i < EditIntentLib.FONT_SLOTS.length; i++) {
      var slot = EditIntentLib.FONT_SLOTS[i];
      var raw = readValue('ctl-fonts-' + slot, '');
      if (raw.trim().length > 0) value[slot] = raw;
    }
    return value;
  }

  /** 从控件读字号值：中文字号名 或 pt 值。 */
  function sizeValueFromUi() {
    if (readValue('ctl-size-mode', 'chinese') === 'pt') {
      return { kind: 'pt', value: readNumber('ctl-size-pt', 12) };
    }
    return { kind: 'chinese', name: readValue('ctl-size-name', '小四') };
  }

  function toolbarNodeFor(control) {
    if (control.input === 'unwired') {
      /* 暂不可用：**不隐藏**，点一下会说明为什么（比一个沉默的灰按钮更有用）。 */
      var unwired = toolButton('ctl-' + control.id, control.label + '（暂不可用）', 'is-unwired');
      unwired.addEventListener('click', function () { applyControl(control.id, undefined); });
      toolbarButtons.push({ node: unwired, control: control, alwaysEnabled: true });
      return unwired;
    }
    if (control.input === 'toggle') {
      var toggle = toolButton('ctl-' + control.id, control.label);
      toggle.addEventListener('click', function () { applyToggle(control); });
      toolbarButtons.push({ node: toggle, control: control });
      return toggle;
    }
    var action = toolButton('ctl-' + control.id, control.label);
    action.addEventListener('click', function () { applyControl(control.id, undefined); });
    toolbarButtons.push({ node: action, control: control });
    return action;
  }

  function choiceButton(id, label, controlId, value) {
    var button = toolButton(id, label);
    button.addEventListener('click', function () { applyControl(controlId, value); });
    toolbarButtons.push({ node: button, control: EditIntentLib.controlById(controlId) });
    return button;
  }

  function applyButton(id, label, handler) {
    var button = toolButton(id, label + '：应用');
    button.addEventListener('click', handler);
    toolbarButtons.push({ node: button, control: null });
    return button;
  }

  function quickButton(id, label, handler) {
    var button = toolButton(id, label);
    button.addEventListener('click', handler);
    toolbarButtons.push({ node: button, control: null });
    return button;
  }

  function readNumber(id, fallback) {
    var node = dom[id] || (document.getElementById ? document.getElementById(id) : null);
    if (!node) return fallback;
    var value = Number(node.value);
    return isFinite(value) ? value : fallback;
  }

  function readValue(id, fallback) {
    var node = dom[id] || (document.getElementById ? document.getElementById(id) : null);
    return node && node.value !== undefined ? String(node.value) : fallback;
  }

  function lineSpacingValueFromUi() {
    var mode = readValue('ctl-lineSpacing-select', 'single');
    if (mode === 'single' || mode === 'oneAndHalf' || mode === 'double') return mode;
    if (mode === 'multiple') return { mode: mode, value: readNumber('ctl-lineSpacing-value', 1.5) };
    return { mode: mode, value: readNumber('ctl-lineSpacing-value', 12), unit: readValue('ctl-lineSpacing-unit', 'pt') };
  }

  function spacingValueFromUi(prefix) {
    var mode = readValue('ctl-' + prefix + '-mode', 'pt');
    if (mode === 'auto') return { mode: 'auto' };
    return { mode: mode, value: readNumber('ctl-' + prefix + '-value', 0) };
  }

  function indentValueFromUi(prefix) {
    var unit = readValue('ctl-' + prefix + '-unit', 'chars');
    var value = readNumber('ctl-' + prefix + '-value', 0);
    if (unit === 'chars') return { mode: 'chars', value: value };
    return { mode: 'length', unit: unit, value: value };
  }

  function applyToggle(control) {
    var current = null;
    if (preview && selection && DocReadLib) {
      var state = DocReadLib.formatStateOf(preview, selection);
      current = state.toggles[control.property];
    }
    /* 已开启 ⇒ 关闭；混合 / 未指定 / 已关闭 ⇒ 打开（与编辑器的"点一下切换"一致）。 */
    applyControl(control.id, current !== 'on');
  }

  function applyControl(controlId, value) {
    if (!EditIntentLib || !staging) {
      setEditorStatus(editorUnavailableReason(), 'err');
      return false;
    }
    var step = EditIntentLib.buildStep(selectionExpression, controlId, value);
    if (!step.ok) {
      setEditorStatus(step.message, step.code === 'unsupported' ? 'warn' : 'err');
      return false;
    }
    var added = staging.add(step.step);
    if (!added.ok) {
      setEditorStatus(added.message, 'err');
      return false;
    }
    renderStaged();
    setEditorStatus('已加入待保存步骤（共 ' + staging.size() +
      ' 步）。这些步骤**还没有提交**；点「保存为新版本」才作为一次事务发给内核。', 'ok');
    return true;
  }

  /* ---------- 暂存步骤：撤销 / 重做 ---------- */

  function describeOperation(operation) {
    if (!operation) return '未知操作';
    var kind = operation.kind;
    if (kind === 'setToggle') {
      return (TOGGLE_LABEL[operation.property] || operation.property) + '：设为' + (operation.value ? '开启' : '关闭');
    }
    if (kind === 'toggle') return (TOGGLE_LABEL[operation.property] || operation.property) + '：翻转';
    if (kind === 'inherit') return (operation.property || '') + '：恢复继承';
    if (kind === 'unsetValue') return (operation.property || '') + '：取消直接格式';
    if (kind === 'clearDirectFormat') return '清除字符直接格式';
    if (kind === 'clearParagraphFormat') return '清除段落格式';
    /* --- 带值通道（WF-006 字体 / WF-007 字号；由 `edit-intent.js` 产出） --- */
    if (kind === 'setValue') {
      if (operation.property === 'fonts') return '字体：' + JSON.stringify(operation.value);
      if (operation.property === 'size') {
        var size = operation.value || {};
        return '字号：' + (size.kind === 'chinese' ? String(size.name) : String(size.value) + ' pt');
      }
      return '设置值：' + String(operation.property);
    }
    if (kind === 'setAlignment') return '对齐：' + alignmentLabel(operation.alignment);
    if (kind === 'setLineSpacing') return '行距：' + JSON.stringify(operation.lineSpacing);
    if (kind === 'setSpacingBefore' || kind === 'setSpacingAfter') {
      return (kind === 'setSpacingBefore' ? '段前间距：' : '段后间距：') + JSON.stringify(operation.spacing);
    }
    if (kind === 'setFirstLineIndent') return '首行缩进：' + JSON.stringify(operation.indent);
    if (kind === 'setHangingIndent') return '悬挂缩进：' + JSON.stringify(operation.indent);
    if (kind === 'setLeftIndent') return '左缩进：' + JSON.stringify(operation.indent);
    if (kind === 'setRightIndent') return '右缩进：' + JSON.stringify(operation.indent);
    /* --- 列表域（WF-035–044；由 `list-intent.js` 产出） ------------------ */
    if (kind === 'applyList') {
      return (operation.style === 'numbered' ? '编号列表' : '项目符号') +
        '：' + String((typeof operation.level === 'number' ? operation.level : 0) + 1) + ' 级';
    }
    if (kind === 'setListLevel') {
      return '列表级别：' + String((typeof operation.level === 'number' ? operation.level : 0) + 1) + ' 级';
    }
    if (kind === 'restartList') return '重启编号（从 1 重新开始）';
    if (kind === 'removeList') return '取消列表（保留文字）';
    /* --- 节域（WF-045–055；由 `section-intent.js` 产出） ------------------ */
    if (kind === 'setPageSizePreset') return '纸张大小：' + String(operation.preset);
    if (kind === 'setPageSize') return '纸张大小：' + JSON.stringify(operation);
    if (kind === 'setOrientation') {
      return '纸张方向：' + (operation.orientation === 'landscape' ? '横向' : '纵向');
    }
    if (kind === 'setMargins') return '页边距：' + JSON.stringify(operation.margins);
    if (kind === 'setPageNumberFormat') return '页码格式：' + String(operation.format);
    if (kind === 'setPageNumberStart') {
      return operation.start === null ? '页码：接上一节' : '页码：从 ' + String(operation.start) + ' 起';
    }
    if (kind === 'setVerticalAlign') return '页内垂直对齐：' + String(operation.align);
    if (kind === 'setColumnCount') return '栏数：' + String(operation.count);
    return kind;
  }

  /** 步骤的显示后缀：段落步有 `range`（范围表达式），节步有 `label`（作用节标签）。 */
  function stagedScopeText(step) {
    if (step.range !== undefined) return ' · 范围：' + String(step.range);
    if (step.label !== undefined) return ' · 作用：' + String(step.label);
    return '';
  }

  function renderStaged() {
    var list = dom['staged-list'];
    if (!list) return;
    clearNode(list);
    var steps = staging ? staging.steps() : [];
    show(dom['staged-empty'], steps.length === 0);
    for (var i = 0; i < steps.length; i++) {
      var item = el('li', 'staged-item');
      var domain = (ListIntentLib && ListIntentLib.isListStep(steps[i])) ? 'list'
        : (SectionIntentLib && SectionIntentLib.isSectionStep(steps[i])) ? 'section' : 'paragraph';
      item.appendChild(el('span', 'staged-domain',
        domain === 'list' ? '[列表] ' : (domain === 'section' ? '[节] ' : '[段落] ')));
      item.appendChild(el('span', '', describeOperation(steps[i].operation)));
      item.appendChild(el('span', 'staged-range', stagedScopeText(steps[i])));
      list.appendChild(item);
    }
    renderToolbarState();
  }

  function renderToolbarState() {
    var hasRange = !!selectionExpression;
    for (var i = 0; i < toolbarButtons.length; i++) {
      var entry = toolbarButtons[i];
      if (entry.alwaysEnabled) continue;
      if (hasRange) entry.node.removeAttribute('disabled');
      else entry.node.setAttribute('disabled', '');
    }
    if (dom['undo-btn']) {
      if (staging && staging.canUndo()) dom['undo-btn'].removeAttribute('disabled');
      else dom['undo-btn'].setAttribute('disabled', '');
    }
    if (dom['redo-btn']) {
      if (staging && staging.canRedo()) dom['redo-btn'].removeAttribute('disabled');
      else dom['redo-btn'].setAttribute('disabled', '');
    }
    if (dom['save-edit-btn']) {
      if (staging && staging.size() > 0) dom['save-edit-btn'].removeAttribute('disabled');
      else dom['save-edit-btn'].setAttribute('disabled', '');
    }
  }

  /* ---------- 节与页面设置（WF-045–055 的用户入口；WCF-D72） ---------- */

  /** 最近一次列表控件尝试的结果（**只读接缝**；见 `list-intent.js` 的缺口登记）。 */
  var lastListAttempt = null;

  /** 当前预览的节列表（来自**服务端返回的字节**，不是本地编的）。 */
  function previewSections() {
    return (preview && preview.sections && preview.sections.length !== undefined) ? preview.sections : [];
  }

  /** 从下拉框读作用节。`''`（未指定）⇒ `null`，**不默认成全文**。 */
  function sectionScopeFromUi() {
    if (!SectionIntentLib) return null;
    return SectionIntentLib.readScopeFromChoice(readValue('ctl-section-scope', ''));
  }

  function sectionOptionLabel(controlId, value) {
    if (controlId === 'orientation') return value === 'landscape' ? '横向' : '纵向';
    if (controlId === 'pageNumberFormat') {
      var hint = SectionIntentLib.PAGE_NUMBER_FORMAT_HINTS[value];
      return hint ? value + '（' + hint + '）' : value;
    }
    return value;
  }

  function renderSectionSummary(sections) {
    var host = dom['section-summary'];
    if (!host) return;
    clearNode(host);
    if (sections.length === 0) {
      host.appendChild(el('p', 'note note-dim', '这份文档里读不到节（没有 w:sectPr），因此页面设置不可用。'));
      return;
    }
    for (var i = 0; i < sections.length; i++) {
      var line = el('p', 'section-line');
      line.appendChild(el('span', 'section-tag', '第 ' + String(sections[i].number) + ' 节'));
      line.appendChild(el('span', 'section-desc',
        (DocReadLib && DocReadLib.describeSection) ? DocReadLib.describeSection(sections[i]) : ''));
      host.appendChild(line);
    }
  }

  /**
   * 节控件的按钮。
   *
   * **刻意不用 `applyButton` / `quickButton`**：那两个会把节点登记进 `toolbarButtons`，
   * 于是被 `renderToolbarState()` 按"有没有文字选区"统一启用/禁用——而节操作
   * **与选区无关**（它是按节索引寻址的），跟着段落控件的开关走会让"没选中文字就改不了页边距"。
   * 因此这里自己建按钮、自己挂事件，不进那份清单。
   */
  function sectionChoiceButton(id, label, controlId, value) {
    var button = toolButton(id, label);
    button.addEventListener('click', function () { applySectionControl(controlId, value); });
    return button;
  }

  /** 取值要**点的时候**才从界面读的节控件（例如页边距的四个数字框）。 */
  function sectionActionButton(id, label, handler) {
    var button = toolButton(id, label);
    button.addEventListener('click', handler);
    return button;
  }

  function renderSectionPanel() {
    var host = dom['section-toolbar'];
    if (!host) return;
    var previousChoice = readValue('ctl-section-scope', '');
    clearNode(host);
    var sections = previewSections();
    renderSectionSummary(sections);

    if (!SectionIntentLib) {
      setText(dom['section-note'], '页面没有加载节意图模块（section-intent.js），本次不提供页面设置入口。');
      return;
    }
    setText(dom['section-note'],
      '这些控件改的是「作用节」下拉框指定的那一节（或全文）。**没有默认值**：不先选节直接点控件会被拒绝，' +
      '不会替你默认成"改全文"。节操作与文字选区无关；一次「保存」把这一串节操作作为**一次事务**提交，版本号只 +1。');

    var select = toolSelect('ctl-section-scope', SectionIntentLib.scopeOptions(sections.length));
    /* 保留用户当前的选择。节数变了导致原选择不再存在时，退回"未指定"——
       **不替用户改选成另一节**（那正是"指错了节"的来源）。 */
    var keep = false;
    for (var o = 0; o < select.children.length; o++) {
      if (select.children[o].value === previousChoice) keep = true;
    }
    if (keep) select.value = previousChoice;
    host.appendChild(select);

    var group = el('div', 'toolbar-group');
    for (var i = 0; i < SectionIntentLib.CONTROLS.length; i++) {
      var control = SectionIntentLib.CONTROLS[i];
      if (control.input === 'choice') {
        group.appendChild(el('span', 'toolbar-label', control.label));
        for (var v = 0; v < control.values.length; v++) {
          group.appendChild(sectionChoiceButton('ctl-section-' + control.id + '-' + control.values[v],
            sectionOptionLabel(control.id, control.values[v]), control.id, control.values[v]));
        }
        continue;
      }
      if (control.input === 'margins') {
        group.appendChild(el('span', 'toolbar-label', '页边距（四边必给）'));
        var edges = ['top', 'right', 'bottom', 'left'];
        var edgeLabels = { top: '上', right: '右', bottom: '下', left: '左' };
        for (var e = 0; e < edges.length; e++) {
          group.appendChild(el('span', 'toolbar-label', edgeLabels[edges[e]]));
          group.appendChild(toolNumber('ctl-margins-' + edges[e], 2.54));
        }
        group.appendChild(el('span', 'toolbar-label', '装订线'));
        group.appendChild(toolNumber('ctl-margins-gutter', 0));
        group.appendChild(toolSelect('ctl-margins-unit', unitOptions()));
        group.appendChild(sectionActionButton('ctl-section-margins-apply', '页边距：应用', function () {
          applySectionControl('margins', marginsValueFromUi());
        }));
        continue;
      }
      group.appendChild(sectionChoiceButton('ctl-section-' + control.id, control.label, control.id, undefined));
    }
    host.appendChild(group);
  }

  /** 页边距控件的读数（四边 + 可选装订线；单位对四边统一）。 */
  function marginsValueFromUi() {
    return {
      unit: readValue('ctl-margins-unit', 'mm'),
      top: readNumber('ctl-margins-top', 0),
      right: readNumber('ctl-margins-right', 0),
      bottom: readNumber('ctl-margins-bottom', 0),
      left: readNumber('ctl-margins-left', 0),
      gutter: readNumber('ctl-margins-gutter', 0)
    };
  }

  /**
   * 点一个节控件：翻成一步节意图并加入**同一个**暂存栈。
   * 翻不出来（含"未指定作用节"）就如实说明并**不加栈**。
   */
  function applySectionControl(controlId, value) {
    if (!SectionIntentLib || !staging) {
      setEditorStatus('页面缺少节意图模块（section-intent.js），本次不提供页面设置入口。', 'err');
      return false;
    }
    var step = SectionIntentLib.buildStep(sectionScopeFromUi(), controlId, value);
    if (!step.ok) {
      setEditorStatus(step.message, step.code === 'unsupported' ? 'warn' : 'err');
      return false;
    }
    var added = staging.add(step.step);
    if (!added.ok) {
      setEditorStatus(added.message, 'err');
      return false;
    }
    renderStaged();
    setEditorStatus('已加入待保存的节操作（共 ' + staging.size() + ' 步，作用于' +
      (step.step.label || '（未知范围）') + '）。这些步骤**还没有提交**；' +
      '点「保存为新版本」才作为一次事务发给内核。', 'ok');
    return true;
  }

  /* ---------- 列表与编号（WF-035–044 的界面侧；FA-N 已接线） ---------- */

  /**
   * 列表级别控件的读数。
   *
   * 页面上是 **1–9 级**（人话），内核收 **0–8**（`MAX_LIST_LEVEL`）。
   * 换算**只在这里**做一次：两套编号在 1–8 上完全重叠，让下层去猜必然会把
   * "1 级"读成"2 级"。
   */
  function listLevelFromUi() {
    var raw = readNumber('ctl-list-level', 1);
    if (!isFinite(raw)) return 0;
    var oneBased = Math.floor(raw);
    if (oneBased < 1) oneBased = 1;
    if (oneBased > 9) oneBased = 9;
    return oneBased - 1;
  }

  function renderListPanel() {
    var host = dom['list-toolbar'];
    if (!host) return;
    clearNode(host);
    if (!ListIntentLib) {
      setText(dom['list-note'], '页面没有加载列表能力模块（list-intent.js），本次不提供列表入口。');
      return;
    }
    var info = ListIntentLib.gap();
    var available = info.capability === 'available';
    var group = el('div', 'toolbar-group');
    group.appendChild(el('span', 'toolbar-label', '列表 / 编号'));
    for (var i = 0; i < ListIntentLib.CONTROLS.length; i++) {
      (function (control) {
        var button = toolButton(
          'ctl-list-' + control.id,
          available ? control.label : (control.label + '（暂不可用）'),
          available ? '' : 'is-unwired'
        );
        button.addEventListener('click', function () { applyListControl(control.id); });
        group.appendChild(button);
      })(ListIntentLib.CONTROLS[i]);
    }
    if (available) {
      /* 级别只在"能应用列表"时才需要；四个控件里只有前两个用到它。 */
      var levelSelect = toolSelect('ctl-list-level', [
        { value: 1, label: '1 级' }, { value: 2, label: '2 级' }, { value: 3, label: '3 级' },
        { value: 4, label: '4 级' }, { value: 5, label: '5 级' }, { value: 6, label: '6 级' },
        { value: 7, label: '7 级' }, { value: 8, label: '8 级' }, { value: 9, label: '9 级' }
      ]);
      levelSelect.title = '列表级别（1–9 级）';
      group.appendChild(levelSelect);
    }
    host.appendChild(group);
    setText(dom['list-note'],
      (available ? '列表能力**已接通**：' : '列表能力当前不可用：') + info.reason +
      '（能力状态：' + info.capability + '；页面伪造文本前缀：' + String(info.fabricatesTextPrefix) + '）');
  }

  /**
   * 点一个列表控件：翻成一步列表意图并加入**同一个**暂存栈。
   *
   * 翻不出来（含"没有选中范围"）就如实说明并**不加栈、不发请求**。
   * 这里**没有任何写文本的路径**：正文只有在点「保存为新版本」、内核真的发布了新版本之后
   * 才会变——而那条路上写的是 `numPr` 引用，不是 `•` / `1.` 这些字符。
   */
  function applyListControl(controlId) {
    if (!ListIntentLib || !staging) {
      setEditorStatus('页面缺少列表能力模块（list-intent.js），本次不提供列表入口。', 'err');
      lastListAttempt = { controlId: controlId, ok: false, code: 'no_module', showsSuccess: false };
      return false;
    }
    var built = ListIntentLib.buildStep(selectionExpression, controlId, listLevelFromUi());
    lastListAttempt = {
      controlId: controlId,
      ok: built.ok === true,
      code: built.code || null,
      showsSuccess: false,
      stagedSize: staging.size(),
      message: built.message || ''
    };
    if (!built.ok) {
      setEditorStatus(built.message, built.code === 'unsupported' ? 'warn' : 'err');
      return false;
    }
    var added = staging.add(built.step);
    if (!added.ok) {
      setEditorStatus(added.message, 'err');
      return false;
    }
    lastListAttempt.stagedSize = staging.size();
    renderStaged();
    setEditorStatus('已加入待保存的列表操作（共 ' + staging.size() + ' 步，作用于' +
      built.step.range + '）。这些步骤**还没有提交**；点「保存为新版本」才作为一次事务发给内核' +
      '（内核写的是结构化列表引用，**不会**在正文里塞符号）。', 'ok');
    return true;
  }

  /* ---------- 保存（一次事务）与版本 ---------- */

  function saveEdit() {
    setEditorError('');
    if (!EditIntentLib || !staging) {
      setEditorStatus(editorUnavailableReason(), 'err');
      return;
    }
    if (!session) {
      setEditorStatus('还没有导入文档：请先在上面选择一份 .docx 并导入。', 'err');
      return;
    }
    var steps = staging.steps();
    if (steps.length === 0) {
      setEditorStatus('还没有待保存的步骤；先选中文字并点格式控件，或用上面的节控件加一条节操作。', 'err');
      return;
    }
    if (steps.length > EditIntentLib.MAX_STEPS_PER_INTENT) {
      setEditorStatus('一次最多提交 ' + EditIntentLib.MAX_STEPS_PER_INTENT + ' 步，请先拆成两次保存。', 'err');
      return;
    }

    var paragraphSteps = [];
    var sectionSteps = [];
    var listSteps = [];
    for (var s = 0; s < steps.length; s++) {
      if (ListIntentLib && ListIntentLib.isListStep(steps[s])) listSteps.push(steps[s]);
      else if (SectionIntentLib && SectionIntentLib.isSectionStep(steps[s])) sectionSteps.push(steps[s]);
      else paragraphSteps.push(steps[s]);
    }
    var kinds = [];
    if (paragraphSteps.length > 0) kinds.push('段落格式（' + paragraphSteps.length + ' 步）');
    if (sectionSteps.length > 0) kinds.push('节操作（' + sectionSteps.length + ' 步）');
    if (listSteps.length > 0) kinds.push('列表 / 编号（' + listSteps.length + ' 步）');
    if (kinds.length > 1) {
      /* 服务端 `/edits` 的 `intent` / `sectionIntent` / `listIntent` 是**三选一**（同时给 = 400）。
         与其悄悄拆成两次版本（那会破坏"一次用户指令 = 一次 revision"），不如拒绝并说明。 */
      setEditorStatus('待保存的步骤里同时有' + kinds.join('、') +
        '：内核的 /edits 一次只接受一种意图（intent / sectionIntent / listIntent 三选一），' +
        '合并提交会被拒。请先撤销其中一类，或分两次保存（那会是两次提交、两个版本）。', 'err');
      return;
    }

    var body = {
      idempotencyKey: EditIntentLib.newKey('edit'),
      baseRevision: session.editRevision,
      baseDigest: session.contentDigest
    };
    if (listSteps.length > 0) {
      body.listIntent = ListIntentLib.toListIntent(listSteps);
    } else if (sectionSteps.length > 0) {
      body.sectionIntent = SectionIntentLib.toSectionIntent(sectionSteps);
    } else {
      body.intent = EditIntentLib.toIntent(paragraphSteps);
    }
    setEditorStatus('正在提交到电脑服务…', '');
    if (dom['save-edit-btn']) dom['save-edit-btn'].setAttribute('disabled', '');

    request('POST', ROUTES.sessionEdits(session.sessionId), body, 60000)
      .then(function (res) {
        lastVerdict = EditIntentLib.classifyEditResponse(res.status, res.data);
        applyEditVerdict(lastVerdict);
      })
      ['catch'](function () {
        lastVerdict = {
          kind: 'failed', showsSuccess: false, keepsStaged: true, retryable: true,
          code: 'network',
          message: '连不上电脑服务，这次提交没有送达。',
          note: '本次没有确认改动生效；待保存的步骤仍在页面上。'
        };
        applyEditVerdict(lastVerdict);
      })
      .then(function () {
        if (dom['save-edit-btn'] && staging && staging.size() > 0) {
          dom['save-edit-btn'].removeAttribute('disabled');
        }
      });
  }

  function applyEditVerdict(verdict) {
    if (verdict.kind === 'applied') {
      if (typeof verdict.editRevision === 'number') session.editRevision = verdict.editRevision;
      if (verdict.version) {
        versionEntry = verdict.version;
        if (verdict.version.contentDigest) session.contentDigest = String(verdict.version.contentDigest);
        sessionVersions = sessionVersions.concat([verdict.version]);
      }
      staging.clear();
      renderStaged();
      renderSessionIdentity();
      renderVersions();
      var report = EditIntentLib.describeReports(verdict.reports);
      setEditorStatus('电脑端已发布新版本（第 ' + session.editRevision + ' 版）。' +
        (report ? ' ' + report : ''), 'ok');
      refreshPreviewFromServer();
      return;
    }
    if (verdict.kind === 'conflict') {
      setEditorStatus(verdict.note +
        (verdict.currentRevision === null ? '' : '（电脑端当前版本：第 ' + verdict.currentRevision + ' 版）'),
        'err');
      refreshSessionState();
      return;
    }
    if (verdict.kind === 'replayed') {
      setEditorStatus(verdict.message, 'warn');
      staging.clear();
      renderStaged();
      refreshSessionState();
      return;
    }
    if (verdict.kind === 'no_op') {
      setEditorStatus(verdict.message, 'warn');
      refreshSessionState();
      return;
    }
    setEditorStatus((verdict.note ? verdict.note + ' ' : '') + verdict.message +
      (verdict.code ? '（' + verdict.code + '）' : ''), 'err');
  }

  function refreshPreviewFromServer() {
    if (!session) return;
    var revision = (versionEntry && typeof versionEntry.editRevision === 'number')
      ? versionEntry.editRevision
      : session.editRevision;
    fetch(ROUTES.sessionVersion(session.sessionId, revision), { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('电脑服务返回 HTTP ' + resp.status);
        return resp.arrayBuffer();
      })
      .then(function (buf) {
        return loadPreviewFromBytes(new Uint8Array(buf));
      })
      ['catch'](function () {
        setEditorStatus('新版本已发布，但页面没能取回它做预览；可点下面的「下载最新版本」取回。', 'warn');
      });
  }

  function refreshSessionState() {
    if (!session) return;
    request('GET', ROUTES.session(session.sessionId), null, 12000)
      .then(function (res) {
        if (!res.ok || !res.data || typeof res.data !== 'object') return;
        if (typeof res.data.editRevision === 'number') session.editRevision = res.data.editRevision;
        if (res.data.contentDigest) session.contentDigest = String(res.data.contentDigest);
        if (res.data.currentVersion) versionEntry = res.data.currentVersion;
        if (Array.isArray(res.data.versions)) sessionVersions = res.data.versions;
        renderSessionIdentity();
        renderVersions();
      })
      ['catch'](function () {
        /* 取不到就不更新：界面上的数字仍是上一次服务端给的值，不猜、不编。 */
      });
  }

  function renderVersions() {
    var list = dom['version-list'];
    if (!list) return;
    clearNode(list);
    show(dom['version-panel'], sessionVersions.length > 0 || versionEntry !== null);
    for (var i = 0; i < sessionVersions.length; i++) {
      var entry = sessionVersions[i];
      var item = el('li', 'kv-item');
      item.appendChild(el('span', 'kv-key', '第 ' + entry.editRevision + ' 版'));
      item.appendChild(el('span', 'kv-val kv-mono kv-break',
        entry.contentDigest ? String(entry.contentDigest).slice(0, 16) + '…（' + entry.byteLength + ' 字节）' : ''));
      list.appendChild(item);
    }
    if (sessionVersions.length === 0) {
      list.appendChild(el('li', 'kv-item', '还没有已保存的新版本。'));
    }
  }

  function downloadSessionVersion() {
    if (!session || !versionEntry) {
      setVersionDownloadStatus('还没有可下载的已发布版本。', 'err');
      return;
    }
    var revision = typeof versionEntry.editRevision === 'number' ? versionEntry.editRevision : session.editRevision;
    setVersionDownloadStatus('正在从电脑取回新版本…', '');
    if (dom['download-version-btn']) dom['download-version-btn'].setAttribute('disabled', '');

    fetch(ROUTES.sessionVersion(session.sessionId, revision), { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('电脑服务返回 HTTP ' + resp.status);
        return resp.arrayBuffer();
      })
      .then(function (buf) {
        /* 与任务产物下载**共用**同一条核对流程：未算出摘要就不会发布 download_verified。 */
        return verifyAndSaveBytes(new Uint8Array(buf), {
          artifactId: versionEntry.artifactId ? String(versionEntry.artifactId)
            : ('session-' + session.sessionId + '-v' + revision),
          filename: session.filename || 'document.docx',
          mimeType: DOCX_MIME,
          sha256: versionEntry.contentDigest ? String(versionEntry.contentDigest) : null,
          byteLength: typeof versionEntry.byteLength === 'number' ? versionEntry.byteLength : null
        }, setVersionDownloadStatus);
      })
      ['catch'](function (err) {
        setVersionDownloadStatus((err && err.message ? err.message : '取回新版本失败。') +
          ' 没有保存任何文件。', 'err');
      })
      .then(function () {
        if (dom['download-version-btn']) dom['download-version-btn'].removeAttribute('disabled');
      });
  }

  /* ===================== 连续对话界面（APP-02 / CHAT-01–03 界面侧） ===================== */

  var MSG_STATE_LABEL = {
    sending: '发送中',
    received: '已接收',
    failed: '失败',
    cancelled: '已取消',
    pending: '等待回复',
    streaming: '回复中（增量）',
    /* 服务端的**业务完成**态（R209 的五态之一）：与「已接收」是两回事，
       所以界面必须给它一个自己的说法，而不是让它裸着显示成 `completed`。 */
    completed: '业务完成'
  };

  var ROLE_LABEL = { user: '我', assistant: '助手', system: '系统' };

  function setConvNote(text) { setText(dom['conv-note'], text); }

  function sessionName(id) {
    if (!conversation) return '（未知会话）';
    var sessions = conversation.sessions(true);
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === id) return sessions[i].name;
    }
    return '（未知会话）';
  }

  /** 取当前会话；没有就在本机新建一个（首条消息前不产生网络请求）。 */
  function ensureSession() {
    if (!conversation) return null;
    var sid = conversation.current();
    if (sid) return sid;
    var created = conversation.createSession();
    return created ? created.id : null;
  }

  function renderConversation() {
    if (!conversation) {
      setViewState('conversation', 'failure', '页面没有加载会话模块（conversation-store.js），本次不提供对话入口。');
      return;
    }
    var sid = conversation.current();
    setText(dom['conv-session-name'], sid ? sessionName(sid) : '（还没有会话，发第一条消息时会自动新建）');

    var list = dom['conv-messages'];
    if (list) {
      clearNode(list);
      var messages = sid ? conversation.messages(sid) : [];
      if (messages.length === 0) {
        list.appendChild(el('li', 'conv-empty',
          '还没有消息。写下你的目标，或追问、补充资料、指代当前文件。'));
      }
      for (var i = 0; i < messages.length; i++) list.appendChild(conversationItem(messages[i]));
    }

    if (offlineNow) {
      setViewState('conversation', 'offline', '当前离线：新消息不会送达；已发送但未定局的消息可在恢复后重试或从上次位置续取。');
    } else if (!chatBackendReady()) {
      setViewState('conversation', 'blank',
        '对话后端未接入（由 B 流的会话/后台内核提供）。界面与状态机已就绪；现在发送会**如实标为「失败 / 未送达」**，不会伪造回复。');
    } else {
      setViewState('conversation', 'ready', '');
    }
    renderResumeNote();
    updateSendability();
  }

  function conversationItem(message) {
    var item = el('li', 'conv-msg conv-' + message.role + ' conv-state-' + message.state);
    item.setAttribute('data-message-id', message.id);
    item.setAttribute('data-state', message.state);
    item.appendChild(el('p', 'conv-text', message.text));
    item.appendChild(el('p', 'conv-meta',
      (ROLE_LABEL[message.role] || message.role) + ' · ' +
      (MSG_STATE_LABEL[message.state] || message.state) + ' · #' + message.seq));
    if (message.role === 'user' && message.state === 'received') {
      item.appendChild(el('p', 'conv-note', '已接收 ≠ 业务完成：这只表示对话后端收下了这条消息。'));
    }
    if (message.error && message.error.message) {
      item.appendChild(el('p', 'conv-error', message.error.message));
    }
    if (message.state === 'failed' || message.state === 'cancelled') {
      var retry = el('button', 'btn btn-secondary btn-small conv-retry');
      retry.type = 'button';
      retry.setAttribute('data-retry-id', message.id);
      setText(retry, '重试这条（复用同一条消息，不新建任务）');
      item.appendChild(retry);
    }
    return item;
  }

  function renderResumeNote() {
    if (!conversation) return;
    var note = dom['conv-resume-note'];
    var button = dom['conv-resume-btn'];
    if (!note || !button) return;
    var sid = conversation.current();
    if (!sid) { setText(note, ''); show(button, false); return; }
    var info = conversation.resumable(sid);
    var hasUnfinished = info.cursor !== null || info.pending.length > 0;
    if (!hasUnfinished) {
      setText(note, '本会话没有未定局的消息，也没有续取游标。');
      show(button, false);
      return;
    }
    show(button, true);
    setText(note,
      (info.cursor !== null ? ('上次续取位置：' + info.cursor + '。') : '还没有续取游标。') +
      (info.pending.length > 0 ? ('有 ' + info.pending.length + ' 条消息尚未定局。') : ''));
  }

  function sendMessage() {
    if (!conversation) return;
    var input = dom['conv-input'];
    var text = input ? trimText(input.value) : '';
    if (!text) { setConvNote('请先写下要说的话。'); return; }
    if (offlineNow) {
      setConvNote('当前处于离线状态：这条消息没有发送。恢复网络后可再点发送。');
      setViewState('conversation', 'offline', '当前离线：消息不会送达。');
      return;
    }

    var sid = ensureSession();
    if (!sid) { setConvNote('本机没有可用的会话。'); return; }
    var message = conversation.appendMessage(sid, {
      role: 'user', text: text, state: conversation.SEND_STATES.SENDING
    });
    if (input) input.value = '';
    renderConversation();
    setConvNote('正在发送…');

    if (!chatBackendReady()) {
      conversation.updateMessage(sid, message.id, {
        state: conversation.SEND_STATES.FAILED,
        error: { code: 'backend_unavailable', message: '对话后端未接入（由 B 流提供）：这条消息没有送达，也不会被执行。', retryable: true }
      });
      renderConversation();
      setConvNote('对话后端未接入：消息留在本机并标为「失败」，接入后可用「重试这条」再发。');
      return;
    }
    dispatchSend(sid, message, text);
  }

  /** 真正把一条用户消息交给可选注入的对话后端；结果只按 classifySendOutcome 归位。 */
  function dispatchSend(sessionId, message, text) {
    var transport = chatTransport();
    transport.send({ sessionId: sessionId, clientId: message.clientId, text: text })
      .then(function (res) {
        var verdict = conversation.classifySendOutcome(res);
        conversation.updateMessage(sessionId, message.id, {
          state: verdict.state, error: verdict.error,
          cursor: verdict.cursor === null ? undefined : verdict.cursor
        });
        renderConversation();
        setConvNote(verdict.state === conversation.SEND_STATES.RECEIVED
          ? '对话后端已接收这条消息（已接收不等于业务完成）。'
          : ('发送失败：' + ((verdict.error && verdict.error.message) || '后端未给出原因')));
      })
      ['catch'](function () {
        conversation.updateMessage(sessionId, message.id, {
          state: conversation.SEND_STATES.FAILED,
          error: { code: 'network', message: '没有连上对话后端，这条消息没有送达。', retryable: true }
        });
        renderConversation();
        setConvNote('发送失败：没有连上对话后端。');
      });
  }

  /**
   * 重试一条失败/已取消的消息。**复用同一条消息与幂等键**（R207）：
   * 不新建消息、不新建任务。未接入后端时立刻回到「失败」并说明原因——不留在假「发送中」。
   */
  function retryMessageById(messageId) {
    if (!conversation) return;
    var sid = conversation.current();
    if (!sid) return;
    var result = conversation.retryMessage(sid, messageId);
    if (!result.ok) { setConvNote('这条消息当前不能重试（' + result.code + '）。'); return; }
    renderConversation();

    if (chatBackendReady() && !offlineNow) {
      setConvNote('已按同一条消息重新发送（复用同一幂等键，不会新建任务）。');
      dispatchSend(sid, result.message, result.message.text);
      return;
    }
    conversation.updateMessage(sid, messageId, {
      state: conversation.SEND_STATES.FAILED,
      error: {
        code: offlineNow ? 'offline' : 'backend_unavailable',
        message: offlineNow ? '当前离线：这条消息仍未送达。'
          : '对话后端未接入（由 B 流提供）：这条消息仍未送达。',
        retryable: true
      }
    });
    renderConversation();
    setConvNote(offlineNow ? '当前离线，重试没有发出。' : '对话后端未接入，重试没有发出。');
  }

  function resumeConversation() {
    if (!conversation) return;
    var sid = conversation.current();
    if (!sid) return;
    var info = conversation.resumable(sid);
    var transport = chatTransport();
    if (!chatBackendReady() || !transport || typeof transport.resume !== 'function') {
      setConvNote('续取接口未接入（由 B 流提供）：本页不会假装已经从断点继续，也不会重放已消费内容。');
      return;
    }
    setConvNote('正在从上次位置续取…');
    transport.resume({
      sessionId: sid,
      cursor: info.cursor,
      onEvent: function (event) { applyResumeEvent(sid, event); }
    }).then(function (res) {
      if (res && res.ok === true) setConvNote('续取完成。');
      else setConvNote('续取失败：' + ((res && res.error && res.error.message) || '后端未给出原因') +
        '；本次没有重放已消费内容。');
      renderConversation();
    })['catch'](function () {
      setConvNote('续取失败：没有连上对话后端。');
    });
  }

  /** 续取事件：只做状态归位；游标**只在后端明确给出时**前移。 */
  function applyResumeEvent(sessionId, event) {
    if (!conversation || !event) return;
    if (typeof event.cursor === 'string' && event.cursor !== '') {
      conversation.setResumeCursor(sessionId, event.cursor);
    }
    if (event.messageId && event.state) {
      var existing = conversation.getMessage(sessionId, event.messageId);
      if (existing) {
        conversation.updateMessage(sessionId, event.messageId, {
          state: event.state,
          text: typeof event.text === 'string' ? event.text : undefined
        });
      } else if (typeof event.text === 'string' && event.text !== '') {
        conversation.appendMessage(sessionId, {
          id: event.messageId, role: 'assistant', text: event.text, state: event.state
        });
      }
    }
    renderConversation();
  }

  /* ===================== 会话列表（CHAT-02） ===================== */

  /**
   * 「服务端为准」模式：接上了对话后端（`PotbotChatTransport.available`）时，
   * 会话清单与生命周期一律走电脑端；否则退回本机存储（接线前的老行为）。
   *
   * 为什么看后端而不是看一次请求的成败：一次 GET 失败可能是瞬时网络问题，
   * 不该据此把整个列表降级成本地而**悄悄**不再同步。
   */
  function serverSessionMode() {
    return chatBackendReady();
  }

  function encodeIdent(value) {
    return encodeURIComponent(String(value));
  }

  function currentSessionId() {
    return conversation ? conversation.current() : '';
  }

  function sessButton(label, action, id) {
    var button = el('button', 'btn btn-ghost btn-small');
    button.type = 'button';
    button.setAttribute('data-action', action);
    button.setAttribute('data-session-id', id);
    setText(button, label);
    return button;
  }

  /** 服务端摘要 → 统一的列表行模型（**只搬运响应里真实有的字段**）。 */
  function serverRow(record) {
    var count = typeof record.messageCount === 'number' ? record.messageCount : 0;
    return {
      id: String(record.conversationId),
      name: typeof record.name === 'string' ? record.name : String(record.conversationId),
      archived: record.archived === true,
      meta: count + ' 条消息 · ' + formatTime(record.updatedAt)
    };
  }

  /** 本机会话 → 统一的列表行模型。 */
  function localRow(session) {
    return {
      id: session.id,
      name: session.name,
      archived: session.archived === true,
      meta: session.messages.length + ' 条消息 · ' + formatTime(session.updatedAt)
    };
  }

  /** 当前要渲染的行：服务端模式读服务端清单；本机模式读本机存储（含本机搜索筛选）。 */
  function sessionRows() {
    if (serverSessionMode()) {
      if (!remoteSessionsReady || !remoteSessions) return [];
      var out = [];
      for (var i = 0; i < remoteSessions.length; i++) out.push(serverRow(remoteSessions[i]));
      return out;
    }
    if (!conversation) return [];
    var sessions = conversation.sessions(showArchived);
    var rows = [];
    var needle = sessionQuery === '' ? '' : sessionQuery.toLowerCase();
    for (var j = 0; j < sessions.length; j++) {
      var row = localRow(sessions[j]);
      if (needle === '' || row.name.toLowerCase().indexOf(needle) >= 0) rows.push(row);
    }
    return rows;
  }

  /** 某个会话当前显示的名字（服务端模式下以服务端清单为准）。 */
  function sessionNameOf(id) {
    var rows = sessionRows();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === id) return rows[i].name;
    }
    if (conversation) {
      var sessions = conversation.sessions(true);
      for (var j = 0; j < sessions.length; j++) {
        if (sessions[j].id === id) return sessions[j].name;
      }
    }
    return '（未知会话）';
  }

  /** 列表接口的路径：搜索走 `?q=`，显示归档走 `?include_archived=true`（空搜索词**不**发 `q`）。 */
  function sessionsListPath() {
    var params = [];
    if (sessionQuery !== '') params.push('q=' + encodeIdent(sessionQuery));
    if (showArchived) params.push('include_archived=true');
    return '/api/conversations' + (params.length > 0 ? '?' + params.join('&') : '');
  }

  /**
   * 重新读服务端会话清单并渲染。**这是"服务端为准"的唯一入口**：
   * 写操作成功之后也走它，而不是在本地改一份再等下一次刷新。
   *
   * @returns {Promise<{ok:boolean, mode:string, count?:number, error?:object}>}
   */
  function reloadSessions() {
    if (!serverSessionMode()) {
      renderSessions();
      return Promise.resolve({ ok: true, mode: 'local' });
    }
    setViewState('sessions', 'loading', '正在从电脑端读取会话列表…');
    return request('GET', sessionsListPath()).then(function (res) {
      if (res.ok && res.data && Object.prototype.toString.call(res.data.conversations) === '[object Array]') {
        remoteSessions = res.data.conversations;
        remoteSessionsReady = true;
        remoteSessionsError = null;
        renderSessions();
        return { ok: true, mode: 'server', count: remoteSessions.length };
      }
      remoteSessionsError = describeHttpError(res);
      remoteSessionsReady = false;
      remoteSessions = null;
      renderSessions();
      return { ok: false, mode: 'server', error: remoteSessionsError };
    }, function () {
      remoteSessionsError = { code: 'network', message: '没有连上电脑服务，读不到会话列表。', retryable: true };
      remoteSessionsReady = false;
      remoteSessions = null;
      renderSessions();
      return { ok: false, mode: 'server', error: remoteSessionsError };
    });
  }

  function renderSessions() {
    if (!conversation && !serverSessionMode()) {
      setViewState('sessions', 'failure', '页面没有加载会话模块（conversation-store.js）。');
      return;
    }
    var list = dom['sess-list'];
    if (!list) return;
    var rows = sessionRows();
    clearNode(list);

    if (serverSessionMode() && !remoteSessionsReady) {
      setViewState('sessions', 'failure',
        '读不到电脑端的会话列表：' + (remoteSessionsError ? remoteSessionsError.message : '原因未知') +
        '（下面的列表是空的，**不代表一条会话都没有**）。');
    } else if (rows.length === 0) {
      setViewState('sessions', 'blank', sessionQuery !== ''
        ? ('没有会话匹配「' + sessionQuery + '」。')
        : '还没有任何会话。点上面的「新建会话」开始。');
    } else {
      setViewState('sessions', 'ready', '');
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var item = el('li', 'sess-item' +
        (row.id === currentSessionId() ? ' is-active' : '') +
        (row.id === sessSelectedId ? ' is-selected' : ''));
      item.setAttribute('data-session-id', row.id);
      item.appendChild(el('span', 'sess-name', row.name + (row.archived ? '（已归档）' : '')));
      item.appendChild(el('span', 'sess-meta', row.meta));
      var actions = el('div', 'sess-actions');
      actions.appendChild(sessButton('切换', 'select', row.id));
      actions.appendChild(sessButton('重命名', 'rename', row.id));
      actions.appendChild(sessButton(row.archived ? '取消归档' : '归档', 'archive', row.id));
      actions.appendChild(sessButton('删除', 'delete', row.id));
      item.appendChild(actions);
      list.appendChild(item);
    }

    if (dom['sess-search-note']) {
      if (serverSessionMode()) {
        if (!remoteSessionsReady) setText(dom['sess-search-note'], '');
        else if (sessionQuery !== '') {
          setText(dom['sess-search-note'],
            '在电脑端的会话里找到 ' + rows.length + ' 条匹配「' + sessionQuery + '」' +
            (showArchived ? '（含已归档）' : '') + '。');
        } else {
          setText(dom['sess-search-note'],
            '共 ' + rows.length + ' 条会话（来自电脑端' + (showArchived ? '，含已归档' : '') + '）。');
        }
      } else if (sessionQuery !== '') {
        setText(dom['sess-search-note'], '在本机会话里找到 ' + rows.length + ' 条匹配「' + sessionQuery + '」。');
      } else {
        setText(dom['sess-search-note'], '');
      }
    }
  }

  /**
   * 会话写操作（改名 / 归档 / 删除 / 新建）的**统一收尾**：
   * 成功 ⇒ 重新读服务端清单核对；失败 ⇒ 给人话、**不动列表**（服务端状态没变就不假装变了）。
   */
  function runSessionWrite(options) {
    if (sessionBusy) {
      setText(dom['sess-note'], '上一个会话操作还在进行中，请稍候。');
      return Promise.resolve({ ok: false, code: 'busy' });
    }
    sessionBusy = true;
    setText(dom['sess-note'], options.label + '中…');
    return request(options.method, options.path, options.body).then(function (res) {
      sessionBusy = false;
      if (!res.ok) {
        var info = describeHttpError(res);
        info.status = res.status;
        var failed = { ok: false, code: info.code, status: res.status, error: info };
        /* 「这条会话在电脑端已经不在了」⇒ 光说一句不够：清单得**真重新读回**，
           那条过期的行才会从这里消失（否则那句正文自己就是假的）。 */
        if (info.code === 'conversation_not_found') {
          return reloadSessions().then(function () {
            setText(dom['sess-note'], sessionWriteErrorText(options, info));
            return failed;
          });
        }
        setText(dom['sess-note'], sessionWriteErrorText(options, info));
        renderSessions();
        return failed;
      }
      var data = res.data || {};
      if (typeof options.afterOk === 'function') options.afterOk(data);
      /* **服务端已确认**之后才重新读回清单：列表由服务端说话。 */
      return reloadSessions().then(function () {
        setText(dom['sess-note'], options.successText(data));
        renderConversation();
        return { ok: true, status: res.status, data: data };
      });
    }, function () {
      sessionBusy = false;
      setText(dom['sess-note'], '没有连上电脑服务，这次「' + options.label +
        '」没有生效（服务端状态没有变）。');
      renderSessions();
      return { ok: false, code: 'network' };
    });
  }

  /**
   * 写失败的**人话**。后端码只用来选句子，**不进正文**：
   * 404（会话不在）/ 400（请求形状）/ 422（值被业务规则拒）/ 网络失败各有各的说法。
   */
  function sessionWriteErrorText(options, info) {
    var who = options.who ? ('「' + options.who + '」') : '这条会话';
    if (info.code === 'conversation_not_found') {
      return who + '在电脑端已经不存在了（可能已在别处被删除）；列表已按服务端重新读取。';
    }
    if (info.code === 'empty_name') return '名字不能为空，这次改名没有生效。';
    if (info.code === 'invalid_name') return '这次改名没有生效：请给出一个非空的名字。';
    if (info.code === 'invalid_archived') return '这次归档没有生效：电脑端只接受布尔值。';
    if (info.code === 'empty_query' || info.code === 'invalid_query') return '搜索词不合法：换一个关键词再搜。';
    if (info.code === 'network') return '没有连上电脑服务，这次操作没有生效（服务端状态没有变）。';
    return '电脑服务拒绝了这次「' + options.label + '」（HTTP ' + String(info.status || '?') +
      '）；服务端状态没有变' + (info.retryable === true ? '，可以重试。' : '。');
  }

  function selectSessionById(id) {
    sessSelectedId = id;
    var switched = conversation ? conversation.selectSession(id) : false;
    renderSessions(); renderConversation();
    if (switched) setText(dom['sess-note'], '已切换到「' + sessionNameOf(id) + '」。');
    else setText(dom['sess-note'], '已选中「' + sessionNameOf(id) +
      '」；它本机的消息不在本页（本页只同步电脑端的会话清单），发新消息时会从这个会话继续。');
  }

  function createSessionNow() {
    if (!conversation) {
      setText(dom['sess-note'], '页面没有加载会话模块（conversation-store.js），本次不建会话。');
      return Promise.resolve({ ok: false, code: 'no_conversation_module' });
    }
    var created = conversation.createSession();
    renderSessions(); renderConversation();
    if (!serverSessionMode() || !created) {
      setText(dom['sess-note'], '已新建会话：' + (created ? created.name : '') + '。');
      return Promise.resolve({ ok: true, mode: 'local' });
    }
    /* 服务端模式：把本机这次建的会话**同一个 id** 落到电脑端（发消息时服务端也会按这个 id 认领，
       这里先建只是让它在清单里立刻可见）。失败时如实说明"还没同步"，不假装成了。 */
    return runSessionWrite({
      kind: 'create', label: '新建会话', who: created.name, method: 'POST',
      path: '/api/conversations',
      body: { conversationId: created.id, name: created.name },
      successText: function () { return '已新建会话「' + created.name + '」（电脑端已确认）。'; }
    }).then(function (out) {
      if (!out.ok) {
        setText(dom['sess-note'], '新建会话在电脑端没有建成功；本机已经有一个「' + created.name +
          '」，你发出的第一条消息会把它同步到电脑端。');
      }
      return out;
    });
  }

  function onSessionListClick(ev) {
    if (!conversation) return;
    var node = ev.target;
    while (node && node !== dom['sess-list'] && !(node.getAttribute && node.getAttribute('data-action'))) {
      node = node.parentNode;
    }
    if (!node || !node.getAttribute) return;
    var action = node.getAttribute('data-action');
    var id = node.getAttribute('data-session-id');
    if (!action || !id) return;

    if (action === 'select') {
      selectSessionById(id);
      return;
    }
    if (action === 'rename') {
      sessSelectedId = id;
      renderSessions();
      var input = dom['sess-rename-input'];
      if (input && typeof input.focus === 'function') input.focus();
      setText(dom['sess-note'], '已选中「' + sessionNameOf(id) + '」；在上面输入新名字后点「应用改名」。');
      return;
    }
    if (action === 'archive') {
      sessSelectedId = id;
      var rows = sessionRows();
      var archived = false;
      for (var i = 0; i < rows.length; i++) if (rows[i].id === id) archived = rows[i].archived;
      archiveSessionById(id, !archived);
      return;
    }
    if (action === 'delete') {
      sessSelectedId = id;
      deleteSessionById(id);
    }
  }

  function archiveSessionById(id, archived) {
    var who = sessionNameOf(id);
    if (serverSessionMode()) {
      return runSessionWrite({
        kind: 'archive', label: archived ? '归档' : '取消归档', who: who, method: 'POST',
        path: '/api/conversations/' + encodeIdent(id) + '/archive',
        body: { archived: archived },
        successText: function () {
          return (archived ? '已归档「' : '已取消归档「') + who + '」（电脑端已确认）。' +
            (archived && !showArchived ? '默认列表不再显示它，勾选「显示已归档」可以找回。' : '');
        }
      });
    }
    conversation.archiveSession(id, archived);
    renderSessions(); renderConversation();
    setText(dom['sess-note'], (archived ? '已归档「' : '已取消归档「') + who + '」。');
    return Promise.resolve({ ok: true, mode: 'local' });
  }

  function deleteSessionById(id) {
    var who = sessionNameOf(id);
    if (serverSessionMode()) {
      return runSessionWrite({
        kind: 'delete', label: '删除', who: who, method: 'DELETE',
        path: '/api/conversations/' + encodeIdent(id), body: undefined,
        /* 服务端确认删除之后，才把本机那份对话记录一并清掉（镜像，不是先行）。 */
        afterOk: function () {
          if (conversation) {
            var local = conversation.sessions(true);
            for (var i = 0; i < local.length; i++) {
              if (local[i].id === id) { conversation.deleteSession(id); break; }
            }
          }
          if (sessSelectedId === id) sessSelectedId = '';
        },
        successText: function (data) {
          var detached = (data && Object.prototype.toString.call(data.detached_tasks) === '[object Array]')
            ? data.detached_tasks.length : 0;
          return '已从电脑端删除会话「' + who + '」（已重新读取列表核对）。' +
            '**这不清掉电脑上已生成的文件，也不撤销任何已经发生的外部动作**' +
            (detached > 0 ? ('；有 ' + detached + ' 个任务没有被取消，仍留在任务账本里。') : '。');
        }
      });
    }
    conversation.deleteSession(id);
    renderSessions(); renderConversation();
    setText(dom['sess-note'], '已删除会话「' + who + '」的本机记录。' +
      '**这不影响电脑上已生成的文件，也不撤销任何已经发生的外部动作。**');
    return Promise.resolve({ ok: true, mode: 'local' });
  }

  function renameCurrentSession() {
    if (!conversation) return Promise.resolve({ ok: false, code: 'no_conversation_module' });
    var id = sessSelectedId || currentSessionId();
    if (!id) {
      setText(dom['sess-note'], '还没有选中的会话：先在列表里点「重命名」选一个。');
      return Promise.resolve({ ok: false, code: 'no_session' });
    }
    var input = dom['sess-rename-input'];
    var name = trimText(input ? input.value : '');
    if (name === '') {
      setText(dom['sess-note'], '名字不能为空。');
      return Promise.resolve({ ok: false, code: 'empty_name' });
    }
    if (serverSessionMode()) {
      return runSessionWrite({
        kind: 'rename', label: '改名', who: sessionNameOf(id), method: 'PATCH',
        path: '/api/conversations/' + encodeIdent(id), body: { name: name },
        successText: function (data) {
          if (input) input.value = '';
          return '已改名为「' + String(data.name || name) + '」（电脑端已确认，列表已重新读取）。';
        }
      });
    }
    var result = conversation.renameSession(id, name);
    if (!result.ok) {
      setText(dom['sess-note'], result.code === 'empty_name' ? '名字不能为空。' : '重命名失败。');
      return Promise.resolve({ ok: false, code: result.code });
    }
    if (input) input.value = '';
    renderSessions(); renderConversation();
    setText(dom['sess-note'], '已重命名为「' + result.session.name + '」。');
    return Promise.resolve({ ok: true, mode: 'local' });
  }

  /** 会话搜索：搜索词进 `GET /api/conversations?q=`（服务端模式），或筛本机清单。 */
  function applySessionSearch() {
    var input = dom['sess-search'];
    sessionQuery = input ? trimText(input.value) : '';
    sessSelectedId = '';
    return reloadSessions();
  }

  function toggleShowArchived() {
    var box = dom['sess-show-archived'];
    showArchived = !!(box && box.checked === true);
    return reloadSessions();
  }

  /* ===================== 任务 / 文件 / 设置视图（APP-04 / APP-07） ===================== */

  /**
   * 把本机任务记录翻成可搜索、可操作的条目。**只搬运记录里**真实有的字段：
   * 文件名取自当前任务的服务端回执，历史版本只取记录里真实存在的 `versions` 数组——
   * 没有就是空，不按版本号凭空造出来。
   */
  function taskEntries() {
    var out = [];
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var artifact = (taskState && activeRequestId === rec.requestId) ? currentArtifact() : null;
      out.push({
        requestId: rec.requestId,
        taskId: rec.taskId || '',
        instruction: rec.instruction || '',
        filename: artifact ? (artifact.filename || '') : '',
        lastStatus: rec.lastStatus,
        createdAt: rec.createdAt || 0,
        versions: Array.isArray(rec.versions) ? rec.versions : []
      });
    }
    return out;
  }

  function entryForRequest(requestId) {
    var all = taskEntries();
    for (var i = 0; i < all.length; i++) {
      if (all[i].requestId === requestId) return all[i];
    }
    return null;
  }

  /** 某个条目最近一次的 URI 台账记录（没有就是 null）。 */
  function latestUriOp(entry) {
    if (!uriTracker || !entry) return null;
    var all = uriTracker.records();
    var docId = entry.taskId || entry.requestId;
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].documentId === docId) return all[i];
    }
    return null;
  }

  /**
   * 桥操作终结 → 更新 URI 台账。**取消 / 超时 / 失败都算非成功**：
   * 绝不因为「回执到了」就把授权写成「可用」（那正是要防的假成功）。
   */
  function settleUriOp(op) {
    if (!uriTracker || !op) return;
    var uriOpId = uriByBridgeOp[op.operationId];
    if (!uriOpId) return;
    if (op.terminal && op.ok === true && op.terminalReason !== 'timeout') {
      uriTracker.grant(uriOpId, { persisted: op.method === 'saveCopy' });
    } else {
      /* 超时 / 取消 / 失败统一按「取消」结算：不产生可用状态。 */
      uriTracker.cancel(uriOpId);
    }
    lastBridgeOutcome = { operationId: op.operationId, ok: op.ok === true, reason: op.terminalReason };
    if (activeViewId === 'tasks') renderTaskUriStatus(activeRequestId ? entryForRequest(activeRequestId) : null);
    if (activeViewId === 'files') renderFileActionBar(activeRequestId ? entryForRequest(activeRequestId) : null);
  }

  /** 条目当前是否「读回通过、可以真正打开/另存/分享」。**默认一律 false**。 */
  function entryUsable(entry) {
    var op = latestUriOp(entry);
    return !!(op && uriTracker && uriTracker.usable(op.operationId));
  }

  function renderTaskList() {
    var list = dom['task-list'];
    if (!list) return;
    var all = taskEntries();
    var result = AssetLib ? AssetLib.searchEntries(all, taskQuery) : { matched: all, hasQuery: false, total: all.length };

    if (dom['task-search-note']) {
      setText(dom['task-search-note'], result.hasQuery
        ? ('在 ' + result.total + ' 条任务里找到 ' + result.matched.length + ' 条匹配「' + result.query + '」。')
        : (result.total > 0 ? ('共 ' + result.total + ' 条任务。输入关键词可按文件名 / 要求 / 任务编号筛选。')
          : '还没有任务可以搜索。'));
    }

    clearNode(list);
    if (result.total === 0) {
      setViewState('tasks', 'blank', '还没有任务。到「对话」页写下目标，或在下面的输入框提交一次生成。');
      renderTaskActionBar(null);
      return;
    }
    if (result.matched.length === 0) {
      setViewState('tasks', 'blank', '没有任务匹配「' + result.query + '」。换个关键词试试。');
      renderTaskActionBar(null);
      return;
    }
    setViewState('tasks', 'ready', '');
    for (var i = 0; i < result.matched.length; i++) {
      var rec = result.matched[i];
      var item = el('li', 'task-item' + (rec.requestId === activeRequestId ? ' is-active' : ''));
      item.setAttribute('data-request-id', rec.requestId);
      item.appendChild(el('span', 'task-item-text', rec.instruction || rec.filename || '（无要求文本）'));
      item.appendChild(el('span', 'task-item-meta',
        (STATUS_TEXT[rec.lastStatus] || '未取到状态') + ' · ' + formatTime(rec.createdAt || Date.now()) +
        ' · 请求编号 ' + rec.requestId));
      list.appendChild(item);
    }
    renderTaskActionBar(activeRequestId ? entryForRequest(activeRequestId) : null);
  }

  /**
   * 当前任务的文件操作区。**打开/另存/分享都只有「读回通过」才可用**，
   * 否则给出具体原因（未授权 / 未读回 / 格式没有登记消费者）。
   */
  function renderTaskActionBar(entry) {
    var bar = dom['task-action-bar'];
    if (!bar) return;
    clearNode(bar);

    if (!entry) {
      setText(dom['task-actions-note'], '先在上面的列表里选一个任务，这里会显示它的文件操作。');
      setText(dom['task-uri-status'], '');
      if (dom['task-version-list']) clearNode(dom['task-version-list']);
      return;
    }

    var hasVersions = AssetLib ? AssetLib.versionHistory(entry).length > 0 : false;
    var actions = AssetLib ? AssetLib.availableActions(entry, {
      usable: entryUsable(entry), hasVersions: hasVersions, readOnly: false
    }) : [];

    setText(dom['task-actions-note'],
      '这些入口**不会替你假装成功**：只有文件真的读回并核对通过后，「打开 / 另存 / 分享」才可点。' +
      '交接给哪个应用按格式决定（DOCX → Word/WPS 文字，XLSX → Excel/WPS 表格，PPTX → PowerPoint/WPS 演示）。');

    for (var i = 0; i < actions.length; i++) {
      (function (action) {
        var button = el('button', 'btn btn-small ' + (action.enabled ? 'btn-secondary' : 'btn-ghost'));
        button.type = 'button';
        button.setAttribute('data-task-action', action.id);
        button.setAttribute('data-enabled', action.enabled ? 'true' : 'false');
        if (!action.enabled) button.setAttribute('disabled', '');
        setText(button, action.label + (action.enabled ? '' : '（不可用）'));
        if (!action.enabled && action.reason) button.setAttribute('title', action.reason);
        button.addEventListener('click', function () { runTaskAction(action.id); });
        bar.appendChild(button);
      })(actions[i]);
    }

    renderTaskUriStatus(entry);
    renderTaskVersions(entry);
  }

  /** URI 授权与读回状态：如实显示当前态；**取消 / 失权 / 旧版本一律显示为非成功**。 */
  function renderTaskUriStatus(entry) {
    var host = dom['task-uri-status'];
    if (!host) return;
    var op = latestUriOp(entry);
    if (!op) {
      setText(host, '本机还没有对这个文件做过文件授权操作（应用内打开 / 另存）。' +
        '授权、取消、读回与失权的结果会在发生时如实显示在这里。');
      return;
    }
    var verdict = uriTracker.evaluate(op.operationId);
    var stateText = op.state === 'granted_persisted' ? '已授予（长久有效）'
      : op.state === 'granted_volatile' ? '已授予（仅本次会话）'
      : op.state === 'requested' ? '已申请，等待你确认'
      : op.state === 'cancelled' ? '已取消'
      : op.state === 'revoked' ? '已撤销'
      : op.state === 'expired' ? '已过期' : '未申请';
    setText(host, '文件授权：' + stateText + '。' +
      (verdict.showsSuccess ? '读回结果：' : '读回结果（**不算成功**）：') + verdict.message +
      (verdict.action ? ' ' + verdict.action : ''));
  }

  /** 历史版本：**只列真实存在的版本**；没有就说明「服务端没有返回」。 */
  function renderTaskVersions(entry) {
    var list = dom['task-version-list'];
    if (!list) return;
    clearNode(list);
    var rows = AssetLib ? AssetLib.versionHistory(entry) : [];
    if (rows.length === 0) {
      list.appendChild(el('li', 'version-item version-empty',
        '服务端没有为这个任务返回历史版本，本页不凭空列出条目。'));
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      list.appendChild(el('li', 'version-item' + (row.isLatest ? ' is-latest' : ''),
        row.label + (row.isLatest ? '（当前）' : '') + (row.note ? ' · ' + row.note : '')));
    }
  }

  /** 执行一个任务操作。**不可用时拒绝并说明原因**，不静默、不假装成功。 */
  function runTaskAction(actionId) {
    var entry = activeRequestId ? entryForRequest(activeRequestId) : null;
    if (!entry) return;
    var hasVersions = AssetLib ? AssetLib.versionHistory(entry).length > 0 : false;
    var actions = AssetLib ? AssetLib.availableActions(entry, {
      usable: entryUsable(entry), hasVersions: hasVersions, readOnly: false
    }) : [];
    var chosen = null;
    for (var i = 0; i < actions.length; i++) if (actions[i].id === actionId) chosen = actions[i];
    if (!chosen) return;
    if (!chosen.enabled) {
      setText(dom['task-actions-note'], '「' + chosen.label + '」现在不可用：' + chosen.reason);
      return;
    }
    /* 走到这里说明文件确实读回并通过核验；交接仍由应用内桥完成（真机路径未验证）。 */
    if (actionId === 'saveAs') nativeSave('saveCopy');
    else if (actionId === 'share' || actionId === 'open') nativeSave('saveDocx');
    else if (actionId === 'rename') {
      setText(dom['task-actions-note'], '重命名只改这台手机上的显示名；电脑上的文件不会被改名。');
    } else if (actionId === 'history') {
      renderTaskVersions(entry);
    }
  }

  /**
   * 「文件·产物」的四态条。有面板接管这个视图时，四态由面板按**电脑端文档工作流**的
   * 真实结果写（本机产物列表的搜索/点击重绘不再覆盖它）；没有面板时行为与以前一致。
   */
  function setFilesViewState(kind, text) {
    if (panelFor('files')) return;
    setViewState('files', kind, text);
  }

  function renderFilesView() {
    var list = dom['file-list'];
    if (!list) return;
    var all = taskEntries();
    var result = AssetLib ? AssetLib.searchEntries(all, fileQuery) : { matched: all, hasQuery: false, total: all.length };

    if (dom['file-search-note']) {
      setText(dom['file-search-note'], result.hasQuery
        ? ('在 ' + result.total + ' 个产物里找到 ' + result.matched.length + ' 个匹配「' + result.query + '」。')
        : (result.total > 0 ? ('共 ' + result.total + ' 个候选产物。') : '还没有产物可以搜索。'));
    }

    clearNode(list);
    if (result.total === 0) {
      setFilesViewState('files', 'blank', '本机还没有任务记录，因此没有可列出的产物。到「对话」或「任务」页发起一次生成后，这里会列出对应任务。');
      renderFileActionBar(null);
      return;
    }
    if (result.matched.length === 0) {
      setFilesViewState('files', 'blank', '没有产物匹配「' + result.query + '」。换个关键词试试。');
      renderFileActionBar(null);
      return;
    }
    setFilesViewState('files', 'ready', '');
    for (var i = 0; i < result.matched.length; i++) {
      var rec = result.matched[i];
      var item = el('li', 'file-item' + (rec.requestId === activeRequestId ? ' is-active' : ''));
      item.setAttribute('data-request-id', rec.requestId);
      item.appendChild(el('span', 'file-name', rec.filename || rec.instruction || '（无要求文本）'));
      var handoff = AssetLib ? AssetLib.handoffTargetFor(rec.filename || '') : { known: false, target: '' };
      item.appendChild(el('span', 'file-meta',
        (STATUS_TEXT[rec.lastStatus] || '未取到状态') + ' · 任务 ' + (rec.taskId || '—') +
        ' · ' + (handoff.known ? ('交接给 ' + handoff.target) : '格式未登记消费者')));
      list.appendChild(item);
    }
    setText(dom['files-note'],
      '文件名、大小、校验值与版本只在**任务详情**里由服务端回执给出；本页不编造本机并不存在的文件。' +
      '要取回文件，请到「任务」页打开对应任务。');
    renderFileActionBar(activeRequestId ? entryForRequest(activeRequestId) : null);
  }

  function renderFileActionBar(entry) {
    var bar = dom['file-action-bar'];
    if (!bar) return;
    clearNode(bar);
    if (!entry) {
      setText(dom['file-uri-note'], '先在列表里选一个产物，这里会显示它能做什么。');
      return;
    }
    var hasVersions = AssetLib ? AssetLib.versionHistory(entry).length > 0 : false;
    var actions = AssetLib ? AssetLib.availableActions(entry, {
      usable: entryUsable(entry), hasVersions: hasVersions, readOnly: false
    }) : [];
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      var chip = el('span', 'action-chip' + (action.enabled ? ' is-on' : ' is-off'),
        action.label + (action.enabled ? '' : '：' + action.reason));
      chip.setAttribute('data-task-action', action.id);
      chip.setAttribute('data-enabled', action.enabled ? 'true' : 'false');
      bar.appendChild(chip);
    }
    var op = latestUriOp(entry);
    var verdict = (op && uriTracker) ? uriTracker.evaluate(op.operationId) : null;
    setText(dom['file-uri-note'], op
      ? ('这个文件的授权/读回结果：' + (verdict.showsSuccess ? '已通过核验。' : '**未通过**——' + verdict.message))
      : '这个文件还没有进行过授权与读回，因此上面这些操作都不可用；本页不会假装它们已经可用。');
  }

  /* --------------------- 设置视图（APP-07） --------------------- */

  /** 把后台传来的健康状态翻成连接摘要输入。**没有实测通过就不写「可用」**。 */
  function settingsConnectionInput() {
    var health = lastHealth || null;
    return {
      service: {
        origin: serviceOrigin(),
        reachable: connected === true,
        configured: health && typeof health.modelConfigured === 'boolean' ? health.modelConfigured : null,
        verified: health && typeof health.modelVerified === 'boolean' ? health.modelVerified : null
      },
      account: { signedIn: false, name: '' }
    };
  }

  function renderSettingsView() {
    var host = dom['settings-summary'];
    if (!host) return;
    clearNode(host);
    host.appendChild(stateRow('连接状态', connected ? '已连接电脑服务' : '未连接'));
    host.appendChild(stateRow('服务地址', serviceOrigin()));
    host.appendChild(stateRow('对话后端', chatBackendReady() ? '已接入' : '未接入（由 B 流提供）'));
    host.appendChild(stateRow('本机任务记录', String(records.length) + ' 条'));
    host.appendChild(stateRow('本机会话', String(conversation ? conversation.sessions(true).length : 0) + ' 个'));
    /* 有面板接管这个视图的四态时，别用基础卡片的「有数据」把它盖掉
       （健康轮询每 10 秒会走到这里一次）。没有面板时行为与以前一致。 */
    if (!panelFor('settings')) setViewState('settings', 'ready', '');

    renderSettingsConnection();
    renderSettingsAuth();
    renderSettingsQuotaAndStorage();
    renderSettingsErrorHint();
    renderSettingsSecretNote();
  }

  function renderSettingsConnection() {
    var host = dom['settings-connection'];
    if (!host) return;
    clearNode(host);
    if (!SettingsLib) {
      host.appendChild(stateRow('连接摘要', '页面没有加载设置模块（settings-model.js）。'));
      return;
    }
    var summary = SettingsLib.connectionSummary(settingsConnectionInput());
    for (var i = 0; i < summary.rows.length; i++) {
      host.appendChild(stateRow(summary.rows[i].label, summary.rows[i].value));
    }
  }

  /**
   * 授权清单 + 撤销入口。**撤销后立刻显示「撤销了什么、没撤销什么」**，
   * 不让人以为外部副作用被回滚（R205）。
   */
  function renderSettingsAuth() {
    var list = dom['settings-auth-list'];
    if (!list) return;
    clearNode(list);
    if (!authRegistry) {
      setText(dom['settings-auth-note'], '页面没有加载设置模块（settings-model.js），无法显示授权清单。');
      return;
    }
    var entries = authRegistry.entries();
    for (var i = 0; i < entries.length; i++) {
      (function (item) {
        var row = el('li', 'auth-item');
        row.setAttribute('data-auth-id', item.id);
        row.appendChild(el('span', 'auth-label', item.label));
        row.appendChild(el('span', 'auth-state auth-state-' + item.state, item.stateLabel));
        row.appendChild(el('span', 'auth-scope', item.scope));
        if (item.canRevoke) {
          var button = el('button', 'btn btn-ghost btn-small', '撤销');
          button.type = 'button';
          button.setAttribute('data-revoke-id', item.id);
          button.addEventListener('click', function () { revokeAuthorization(item.id); });
          row.appendChild(button);
        } else if (!item.revocable) {
          row.appendChild(el('span', 'auth-note', item.note + '（' + item.systemPath + '）'));
        }
        list.appendChild(row);
      })(entries[i]);
    }
    setText(dom['settings-auth-note'],
      '这些是应用会用到的权限。未授予的项在需要时才会向你申请；撤销后可以重新授予。' +
      '系统里的开关位置写在每一项后面。');
  }

  function revokeAuthorization(id) {
    if (!authRegistry) return;
    var result = authRegistry.revoke(id);
    renderSettingsAuth();
    var label = result.entry ? result.entry.label : id;
    if (result.ok) {
      setText(dom['settings-auth-note'], '已撤销「' + label + '」。' + result.note);
    } else if (result.code === 'not_revocable') {
      setText(dom['settings-auth-note'], '「' + label + '」不能在本应用内撤销：' + result.note);
    } else if (result.code === 'already_revoked') {
      setText(dom['settings-auth-note'], '「' + label + '」此前已经撤销过。' + result.note);
    } else {
      setText(dom['settings-auth-note'], '撤销没有成功（' + result.code + '）。');
    }
  }

  /** 额度与存储。**电脑端没上报就写「未知」，绝不写 0**。 */
  function renderSettingsQuotaAndStorage() {
    var quotaHost = dom['settings-quota'];
    if (quotaHost && SettingsLib) {
      clearNode(quotaHost);
      var health = lastHealth || null;
      var quota = SettingsLib.quotaSummary({
        quotaBytes: health && typeof health.quotaBytes === 'number' ? health.quotaBytes : null,
        usedBytes: health && typeof health.usedBytes === 'number' ? health.usedBytes : null,
        unlimited: false
      });
      for (var i = 0; i < quota.rows.length; i++) {
        quotaHost.appendChild(stateRow(quota.rows[i].label, quota.rows[i].value));
      }
      setText(dom['settings-quota-note'], quota.note);
    }
    var storageHost = dom['settings-storage'];
    if (storageHost && SettingsLib) {
      clearNode(storageHost);
      var storage = SettingsLib.storageSummary({
        records: records.length,
        sessions: conversation ? conversation.sessions(true).length : null,
        files: null, bytes: null
      });
      for (var j = 0; j < storage.rows.length; j++) {
        storageHost.appendChild(stateRow(storage.rows[j].label, storage.rows[j].value));
      }
      setText(dom['settings-storage-note'], storage.note);
    }
  }

  /** 错误 → 用户能采取的动作。 */
  function renderSettingsErrorHint() {
    var host = dom['settings-error-hint'];
    if (!host) return;
    if (!SettingsLib) { setText(host, ''); return; }
    var code = settingsErrorCode || 'uri_revoked';
    var info = SettingsLib.actionForError(code);
    setText(host, '「' + info.title + '」时你可以：' + info.action + (info.retryable ? '（可以重试）' : '（重试不会有用）'));
    if (dom['settings-error-code']) setText(dom['settings-error-code'], '示例错误码：' + info.code);
  }

  /** 页面密钥自检：渲染完对**页面可见文本**扫一遍，发现即视为页面缺陷。 */
  function renderSettingsSecretNote() {
    var host = dom['settings-secret-note'];
    if (!host || !SettingsLib) return;
    pageSecretFindings = SettingsLib.assertNoSecrets(pageVisibleText());
    setText(host, SettingsLib.SECRET_POLICY_NOTE + ' 自检：' +
      (pageSecretFindings.ok ? '本次渲染的页面文本里**没有**发现密钥形态。'
        : '**发现 ' + pageSecretFindings.findings.length + ' 处疑似密钥形态，这是页面缺陷**。'));
  }

  /** 页面可见文本（本机自检用；不含脚本源码）。 */
  function pageVisibleText() {
    var parts = [];
    for (var key in dom) {
      if (!Object.prototype.hasOwnProperty.call(dom, key)) continue;
      var node = dom[key];
      if (node && typeof node.textContent === 'string' && node.textContent) parts.push(node.textContent);
    }
    return parts.join('\n');
  }

  /* ===================== 表格 / 演示的交付入口（design-06 P8/P9） ===================== */

  /**
   * 页面侧的交付计划模块（`deliverable-ops.js`）。
   *
   * **没加载就如实说没加载**，不在这里另抄一份路径与请求体：那样"页面发的形状"与
   * "验收用例发的形状"就会变成两份实现，其中一份永远不被测。
   */
  function deliverablesLib() {
    if (typeof window !== 'undefined' && window.PotbotDeliverables) return window.PotbotDeliverables;
    if (typeof globalThis !== 'undefined' && globalThis.PotbotDeliverables) {
      return globalThis.PotbotDeliverables;
    }
    return null;
  }

  /* 最后一次成功交付的版本（下载按钮据此取字节）。**只存服务端回执里给的字段**。 */
  var deliverableDelivery = null;

  function setDeliverableStatus(text, kind) {
    if (!dom['deliverable-status']) return;
    setText(dom['deliverable-status'], text);
    dom['deliverable-status'].className = 'download-status' + (kind ? ' ' + kind : '');
  }

  function setDeliverableFormError(msg) {
    if (!dom['deliverable-form-error']) return;
    if (msg) {
      setText(dom['deliverable-form-error'], msg);
      show(dom['deliverable-form-error'], true);
    } else {
      setText(dom['deliverable-form-error'], '');
      show(dom['deliverable-form-error'], false);
    }
  }

  function setDeliverableDownloadStatus(text, kind) {
    if (!dom['deliverable-download-status']) return;
    setText(dom['deliverable-download-status'], text);
    dom['deliverable-download-status'].className = 'download-status' + (kind ? ' ' + kind : '');
  }

  function currentDeliverableFormat() {
    return dom['deliverable-format'] ? String(dom['deliverable-format'].value) : 'xlsx';
  }

  function renderDeliverablePanel() {
    var Lib = deliverablesLib();
    if (!Lib) {
      if (dom['deliverable-edit-hint']) {
        setText(dom['deliverable-edit-hint'],
          '页面没有加载交付模块（deliverable-ops.js），本次不提供表格 / 演示入口。' +
          '这里不退回"随便生成一个文件"的做法。');
      }
      if (dom['deliverable-submit-btn']) dom['deliverable-submit-btn'].setAttribute('disabled', '');
      return;
    }
    if (dom['deliverable-submit-btn']) dom['deliverable-submit-btn'].removeAttribute('disabled');
    if (dom['deliverable-edit-hint']) setText(dom['deliverable-edit-hint'], Lib.editHintFor(currentDeliverableFormat()));
  }

  /** 从回执渲染"交付结果"面板。**每个字段都来自服务端**，缺就是"未提供"。 */
  function renderDeliverableResult(result) {
    if (!dom['deliverable-result']) return;
    if (!result) {
      show(dom['deliverable-result'], false);
      return;
    }
    show(dom['deliverable-result'], true);
    if (dom['deliverable-result-filename']) setText(dom['deliverable-result-filename'], result.filename || '未提供');
    if (dom['deliverable-result-format']) {
      var spec = deliverablesLib() ? deliverablesLib().formatSpec(result.fileFormat) : null;
      setText(dom['deliverable-result-format'],
        (spec ? spec.label : String(result.fileFormat || '未提供')) +
        (result.templateKind ? '（模板种类 ' + result.templateKind + '）' : ''));
    }
    if (dom['deliverable-result-mime']) setText(dom['deliverable-result-mime'], result.mimeType || '未提供');
    if (dom['deliverable-result-size']) {
      setText(dom['deliverable-result-size'],
        typeof result.byteLength === 'number' ? result.byteLength + ' 字节' : '未提供');
    }
    if (dom['deliverable-result-sha']) setText(dom['deliverable-result-sha'], result.contentDigest || '未提供');
  }

  /**
   * 渲染**完成口径**（R261–R263）。
   *
   * 完成与成功**分两行**：第一行只回答"有没有未了之事"，第二行才回答"办成了没有"。
   * 三个谓词逐条列出，方便用户自己复算，而不是只相信一个结论词。
   */
  function renderDeliverableCompletion(view) {
    if (!dom['deliverable-completion']) return;
    var Lib = deliverablesLib();
    var info = Lib ? Lib.labelForCompletion(view) : null;
    if (!info) {
      show(dom['deliverable-completion'], false);
      return;
    }
    show(dom['deliverable-completion'], true);
    if (dom['deliverable-completion-completed']) {
      setText(dom['deliverable-completion-completed'], info.completedText + '（' + info.labelText + '）');
    }
    if (dom['deliverable-completion-success']) {
      setText(dom['deliverable-completion-success'], '成功与否：' + info.successText);
    }
    if (dom['deliverable-completion-detail']) setText(dom['deliverable-completion-detail'], info.detail);
    var mark = function (value) { return value ? '成立' : '**不成立**'; };
    if (dom['deliverable-pred-work']) {
      setText(dom['deliverable-pred-work'], mark(info.predicates.allWorkItemsTerminal));
    }
    if (dom['deliverable-pred-runs']) {
      setText(dom['deliverable-pred-runs'], mark(info.predicates.noInFlightRuns));
    }
    if (dom['deliverable-pred-actions']) {
      setText(dom['deliverable-pred-actions'], mark(info.predicates.noUnresolvedActions));
    }
  }

  /** 逐个提交编辑：每次都用**上一次回执**里的版本与摘要做基线（不自己猜版本号）。 */
  function submitDeliverableEdits(Lib, sessionId, edits, revision, digest, onDone, onFail) {
    var index = 0;
    function next() {
      if (index >= edits.length) { onDone(revision, digest); return; }
      var step = index;
      var plan = Lib.planEdit({
        sessionId: sessionId,
        idempotencyKey: Lib.safeId('web-step', Date.now(), String(step + 1)),
        baseRevision: revision,
        baseDigest: digest,
        edit: edits[step]
      });
      setDeliverableStatus('正在交付第 ' + String(step + 1) + ' / ' + String(edits.length) + ' 步…', '');
      request(plan.method, plan.path, plan.body, 30000).then(function (res) {
        if (!res.ok) { onFail(res); return; }
        var data = res.data || {};
        var version = data.version && typeof data.version === 'object' ? data.version : null;
        if (!version || typeof version.contentDigest !== 'string') {
          onFail({ status: res.status, data: { code: 'no_version', message: '这一版没有返回产物映射行，不能继续用未知基线提交。' } });
          return;
        }
        revision = Number(data.editRevision);
        digest = version.contentDigest;
        index += 1;
        next();
      })['catch'](function (err) {
        onFail({ status: 0, data: { code: 'network', message: (err && err.message) || '网络请求失败' } });
      });
    }
    next();
  }

  function submitDeliverable() {
    var Lib = deliverablesLib();
    if (!Lib) {
      setDeliverableFormError('页面没有加载交付模块（deliverable-ops.js），无法交付。');
      return;
    }
    var format = currentDeliverableFormat();
    var spec = Lib.formatSpec(format);
    if (spec === null) {
      setDeliverableFormError('未知格式：' + format);
      return;
    }
    var parsed = Lib.parseEdits(format, dom['deliverable-edit-input'] ? dom['deliverable-edit-input'].value : '');
    if (!parsed.ok) {
      setDeliverableFormError(parsed.errors.length > 0
        ? '编辑内容有问题：' + parsed.errors.join('；')
        : '请至少写一条编辑（表格：`表名 | 地址 | 值`；演示：每行一页标题）。');
      return;
    }
    setDeliverableFormError('');
    renderDeliverableResult(null);
    renderDeliverableCompletion(null);
    deliverableDelivery = null;

    var rawName = trimText(dom['deliverable-filename'] ? dom['deliverable-filename'].value : '');
    var stem = rawName.length > 0 ? rawName : (format === 'xlsx' ? '工作簿' : '演示文稿');
    var filename = stem + spec.extension;  /* 契约要求文件名扩展名与格式一致（R232） */
    var stamp = Date.now();
    var sessionId = Lib.safeId('web-' + format, stamp);
    var deliverableId = Lib.safeId('web-del', stamp);

    var openPlan = Lib.planOpen({
      sessionId: sessionId, deliverableId: deliverableId,
      filename: filename, format: format, title: stem
    });

    if (dom['deliverable-submit-btn']) dom['deliverable-submit-btn'].setAttribute('disabled', '');
    setDeliverableStatus('正在创建交付会话…', '');

    request(openPlan.method, openPlan.path, openPlan.body, 30000).then(function (res) {
      if (!res.ok) {
        var failure = Lib.describeFailure(res.status, res.data);
        setDeliverableStatus('创建失败。' + failure.text, 'err');
        setDeliverableFormError(failure.text);
        return;
      }
      var data = res.data || {};
      var revision = Number(data.editRevision);
      var digest = typeof data.contentDigest === 'string' ? data.contentDigest : '';
      submitDeliverableEdits(Lib, sessionId, parsed.edits, revision, digest, function (finalRevision, finalDigest) {
        deliverableDelivery = { sessionId: sessionId, editRevision: finalRevision, digest: finalDigest };
        setDeliverableStatus('已交付第 ' + String(finalRevision) + ' 版。正在核对完成口径…', 'ok');
        refreshDeliverableCompletion(Lib, sessionId);
      }, function (failureRes) {
        var failure = Lib.describeFailure(failureRes.status, failureRes.data);
        setDeliverableStatus('交付中断。' + failure.text + ' 已经交付过的版本仍保留在服务端，不会留下半个文件。', 'err');
        /* 即使中断也要把**当前真实状态**（完成口径）拿回来显示，不粉饰、也不隐瞒。 */
        refreshDeliverableCompletion(Lib, sessionId);
      });
    })['catch'](function (err) {
      setDeliverableStatus('请求电脑服务失败：' + ((err && err.message) || '未知错误') +
        '。没有创建任何文件。', 'err');
    }).then(function () {
      if (dom['deliverable-submit-btn']) dom['deliverable-submit-btn'].removeAttribute('disabled');
    });
  }

  /** 取回完成口径并渲染（**只读**；这里没有任何"把任务置为完成"的调用）。 */
  function refreshDeliverableCompletion(Lib, sessionId) {
    var plan = Lib.planCompletion({ sessionId: sessionId });
    request(plan.method, plan.path, null, 15000).then(function (res) {
      if (!res.ok) {
        setDeliverableStatus('交付已完成，但完成口径取回失败：HTTP ' + String(res.status) + '。', 'err');
        return;
      }
      var view = res.data || {};
      renderDeliverableCompletion(view);
      var info = Lib.labelForCompletion(view);
      /* 交付结果面板的字段来自**会话状态**（版本映射行），完成视图只回答"有没有未了之事"。 */
      renderDeliveryFromCompletion(view, info);
    })['catch'](function () {
      setDeliverableStatus('交付已完成，但完成口径请求失败（网络）。', 'err');
    });
  }

  /** 交付结果面板：优先用最近一版的映射行；取不到就如实说取不到。 */
  function renderDeliveryFromCompletion(view, info) {
    var Lib = deliverablesLib();
    if (!Lib || !deliverableDelivery) return;
    var plan = Lib.planStatus({ sessionId: deliverableDelivery.sessionId });
    request(plan.method, plan.path, null, 15000).then(function (res) {
      if (!res.ok) {
        setDeliverableStatus('已交付，但版本映射取回失败：HTTP ' + String(res.status) + '。', 'err');
        return;
      }
      var body = res.data || {};
      var versions = body.versions;
      var latest = (versions && versions.length > 0) ? versions[versions.length - 1] : null;
      if (latest) {
        var described = Lib.describeDelivery(deliverableDelivery.sessionId, {
          editRevision: latest.editRevision, replayed: false, version: latest
        });
        renderDeliverableResult(described);
        /* 下载按钮要用**这一版自己的**文件名 / MIME / 长度 / 摘要——全部来自服务端映射行。 */
        if (described) {
          deliverableDelivery = {
            sessionId: deliverableDelivery.sessionId,
            editRevision: described.editRevision,
            digest: described.contentDigest,
            artifactId: described.artifactId,
            filename: described.filename,
            mimeType: described.mimeType,
            byteLength: described.byteLength
          };
        }
      } else {
        setDeliverableStatus('已交付，但服务端还没有返回任何版本映射行。', 'err');
      }
      if (info) {
        setDeliverableStatus(info.labelText + '：' + info.detail, info.completed ? 'ok' : '');
      }
    })['catch'](function () {
      setDeliverableStatus('已交付，但版本映射请求失败（网络）。', 'err');
    });
  }

  /** 下载最近一版：**复用同一个取回核对流程**（摘要不符就不保存）。 */
  function downloadDeliverable() {
    var Lib = deliverablesLib();
    if (!Lib || !deliverableDelivery) return;
    var plan = Lib.planDownload({
      sessionId: deliverableDelivery.sessionId, editRevision: deliverableDelivery.editRevision
    });
    setDeliverableDownloadStatus('正在从电脑取回文件…', '');
    if (dom['deliverable-download-btn']) dom['deliverable-download-btn'].setAttribute('disabled', '');

    fetch(plan.path, { cache: 'no-store' }).then(function (resp) {
      if (!resp.ok) throw new Error('电脑服务返回 HTTP ' + String(resp.status));
      return resp.arrayBuffer();
    }).then(function (buf) {
      return verifyAndSaveBytes(new Uint8Array(buf), {
        artifactId: deliverableDelivery.artifactId,
        filename: deliverableDelivery.filename,
        /* MIME 取**该版自己的**映射行（R232），不是页面上的常量。 */
        mimeType: deliverableDelivery.mimeType,
        byteLength: deliverableDelivery.byteLength,
        sha256: deliverableDelivery.digest
      }, setDeliverableDownloadStatus);
    })['catch'](function (err) {
      setDeliverableDownloadStatus((err && err.message ? err.message : '取回文件失败。') +
        ' 没有保存任何文件；上一次的成功文件不会在这里被冒充成本次结果。', 'err');
    }).then(function () {
      if (dom['deliverable-download-btn']) dom['deliverable-download-btn'].removeAttribute('disabled');
    });
  }

  /* ===================== 初始化 ===================== */

  function bindEvents() {
    dom['submit-btn'].addEventListener('click', function () { submitInstruction(false); });

    /* --- 表格 / 演示的交付入口 ------------------------------------------- */
    if (dom['deliverable-submit-btn']) {
      dom['deliverable-submit-btn'].addEventListener('click', submitDeliverable);
    }
    if (dom['deliverable-download-btn']) {
      dom['deliverable-download-btn'].addEventListener('click', downloadDeliverable);
    }
    if (dom['deliverable-format']) {
      /* 换格式要换记法说明：表格是「表名 | 地址 | 值」，演示是"一行一页"。 */
      dom['deliverable-format'].addEventListener('change', function () {
        setDeliverableFormError('');
        renderDeliverablePanel();
      });
    }
    if (dom['deliverable-edit-input']) {
      dom['deliverable-edit-input'].addEventListener('input', function () { setDeliverableFormError(''); });
    }
    renderDeliverablePanel();

    dom['clear-btn'].addEventListener('click', function () {
      dom['instruction'].value = '';
      updateCharCount();
      setFormError('');
      dom['instruction'].focus();
    });

    dom['instruction'].addEventListener('input', function () {
      updateCharCount();
      setFormError('');
    });

    dom['retry-btn'].addEventListener('click', function () {
      var rec = activeRequestId ? findRecord(activeRequestId) : null;
      if (!rec) return;
      dom['instruction'].value = rec.instruction || '';
      updateCharCount();
      show(dom['error-panel'], false);
      submitInstruction(true); /* 重试使用新的请求编号，不复用失败任务 */
    });

    dom['save-browser-btn'].addEventListener('click', browserSave);
    dom['save-native-btn'].addEventListener('click', function () { nativeSave('saveDocx'); });
    dom['save-copy-btn'].addEventListener('click', function () { nativeSave('saveCopy'); });

    /* --- 文档编辑区 --------------------------------------------------- */
    if (dom['import-btn']) dom['import-btn'].addEventListener('click', importDocument);
    if (dom['refresh-selection-btn']) {
      dom['refresh-selection-btn'].addEventListener('click', function () { applySelectionFromDom(); });
    }
    if (dom['undo-btn']) {
      dom['undo-btn'].addEventListener('click', function () {
        if (!staging || !staging.undo()) return;
        renderStaged();
        setEditorStatus('已撤销最后一步（只是从待保存列表里拿掉，**没有提交给内核**）。' +
          '可以点「重做一步」放回去。', '');
      });
    }
    if (dom['redo-btn']) {
      dom['redo-btn'].addEventListener('click', function () {
        if (!staging || !staging.redo()) return;
        renderStaged();
        setEditorStatus('已重做一步。', '');
      });
    }
    if (dom['clear-staged-btn']) {
      dom['clear-staged-btn'].addEventListener('click', function () {
        if (!staging) return;
        var dropped = staging.clear();
        renderStaged();
        setEditorStatus('已清空 ' + dropped.length + ' 步（没有提交任何东西）。', '');
      });
    }
    if (dom['save-edit-btn']) dom['save-edit-btn'].addEventListener('click', saveEdit);
    if (dom['download-version-btn']) {
      dom['download-version-btn'].addEventListener('click', downloadSessionVersion);
    }
    /* 选区变化是**事件**：用户一放手就重新翻译，不用先点按钮。 */
    document.addEventListener('selectionchange', function () { applySelectionFromDom(); });

    dom['opened-btn'].addEventListener('click', function () {
      var artifact = currentArtifact();
      if (!artifact) return;
      postObservation(artifact, 'user_reported_opened', '用户在页面上确认：已在办公软件中打开 ' + (artifact.filename || ''));
      setDownloadStatus('已记录你的反馈（用户自述，不是机器验证结果）。', 'ok');
    });

    dom['history-list'].addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== dom['history-list'] && !node.getAttribute('data-request-id')) {
        node = node.parentNode;
      }
      if (node && node.getAttribute && node.getAttribute('data-request-id')) {
        openRecord(node.getAttribute('data-request-id'));
      }
    });

    dom['forget-btn'].addEventListener('click', function () {
      records = [];
      activeRequestId = '';
      taskState = null;
      saveRecords();
      storageSet(STORE_ACTIVE, '');
      show(dom['history-section'], false);
      show(dom['task-body'], false);
      show(dom['task-empty'], true);
      setDownloadStatus('', '');
      setText(dom['task-note'], '');
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        pollHealth();
        tick();
      }
    });

    /* --- 导航骨架与连续对话（FA-A） ------------------------------------- */
    if (dom['nav-back']) dom['nav-back'].addEventListener('click', function () { if (router) router.back(); });
    if (dom['nav-forward']) dom['nav-forward'].addEventListener('click', function () { if (router) router.forward(); });
    if (dom['conv-send']) dom['conv-send'].addEventListener('click', sendMessage);
    if (dom['conv-input']) {
      dom['conv-input'].addEventListener('input', function () { setConvNote(''); });
      dom['conv-input'].addEventListener('keydown', function (ev) {
        /* 桌面浏览器里 Ctrl/⌘+Enter 发送；手机上是纯点按。 */
        if (ev && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) sendMessage();
      });
    }
    if (dom['conv-new-btn']) {
      dom['conv-new-btn'].addEventListener('click', function () {
        var created = createSessionNow();
        setConvNote('已新建会话' + (serverSessionMode() ? '，正在同步到电脑端…' : '。'));
        renderConversation();
        if (created && typeof created.then === 'function') created.then(function () { renderConversation(); });
      });
    }
    if (dom['conv-resume-btn']) dom['conv-resume-btn'].addEventListener('click', resumeConversation);
    if (dom['conv-messages']) {
      dom['conv-messages'].addEventListener('click', function (ev) {
        var node = ev.target;
        while (node && node !== dom['conv-messages'] &&
               !(node.getAttribute && node.getAttribute('data-retry-id'))) {
          node = node.parentNode;
        }
        if (node && node.getAttribute && node.getAttribute('data-retry-id')) {
          retryMessageById(node.getAttribute('data-retry-id'));
        }
      });
    }
    if (dom['sess-new-btn']) dom['sess-new-btn'].addEventListener('click', function () { createSessionNow(); });
    if (dom['sess-rename-btn']) dom['sess-rename-btn'].addEventListener('click', renameCurrentSession);
    if (dom['sess-list']) dom['sess-list'].addEventListener('click', onSessionListClick);
    /* --- 会话搜索 / 显示归档（FA-WEB-CONSUME-LIFECYCLE）：读服务端，不当本地筛子 --- */
    if (dom['sess-search']) {
      dom['sess-search'].addEventListener('input', function () { applySessionSearch(); });
      dom['sess-search'].addEventListener('keydown', function (ev) {
        if (ev && ev.key === 'Enter') applySessionSearch();
      });
    }
    if (dom['sess-search-btn']) dom['sess-search-btn'].addEventListener('click', applySessionSearch);
    if (dom['sess-show-archived']) {
      dom['sess-show-archived'].addEventListener('change', function () { toggleShowArchived(); });
    }
    if (dom['task-list']) {
      dom['task-list'].addEventListener('click', function (ev) {
        var node = ev.target;
        while (node && node !== dom['task-list'] && !(node.getAttribute && node.getAttribute('data-request-id'))) {
          node = node.parentNode;
        }
        if (node && node.getAttribute && node.getAttribute('data-request-id')) {
          openRecord(node.getAttribute('data-request-id'));
          renderTaskList();
        }
      });
    }

    /* --- 任务/文件搜索与设置（APP-04 / APP-07，FA-K） ------------------- */
    if (dom['task-search']) {
      dom['task-search'].addEventListener('input', function () {
        taskQuery = dom['task-search'].value || '';
        renderTaskList();
      });
    }
    if (dom['file-search']) {
      dom['file-search'].addEventListener('input', function () {
        fileQuery = dom['file-search'].value || '';
        renderFilesView();
      });
    }
    if (dom['file-list']) {
      dom['file-list'].addEventListener('click', function (ev) {
        var node = ev.target;
        while (node && node !== dom['file-list'] && !(node.getAttribute && node.getAttribute('data-request-id'))) {
          node = node.parentNode;
        }
        if (node && node.getAttribute && node.getAttribute('data-request-id')) {
          openRecord(node.getAttribute('data-request-id'));
          renderFilesView();
        }
      });
    }

    window.addEventListener('online', function () { setOffline(false); pollHealth(); tick(); });
    window.addEventListener('offline', function () {
      setOffline(true);
      healthFailure();
    });
  }

  function init() {
    cacheDom();
    records = loadRecords();
    activeRequestId = storageGet(STORE_ACTIVE) || '';
    if (!findRecord(activeRequestId)) activeRequestId = records.length > 0 ? records[0].requestId : '';

    setText(dom['meta-contract'], CONTRACT_VERSION);
    updateCharCount();
    bindEvents();
    /* 四个管理面板的「重新读取」按钮（没有面板模块时这一步是空转）。 */
    bindPanelButtons();
    renderHistory();

    /* 导航骨架：先建按钮，再落到初始视图（地址栏 hash 优先，但**只认清单里的视图**）。 */
    if (NavLib) {
      var initialView = NavLib.DEFAULT_VIEW;
      var rawHash = currentHash();
      var fromHash = NavLib.viewFromHash(rawHash);
      /* 深链还原优先走 APP-02 的口径（`app-nav.js` 的 `resolveDeepLink`）：认得出就用它，
         认不出**不猜**（`from === 'fallback'`）由导航模块回退。两个模块认的是同一批 id。 */
      var deep = null;
      if (navViewReady() && typeof NavViewLib.resolveView === 'function') {
        deep = NavViewLib.resolveView(rawHash, initialView, window);
        if (deep.from === 'deep-link') fromHash = deep.view;
      }
      if (fromHash) initialView = fromHash;
      router = NavLib.createRouter({
        initial: initialView, onNavigate: applyView,
        readHash: currentHash, writeHash: writeHash
      });
      /* APP-02 渲染层：接上导航条、hashchange 深链与真实连接探测（画导航条仍由 renderNav 走）。 */
      if (navViewReady() && typeof NavViewLib.mount === 'function') {
        navViewMount = NavViewLib.mount({
          scope: window, document: document, host: dom['nav-bar'],
          currentId: router.current(), render: false,
          goTo: goView, onAction: onViewStateAction, onConnection: applyProbe
        });
        if (dom['nav-view-note']) {
          setText(dom['nav-view-note'], deep && deep.from === 'deep-link'
            ? ('深链 ' + deep.raw + ' 还原为「' + deep.view + '」；正在探测与电脑服务的连接…')
            : '正在探测与电脑服务的连接…');
        }
      }
      renderNav();
      applyView(router.current(), null);
    } else if (dom['nav-note']) {
      setText(dom['nav-note'], '页面没有加载导航模块（nav.js），本次只显示对话视图。');
    }
    setOffline(typeof navigator !== 'undefined' && navigator !== null && navigator.onLine === false);
    renderConversation();
    /* 会话清单：接上后端就**从电脑端读**（读不到如实报"读不到"，不拿本机清单冒充）。 */
    reloadSessions();

    /* 编辑区先渲染骨架（还没有导入文档时身体是隐藏的）。 */
    renderToolbar();
    renderSectionPanel();
    renderListPanel();
    renderStaged();
    renderSelection();
    renderVersions();
    if (editorUnavailableReason()) setEditorError(editorUnavailableReason());

    if (activeRequestId) {
      var rec = findRecord(activeRequestId);
      openRecord(activeRequestId);
      if (rec && trimText(dom['instruction'].value) === '') {
        dom['instruction'].value = rec.instruction || '';
        updateCharCount();
      }
    } else {
      show(dom['task-empty'], true);
      show(dom['task-body'], false);
    }

    pollHealth();
    healthTimer = setInterval(function () {
      if (document.hidden) return;
      pollHealth();
    }, 10000);

    clockTimer = setInterval(renderElapsed, 1000);
    ensurePolling();
    renderElapsed();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
