/**
 * WCF-D71 验收用例：**引用与审阅元素的独立读回**（合同 R158 / R161 / R166–R168）。
 *
 * ## 为什么需要这一组
 *
 * WCF-D60 把缺口 7 登记在案：独立读回器 `scripts/demo/verify-docx.py` 当时**不解析**
 * 它新引入的书签 / 超链接 / 域 / 脚注尾注 / 批注 / 修订——所以 design-05-P7 的"独立读回"
 * **只覆盖包与关系完整性，不覆盖元素语义**；P9 的公式/图表同样没有独立判据。
 * 本组把这一层补上，并给出**判别力证据**：每个变异必须被**对应**判据抓住，
 * 未变异对照必须通过（R168 / T16）。
 *
 * ## 判据的三条来源（都不 import `src/**` 当预期值，R167）
 *
 * 1. **corpus-d**（手拼 OOXML，与读回器 `reference_corpus_parts()` 同源）——期望是
 *    **按 OOXML 规范手写声明**的语义；它同时声明 `unparsed_elements: {}`，
 *    即"这份样本里没有未解析元素"本身是一条判据。
 * 2. **corpus-e**（potbot WCF-D60 **真实产物**的逐字节副本）——期望是**人工读 XML** 得到的，
 *    用来证明读回器能按新判据读回**生产实现真的写出来的**元素。
 * 3. **变异矩阵**——`--mutate` 只有一份实现（读回器里），本组在真实 fixture 上复用它。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FIXTURES,
  REFERENCE_MUTATIONS,
  REPO_ROOT,
  assertToolAvailable,
  checkByName,
  failedChecks,
  listMutations,
  listReferenceMutations,
  mutate,
  readJson,
  verifyPlain,
  verifyWithExpectation,
  type ReferenceMutationKind,
  type VerifierRun,
} from './support.js';

/** WCF-D71 证据目录（与 D10 的证据目录并列，互不覆盖）。 */
const EVIDENCE_DIR = join(
  REPO_ROOT, '.dev-evidence', 'word-common-features', 'WCF-20261002-A', 'D71', 'auto',
);

const REFERENCE_FIXTURES = [
  { key: 'corpus-d', ...FIXTURES.referenceCorpus },
  { key: 'corpus-e', ...FIXTURES.annotationExport },
] as const;

const REFERENCE_KINDS = Object.keys(REFERENCE_MUTATIONS) as ReferenceMutationKind[];

let workdir: string;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function saveEvidence(name: string, run: VerifierRun): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    `${EVIDENCE_DIR}/${name}.txt`,
    `# ${name}\n# command: ${run.command}\n# exitCode: ${run.exitCode}\n`
    + `# stderr: ${run.stderr}\n# stdout:\n${run.stdout}\n`,
    'utf8',
  );
}

beforeAll(() => {
  // 缺 python / 缺读回器 / 缺 fixture 一律**抛错失败**，不 skip 计通过。
  assertToolAvailable();
  workdir = mkdtempSync(join(tmpdir(), 'wcf-d71-reference-'));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('变异登记表不得与读回器脱节', () => {
  it('引用/审阅组的 kind→判据映射与 `--list-mutations` 的 reference_mutations 逐条一致', () => {
    const declared = new Map(
      listReferenceMutations().map((item) => [item.kind, item.expected_check] as const),
    );
    expect([...declared.keys()].sort()).toEqual([...REFERENCE_KINDS].sort());
    for (const kind of REFERENCE_KINDS) {
      expect(declared.get(kind), `${kind} 的对应判据不一致`).toBe(REFERENCE_MUTATIONS[kind]);
    }
  });

  it('基础组 `mutations` 仍是原来的 6 个（扩展没有动老契约）', () => {
    expect(listMutations().map((item) => item.kind).sort()).toEqual([
      'break-relationship', 'drop-rpr', 'drop-unknown-part',
      'indent-unit-swap', 'resize-font', 'tamper-hash',
    ]);
  });

  it('本组声明的判据名都真实存在于读回器（不是自说自话）', () => {
    const run = verifyWithExpectation(FIXTURES.referenceCorpus.docx, FIXTURES.referenceCorpus.expectation);
    const names = new Set((run.parsed?.checks ?? []).map((item) => item.name));
    for (const check of new Set(Object.values(REFERENCE_MUTATIONS))) {
      expect(names.has(check), `读回器没有判据 ${check}`).toBe(true);
    }
  });
});

describe('未变异对照必须通过（尺子不是恒红）', () => {
  it.each(REFERENCE_FIXTURES)('$key：通过全部期望判据', (fixture) => {
    const run = verifyWithExpectation(fixture.docx, fixture.expectation);
    saveEvidence(`control-${fixture.key}`, run);
    expect(run.exitCode, `stdout=${run.stdout.slice(0, 800)}`).toBe(0);
    expect(run.parsed?.ok).toBe(true);
    expect(failedChecks(run)).toEqual([]);
  });
});

describe('corpus-e：生产实现写出的引用/审阅元素被独立读回', () => {
  it('书签成对、内部锚点对得上、外部目标只记录不抓取（R161）', () => {
    const run = verifyWithExpectation(FIXTURES.annotationExport.docx, FIXTURES.annotationExport.expectation);
    const refs = run.parsed?.references;
    expect(refs, '读回器没有给出 references').toBeTruthy();
    if (refs === null || refs === undefined) return;

    expect(refs.bookmarks.paired).toBe(true);
    expect(refs.bookmarks.unpaired_start_ids).toEqual([]);
    expect(refs.bookmarks.unpaired_end_ids).toEqual([]);
    expect(refs.bookmarks.names).toEqual(['总则']);

    const external = refs.hyperlinks.filter((item) => item.kind === 'external');
    expect(external).toHaveLength(1);
    // **不抓取**：只如实记录 TargetMode 与 Target 字符串（没有任何网络访问）。
    expect(external[0]?.target_mode).toBe('External');
    expect(external[0]?.target).toBe('https://example.com/wcf-d60');
    expect(refs.external_targets).toEqual([
      { relationship_id: 'rId13', target: 'https://example.com/wcf-d60' },
    ]);

    const internal = refs.hyperlinks.filter((item) => item.kind === 'internal');
    expect(internal).toHaveLength(1);
    expect(internal[0]?.anchor).toBe('总则');
    expect(internal[0]?.anchor_resolves, '内部锚点必须对上已存在的书签名').toBe(true);
    expect(refs.dangling_anchors).toEqual([]);
  });

  it('域的三态分开报（R158）：交叉引用有指令无缓存、目录有缓存未刷新', () => {
    const run = verifyWithExpectation(FIXTURES.annotationExport.docx, FIXTURES.annotationExport.expectation);
    const refs = run.parsed?.references;
    if (refs === null || refs === undefined) throw new Error('读回器没有给出 references');

    const simple = refs.fields.find((item) => item.kind === 'simple');
    expect(simple?.instruction).toBe(' REF 总则 \\h ');
    expect(simple?.has_instruction).toBe(true);
    expect(simple?.has_cache).toBe(false);
    expect(simple?.state).toBe('instruction_no_cache');
    expect(simple?.refreshed).toBe(false);

    const complex = refs.fields.find((item) => item.kind === 'complex');
    expect(complex?.instruction).toContain('TOC');
    expect(complex?.has_cache).toBe(true);
    expect(complex?.dirty).toBe(true);
    expect(complex?.state).toBe('cached_not_refreshed');
    expect(refs.field_pairing).toMatchObject({ begin: 1, separate: 1, end: 1, balanced: true });
  });

  it('脚注/尾注/批注的新部件与关系都在，且引用 id 对得上', () => {
    const run = verifyWithExpectation(FIXTURES.annotationExport.docx, FIXTURES.annotationExport.expectation);
    const refs = run.parsed?.references;
    if (refs === null || refs === undefined) throw new Error('读回器没有给出 references');

    expect(refs.notes.footnotes).toMatchObject({
      part: 'word/footnotes.xml', present: true, relationship: true, reference_ids: [1],
      dangling_reference_ids: [], unreferenced_note_ids: [],
    });
    expect(refs.notes.endnotes).toMatchObject({
      part: 'word/endnotes.xml', present: true, relationship: true, reference_ids: [1],
    });
    expect(refs.comments).toMatchObject({
      part: 'word/comments.xml', part_present: true, relationship: true,
      paired_range_ids: [1], unpaired_range_start_ids: [], unpaired_range_end_ids: [],
      dangling_reference_ids: [], unreferenced_comment_ids: [],
    });
    expect(refs.revisions.ins).toBe(1);
    expect(refs.revisions.del).toBe(1);
    expect(refs.revisions.authors).toEqual(['审阅人']);
    // 删除区间必须用 `w:delText`，不能误用 `w:t`。
    expect(refs.revisions.del_without_del_text).toBe(0);
  });
});

describe('每个引用/审阅变异必须被对应判据抓住（尺子不是恒绿）', () => {
  it.each(REFERENCE_KINDS)('%s → %s', (kind) => {
    const { docx, expectation } = FIXTURES.referenceCorpus;
    const mutated = join(workdir, `corpus-d--${kind}.docx`);

    const mutationRun = mutate(kind, docx, mutated);
    expect(mutationRun.exitCode, `变异 ${kind} 不可应用：${mutationRun.stdout}`).toBe(0);
    expect(existsSync(mutated)).toBe(true);
    // 变异真的改了字节（否则下面的"被抓住"是假的）
    expect(sha256File(mutated)).not.toBe(sha256File(docx));

    const run = verifyWithExpectation(mutated, expectation);
    saveEvidence(`mutation-corpus-d-${kind}`, run);
    expect(run.parsed?.ok).toBe(false);
    expect(run.parsed?.error?.code).toBe('expectation_mismatch');
    expect(failedChecks(run), `${kind} 必须被 ${REFERENCE_MUTATIONS[kind]} 抓住`)
      .toContain(REFERENCE_MUTATIONS[kind]);

    // 读回器本身没有被变异打挂：元素解析仍然成功（失败是**判据**给的，不是解析崩了）
    expect(checkByName(run, 'references_parsed').passed,
      `变异 ${kind} 不该让解析本身失败`).toBe(true);
  });

  it('隔离：删一个 bookmarkEnd 只该动书签判据，不该牵连超链接/批注/域', () => {
    const mutated = join(workdir, 'isolation--drop-bookmark-end.docx');
    expect(mutate('drop-bookmark-end', FIXTURES.referenceCorpus.docx, mutated).exitCode).toBe(0);
    const run = verifyWithExpectation(mutated, FIXTURES.referenceCorpus.expectation);
    expect(failedChecks(run)).toContain('expect_bookmarks');
    for (const name of ['expect_hyperlinks', 'expect_comments', 'expect_fields',
      'expect_note_parts', 'expect_revisions', 'expect_math_structure']) {
      expect(checkByName(run, name).passed, `${name} 不该被书签变异牵连`).toBe(true);
    }
  });

  it('隔离：改域的三态只该动 expect_fields，不该牵连修订/注记', () => {
    const mutated = join(workdir, 'isolation--strip-field-cache.docx');
    expect(mutate('strip-field-cache', FIXTURES.referenceCorpus.docx, mutated).exitCode).toBe(0);
    const run = verifyWithExpectation(mutated, FIXTURES.referenceCorpus.expectation);
    expect(failedChecks(run)).toContain('expect_fields');
    for (const name of ['expect_revisions', 'expect_note_parts', 'expect_bookmarks',
      'expect_math_structure', 'expect_chart_parts']) {
      expect(checkByName(run, name).passed, `${name} 不该被域变异牵连`).toBe(true);
    }
  });
});

describe('未解析元素必须显式列出（不是"没报错所以没问题"）', () => {
  it('读回结果里始终带未解析清单与范围说明', () => {
    // 未解析清单**不依赖 --expect**（无期望文件时也照样给出），这里同时验证两种调用。
    const plain = verifyPlain(FIXTURES.referenceCorpus.docx);
    saveEvidence('coverage-reference-corpus-plain', plain);
    expect(plain.parsed?.coverage, '无 --expect 时也必须给 coverage').toBeTruthy();
    expect(plain.parsed?.coverage).toEqual({});
    expect((plain.parsed?.coverage_notes ?? []).length).toBeGreaterThan(0);

    const run = verifyWithExpectation(FIXTURES.referenceCorpus.docx, FIXTURES.referenceCorpus.expectation);
    saveEvidence('coverage-reference-corpus', run);
    expect(run.parsed?.coverage, '读回器必须给出 coverage 字段').toBeTruthy();
    expect(Array.isArray(run.parsed?.coverage_notes)).toBe(true);
    expect((run.parsed?.coverage_notes ?? []).length).toBeGreaterThan(0);
    // corpus-d 声明了 `unparsed_elements: {}` ⇒ 该样本里没有未解析元素。
    expect(run.parsed?.coverage).toEqual({});
    expect(checkByName(run, 'expect_unparsed_elements').passed).toBe(true);
  });

  it('这条判据不是空的：声明一个并不存在的"未解析元素"必须变红', () => {
    const baseExpectation = readJson<Record<string, unknown>>(
      FIXTURES.referenceCorpus.expectation,
    );
    const tampered = {
      ...baseExpectation,
      unparsed_elements: { 'word/document.xml': ['w:notActuallyUnparsed'] },
    };
    const path = join(workdir, 'unparsed-mismatch.json');
    writeFileSync(path, JSON.stringify(tampered), 'utf8');
    const run = verifyWithExpectation(FIXTURES.referenceCorpus.docx, path);
    saveEvidence('expectation-unparsed-mismatch', run);
    expect(run.parsed?.ok).toBe(false);
    expect(failedChecks(run)).toContain('expect_unparsed_elements');
  });

  it('缺文件不得被当成通过（显式失败，不静默）', () => {
    const run = verifyPlain(join(workdir, 'does-not-exist.docx'));
    saveEvidence('missing-file', run);
    expect(run.exitCode).not.toBe(0);
    expect(run.parsed?.ok).toBe(false);
    expect(run.parsed?.error?.code).toBe('file_missing');
  });
});
