/*
 * potbot 完整 App —— 「文件·产物」面板：接上真实文档工作流路由
 *
 * 入口：`GET /api/documents/status`（`documents-routes.ts` 的 `DOCUMENTS_ROOT`）。
 * 这条路由**已挂载且真服务实测 200**，但此前手机页面上没有任何入口能用到它。
 *
 * 面板做的事就一件：**真的发一次请求，把响应体渲染成行**，并把结果按四态交回页面
 * （`panel-core.js` 的四态分流 → `app-nav.js` 的文案 → `nav-view.js` 画出来）。
 * 电脑端把文档端口接没接上、哪些能力已接线 / 已暴露 / 已知不支持，都在这里如实显示。
 *
 * 第二批（FA-WEB-PANEL-DEPTH）：**导出 / 下载**——
 *   `GET /api/artifacts/:id/download`（`http.ts` 的真实产物下载口，返回**二进制**）。
 *   目标从哪来：宿主给的 `ctx.exportTarget()`（产品里是当前任务的产物，或用户填的产物编号）；
 *   **没有目标就不发请求**，只给一句人话告诉用户怎么把它变出来——
 *   不做「点了没反应」的假按钮，也不拿 0 字节冒充下载成功。
 *
 * ⚠️ 本面板**不编造**任何文档内容：`/api/documents/status` 按纪律只报就绪，
 *    不返回任何文档正文；因此这里也只显示就绪与能力清单。
 * ⚠️ 下载**不核对校验值**（本口没有随包给摘要）：文案如实写「未核对校验值」，
 *    不把「没核对」说成「已核验」。
 * ⚠️ 浏览器 / 真机渲染**未验证**：只证明请求真的发出、状态真的按四态分流。
 *
 * 能力目录 APP-04（任务与文件）；合同 R258。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root && root.PotbotPanels ? root.PotbotPanels : null);
  if (root && typeof root === 'object') root.PotbotPanelDocuments = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (core) {
  'use strict';

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }

  /** 能力分型（`capabilityDigest()` 的形状）：`{ total, wired, exposed, not_wired }`。 */
  function capText(cap) {
    if (!isObject(cap) || typeof cap.total !== 'number') return '未上报';
    var wired = typeof cap.wired === 'number' ? cap.wired : 0;
    var exposed = typeof cap.exposed === 'number' ? cap.exposed : 0;
    return '已接线 ' + String(wired) + '/' + String(cap.total) + '（已暴露 ' + String(exposed) + '）';
  }

  function summarize(body) {
    if (!isObject(body)) return { rows: [], note: '' };
    /* 空态：电脑端回了 200，但体里没有任何就绪 / 能力信息——如实显示「没有可显示的内容」。 */
    var hasReady = typeof body.ready === 'boolean';
    var hasCaps = isObject(body.capabilities);
    var hasUnsupported = Array.isArray(body.unsupported) && body.unsupported.length > 0;
    var hasCoverage = Array.isArray(body.coverage) && body.coverage.length > 0;
    if (!hasReady && !hasCaps && !hasUnsupported && !hasCoverage) return { rows: [], note: '' };

    var rows = [];
    var caps = isObject(body.capabilities) ? body.capabilities : null;

    rows.push({ label: '文档工作流就绪', value: body.ready === true ? '已就绪' : '未就绪' });
    if (body.ready !== true && textOf(body.reason) !== '') {
      rows.push({ label: '未就绪原因', value: textOf(body.reason) });
    }
    if (caps !== null) {
      rows.push({ label: '表格', value: capText(caps.table) });
      rows.push({ label: '页面设置', value: capText(caps.pages) });
      rows.push({ label: '页眉页脚', value: capText(caps.header_footer) });
      rows.push({ label: '图形 / 图片', value: capText(caps.images) });
    }

    var unsupported = Array.isArray(body.unsupported) ? body.unsupported : [];
    for (var i = 0; i < unsupported.length; i++) {
      var item = isObject(unsupported[i]) ? unsupported[i] : {};
      var id = textOf(item.id);
      if (id === '') continue;
      rows.push({ label: '已知不支持：' + id, value: textOf(item.reason) || '未说明原因' });
    }

    var verification = textOf(body.render_verification);
    if (verification !== '') {
      rows.push({
        label: '渲染核对',
        value: verification === 'unverified' ? '未做（未验证）' : verification
      });
    }

    if (Array.isArray(body.coverage)) {
      rows.push({ label: '已覆盖路由模块', value: String(body.coverage.length) + ' 个' });
    }

    if (rows.length === 0) return { rows: [], note: '' };
    return { rows: rows, note: textOf(body.note) };
  }

  /* ===================== 写侧：导出 / 下载一次（真二进制） ===================== */

  function resolveFetch(ctx) {
    if (ctx && typeof ctx.fetch === 'function') return ctx.fetch;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  /** 下载目标由宿主给：产品里是当前任务的产物下载口，或用户手填的产物编号。 */
  function resolveTarget(ctx) {
    if (!ctx || typeof ctx.exportTarget !== 'function') return null;
    var target = ctx.exportTarget();
    if (!isObject(target) || textOf(target.url) === '') return null;
    return { url: textOf(target.url), filename: textOf(target.filename) };
  }

  /** 尽力触发一次浏览器保存。返回是否真的调用了保存通道（不谎报）。 */
  function saveBytes(ctx, bytes, filename) {
    var doc = (ctx && ctx.document) || null;
    var scope = (ctx && ctx.scope) || null;
    if (!doc || typeof doc.createElement !== 'function') return false;
    try {
      var BlobCtor = scope && typeof scope.Blob === 'function'
        ? scope.Blob : (typeof Blob === 'function' ? Blob : null);
      var URLCtor = scope && scope.URL ? scope.URL : (typeof URL !== 'undefined' ? URL : null);
      var href = '';
      if (BlobCtor && URLCtor && typeof URLCtor.createObjectURL === 'function') {
        href = URLCtor.createObjectURL(new BlobCtor([bytes], { type: 'application/octet-stream' }));
      }
      var link = doc.createElement('a');
      if (href !== '') link.href = href;
      link.download = filename;
      if (typeof link.click === 'function') link.click();
      if (href !== '' && URLCtor && typeof URLCtor.revokeObjectURL === 'function') {
        URLCtor.revokeObjectURL(href);
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function exportArtifact(ctx) {
    var target = resolveTarget(ctx);
    if (target === null) {
      core.setActionStatus(ctx,
        '现在没有可导出的产物：先在「任务」页发起一次生成，或在下面的输入框里填入产物编号，' +
        '这里才会真的去电脑端取文件。**本次没有发出任何请求**。');
      return Promise.resolve({ outcome: 'no-target' });
    }
    var fetchFn = resolveFetch(ctx);
    if (typeof fetchFn !== 'function') {
      core.setActionStatus(ctx, '当前环境没有可用的下载通道，本次没有发出请求。');
      return Promise.resolve({ outcome: 'no-channel' });
    }
    core.setActionStatus(ctx, '正在从电脑端取回产物字节…');
    return Promise.resolve(fetchFn(target.url, { cache: 'no-store' })).then(
      function (res) {
        if (!res || res.ok !== true) {
          core.setActionStatus(ctx, '没能取回产物：' + core.classifyHttp(res ? res.status : 0, null).message);
          return { outcome: 'failed' };
        }
        return Promise.resolve(res.arrayBuffer()).then(function (buf) {
          var bytes = buf ? new Uint8Array(buf) : new Uint8Array(0);
          var name = target.filename || '产物';
          if (bytes.byteLength === 0) {
            core.setActionStatus(ctx,
              '电脑端回了 0 字节：这次没有拿到可用产物，**不算下载成功**。' +
              '请确认产物是否已生成完成，再试一次。');
            return { outcome: 'empty', bytes: 0 };
          }
          var saved = saveBytes(ctx, bytes, name);
          core.setActionStatus(ctx,
            '已从电脑端取回「' + name + '」（' + String(bytes.byteLength) + ' 字节）' +
            (saved ? '，并已发起保存。' : '；当前环境不能触发保存，字节已在页面里取回。') +
            '本次**未核对校验值**（这个下载口没有随包给摘要）。');
          return { outcome: 'downloaded', bytes: bytes.byteLength };
        });
      },
      function (err) {
        var offline = typeof ctx.offline === 'function' && ctx.offline() === true;
        core.setActionStatus(ctx, '没能取回产物：' + core.classifyFailure(err, offline).message);
        return { outcome: 'failed' };
      }
    );
  }

  function panelActions(ctx) {
    return [{
      id: 'export',
      label: '导出 / 下载产物',
      onClick: function () { return exportArtifact(ctx); }
    }];
  }

  var panel = core ? core.createPanel({
    view: 'files',
    label: '文件·产物',
    endpoint: '/api/documents/status',
    pending: '文档工作流就绪清单',
    emptyMessage: '电脑端这次没有返回文档能力清单，暂时没有可显示的内容。',
    summarize: summarize,
    panelActions: panelActions
  }) : null;

  if (core && panel) core.register(panel);

  return {
    VIEW: 'files',
    ENDPOINT: '/api/documents/status',
    summarize: summarize,
    panelActions: panelActions,
    exportArtifact: exportArtifact
  };
});
