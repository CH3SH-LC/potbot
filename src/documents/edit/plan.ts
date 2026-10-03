/**
 * **确定性操作计划执行器**（合同 R132–R136；归属：主协调者独占的共享集成适配层）。
 *
 * ## 为什么要有这一层
 *
 * WCF-D02（DOCX 读写）、WCF-D03（选区 + 字符格式）、WCF-D04（段落排版 + 单位）三个包
 * 各自只负责自己那一段：D03/D04 是**对单个段落/属性集的纯函数**，D02 只管模型 ↔ 字节。
 * 没有这一层，"把第二段居中、把其中的'提示'加粗"这条**复合指令**就没有地方落地。
 *
 * R133/R135 要求：模型只产出**受约束的意图**，真正改文件的是**确定性操作计划**——
 * 本文件就是那个执行器：计划是**可序列化的数据**（可存进操作日志，R139），
 * 执行是**纯函数**，因此"同一模型 + 同一计划 ⇒ 同一结果"可复算。
 *
 * ## 原子性（R136）
 *
 * 逐步执行，但**只有整批成功才产出新模型**；任一步失败返回 `Failure`，
 * 且 `Failure` 在类型上**不带模型字段**——"前半段成功、后半段悄悄失败"在类型上不可表达。
 * 失败时输入模型一个字节都没有被改（模型是不可变的，执行器只在其上构造新对象）。
 *
 * ## 版本（R141/R142）
 *
 * 一次计划 = 一次事务 = **一次 revision 递增**（不是每步 +1）。这同时是 R138 的**撤销单元**：
 * "撤销"= 回到上一个 revision 的模型。
 *
 * ## 不做的事
 *
 * - **不换算单位**（R128）：换算在 `src/documents/units/**`，本层只传语义值。
 * - **不拼 XML**（R107）：那是 `src/documents/docx/**`。
 * - **不解析自然语言**：本层收的是**已结构化的计划**；"把第二段居中"→ 计划 的翻译归上层（R134）。
 */

import type { Alignment, DocumentModel, IndentAmount, LineSpacing, ParagraphNode, ParagraphProperties, ParagraphSpacing, Revision } from '../model/index.js';
import { clearParagraphFormat, setAlignment, setFirstLineIndent, setHangingIndent, setLeftIndent, setLineSpacing, setRightIndent, setSpacingAfter, setSpacingBefore } from '../operations/paragraph/index.js';
import type { CharacterFormatOperation } from '../operations/character/index.js';
import { applyCharacterFormatToRanges } from '../operations/character/index.js';
import { resolveRangeExpression } from '../selection/resolve.js';
import { replaceParagraph, requireParagraph } from '../selection/structure.js';
import { fail, succeed } from '../selection/types.js';
import type { Result } from '../selection/types.js';

// ---------------------------------------------------------------------------
// 计划形状（可序列化）
// ---------------------------------------------------------------------------

/**
 * 段落属性操作（WF-017–034 里"整段生效"的那部分）。
 *
 * 与 `CharacterFormatOperation` 分开用 `domain` 标记（而不是把两者摊平成一个联合）：
 * 两个包的 `kind` 命名空间互不知情，摊平会有**静默改名冲突**的风险；
 * `domain` 显式说出"这一步作用在段落属性还是字符属性上"，判据也更好写。
 */
export type ParagraphPropertyOperation =
  | { readonly kind: 'setAlignment'; readonly alignment: Alignment }
  | { readonly kind: 'setLineSpacing'; readonly spacing: LineSpacing }
  | { readonly kind: 'setSpacingBefore'; readonly spacing: ParagraphSpacing }
  | { readonly kind: 'setSpacingAfter'; readonly spacing: ParagraphSpacing }
  | { readonly kind: 'setFirstLineIndent'; readonly amount: IndentAmount }
  | { readonly kind: 'setHangingIndent'; readonly amount: IndentAmount }
  | { readonly kind: 'setLeftIndent'; readonly amount: IndentAmount }
  | { readonly kind: 'setRightIndent'; readonly amount: IndentAmount }
  /** 清除段落直接格式（WF-034）；**不清字符局部强调**（R120）。 */
  | { readonly kind: 'clearParagraphFormat' };

/** 一步编辑：作用范围（R111 的固定语法）+ 操作。 */
export type EditOperation =
  | { readonly domain: 'character'; readonly operation: CharacterFormatOperation }
  | { readonly domain: 'paragraph'; readonly operation: ParagraphPropertyOperation };

export interface EditStep {
  /** 范围表达式原文（`第2段` / `指定文本:提示` / `全文` …）。**原样保留进回执**，便于回显与日志。 */
  readonly range: string;
  readonly operation: EditOperation;
}

export interface EditPlan {
  readonly steps: readonly EditStep[];
}

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

/** 单步回执。**没有"改了但没说改了哪"这一态**：`changed=false` 表示合法但幂等空转。 */
export interface EditStepReport {
  readonly range: string;
  readonly domain: EditOperation['domain'];
  /** 该范围表达式实际命中的段落数（`ok` 时 ≥1）。 */
  readonly hitCount: number;
  /** 本次是否真的改动了模型（重复施加同一操作 ⇒ `false`，即幂等，R137）。 */
  readonly changed: boolean;
  /** 字符域 `toggle` 时统一采用的目标态，供上层写"已加粗 / 已取消加粗"。 */
  readonly toggleTarget?: 'on' | 'off' | null;
}

export interface EditResult {
  readonly model: DocumentModel;
  readonly steps: readonly EditStepReport[];
  /** 计划前的版本（`model.revision === previous_revision + 1`）。 */
  readonly previous_revision: Revision;
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/**
 * 原子地执行一个操作计划。
 *
 * @returns 成功时给出**新模型**（revision +1）与逐步回执；失败时给出结构化原因，
 *          **不带模型**——调用方据此知道"文档没有任何改动"。
 */
export function applyEditPlan(model: DocumentModel, plan: EditPlan): Result<EditResult> {
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    return fail('empty_range', '编辑计划没有任何步骤（空计划不得计入一次事务）。', {
      expression: '',
      extra: { steps: 0 },
    });
  }

  const reports: EditStepReport[] = [];
  let next = model;

  for (const [index, step] of plan.steps.entries()) {
    // R111–R116：每一步都在**当前**模型上重新解析范围（节点 id 稳定，R101）。
    const resolved = resolveRangeExpression(next, step.range);
    if (resolved.status !== 'ok') {
      return fail(
        resolved.status === 'not_found'
          ? 'not_found'
          : resolved.status === 'ambiguous'
            ? 'ambiguous'
            : 'invalid_expression',
        `第 ${String(index + 1)} 步的范围 "${step.range}" 无法执行：${resolved.message}`,
        { ...resolved.detail, expression: step.range },
      );
    }

    const applied =
      step.operation.domain === 'character'
        ? applyCharacterStep(next, resolved.ranges, step.operation.operation)
        : applyParagraphStep(next, resolved.ranges, step.operation.operation);

    if (!applied.ok) {
      // 原子性：直接返回失败，`next` 与 `model` 都不变。
      return applied;
    }

    reports.push({
      range: step.range,
      domain: step.operation.domain,
      hitCount: resolved.hitCount,
      changed: applied.value.changed,
      ...(applied.value.toggleTarget === undefined ? {} : { toggleTarget: applied.value.toggleTarget }),
    });
    next = applied.value.model;
  }

  return succeed({
    model: { ...next, revision: model.revision + 1 },
    steps: reports,
    previous_revision: model.revision,
  });
}

// ---------------------------------------------------------------------------
// 内部：两类步骤
// ---------------------------------------------------------------------------

interface AppliedStep {
  readonly model: DocumentModel;
  readonly changed: boolean;
  readonly toggleTarget?: 'on' | 'off' | null;
}

/** 字符域：整批一次判定 toggle 目标态（R121），由 D03 的 `applyCharacterFormatToRanges` 保证。 */
function applyCharacterStep(
  model: DocumentModel,
  ranges: Parameters<typeof applyCharacterFormatToRanges>[1],
  operation: CharacterFormatOperation,
): Result<AppliedStep> {
  const before = model;
  const applied = applyCharacterFormatToRanges(model, ranges, operation);
  if (!applied.ok) return applied;
  return succeed({
    model: applied.value,
    // 不可变更新：模型引用变了才叫改过（未受影响的分支沿用原引用，见 D03 的 structure.ts）。
    changed: applied.value !== before,
    toggleTarget: null,
  });
}

/** 段落域：对范围内每个段落施加同一属性操作。 */
function applyParagraphStep(
  model: DocumentModel,
  ranges: Parameters<typeof applyCharacterFormatToRanges>[1],
  operation: ParagraphPropertyOperation,
): Result<AppliedStep> {
  let next = model;
  let changed = false;

  for (const range of ranges) {
    const paragraph = requireParagraph(next, range.node_id);
    if (!paragraph.ok) return paragraph;

    const after = applyParagraphOperation(paragraph.value, operation);
    if (after === paragraph.value) continue;

    const replaced = replaceParagraph(next, range.node_id, after);
    if (!replaced.ok) return replaced;
    next = replaced.value;
    changed = true;
  }

  return succeed({ model: next, changed });
}

/**
 * 把一条段落属性操作施加到一个段落上。
 *
 * 返回**可能是同一个对象**（属性未变时——例如已居中的段落再居中）：调用方据此判"真的改了吗"，
 * 从而让幂等重试（R137）在回执里表现为 `changed: false` 而不是又写一遍。
 */
function applyParagraphOperation(
  paragraph: ParagraphNode,
  operation: ParagraphPropertyOperation,
): ParagraphNode {
  if (operation.kind === 'clearParagraphFormat') {
    return clearParagraphFormat(paragraph);
  }
  const properties = applyParagraphProperties(paragraph.properties, operation);
  return properties === paragraph.properties ? paragraph : { ...paragraph, properties };
}

function applyParagraphProperties(
  props: ParagraphProperties,
  operation: ParagraphPropertyOperation,
): ParagraphProperties {
  switch (operation.kind) {
    case 'setAlignment':
      return setAlignment(props, operation.alignment);
    case 'setLineSpacing':
      return setLineSpacing(props, operation.spacing);
    case 'setSpacingBefore':
      return setSpacingBefore(props, operation.spacing);
    case 'setSpacingAfter':
      return setSpacingAfter(props, operation.spacing);
    case 'setFirstLineIndent':
      return setFirstLineIndent(props, operation.amount);
    case 'setHangingIndent':
      return setHangingIndent(props, operation.amount);
    case 'setLeftIndent':
      return setLeftIndent(props, operation.amount);
    case 'setRightIndent':
      return setRightIndent(props, operation.amount);
    case 'clearParagraphFormat':
      // 上面已提前返回；这里只是让 switch 穷尽（`noFallthroughCasesInSwitch` 要求显式分支）。
      return props;
    default: {
      const exhaustive: never = operation;
      throw new Error(`未知的段落属性操作：${JSON.stringify(exhaustive)}`);
    }
  }
}
