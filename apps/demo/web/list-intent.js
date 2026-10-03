/*
 * potbot 手机 Word Demo —— 列表 / 编号入口（list-intent.js；FA-N 接线）
 *
 * ## 这一版和上一版的区别（**是真的接线了，不是改文案**）
 *
 * 上一版（WCF-D72）记的是当时的事实：`list-intent.js` 的 `KERNEL_LIST_OPERATION_KINDS`
 * 是**空数组**，四个控件点下去只会返回 `{ok:false, code:'unsupported'}`。那条记录是对的
 * ——当时 `http.ts` 的 `/edits` 只接受 `intent` / `sectionIntent` 两条，列表意图**到不了**内核。
 *
 * FA-N 把缺的那两段补上了（写权都在本包内）：
 *
 * | 之前 | 现在 | 在哪 |
 * |---|---|---|
 * | `http.ts` 只认 `intent` / `sectionIntent` | 三选一，多一条 `listIntent` | `apps/demo/server/http.ts` |
 * | 会话宿主不透传列表意图 | `submitEdit` 透传 `list_intent` | `apps/demo/server/session-host.ts` |
 * | 本模块声明"内核没有" | 声明**有**，并产出真正的 step | 本文件 |
 *
 * 内核侧本来就有（`src/documents/session/list-ops.ts` + `src/documents/numbering/**`）：
 * 应用 / 取消项目符号与编号、换级、重启编号，全是不可变更新的纯函数，而且
 * **只写 `numPr` 引用、绝不往正文塞 `•` / `1.`**。
 *
 * ## 判据（**没有任何一条**是"看起来像"）
 *
 * 1. `buildStep(range, controlId, level?)` 产出的是**结构化操作**，形状与
 *    `src/documents/session/list-ops.ts` 的 `ListIntentOperation` 逐字一致；
 * 2. 没有范围表达式 ⇒ `{ok:false, code:'no_range'}`，**不**产出"给全文加符号"这种默认；
 * 3. 本模块**没有任何写文本的入口**——`fabricatesTextPrefix` 恒为 `false`，
 *    且代码里不存在能把它变 true 的路径（`tests/demo` 逐字断言预览文本不变）。
 *
 * ## 级别的表示（**0-based 对内核，1-based 对人**）
 *
 * 内核的 `level` 是 0–8（`MAX_LIST_LEVEL`）；页面上说"1–9 级"。本模块只在**边界**上换算，
 * 内部一律传内核值——两套编号混着传是这类功能最容易出的静默错误。
 *
 * 载入方式：`<script src="./list-intent.js">`（在 app.js 之前）⇒ 全局 `PotbotListIntent`。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotListIntent = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /**
   * 内核**当前**开放的列表意图种类（镜像 `list-ops.ts` 的 `ListIntentOperation['kind']`）。
   *
   * 与 `session/intent.ts` 的字符/段落白名单不同，这四种**不在**那份白名单里：
   * 列表意图走的是会话包的**第四条入口**（`list_intent`），因为应用列表要判
   * "这个 `numId` 指得对不对"就必须拿到编号表，而表刻意不在冻结骨架里。
   */
  var KERNEL_LIST_OPERATION_KINDS = Object.freeze([
    'applyList', 'removeList', 'setListLevel', 'restartList'
  ]);

  /** 内核的级别上限（`MAX_LIST_LEVEL`，0-based）。 */
  var MAX_LIST_LEVEL = 8;

  /** 页面上要显示的四个控件（名字与 WF-035–044 的说法一致）。 */
  var CONTROLS = Object.freeze([
    { id: 'bullet', label: '项目符号', note: '给选中段落套用项目符号列表', kind: 'applyList', style: 'bullet' },
    { id: 'numbered', label: '编号列表', note: '给选中段落套用编号列表', kind: 'applyList', style: 'numbered' },
    { id: 'restartNumbering', label: '重启编号', note: '让选中段落从 1 重新开始编号', kind: 'restartList' },
    { id: 'removeList', label: '取消列表', note: '把选中段落从列表里摘出来（保留文字）', kind: 'removeList' }
  ]);

  var CONTROL_BY_ID = {};
  for (var ci = 0; ci < CONTROLS.length; ci++) CONTROL_BY_ID[CONTROLS[ci].id] = CONTROLS[ci];

  /** 可用的说明（四项**真的可用**时页面显示这句；不是"暂不可用"的占位）。 */
  var AVAILABLE_NOTE =
    '四项都走内核的结构化列表（`w:numPr` 引用 + `numbering.xml`），**不会**往正文里塞 ' +
    '`•` / `1.`——列表是结构，不是文字。加符号 / 取消 / 重启编号都会经 /edits 的 ' +
    'listIntent 提交为一次事务（一次提交 = 一个版本）。';

  /** 能力状态：`available`（内核有列表意图） / `unavailable`（内核没有）。 */
  function capability() {
    return KERNEL_LIST_OPERATION_KINDS.length > 0 ? 'available' : 'unavailable';
  }

  /** 把"当前能力"作为一个可断言的记录返回（测试与完成报告都读它，不读自然语言）。 */
  function gap() {
    return {
      capability: capability(),
      kernelOperationKinds: KERNEL_LIST_OPERATION_KINDS.slice(),
      controls: CONTROLS.map(function (control) { return control.id; }),
      reason: AVAILABLE_NOTE,
      /** 页面是否会在本地伪造文本前缀。**恒为 false**，且没有让它变 true 的代码路径。 */
      fabricatesTextPrefix: false,
      /** 内核侧的实现层（供复核者按图索骥）。 */
      kernelLayer: 'src/documents/session/list-ops.ts + src/documents/numbering/**',
      /** HTTP 入口（FA-N 补上的那一段）。 */
      httpEntry: 'POST /api/sessions/:id/edits 的 listIntent 字段'
    };
  }

  function isPlainRange(range) {
    return typeof range === 'string' && range.trim().length > 0;
  }

  /**
   * 归一化级别：本函数只认**内核口径（0-based，0–8）**。
   *
   * 为什么不"顺便"也接受 1-based：两套编号在 1–8 上**完全重叠**，
   * 任何"看着像 1-based 就减一"的猜测都会让"1 级"变成"2 级"——正是这类功能最容易
   * 出的静默错误。换算只允许发生在**调用点**（`app.js` 的 `listLevelFromUi()` 减一），
   * 那里能同时看到两边。
   *
   * 返回 `null` = 非法（调用方据此拒绝，**不**猜一个默认级别）。
   */
  function normalizeLevel(value) {
    var raw = value;
    if (raw !== null && typeof raw === 'object') raw = raw.level;
    if (raw === undefined || raw === null || raw === '') return 0;
    if (typeof raw !== 'number' || !isFinite(raw) || Math.floor(raw) !== raw) return null;
    if (raw < 0 || raw > MAX_LIST_LEVEL) return null;
    return raw;
  }

  /**
   * 产出一条列表步骤。
   *
   * 返回形状与 `section-intent.js` 的 `buildStep` 同构：
   *   `{ok:true, step:{range, operation}}` 或 `{ok:false, code, message}`。
   * **翻不出来就不提交**：没有范围表达式 / 不认识的控件 / 非法级别一律结构化拒绝，
   * 不降级成"给全文加符号"，也不写任何文字。
   */
  function buildStep(range, controlId, value) {
    if (!isPlainRange(range)) {
      return {
        ok: false, code: 'no_range',
        message: '还没有可用的范围表达式：请先在预览里选中一段文字，再点列表控件。'
      };
    }
    var control = CONTROL_BY_ID[controlId];
    if (control === undefined) {
      return { ok: false, code: 'unknown_control', message: '不认识的列表控件：' + String(controlId) };
    }
    if (capability() !== 'available') {
      return {
        ok: false, code: 'unsupported',
        message: control.label + '：内核当前没有开放列表意图，本页不提交注定被拒的请求。'
      };
    }
    var operation;
    if (control.kind === 'applyList') {
      var level = normalizeLevel(value);
      if (level === null) {
        return {
          ok: false, code: 'invalid_value',
          message: control.label + '：级别必须是 0–' + String(MAX_LIST_LEVEL) + ' 的整数（页面上显示为 1–' +
            String(MAX_LIST_LEVEL + 1) + ' 级）。'
        };
      }
      operation = { kind: 'applyList', style: control.style, level: level };
    } else if (control.kind === 'restartList') {
      operation = { kind: 'restartList' };
    } else {
      operation = { kind: 'removeList' };
    }
    return { ok: true, step: { range: range, operation: operation } };
  }

  /** 把一组步折叠成一次提交的列表意图（`{steps}`）——与 `edit-intent.js` 的 `toIntent` 同构。 */
  function toListIntent(steps) {
    var list = Array.isArray(steps) ? steps : [];
    return { steps: list.slice() };
  }

  /** 这一步是不是列表步骤（`app.js` 保存时据此分桶）。 */
  function isListStep(step) {
    if (step === null || typeof step !== 'object') return false;
    var operation = step.operation;
    if (operation === null || typeof operation !== 'object') return false;
    return KERNEL_LIST_OPERATION_KINDS.indexOf(operation.kind) !== -1;
  }

  return {
    KERNEL_LIST_OPERATION_KINDS: KERNEL_LIST_OPERATION_KINDS,
    MAX_LIST_LEVEL: MAX_LIST_LEVEL,
    CONTROLS: CONTROLS,
    AVAILABLE_NOTE: AVAILABLE_NOTE,
    controlById: function (id) { return CONTROL_BY_ID[id] || null; },
    capability: capability,
    gap: gap,
    buildStep: buildStep,
    toListIntent: toListIntent,
    isListStep: isListStep
  };
});
