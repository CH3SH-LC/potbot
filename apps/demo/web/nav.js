/*
 * potbot 完整 App —— 导航路由（纯逻辑，无 DOM 依赖）
 *
 * 目的：把「网页只有一次性写作输入」升级为**多视图导航**（APP-02）。
 * 本文件只做三件事，不碰 DOM、不发请求、不读全局：
 *   1. 定义七个视图的**唯一清单**（对话 / 会话 / 任务 / 文件 / 记忆 / 模板 / 设置）；
 *   2. 维护当前视图 + 前进/后退栈；
 *   3. 在视图 id 与 URL hash（`#/view-id`）之间双向映射。
 *
 * 之所以是「视图清单的唯一来源」：页面渲染、状态机、独立验证器都从这里取，
 * 避免三处各写一份列表后互相漂移。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md` R256（回到任务）、
 * R258（界面资源与断线状态完整）；能力目录 APP-02。
 */
(function () {
  'use strict';

  /* 七个视图：id 用于 DOM（`view-<id>`）、hash（`#/<id>`）与调试接缝。 */
  var VIEWS = [
    { id: 'conversation', label: '对话' },
    { id: 'sessions', label: '会话' },
    { id: 'tasks', label: '任务' },
    { id: 'files', label: '文件' },
    { id: 'memory', label: '记忆' },
    { id: 'templates', label: '模板' },
    { id: 'settings', label: '设置' }
  ];

  var HASH_PREFIX = '#/';

  function idsOf(views) {
    var list = views || VIEWS;
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].id);
    return out;
  }

  function isKnown(id, views) {
    if (typeof id !== 'string' || id === '') return false;
    return idsOf(views).indexOf(id) >= 0;
  }

  /** 视图 id → hash 字面量。未知 id 返回 ''（调用方据此决定不写地址）。 */
  function hashFor(id, views) {
    if (!isKnown(id, views)) return '';
    return HASH_PREFIX + id;
  }

  /**
   * hash → 视图 id。**只认本清单里的 id**；认不出（空、错误格式、陌生视图）一律
   * 返回 null，由调用方决定回退到哪个视图——不把陌生 hash 猜成一个视图。
   */
  function viewFromHash(hash, views) {
    if (typeof hash !== 'string') return null;
    var trimmed = hash.replace(/^#/, '');
    trimmed = trimmed.replace(/^\/+/, '');
    if (trimmed === '') return null;
    /* 去掉可能的查询串，例如 `#/tasks?x=1`。 */
    var q = trimmed.indexOf('?');
    if (q >= 0) trimmed = trimmed.slice(0, q);
    return isKnown(trimmed, views) ? trimmed : null;
  }

  /**
   * 建立一个路由器。
   *
   * `opts`：
   *   - `views`       视图清单（默认 VIEWS）；
   *   - `initial`     初始视图 id（不认识时退回清单第一个）；
   *   - `onNavigate(nextId, prevId)` 每次**成功切换**后回调；
   *   - `readHash()` / `writeHash(id)` 可选的地址读写（缺失=不碰地址，测试里安全）。
   */
  function createRouter(opts) {
    var options = opts || {};
    var views = options.views || VIEWS;
    var ids = idsOf(views);
    var current = isKnown(options.initial, views) ? options.initial : ids[0];
    var backStack = [];
    var forwardStack = [];

    function notify(prev) {
      if (typeof options.onNavigate === 'function') {
        options.onNavigate(current, prev);
      }
    }

    function writeHash() {
      if (typeof options.writeHash === 'function') {
        try { options.writeHash(current); } catch (e) { /* 地址写入失败不影响视图切换 */ }
      }
    }

    return {
      /** 视图清单的只读副本。 */
      views: function () {
        var out = [];
        for (var i = 0; i < views.length; i++) out.push({ id: views[i].id, label: views[i].label });
        return out;
      },
      current: function () { return current; },
      isKnown: function (id) { return isKnown(id, views); },
      /** 切换视图。**同视图不切换也不入栈**（重复点击不产生历史膨胀）。 */
      go: function (id) {
        if (!isKnown(id, views) || id === current) return false;
        var prev = current;
        backStack.push(prev);
        forwardStack.length = 0;
        current = id;
        writeHash();
        notify(prev);
        return true;
      },
      back: function () {
        if (backStack.length === 0) return false;
        var prev = current;
        current = backStack.pop();
        forwardStack.push(prev);
        writeHash();
        notify(prev);
        return true;
      },
      forward: function () {
        if (forwardStack.length === 0) return false;
        var prev = current;
        current = forwardStack.pop();
        backStack.push(prev);
        writeHash();
        notify(prev);
        return true;
      },
      canBack: function () { return backStack.length > 0; },
      canForward: function () { return forwardStack.length > 0; },
      /** 已访问视图轨迹（含当前），供状态恢复与调试接缝使用。 */
      trail: function () {
        var out = [];
        for (var i = 0; i < backStack.length; i++) out.push(backStack[i]);
        out.push(current);
        return out;
      }
    };
  }

  var api = {
    VIEWS: VIEWS,
    DEFAULT_VIEW: VIEWS[0].id,
    createRouter: createRouter,
    viewFromHash: viewFromHash,
    hashFor: hashFor,
    ids: idsOf
  };

  /* 浏览器与 node:vm 沙箱都成立：挂到全局对象上。 */
  if (typeof window !== 'undefined' && window) window.PotbotNav = api;
  if (typeof globalThis !== 'undefined') globalThis.PotbotNav = api;
})();
