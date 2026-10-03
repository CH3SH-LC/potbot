/**
 * 拼写与语法检查单测（WF-095）。
 *
 * 三条判据的用例分组：
 * 1. **不以固定提示冒充真实检查**——干净文本 + 规则集 ⇒ **0 条提示**；命中完全由文本决定。
 * 2. **只提示不改**——`check` 的返回值里没有模型；只有"接受"才产生修改。
 * 3. **不擅自改全文**——接受一条提示，另一处同词**原样保留**；忽略则模型引用不变。
 *
 * 另有两个容易被忽略的正确性点：位置是**码位**（emoji 在前时不能偏 1），
 * 以及跨 run 的命中（选区包负责切分，检查器只管坐标）。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../model/types.js';
import { paragraphText } from '../selection/structure.js';
import { breakNode, document, paragraph, paragraphOfRuns, run } from '../selection/testing.js';
import type { Result } from '../selection/types.js';
import { applyProofingDecision, createRuleBasedChecker, describeIssue, type ProofingIssue, type ProofingRule } from './spelling.js';
import { sampleRules } from './testing.js';

const PICTO = String.fromCodePoint(0x1f600);

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  return result.value;
}

function textOf(model: DocumentModel, nodeId: string): string {
  for (const block of model.blocks) {
    if (block.kind === 'paragraph' && block.id === nodeId) return paragraphText(block);
  }
  throw new Error(`找不到段落 ${nodeId}`);
}

function checker() {
  return unwrap(createRuleBasedChecker(sampleRules()));
}

describe('检查：结果由文本决定，不是固定提示', () => {
  it('干净文本 ⇒ 0 条提示（同一规则集）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'The cat sat on the mat.']])]);
    const issues = unwrap(checker().check(model));
    expect(issues).toEqual([]);
  });

  it('命中数与位置由文本决定，且带规则 id / 类型 / 建议', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'teh cat and teh dog']])]);
    const issues = unwrap(checker().check(model));

    expect(issues.map((issue) => [issue.location.start, issue.location.end])).toEqual([
      [0, 3],
      [12, 15],
    ]);
    expect(issues.every((issue) => issue.rule_id === 'common-typo-teh')).toBe(true);
    expect(issues[0]!.kind).toBe('spelling');
    expect(issues[0]!.suggestions).toEqual(['the']);
    expect(issues[0]!.message).toContain('teh');
    expect(issues[0]!.base_revision).toBe(1);
    expect(describeIssue(issues[0]!)).toContain('@0–3');
  });

  it('位置是**码位**：emoji 在命中之前时不能按 UTF-16 码元算', () => {
    const model = document([paragraphOfRuns('p1', [['r1', `${PICTO} teh`]])]);
    const issues = unwrap(checker().check(model));
    expect(issues).toHaveLength(1);
    // 码位：😀(0) 空格(1) t(2) e(3) h(4) ⇒ [2,5)；按 UTF-16 会是 [3,6)
    expect([issues[0]!.location.start, issues[0]!.location.end]).toEqual([2, 5]);
    expect(issues[0]!.location.text).toBe('teh');
  });

  it('跨 run 的命中也能定位并接受（切分由选区包负责）', () => {
    const model = document([paragraph('p1', [run('r1', 'te'), run('r2', 'h cat')])]);
    const issues = unwrap(checker().check(model));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.location.start).toBe(0);
    expect(issues[0]!.location.end).toBe(3);

    const applied = unwrap(applyProofingDecision(model, issues[0]!, { kind: 'accept' }));
    expect(textOf(applied.model, 'p1')).toBe('the cat');
  });

  it('中文规则与英文规则并存；同一位置多规则命中时按位置排序', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '这本书的的写法']])]);
    const issues = unwrap(checker().check(model));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('grammar');
    expect(issues[0]!.location.text).toBe('的的');
  });

  it('只检查指定段落时，其余段落不产生提示', () => {
    const model = document([
      paragraphOfRuns('p1', [['r1', 'teh']]),
      paragraphOfRuns('p2', [['r2', 'teh']]),
    ]);
    const issues = unwrap(checker().check(model, ['p2']));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.location.paragraph_id).toBe('p2');
  });
});

describe('接受 / 忽略：不擅自改全文', () => {
  it('接受一条只改那一处，另一处同词原样保留', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'teh cat and teh dog']])]);
    const issues = unwrap(checker().check(model));
    const first = issues[0]!;

    const applied = unwrap(applyProofingDecision(model, first, { kind: 'accept' }));

    expect(applied.applied).toBe('accepted');
    expect(applied.changed).toBe(true);
    expect(applied.replacement).toBe('the');
    expect(textOf(applied.model, 'p1')).toBe('the cat and teh dog');
    expect(applied.model.revision).toBe(model.revision + 1);
    // 第二处**没有**被顺手改掉
    expect(textOf(applied.model, 'p1')).toContain('and teh dog');
  });

  it('接受后可显式指定替换文本', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'teh']])]);
    const issue = unwrap(checker().check(model))[0]!;
    const applied = unwrap(applyProofingDecision(model, issue, { kind: 'accept', replacement: 'the ' }));
    expect(textOf(applied.model, 'p1')).toBe('the ');
  });

  it('忽略：模型引用**完全不变**（一个码位都没动）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'teh']])]);
    const issue = unwrap(checker().check(model))[0]!;
    const applied = unwrap(applyProofingDecision(model, issue, { kind: 'ignore' }));

    expect(applied.applied).toBe('ignored');
    expect(applied.changed).toBe(false);
    expect(applied.replacement).toBeNull();
    expect(applied.model).toBe(model); // 同一对象引用
  });

  it('迟到的接受被拒：改了文档之后，基于旧 revision 的提示失效（R142/R143）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'teh cat and teh dog']])]);
    const issues = unwrap(checker().check(model));
    const applied = unwrap(applyProofingDecision(model, issues[0]!, { kind: 'accept' }));

    const stale = applyProofingDecision(applied.model, issues[1]!, { kind: 'accept' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe('stale_revision');
      expect(stale.detail.currentRevision).toBe(2);
      expect(stale.detail.requestedRevision).toBe(1);
    }
  });

  it('定位处文本与提示不符 ⇒ precondition（不按旧坐标硬改）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'teh']])]);
    const drifted: ProofingIssue = {
      ...unwrap(checker().check(model))[0]!,
      location: { paragraph_id: 'p1', start: 0, end: 3, text: 'zzz' },
    };
    const result = applyProofingDecision(model, drifted, { kind: 'accept' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('没有建议又没给替换文本 ⇒ precondition；范围含软换行 ⇒ unsupported', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'xyz']])]);
    const noSuggestion = unwrap(
      createRuleBasedChecker([
        { rule_id: 'r-x', kind: 'spelling', message: '可疑', suggestions: [], match: { kind: 'literal', text: 'xyz' } },
      ]),
    );
    const issue = unwrap(noSuggestion.check(model))[0]!;
    const result = applyProofingDecision(model, issue, { kind: 'accept' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('precondition');

    const withBreak = document([paragraph('p1', [run('r1', 'a'), breakNode('b1'), run('r2', 'b')])]);
    const newlineRule = unwrap(
      createRuleBasedChecker([
        { rule_id: 'r-nl', kind: 'grammar', message: '软换行', suggestions: [' '], match: { kind: 'regex', source: '\\n', flags: '' } },
      ]),
    );
    const breakIssue = unwrap(newlineRule.check(withBreak))[0]!;
    const breakResult = applyProofingDecision(withBreak, breakIssue, { kind: 'accept' });
    expect(breakResult.ok).toBe(false);
    if (!breakResult.ok) expect(breakResult.code).toBe('unsupported');
  });
});

describe('检查器构造与查询的拒绝路径', () => {
  it('规则本身非法 ⇒ 构造期拒绝（不让"永远不命中"变成"检查通过"）', () => {
    const bad: readonly ProofingRule[] = [
      { rule_id: 'r1', kind: 'spelling', message: 'm', suggestions: [], match: { kind: 'regex', source: '(', flags: '' } },
    ];
    const compiled = createRuleBasedChecker(bad);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.code).toBe('invalid_query');

    const emptyLiteral = createRuleBasedChecker([
      { rule_id: 'r1', kind: 'spelling', message: 'm', suggestions: [], match: { kind: 'literal', text: '' } },
    ]);
    expect(emptyLiteral.ok).toBe(false);

    const duplicated = createRuleBasedChecker([
      { rule_id: 'r1', kind: 'spelling', message: 'm', suggestions: [], match: { kind: 'literal', text: 'a' } },
      { rule_id: 'r1', kind: 'spelling', message: 'm', suggestions: [], match: { kind: 'literal', text: 'b' } },
    ]);
    expect(duplicated.ok).toBe(false);

    const unnamed = createRuleBasedChecker([
      { rule_id: '', kind: 'spelling', message: 'm', suggestions: [], match: { kind: 'literal', text: 'a' } },
    ]);
    expect(unnamed.ok).toBe(false);
  });

  it('空规则集 ⇒ 任何文本都 0 条提示（没有"内置兜底提示"）', () => {
    const empty = unwrap(createRuleBasedChecker([]));
    const model = document([paragraphOfRuns('p1', [['r1', 'teh teh teh 的的']])]);
    expect(unwrap(empty.check(model))).toEqual([]);
    expect(empty.rule_ids).toEqual([]);
  });

  it('检查不存在的段落 ⇒ unknown_node', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'teh']])]);
    const result = checker().check(model, ['p1', 'p9']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_node');
  });

  it('规则 id 会随检查器暴露出来（回执用）', () => {
    const ids = checker().rule_ids;
    expect(ids).toContain('common-typo-teh');
    expect(ids).toHaveLength(3);
  });
});
