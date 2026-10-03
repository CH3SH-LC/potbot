/*
 * potbot 手机 Word Demo —— 节（页面设置）意图的页面侧镜像与校验（section-intent.js）
 *
 * 由来（design-05-P4：WF-045–055 的**用户入口**）：
 *   内核侧那条链已经存在并可发布字节——`src/documents/session/section-ops.ts`
 *   （`compileSectionIntent` → `applySectionPlan`）+ `apps/demo/server/http.ts` 的
 *   `POST /api/sessions/:id/edits` 接受 `sectionIntent`（与 `intent` **二选一**）。
 *   但手机页面上**没有任何地方能发起它**（WCF-D61 自己登记的缺口）。本文件补的就是这一层：
 *   把「选了哪一节 + 点了哪个控件 + 给了什么值」翻成 `SectionEditIntent`。
 *
 * ## 与 `edit-intent.js` 的关系（**刻意分开，不合并**）
 *
 * `edit-intent.js` 翻的是**段落/字符**域（范围表达式 + `EditOperation`），
 * 本文件翻的是**节**域（节索引 + `SectionOperationIntent`）。两者的作用域语法不同，
 * 服务端也**不允许**在同一个请求里同时给（`intent` xor `sectionIntent`，给两个 = 400）。
 * 因此是两个模块、两条入口，而不是一个数组里混两种步骤。
 *
 * ## 三条纪律（与内核逐条对齐）
 *
 * 1. **作用节没有默认值**：必须显式给出 `{kind:'all'}` / `{kind:'current',index}` /
 *    `{kind:'indices',indices}`。页面上「未指定」是一个**真正的空选项**，
 *    `buildStep` 会以 `no_scope` 拒绝并且**不发请求**——R108 要挡的正是
 *    "改了一个节却动了全文"这类静默行为。
 * 2. **值必须带单位**（R127/R128）：长度一律 `{unit, value}`，本层**不换算**，
 *    原样搬运给内核（换算是 `units/**` 的事）。
 * 3. **翻不出来就不提交**：未知控件 / 未知取值 / 空节列表一律返回结构化拒绝并说明原因，
 *    既不降级成别的操作，也不"看着像就往上套"。
 *
 * ## 回显标签是**派生**的
 *
 * `label`（`全文` / `第2节`）由作用范围派生（`scopeLabel`），不接受调用方自报——
 * 自报就会与真实作用范围分叉。这条与内核 `sectionScopeLabel` 同一条纪律，
 * 测试用**真实的**那个函数对拍，防止两边漂移。
 *
 * 载入方式：`<script src="./section-intent.js">`（在 app.js 之前）⇒ 全局 `PotbotSectionIntent`。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotSectionIntent = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /* ===================== 镜像（来源：src/documents/sections/types.ts 与 session/section-ops.ts） ===================== */

  /** 纸张预设名（逐字镜像 `PAGE_SIZE_PRESET_NAMES`）。**尺寸由内核给，本页只给名字**。 */
  var PAGE_SIZE_PRESET_NAMES = Object.freeze(['A4', 'A3', 'A5', 'Letter', 'Legal']);

  /** 页面方向（镜像 `PageOrientation`）。 */
  var ORIENTATIONS = Object.freeze(['portrait', 'landscape']);

  /** 页码格式（镜像 `PAGE_NUMBER_FORMATS`，**顺序也逐字一致**）。 */
  var PAGE_NUMBER_FORMATS = Object.freeze([
    'decimal', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter',
    'chineseCounting', 'chineseCountingThousand', 'ideographDigital'
  ]);

  /** 页码格式的示例（**只用于显示**，不是取值）。 */
  var PAGE_NUMBER_FORMAT_HINTS = Object.freeze({
    decimal: '1, 2, 3', upperRoman: 'I, II, III', lowerRoman: 'i, ii, iii',
    upperLetter: 'A, B, C', lowerLetter: 'a, b, c',
    chineseCounting: '一, 二, 三', chineseCountingThousand: '一千, 一千零一',
    ideographDigital: '壹, 贰, 叁'
  });

  /** 长度单位（镜像 `IntentLength['unit']` / `units/**` 的记号）。 */
  var LENGTH_UNITS = Object.freeze(['pt', 'mm', 'cm', 'inch', 'twips']);

  /** 页内垂直对齐（镜像 `SECTION_VERTICAL_ALIGNS`）。 */
  var SECTION_VERTICAL_ALIGNS = Object.freeze(['top', 'center', 'bottom', 'both']);

  /** 单次意图的步骤上限（镜像 `SESSION_LIMITS.maxStepsPerIntent`）。 */
  var MAX_STEPS_PER_INTENT = 64;

  /** 一条长度必须是 `{unit, value}`（R127）——不写裸数字。 */
  function length(unit, value) {
    return { unit: unit, value: value };
  }

  /* ===================== 作用范围 ===================== */

  function scopeAll() { return { kind: 'all' }; }
  function scopeCurrent(index) { return { kind: 'current', index: index }; }
  function scopeIndices(indices) { return { kind: 'indices', indices: indices.slice() }; }

  /**
   * 作用范围 → 回显标签。**派生**，与内核 `sectionScopeLabel` 同一口径：
   * `全文` / `第2节` / `第1,3节`（空列表⇒空串，由调用方拒绝，不在这里编一个名字）。
   */
  function scopeLabel(scope) {
    if (scope === null || typeof scope !== 'object') return '';
    if (scope.kind === 'all') return '全文';
    if (scope.kind === 'current') return '第' + String(scope.index + 1) + '节';
    if (scope.kind === 'indices') {
      var seen = {};
      var list = [];
      for (var i = 0; i < scope.indices.length; i++) {
        var value = scope.indices[i];
        if (seen[value] === true) continue;
        seen[value] = true;
        list.push(value);
      }
      list.sort(function (left, right) { return left - right; });
      var parts = [];
      for (var p = 0; p < list.length; p++) parts.push(String(list[p] + 1));
      return '第' + parts.join(',') + '节';
    }
    return '';
  }

  /**
   * 下拉框的取值 → 作用范围。**未指定返回 `null`**（不是一个"默认全文"）：
   * `''` = 用户还没有选节；`'all'` = 全文；`'0'|'1'|…` = 第 N 节（0 起的节索引）。
   * 负例（"未指定时报错"）由 `buildStep` 消费这个 `null` 来产生。
   */
  function readScopeFromChoice(choice) {
    if (choice === null || choice === undefined) return null;
    var text = String(choice);
    if (text === '' ) return null;
    if (text === 'all') return scopeAll();
    if (!/^[0-9]+$/.test(text)) return null;
    var index = Number(text);
    if (!isFinite(index) || Math.floor(index) !== index) return null;
    return scopeCurrent(index);
  }

  /** 作用范围下拉框的选项（**第一项是空的"未指定"**：默认必须是"没说"而不是"全文"）。 */
  function scopeOptions(sectionCount) {
    var options = [{ value: '', label: '（未指定——请先选一节）' }];
    for (var i = 0; i < sectionCount; i++) {
      options.push({ value: String(i), label: '第 ' + String(i + 1) + ' 节' });
    }
    options.push({ value: 'all', label: '全文（所有节）' });
    return options;
  }

  /* ===================== 控件定义 ===================== */

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /** 纸张大小：只给预设名，尺寸由内核查表（本页不搬运 210×297 这类数字）。 */
  function pageSizePresetOperation(preset) {
    if (typeof preset !== 'string' || PAGE_SIZE_PRESET_NAMES.indexOf(preset) === -1) {
      return { ok: false, message: '纸张预设必须是 ' + PAGE_SIZE_PRESET_NAMES.join(' / ') + ' 之一。' };
    }
    return { ok: true, operation: { kind: 'setPageSizePreset', preset: preset } };
  }

  /** 纸张方向。**不给 `fallback_size`**：该节没设过纸张时内核就不替他猜 A4（R118 的延伸）。 */
  function orientationOperation(orientation) {
    if (typeof orientation !== 'string' || ORIENTATIONS.indexOf(orientation) === -1) {
      return { ok: false, message: '页面方向必须是 portrait / landscape 之一。' };
    }
    return { ok: true, operation: { kind: 'setOrientation', orientation: orientation } };
  }

  /** 页边距：四边**必给**（OOXML `w:pgMar` 四边是必填），装订线可省（缺省 0）。 */
  function marginsOperation(value) {
    if (value === null || typeof value !== 'object') {
      return { ok: false, message: '页边距必须给出 {top,right,bottom,left,unit}。' };
    }
    if (LENGTH_UNITS.indexOf(value.unit) === -1) {
      return { ok: false, message: '页边距的 unit 必须是 ' + LENGTH_UNITS.join(' / ') + ' 之一。' };
    }
    var edges = ['top', 'right', 'bottom', 'left'];
    var margins = {};
    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      var raw = value[edge];
      if (!isFiniteNumber(raw) || raw < 0) {
        return { ok: false, message: '页边距的 ' + edge + ' 必须是 ≥0 的有限数字。' };
      }
      margins[edge] = length(value.unit, raw);
    }
    if (value.gutter !== undefined && value.gutter !== null) {
      if (!isFiniteNumber(value.gutter) || value.gutter < 0) {
        return { ok: false, message: '装订线必须是 ≥0 的有限数字。' };
      }
      margins.gutter = length(value.unit, value.gutter);
    }
    return { ok: true, operation: { kind: 'setMargins', margins: margins } };
  }

  /** 页码格式。 */
  function pageNumberFormatOperation(format) {
    if (typeof format !== 'string' || PAGE_NUMBER_FORMATS.indexOf(format) === -1) {
      return { ok: false, message: '页码格式必须是 ' + PAGE_NUMBER_FORMATS.join(' / ') + ' 之一。' };
    }
    return { ok: true, operation: { kind: 'setPageNumberFormat', format: format } };
  }

  var CONTROLS = Object.freeze([
    { id: 'pageSizePreset', label: '纸张大小', input: 'choice', values: PAGE_SIZE_PRESET_NAMES,
      build: pageSizePresetOperation },
    { id: 'orientation', label: '纸张方向', input: 'choice', values: ORIENTATIONS,
      build: orientationOperation },
    { id: 'margins', label: '页边距', input: 'margins', build: marginsOperation },
    { id: 'pageNumberFormat', label: '页码格式', input: 'choice', values: PAGE_NUMBER_FORMATS,
      build: pageNumberFormatOperation },
    { id: 'restartPageNumbering', label: '本节页码从 1 重新开始', input: 'action',
      build: function () { return { ok: true, operation: { kind: 'restartPageNumbering' } }; } },
    { id: 'continuePageNumbering', label: '页码接上一节', input: 'action',
      build: function () { return { ok: true, operation: { kind: 'setPageNumberStart', start: null } }; } }
  ]);

  var CONTROL_BY_ID = {};
  for (var ci = 0; ci < CONTROLS.length; ci++) CONTROL_BY_ID[CONTROLS[ci].id] = CONTROLS[ci];

  /* ===================== 本地校验（镜像 compileSectionIntent 的准入） ===================== */

  var SUPPORTED_OPERATION_KINDS = Object.freeze([
    'setPageSizePreset', 'setPageSize', 'setOrientation', 'setMargins',
    'setPageNumberFormat', 'setPageNumberStart', 'restartPageNumbering',
    'setVerticalAlign', 'setColumnCount'
  ]);

  function isRecord(value) {
    return typeof value === 'object' && value !== null && Array.isArray(value) === false;
  }

  /**
   * 本地预检一步节操作能否被内核编译器接受。
   * 返回 `null`（可提交）或 `{code, message}`（**不提交**，附原因）。
   * 镜像的是 `compileSectionIntent` 的 `compileScope` + `compileOperation`；
   * 测试用**真实**的那个编译器对拍（`section-intent.test.ts`）。
   */
  function localRejection(step) {
    if (!isRecord(step)) return { code: 'invalid_expression', message: '步骤必须是对象。' };
    var scope = step.section;
    if (!isRecord(scope)) {
      return { code: 'no_scope', message: '这一步没有作用节：请显式指定「哪一节」或「全文」。' };
    }
    if (scope.kind === 'current') {
      if (!isNonNegativeInteger(scope.index)) {
        return { code: 'invalid_expression', message: '节索引必须是非负整数。' };
      }
    } else if (scope.kind === 'indices') {
      if (!Array.isArray(scope.indices)) {
        return { code: 'invalid_expression', message: 'indices 必须是数组。' };
      }
      if (scope.indices.length === 0) {
        return { code: 'empty_range', message: '节列表为空：按 R112，命中零项不得静默无操作。' };
      }
      for (var i = 0; i < scope.indices.length; i++) {
        if (!isNonNegativeInteger(scope.indices[i])) {
          return { code: 'invalid_expression', message: '节列表里的每一项都必须是非负整数。' };
        }
      }
    } else if (scope.kind !== 'all') {
      return { code: 'invalid_expression', message: '作用节必须是 all / current / indices 之一。' };
    }

    var operation = step.operation;
    if (!isRecord(operation)) return { code: 'invalid_expression', message: '操作必须是对象。' };
    var kind = operation.kind;
    if (typeof kind !== 'string') return { code: 'invalid_expression', message: '操作缺少 kind。' };
    if (SUPPORTED_OPERATION_KINDS.indexOf(kind) === -1) {
      return { code: 'unsupported', message: '内核节操作不支持 ' + kind + '。' };
    }
    if (kind === 'setPageSizePreset' && PAGE_SIZE_PRESET_NAMES.indexOf(operation.preset) === -1) {
      return { code: 'unsupported', message: '纸张预设不在内核名单里。' };
    }
    if (kind === 'setOrientation' && ORIENTATIONS.indexOf(operation.orientation) === -1) {
      return { code: 'unsupported', message: '页面方向不是 portrait / landscape。' };
    }
    if (kind === 'setPageNumberFormat' && PAGE_NUMBER_FORMATS.indexOf(operation.format) === -1) {
      return { code: 'unsupported', message: '页码格式不在内核名单里。' };
    }
    if (kind === 'setVerticalAlign' && SECTION_VERTICAL_ALIGNS.indexOf(operation.align) === -1) {
      return { code: 'unsupported', message: '页内垂直对齐不在内核名单里。' };
    }
    if (kind === 'setPageNumberStart' && operation.start !== null && !isNonNegativeInteger(operation.start)) {
      return { code: 'invalid_expression', message: '起始页码必须是非负整数或 null（接上一节）。' };
    }
    if (kind === 'setColumnCount' && !(isNonNegativeInteger(operation.count) && operation.count >= 1)) {
      return { code: 'invalid_expression', message: '栏数必须是正整数。' };
    }
    if (kind === 'setMargins') {
      var margins = operation.margins;
      if (!isRecord(margins)) return { code: 'invalid_expression', message: '页边距必须是对象。' };
      var edges = ['top', 'right', 'bottom', 'left'];
      for (var e = 0; e < edges.length; e++) {
        var compiled = checkLength(margins[edges[e]]);
        if (compiled !== null) return compiled;
      }
      if (margins.gutter !== undefined && margins.gutter !== null) {
        var gutter = checkLength(margins.gutter);
        if (gutter !== null) return gutter;
      }
    }
    if (kind === 'setPageSize') {
      var width = checkLength(operation.width);
      if (width !== null) return width;
      var height = checkLength(operation.height);
      if (height !== null) return height;
    }
    return null;
  }

  function isNonNegativeInteger(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= 0;
  }

  function checkLength(raw) {
    if (!isRecord(raw)) return { code: 'invalid_expression', message: '长度必须是 {unit, value} 对象。' };
    if (LENGTH_UNITS.indexOf(raw.unit) === -1) {
      return { code: 'invalid_expression', message: '长度的 unit 必须是 ' + LENGTH_UNITS.join(' / ') + ' 之一（R127）。' };
    }
    if (!isFiniteNumber(raw.value)) {
      return { code: 'invalid_expression', message: '长度的 value 必须是有限数。' };
    }
    return null;
  }

  /* ===================== 组装 ===================== */

  /**
   * 把「作用节 + 控件 + 值」翻成一步节意图。
   * 返回 `{ok:true, step:{domain:'section', section, operation, label}}`
   * 或 `{ok:false, code, message}`。**翻不出来就不提交**。
   *
   * `scope` 为 `null`（页面上"未指定"）时以 `no_scope` 拒绝——
   * 这是任务书要求的负例，且**不会**退化成"作用于全文"。
   */
  function buildStep(scope, controlId, value) {
    if (scope === null || scope === undefined) {
      return {
        ok: false, code: 'no_scope',
        message: '还没有指定作用节。多节文档里必须明确「改哪一节」或「全文」——' +
          '本页不会替你默认成全文（R108：局部页面设置不得污染其他节）。'
      };
    }
    var control = CONTROL_BY_ID[controlId];
    if (control === undefined) {
      return { ok: false, code: 'unknown_control', message: '不认识的节控件：' + String(controlId) };
    }
    var built = control.build(value);
    if (!built.ok) {
      return { ok: false, code: 'invalid_value', message: control.label + '：' + built.message };
    }
    var step = { domain: 'section', section: scope, operation: built.operation, label: scopeLabel(scope) };
    var rejection = localRejection(step);
    if (rejection !== null) {
      return { ok: false, code: rejection.code, message: control.label + '：' + rejection.message };
    }
    return { ok: true, step: step };
  }

  /** 一组步骤 → 一次提交的节意图（`{steps:[{section, operation}]}`）。 */
  function toSectionIntent(steps) {
    var list = Array.isArray(steps) ? steps : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push({ section: list[i].section, operation: list[i].operation });
    }
    return { steps: out };
  }

  /** 步骤是否属于节域（暂存栈里两种域的步骤混放，靠这一条分流）。 */
  function isSectionStep(step) {
    return isRecord(step) && step.domain === 'section';
  }

  return {
    PAGE_SIZE_PRESET_NAMES: PAGE_SIZE_PRESET_NAMES,
    ORIENTATIONS: ORIENTATIONS,
    PAGE_NUMBER_FORMATS: PAGE_NUMBER_FORMATS,
    PAGE_NUMBER_FORMAT_HINTS: PAGE_NUMBER_FORMAT_HINTS,
    LENGTH_UNITS: LENGTH_UNITS,
    SECTION_VERTICAL_ALIGNS: SECTION_VERTICAL_ALIGNS,
    MAX_STEPS_PER_INTENT: MAX_STEPS_PER_INTENT,
    SUPPORTED_OPERATION_KINDS: SUPPORTED_OPERATION_KINDS,
    CONTROLS: CONTROLS,
    controlById: function (id) { return CONTROL_BY_ID[id] || null; },
    scopeAll: scopeAll,
    scopeCurrent: scopeCurrent,
    scopeIndices: scopeIndices,
    scopeLabel: scopeLabel,
    scopeOptions: scopeOptions,
    readScopeFromChoice: readScopeFromChoice,
    buildStep: buildStep,
    localRejection: localRejection,
    toSectionIntent: toSectionIntent,
    isSectionStep: isSectionStep
  };
});
