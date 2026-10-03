/**
 * **表格 / 演示的页面入口**（design-06 P8/P9 的产品入口的网页侧；合同 R232 / R247 / R250）。
 *
 * 这个文件只做三件事，**都不碰内核**：
 *
 * 1. **拼请求形状**（`planOpen` / `planEdit` / `planDownload` / `planCompletion`）——
 *    路径、方法、请求体与 `apps/demo/server/http.ts` 的 `/api/deliverables/**` 契约逐字对应。
 *    app.js 用这些计划去 `fetch`；验收用例用**同一批计划**直喂真实宿主。
 *    这样"页面发出的请求形状"与"被测的请求形状"是**同一个函数**产出的，不是两处各写一遍。
 * 2. **结构化记法 → 封闭编辑枚举**（`parseEdits`）。合同 R134 把"自然语言 → 表格/演示操作"
 *    归给模型层；本页**不做翻译**，只认一种**逐行记法**，每行对应一个确定的 `edit` 对象。
 * 3. **把服务端回执翻成给人看的话**（`describeDelivery` / `describeFailure` / `labelForCompletion`）。
 *    其中 `labelForCompletion` 严格区分**完成**（没有未了之事）与**成功**（办成了）——
 *    R263 要求两者分开呈现。
 *
 * **诚实边界**：文件名、大小、校验值、MIME 一律取自**服务端回执/响应头**，本模块不编造。
 * 拿不到就如实显示"未提供"，绝不填一个看起来合理的值。
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 格式轴（R232：模板 / 工具 / 文件格式分开建模；这里只是网页侧的镜像）
   * ------------------------------------------------------------------ */

  var FORMATS = [
    {
      value: 'xlsx',
      label: '表格（XLSX）',
      extension: '.xlsx',
      templateKind: 'spreadsheet',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    {
      value: 'pptx',
      label: '演示（PPTX）',
      extension: '.pptx',
      templateKind: 'presentation',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
  ];

  function formatSpec(format) {
    for (var i = 0; i < FORMATS.length; i += 1) {
      if (FORMATS[i].value === format) return FORMATS[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 路径（与 apps/demo/server/http.ts 的 /api/deliverables/** 一一对应）
   * ------------------------------------------------------------------ */

  function pathOpen() {
    return '/api/deliverables';
  }

  function pathEdits(sessionId) {
    return '/api/deliverables/' + encodeURIComponent(sessionId) + '/edits';
  }

  function pathDownload(sessionId, editRevision) {
    return (
      '/api/deliverables/' +
      encodeURIComponent(sessionId) +
      '/versions/' +
      String(editRevision) +
      '/download'
    );
  }

  function pathStatus(sessionId) {
    return '/api/deliverables/' + encodeURIComponent(sessionId);
  }

  /** 交付会话那条内核任务的**完成口径**派生视图（R261–R263；只读）。 */
  function pathCompletion(sessionId) {
    return '/api/deliverables/' + encodeURIComponent(sessionId) + '/completion';
  }

  /* ------------------------------------------------------------------ *
   * 请求计划：{ method, path, body? } —— 页面与验收用例共用同一份形状
   * ------------------------------------------------------------------ */

  function planOpen(input) {
    var spec = formatSpec(input.format);
    if (spec === null) {
      throw new Error('未知格式：' + String(input.format));
    }
    var body = {
      sessionId: input.sessionId,
      deliverableId: input.deliverableId,
      filename: input.filename,
      format: input.format
    };
    if (typeof input.title === 'string' && input.title.length > 0) {
      body.title = input.title;
    }
    return { method: 'POST', path: pathOpen(), body: body };
  }

  function planEdit(input) {
    return {
      method: 'POST',
      path: pathEdits(input.sessionId),
      body: {
        idempotencyKey: input.idempotencyKey,
        baseRevision: input.baseRevision,
        baseDigest: input.baseDigest,
        edit: input.edit
      }
    };
  }

  function planDownload(input) {
    return { method: 'GET', path: pathDownload(input.sessionId, input.editRevision) };
  }

  function planCompletion(input) {
    return { method: 'GET', path: pathCompletion(input.sessionId) };
  }

  function planStatus(input) {
    return { method: 'GET', path: pathStatus(input.sessionId) };
  }

  /* ------------------------------------------------------------------ *
   * 结构化记法 → 封闭编辑枚举（**不是**自然语言翻译，R134）
   *
   * 表格（xlsx）：每行三种之一
   *   `+表名`                       → { op:'add_sheet' }
   *   表名 | 地址 | 值               → { op:'set_cell' }（值形如数字则按数值写入，否则文本）
   *   以 `#` 开头                    → 注释行，忽略
   * 演示（pptx）：每个非空行 = 一页的标题 → { op:'add_slide' }
   * ------------------------------------------------------------------ */

  var NUMBER_RE = /^-?\d+(\.\d+)?$/;

  function cellValueOf(raw) {
    var text = String(raw).trim();
    if (NUMBER_RE.test(text)) {
      var asNumber = Number(text);
      if (isFinite(asNumber)) return { kind: 'number', value: asNumber };
    }
    if (text === 'TRUE' || text === 'FALSE') return { kind: 'boolean', value: text === 'TRUE' };
    return { kind: 'text', value: text };
  }

  function splitRow(line) {
    var parts = line.split('|');
    if (parts.length < 3) return null;
    var sheet = parts[0].trim();
    var address = parts[1].trim();
    // 值本身可能含 `|`，所以第三个起全部拼回去，不做二次切分。
    var value = parts.slice(2).join('|');
    if (sheet.length === 0 || address.length === 0) return null;
    return { sheet: sheet, address: address, value: value };
  }

  function parseEdits(format, text) {
    var spec = formatSpec(format);
    var errors = [];
    var edits = [];
    if (spec === null) {
      return { ok: false, edits: [], errors: ['未知格式：' + String(format)] };
    }
    var lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (line.length === 0 || line.charAt(0) === '#') continue;
      if (format === 'xlsx') {
        if (line.charAt(0) === '+') {
          var name = line.slice(1).trim();
          if (name.length === 0) {
            errors.push('第 ' + String(i + 1) + ' 行：+ 后面要写表名');
            continue;
          }
          edits.push({ op: 'add_sheet', name: name });
          continue;
        }
        var row = splitRow(line);
        if (row === null) {
          errors.push('第 ' + String(i + 1) + ' 行：表格编辑要写成「表名 | 地址 | 值」');
          continue;
        }
        edits.push({ op: 'set_cell', sheet: row.sheet, address: row.address, value: cellValueOf(row.value) });
        continue;
      }
      // pptx：一行一页
      edits.push({ op: 'add_slide', title: line });
    }
    return { ok: errors.length === 0 && edits.length > 0, edits: edits, errors: errors };
  }

  /** 记法的说明文字（页面直接显示，避免用户猜格式）。 */
  function editHintFor(format) {
    if (format === 'pptx') {
      return '每行 = 一页的标题（第一行是封面）。页数由你写几行决定，不是固定两页。' +
        '以 # 开头的行被当作注释忽略。';
    }
    return '每行一条：`表名 | 地址 | 值`（例如 `Sheet1 | A1 | 季度`）；' +
      '`+表名` 新建一张表（例如 `+明细`）。值是纯数字时按数值写入，否则按文本。' +
      '以 # 开头的行被当作注释忽略。';
  }

  /** 会话/交付物 id：只用契约允许的安全字符（1–128 位）。 */
  function safeId(prefix, nowMs, salt) {
    var time = Math.floor(Number(nowMs) || 0).toString(36);
    var extra = String(salt === undefined ? '' : salt).replace(/[^A-Za-z0-9]/g, '');
    return String(prefix) + '-' + time + (extra.length > 0 ? '-' + extra : '');
  }

  /* ------------------------------------------------------------------ *
   * 回执 → 人话
   * ------------------------------------------------------------------ */

  /** 交付一版之后的回执（来自 `POST /api/deliverables/:id/edits` 的 200）。 */
  function describeDelivery(sessionId, body) {
    var version = body && typeof body === 'object' ? body.version : null;
    if (version === null || typeof version !== 'object') {
      return null;
    }
    return {
      sessionId: sessionId,
      editRevision: Number(body.editRevision),
      replayed: body.replayed === true,
      filename: typeof version.filename === 'string' ? version.filename : null,
      fileFormat: typeof version.fileFormat === 'string' ? version.fileFormat : null,
      mimeType: typeof version.mimeType === 'string' ? version.mimeType : null,
      templateKind: typeof version.templateKind === 'string' ? version.templateKind : null,
      byteLength: typeof version.byteLength === 'number' ? version.byteLength : null,
      contentDigest: typeof version.contentDigest === 'string' ? version.contentDigest : null,
      artifactId: typeof version.artifactId === 'string' ? version.artifactId : null
    };
  }

  /**
   * 失败如实显示：服务端给什么写什么，**不替换成温和的笼统话**。
   * 返回 { code, message, retryable, text }。
   */
  function describeFailure(status, body) {
    var code = body && typeof body.code === 'string' ? body.code : '';
    var message = body && typeof body.message === 'string' ? body.message : '';
    if (message.length === 0 && body && typeof body.raw === 'string' && body.raw.length > 0) {
      message = body.raw.slice(0, 200);
    }
    /* 三态而不是两态：服务端**没说**的时候，"可重试"与"不可重试"都不能替它认领。
       （两态会把"没说"悄悄算成"不可重试"，那是在替服务端下结论。） */
    var retryable = body && typeof body.retryable === 'boolean' ? body.retryable : null;
    var retryNote = retryable === true
      ? '（服务端标记为可重试）'
      : (retryable === false ? '（服务端标记为不可重试）' : '（服务端没有说明是否可重试）');
    var head = 'HTTP ' + String(status) + (code.length > 0 ? ' · ' + code : '');
    return {
      code: code.length > 0 ? code : 'http_' + String(status),
      message: message.length > 0 ? message : '服务端没有给出说明',
      retryable: retryable,
      text: head + '：' + (message.length > 0 ? message : '服务端没有给出说明') + retryNote
    };
  }

  /* ------------------------------------------------------------------ *
   * 完成口径的呈现（R261–R263）
   * ------------------------------------------------------------------ */

  var COMPLETION_LABELS = {
    not_completed: '尚未完成',
    completed_and_successful: '已完成且成功',
    completed_with_unfinished_business: '已完成但有未成之事',
    completed_and_cancelled: '已完成且被取消'
  };

  var SUCCESS_TEXT = {
    not_completed: '还没有结论：仍有未了之事。',
    completed_and_successful: '办成了：产物已发布并回读。',
    completed_with_unfinished_business: '没全办成：有工作项失败 / 动作结果未知 / 没有已交付的产物。',
    completed_and_cancelled: '被取消：没有未了之事，但有工作项是被取消的。'
  };

  /**
   * 把 `/api/deliverables/:id/completion` 的响应翻成页面要显示的两行。
   *
   * **完成与成功分开**（R263）：`completedText` 只回答"有没有未了之事"，
   * `successText` 才回答"办成了没有"。两者**不得**合并成一句"已完成"。
   */
  function labelForCompletion(view) {
    if (view === null || typeof view !== 'object') return null;
    var completed = view.completed === true;
    var label = typeof view.label === 'string' && COMPLETION_LABELS[view.label] ? view.label : null;
    if (label === null) {
      label = completed ? 'completed_and_successful' : 'not_completed';
    }
    var predicates = view.predicates && typeof view.predicates === 'object' ? view.predicates : {};
    return {
      completed: completed,
      label: label,
      labelText: typeof view.labelText === 'string' ? view.labelText : COMPLETION_LABELS[label],
      detail: typeof view.detail === 'string' ? view.detail : '',
      completedText: completed ? '已完成（没有未了之事）' : '尚未完成（还有未了之事）',
      successText: SUCCESS_TEXT[label],
      predicates: {
        allWorkItemsTerminal: predicates.allWorkItemsTerminal === true,
        noInFlightRuns: predicates.noInFlightRuns === true,
        noUnresolvedActions: predicates.noUnresolvedActions === true
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 出口
   * ------------------------------------------------------------------ */

  var api = {
    FORMATS: FORMATS,
    COMPLETION_LABELS: COMPLETION_LABELS,
    formatSpec: formatSpec,
    pathOpen: pathOpen,
    pathEdits: pathEdits,
    pathDownload: pathDownload,
    pathStatus: pathStatus,
    pathCompletion: pathCompletion,
    planOpen: planOpen,
    planEdit: planEdit,
    planDownload: planDownload,
    planStatus: planStatus,
    planCompletion: planCompletion,
    parseEdits: parseEdits,
    cellValueOf: cellValueOf,
    editHintFor: editHintFor,
    safeId: safeId,
    describeDelivery: describeDelivery,
    describeFailure: describeFailure,
    labelForCompletion: labelForCompletion
  };

  if (typeof window !== 'undefined') {
    window.PotbotDeliverables = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.PotbotDeliverables = api;
  }
})();
