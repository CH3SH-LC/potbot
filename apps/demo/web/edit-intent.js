/*
 * potbot 手机 Word Demo —— 直接控件的编辑意图、暂存栈与回执分类（edit-intent.js）
 *
 * 由来（design-05-P8：WF-083 保存、WF-086 撤销重做、WF-088 选区）：
 *   内核收的是**结构化编辑意图** `{steps:[{range, operation}]}`（见
 *   `src/documents/session/intent.ts`）。手机上用户点的是按钮、拉的是选择框，
 *   本文件负责把「控件 + 值 + 范围表达式」翻成那个形状，并且**只翻内核已支持的**：
 *
 *   - 支持的操作名与**意图层白名单逐字一致**（`setToggle` / `toggle` / `setValue` /
 *     `inherit` / `unsetValue` / `clearDirectFormat` / 八个段落操作）；
 *   - **带值型属性（下划线样式 / 颜色 / 高亮 / 上下标等）在意图层没有 `setValue` 通道**
 *     （内核只开了**字体 `fonts`** 与**字号 `size`** 两条，见 `compileSetValue`），因此本页
 *     **只放行这两条**：其余带值属性 `buildStep` 直接返回本地拒绝并说明原因，
 *     既不假装成功，也不把注定 422 的请求发出去。测试用真实的 `compileEditIntent`
 *     断言这条镜像不会漂移（见 `tests/demo/word-ui/edit-intent.test.ts`）。
 *
 * ## 一次复合指令 = 一次事务 = 一次 revision（WF-086）
 *   `createStaging()` 是**提交前的暂存栈**：用户连续点若干格式 = 若干步；
 *   只有点「保存」才把整个栈作为**一个 intent** 提交一次，因此 revision 只 +1。
 *   撤销 / 重做作用在这个**尚未提交**的栈上（跨保存的撤销需要服务端支持回退，
 *   不在本包范围——这条约定写在界面说明里，也写在接口声明里）。
 *
 * 载入方式：`<script src="./edit-intent.js">`（在 app.js 之前）⇒ 全局 `PotbotEditIntent`。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotEditIntent = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  /* ===================== 镜像（来源：src/documents/session/intent.ts） ===================== */

  /** 意图层**已开放**的操作名（逐字镜像 `intent.ts` 的两个白名单）。 */
  var SUPPORTED_OPERATION_KINDS = Object.freeze([
    'setToggle', 'toggle', 'setValue', 'inherit', 'unsetValue', 'clearDirectFormat',
    'setAlignment', 'setLineSpacing', 'setSpacingBefore', 'setSpacingAfter',
    'setFirstLineIndent', 'setHangingIndent', 'setLeftIndent', 'setRightIndent',
    'clearParagraphFormat'
  ]);

  /**
   * 本页**放行的 `setValue` 属性**（逐字镜像 `intent.ts` 的 `compileSetValue`）。
   *
   * 内核在这个通道上**只开了两条**：字体 `fonts`（WF-006，中西文四槽分设）与字号 `size`
   * （WF-007，pt 或中文字号名）。其余带值属性（`underline` / `color` / `highlight` /
   * `shading` / `spacing` / `scale` / `position` / `vertAlign`）在**内核侧**就是 `unsupported`，
   * 本页因此**不放行**——本地拒掉，不发注定 422 的请求。
   */
  var SET_VALUE_PROPERTIES = Object.freeze(['fonts', 'size']);

  /**
   * 字体四槽位名（镜像内核 `IntentFontSet`）：`ascii` / `hAnsi` = 西文，`eastAsia` = 中文，
   * `cs` = 复杂文种。**未给的槽位 = 该槽不指定**（不是空串）。
   */
  var FONT_SLOTS = Object.freeze(['ascii', 'hAnsi', 'eastAsia', 'cs']);

  /** 开关型字符属性（镜像 `TOGGLE_PROPERTY_KEYS`）。 */
  var TOGGLE_PROPERTIES = Object.freeze(['bold', 'italic', 'strike', 'doubleStrike', 'caps', 'smallCaps']);

  /**
   * 十六项中文字号名（**来源：合同 `docs/other/prep/文档编辑合同-冻结v1（design-05批）.md` R129**，
   * 顺序 初号→八号）。R129 说"唯一权威实现"在内核 `src/documents/units/font-size.ts`
   * 的 `CHINESE_FONT_SIZE_NAMES`——本页是它的**镜像**，由
   * `tests/demo/word-ui/edit-intent.test.ts` 的对拍用例断言**与内核逐字相等**（漂移即红）。
   *
   * 为什么不从服务取：`apps/demo/server/**` 当前**没有**输出"可用值"的端点（已 grep 核实），
   * 因此来源按任务口径取**合同**，并以对拍测试锚定内核，**不另抄一份自造表**。
   */
  var CHINESE_FONT_SIZE_NAMES = Object.freeze([
    '初号', '小初', '一号', '小一', '二号', '小二', '三号', '小三',
    '四号', '小四', '五号', '小五', '六号', '小六', '七号', '八号'
  ]);

  /**
   * 带值型字符属性（镜像 `VALUED_PROPERTY_KEYS`）。
   * 它们都能被 `unsetValue` / `inherit` 碰到；**只有 `fonts` / `size` 两条**（见
   * `SET_VALUE_PROPERTIES`）有 `setValue` 写入通道，其余"设置"在本页不可提交。
   */
  var VALUED_PROPERTIES = Object.freeze([
    'underline', 'vertAlign', 'fonts', 'size', 'scale', 'position', 'color', 'highlight', 'shading', 'spacing'
  ]);

  /** 对齐取值（镜像 `ALIGNMENTS`）。 */
  var ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify', 'distribute']);

  /** 长度单位（镜像 `IntentLength['unit']`）。 */
  var LENGTH_UNITS = Object.freeze(['pt', 'mm', 'cm', 'inch', 'twips']);

  /** 单次意图的步骤上限（镜像 `SESSION_LIMITS.maxStepsPerIntent`）。 */
  var MAX_STEPS_PER_INTENT = 64;

  /** 本页**不接线**的能力与原因（不是"没做"，是"意图层未开这条通道"，如实写出来）。 */
  var UNWIRED_REASON =
    '内核意图层的 setValue 通道**只开放字体（fonts）与字号（size）**两条（其余带值属性——' +
    '下划线 / 颜色 / 高亮 / 底纹 / 字距 / 缩放 / 位置 / 上下标——内核一律判 unsupported），' +
    '本页不提交注定被拒的请求，因此这项暂不可用。';

  /* ===================== 控件定义 ===================== */

  function toggleOperation(property) {
    return function (value) {
      if (typeof value !== 'boolean') return { ok: false, message: '开关值必须是布尔值。' };
      return { ok: true, operation: { kind: 'setToggle', property: property, value: value } };
    };
  }

  function choiceOperation(kind, field, allowed) {
    return function (value) {
      if (typeof value !== 'string' || allowed.indexOf(value) === -1) {
        return { ok: false, message: '取值必须是 ' + allowed.join(' / ') + ' 之一。' };
      }
      var operation = { kind: kind };
      operation[field] = value;
      return { ok: true, operation: operation };
    };
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /* ---------- setValue：字体（fonts）与字号（size）的**共享**校验 ----------
     校验函数被 `buildStep` 的 build 与 `localRejection` **共用**（同一个函数，两处调用），
     避免"两套校验各自漂移"。规则逐条镜像 `intent.ts` 的 `compileIntentFonts` /
     `compileIntentFontSize`，由对拍测试用真实内核函数锚定。 */

  /** 字体四槽值：只带**非空**槽位；至少要有一个；字符串**不裁剪**（与内核逐字一致）。 */
  function checkFontsValue(value) {
    if (!isRecord(value)) {
      return { ok: false, message: '字体值必须是对象（形状：{ascii?, hAnsi?, eastAsia?, cs?}），' +
        '未给的槽位表示"该槽不指定"。' };
    }
    var resolved = {};
    var filled = 0;
    for (var i = 0; i < FONT_SLOTS.length; i++) {
      var slot = FONT_SLOTS[i];
      var slotValue = value[slot];
      if (slotValue === undefined || slotValue === null) continue;
      if (typeof slotValue !== 'string' || slotValue.trim().length === 0) {
        return { ok: false, message: '字体槽 ' + slot + ' 必须是非空字符串或留空（留空 = 该槽不指定），' +
          '收到 ' + JSON.stringify(slotValue) + '。' };
      }
      resolved[slot] = slotValue;
      filled++;
    }
    if (filled === 0) {
      return { ok: false, message: '字体至少要填一个槽位（西文 ascii / 西文扩展 hAnsi / 中文 eastAsia / ' +
        '复杂文种 cs）；四个都空等于什么都没设。' };
    }
    return { ok: true, value: resolved };
  }

  /**
   * 字号值：`{kind:'pt', value}` 或 `{kind:'chinese', name}`。
   * pt 必须是 **0.5 的整数倍且 ≥ 0.5pt**（`w:sz` 的半点粒度）——`12.3pt` 在这里就被拒，
   * **不四舍五入**（镜像内核的 `isRepresentableFontSize`，R140 禁止静默改值）。
   */
  function checkSizeValue(value) {
    if (!isRecord(value)) {
      return { ok: false, message: '字号值必须是对象（形状：{kind:"pt", value} 或 {kind:"chinese", name}）。' };
    }
    if (value.kind === 'pt') {
      if (!isFiniteNumber(value.value)) {
        return { ok: false, message: '字号的 pt 值必须是有限数字，收到 ' + JSON.stringify(value.value) + '。' };
      }
      var halfPoints = Math.round(value.value * 2);
      var exact = value.value * 2;
      if (Math.abs(exact - halfPoints) > 1e-9 || halfPoints < 1) {
        return { ok: false, message: '字号 ' + String(value.value) + 'pt 无法用 w:sz 精确表示' +
          '（粒度是 0.5pt，必须是 0.5 的整数倍且不小于 0.5pt）。本页**不替你四舍五入**——' +
          '请给出可精确表示的值（如 12 / 12.5 / 10.5）。' };
      }
      return { ok: true, value: { kind: 'pt', value: value.value } };
    }
    if (value.kind === 'chinese') {
      if (typeof value.name !== 'string' || CHINESE_FONT_SIZE_NAMES.indexOf(value.name) === -1) {
        return { ok: false, message: '中文字号名必须是 ' + CHINESE_FONT_SIZE_NAMES.join(' / ') +
          ' 之一，收到 ' + JSON.stringify(value.name) + '。' };
      }
      return { ok: true, value: { kind: 'chinese', name: value.name } };
    }
    return { ok: false, message: '字号的 kind 必须是 "pt" 或 "chinese"，收到 ' +
      JSON.stringify(value.kind) + '。' };
  }

  /** 字体：`{ascii?, hAnsi?, eastAsia?, cs?}` → `{kind:'setValue', property:'fonts', value}`。 */
  function fontsOperation(value) {
    var checked = checkFontsValue(value);
    if (!checked.ok) return { ok: false, message: checked.message };
    return { ok: true, operation: { kind: 'setValue', property: 'fonts', value: checked.value } };
  }

  /** 字号：`{kind:'pt',value}` / `{kind:'chinese',name}` → `{kind:'setValue', property:'size', value}`。 */
  function sizeOperation(value) {
    var checked = checkSizeValue(value);
    if (!checked.ok) return { ok: false, message: checked.message };
    return { ok: true, operation: { kind: 'setValue', property: 'size', value: checked.value } };
  }

  /** 行距：简单模式传字符串，自定义模式传 `{mode, value, unit}`。形状与内核逐条对齐。 */
  function lineSpacingOperation(value) {
    var spacing = (typeof value === 'string') ? { mode: value } : value;
    if (spacing === null || typeof spacing !== 'object') {
      return { ok: false, message: '行距取值必须是 mode 字符串或 {mode, value, unit} 对象。' };
    }
    var mode = spacing.mode;
    if (mode === 'single' || mode === 'oneAndHalf' || mode === 'double') {
      return { ok: true, operation: { kind: 'setLineSpacing', lineSpacing: { mode: mode } } };
    }
    if (mode === 'multiple') {
      if (!isFiniteNumber(spacing.value) || spacing.value <= 0) {
        return { ok: false, message: '多倍行距必须是正数。' };
      }
      return { ok: true, operation: { kind: 'setLineSpacing', lineSpacing: { mode: mode, value: spacing.value } } };
    }
    if (mode === 'exact' || mode === 'atLeast') {
      if (!isFiniteNumber(spacing.value) || LENGTH_UNITS.indexOf(spacing.unit) === -1) {
        return { ok: false, message: '固定 / 最小行距必须给出合法的 {unit, value}。' };
      }
      return {
        ok: true,
        operation: { kind: 'setLineSpacing', lineSpacing: { mode: mode, unit: spacing.unit, value: spacing.value } }
      };
    }
    return { ok: false, message: '行距模式不受支持：' + String(mode) };
  }

  /** 段间距：`{mode:'auto'}` / `{mode:'pt'|'lines', value}`。 */
  function spacingOperation(kind) {
    return function (value) {
      if (value === null || typeof value !== 'object') {
        return { ok: false, message: '段间距必须给出 {mode:"pt"|"lines"|"auto", value?}。' };
      }
      /* 意图层收的是 `{mode, value}`；`{kind:'pt'}` 是**执行器**那一侧的形状，
         在这里写错会在内核被判 invalid_expression（本文件的对拍测试抓过一次）。 */
      if (value.mode === 'auto') return { ok: true, operation: { kind: kind, spacing: { mode: 'auto' } } };
      if (value.mode !== 'pt' && value.mode !== 'lines') {
        return { ok: false, message: '段间距的 mode 必须是 "pt" | "lines" | "auto"。' };
      }
      if (!isFiniteNumber(value.value)) {
        return { ok: false, message: '段间距的 value 必须是有限数字。' };
      }
      return { ok: true, operation: { kind: kind, spacing: { mode: value.mode, value: value.value } } };
    };
  }

  /** 缩进：字符与长度**分开表达**（R130：`2 字` ≠ `2 cm`）。 */
  function indentOperation(kind) {
    return function (value) {
      if (value === null || typeof value !== 'object') {
        return { ok: false, message: '缩进量必须给出 {mode:"chars"|"length", value, unit?}。' };
      }
      if (!isFiniteNumber(value.value)) {
        return { ok: false, message: '缩进量必须是有限数字。' };
      }
      /* 意图层收的是 `{mode, value, unit?}`；`{unit, value}` 是执行器那一侧的形状。 */
      if (value.mode === 'chars') {
        return { ok: true, operation: { kind: kind, indent: { mode: 'chars', value: value.value } } };
      }
      if (value.mode === 'length') {
        if (LENGTH_UNITS.indexOf(value.unit) === -1) {
          return { ok: false, message: '长度单位必须是 ' + LENGTH_UNITS.join(' / ') + '。' };
        }
        return {
          ok: true,
          operation: { kind: kind, indent: { mode: 'length', unit: value.unit, value: value.value } }
        };
      }
      return { ok: false, message: '缩进量的 mode 必须是 "chars" 或 "length"。' };
    };
  }

  var CONTROLS = Object.freeze([
    /* --- 字符域：开关型（可提交） --------------------------------------- */
    { id: 'bold', label: '加粗', group: 'character', input: 'toggle', property: 'bold', build: toggleOperation('bold') },
    { id: 'italic', label: '斜体', group: 'character', input: 'toggle', property: 'italic', build: toggleOperation('italic') },
    { id: 'strike', label: '删除线', group: 'character', input: 'toggle', property: 'strike', build: toggleOperation('strike') },
    { id: 'doubleStrike', label: '双删除线', group: 'character', input: 'toggle', property: 'doubleStrike', build: toggleOperation('doubleStrike') },
    { id: 'caps', label: '全部大写', group: 'character', input: 'toggle', property: 'caps', build: toggleOperation('caps') },
    { id: 'smallCaps', label: '小型大写', group: 'character', input: 'toggle', property: 'smallCaps', build: toggleOperation('smallCaps') },
    { id: 'clearDirectFormat', label: '清除字符格式', group: 'character', input: 'action', build: function () {
      return { ok: true, operation: { kind: 'clearDirectFormat' } };
    } },

    /* --- 字符域：带值型里**有 setValue 通道**的两条（FA-P 接线） -------- */
    { id: 'fonts', label: '字体', group: 'character', input: 'font', property: 'fonts', build: fontsOperation },
    { id: 'size', label: '字号', group: 'character', input: 'size', property: 'size', build: sizeOperation },

    /* --- 字符域：带值型（意图层未开 setValue ⇒ 本页不提交） -------------- */
    { id: 'underlineStyle', label: '下划线样式', group: 'character', input: 'unwired', property: 'underline', supported: false },
    { id: 'color', label: '字体颜色', group: 'character', input: 'unwired', property: 'color', supported: false },
    { id: 'highlight', label: '高亮', group: 'character', input: 'unwired', property: 'highlight', supported: false },
    { id: 'vertAlign', label: '上标 / 下标', group: 'character', input: 'unwired', property: 'vertAlign', supported: false },
    /* 带值型里**唯一**有通道的一条：``unsetValue`` 把下划线取消成规范值 'none'。 */
    { id: 'underlineNone', label: '取消下划线', group: 'character', input: 'action', build: function () {
      return { ok: true, operation: { kind: 'unsetValue', property: 'underline' } };
    } },

    /* --- 段落域（可提交） ---------------------------------------------- */
    { id: 'alignment', label: '对齐', group: 'paragraph', input: 'choice', values: ALIGNMENTS,
      build: choiceOperation('setAlignment', 'alignment', ALIGNMENTS) },
    { id: 'lineSpacing', label: '行距', group: 'paragraph', input: 'choice',
      values: ['single', 'oneAndHalf', 'double', 'multiple', 'exact', 'atLeast'],
      build: lineSpacingOperation },
    { id: 'spacingBefore', label: '段前间距', group: 'paragraph', input: 'spacing',
      build: spacingOperation('setSpacingBefore') },
    { id: 'spacingAfter', label: '段后间距', group: 'paragraph', input: 'spacing',
      build: spacingOperation('setSpacingAfter') },
    { id: 'firstLineIndent', label: '首行缩进', group: 'paragraph', input: 'indent',
      build: indentOperation('setFirstLineIndent') },
    { id: 'hangingIndent', label: '悬挂缩进', group: 'paragraph', input: 'indent',
      build: indentOperation('setHangingIndent') },
    { id: 'leftIndent', label: '左缩进', group: 'paragraph', input: 'indent',
      build: indentOperation('setLeftIndent') },
    { id: 'rightIndent', label: '右缩进', group: 'paragraph', input: 'indent',
      build: indentOperation('setRightIndent') },
    { id: 'clearParagraphFormat', label: '清除段落格式', group: 'paragraph', input: 'action',
      build: function () { return { ok: true, operation: { kind: 'clearParagraphFormat' } }; } }
  ]);

  var CONTROL_BY_ID = {};
  for (var ci = 0; ci < CONTROLS.length; ci++) CONTROL_BY_ID[CONTROLS[ci].id] = CONTROLS[ci];

  /* ===================== 本地校验（镜像内核白名单） ===================== */

  /**
   * 本地预检一条操作是否可能被内核接受。
   * 返回 `null`（可以提交）或 `{code, message}`（**不提交**，附原因）。
   * 镜像的是 `compileEditIntent` 的两个白名单；测试用真实的那个函数对拍。
   */
  function localRejection(operation) {
    if (operation === null || typeof operation !== 'object') {
      return { code: 'invalid_expression', message: '操作必须是对象。' };
    }
    var kind = operation.kind;
    if (typeof kind !== 'string') {
      return { code: 'invalid_expression', message: '操作缺少 kind。' };
    }
    if (SUPPORTED_OPERATION_KINDS.indexOf(kind) === -1) {
      return {
        code: 'unsupported',
        message: '本页不提交内核意图层未开放的操作（kind=' + kind + '）。' + UNWIRED_REASON
      };
    }
    if (kind === 'setToggle' || kind === 'toggle') {
      if (TOGGLE_PROPERTIES.indexOf(operation.property) === -1) {
        return {
          code: 'unsupported',
          message: '开关型字符属性只能是 ' + TOGGLE_PROPERTIES.join(' / ') + '，收到 ' + String(operation.property) + '。'
        };
      }
      if (kind === 'setToggle' && typeof operation.value !== 'boolean') {
        return { code: 'invalid_expression', message: 'setToggle 的 value 必须是布尔值。' };
      }
    }
    if (kind === 'setValue') {
      if (SET_VALUE_PROPERTIES.indexOf(operation.property) === -1) {
        return {
          code: 'unsupported',
          message: 'setValue 目前**只开放** ' + SET_VALUE_PROPERTIES.join(' / ') +
            '（字体 / 字号）两条通道；收到 ' + JSON.stringify(operation.property) + '。' + UNWIRED_REASON
        };
      }
      var checked = operation.property === 'fonts'
        ? checkFontsValue(operation.value)
        : checkSizeValue(operation.value);
      if (!checked.ok) {
        return { code: 'invalid_value', message: checked.message };
      }
    }
    if (kind === 'unsetValue' && VALUED_PROPERTIES.indexOf(operation.property) === -1) {
      return {
        code: 'unsupported',
        message: 'unsetValue 只对带值型字符属性成立（开关型的"取消"是 setToggle(value=false)）。'
      };
    }
    return null;
  }

  function isPlainRange(range) {
    return typeof range === 'string' && range.trim().length > 0;
  }

  /**
   * 把「控件 + 值 + 范围表达式」翻成一步意图。
   * 返回 `{ok:true, step:{range, operation}}` 或 `{ok:false, code, message}`。
   * **翻不出来就不提交**（不降级成别的操作、不猜）。
   */
  function buildStep(range, controlId, value) {
    if (!isPlainRange(range)) {
      return { ok: false, code: 'no_range', message: '还没有可用的范围表达式：请先在预览里选中一段文字。' };
    }
    var control = CONTROL_BY_ID[controlId];
    if (control === undefined) {
      return { ok: false, code: 'unknown_control', message: '不认识的控件：' + String(controlId) };
    }
    if (control.supported === false) {
      return { ok: false, code: 'unsupported', message: control.label + '：' + UNWIRED_REASON };
    }
    var built = control.build(value);
    if (!built.ok) {
      return { ok: false, code: 'invalid_value', message: control.label + '：' + built.message };
    }
    var rejection = localRejection(built.operation);
    if (rejection !== null) {
      return { ok: false, code: rejection.code, message: rejection.message };
    }
    return { ok: true, step: { range: range, operation: built.operation } };
  }

  /** 把一组步折叠成一次提交的意图（`{steps}`）。 */
  function toIntent(steps) {
    var list = Array.isArray(steps) ? steps : [];
    return { steps: list.slice() };
  }

  /* ===================== 暂存栈（撤销 / 重做） ===================== */

  /**
   * 提交前的暂存栈。语义固定：
   *   - `add` 追加一步，并**清空重做栈**（与编辑器一致：新动作切断重做分支）；
   *   - `undo` 把最后一步移到重做栈；`redo` 移回来；
   *   - 栈内容**不自动提交**：只有 `app.js` 的「保存」把它作为**一次** intent 提交。
   */
  function createStaging(options) {
    var opt = options || {};
    var limit = typeof opt.limit === 'number' && opt.limit > 0 ? Math.floor(opt.limit) : MAX_STEPS_PER_INTENT;
    var steps = [];
    var undone = [];

    return {
      limit: limit,
      add: function (step) {
        if (steps.length >= limit) {
          return { ok: false, code: 'too_many_steps', message: '一次最多 ' + limit + ' 步，请先保存再继续。' };
        }
        steps.push(step);
        undone.length = 0;
        return { ok: true, index: steps.length - 1 };
      },
      undo: function () {
        if (steps.length === 0) return null;
        var step = steps.pop();
        undone.push(step);
        return step;
      },
      redo: function () {
        if (undone.length === 0) return null;
        var step = undone.pop();
        steps.push(step);
        return step;
      },
      steps: function () { return steps.slice(); },
      size: function () { return steps.length; },
      canUndo: function () { return steps.length > 0; },
      canRedo: function () { return undone.length > 0; },
      undoneCount: function () { return undone.length; },
      clear: function () { var copy = steps.slice(); steps.length = 0; undone.length = 0; return copy; },
      toIntent: function () { return toIntent(steps); }
    };
  }

  /* ===================== 回执分类 ===================== */

  /**
   * 分类一次编辑提交的结果。**`showsSuccess` 只在服务端真的发布了新版本时为 true**：
   *   applied   —— 200 且未 replayed / 未 noOp：产生了新版本（唯一可显示"已保存"的一类）；
   *   replayed  —— 200 且命中幂等键：没有产生第二个版本，回执是第一次的；
   *   no_op     —— 200 但没有任何一步真正改动：**不产生新版本，不得说已保存**；
   *   conflict  —— 409 stale_revision：基线过期，**保留待保存状态**，提示重取；
   *   rejected  —— 4xx：结构化拒绝（范围没命中 / 不支持 / 表达式非法…）；
   *   failed    —— 5xx：下游没交付成功，可重试。
   */
  function classifyEditResponse(httpStatus, data) {
    var body = (data !== null && typeof data === 'object') ? data : {};
    var status = typeof httpStatus === 'number' ? httpStatus : 0;

    if (status >= 200 && status < 300) {
      var revision = typeof body.editRevision === 'number' ? body.editRevision : null;
      var version = body.version === undefined ? null : body.version;
      var reports = Array.isArray(body.steps) ? body.steps : [];
      if (body.replayed === true) {
        return {
          kind: 'replayed', showsSuccess: false, keepsStaged: false, retryable: false,
          editRevision: revision, version: version, reports: reports,
          message: '这次提交命中了幂等键：电脑端没有产生新版本，回执是上一次同一次提交的结果。'
        };
      }
      if (body.noOp === true) {
        return {
          kind: 'no_op', showsSuccess: false, keepsStaged: false, retryable: false,
          editRevision: revision, version: version, reports: reports,
          message: '格式已经是目标状态，没有任何一步真正改动文档，因此**没有产生新版本**。'
        };
      }
      return {
        kind: 'applied', showsSuccess: true, keepsStaged: false, retryable: false,
        editRevision: revision, version: version, reports: reports,
        message: '电脑端已发布新版本。'
      };
    }

    var code = typeof body.code === 'string' ? body.code : ('http_' + String(status));
    var message = typeof body.message === 'string' && body.message ? body.message : '电脑服务拒绝了这次编辑。';
    if (code === 'stale_revision') {
      return {
        kind: 'conflict', showsSuccess: false, keepsStaged: true, retryable: true,
        code: code, message: message,
        currentRevision: typeof body.currentRevision === 'number' ? body.currentRevision : null,
        requestedRevision: typeof body.requestedRevision === 'number' ? body.requestedRevision : null,
        reason: body.reason === 'revision' || body.reason === 'digest' ? body.reason : null,
        note: '你手上的文档版本已经过期（可能有别人或另一次提交先改过）。**本次没有改动文档**，' +
          '待保存的格式步骤仍留在页面上；请先重新取回最新版本，再决定是否重新提交。'
      };
    }
    if (status >= 500 || status === 0) {
      return {
        kind: 'failed', showsSuccess: false, keepsStaged: true, retryable: body.retryable !== false,
        code: code, message: message,
        note: '电脑端没有把这次编辑交付成功。**本次没有确认改动生效**；待保存的步骤仍在页面上。'
      };
    }
    return {
      kind: 'rejected', showsSuccess: false, keepsStaged: true, retryable: body.retryable === true,
      code: code, message: message,
      note: '这次编辑被电脑端拒绝了，**文档没有改动**；待保存的步骤仍在页面上，可修改后再提交。'
    };
  }

  /** 把逐步回执渲染成一句中文说明（如实区分"命中但幂等空转"与"真的改了"）。 */
  function describeReports(reports) {
    if (!Array.isArray(reports) || reports.length === 0) return '';
    var parts = [];
    for (var i = 0; i < reports.length; i++) {
      var report = reports[i] || {};
      var range = typeof report.range === 'string' ? report.range : '（未知范围）';
      var hits = typeof report.hitCount === 'number' ? report.hitCount : 0;
      var tail = report.changed === true
        ? '已改动'
        : '无变化（已是目标状态）';
      if (report.toggleTarget === 'on') tail += '·目标为开启';
      else if (report.toggleTarget === 'off') tail += '·目标为关闭';
      parts.push(range + '：命中 ' + hits + ' 段，' + tail);
    }
    return parts.join('；');
  }

  function newKey(prefix) {
    var tail;
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      tail = crypto.randomUUID();
    } else {
      tail = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    var key = (prefix ? prefix + '-' : '') + tail;
    return key.length > 128 ? key.slice(0, 128) : key;
  }

  return {
    SUPPORTED_OPERATION_KINDS: SUPPORTED_OPERATION_KINDS,
    TOGGLE_PROPERTIES: TOGGLE_PROPERTIES,
    VALUED_PROPERTIES: VALUED_PROPERTIES,
    SET_VALUE_PROPERTIES: SET_VALUE_PROPERTIES,
    FONT_SLOTS: FONT_SLOTS,
    CHINESE_FONT_SIZE_NAMES: CHINESE_FONT_SIZE_NAMES,
    ALIGNMENTS: ALIGNMENTS,
    LENGTH_UNITS: LENGTH_UNITS,
    MAX_STEPS_PER_INTENT: MAX_STEPS_PER_INTENT,
    UNWIRED_REASON: UNWIRED_REASON,
    CONTROLS: CONTROLS,
    controlById: function (id) { return CONTROL_BY_ID[id] || null; },
    buildStep: buildStep,
    localRejection: localRejection,
    toIntent: toIntent,
    createStaging: createStaging,
    classifyEditResponse: classifyEditResponse,
    describeReports: describeReports,
    newKey: newKey
  };
});
