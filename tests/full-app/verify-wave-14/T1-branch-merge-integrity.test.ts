/**
 * FA-VERIFY-WAVE-14 · 第 1 项 —— **合并完整性（分支拓扑）**。
 *
 * ## 为什么单开一项
 *
 * 本批协调者自述：合并时**连续踩了三次同一个坑**——冲突合并留下 mid-merge 状态，
 * 后续 `git merge` 静默失败，于是"**已宣布合并的分支其实不在 main**"。
 * 这不是代码缺陷，是**版本库状态缺陷**：`tsc` 全绿、单测全绿，但 main 少了整整一个包。
 *
 * 本项把它变成**可机判的不变量**：
 *
 * 1. 枚举**全部** `fa/*` 分支，逐个用 `git merge-base --is-ancestor <b> main` 判定；
 * 2. 不在 main 的分两类（**这是本项的核心判据**）：
 *    - `pending`（**还没合**）：main 的 merge 提交里**没有任何一条**点到它；
 *    - `announced-but-missing`（**合失败**）：main 的 merge 提交里**有**一条写着
 *      `Merge branch 'fa/x'`，但 `fa/x` 的 tip **不是** main 的祖先 —— 这正是
 *      "宣布了却没真合进去"的指纹。**这一类必须为空**，否则重复本批那个坑。
 * 3. 另判 mid-merge 残留（`.git/MERGE_HEAD` / `MERGE_MSG` / `rebase-*`）：那是"后续 merge
 *    静默失败"的**根因状态**，必须在工作树里缺席。
 *
 * 【判别力】第 2 条的 `announced-but-missing` 用一个**合成的**第三条分支做反向对照
 * （见下方 pure 用例）：若把判据改成恒真/恒假，那条用例立刻变红。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = process.cwd();

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: REPO, encoding: 'utf8' }).trim();
}

function gitOk(args: readonly string[]): boolean {
  try {
    execFileSync('git', [...args], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface BranchFact {
  readonly name: string;
  readonly tip: string;
  readonly inMain: boolean;
  readonly commitsAheadOfMain: number;
  readonly mentionedInMainMerge: boolean;
}

export type BranchClass = 'in-main' | 'pending' | 'announced-but-missing';

/**
 * 纯分类函数（反向对照直接喂它合成输入）。
 *
 * - `inMain` ⇒ `in-main`；
 * - 不在 main 且 main 的 merge 信息里**没有**它 ⇒ `pending`（还没合）；
 * - 不在 main 但 main 的 merge 提交**声称**合过它 ⇒ `announced-but-missing`（合失败）。
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

/** main 的 merge 提交里 "Merge branch 'fa/x'" / "Merge fa/x" 提到的分支名集合。 */
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

let factsCache: BranchFact[] | null = null;

/**
 * 收集分支事实。**只做一次**（每个 `fa/*` 分支一次 `merge-base --is-ancestor` 子进程；
 * 186 个分支在 Windows 上一次就要几十秒，重复调用会拖垮整个套件）。
 *
 * `commitsAheadOfMain` 只对**不在 main** 的分支才算（`rev-list --count` 也是一次子进程）。
 */
function collectFacts(): BranchFact[] {
  if (factsCache !== null) {
    return factsCache;
  }
  const refLines = git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('fa/'));
  const mentioned = parseMentionedBranches(git(['log', '--merges', '--format=%s', 'main']).split('\n'));
  factsCache = refLines.map((line) => {
    const [name = '', objectname = ''] = line.split('\t');
    const inMain = gitOk(['merge-base', '--is-ancestor', name, 'main']);
    const ahead = inMain
      ? 0
      : Number.parseInt(git(['rev-list', '--count', `main..${name}`]), 10) || 0;
    return {
      name,
      tip: objectname.slice(0, 7),
      inMain,
      commitsAheadOfMain: ahead,
      mentionedInMainMerge: mentioned.has(name),
    };
  });
  return factsCache;
}

describe('W14-T1 · 合并完整性：每个 fa/* 分支是否**真**在 main', () => {
  it('HEAD 与 main **未分叉**（一方是另一方的祖先）；漂移方向如实申报', () => {
    const head = git(['rev-parse', 'HEAD']);
    const main = git(['rev-parse', 'main']);
    const mainInHead = gitOk(['merge-base', '--is-ancestor', 'main', 'HEAD']);
    const headInMain = gitOk(['merge-base', '--is-ancestor', 'HEAD', 'main']);
    // eslint-disable-next-line no-console
    console.log(
      `[drift] HEAD=${head.slice(0, 7)} main=${main.slice(0, 7)} main⊆HEAD=${String(mainInHead)} HEAD⊆main=${String(headInMain)}`,
    );
    // 允许两种方向（main 可能被别的并发工作者推进），但**不允许分叉**：分叉意味着本工作树
    // 的验证基线已不再是一条直链，本轮的"合并完整性"结论会受到污染。
    expect(mainInHead || headInMain, 'HEAD 与 main 分叉了：验证基线不再是直链').toBe(true);
  });

  it('仓库**没有** mid-merge 残留（"后续 merge 静默失败"的根因状态）', () => {
    const gitDir = git(['rev-parse', '--git-dir']);
    const absoluteGitDir = gitDir.startsWith('.') ? join(REPO, gitDir.slice(2)) : gitDir;
    for (const residue of [
      'MERGE_HEAD',
      'MERGE_MSG',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      expect(
        existsSync(join(absoluteGitDir, residue)),
        `发现 ${residue}：仓库处于冲突/合并中间态，后续 git merge 会静默失败`,
      ).toBe(false);
    }
  });

  // 首次调用会发出 186 次 `git merge-base --is-ancestor` 子进程（Windows 上约 15–20 s）——
  // 这是**重型用例自带显式时限**（纪律：不改 `vitest.config.ts` 的 testTimeout）。
  it(
    '★核心：**没有任何** fa/* 分支处于"已宣布合并、实体却不在 main"的状态',
    () => {
      const facts = collectFacts();
      const announcedButMissing = facts.filter(
        (f) => classifyBranch(f) === 'announced-but-missing',
      );
      expect(
        announcedButMissing.map((f) => `${f.name}@${f.tip}`),
        '这些分支的 merge 提交已写进 main，但它的 tip 不是 main 的祖先 ⇒ 实体丢了（本批踩过三次的坑）',
      ).toEqual([]);
    },
    90_000,
  );

  it('如实申报：**尚未合并**的 fa/* 分支逐个列出（这一类不是缺陷，是待办）', () => {
    const facts = collectFacts();
    const pending = facts.filter((f) => classifyBranch(f) === 'pending');
    // 如实打印，供回报里点名。
    for (const f of pending) {
      // eslint-disable-next-line no-console
      console.log(`[pending] ${f.name} @ ${f.tip}，领先 main ${String(f.commitsAheadOfMain)} 个提交`);
    }
    // pending 的分支必须**真的**领先 main（否则"还没合"这个说法不成立）。
    for (const f of pending) {
      expect(f.commitsAheadOfMain, `${f.name} 被判为 pending，必须领先 main ≥1 个提交`).toBeGreaterThan(0);
    }
  });

  it('规模如实：已合入 main 的 fa/* 分支数与 main 的 merge 提交数都 ≥ 100（本批规模）', () => {
    const facts = collectFacts();
    const inMain = facts.filter((f) => classifyBranch(f) === 'in-main');
    expect(facts.length, 'fa/* 分支总数').toBeGreaterThanOrEqual(150);
    expect(inMain.length, '已合入 main 的 fa/* 分支数').toBeGreaterThanOrEqual(150);
    expect(
      git(['log', '--merges', '--format=%H', 'main']).split('\n').filter((l) => l.trim() !== '').length,
      'main 的 merge 提交数',
    ).toBeGreaterThanOrEqual(100);
  });

  it('★反向对照：合成一条"被 merge 信息点名、实体却不在 main"的分支 ⇒ 必须判为 announced-but-missing', () => {
    expect(classifyBranch({ inMain: false, mentionedInMainMerge: true })).toBe('announced-but-missing');
    expect(classifyBranch({ inMain: false, mentionedInMainMerge: false })).toBe('pending');
    expect(classifyBranch({ inMain: true, mentionedInMainMerge: false })).toBe('in-main');
  });

  it('★反向对照：merge 提交主题解析必须真的能点出分支名（否则第 3 条恒真）', () => {
    const mentioned = parseMentionedBranches([
      "Merge branch 'fa/xls-formula-product'",
      "Merge fa/perf-gate-3（T1 冲突取性能优化版）",
      'test(app-server): 与合并无关的普通提交',
    ]);
    expect(mentioned.has('fa/xls-formula-product')).toBe(true);
    expect(mentioned.has('fa/perf-gate-3')).toBe(true);
    expect(mentioned.size).toBe(2);
    // 真实 main 上必须解析出**大量**点名（否则"点名"没发生，第 3 条无判别力）。
    const realMentioned = parseMentionedBranches(git(['log', '--merges', '--format=%s', 'main']).split('\n'));
    expect(realMentioned.size, '真实 main 的 merge 主题里应点出大量 fa/* 分支').toBeGreaterThanOrEqual(100);
  });
});
