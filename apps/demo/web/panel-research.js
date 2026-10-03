/*
 * potbot 完整 App —— 「权限与连接设置」面板：接上真实检索 / 连接就绪路由
 *
 * 入口：`GET /api/research/status`（`research-routes.ts` 的 `RESEARCH_ROOT`，
 * **已挂载且真服务实测 200**）。它报的是**连接与边界**：联网查询 / 链接抓取 / 扫描件 OCR
 * 三段各自就绪没有、整链通不通、以及**出口策略探针**（本机目的地 vs 外部目的地）。
 * 这正是「权限与连接设置」要给人看的东西——远程与本机工具的边界（合同 R253）。
 *
 * 此前这个视图只有既有的健康 / 授权 / 额度卡片，**够不到**这条真实路由。
 * 面板真的发一次请求，把分段就绪与出口策略渲染成行；取不到时按四态如实分流。
 *
 * 第二批（FA-WEB-PANEL-DEPTH）：**重新探测连接**——
 *   真发一次 `GET /health`，把结果分成**四种互不相同**的情形写在动作反馈里，
 *   并且**离线时根本不发请求**（设备自己说没网 ≠ 连上了没成）：
 *     `ready`       电脑端在线且服务就绪
 *     `not_ready`   电脑端在线，但服务未就绪（不是网络问题）
 *     `unreachable` 设备有网，但电脑端没有响应
 *     `offline`     设备当前没连网（未发出请求）
 *
 * ⚠️ OCR 的 `verified_supported` **恒为 false**：本仓未对真实 OCR 引擎做端到端实测，
 *    面板如实标「未实测支持」，不假装可用。
 * ⚠️ 浏览器 / 真机渲染**未验证**。
 *
 * 能力目录 APP-07（设置）；合同 R253 / R258。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root && root.PotbotPanels ? root.PotbotPanels : null);
  if (root && typeof root === 'object') root.PotbotPanelResearch = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (core) {
  'use strict';

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  function bool(value) {
    return value === true;
  }

  /** 一段能力的就绪描述：普通段有 `ready`，OCR 段是五态（配置 / 启用 / 授权 / 依赖 / 实测）。 */
  function segmentText(segment) {
    if (!isObject(segment)) return '未上报';
    if (typeof segment.ready === 'boolean') {
      var base = segment.ready ? '可用' : '未就绪';
      var reason = textOf(segment.reason);
      return reason === '' ? base : base + '（' + reason + '）';
    }
    var flags = [];
    flags.push(bool(segment.configured) ? '已安装' : '未安装');
    if (bool(segment.installed)) flags.push('已装入');
    flags.push(bool(segment.enabled) ? '已启用' : '未启用');
    flags.push(bool(segment.authorized) ? '已授权' : '未授权');
    flags.push(bool(segment.deps_ready) ? '依赖就绪' : '依赖未就绪');
    flags.push(bool(segment.verified_supported) ? '已实测支持' : '未实测支持');
    var text = flags.join(' / ');
    var why = textOf(segment.reason);
    return why === '' ? text : text + '（' + why + '）';
  }

  /** 出口策略探针：本机 / 外部目的地分别放行还是拒绝。 */
  function egressText(probe) {
    if (!isObject(probe)) return '未上报';
    var allowed = probe.allowed === true ? '放行' : (probe.allowed === false ? '拒绝' : '未裁定');
    var reason = textOf(probe.reason);
    return reason === '' ? allowed : allowed + '（' + reason + '）';
  }

  function summarize(body) {
    if (!isObject(body)) return { rows: [], note: '' };
    /* 空态：既没有分段清单，也没有整链结论与出口策略——不拿空壳冒充内容。 */
    var hasSegments = Array.isArray(body.segments) && body.segments.length > 0;
    if (!hasSegments && !isObject(body.ready) && !isObject(body.egress_policy_probe)) {
      return { rows: [], note: '' };
    }

    var rows = [];

    var segments = Array.isArray(body.segments) ? body.segments : [];
    for (var i = 0; i < segments.length; i++) {
      var segment = isObject(segments[i]) ? segments[i] : {};
      var label = textOf(segment.label) || textOf(segment.name);
      if (label === '') continue;
      rows.push({ label: label, value: segmentText(segment) });
    }

    var ready = isObject(body.ready) ? body.ready : null;
    if (ready && typeof ready.chain_ready === 'boolean') {
      rows.push({ label: '整链就绪', value: ready.chain_ready ? '通' : '不通（有分段未就绪）' });
    }

    var probe = isObject(body.egress_policy_probe) ? body.egress_policy_probe : null;
    if (probe) {
      rows.push({ label: '出口策略 · 本机目的地', value: egressText(probe.local) });
      rows.push({ label: '出口策略 · 外部目的地', value: egressText(probe.external) });
    }

    if (rows.length === 0) return { rows: [], note: '' };
    return {
      rows: rows,
      note: textOf(body.note) || '分段就绪与出口策略来自电脑端；未注入端口的段落如实标为未就绪。'
    };
  }

  /* ===================== 动作：重新探测连接（真实请求，四态可区分） ===================== */

  function notifyState(ctx, kind, message) {
    if (ctx && typeof ctx.onState === 'function') ctx.onState(kind, { message: message });
  }

  function probeConnection(ctx) {
    /* 设备自己说没网：**不发请求**，如实报离线（没连上 ≠ 连上了没成）。 */
    if (typeof ctx.offline === 'function' && ctx.offline() === true) {
      var offlineText = '探测结果：**设备当前没连网（离线）**——没有向电脑端发出请求。' +
        '先恢复网络或与电脑端的连接，再点「重新探测连接」。';
      core.setActionStatus(ctx, offlineText);
      notifyState(ctx, 'offline', offlineText);
      return Promise.resolve({ outcome: 'offline', kind: 'offline' });
    }
    if (typeof ctx.request !== 'function') {
      var noChannel = '页面没有可用的请求通道，本次没有发出探测请求。';
      core.setActionStatus(ctx, noChannel);
      return Promise.resolve({ outcome: 'no-channel', kind: 'error' });
    }
    core.setActionStatus(ctx, '正在向电脑端探测连接（GET /health）…');
    return Promise.resolve(ctx.request('GET', '/health')).then(
      function (res) {
        if (!res || res.ok !== true) {
          var unreachable = '探测结果：**连不上电脑端**——设备有网，但这次探测没有成功。' +
            '检查页面里的服务地址，并确认电脑端服务还在运行。';
          core.setActionStatus(ctx, unreachable);
          notifyState(ctx, 'error', unreachable);
          return { outcome: 'unreachable', kind: 'error' };
        }
        var data = isObject(res.data) ? res.data : {};
        if (data.ready !== true) {
          var notReady = '探测结果：**电脑端在线，但服务未就绪**（不是网络问题）。' +
            '到上面「电脑服务状态」卡片看是哪一项没就绪（例如模型未配置）。';
          core.setActionStatus(ctx, notReady);
          notifyState(ctx, 'error', notReady);
          return { outcome: 'not_ready', kind: 'error' };
        }
        var ready = '探测结果：**电脑端在线，服务已就绪**（模型已配置）——可以正常读写。';
        core.setActionStatus(ctx, ready);
        notifyState(ctx, 'ready', ready);
        return { outcome: 'ready', kind: 'ready' };
      },
      function (err) {
        var failed = '探测结果：**连不上电脑端**——探测请求失败了（' +
          core.classifyFailure(err, false).message + '）。';
        core.setActionStatus(ctx, failed);
        notifyState(ctx, 'error', failed);
        return { outcome: 'unreachable', kind: 'error' };
      }
    );
  }

  function panelActions(ctx) {
    return [{
      id: 'reprobe',
      label: '重新探测连接',
      onClick: function () { return probeConnection(ctx); }
    }];
  }

  var panel = core ? core.createPanel({
    view: 'settings',
    label: '权限与连接设置',
    endpoint: '/api/research/status',
    pending: '连接与检索分段就绪',
    emptyMessage: '电脑端这次没有返回连接分段清单，暂时没有可显示的内容。',
    summarize: summarize,
    panelActions: panelActions
  }) : null;

  if (core && panel) core.register(panel);

  return {
    VIEW: 'settings',
    ENDPOINT: '/api/research/status',
    summarize: summarize,
    panelActions: panelActions,
    probeConnection: probeConnection
  };
});
