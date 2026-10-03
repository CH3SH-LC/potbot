/**
 * FA-VERIFY-WAVE-13 · 第 3 项 —— **每个修复提交是否真在 main**（`git merge-base --is-ancestor`）。
 *
 * ## 为什么这是本批的**强制项**
 *
 * 本批已出现**两次"合并静默失败"**：声称合入 main 的分支，其提交其实**不在** main 里。
 * 因此"某分支已合"这类结论**不得只凭叙述**，必须用 `git merge-base --is-ancestor <sha> HEAD`
 * **逐条复算**。
 *
 * ## 修订记录（2026-10-03）：把"时点性期望"换成"硬不变量"
 *
 * 本文件原版有一行**反向对照**：`0815c52`（`fa/xls-print-route` 的分支头）被钉成
 * `expectInMain:false`，断言它"尚未合入 main"。该分支**随后真的被合入 main**
 * （`f249589 Merge branch 'fa/xls-print-route'`；分支 tip 现为 `cca8ba3`，
 * `git rev-list --count main..fa/xls-print-route == 0`）——于是"某 sha 此刻不在 main"
 * 这条**时点性**断言**永久变红**。错不在被测对象，而在判据写错了对象：
 * **"此刻未合"不是不变量，合并本来就会随时间发生**。
 *
 * 本次修订（**只改本文件**，不动任何产品代码）：
 *
 * 1. `0815c52` 移入 **A 组（已落地）**——"已合入 main 的提交恒为 HEAD 的祖先"才是硬不变量
 *    （除非改写历史，届时理应变红）；
 * 2. 新增**核心不变量**（对齐 `verify-wave-14/T1` 的判据）：main 的 merge 提交里
 *    **没有任何**一条"点名合过某分支、而该分支 tip 不是 HEAD 的祖先"
 *    —— 即 `announced-but-missing` **恒为空**；
 * 3. "未落地清单"改为**运行时现算**（`git branch --merged HEAD` + `git rev-list --count HEAD..<b>`），
 *    **不再硬编码任何 sha**，因此合并漂移不会再让它变红；
 * 4. 判别力（反向对照）改由**合成输入**承担：
 *    (a) 纯函数喂人造 `git log --merges` 文本；(b) **临时仓库**用**真实 git 管线**复现
 *    "merge 提交点名了某分支、实体却不在 main" ⇒ 判据**必须变红**。
 *    **不移动任何真实 `fa/*` ref**（每个分支都被活跃 worktree 检出，动了会波及他人）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = process.cwd();

/** 在指定仓库根执行 git（只读命令；不注入身份）。 */
function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

/** 在真实仓库执行 git（本文件的默认仓库）。 */
function git(args: readonly string[]): string {
  return gitIn(REPO, args);
}

/** `git merge-base --is-ancestor <sha> HEAD` 的退出码判定（0 ⇒ 在 main）。 */
export function isAncestorOfHead(sha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface CommitRow {
  readonly sha: string;
  readonly subject: string;
}

/**
 * A 组 —— **本批声称已落地**的修复 / 特性提交。判据：每条的 sha 必须是 HEAD 的祖先。
 * （subject 只作人读辅助。）
 */
export const LANDED_FIX_COMMITS: readonly CommitRow[] = Object.freeze([
  { sha: '0fda9cd', subject: '可信回执改由服务端受控执行器建立' },
  { sha: 'ee175a7', subject: 'chat-reject-retry（被拒即收手 + 独立尝试记录）' },
  { sha: '7479fab', subject: 'budget-server-key（计费量服务端确定 + 无 key 落盘）' },
  { sha: '96e48d6', subject: 'budget-wiring-real（预算接进真实调用路径）' },
  { sha: 'f518041', subject: 'artifact-id-collision（重启后同会话再编辑 502）' },
  { sha: '4a533da', subject: 'cancel-invalidates-actions（取消失效未执行动作）' },
  { sha: '8131d67', subject: 'fix-nul-bytes（消除裸 NUL + 守卫）' },
  { sha: '27b701e', subject: 'dispatch-guard 前缀表改为自动提取' },
  { sha: '2108a09', subject: 'session-adapters/budget/checkpoint 产品侧真调用（N-5）' },
  { sha: '2ffdd1f', subject: 'deliverable-input-bytes（不再静默丢弃 fileBase64）' },
  { sha: '2a3f803', subject: 'doc-import-colwidth（导入侧解出逐栏宽度）' },
  { sha: 'c950581', subject: 'fix-a11（空工作集平凡满足的旧行为改写）' },
  { sha: '58cbb9a', subject: '内核纪律 4 处违约修复' },
  { sha: '64b78ae', subject: 'facts-routes（/api/facts 共享事实 HTTP 路由）' },
  { sha: '1397234', subject: 'trace-fact-versions（/api/memory/facts/:key/versions）' },
  { sha: '4c962ea', subject: 'krn-orphans（/api/krn-orphans/**）' },
  { sha: 'c941539', subject: 'krn-barrel（/api/krn-barrel/**）' },
  { sha: 'eaa7ad1', subject: 'route-wiring（/api/conversation-loop 等挂进产品入口）' },
  { sha: 'ae77968', subject: 'conversation-loop 领域门面' },
  { sha: '3fc8894', subject: '对话轮次自动写入记忆' },
  // 原 B 组反向对照（"未落地"）。分支已被 f249589 真正合入 main ⇒ 现为**已落地**硬不变量。
  { sha: '0815c52', subject: 'xls-print-route（XLSX 打印设置接产品 HTTP）—— 已经 f249589 合入 main' },
]);

/** main 的 merge 提交主题里点到的分支名集合（`Merge branch 'fa/x'` / `Merge fa/x`）。 */
export function parseMentionedBranches(mergeSubjects: readonly string[]): Set<string> {
  const mentioned = new Set<string>();
  for (const subject of mergeSubjects) {
    const angle = /^Merge branch '([^']+)'/.exec(subject);
    if (angle !== null && angle[1] !== undefined) {
      mentioned.add(angle[1]);
    }
    const plain = /^Merge (fa\/[\w.-]+)/.exec(subject);
    if (plain !== null && plain[1] !== undefined) {
      mentioned.add(plain[1]);
    }
  }
  return mentioned;
}

export type BranchClass = 'in-main' | 'pending' | 'announced-but-missing';

/**
 * 纯分类函数（反向对照直接喂它合成输入）。
 *
 * - `inMain` ⇒ `in-main`；
 * - 不在 main 且 main 的 merge 信息里**没有**它 ⇒ `pending`（还没合，是待办）；
 * - 不在 main 但 main 的 merge 提交**声称**合过它 ⇒ `announced-but-missing`（合失败，**必须为空**）。
 */
export function classifyBranch(fact: {
  readonly inMain: boolean;
  readonly mentionedInMainMerge: boolean;
}): BranchClass {
  if (fact.inMain) {
    return 'in-main';
  }
  return fact.mentionedInMainMerge ? 'announced-but-missing' : 'pending';
}

export interface BranchFact {
  readonly name: string;
  readonly tip: string;
  readonly inMain: boolean;
  readonly commitsAheadOfMain: number;
  readonly mentionedInMainMerge: boolean;
}

const factsCache = new Map<string, readonly BranchFact[]>();

/**
 * 收集某个仓库的 `fa/*` 分支事实（**按 cwd 缓存**，读命令只跑一遍）。
 *
 * `inMain` 用**一条** `git branch --merged HEAD` 求出（196 个分支逐个
 * `merge-base --is-ancestor` 在 Windows 上要几十秒，这里避免）。
 * `commitsAheadOfMain` 只对**不在 main** 的分支现算（`rev-list --count`）。
 */
export function collectBranchFacts(cwd: string): readonly BranchFact[] {
  const cached = factsCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  const mergedIntoHead = new Set(
    gitIn(cwd, ['branch', '--merged', 'HEAD', '--format=%(refname:short)'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  const mentioned = parseMentionedBranches(gitIn(cwd, ['log', '--merges', '--format=%s', 'HEAD']).split('\n'));
  const facts = gitIn(cwd, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('fa/'))
    .map((line): BranchFact => {
      const [name = '', objectname = ''] = line.split('\t');
      const inMain = mergedIntoHead.has(name);
      const ahead = inMain
        ? 0
        : Number.parseInt(gitIn(cwd, ['rev-list', '--count', `HEAD..${name}`]), 10) || 0;
      return {
        name,
        tip: objectname.slice(0, 7),
        inMain,
        commitsAheadOfMain: ahead,
        mentionedInMainMerge: mentioned.has(name),
      };
    });
  factsCache.set(cwd, facts);
  return facts;
}

/** 核心判据：被 main 的 merge 提交点名、tip 却不是 HEAD 祖先的分支名（**应为空**）。 */
export function detectAnnouncedButMissing(cwd: string): string[] {
  return collectBranchFacts(cwd)
    .filter((fact) => classifyBranch(fact) === 'announced-but-missing')
    .map((fact) => fact.name);
}

/** 在临时仓库里执行会写入对象的 git（注入本地身份并关掉签名，不依赖宿主全局配置）。 */
function tmpGit(cwd: string, args: readonly string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=w13-t3',
      '-c',
      'user.email=w13-t3@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

describe('W13-T3 · 逐提交 merge-base 复算（已改为硬不变量）', () => {
  it('候选身份：现场取 HEAD（不写死），并给出可复现命令', () => {
    const head = git(['rev-parse', 'HEAD']);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // 复现：git merge-base --is-ancestor <sha> HEAD
    expect(typeof head).toBe('string');
  });

  for (const row of LANDED_FIX_COMMITS) {
    it(`A-fix/feat ${row.sha} ${row.subject} ⇒ 期望 IN main`, () => {
      // 提交必须真实存在（拼错的 sha 一律红，不允许"查不到就当不在"）。
      expect(() => git(['cat-file', '-e', `${row.sha}^{commit}`])).not.toThrow();
      const actual = isAncestorOfHead(row.sha);
      expect(
        actual,
        `git merge-base --is-ancestor ${row.sha} HEAD ⇒ ${String(actual)}（期望 true）`,
      ).toBe(true);
    });
  }

  it('汇总：A 组**全部**在 main（逐条统计，不是"抽样相信"）', () => {
    const notIn = LANDED_FIX_COMMITS.filter((row) => !isAncestorOfHead(row.sha)).map((row) => row.sha);
    expect(notIn, `A 组里不在 main 的：${notIn.join(', ')}`).toEqual([]);
    expect(LANDED_FIX_COMMITS.length).toBeGreaterThanOrEqual(20);
  });

  it('★核心不变量：main 的 merge 提交**没有**"宣布合过却实体缺失"的分支', () => {
    const facts = collectBranchFacts(REPO);
    const offenders = facts
      .filter((fact) => classifyBranch(fact) === 'announced-but-missing')
      .map((fact) => `${fact.name}@${fact.tip}`);
    expect(
      offenders,
      `这些分支被 main 的 merge 提交点名，其 tip 却不是 HEAD 的祖先 ⇒ 实体缺失（本批踩过的坑）：\n${offenders.join('\n')}`,
    ).toEqual([]);
    // 判据非空转：真实 main 上确实有**大量**分支被点名（否则"恒为空"可能只是没解析出东西）。
    expect(facts.filter((fact) => fact.mentionedInMainMerge).length).toBeGreaterThanOrEqual(100);
  });

  it('如实申报：尚未合入 main 的 fa/* 分支（**运行时现算**，不硬编码 sha）', () => {
    const pending = collectBranchFacts(REPO).filter((fact) => classifyBranch(fact) === 'pending');
    for (const fact of pending) {
      // eslint-disable-next-line no-console
      console.log(`[pending] ${fact.name} @ ${fact.tip}，领先 HEAD ${String(fact.commitsAheadOfMain)} 个提交`);
    }
    // "还没合"必须字面成立：由 `git rev-list --count HEAD..<b>` **现算**得出领先 ≥1 个提交。
    for (const fact of pending) {
      expect(fact.commitsAheadOfMain, `${fact.name} 被判 pending，必须真的领先 HEAD ≥1 个提交`).toBeGreaterThan(0);
    }
    // 与原始台账对照：xls-print-route 已由 f249589 合入 ⇒ 它**不再是** pending（若 ref 已被删则无从判定）。
    const xls = collectBranchFacts(REPO).find((fact) => fact.name === 'fa/xls-print-route');
    if (xls !== undefined) {
      expect(xls.inMain, 'fa/xls-print-route 已合入 main ⇒ 必须判为 in-main（这也是原断言过期的原因）').toBe(true);
    }
  });

  it('判别力保底：真实 main 的 merge 主题里解析出大量点名，且点到已合入的 xls-print-route', () => {
    const mentioned = parseMentionedBranches(git(['log', '--merges', '--format=%s', 'HEAD']).split('\n'));
    expect(mentioned.size, '真实 main 的 merge 主题里点到的分支数').toBeGreaterThanOrEqual(100);
    expect(
      mentioned.has('fa/xls-print-route'),
      'main 的 merge 主题里应点到 fa/xls-print-route（它已经 f249589 合入）',
    ).toBe(true);
  });

  it('★反向对照（纯函数）：合成"被点名却不在 main" ⇒ 必须判为 announced-but-missing', () => {
    const mentioned = parseMentionedBranches([
      "Merge branch 'fa/xls-print-route'",
      'test: 与合并无关的普通提交（不得被当作点名）',
    ]);
    expect(mentioned.has('fa/xls-print-route')).toBe(true);
    expect(mentioned.size).toBe(1);
    // 若把 classifyBranch 改成恒返回 'in-main' 或恒返回 'pending'，下面三条立刻变红。
    expect(classifyBranch({ inMain: false, mentionedInMainMerge: true })).toBe('announced-but-missing');
    expect(classifyBranch({ inMain: false, mentionedInMainMerge: false })).toBe('pending');
    expect(classifyBranch({ inMain: true, mentionedInMainMerge: true })).toBe('in-main');
  });

  it('★反向对照（临时仓库·真实 git 管线）：点名了却没真合 ⇒ 判据变红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w13-t3-ancestry-'));
    try {
      tmpGit(dir, ['init', '-q', '-b', 'main']);
      writeFileSync(join(dir, 'a.txt'), 'root\n');
      tmpGit(dir, ['add', '-A']);
      tmpGit(dir, ['commit', '-q', '-m', 'chore: 根提交']);

      // fa/y：真实提交，但**不**合入 main（模拟"实体缺失"）。
      tmpGit(dir, ['checkout', '-q', '-b', 'fa/y']);
      writeFileSync(join(dir, 'y.txt'), 'y\n');
      tmpGit(dir, ['add', '-A']);
      tmpGit(dir, ['commit', '-q', '-m', 'feat: y']);

      // fa/z：用来制造一条**真实 merge 提交**，其主题却点名 fa/y（"宣布合了 fa/y"，实体却是 fa/z）。
      tmpGit(dir, ['checkout', '-q', 'main']);
      tmpGit(dir, ['checkout', '-q', '-b', 'fa/z']);
      writeFileSync(join(dir, 'z.txt'), 'z\n');
      tmpGit(dir, ['add', '-A']);
      tmpGit(dir, ['commit', '-q', '-m', 'feat: z']);
      tmpGit(dir, ['checkout', '-q', 'main']);
      tmpGit(dir, ['merge', '--no-ff', '-q', '-m', "Merge branch 'fa/y'", 'fa/z']);

      // 阴性对照：fa/w **确实**被正确合入 main。
      tmpGit(dir, ['checkout', '-q', '-b', 'fa/w']);
      writeFileSync(join(dir, 'w.txt'), 'w\n');
      tmpGit(dir, ['add', '-A']);
      tmpGit(dir, ['commit', '-q', '-m', 'feat: w']);
      tmpGit(dir, ['checkout', '-q', 'main']);
      tmpGit(dir, ['merge', '--no-ff', '-q', '-m', "Merge branch 'fa/w'", 'fa/w']);

      const flagged = detectAnnouncedButMissing(dir);
      // 判据必须**真的抓到**被点名却缺失的 fa/y —— 这就是"能变红"的证据。
      expect(flagged, `临时仓库应恰好点名 fa/y：${flagged.join(', ')}`).toEqual(['fa/y']);
      // 阴性：真合入的 fa/w、未被点名的 fa/z 都不许被误判。
      expect(flagged).not.toContain('fa/w');
      expect(flagged).not.toContain('fa/z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
