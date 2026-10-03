/**
 * **结构化编辑意图 → 确定性操作计划**（合同 R133/R134/R135/R140）。
 *
 * ## 为什么需要这一层（而不是让调用方直接写 `EditPlan`）
 *
 * R134 把自然语言边界钉成两半：
 * - **模型只做受约束的意图解析**——它**不**产出 XML、HTML、脚本，也不产出
 *   `EditPlan` 这种"已经是实现形态"的对象；
 * - **确定性执行器校验目标、属性、前置条件与能力**，校验通过才生成计划。
 *
 * 本文件就是那半边的落地：它收的是**受限的、可序列化的意图**（JSON 形状，未来由模型产出），
 * 逐字段校验后翻成 `EditPlan`。加这一层不是为了将来，而是为了**现在就有的判据**：
 *
 * 1. **零模型也能执行**——"把第二段居中"在这条链上是
 *    `{range:'第2段', operation:{kind:'setAlignment', alignment:'center'}}`，
 *    不经过任何模型（R134 的硬要求）；
 * 2. **不支持的能力在**操作前**就被拒**（R140），而不是落到执行器里去炸：
 *    非法对齐值、非法字号形态、`mixed` 这类禁止写入的状态，都在这里返回 `unsupported`，
 *    此时**文档一个字节都没动**；
 * 3. **计划是可复算的**——同一意图 ⇒ 同一计划 ⇒ 同一结果（R133）。
 *
 * ## 受限度（刻意收窄，写在这里免得被当成遗漏）
 *
 * 本文件**只**覆盖 `src/documents/edit/plan.ts` 能执行的两种域（段落属性 / 字符属性）。
 * 字符域里**带值属性**只开放了两条 **`setValue`** 通道——**字体**（`fonts`，中西文分设，WF-006）
 * 与**字号**（`size`，pt 或中文字号名，WF-007）——因为它们是"设宋体、小四"这类最常见指令的落点；
 * 其余带值属性（下划线 / 颜色 / 高亮 / 底纹 / 字距 / 缩放 / 位置）**刻意未开**，
 * 请求它们会得到 `unsupported` 并明说本通道支持哪些。
 * 表格结构、图片、样式、域的意图**不在这里**——它们要么尚未有执行器，要么属于后续包。
 * 遇到不认识的操作种类**明确返回 `unsupported`**，不静默丢弃（R140/R154）。
 *
 * ## 字号为什么要在这里就拒掉"不可表示"的值
 *
 * `w:sz` 的粒度是 **0.5 pt**（半点）。`docx/word-xml.ts` 的 `writableHalfPoints` 在**写出时**
 * 会对 `12.3pt` 这类值抛错——但那是**导出期**，用户已经提交过一次"成功"的编辑事务。
 * 因此本层用 `units` 的 `isRepresentableFontSize` **同一套规则**提前判：
 * `12.3pt` ⇒ `unsupported`，**不四舍五入成 12pt**（那正是 R140 要挡的"静默改值"）。
 */

import type { Alignment, FontSet, FontSize, IndentAmount, LineSpacing, ParagraphSpacing } from '../model/index.js';
import {
  CHARACTER_PROPERTY_KEYS,
  TOGGLE_PROPERTY_KEYS,
  isTogglePropertyKey,
  type CharacterPropertyKey,
  type CharacterFormatOperation,
  type TogglePropertyKey,
  type ValuedPropertyKey,
} from '../operations/character/index.js';
import { CHINESE_FONT_SIZE_NAMES, isRepresentableFontSize } from '../units/index.js';
import type { EditOperation, EditPlan, EditStep, ParagraphPropertyOperation } from '../edit/plan.js';
import { fail, succeed } from '../selection/types.js';
import type { FailureDetail, Result } from '../selection/types.js';

// ---------------------------------------------------------------------------
// 意图形状（JSON 形状；未来由模型产出，现在由前端/直接命令产出）
// ---------------------------------------------------------------------------

/** 长度：**必须带单位**（R127/R128）——本层不做换算，只搬运。 */
export interface IntentLength {
  readonly unit: 'pt' | 'mm' | 'cm' | 'inch' | 'twips';
}

/** 缩进量：字符与长度**分开表达**（R130：`2 字` ≠ `2 cm`）。 */
export type IntentIndent =
  | { readonly mode: 'chars'; readonly value: number }
  | { readonly mode: 'length'; readonly unit: IntentLength['unit']; readonly value: number };

/** 行距（R128 的六类）。 */
export type IntentLineSpacing =
  | { readonly mode: 'single' }
  | { readonly mode: 'oneAndHalf' }
  | { readonly mode: 'double' }
  | { readonly mode: 'multiple'; readonly value: number }
  | { readonly mode: 'exact'; readonly unit: IntentLength['unit']; readonly value: number }
  | { readonly mode: 'atLeast'; readonly unit: IntentLength['unit']; readonly value: number };

/** 段前 / 段后间距：pt、行、自动，三种形态互斥（R128/R131）。 */
export type IntentSpacing =
  | { readonly mode: 'pt'; readonly value: number }
  | { readonly mode: 'lines'; readonly value: number }
  | { readonly mode: 'auto' };

/**
 * 一条操作意图。
 *
 * **字段名与执行器的操作名一致**：这样"意图 → 计划"是一张查表，而不是一次翻译
 * （翻译就有第二次解读，第二次解读就有分叉）。
 */
/**
 * **字体槽位意图**（WF-006）：中西文四个槽位**分别**给，未给 / `null` = 该槽不指定。
 *
 * 为什么四槽分开而不是一个 `fontFamily`：OOXML 的 `w:rFonts` 本就有 `ascii` / `hAnsi` /
 * `eastAsia` / `cs` 四个属性，中文（`eastAsia`）与西文（`ascii`）**必须能分别设置**——
 * 只写一个"字体名"表达不了"中文用宋体、西文用 Times New Roman"。
 *
 * 至少要指定一个槽位（四个都是空 ⇒ 这次操作没有任何意义，`unsupported`）。
 */
export interface IntentFontSet {
  readonly ascii?: string | null;
  readonly hAnsi?: string | null;
  readonly eastAsia?: string | null;
  readonly cs?: string | null;
}

/**
 * **字号意图**（WF-007）：pt 精确值 或 中文字号名。
 *
 * 与模型层的 `FontSize` **同形**（`kind` 判别式一致）——中文名 → pt 的映射表归
 * `src/documents/units/**`（R128/R129 唯一权威），本层只校验名字在不在表里、pt 能不能表示。
 */
export type IntentFontSize =
  | { readonly kind: 'pt'; readonly value: number }
  | { readonly kind: 'chinese'; readonly name: string };

export type IntentOperation =
  // --- 段落属性域（WF-017–034 中整段生效的部分） ---------------------------
  | { readonly kind: 'setAlignment'; readonly alignment: string }
  | { readonly kind: 'setLineSpacing'; readonly lineSpacing: unknown }
  | { readonly kind: 'setSpacingBefore'; readonly spacing: unknown }
  | { readonly kind: 'setSpacingAfter'; readonly spacing: unknown }
  | { readonly kind: 'setFirstLineIndent'; readonly indent: unknown }
  | { readonly kind: 'setHangingIndent'; readonly indent: unknown }
  | { readonly kind: 'setLeftIndent'; readonly indent: unknown }
  | { readonly kind: 'setRightIndent'; readonly indent: unknown }
  | { readonly kind: 'clearParagraphFormat' }
  // --- 字符属性域（WF-001–016 中开关与清除的部分） -------------------------
  | { readonly kind: 'setToggle'; readonly property: string; readonly value: boolean }
  | { readonly kind: 'toggle'; readonly property: string }
  // --- 带值属性通道（本批只开字体与字号；其余明确拒绝） --------------------
  /** 设字体（WF-006）：中西文四槽分设，至少给一个。 */
  | { readonly kind: 'setValue'; readonly property: 'fonts'; readonly value: IntentFontSet }
  /** 设字号（WF-007）：pt 或中文字号名。 */
  | { readonly kind: 'setValue'; readonly property: 'size'; readonly value: IntentFontSize }
  | { readonly kind: 'inherit'; readonly property: string }
  | { readonly kind: 'unsetValue'; readonly property: string }
  | { readonly kind: 'clearDirectFormat' };

/** 一步意图：范围表达式原文（R111 的固定语法）+ 操作。 */
export interface IntentStep {
  readonly range: string;
  readonly operation: IntentOperation;
}

export interface EditIntent {
  readonly steps: readonly IntentStep[];
}

// ---------------------------------------------------------------------------
// 校验表
// ---------------------------------------------------------------------------

const ALIGNMENTS: readonly Alignment[] = ['left', 'center', 'right', 'justify', 'distribute'];

/** 段落域的操作名（与执行器逐字一致）。 */
const PARAGRAPH_KINDS = [
  'setAlignment',
  'setLineSpacing',
  'setSpacingBefore',
  'setSpacingAfter',
  'setFirstLineIndent',
  'setHangingIndent',
  'setLeftIndent',
  'setRightIndent',
  'clearParagraphFormat',
] as const;

type ParagraphIntentKind = (typeof PARAGRAPH_KINDS)[number];

const PARAGRAPH_KIND_SET: ReadonlySet<string> = new Set<string>(PARAGRAPH_KINDS);
const CHARACTER_KIND_SET: ReadonlySet<string> = new Set<string>([
  'setToggle',
  'toggle',
  'setValue',
  'inherit',
  'unsetValue',
  'clearDirectFormat',
]);

/** `unsetValue` 只对**带值型**属性成立（开关型的"取消"是 `setToggle(value=false)`，R118）。 */
const VALUED_PROPERTY_SET: ReadonlySet<string> = new Set<string>(
  CHARACTER_PROPERTY_KEYS.filter((key) => !isTogglePropertyKey(key)),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

/** 是不是一条**失败结果**（操作对象没有 `ok` 字段，故判别位不会误伤）。 */
function isFailure(value: unknown): value is { readonly ok: false; readonly code: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly ok?: unknown }).ok === false
  );
}

// ---------------------------------------------------------------------------
// 编译器
// ---------------------------------------------------------------------------

/**
 * 把结构化意图编译成确定性操作计划。
 *
 * **纯函数**：不读时钟、不读磁盘、不碰模型。同一意图必然同一计划。
 *
 * 失败一律是**结构化拒绝**且**发生在任何文档改动之前**（R140）：
 * 非法的对齐值 / 字号形态 / 属性名 → `unsupported`；缺字段 / 形状不对 → `invalid_*`。
 */
export function compileEditIntent(intent: unknown): Result<EditPlan> {
  if (!isRecord(intent)) {
    return fail('invalid_expression', '编辑意图必须是一个对象（形状：{steps:[{range, operation}]}）', {
      extra: { shape: 'object' },
    });
  }
  const rawSteps = field(intent, 'steps');
  if (!Array.isArray(rawSteps)) {
    return fail('invalid_expression', '编辑意图缺少 steps 数组', { extra: { steps: 0 } });
  }
  if (rawSteps.length === 0) {
    // 与 `applyEditPlan` 的口径一致：空计划**不是**一次事务（R136/R138）。
    return fail('empty_range', '编辑意图没有任何步骤（空计划不得计入一次事务）', {
      extra: { steps: 0 },
    });
  }

  const steps: EditStep[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const position = index + 1;
    const context: FailureDetail = { extra: { step: position } };
    if (!isRecord(raw)) {
      return fail('invalid_expression', `第 ${String(position)} 步不是对象`, context);
    }
    const range = field(raw, 'range');
    if (typeof range !== 'string' || range.trim().length === 0) {
      return fail('invalid_expression', `第 ${String(position)} 步缺少 range（范围表达式原文）`, {
        ...context,
        expression: typeof range === 'string' ? range : '',
      });
    }
    const operation = compileOperation(field(raw, 'operation'), position, range);
    if (!operation.ok) {
      return operation;
    }
    steps.push({ range, operation: operation.value });
  }

  return succeed<EditPlan>({ steps });
}

/** 编译一条操作（域由 `kind` 决定；未知 `kind` 一律 `unsupported`）。 */
function compileOperation(raw: unknown, position: number, range: string): Result<EditOperation> {
  const context: FailureDetail = { expression: range, extra: { step: position } };
  if (!isRecord(raw)) {
    return fail('invalid_expression', `第 ${String(position)} 步的 operation 不是对象`, context);
  }
  const kind = field(raw, 'kind');
  if (typeof kind !== 'string') {
    return fail('invalid_expression', `第 ${String(position)} 步的 operation 缺少 kind`, context);
  }

  if (PARAGRAPH_KIND_SET.has(kind)) {
    return compileParagraphOperation(kind as ParagraphIntentKind, raw, position, range);
  }
  if (CHARACTER_KIND_SET.has(kind)) {
    return compileCharacterOperation(kind, raw, position, range);
  }
  // R140：未支持的能力**在操作前拒绝**，且明说它是什么。
  return fail('unsupported', `第 ${String(position)} 步的操作 ${JSON.stringify(kind)} 不受支持`, {
    expression: range,
    extra: { step: position, kind },
  });
}

function compileParagraphOperation(
  kind: ParagraphIntentKind,
  raw: Record<string, unknown>,
  position: number,
  range: string,
): Result<EditOperation> {
  const where = `第 ${String(position)} 步（${kind}）`;
  const context: FailureDetail = { expression: range, extra: { step: position, kind } };
  const unsupported = (message: string): Result<EditOperation> =>
    fail('unsupported', `${where}：${message}`, context);
  const invalid = (message: string): Result<EditOperation> =>
    fail('invalid_expression', `${where}：${message}`, context);

  const compiled: ParagraphPropertyOperation | Result<EditOperation> = ((): ParagraphPropertyOperation | Result<EditOperation> => {
    switch (kind) {
      case 'setAlignment': {
        const alignment = field(raw, 'alignment');
        if (typeof alignment !== 'string' || !ALIGNMENTS.includes(alignment as Alignment)) {
          return unsupported(
            `对齐方式必须是 ${ALIGNMENTS.join(' | ')} 之一，收到 ${JSON.stringify(alignment)}`,
          );
        }
        return { kind: 'setAlignment', alignment: alignment as Alignment };
      }
      case 'setLineSpacing': {
        const spacing = compileLineSpacing(field(raw, 'lineSpacing'));
        return spacing.ok ? { kind: 'setLineSpacing', spacing: spacing.value } : spacing;
      }
      case 'setSpacingBefore':
      case 'setSpacingAfter': {
        const spacing = compileSpacing(field(raw, 'spacing'));
        if (!spacing.ok) return spacing;
        return kind === 'setSpacingBefore'
          ? { kind: 'setSpacingBefore', spacing: spacing.value }
          : { kind: 'setSpacingAfter', spacing: spacing.value };
      }
      case 'setFirstLineIndent':
      case 'setHangingIndent':
      case 'setLeftIndent':
      case 'setRightIndent': {
        const amount = compileIndent(field(raw, 'indent'));
        if (!amount.ok) return amount;
        switch (kind) {
          case 'setFirstLineIndent':
            return { kind: 'setFirstLineIndent', amount: amount.value };
          case 'setHangingIndent':
            return { kind: 'setHangingIndent', amount: amount.value };
          case 'setLeftIndent':
            return { kind: 'setLeftIndent', amount: amount.value };
          default:
            return { kind: 'setRightIndent', amount: amount.value };
        }
      }
      case 'clearParagraphFormat':
        return { kind: 'clearParagraphFormat' };
      default:
        return invalid(`未知的段落操作 ${JSON.stringify(kind)}`);
    }
  })();

  return isFailure(compiled)
    ? (compiled as Result<EditOperation>)
    : succeed<EditOperation>({ domain: 'paragraph', operation: compiled as ParagraphPropertyOperation });
}

function compileCharacterOperation(
  kind: string,
  raw: Record<string, unknown>,
  position: number,
  range: string,
): Result<EditOperation> {
  const where = `第 ${String(position)} 步（${kind}）`;
  const context: FailureDetail = { expression: range, extra: { step: position, kind } };
  const unsupported = (message: string): Result<EditOperation> =>
    fail('unsupported', `${where}：${message}`, context);

  const compiled: CharacterFormatOperation | Result<EditOperation> = ((): CharacterFormatOperation | Result<EditOperation> => {
    switch (kind) {
      case 'setToggle': {
        const property = field(raw, 'property');
        if (typeof property !== 'string' || !isTogglePropertyKey(property as CharacterPropertyKey)) {
          return unsupported(
            `开关型字符属性必须是 ${TOGGLE_PROPERTY_KEYS.join(' | ')} 之一，` +
              `收到 ${JSON.stringify(property)}`,
          );
        }
        const value = field(raw, 'value');
        if (typeof value !== 'boolean') {
          return unsupported(`setToggle 的 value 必须是布尔值，收到 ${JSON.stringify(value)}`);
        }
        return { kind: 'setToggle', property: property as TogglePropertyKey, value };
      }
      case 'toggle': {
        const property = requireToggleProperty(raw);
        return property.ok ? { kind: 'toggle', property: property.value } : property;
      }
      case 'inherit': {
        const property = field(raw, 'property');
        if (typeof property !== 'string' || !(CHARACTER_PROPERTY_KEYS as readonly string[]).includes(property)) {
          return unsupported(
            `字符属性必须是 ${CHARACTER_PROPERTY_KEYS.join(' | ')} 之一，` +
              `收到 ${JSON.stringify(property)}`,
          );
        }
        return { kind: 'inherit', property: property as CharacterPropertyKey };
      }
      case 'setValue':
        return compileSetValue(raw, position, range);
      case 'unsetValue': {
        const property = field(raw, 'property');
        if (typeof property !== 'string' || !VALUED_PROPERTY_SET.has(property)) {
          return unsupported(
            'unsetValue 只能用于**带值型**字符属性（开关型请用 setToggle(value=false)）：' +
              `收到 ${JSON.stringify(property)}`,
          );
        }
        return { kind: 'unsetValue', property: property as ValuedPropertyKey };
      }
      case 'clearDirectFormat':
        return { kind: 'clearDirectFormat' };
      default:
        return unsupported(`未知的字符操作 ${JSON.stringify(kind)}`);
    }
  })();

  return isFailure(compiled)
    ? (compiled as Result<EditOperation>)
    : succeed<EditOperation>({ domain: 'character', operation: compiled as CharacterFormatOperation });
}

/**
 * 编译一条 **`setValue`**（带值属性）。
 *
 * 本批**只开两条通道**：`fonts`（WF-006）与 `size`（WF-007）。
 * 其余带值属性（`underline` / `color` / `highlight` / `shading` / `spacing` / `scale` /
 * `position` / `vertAlign`）**明确 `unsupported`**，并在消息里说清本通道支持哪些——
 * 不静默丢弃，也不"顺手"照单全收（R140/R154）。
 */
function compileSetValue(
  raw: Record<string, unknown>,
  position: number,
  range: string,
): CharacterFormatOperation | Result<EditOperation> {
  const where = `第 ${String(position)} 步（setValue）`;
  const context: FailureDetail = { expression: range, extra: { step: position, kind: 'setValue' } };
  const unsupported = (message: string): Result<EditOperation> =>
    fail('unsupported', `${where}：${message}`, context);

  const property = field(raw, 'property');
  if (property === 'fonts') {
    const fonts = compileIntentFonts(field(raw, 'value'), where);
    return fonts.ok ? { kind: 'setValue', property: 'fonts', value: fonts.value } : fonts;
  }
  if (property === 'size') {
    const size = compileIntentFontSize(field(raw, 'value'), where);
    return size.ok ? { kind: 'setValue', property: 'size', value: size.value } : size;
  }
  if (typeof property === 'string' && (CHARACTER_PROPERTY_KEYS as readonly string[]).includes(property)) {
    return unsupported(
      `带值属性 ${JSON.stringify(property)} 目前**未开**这条通道：本批只开放 ` +
        '"fonts"（字体，WF-006）与 "size"（字号，WF-007）。' +
        '其余带值属性（underline / color / highlight / shading / spacing / scale / position / vertAlign）尚未接线。',
    );
  }
  return unsupported(
    `setValue 的 property 必须是 "fonts" 或 "size" 之一，收到 ${JSON.stringify(property)}`,
  );
}

/** `IntentFontSet` → `FontSet`（四槽补齐为 `string | null`）。至少要给一个非空槽位。 */
function compileIntentFonts(raw: unknown, where: string): Result<FontSet> {
  const bad = (message: string): Result<FontSet> => fail('unsupported', `${where}：${message}`, {});
  if (!isRecord(raw)) {
    return bad('fonts 的值必须是对象（形状：{ascii?, hAnsi?, eastAsia?, cs?}）');
  }
  const slots = ['ascii', 'hAnsi', 'eastAsia', 'cs'] as const;
  const resolved: Record<(typeof slots)[number], string | null> = {
    ascii: null,
    hAnsi: null,
    eastAsia: null,
    cs: null,
  };
  for (const slot of slots) {
    const value = field(raw, slot);
    if (value === undefined || value === null) continue; // 不给 = 该槽不指定（不是空串）
    if (typeof value !== 'string' || value.trim().length === 0) {
      return bad(
        `fonts.${slot} 必须是非空字符串或 null（null = 该槽不指定），收到 ${JSON.stringify(value)}`,
      );
    }
    resolved[slot] = value;
  }
  if (resolved.ascii === null && resolved.hAnsi === null && resolved.eastAsia === null && resolved.cs === null) {
    return bad('fonts 至少要指定一个槽位（ascii / hAnsi / eastAsia / cs），四个都是空等于什么都没设');
  }
  return succeed<FontSet>(resolved);
}

/**
 * `IntentFontSize` → `FontSize`。
 *
 * **不可表示的字号在这里就被拒**：pt 值必须是 0.5 的整数倍且 ≥ 0.5pt（`w:sz` 的粒度是半点）。
 * 判据用 `units` 的 `isRepresentableFontSize`（**同一套规则**，与写出侧的 `writableHalfPoints`
 * 对拍），因此 `12.3pt` ⇒ `unsupported`，**不四舍五入成 12pt**。
 */
function compileIntentFontSize(raw: unknown, where: string): Result<FontSize> {
  const bad = (message: string): Result<FontSize> => fail('unsupported', `${where}：${message}`, {});
  if (!isRecord(raw)) {
    return bad('size 的值必须是对象（形状：{kind:"pt", value} 或 {kind:"chinese", name}）');
  }
  const kind = field(raw, 'kind');
  if (kind === 'pt') {
    const value = field(raw, 'value');
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return bad(`size 的 pt 值必须是有限数字，收到 ${JSON.stringify(value)}`);
    }
    const size: FontSize = { kind: 'pt', value };
    if (!isRepresentableFontSize(size)) {
      return bad(
        `字号 ${String(value)}pt 无法用 w:sz 精确表示（粒度是 0.5pt，值必须是 0.5 的整数倍且不小于 0.5pt）。` +
          '本层**不替你四舍五入**——请给出可精确表示的值（如 12 / 12.5 / 10.5）。',
      );
    }
    return succeed<FontSize>(size);
  }
  if (kind === 'chinese') {
    const name = field(raw, 'name');
    if (typeof name !== 'string' || !(CHINESE_FONT_SIZE_NAMES as readonly string[]).includes(name)) {
      return bad(
        `中文字号名必须是 ${CHINESE_FONT_SIZE_NAMES.join(' / ')} 之一，收到 ${JSON.stringify(name)}`,
      );
    }
    return succeed<FontSize>({ kind: 'chinese', name: name as (typeof CHINESE_FONT_SIZE_NAMES)[number] });
  }
  return bad(`size.kind 必须是 "pt" 或 "chinese"，收到 ${JSON.stringify(kind)}`);
}

function requireToggleProperty(raw: Record<string, unknown>): Result<TogglePropertyKey> {
  const property = field(raw, 'property');
  if (typeof property !== 'string' || !isTogglePropertyKey(property as CharacterPropertyKey)) {
    return fail(
      'unsupported',
      `toggle 只能用于开关型字符属性（${TOGGLE_PROPERTY_KEYS.join(' | ')}）：` +
        `收到 ${JSON.stringify(property)}`,
      { extra: { property: String(property) } },
    );
  }
  return succeed(property as TogglePropertyKey);
}

// ---------------------------------------------------------------------------
// 值编译（**不做任何单位换算**，R128：换算集中在 `src/documents/units/**`）
// ---------------------------------------------------------------------------

function compileIndent(raw: unknown): Result<IndentAmount> {
  if (!isRecord(raw)) {
    return fail('invalid_expression', '缩进量必须给出 {mode:"chars"|"length", value, unit?}', {
      extra: { shape: 'object' },
    });
  }
  const mode = field(raw, 'mode');
  const value = field(raw, 'value');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('invalid_expression', `缩进量必须是有限数字，收到 ${JSON.stringify(value)}`, {
      extra: { value: String(value) },
    });
  }
  if (mode === 'chars') {
    // R130：`2 字` 与 `2 cm` 是**两个不同量**，走两个不同字段。
    return succeed<IndentAmount>({ unit: 'chars', value });
  }
  if (mode === 'length') {
    const unit = field(raw, 'unit');
    if (!isLengthUnit(unit)) {
      return fail(
        'invalid_expression',
        `长度单位必须是 pt | mm | cm | inch | twips，收到 ${JSON.stringify(unit)}`,
        { extra: { unit: String(unit) } },
      );
    }
    return succeed<IndentAmount>({ unit, value });
  }
  return fail(
    'invalid_expression',
    `缩进量的 mode 必须是 "chars" 或 "length"，收到 ${JSON.stringify(mode)}`,
    { extra: { mode: String(mode) } },
  );
}

function compileSpacing(raw: unknown): Result<ParagraphSpacing> {
  if (!isRecord(raw)) {
    return fail('invalid_expression', '段间距必须给出 {mode:"pt"|"lines"|"auto", value?}', {
      extra: { shape: 'object' },
    });
  }
  const mode = field(raw, 'mode');
  if (mode === 'auto') {
    return succeed<ParagraphSpacing>({ kind: 'auto' });
  }
  const value = field(raw, 'value');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('invalid_expression', `段间距的 value 必须是有限数字，收到 ${JSON.stringify(value)}`, {
      extra: { value: String(value) },
    });
  }
  if (mode === 'pt') return succeed<ParagraphSpacing>({ kind: 'pt', value });
  if (mode === 'lines') return succeed<ParagraphSpacing>({ kind: 'lines', value });
  return fail(
    'invalid_expression',
    `段间距的 mode 必须是 "pt" | "lines" | "auto"，收到 ${JSON.stringify(mode)}`,
    { extra: { mode: String(mode) } },
  );
}

function compileLineSpacing(raw: unknown): Result<LineSpacing> {
  if (!isRecord(raw)) {
    return fail(
      'invalid_expression',
      '行距必须给出 {mode:…}（single / oneAndHalf / double / multiple / exact / atLeast）',
      { extra: { shape: 'object' } },
    );
  }
  const mode = field(raw, 'mode');
  switch (mode) {
    case 'single':
      return succeed<LineSpacing>({ kind: 'single' });
    case 'oneAndHalf':
      return succeed<LineSpacing>({ kind: 'oneAndHalf' });
    case 'double':
      return succeed<LineSpacing>({ kind: 'double' });
    case 'multiple': {
      const value = field(raw, 'value');
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fail('invalid_expression', `多倍行距必须是正数，收到 ${JSON.stringify(value)}`, {
          extra: { value: String(value) },
        });
      }
      return succeed<LineSpacing>({ kind: 'multiple', value });
    }
    case 'exact':
    case 'atLeast': {
      const unit = field(raw, 'unit');
      const value = field(raw, 'value');
      if (!isLengthUnit(unit) || typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('invalid_expression', '固定/最小行距必须给出合法的 {unit, value}', {
          extra: { unit: String(unit), value: String(value) },
        });
      }
      return succeed<LineSpacing>({ kind: mode, value: { unit, value } });
    }
    default:
      return fail('invalid_expression', `行距 mode 不受支持：${JSON.stringify(mode)}`, {
        extra: { mode: String(mode) },
      });
  }
}

function isLengthUnit(raw: unknown): raw is IntentLength['unit'] {
  return raw === 'pt' || raw === 'mm' || raw === 'cm' || raw === 'inch' || raw === 'twips';
}
