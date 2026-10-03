/**
 * WCF-D10 验收用例 ②：**变异判别力**（合同 R168 / 场景 T16）。
 *
 * 判据不是"读回器说 ok"，而是"**说 ok 的尺子在被改动时会红，且红在对应的那一格**"：
 *
 * 1. **未变异对照必须通过** —— 证明尺子不是恒红；
 * 2. 每个变异**必须**被**对应**判据抓住 —— 证明尺子不是恒绿，也不是"一动就全红"蒙对；
 * 3. `tamper-hash` 刻意做成语义中性，所以它**只能**被 `expect_sha256` 抓住——
 *    其余格式判据必须仍然通过（这是"对应判据"最强的隔离证据）；
 * 4. 变异在样本上**不可应用**时退出码必须是 3（显式失败），**绝不静默变成空操作**；
 * 5. `--mutate` 不得改动输入文件。
 *
 * 变异实现**只有一份**（`scripts/demo/verify-docx.py` 的 `apply_mutation`）：
 * `--self-test` 在合成样本上用它，本用例在真实语料上用它。
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
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
  EVIDENCE_AUTO_DIR,
  FIXTURES,
  MUTATIONS,
  assertToolAvailable,
  checkByName,
  failedChecks,
  listMutations,
  mutate,
  verifyWithExpectation,
  type MutationKind,
  type VerifierRun,
} from './support.js';

/**
 * 跑完整变异矩阵的语料（旧 golden 只做对照与"不可应用"用例）。
 * 含 **真实 Microsoft Word 保存出来**的 corpus-c——判别力必须对真实语料同样成立。
 */
const CORPUS = [
  { key: 'corpus-a', ...FIXTURES.corpusA },
  { key: 'corpus-b', ...FIXTURES.corpusB },
  { key: 'corpus-c-word16', ...FIXTURES.wordCorpus },
] as const;

const KINDS = Object.keys(MUTATIONS) as MutationKind[];

interface MutationCase {
  readonly fixtureKey: string;
  readonly docx: string;
  readonly expectation: string;
  readonly kind: MutationKind;
  readonly expectedCheck: string;
}

const MATRIX: MutationCase[] = [];
for (const fixture of CORPUS) {
  for (const kind of KINDS) {
    MATRIX.push({
      fixtureKey: fixture.key,
      docx: fixture.docx,
      expectation: fixture.expectation,
      kind,
      expectedCheck: MUTATIONS[kind],
    });
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function saveEvidence(name: string, run: VerifierRun): void {
  writeFileSync(
    `${EVIDENCE_AUTO_DIR}/${name}.txt`,
    `# ${name}\n# command: ${run.command}\n# exitCode: ${run.exitCode}\n`
    + `# stderr: ${run.stderr}\n# stdout:\n${run.stdout}\n`,
    'utf8',
  );
}

let workdir: string;

beforeAll(() => {
  assertToolAvailable();
  workdir = mkdtempSync(join(tmpdir(), 'wcf-d10-mutation-'));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('变异登记表不得与读回器脱节', () => {
  it('本文件的 MUTATIONS 与工具 `--list-mutations` 的 kind→判据映射逐条一致', () => {
    const declared = new Map(
      listMutations().map((item) => [item.kind, item.expected_check] as const),
    );
    expect([...declared.keys()].sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      expect(declared.get(kind), `${kind} 的对应判据不一致`).toBe(MUTATIONS[kind]);
    }
  });
});

describe('未变异对照必须通过（尺子不是恒红）', () => {
  it.each(CORPUS)('$key：未变异样本通过全部期望判据', (fixture) => {
    const run = verifyWithExpectation(fixture.docx, fixture.expectation);
    saveEvidence(`control-${fixture.key}`, run);
    expect(run.exitCode).toBe(0);
    expect(run.parsed?.ok).toBe(true);
    expect(failedChecks(run)).toEqual([]);
  });
});

describe('每个变异必须被对应判据抓住（尺子不是恒绿）', () => {
  it.each(MATRIX)(
    '$fixtureKey × $kind → $expectedCheck',
    (testCase) => {
      const { fixtureKey, docx, expectation, kind, expectedCheck } = testCase;
      const mutated = join(workdir, `${fixtureKey}--${kind}.docx`);

      const mutationRun = mutate(kind, docx, mutated);
      expect(
        mutationRun.exitCode,
        `变异 ${kind} 在 ${fixtureKey} 上不可应用：${mutationRun.stdout}`,
      ).toBe(0);
      expect(mutationRun.parsed?.ok).toBe(true);
      expect(existsSync(mutated)).toBe(true);
      // 变异真的改了字节（否则下面的"被抓住"是假的）
      expect(sha256File(mutated)).not.toBe(sha256File(docx));

      const run = verifyWithExpectation(mutated, expectation);
      saveEvidence(`mutation-${fixtureKey}-${kind}`, run);
      expect(run.exitCode).not.toBe(0);
      expect(run.parsed?.ok).toBe(false);
      expect(run.parsed?.error?.code).toBe('expectation_mismatch');
      expect(failedChecks(run)).toContain(expectedCheck);

      // 隔离：**对应判据**负责抓它，别的判据不该被牵连（"一动就全红"不算判别力）
      if (kind !== 'drop-unknown-part') {
        expect(checkByName(run, 'expect_required_parts').passed, '部件清单不该被动过').toBe(true);
      }
      if (kind !== 'break-relationship' && kind !== 'drop-unknown-part') {
        expect(checkByName(run, 'expect_relationships').passed, '关系不该被动过').toBe(true);
      }
      if (kind !== 'indent-unit-swap') {
        expect(checkByName(run, 'expect_paragraph_indent').passed, '缩进不该被动过').toBe(true);
      }
      if (kind !== 'drop-rpr' && kind !== 'resize-font') {
        expect(checkByName(run, 'expect_run_properties').passed, '字符属性不该被动过').toBe(true);
      }
      if (kind !== 'resize-font') {
        expect(checkByName(run, 'expect_paragraph_text').passed, '文本不该被动过').toBe(true);
      }
    },
  );

  it('tamper-hash 是语义中性变异：**只有** expect_sha256 该红', () => {
    const mutated = join(workdir, 'corpus-a--tamper-hash-isolation.docx');
    const mutationRun = mutate('tamper-hash', FIXTURES.corpusA.docx, mutated);
    expect(mutationRun.exitCode).toBe(0);

    const run = verifyWithExpectation(mutated, FIXTURES.corpusA.expectation);
    saveEvidence('mutation-corpus-a-tamper-hash-isolation', run);
    expect(failedChecks(run)).toEqual(['expect_sha256']);
    for (const name of [
      'expect_run_properties',
      'expect_paragraph_indent',
      'expect_paragraph_spacing',
      'expect_paragraph_text',
      'expect_required_parts',
      'expect_relationships',
      'expect_sections',
      'expect_tables',
      'expect_deflate',
      'expect_units_recompute',
    ]) {
      expect(checkByName(run, name).passed, `${name} 不该被语义中性变异牵连`).toBe(true);
    }
  });
});

describe('变异不可应用时必须显式失败（退出码 3），绝不静默空操作', () => {
  const INAPPLICABLE_ON_LEGACY: readonly MutationKind[] = [
    'drop-rpr',       // 旧 golden 里没有 <w:rPr>
    'resize-font',    // 没有 <w:sz>
    'indent-unit-swap', // 没有 <w:ind>
    'break-relationship', // 没有 word/_rels/document.xml.rels
    'drop-unknown-part',  // 只有 3 个基础部件
  ];

  it.each(INAPPLICABLE_ON_LEGACY)('legacy-golden × %s：退出码 3，不产出误导性输出', (kind) => {
    const destination = join(workdir, `legacy--${kind}.docx`);
    const run = mutate(kind, FIXTURES.legacyGolden.docx, destination);
    expect(run.exitCode).toBe(3);
    expect(run.parsed?.ok).toBe(false);
    expect(run.parsed?.error?.code).toBe('mutation_not_applicable');
    expect(existsSync(destination), '不可应用时不应写出目标文件').toBe(false);
  });

  it('tamper-hash 在旧 golden 上**是**可应用的（有 w:body），说明退出码 3 由真实判据决定', () => {
    const destination = join(workdir, 'legacy--tamper-hash.docx');
    const run = mutate('tamper-hash', FIXTURES.legacyGolden.docx, destination);
    expect(run.exitCode).toBe(0);
    expect(existsSync(destination)).toBe(true);
  });
});

describe('--mutate 不得改动输入文件', () => {
  it('施加 6 种变异后，源 fixture 摘要逐字节不变', () => {
    const copies = join(workdir, 'originals');
    rmSync(copies, { recursive: true, force: true });
    mkdirSync(copies, { recursive: true });
    const source = join(copies, 'corpus-a.docx');
    copyFileSync(FIXTURES.corpusA.docx, source);
    const before = sha256File(source);

    for (const kind of KINDS) {
      const destination = join(workdir, `noop-check--${kind}.docx`);
      mutate(kind, source, destination);
      expect(sha256File(source), `变异 ${kind} 动了输入文件`).toBe(before);
      expect(sha256File(source)).toBe(sha256File(FIXTURES.corpusA.docx));
    }
  });
});
