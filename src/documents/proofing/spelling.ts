/**
 * 拼写与语法检查（WF-095）。
 *
 * ## 三条硬规矩，以及它们是怎么被"做进结构"的
 *
 * 1. **不未经同意改全文**——检查与修改是**两个**函数：`check` 只产出
 *    `ProofingIssue`（规则 id + 位置 + 建议），**不返回模型**；只有
 *    `applyProofingDecision(..., {kind:'accept'})` 才产出新模型，且**只改那一处范围**。
 *    留意 `check` 的返回类型里根本没有 `DocumentModel` 字段——"顺手全改了"写不出来。
 * 2. **不以固定提示冒充真实检查**——规则是**调用方显式给的**（`ProofingRule`），
 *    检查器没有内置词表、也没有兜底提示。空规则集 + 干净文本 ⇒ **0 条提示**；
 *    规则集里的 `message` 只是文案，命中完全取决于文本是否真的匹配。
 * 3. **提示与定位**——每条提示带 `(paragraph_id, start, end, text)`（**码位**偏移，R102），
 *    上层据此高亮/跳转；`describeIssue` 给一句人话。
 *
 * ## 迟到的接受必须被拒（R142/R143）
 *
 * 每条提示记住它是在哪个 `base_revision` 上产生的。文档一旦被改过，旧提示的偏移就
 * 不再可靠——此时接受它等于"按旧坐标改新文本"，正是 R114 要挡的事。因此
 * `applyProofingDecision` 先比 `base_revision`，不符即 `stale_revision` 并回报当前 revision。
 */

import type { DocumentModel, Revision } from '../model/types.js';
import { replaceRangeInInlines } from '../selection/inline-map.js';
import { collectParagraphs, paragraphText, replaceParagraph } from '../selection/structure.js';
import { fail, succeed, type Result } from '../selection/types.js';
import { codePointsToText, readCodePoints } from './symbols.js';

export type IssueKind = 'spelling' | 'grammar';

/** 一条检查规则（**由调用方给出**；检查器不内置任何词表或提示）。 */
export interface ProofingRule {
  readonly rule_id: string;
  readonly kind: IssueKind;
  /** 命中时给用户看的话。 */
  readonly message: string;
  /** 建议替换文本（第一条为"接受"时的默认值）。 */
  readonly suggestions: readonly string[];
  readonly match:
    | { readonly kind: 'literal'; readonly text: string }
    | { readonly kind: 'regex'; readonly source: string; readonly flags: string };
}

/** 一条提示（**只有位置与建议，没有模型**）。 */
export interface ProofingIssue {
  readonly issue_id: string;
  readonly rule_id: string;
  readonly kind: IssueKind;
  readonly message: string;
  readonly suggestions: readonly string[];
  readonly location: {
    readonly paragraph_id: string;
    /** 码位偏移（含）。 */
    readonly start: number;
    /** 码位偏移（开）。 */
    readonly end: number;
    /** 命中的原文（回执与核对用）。 */
    readonly text: string;
  };
  /** 产生该提示时的编辑版本（R142）：版本一变，此提示即失效。 */
  readonly base_revision: Revision;
}

export interface ProofingChecker {
  /** 生效的规则 id（回执用）。 */
  readonly rule_ids: readonly string[];
  /** 检查若干段落（缺省 = 全文）。**只读**，不产出模型。 */
  check(model: DocumentModel, paragraphIds?: readonly string[]): Result<readonly ProofingIssue[]>;
}

/** UTF-16 下标 → 码位下标的查找表（`table[i]` = 前 i 个码元含多少个码位）。 */
function utf16ToCodePointTable(text: string): readonly number[] {
  const table = new Array<number>(text.length + 1).fill(0);
  let codePoints = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const isSurrogatePair = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length;
    index += isSurrogatePair ? 2 : 1;
    codePoints += 1;
    table[index] = codePoints;
    if (isSurrogatePair) table[index - 1] = codePoints;
  }
  return table;
}

function compile(rule: ProofingRule): Result<RegExp> {
  if (rule.match.kind === 'literal') {
    if (rule.match.text.length === 0) {
      return fail('invalid_query', `规则 "${rule.rule_id}" 的字面量为空，会匹配任意位置。`, {
        extra: { ruleId: rule.rule_id },
      });
    }
    return succeed(new RegExp(escapeRegExp(rule.match.text), 'gu'));
  }
  try {
    return succeed(new RegExp(rule.match.source, rule.match.flags.includes('g') ? rule.match.flags : `${rule.match.flags}g`));
  } catch (error) {
    return fail('invalid_query', `规则 "${rule.rule_id}" 的正则无法编译：${String(error)}`, {
      extra: { ruleId: rule.rule_id },
    });
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 造一个规则检查器。规则非法（空字面量 / 正则编译失败）在**构造时**拒绝——
 * 不让"这条规则永远不命中"悄悄变成"检查通过了"。
 */
export function createRuleBasedChecker(rules: readonly ProofingRule[]): Result<ProofingChecker> {
  const seen = new Set<string>();
  const compiled: { rule: ProofingRule; pattern: RegExp }[] = [];
  for (const rule of rules) {
    if (typeof rule.rule_id !== 'string' || rule.rule_id.length === 0) {
      return fail('invalid_query', '检查规则必须有非空的 rule_id。');
    }
    if (seen.has(rule.rule_id)) {
      return fail('invalid_query', `检查规则的 rule_id 重复：${rule.rule_id}`, { extra: { ruleId: rule.rule_id } });
    }
    seen.add(rule.rule_id);
    const pattern = compile(rule);
    if (!pattern.ok) return pattern;
    compiled.push({ rule, pattern: pattern.value });
  }

  return succeed({
    rule_ids: compiled.map((item) => item.rule.rule_id),
    check(model: DocumentModel, paragraphIds?: readonly string[]): Result<readonly ProofingIssue[]> {
      const wanted = paragraphIds === undefined ? null : new Set(paragraphIds);
      const issues: ProofingIssue[] = [];
      const missing = paragraphIds === undefined ? [] : [...new Set(paragraphIds)];

      for (const paragraph of collectParagraphs(model.blocks)) {
        const text = paragraphText(paragraph);
        if (wanted !== null && !wanted.has(paragraph.id)) continue;
        if (wanted !== null) {
          const at = missing.indexOf(paragraph.id);
          if (at >= 0) missing.splice(at, 1);
        }
        const table = utf16ToCodePointTable(text);

        for (const { rule, pattern } of compiled) {
          pattern.lastIndex = 0;
          for (;;) {
            const match = pattern.exec(text);
            if (match === null) break;
            if (match[0].length === 0) {
              pattern.lastIndex += 1; // 空匹配：前进一格，避免死循环
              continue;
            }
            const start = table[match.index] ?? 0;
            const end = table[match.index + match[0].length] ?? start;
            issues.push({
              issue_id: `${paragraph.id}:${String(start)}:${rule.rule_id}`,
              rule_id: rule.rule_id,
              kind: rule.kind,
              message: rule.message,
              suggestions: [...rule.suggestions],
              location: { paragraph_id: paragraph.id, start, end, text: match[0] },
              base_revision: model.revision,
            });
          }
        }
      }

      if (missing.length > 0) {
        return fail('unknown_node', `以下段落不存在：${missing.join('、')}`, { extra: { missing: missing.join('、') } });
      }
      issues.sort((left, right) => left.location.start - right.location.start || left.rule_id.localeCompare(right.rule_id));
      return succeed(issues);
    },
  });
}

export type ProofingDecision =
  | { readonly kind: 'accept'; readonly replacement?: string }
  | { readonly kind: 'ignore' };

export interface ProofingApplication {
  readonly model: DocumentModel;
  readonly applied: 'accepted' | 'ignored';
  readonly changed: boolean;
  /** 接受时实际写入的文本（忽略时为 `null`）。 */
  readonly replacement: string | null;
  readonly location: ProofingIssue['location'];
}

/**
 * 接受或忽略一条提示。
 *
 * - `ignore`：返回**同一个**模型对象（`changed: false`），正文一个码位都不动；
 * - `accept`：**只改** `issue.location` 指的那一处；替换文本取 `decision.replacement`
 *   或提示的第一条建议；没有可用的替换文本即 `precondition` 拒绝；
 * - 版本不符 ⇒ `stale_revision`（R142/R143），并带上当前 revision；
 * - 定位处文本与提示记录不符 ⇒ `precondition` 拒绝（不按旧坐标硬改）。
 */
export function applyProofingDecision(
  model: DocumentModel,
  issue: ProofingIssue,
  decision: ProofingDecision,
): Result<ProofingApplication> {
  if (issue.base_revision !== model.revision) {
    return fail(
      'stale_revision',
      `该提示基于 revision ${String(issue.base_revision)}，当前已是 ${String(model.revision)}；旧提示已失效，请重新检查。`,
      { currentRevision: model.revision, requestedRevision: issue.base_revision },
    );
  }

  const paragraph = collectParagraphs(model.blocks).find((item) => item.id === issue.location.paragraph_id);
  if (paragraph === undefined) {
    return fail('unknown_node', `文档中不存在 id 为 "${issue.location.paragraph_id}" 的段落。`, {
      extra: { node_id: issue.location.paragraph_id },
    });
  }

  // 位置核对：即使 revision 相同，也验证"那一处的文本确实是这条提示说的那个"。
  const currentText = codePointsToText(
    readCodePoints(paragraphText(paragraph)).slice(issue.location.start, issue.location.end),
  );
  if (currentText !== issue.location.text) {
    return fail(
      'precondition',
      `定位处文本与提示不符（提示为 "${issue.location.text}"，实际为 "${currentText}"）；拒绝按旧定位修改。`,
      { extra: { expected: issue.location.text, actual: currentText } },
    );
  }

  if (decision.kind === 'ignore') {
    return succeed({ model, applied: 'ignored', changed: false, replacement: null, location: issue.location });
  }

  const replacement = decision.replacement ?? issue.suggestions[0];
  if (typeof replacement !== 'string' || replacement.length === 0) {
    return fail('precondition', '接受提示必须给出非空的替换文本（该提示没有可用建议）。', {
      extra: { issueId: issue.issue_id },
    });
  }

  const replaced = replaceRangeInInlines(paragraph.inlines, issue.location.start, issue.location.end, replacement);
  if (!replaced.ok) return replaced;

  const updated = replaceParagraph(model, paragraph.id, { ...paragraph, inlines: replaced.value });
  if (!updated.ok) return updated;

  return succeed({
    model: { ...updated.value, revision: model.revision + 1 },
    applied: 'accepted',
    changed: true,
    replacement,
    location: issue.location,
  });
}

/** 给回执的一句话（含定位，便于用户跳到那处）。 */
export function describeIssue(issue: ProofingIssue): string {
  return `[${issue.kind}] 第 "${issue.location.text}"（段 ${issue.location.paragraph_id} @${String(issue.location.start)}–${String(issue.location.end)}）：${issue.message}`;
}
