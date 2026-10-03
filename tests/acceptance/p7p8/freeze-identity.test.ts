/**
 * 冻结点标识**单一来源**的自检（D11；合同 R24 / `guide:111`）+ **F11 复算守卫**的验收。
 *
 * D10 的复核结论是「证据自称 FREEZE-1、实际被测的是 FREEZE-2 的源码」。第一部分证明
 * `tests/acceptance/freeze-identity.ts` 的形状自检**真的能拦下那类事故**（不是装饰性的）。
 *
 * 第二部分（F11 / R38.1–R38.4）证明守卫**复算真实文件内容**，而不是只查 64 位十六进制的形状：
 * 形状合法的假摘要（64 个 `a`）、另一个合法长度的 sha256、域内新增 / 删除 / 重命名，
 * 都必须被拒；开发期产物必须标为未冻结且与正式证据分目录。
 *
 * ## 本文件的断言为何**不**与 FREEZE-3 的固定值绑定
 *
 * 摘要域是 `find src tests -name "*.ts"` —— **本文件自身在域内**。任何一次修复（包括
 * 实现 F11 的这一批）都会改变整体摘要。因此测试断言的是**判定性质**（"复算值 ≠ 登记值
 * ⇒ 必须拒绝"），而非"当前必须等于 FREEZE-3"；后者只会在**冻结那一刻**为真。
 * 对当前工作区的真实复算结论由运行日志与 F11 交付报告如实记录。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FREEZE_IDENTITY_RECORD_PATH,
  FreezeDigestMismatchError,
  FreezeIdentityError,
  assertDevelopmentEvidence,
  assertFreezeIdentity,
  assertFrozenEvidence,
  compareWithFreezePoint,
  developmentEvidence,
  developmentEvidenceDir,
  evidenceIdentityStamp,
  evidenceOutputLocation,
  freezeId,
  freezePoint,
  freezePointEvidence,
  freezeSourceTreeDigest,
  freezeSrcOnlyDigest,
  freezeEvidenceFile,
  frozenEvidenceDir,
  isFrozenEvidence,
  publishFrozenEvidence,
  recomputeDigests,
  reviewRegisteredFreezePoint,
  writeEvidenceArtifacts,
  type FreezeIdentity,
  type RecomputedDigests,
} from '../freeze-identity.js';
import {
  CONFIG_MANIFEST_FILES,
  DIGEST_ALGORITHM_NOTE,
  computeTreeDigest,
  digestFromEntries,
  sha256Hex,
  type SourceFileEntry,
} from '../source-digest.js';

const CURRENT: FreezeIdentity = freezePoint();

// ---------------------------------------------------------------------------
// 只读快照的模块级缓存（**不改任何判据**，只去掉同一份快照的重复复算）
// ---------------------------------------------------------------------------
//
// 本文件里全部**不带 root 参数**的复算都指向同一个对象：本仓库 `src/**` + `tests/**` 的
// 680 个 `.ts` 文件（实测单次复算 ≈ 0.4 s，`../source-digest.js` 无缓存）。本文件从不改动
// 这些文件（全部写入都落在 `mkdtempSync` 的临时仓库里），故在一次运行之内该结果是**只读快照**。
// 原先每条用例各付一次复算；这里各缓存一次。断言与调用语义一条未动——
// 缓存值仍由**原函数真实复算**得出，只是不再重复计算同一份不变的输入。

let cachedRepoDigests: RecomputedDigests | null = null;

/** 本仓库的复算结果（`src` + `tests` 域；一次运行内只算一次）。 */
function repoDigests(): RecomputedDigests {
  if (cachedRepoDigests === null) cachedRepoDigests = recomputeDigests();
  return cachedRepoDigests;
}

let cachedRepoStamp: ReturnType<typeof evidenceIdentityStamp> | null = null;

/** 本仓库的证据身份戳（仍由 `evidenceIdentityStamp()` 真实复算得出，只是只算一次）。 */
function repoStamp(): ReturnType<typeof evidenceIdentityStamp> {
  if (cachedRepoStamp === null) cachedRepoStamp = evidenceIdentityStamp();
  return cachedRepoStamp;
}

let cachedRepoLocation: ReturnType<typeof evidenceOutputLocation> | null = null;

/** 本仓库的证据落盘位置（仍由 `evidenceOutputLocation()` 真实复算得出，只是只算一次）。 */
function repoLocation(): ReturnType<typeof evidenceOutputLocation> {
  if (cachedRepoLocation === null) cachedRepoLocation = evidenceOutputLocation();
  return cachedRepoLocation;
}

function mutated(patch: Partial<FreezeIdentity>): FreezeIdentity {
  return { ...CURRENT, ...patch };
}

/** 64 个 `a` / 64 个 `b`——**形状合法**的假摘要（F11 的原始反例）。 */
const FAKE_ALL_A = 'a'.repeat(64);
const FAKE_ALL_B = 'b'.repeat(64);

/** 把 64 位摘要的最后一个字符翻转，得到"另一个合法长度但内容不符"的值。 */
function flipLastHexChar(digest: string): string {
  const last = digest.slice(-1);
  const replacement = last === '0' ? '1' : '0';
  return `${digest.slice(0, -1)}${replacement}`;
}

/** 构造一个临时"仓库"（隔离副本），返回根目录；用后须 cleanup。 */
function makeTempRepo(populate: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'potbot-freeze-'));
  populate(root);
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const full = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/**
 * 合成候选冻结记录：摘要**由复算得出**（不是硬编码），用于正向对照。
 * 同时登记文件清单，以便精确诊断增 / 删 / 改名。
 *
 * **R45.1**：候选必须登记 `config_digest`（否则一律不得 `frozen: true`，见「G04」一节）。
 */
function candidateFrom(recomputed: RecomputedDigests, id = 'FREEZE-99'): FreezeIdentity {
  return {
    schema: 'freeze-identity.v1',
    id,
    evidence_file: `docs/other/evidence/${id}.md`,
    source_tree_sha256: recomputed.source_tree.sha256,
    src_only_sha256: recomputed.src_only.sha256,
    digest_command: 'find src tests -name "*.ts" | sort | xargs sha256sum | sha256sum',
    src_digest_command: 'find src -name "*.ts" | sort | xargs sha256sum | sha256sum',
    source_tree_files: recomputed.source_tree.files.map((entry) => entry.path),
    src_only_files: recomputed.src_only.files.map((entry) => entry.path),
    config_digest: recomputed.config.sha256,
    superseded: [],
  };
}

/** R45.1 要求的四个配置文件（与 `CONFIG_MANIFEST_FILES` 同源，此处只用于逐文件篡改矩阵）。 */
const CONFIG_MATRIX_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vitest.config.ts',
];

/** 四个配置文件的原始内容（逐文件篡改矩阵用它"改回 / 补回"）。 */
const CONFIG_MANIFEST_CONTENTS: Readonly<Record<string, string>> = Object.freeze({
  'package.json': '{"name":"x","version":"1.0.0"}\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'tsconfig.json': '{"compilerOptions":{"strict":true}}\n',
  'vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts'] } };\n",
});

/** 在临时仓库里铺一份"完整"配置面（四个文件都存在，内容各不相同）。 */
function writeConfigManifest(root: string): void {
  for (const [file, content] of Object.entries(CONFIG_MANIFEST_CONTENTS)) {
    write(root, file, content);
  }
}

/** 四个配置文件的原始内容（读取入口；缺失键返回 `undefined`，由调用方兜底）。 */
function originalManifest(): Readonly<Record<string, string>> {
  return CONFIG_MANIFEST_CONTENTS;
}

// ===========================================================================
// 第一部分：单一来源与形状自检（D11 / R24，保留原判据）
// ===========================================================================

describe('冻结点标识的单一来源（D11 / R24）', () => {
  it('现行标识通过自检，且全部出口取自同一记录', () => {
    expect(() => assertFreezeIdentity(CURRENT)).not.toThrow();

    // 出口收敛：单一来源的每个取值都必须与记录一致（四个夹具一律经此取值）。
    expect(freezeSourceTreeDigest()).toBe(CURRENT.source_tree_sha256);
    expect(freezeSrcOnlyDigest()).toBe(CURRENT.src_only_sha256);
    expect(freezeId()).toBe(CURRENT.id);
    expect(freezeEvidenceFile()).toBe(CURRENT.evidence_file);

    const evidence = freezePointEvidence();
    expect(evidence.source_tree_sha256).toBe(CURRENT.source_tree_sha256);
    expect(evidence.src_only_sha256).toBe(CURRENT.src_only_sha256);
    expect(evidence.file).toBe(`docs/other/evidence/${CURRENT.id}.md`);
    expect(FREEZE_IDENTITY_RECORD_PATH.endsWith('.json')).toBe(true);
  });

  it('★ 引用已作废的冻结点 → 自检必须失败（D10 找到的那类事故的机器判据）', () => {
    const superseded = CURRENT.superseded[0];
    expect(superseded).toBeDefined();
    if (superseded === undefined) throw new Error('superseded 记录缺失（夹具/标识记录错误）');

    expect(() =>
      assertFreezeIdentity(mutated({ source_tree_sha256: superseded.source_tree_sha256 })),
    ).toThrow(FreezeIdentityError);
  });

  it('★ 标识形状非法 / 自相矛盾 → 自检必须失败', () => {
    // 摘要不是 64 位小写十六进制。
    expect(() => assertFreezeIdentity(mutated({ source_tree_sha256: 'not-a-sha256' }))).toThrow(
      FreezeIdentityError,
    );
    // 全量与仅 src 两个域不同，取值相同只可能是抄写错误。
    expect(() =>
      assertFreezeIdentity(mutated({ src_only_sha256: CURRENT.source_tree_sha256 })),
    ).toThrow(FreezeIdentityError);
    // id 与证据文档名不一致。
    expect(() =>
      assertFreezeIdentity(mutated({ evidence_file: 'docs/other/evidence/FREEZE-999.md' })),
    ).toThrow(FreezeIdentityError);
    // id 形状非法。
    expect(() => assertFreezeIdentity(mutated({ id: '冻结点三' }))).toThrow(FreezeIdentityError);
    // 计算命令缺失 / 两条命令相同（少了可复算依据）。
    expect(() => assertFreezeIdentity(mutated({ digest_command: '' }))).toThrow(
      FreezeIdentityError,
    );
    expect(() =>
      assertFreezeIdentity(mutated({ src_digest_command: CURRENT.digest_command })),
    ).toThrow(FreezeIdentityError);
  });
});

// ===========================================================================
// 第二部分：F11 —— 摘要必须绑定真实文件内容（R38.1–R38.4）
// ===========================================================================

describe('F11 摘要口径：与历史 Windows Git 命令逐字节一致（R38.2 / R38.3）', () => {
  /**
   * **金标准向量**：下面三个文件的内容与逐文件摘要，以及最终整体摘要，均由真实 shell 命令
   * 在真实目录上跑出（Windows Git Bash）：
   *
   * ```sh
   * find src tests -name "*.ts" | sort | xargs sha256sum | sha256sum
   * # ⇒ 1c28430ae593b6a809b44d2002fb64b428ee3a046604e9baabba6b82d8b6b455
   * ```
   *
   * 该向量锁死了全部口径：` *` 分隔符、LF 行尾、相对 POSIX 路径、UTF-8 字节序排序、
   * 行拼接方式。换算法（例如把 ` *` 换成两个空格）会立刻在此失败——这正是 R38.3 要防的
   * "把历史正确摘要误报为损坏"的反面：口径一换，历史值就再也复算不出来。
   */
  const GOLDEN_FIXTURE: readonly { readonly path: string; readonly content: string; readonly sha256: string }[] =
    [
      { path: 'src/a.ts', content: 'alpha\n', sha256: 'b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060' },
      { path: 'src/b.ts', content: 'beta\n', sha256: 'f2c82decdd7181cf98945929a62598db7e6b477e11f6e0eb0ae97020eff151ad' },
      { path: 'tests/c.test.ts', content: 'gamma\n', sha256: 'ae9a6306a205417afddd14316cc1d0d5e04a98f1be10865dce643925ee070ce2' },
    ];
  const GOLDEN_TREE_SHA256 =
    '1c28430ae593b6a809b44d2002fb64b428ee3a046604e9baabba6b82d8b6b455';

  it('★ 纯函数口径命中金标准向量（分隔符 / 行尾 / 排序 / 拼接）', () => {
    const entries: SourceFileEntry[] = GOLDEN_FIXTURE.map((file) => ({
      path: file.path,
      sha256: file.sha256,
    }));
    // 逐文件摘要本身也要对得上（防止"整体凑巧相等"的伪验证）。
    for (const file of GOLDEN_FIXTURE) {
      expect(sha256Hex(Buffer.from(file.content, 'utf8'))).toBe(file.sha256);
    }
    expect(digestFromEntries(entries)).toBe(GOLDEN_TREE_SHA256);
    // 入参顺序不影响结果（内部按字节序排序）。
    expect(digestFromEntries([...entries].reverse())).toBe(GOLDEN_TREE_SHA256);
  });

  it('★ 真实目录复算同样命中金标准向量（文件遍历口径一致）', () => {
    const root = makeTempRepo(() => {});
    try {
      for (const file of GOLDEN_FIXTURE) write(root, file.path, file.content);
      const digest = computeTreeDigest(root);
      expect(digest.files.map((entry) => entry.path)).toEqual([
        'src/a.ts',
        'src/b.ts',
        'tests/c.test.ts',
      ]);
      expect(digest.sha256).toBe(GOLDEN_TREE_SHA256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('★ 隔离副本改一个字节 → 摘要必然改变（F11 通过标准第 1 条）', () => {
    const root = makeTempRepo(() => {});
    try {
      for (const file of GOLDEN_FIXTURE) write(root, file.path, file.content);
      expect(computeTreeDigest(root).sha256).toBe(GOLDEN_TREE_SHA256);

      // 只动一个字节。
      write(root, 'src/b.ts', 'betaX\n');
      const changed = computeTreeDigest(root).sha256;
      expect(changed).not.toBe(GOLDEN_TREE_SHA256);

      // 恢复原字节 → 摘要回到原值（守卫不是"永远拒绝"）。
      write(root, 'src/b.ts', 'beta\n');
      expect(computeTreeDigest(root).sha256).toBe(GOLDEN_TREE_SHA256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('口径原文被如实写进摘要常量（供独立复算者核对）', () => {
    expect(DIGEST_ALGORITHM_NOTE).toContain('*');
    expect(DIGEST_ALGORITHM_NOTE).toContain('UTF-8 byte order');
    expect(DIGEST_ALGORITHM_NOTE).toContain('sha256sum');
  });
});

describe('F11 发布闸门：假摘要 / 合法长度错值一律拒绝（R38.1）', () => {
  it('★ 64 个 a / 64 个 b → 发布被拒（F11 原始反例）', () => {
    // 两个域必须给**不同**的假值，否则会先被"两域摘要相同"的形状自检挡住，
    // 那样测的就不是"形状合法但内容不符"这一条了。
    const forgeries: readonly { readonly fake: string; readonly other: string }[] = [
      { fake: FAKE_ALL_A, other: FAKE_ALL_B },
      { fake: FAKE_ALL_B, other: FAKE_ALL_A },
    ];
    for (const { fake, other } of forgeries) {
      const forged = mutated({ source_tree_sha256: fake, src_only_sha256: other });
      // 形状自检**会**放过它（这正是 F11 的缺陷所在）……
      expect(() => assertFreezeIdentity(forged)).not.toThrow();
      // ……但发布闸门基于真实复算，必须拒绝。
      expect(() => publishFrozenEvidence(forged)).toThrow(FreezeDigestMismatchError);
      const check = compareWithFreezePoint(
        mutated({ source_tree_sha256: fake, src_only_sha256: other }),
        repoDigests(),
      );
      expect(check.ok).toBe(false);
      expect(check.source_tree.match).toBe(false);
      expect(check.source_tree.expected).toBe(fake);
    }
  });

  it('★ 另一个合法长度但内容不符的 sha256 → 发布被拒', () => {
    const almost = flipLastHexChar(CURRENT.source_tree_sha256);
    expect(almost).toMatch(/^[0-9a-f]{64}$/);
    expect(almost).not.toBe(CURRENT.source_tree_sha256);
    expect(() =>
      publishFrozenEvidence(mutated({ source_tree_sha256: almost })),
    ).toThrow(FreezeDigestMismatchError);
  });

  // R53.6：本用例是整个文件里**唯一**做两次全仓复算的用例（`reviewRegisteredFreezePoint` 一次，
  // 命中后 `publishFrozenEvidence` 再一次；加上模块级缓存的 `repoDigests` 共三次取树）。
  // 集成波后域内 .ts 数增长，单次复算已 ≈ 2 s，整体实测 ≈ 4.5 s，机器负载高时会越过默认 5 s
  // （与 `office/v6-fixture-audit.test.ts` 登记的是同一现象）。按 R53.6 的取向：重型用例
  // **自带**显式时限，而**不改** `vitest.config.ts` 的全局时限（构建配置是冻结身份的一部分）。
  it('★ 登记记录缺 config_digest 一律拒绝；补登记后按源码是否相符放行（无"永远拒绝"）', () => {
    const recomputed = repoDigests();
    const check = reviewRegisteredFreezePoint();

    expect(check.source_tree.match).toBe(
      recomputed.source_tree.sha256 === CURRENT.source_tree_sha256,
    );
    expect(check.src_only.match).toBe(recomputed.src_only.sha256 === CURRENT.src_only_sha256);

    // G04 / R45.2：候选**未给出** config_digest ⇒ registered=false、match=false、ok=false，
    // **无论源码摘要是否逐字节相符**。旧实现此处会在源码相符时返回 frozen: true（即 G04 缺陷）。
    // 候选与登记记录同源、显式剥掉配置登记 ⇒ 本用例不依赖"当前登记的是哪个冻结点"。
    const { config_digest: _omitConfig, ...noConfig } = CURRENT;
    const noConfigCheck = compareWithFreezePoint(noConfig, recomputed);
    expect(noConfigCheck.config.registered).toBe(false);
    expect(noConfigCheck.config.match).toBe(false);
    expect(noConfigCheck.ok).toBe(false);
    expect(noConfigCheck.deviations.join('\n')).toContain('未登记 config_digest');
    expect(() => publishFrozenEvidence(noConfig)).toThrow(FreezeIdentityError);

    // 补登记 config_digest（源码摘要仍取登记值）后，判定重新变成"源码是否相符"的充要条件：
    // 相符 ⇒ 放行；不符 ⇒ 拒绝并给可读偏差（含两边实际值）。
    const completed: FreezeIdentity = { ...CURRENT, config_digest: recomputed.config.sha256 };
    const completedCheck = compareWithFreezePoint(completed, recomputed);
    expect(completedCheck.config.match).toBe(true);
    expect(completedCheck.config.registered_value).toBe(recomputed.config.sha256);
    expect(completedCheck.ok).toBe(check.source_tree.match && check.src_only.match);

    if (completedCheck.ok) {
      const envelope = publishFrozenEvidence(completed);
      expect(envelope.frozen).toBe(true);
      expect(envelope.recomputed.source_tree_sha256).toBe(CURRENT.source_tree_sha256);
      expect(envelope.config_digest).toBe(recomputed.config.sha256);
      expect(() => assertFrozenEvidence(envelope)).not.toThrow();
    } else {
      expect(() => publishFrozenEvidence(completed)).toThrow(FreezeDigestMismatchError);
      // 失配说明必须**可读且含两边的值**，不能只抛一个 "mismatch"。
      expect(completedCheck.deviations.length).toBeGreaterThan(0);
      expect(completedCheck.deviations.join('\n')).toContain(completedCheck.source_tree.actual);
    }
  }, 30_000);

  it('★ 正向对照：临时仓库上"复算 → 登记 → 发布"必须放行（守卫不是只会拒绝）', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      const recomputed = recomputeDigests(root);
      const candidate = candidateFrom(recomputed);

      expect(() => assertFreezeIdentity(candidate)).not.toThrow();
      const check = compareWithFreezePoint(candidate, recomputed);
      expect(check.ok).toBe(true);
      expect(check.deviations).toEqual([]);
      expect(check.source_tree.actual_file_count).toBe(2);
      expect(check.src_only.actual_file_count).toBe(1);

      const envelope = publishFrozenEvidence(candidate, { root });
      expect(envelope.frozen).toBe(true);
      expect(envelope.recomputed.source_tree_sha256).toBe(recomputed.source_tree.sha256);
      expect(() => assertFrozenEvidence(envelope)).not.toThrow();

      // 同一副本改一个字节后，**同一份登记记录**必须被拒（F11 通过标准第 1 条）。
      write(root, 'src/a.ts', 'alphb\n');
      expect(() => publishFrozenEvidence(candidate, { root })).toThrow(
        FreezeDigestMismatchError,
      );
      // 恢复 → 重新放行。
      write(root, 'src/a.ts', 'alpha\n');
      expect(() => publishFrozenEvidence(candidate, { root })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('登记的 config_digest 被篡改 → 拒绝（R38.2 的独立清单摘要参与判定）', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      write(root, 'package.json', '{"name":"x"}\n');
      const recomputed = recomputeDigests(root);
      expect(recomputed.config.files.some((file) => file.path === 'package.json' && file.present)).toBe(
        true,
      );

      const withConfig = { ...candidateFrom(recomputed), config_digest: recomputed.config.sha256 };
      expect(compareWithFreezePoint(withConfig, recomputed).ok).toBe(true);

      const tampered = { ...withConfig, config_digest: FAKE_ALL_A };
      const check = compareWithFreezePoint(tampered, recomputed);
      expect(check.ok).toBe(false);
      expect(check.config.match).toBe(false);
      expect(() => publishFrozenEvidence(tampered, { root })).toThrow(FreezeDigestMismatchError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('F11 域内新增 / 删除 / 重命名被发现（R38.1）', () => {
  /** 注入清单构造（不真的在仓库里增删源码）。 */
  const base: readonly SourceFileEntry[] = [
    { path: 'src/a.ts', sha256: sha256Hex('alpha') },
    { path: 'src/b.ts', sha256: sha256Hex('beta') },
    { path: 'tests/c.test.ts', sha256: sha256Hex('gamma') },
  ];

  /** 用注入清单拼一份"复算结果"（模拟真实计算，但不碰磁盘）。 */
  function injectedRecomputed(entries: readonly SourceFileEntry[]): RecomputedDigests {
    const srcOnly = entries.filter((entry) => entry.path.startsWith('src/'));
    return {
      source_tree: {
        scope: ['src', 'tests'],
        files: [...entries].sort((a, b) => (a.path < b.path ? -1 : 1)),
        sha256: digestFromEntries(entries),
      },
      src_only: {
        scope: ['src'],
        files: [...srcOnly].sort((a, b) => (a.path < b.path ? -1 : 1)),
        sha256: digestFromEntries(srcOnly),
      },
      config: { files: [], sha256: digestFromEntries([]) },
    };
  }

  function registered(entries: readonly SourceFileEntry[]): FreezeIdentity {
    const recomputed = injectedRecomputed(entries);
    return {
      schema: 'freeze-identity.v1',
      id: 'FREEZE-98',
      evidence_file: 'docs/other/evidence/FREEZE-98.md',
      source_tree_sha256: recomputed.source_tree.sha256,
      src_only_sha256: recomputed.src_only.sha256,
      digest_command: 'find src tests -name "*.ts" | sort | xargs sha256sum | sha256sum',
      src_digest_command: 'find src -name "*.ts" | sort | xargs sha256sum | sha256sum',
      source_tree_files: entries.map((entry) => entry.path),
      src_only_files: entries
        .filter((entry) => entry.path.startsWith('src/'))
        .map((entry) => entry.path),
      superseded: [],
    };
  }

  it('新增一个域内文件 → 摘要改变且被报为 added', () => {
    const identity = registered(base);
    const withNew = injectedRecomputed([
      ...base,
      { path: 'src/d.ts', sha256: sha256Hex('delta') },
    ]);
    const check = compareWithFreezePoint(identity, withNew);
    expect(check.ok).toBe(false);
    expect(check.source_tree.match).toBe(false);
    expect(check.source_tree.added).toEqual(['src/d.ts']);
    expect(check.source_tree.removed).toEqual([]);
    expect(check.source_tree.actual_file_count).toBe(4);
    expect(check.deviations.join('\n')).toContain('新增');
  });

  it('删除一个域内文件 → 摘要改变且被报为 removed', () => {
    const identity = registered(base);
    const withoutB = injectedRecomputed(base.filter((entry) => entry.path !== 'src/b.ts'));
    const check = compareWithFreezePoint(identity, withoutB);
    expect(check.ok).toBe(false);
    expect(check.source_tree.removed).toEqual(['src/b.ts']);
    expect(check.source_tree.added).toEqual([]);
    expect(check.source_tree.actual_file_count).toBe(2);
    expect(check.deviations.join('\n')).toContain('删除/重命名');
  });

  it('重命名（内容不变）→ 摘要改变，旧名 removed、新名 added', () => {
    const identity = registered(base);
    // 只重命名 tests/ 域内的文件：src-only 域不该受影响。
    const renamed = injectedRecomputed([
      base[0] as SourceFileEntry,
      base[1] as SourceFileEntry,
      { path: 'tests/renamed.test.ts', sha256: sha256Hex('gamma') },
    ]);
    const check = compareWithFreezePoint(identity, renamed);
    expect(check.ok).toBe(false);
    expect(check.source_tree.removed).toEqual(['tests/c.test.ts']);
    expect(check.source_tree.added).toEqual(['tests/renamed.test.ts']);
    // 两个域彼此独立：src-only 摘要不受 tests/ 改名影响，但整体判定仍失败。
    expect(check.src_only.match).toBe(true);
    expect(check.ok).toBe(false);
  });

  it('src/ 域内重命名 → 两个摘要同时失配（域划分正确）', () => {
    const identity = registered(base);
    const renamed = injectedRecomputed([
      base[0] as SourceFileEntry,
      { path: 'src/renamed.ts', sha256: sha256Hex('beta') },
      base[2] as SourceFileEntry,
    ]);
    const check = compareWithFreezePoint(identity, renamed);
    expect(check.ok).toBe(false);
    expect(check.source_tree.removed).toEqual(['src/b.ts']);
    expect(check.source_tree.added).toEqual(['src/renamed.ts']);
    expect(check.src_only.removed).toEqual(['src/b.ts']);
    expect(check.src_only.added).toEqual(['src/renamed.ts']);
    expect(check.src_only.match).toBe(false);
  });

  it('域外文件（非 .ts）增删不影响摘要', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      const before = computeTreeDigest(root).sha256;
      write(root, 'src/README.md', 'not a ts file\n');
      write(root, 'docs/notes.md', 'outside the domain\n');
      expect(computeTreeDigest(root).sha256).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('F11 自指规避：摘要不得硬编码在 .ts 内（R32.1 / R38.1）', () => {
  const ACCEPTANCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('★ 守卫实现与摘要工具里都不出现登记摘要的字面量', () => {
    for (const file of ['freeze-identity.ts', 'source-digest.ts']) {
      const source = readFileSync(join(ACCEPTANCE_DIR, file), 'utf8');
      expect(source).not.toContain(CURRENT.source_tree_sha256);
      expect(source).not.toContain(CURRENT.src_only_sha256);
      // 也不许出现"占位式"的 64 位硬编码字符串（那多半是抄来的摘要）。
      const hex64Literals = source.match(/['"`][0-9a-f]{64}['"`]/g) ?? [];
      expect(hex64Literals).toEqual([]);
    }
  });

  it('候选冻结点一律从登记记录读入（值是输入，不是常量）', () => {
    // 改登记文件的字节会让 freezePoint() 读到不同的值 —— 证明它确实在读文件。
    const recordPath = join(ACCEPTANCE_DIR, '..', '..', ...FREEZE_IDENTITY_RECORD_PATH.split('/'));
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    expect(raw['source_tree_sha256']).toBe(CURRENT.source_tree_sha256);
    expect(FREEZE_IDENTITY_RECORD_PATH.endsWith('.json')).toBe(true);
  });
});

describe('F11 开发期输出与正式证据分目录、且标为未冻结（R38.4）', () => {
  it('★ 开发期产物恒为未冻结，且不复用 FREEZE-N 的通过身份', () => {
    const dev = developmentEvidence(CURRENT, { note: 'unit-test' });
    expect(dev.frozen).toBe(false);
    expect(isFrozenEvidence(dev)).toBe(false);
    expect(dev.id).toBe('DEV-UNFROZEN');
    expect(dev.id).not.toMatch(/^FREEZE-\d+$/);
    // 候选标识嵌在 candidate_freeze_point 下，避免下游把它当顶层身份读走。
    expect(Object.hasOwn(dev, 'freeze_point')).toBe(false);
    expect(dev.candidate_freeze_point.id).toBe(CURRENT.id);
    expect(() => assertDevelopmentEvidence(dev)).not.toThrow();
    // 守卫不宣布最终冻结 / 最终验收。
    expect(dev.declared_final_by_guard).toBe(false);
    expect(dev.independent_review).toBe('required');
  });

  it('★ 开发期输出目录 ≠ 正式冻结证据目录', () => {
    const devDir = developmentEvidenceDir(CURRENT.id);
    const frozenDir = frozenEvidenceDir(CURRENT);
    expect(devDir).not.toBe(frozenDir);
    expect(devDir.startsWith('.dev-evidence/')).toBe(true);
    expect(frozenDir).toBe(`docs/other/evidence/${CURRENT.id}`);
    expect(developmentEvidence(CURRENT).output_dir).toBe(devDir);
  });

  it('开发期产物里的复算值来自真实复算（不是抄登记值）', () => {
    const dev = developmentEvidence(CURRENT);
    const recomputed = repoDigests();
    expect(dev.recomputed.source_tree_sha256).toBe(recomputed.source_tree.sha256);
    expect(dev.recomputed.src_only_sha256).toBe(recomputed.src_only.sha256);
    expect(dev.recomputed.source_tree_file_count).toBe(recomputed.source_tree.files.length);
    expect(dev.recomputed.config_sha256).toBe(recomputed.config.sha256);
    expect(dev.recomputed.digest_algorithm).toBe(DIGEST_ALGORITHM_NOTE);
  });

  it('★ 正式证据信封放行时：标识与复算值一致、且不自称最终冻结', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      const recomputed = recomputeDigests(root);
      const envelope = publishFrozenEvidence(candidateFrom(recomputed), { root });
      expect(envelope.verification.recomputed_before_publish).toBe(true);
      expect(envelope.verification.matches_registered).toBe(true);
      expect(envelope.declared_final_by_guard).toBe(false);
      expect(envelope.independent_review).toBe('required');
      expect(envelope.digest_command).toContain('sha256sum');
      expect(envelope.output_dir).toBe('docs/other/evidence/FREEZE-99');
      // R45.4：正式信封携带**登记**配置摘要。
      expect(envelope.config_digest).toBe(recomputed.config.sha256);
      expect(() => assertFrozenEvidence(envelope)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 第三部分：G04 —— 冻结身份必须绑定执行配置（R45.1–R45.5）
// ===========================================================================

describe('G04 配置摘要绑定：未登记 / 篡改 / 删除一律不得 frozen（R45.1–R45.5）', () => {
  it('R45.1：配置摘要的文件清单与合同一致（唯一实现 computeConfigDigest）', () => {
    expect([...CONFIG_MANIFEST_FILES]).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'vitest.config.ts',
    ]);
  });

  it('★ 未登记 config_digest ⇒ config.match=false ⇒ ok=false ⇒ 发布被拒（R45.2 / R45.3）', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      writeConfigManifest(root);
      const recomputed = recomputeDigests(root);

      // 正向对照：登记了配置摘要 ⇒ 放行。
      const registered = candidateFrom(recomputed);
      const okCheck = compareWithFreezePoint(registered, recomputed);
      expect(okCheck.ok).toBe(true);
      expect(okCheck.config.registered).toBe(true);
      expect(okCheck.config.match).toBe(true);
      expect(() => publishFrozenEvidence(registered, { root })).not.toThrow();

      // 去掉 config_digest —— 这正是 FREEZE-4 的现状（历史记录只证明源码摘要）。
      const { config_digest: omitted, ...rest } = registered;
      void omitted;
      const unregistered = rest as FreezeIdentity;
      const check = compareWithFreezePoint(unregistered, recomputed);
      expect(check.config.registered).toBe(false);
      expect(check.config.registered_value).toBeNull();
      // **不是** null：缺登记不再"不判失败"（R45.2 把 null 改为 false）。
      expect(check.config.match).toBe(false);
      expect(check.ok).toBe(false);
      expect(check.deviations.join('\n')).toContain('未登记 config_digest');
      expect(() => publishFrozenEvidence(unregistered, { root })).toThrow(FreezeDigestMismatchError);
      // 开发身份仍可产出（只是不能冒用正式身份）。
      expect(developmentEvidence(unregistered, { root }).frozen).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('★ 身份戳携带配置复算与比对结果；config_match 与两个摘要自洽（R45.4）', () => {
    const stamp = repoStamp();
    const recomputed = repoDigests();
    expect(stamp.recomputed_config_sha256).toBe(recomputed.config.sha256);
    // 登记值如实透出（未登记才是 null）。
    expect(stamp.config_sha256).toBe(CURRENT.config_digest ?? null);
    // **自洽判据，不依赖"当前登记的是哪个冻结点"**：
    // 早期写法是 `expect(stamp.config_match).toBe(CURRENT.config_digest !== undefined)`，
    // 它暗含"只要登记了就一定匹配"——那只有在工作树恰好等于登记冻结点时才成立。
    // 登记与复算本就是两件事：匹配 ⇔ 登记值 == 复算值。
    expect(stamp.config_match).toBe(stamp.config_sha256 === stamp.recomputed_config_sha256);
    // 未登记 ⇒ 不得 frozen（R45.2）——这一条才是与登记内容无关的硬约束。
    if (CURRENT.config_digest === undefined) {
      expect(stamp.config_match).toBe(false);
      expect(stamp.frozen).toBe(false);
      expect(stamp.deviations.join('\n')).toContain('未登记 config_digest');
    }
  });

  it('★ R45.5 关闭标准：逐个**修改**四个配置文件 → 正式发布被拒、改回即恢复', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      writeConfigManifest(root);
      const baseline = recomputeDigests(root);
      const candidate = candidateFrom(baseline);

      expect(compareWithFreezePoint(candidate, recomputeDigests(root)).ok).toBe(true);
      expect(() => publishFrozenEvidence(candidate, { root })).not.toThrow();

      const originals = originalManifest();
      for (const file of CONFIG_MATRIX_FILES) {
        const original = originals[file] ?? '';
        write(root, file, `${original}// tampered\n`);

        const modified = recomputeDigests(root);
        expect(modified.config.sha256, `${file} 改动后配置摘要必须变化`).not.toBe(baseline.config.sha256);
        const check = compareWithFreezePoint(candidate, modified);
        expect(check.config.match, `${file} 改动后 config.match 必须为 false`).toBe(false);
        expect(check.ok, `${file} 改动后不得放行`).toBe(false);
        expect(() => publishFrozenEvidence(candidate, { root }), `${file} 改动后发布必须被拒`).toThrow(
          FreezeDigestMismatchError,
        );
        // 源码摘要域不含这些文件 —— 源码摘要**不变**（R45.5"历史源码摘要算法不变"的旁证）。
        expect(computeTreeDigest(root).sha256).toBe(baseline.source_tree.sha256);

        write(root, file, original);
        expect(recomputeDigests(root).config.sha256).toBe(baseline.config.sha256);
        expect(() => publishFrozenEvidence(candidate, { root }), `${file} 改回后必须恢复`).not.toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('★ R45.5 关闭标准：逐个**删除**四个配置文件 → 正式发布被拒、补回即恢复', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      writeConfigManifest(root);
      const baseline = recomputeDigests(root);
      const candidate = candidateFrom(baseline);
      const originals = originalManifest();

      for (const file of CONFIG_MATRIX_FILES) {
        const original = originals[file] ?? '';
        rmSync(join(root, ...file.split('/')));

        const deleted = recomputeDigests(root);
        // 缺失文件在结果里以 present:false 显式标出（不静默跳过，否则"删 lockfile"成绕过路径）。
        expect(deleted.config.files.find((entry) => entry.path === file)?.present, `${file} 删除后须标 present:false`).toBe(false);
        const check = compareWithFreezePoint(candidate, deleted);
        expect(check.config.match, `${file} 删除后 config.match 必须为 false`).toBe(false);
        expect(check.ok, `${file} 删除后不得放行`).toBe(false);
        expect(() => publishFrozenEvidence(candidate, { root }), `${file} 删除后发布必须被拒`).toThrow(
          FreezeDigestMismatchError,
        );

        write(root, file, original);
        expect(() => publishFrozenEvidence(candidate, { root }), `${file} 补回后必须恢复`).not.toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('★ 发布闸门先跑候选自检：错误 id / 空摘要命令 / 自相矛盾候选不得 frozen（N-新2）', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      writeConfigManifest(root);
      const recomputed = recomputeDigests(root);
      const good = candidateFrom(recomputed);
      expect(() => publishFrozenEvidence(good, { root })).not.toThrow();

      /** 断言"被形状自检拦下"，而不是被复算守卫拦下（两者语义不同）。 */
      const expectShapeRejection = (candidate: FreezeIdentity): void => {
        expect(() => assertFreezeIdentity(candidate)).toThrow(FreezeIdentityError);
        let caught: unknown;
        try {
          publishFrozenEvidence(candidate, { root });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(FreezeIdentityError);
        expect(caught).not.toBeInstanceOf(FreezeDigestMismatchError);
      };

      expectShapeRejection({ ...good, id: '冻结点五' });
      expectShapeRejection({ ...good, id: 'FREEZE-77', evidence_file: 'docs/other/evidence/FREEZE-78.md' });
      expectShapeRejection({ ...good, digest_command: '' });
      expectShapeRejection({ ...good, config_digest: 'not-a-sha256' });

      // 候选自检**只做形状与自洽**（文件头第 2 条）：摘要内容错但形状合法 ⇒ 仍由复算守卫拦下。
      const wrongDigest = { ...good, source_tree_sha256: FAKE_ALL_A, src_only_sha256: FAKE_ALL_B };
      expect(() => assertFreezeIdentity(wrongDigest)).not.toThrow();
      expect(() => publishFrozenEvidence(wrongDigest, { root })).toThrow(FreezeDigestMismatchError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('★ 正式证据自检：信封内"登记配置摘要 ≠ 复算配置摘要"必须失败（R45.4 自洽校验）', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      write(root, 'tests/c.test.ts', 'gamma\n');
      writeConfigManifest(root);
      const recomputed = recomputeDigests(root);
      const envelope = publishFrozenEvidence(candidateFrom(recomputed), { root });
      expect(() => assertFrozenEvidence(envelope)).not.toThrow();

      // 抄写 / 拼装错误：登记值与复算值不一致。
      expect(() => assertFrozenEvidence({ ...envelope, config_digest: FAKE_ALL_A })).toThrow(
        FreezeIdentityError,
      );
      // 形状非法同样拒绝。
      expect(() => assertFrozenEvidence({ ...envelope, config_digest: '短' })).toThrow(
        FreezeIdentityError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 第四部分：G05 —— 证据落盘目录由身份决定（R46.1–R46.5）
// ===========================================================================

describe('G05 证据落盘：身份与目录同一处决定（R46.1–R46.5）', () => {
  it('★ 未冻结身份 ⇒ 产物写 .dev-evidence/{登记冻结点}/，正式目录一个字节不碰（R46.1/R46.3）', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      const location = evidenceOutputLocation({ root });
      // 临时副本的复算值不可能等于登记冻结点 ⇒ 必然开发身份。
      expect(location.frozen).toBe(false);
      expect(location.id).toBe('DEV-UNFROZEN');
      // 目录模板用**登记**冻结点 id（R46.1 表格）。
      expect(location.registered_freeze_id).toBe(CURRENT.id);
      expect(location.dir).toBe(`.dev-evidence/${CURRENT.id}`);
      expect(location.absolute_dir).toBe(join(root, '.dev-evidence', CURRENT.id));

      const outcome = writeEvidenceArtifacts(
        (identity) => [
          { file_name: 'a01-evidence.json', content: `${JSON.stringify({ task: 'X', identity }, null, 2)}\n` },
          { file_name: 'a01-events.jsonl', content: '{"kind":"run_started"}\n' },
        ],
        { root },
      );

      expect(outcome.identity.frozen).toBe(false);
      expect(outcome.identity.id).toBe('DEV-UNFROZEN');
      expect(outcome.identity.config_match).toBe(false);
      // R46.2：JSON 与 JSONL **同一** location。
      expect(outcome.written.map((file) => file.file_name)).toEqual([
        'a01-evidence.json',
        'a01-events.jsonl',
      ]);
      for (const file of outcome.written) {
        expect(dirname(file.absolute_path)).toBe(location.absolute_dir);
        expect(existsSync(file.absolute_path)).toBe(true);
      }

      // 读回：产物自带 frozen:false 身份戳 + 配置复算字段。
      const readBack = JSON.parse(
        readFileSync(join(location.absolute_dir, 'a01-evidence.json'), 'utf8'),
      ) as { identity: { frozen: boolean; id: string; recomputed_config_sha256: string } };
      expect(readBack.identity.frozen).toBe(false);
      expect(readBack.identity.id).toBe('DEV-UNFROZEN');
      expect(readBack.identity.recomputed_config_sha256).toBe(recomputeDigests(root).config.sha256);

      // R46.3：正式目录既没被创建、也没被写入。
      expect(existsSync(join(root, 'docs', 'other', 'evidence'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('★ R46.4：守卫 / 文件名判据拒绝时**不写任何文件**（无半成品、不部分覆盖）', () => {
    const root = makeTempRepo(() => {});
    try {
      write(root, 'src/a.ts', 'alpha\n');
      // 非法文件名（试图逃出 location 目录）⇒ 在 mkdir 之前就被拒。
      expect(() =>
        writeEvidenceArtifacts(() => [{ file_name: '../escape.json', content: '{}\n' }], { root }),
      ).toThrow(FreezeIdentityError);
      expect(existsSync(join(root, '.dev-evidence'))).toBe(false);

      // 合法写入一次，随后确认"同名文件已存在"时是**整体替换**而非部分覆盖：
      // 第二次写入同名文件后内容必须与新内容逐字节相同（原子改名，R46.4）。
      const first = writeEvidenceArtifacts(
        () => [{ file_name: 'x.json', content: '{"v":1}\n' }],
        { root },
      );
      const target = first.written[0]?.absolute_path;
      expect(target).toBeDefined();
      if (target === undefined) throw new Error('落盘回执缺失');
      expect(readFileSync(target, 'utf8')).toBe('{"v":1}\n');

      writeEvidenceArtifacts(() => [{ file_name: 'x.json', content: '{"v":22}\n' }], { root });
      expect(readFileSync(target, 'utf8')).toBe('{"v":22}\n');
      // 临时文件不残留。
      expect(readdirSync(first.location.absolute_dir).sort()).toEqual(['x.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('落盘身份与身份戳同源：`evidenceOutputLocation().frozen === evidenceIdentityStamp().frozen`', () => {
    expect(repoLocation().frozen).toBe(repoStamp().frozen);
    expect(repoLocation().registered_freeze_id).toBe(CURRENT.id);
    if (repoLocation().frozen) {
      expect(repoLocation().dir).toBe(`docs/other/evidence/${CURRENT.id}`);
    } else {
      expect(repoLocation().dir).toBe(`.dev-evidence/${CURRENT.id}`);
    }
  }, 30_000);
});
