/**
 * **G05 / G04 证据落盘回归**（V3 独立验收；合同 v1.3 R45.1–R45.5 / R46.1–R46.5）。
 *
 * 本文件是**独立验收子智能体**新增的回归测试，不改任何既有实现或共享夹具。
 * 它把 `docs/other/review/DS进度复查与下一步方案-2026-10-02.md` 的 G04 / G05 缺陷探针
 * 按"**拒绝越权 / 不超限 / 不覆盖**"的正向结论重写：
 *
 * | 编号 | 判据 | 用例 |
 * |---|---|---|
 * | R45.1 | 配置 / 依赖清单摘要覆盖四文件 | §2 四文件逐个改 / 删 |
 * | R45.2 | 未登记 `config_digest` 一律不得 `frozen: true`（`match` 由 `null` → `false`） | §1 |
 * | R45.3 | 历史记录原样保留、产物自动降级为开发身份 | §1 末 / §3 |
 * | R45.4 | 配置登记值 / 复算值 / 比对结论写入身份戳 | §1 / §3 |
 * | R45.5 | 逐个改删四文件 ⇒ 发布失败或转开发身份；未改动 ⇒ 通过 | §2 |
 * | R46.1 | 身份与落盘目录同一处决定 | §3 |
 * | R46.2 | 同一目录选择覆盖全部产物（JSON / JSONL） | §4 |
 * | R46.3 | 新运行不写进 `docs/other/evidence/D**` | §4（临时根断言无该目录） |
 * | R46.4 | 落盘前先过守卫；非法文件名在 `mkdir` 之前抛错、无半成品 | §4 |
 * | R46.5 | **真实运行写入器**（afterAll）与既有 41 个正式证据哈希不变 | 见 V3 交付报告第一部分 |
 *
 * ## 为什么 §5 是"静态覆盖检查"
 *
 * G05 的原始缺陷形态是"**只改了目录函数而写入器没接线**"：身份戳已复算，但写入器仍写固定
 * `docs/other/evidence/D??/`。真实运行（R46.5）能证明**当前**没覆盖，却无法阻止下一次改动把
 * 某个写入器改回自选目录。§5 因此对 11 处写入器源码做静态断言：它们必须**全部**经
 * `writeEvidenceArtifacts()` 落盘，且不得再自行拼证据目录、不得直接调 `node:fs` 写入 API。
 *
 * ## 纪律
 *
 * 本文件**不写** `docs/other/evidence/**`：所有真实落盘都显式传 `{ root: <临时目录> }`，
 * 复算与落盘同根。`afterAll` 清理全部临时根。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_EVIDENCE_DIR_ROOT,
  FreezeDigestMismatchError,
  FreezeIdentityError,
  compareWithFreezePoint,
  evidenceIdentityStamp,
  evidenceOutputLocation,
  freezePoint,
  frozenEvidenceDir,
  publishFrozenEvidence,
  recomputeDigests,
  writeEvidenceArtifacts,
  type FreezeIdentity,
} from './freeze-identity.js';
import { CONFIG_MANIFEST_FILES } from './source-digest.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// 临时根与合成候选
// ---------------------------------------------------------------------------

const TEMP_ROOTS: string[] = [];

/** 造一个本次用例独占的临时根（`afterAll` 统一清理；绝不落到真仓库）。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'potbot-g05-landing-'));
  TEMP_ROOTS.push(root);
  return root;
}

/**
 * 造一个**配置夹具根**：真实复制四个配置文件，并放一小撮 `.ts` 使"全量 / 仅 src"域不同
 * （`assertFreezeIdentity()` 要求两者摘要不同；同域会让合成候选在形状自检处就被拒）。
 */
function makeConfigFixtureRoot(): string {
  const root = makeRoot();
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const file of CONFIG_MANIFEST_FILES) {
    copyFileSync(join(REPO_ROOT, file), join(root, file));
  }
  writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
  writeFileSync(join(root, 'tests', 'beta.test.ts'), 'export const beta = 2;\n', 'utf8');
  return root;
}

/**
 * 从**该根的实际复算值**构造一个合成候选冻结点。
 *
 * 注意：这是**测试夹具**，不是"登记一个新冻结点"——它只用来验证守卫在"候选形状合法"时
 * 的判据（`config_digest` 登记与配置复算是否一致），不写入 `FREEZE_IDENTITY_RECORD_PATH`。
 *
 * @param withConfig `false` 时**刻意不登记** `config_digest`（R45.2 的负向场景）。
 */
function candidateFor(root: string, id: string, withConfig: boolean): FreezeIdentity {
  const recomputed = recomputeDigests(root);
  const base = freezePoint();
  // 不继承登记记录的**文件清单**（那会按 145 个真实文件算 added/removed，与临时夹具无关）
  // 与 `config_digest`（由调用方显式决定登记与否）。其余形状字段（命令 / superseded）沿用。
  const {
    config_digest: _noConfig,
    source_tree_files: _noTreeFiles,
    src_only_files: _noSrcFiles,
    ...withoutOptionalLists
  } = base;
  return {
    ...withoutOptionalLists,
    id,
    evidence_file: `docs/other/evidence/${id}.md`,
    source_tree_sha256: recomputed.source_tree.sha256,
    src_only_sha256: recomputed.src_only.sha256,
    ...(withConfig ? { config_digest: recomputed.config.sha256 } : {}),
  };
}

afterAll(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §1 R45.2 / R45.3 / R45.4 —— 未登记配置摘要一律不得 frozen
// ---------------------------------------------------------------------------

describe('§1 G04：未登记 config_digest 一律不得 frozen（R45.2 / R45.3 / R45.4）', () => {
  it('未登记 ⇒ config.match === false（不是 null）且 ok === false，并给出偏差说明', () => {
    const root = makeConfigFixtureRoot();
    const candidate = candidateFor(root, 'FREEZE-95', false);
    const check = compareWithFreezePoint(candidate, recomputeDigests(root));

    expect(check.config.registered).toBe(false);
    expect(check.config.registered_value).toBeNull();
    expect(typeof check.config.match).toBe('boolean');
    expect(check.config.match).not.toBeNull();
    expect(check.config.match).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.deviations.some((line) => line.includes('未登记 config_digest'))).toBe(true);
  });

  it('未登记 ⇒ publishFrozenEvidence() 抛 FreezeDigestMismatchError，不产出 frozen 信封', () => {
    const root = makeConfigFixtureRoot();
    const candidate = candidateFor(root, 'FREEZE-95', false);
    expect(() => publishFrozenEvidence(candidate, { root })).toThrow(FreezeDigestMismatchError);
  });

  it('不存在"为兼容历史而放宽"的分支：一组构造候选的 config.match 恒为 false、ok 恒为 false', () => {
    const root = makeConfigFixtureRoot();
    const recomputed = recomputeDigests(root);

    const allDigestsMatchNoConfig = candidateFor(root, 'FREEZE-95', false);
    // 与登记记录同源、但**显式剥掉配置登记**：本用例因此不依赖"当前登记的是哪个冻结点"。
    const { config_digest: _omitConfig, ...registeredWithoutConfig } = freezePoint();
    const allDigestsMatchWrongConfig: FreezeIdentity = {
      ...candidateFor(root, 'FREEZE-95', true),
      config_digest: 'f'.repeat(64),
    };

    for (const candidate of [
      allDigestsMatchNoConfig,
      registeredWithoutConfig,
      allDigestsMatchWrongConfig,
    ]) {
      const check = compareWithFreezePoint(candidate, recomputed);
      expect(check.config.match).toBe(false);
      expect(check.ok).toBe(false);
      expect(check.deviations.length).toBeGreaterThan(0);
    }
    // 摘要层面（源码 / 仅 src）对得上的候选，也**只**因配置项被拒：
    expect(compareWithFreezePoint(allDigestsMatchNoConfig, recomputed).source_tree.match).toBe(true);
    expect(compareWithFreezePoint(allDigestsMatchNoConfig, recomputed).src_only.match).toBe(true);
  });

  it('登记记录剥掉 config_digest ⇒ 一律拒绝；本批起的登记记录必须带配置摘要（R45.1 / R45.2）', () => {
    const registered = freezePoint();
    const { config_digest: _omitConfig, ...noConfig } = registered;

    const check = compareWithFreezePoint(noConfig, recomputeDigests(REPO_ROOT));
    expect(check.config.registered).toBe(false);
    expect(check.config.match).toBe(false);
    expect(check.ok).toBe(false);
    expect(() => publishFrozenEvidence(noConfig, { root: REPO_ROOT })).toThrow(
      FreezeDigestMismatchError,
    );

    // R45.1：新冻结点必须登记配置摘要（这条与"当前树是否与冻结点相符"无关，恒成立）。
    expect(typeof registered.config_digest).toBe('string');
    expect(registered.config_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('身份戳携带配置登记值 / 复算值 / 比对结论（R45.4）', () => {
    const stamp = evidenceIdentityStamp();
    const registered = freezePoint();

    expect(typeof stamp.config_match).toBe('boolean');
    expect(stamp.config_sha256).toBe(registered.config_digest ?? null);
    expect(stamp.recomputed_config_sha256).toMatch(/^[0-9a-f]{64}$/);
    // 三字段自洽：匹配 ⇔ 登记值 == 复算值。
    expect(stamp.config_match).toBe(stamp.config_sha256 === stamp.recomputed_config_sha256);
    // 身份与配置结论必须自洽：正式冻结 ⇒ 配置必然匹配。
    if (stamp.frozen) {
      expect(stamp.config_match).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 R45.1 / R45.5 —— 四个配置文件逐个改 / 删
// ---------------------------------------------------------------------------

describe('§2 G04：四个配置 / 依赖文件逐个改动或删除（R45.1 / R45.5）', () => {
  it('未改动 ⇒ 配置摘要一致、ok === true、publishFrozenEvidence 得 frozen 信封', () => {
    const root = makeConfigFixtureRoot();
    const candidate = candidateFor(root, 'FREEZE-94', true);
    const check = compareWithFreezePoint(candidate, recomputeDigests(root));

    expect(check.config.registered).toBe(true);
    expect(check.config.match).toBe(true);
    expect(check.deviations).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.source_tree.match).toBe(true);
    expect(check.src_only.match).toBe(true);

    const envelope = publishFrozenEvidence(candidate, { root });
    expect(envelope.frozen).toBe(true);
    expect(envelope.config_digest).toBe(candidate.config_digest);
    expect(envelope.recomputed.config_sha256).toBe(candidate.config_digest);
  });

  for (const file of CONFIG_MANIFEST_FILES) {
    it(`修改 ${file} ⇒ 配置摘要变化、配置比对失败、正式发布被拒`, () => {
      const root = makeConfigFixtureRoot();
        const candidate = candidateFor(root, 'FREEZE-94', true);
      const before = recomputeDigests(root).config.sha256;
      const original = readFileSync(join(root, file));

      try {
        writeFileSync(join(root, file), Buffer.concat([original, Buffer.from('\n', 'utf8')]));
        const after = recomputeDigests(root);
        expect(after.config.sha256).not.toBe(before);

        const check = compareWithFreezePoint(candidate, after);
        expect(check.config.match).toBe(false);
        expect(check.ok).toBe(false);
        expect(check.deviations.some((line) => line.includes('配置 / 依赖清单摘要不符'))).toBe(true);
        expect(() => publishFrozenEvidence(candidate, { root })).toThrow(FreezeDigestMismatchError);
      } finally {
        writeFileSync(join(root, file), original);
      }

      // 改回 ⇒ 恢复通过
      const restored = compareWithFreezePoint(candidate, recomputeDigests(root));
      expect(restored.config.match).toBe(true);
      expect(restored.ok).toBe(true);
    });

    it(`删除 ${file} ⇒ 配置摘要变化、配置比对失败、正式发布被拒`, () => {
      const root = makeConfigFixtureRoot();
        const candidate = candidateFor(root, 'FREEZE-94', true);
      const before = recomputeDigests(root).config.sha256;
      const original = readFileSync(join(root, file));

      try {
        unlinkSync(join(root, file));
        const after = recomputeDigests(root);
        expect(after.config.sha256).not.toBe(before);
        expect(after.config.files.find((entry) => entry.path === file)?.present).toBe(false);

        const check = compareWithFreezePoint(candidate, after);
        expect(check.config.match).toBe(false);
        expect(check.ok).toBe(false);
        expect(() => publishFrozenEvidence(candidate, { root })).toThrow(FreezeDigestMismatchError);
      } finally {
        writeFileSync(join(root, file), original);
      }

      const restored = compareWithFreezePoint(candidate, recomputeDigests(root));
      expect(restored.config.match).toBe(true);
      expect(restored.ok).toBe(true);
    });
  }

  it('R45.1：配置摘要清单恰为 package.json / pnpm-lock.yaml / tsconfig.json / vitest.config.ts', () => {
    expect(CONFIG_MANIFEST_FILES).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'vitest.config.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §3 R46.1 —— 身份与落盘目录同一处决定
// ---------------------------------------------------------------------------

describe('§3 G05：身份与落盘目录同一处决定（R46.1）', () => {
  it('同一调用的身份与目录必然一致（frozen ⇒ docs/other/evidence/{id}，否则 .dev-evidence/{id}）', () => {
    const root = makeRoot();
    const location = evidenceOutputLocation({ root });
    const stamp = evidenceIdentityStamp({ root });

    expect(location.frozen).toBe(stamp.frozen);
    expect(location.id).toBe(stamp.id);
    expect(location.registered_freeze_id).toBe(freezePoint().id);

    if (location.frozen) {
      expect(location.dir).toBe(`docs/other/evidence/${location.registered_freeze_id}`);
    } else {
      expect(location.dir).toBe(`${DEVELOPMENT_EVIDENCE_DIR_ROOT}/${location.registered_freeze_id}`);
    }
    expect(location.absolute_dir).toBe(join(root, ...location.dir.split('/')));
  });

  it('真实身份的目录选择与身份自洽，且两侧都用登记冻结点 id（R46.1）', () => {
    const stamp = evidenceIdentityStamp();
    const location = evidenceOutputLocation();
    const registeredId = freezePoint().id;

    expect(location.frozen).toBe(stamp.frozen);
    expect(location.registered_freeze_id).toBe(registeredId);
    expect(location.dir).toBe(
      location.frozen
        ? `docs/other/evidence/${registeredId}`
        : `${DEVELOPMENT_EVIDENCE_DIR_ROOT}/${registeredId}`,
    );
    // **不是** `DEV-UNFROZEN`：开发产物也要按冻结点归档（V3 验收裁定的措辞歧义）。
    expect(location.dir.endsWith(`/${registeredId}`)).toBe(true);
    expect(location.dir).not.toContain('DEV-UNFROZEN');
  });

  it('frozen 分支的正向判据：通过守卫的候选 ⇒ docs/other/evidence/{候选 id}（与模板同源）', () => {
    const root = makeConfigFixtureRoot();
    const candidate = candidateFor(root, 'FREEZE-93', true);

    const envelope = publishFrozenEvidence(candidate, { root });
    expect(envelope.frozen).toBe(true);
    expect(envelope.output_dir).toBe(`docs/other/evidence/FREEZE-93`);
    expect(frozenEvidenceDir(candidate)).toBe(envelope.output_dir);
    expect(envelope.output_dir.startsWith(DEVELOPMENT_EVIDENCE_DIR_ROOT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 R46.2 / R46.3 / R46.4 —— 写盘入口的顺序与目录一致性
// ---------------------------------------------------------------------------

describe('§4 G05：writeEvidenceArtifacts 的目录一致性与守卫先行（R46.2 / R46.3 / R46.4）', () => {
  it('一次调用内 JSON 与 JSONL 落在同一目录（R46.2），且不触碰 docs/other/evidence（R46.3）', () => {
    const root = makeRoot();
    const outcome = writeEvidenceArtifacts(
      () => [
        { file_name: 'x-evidence.json', content: '{"a":1}\n' },
        { file_name: 'x-events.jsonl', content: '{"e":1}\n{"e":2}\n' },
      ],
      { root },
    );

    expect(outcome.location.frozen).toBe(false);
    expect(outcome.identity.frozen).toBe(false);
    expect(outcome.location.id).toBe(outcome.identity.id);
    expect(outcome.written).toHaveLength(2);

    const dirs = new Set(outcome.written.map((artifact) => dirname(artifact.absolute_path)));
    expect(dirs.size).toBe(1);
    expect([...dirs][0]).toBe(outcome.location.absolute_dir);
    expect(outcome.location.dir).toBe(`${DEVELOPMENT_EVIDENCE_DIR_ROOT}/${freezePoint().id}`);

    // 读回（产物确实可读、内容原样）
    for (const artifact of outcome.written) {
      expect(existsSync(artifact.absolute_path)).toBe(true);
      expect(readFileSync(artifact.absolute_path, 'utf8')).toHaveLength(artifact.byte_length);
    }
    // R46.3：临时根下**不存在** docs/other/evidence
    expect(existsSync(join(root, 'docs', 'other', 'evidence'))).toBe(false);
  });

  it('非法文件名（含路径分隔符 / ".." / 空）在 mkdir 之前抛错，且不产生任何文件（R46.4）', () => {
    for (const badName of ['../escape.json', 'sub/dir.json', 'sub\\dir.json', '..', '', '.']) {
      const root = makeRoot();
      expect(() =>
        writeEvidenceArtifacts(
          () => [
            { file_name: 'ok.json', content: '{}\n' },
            { file_name: badName, content: '{}\n' },
          ],
          { root },
        ),
      ).toThrow(FreezeIdentityError);

      // 守卫先于 mkdir：目录未被创建，也没有半成品 / 临时文件
      expect(existsSync(join(root, DEVELOPMENT_EVIDENCE_DIR_ROOT))).toBe(false);
      expect(existsSync(join(root, 'escape.json'))).toBe(false);
    }
  });

  it('已存在的同名文件不被部分覆盖（先写临时文件再原子改名，R46.4）', () => {
    const root = makeRoot();
    const first = writeEvidenceArtifacts(() => [{ file_name: 'same.json', content: '{"v":1}\n' }], {
      root,
    });
    const dir = first.location.absolute_dir;
    expect(readFileSync(join(dir, 'same.json'), 'utf8')).toBe('{"v":1}\n');

    writeEvidenceArtifacts(() => [{ file_name: 'same.json', content: '{"v":22}\n' }], { root });
    expect(readFileSync(join(dir, 'same.json'), 'utf8')).toBe('{"v":22}\n');

    // 无残留的临时文件
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(readdirSync(dir)).toEqual(['same.json']);
  });

  it('守卫拒绝正式身份时在 mkdir 之前抛错（以登记记录直接调用发布闸门验证）', () => {
    const root = makeRoot();
    const registered = freezePoint();
    expect(() => publishFrozenEvidence(registered, { root })).toThrow(FreezeDigestMismatchError);
    expect(existsSync(join(root, DEVELOPMENT_EVIDENCE_DIR_ROOT))).toBe(false);
    expect(existsSync(join(root, 'docs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5 静态覆盖检查 —— 11 处写入器必须经统一入口落盘
// ---------------------------------------------------------------------------

/**
 * G05 涉及的**全部**证据写入器（`src` 侧模块内证据测试 + `tests/acceptance` 侧场景夹具）。
 *
 * 这份清单就是"不能漏接线"的回归面：任何一处改回自选目录，本组断言即失败。
 */
const EVIDENCE_WRITERS: readonly string[] = Object.freeze([
  'src/dependency/evidence.test.ts',
  'src/inbox/evidence.test.ts',
  'src/workledger/evidence.test.ts',
  'src/scheduler/evidence.test.ts',
  'src/fake/reproducibility.test.ts',
  'tests/acceptance/a02a03/harness.ts',
  'tests/acceptance/a04/dedup.test.ts',
  'tests/acceptance/reliability/reliable-delivery.test.ts',
  'tests/acceptance/p7p8/support.ts',
  'tests/acceptance/a05/a05.cycle-dependency.test.ts',
  'tests/acceptance/p4/p4.work-commitment.test.ts',
  // 【G-1 的裁决：**不**纳入 office-support.ts，2026-10-02】
  // W-FIX9 试着把它加进本清单，触发两条红：① 清单计数写死为 11；② 本组判据要求写入器
  // **不得直接调 fs 写入 API**，而 office-support.ts **按 R61 必须 `rmSync` 产物根**（正式身份
  // 保留、开发身份删除），天然无法满足该条。
  //
  // 主协调者裁决：**保持清单为 11 处、不放宽本组判据**。理由与替代覆盖：
  // - 放松"不得直接调 fs 写入 API"会削弱 G05 原本要钉的失效模式（写入器自选目录并直接落盘）；
  // - office-support.ts 真正需要被钉的那一面是"**不得自选证据目录**"，它已由
  //   `v8-contract-conformance.test.ts` 的**源码级**断言独立覆盖（断言其产物根是
  //   `join(evidenceDir,'products',…)`，即位置仍由证据发布器决定）；
  // - 它的删除权限由 R61 明确授予，属**合同要求的 fs 调用**，不是"绕开统一入口写证据"。
]);

/** 去掉块注释与行注释后的源码（只对**代码**做路径 / fs 调用断言，不受注释里的旧路径干扰）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

const WRITER_SOURCES = EVIDENCE_WRITERS.map((path) => ({
  path,
  code: stripComments(readFileSync(join(REPO_ROOT, ...path.split('/')), 'utf8')),
}));

describe('§5 静态覆盖：写入器不得自选证据目录（防"只改目录函数、写入器没接线"回归）', () => {
  it('清单为 11 处且全部存在', () => {
    expect(EVIDENCE_WRITERS).toHaveLength(11);
    for (const { path } of WRITER_SOURCES) {
      expect(path.length).toBeGreaterThan(0);
    }
  });

  for (const { path, code } of WRITER_SOURCES) {
    it(`${path}：经统一入口落盘，不自选目录、不直接写盘`, () => {
      // 1. 经统一入口：至少"导入 + 调用"两处出现
      expect(code.match(/writeEvidenceArtifacts/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      // 2. 不得出现写死 / 拼接的正式证据目录字面量
      expect(code).not.toMatch(/['"`](\.\/)?docs\/other\/evidence\/D\d/);
      expect(code).not.toMatch(/['"`]\.dev-evidence/);
      // 3. 不得用 path.join / resolve 拼证据目录
      expect(code).not.toMatch(/join\([^)]*['"`]evidence/i);
      expect(code).not.toMatch(/resolve\([^)]*['"`]evidence/i);
      // 4. 不得自己写盘（写盘只允许发生在统一入口内）
      expect(code).not.toMatch(/\b(writeFileSync|appendFileSync|mkdirSync|createWriteStream|rmSync)\b/);
      // 5. 旧的写死目录常量必须已删除
      expect(code).not.toMatch(/D0[2-9]_EVIDENCE_DIR|D1[01]_EVIDENCE_DIR/);
    });
  }

  it('D07 与 D11 的写入函数不得再返回自选目录（`writeEvidence` 仍存在且产出回执）', () => {
    const harness = WRITER_SOURCES.find((entry) => entry.path.endsWith('a02a03/harness.ts'));
    const support = WRITER_SOURCES.find((entry) => entry.path.endsWith('p7p8/support.ts'));
    expect(harness?.code).toMatch(/export function writeEvidence\(/);
    expect(support?.code).toMatch(/export function writeEvidence\(/);
    expect(harness?.code).toMatch(/outcome\.written\[0\]/);
    expect(support?.code).toMatch(/outcome\.written\[0\]/);
  });

  it('D08 的 JSON 与 JSONL 由**同一次**调用产出（R46.2 的场景侧证据）', () => {
    const a04 = WRITER_SOURCES.find((entry) => entry.path.endsWith('a04/dedup.test.ts'));
    const p2 = WRITER_SOURCES.find((entry) => entry.path.endsWith('reliability/reliable-delivery.test.ts'));
    for (const [entry, jsonName, jsonlName] of [
      [a04, 'a04-evidence.json', 'a04-events.jsonl'],
      [p2, 'p2-evidence.json', 'p2-events.jsonl'],
    ] as const) {
      expect(entry?.code).toContain(jsonName);
      expect(entry?.code).toContain(jsonlName);
      expect(entry?.code.match(/writeEvidenceArtifacts\(/g)?.length).toBe(1);
    }
  });
});
