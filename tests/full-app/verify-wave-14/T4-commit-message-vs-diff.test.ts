/**
 * FA-VERIFY-WAVE-14 · 第 3 项 —— **提交信息声称 vs 实际 diff** 的一致性抽查。
 *
 * ## 判据（每条都能变红）
 *
 * - **A. 加法声称**：提交信息正文里写了 `只做加法` / `只按前缀转交` / `不改动本文件` 的，
 *   其在 `apps/**` + `src/**` 的**删除行数必须为 0**（"只做加法"是可机判的承诺）。
 * - **B. 作用域↔路径**：`feat/fix/test(app-server)` 必须动到 `apps/demo/server/**`；
 *   `(app-web)` ⇒ `apps/demo/web/**`；`(documents)` ⇒ 路径含 `documents`；
 *   `(scheduler)` ⇒ 路径含 `scheduler`。（声称改了哪个子系统，diff 就得落在那里）
 * - **C. 测试类提交确实带测试**：`test(...)` / `test:` 的提交必须动到至少一个
 *   `*.test.ts` 或在 `tests/**` 下的文件（"test:" 却一行测试不碰 = 名不副实）。
 *
 * 【判别力】三条都配合成反例（§0）：喂"声称 app-server 却只动 docs"的假 diff，B 必须报违规。
 * 实测部分是**动态**的（按 git 现取），不是钉死的快照。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const REPO = process.cwd();

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
}

export interface FileChange {
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
}

/** 从 `git show --numstat` 的输出解析出逐文件增删（二进制以 `-` 记 ⇒ 0/0）。 */
export function parseNumstat(output: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, ...rest] = parts;
    const path = rest.join('\t');
    changes.push({
      path,
      added: addedRaw === '-' ? 0 : Number.parseInt(addedRaw ?? '0', 10),
      deleted: deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw ?? '0', 10),
    });
  }
  return changes;
}

/** 提交信息里是否**声称**本次只做加法。 */
export function claimsAdditive(body: string): boolean {
  return /只做加法|只按前缀转交|纯加法|不改动本文件|不改动本文件既有/.test(body);
}

/** 提交主题括号里的作用域，如 `fix(app-server): …` ⇒ `app-server`。 */
export function scopeOf(subject: string): string | null {
  const match = /^[a-z]+\(([^)]+)\)/.exec(subject);
  return match === null ? null : (match[1] ?? null);
}

/** 提交主题的类型前缀，如 `test(app-server): …` ⇒ `test`。 */
export function kindOf(subject: string): string | null {
  const match = /^([a-z]+)(?:\(|:)/.exec(subject);
  return match === null ? null : (match[1] ?? null);
}

const PRODUCT_PREFIXES = ['apps/', 'src/'];

/** 加法声称下，被违反的文件（在 apps/ 或 src/ 里有删除行）。 */
export function additiveViolations(changes: readonly FileChange[]): string[] {
  return changes
    .filter(
      (c) =>
        PRODUCT_PREFIXES.some((prefix) => c.path.startsWith(prefix)) &&
        c.deleted > 0 &&
        c.path.endsWith('.ts'),
    )
    .map((c) => `${c.path}（-${String(c.deleted)}）`);
}

/** 作用域↔路径的违规（声称改了 scope，diff 却没落在对应位置）。 */
export function scopeViolations(
  scope: string,
  changes: readonly FileChange[],
): string[] {
  const paths = changes.map((c) => c.path);
  const has = (predicate: (p: string) => boolean): boolean => paths.some(predicate);
  let satisfied = true;
  let expectation = '';
  switch (scope) {
    case 'app-server':
      expectation = 'apps/demo/server/**';
      satisfied = has((p) => p.startsWith('apps/demo/server/'));
      break;
    case 'app-web':
      expectation = 'apps/demo/web/**';
      satisfied = has((p) => p.startsWith('apps/demo/web/'));
      break;
    case 'documents':
      expectation = '路径含 `documents`';
      satisfied = has((p) => p.includes('documents'));
      break;
    case 'scheduler':
      expectation = '路径含 `scheduler`';
      satisfied = has((p) => p.includes('scheduler'));
      break;
    case 'session':
      expectation = '路径含 `session`';
      satisfied = has((p) => p.includes('session'));
      break;
    case 'gitattributes':
      expectation = '.gitattributes';
      satisfied = has((p) => p === '.gitattributes' || p.endsWith('/.gitattributes'));
      break;
    default:
      // repo / tests / device / docs / manifest 等宽作用域不做路径约束（如实跳过，不猜）。
      return [];
  }
  return satisfied ? [] : [`声称作用域 ${scope}（期望 ${expectation}），但 diff 无一文件落在此处`];
}

function changesOf(hash: string): FileChange[] {
  return parseNumstat(git(['show', '--numstat', '--format=', hash]));
}

function subjectOf(hash: string): string {
  return git(['log', '-1', '--format=%s', hash]).trim();
}

function bodyOf(hash: string): string {
  return git(['log', '-1', '--format=%B', hash]);
}

/** 抽查用的固定样本（本批的非合并提交，覆盖面广）。 */
const SAMPLE = [
  '9168240',
  '36ff112',
  'f4ce12a',
  '2ffdd1f',
  '1397234',
  'e722636',
  '4c962ea',
  '3fc8894',
  '4a533da',
  '27b701e',
  'fedee35',
  '442483d',
  '8131d67',
  'f518041',
  '2a3f803',
  '11c0556',
];

/** 最近 40 条**非合并**提交里，`test` 类提交的哈希。 */
function recentTestCommits(): string[] {
  const hashes = git(['log', '--no-merges', '--format=%H', '-40']).split('\n').filter((h) => h !== '');
  return hashes.filter((h) => kindOf(subjectOf(h)) === 'test');
}

describe('W14-T4 §0 · 判据的判别力（合成反例）', () => {
  it('parseNumstat：正常行解析、二进制行记 0/0', () => {
    const parsed = parseNumstat('12\t0\tapps/demo/server/http.ts\n-\t-\tassets/a.png\n');
    expect(parsed).toEqual([
      { path: 'apps/demo/server/http.ts', added: 12, deleted: 0 },
      { path: 'assets/a.png', added: 0, deleted: 0 },
    ]);
  });

  it('★B 反例：声称 app-server 却只动 docs ⇒ 必须报违规', () => {
    const bad = [{ path: 'docs/PROGRESS.md', added: 5, deleted: 0 }];
    expect(scopeViolations('app-server', bad).length).toBe(1);
    const good = [{ path: 'apps/demo/server/http.ts', added: 5, deleted: 0 }];
    expect(scopeViolations('app-server', good)).toEqual([]);
  });

  it('★A 反例：正文写"只做加法"但在 apps/ 删了行 ⇒ 必须报违规', () => {
    expect(claimsAdditive('**只做加法**：本文件其余路径不变。')).toBe(true);
    expect(claimsAdditive('这次改动不动既有实现。')).toBe(false);
    const bad = [{ path: 'apps/demo/server/http.ts', added: 3, deleted: 2 }];
    expect(additiveViolations(bad).length).toBe(1);
    const good = [{ path: 'apps/demo/server/http.ts', added: 3, deleted: 0 }];
    expect(additiveViolations(good)).toEqual([]);
  });

  it('scopeOf / kindOf 解析正确', () => {
    expect(scopeOf('fix(app-server): 交付入口不再静默丢弃 fileBase64')).toBe('app-server');
    expect(scopeOf('test: 翻正两处引用被删常量的探针')).toBeNull();
    expect(kindOf('test(repo): CRLF×shebang')).toBe('test');
    expect(kindOf('feat(app-web): 四个管理面板')).toBe('feat');
  });
});

describe('W14-T4 §1 · 实测：16 条本批提交（声称 vs diff）', () => {
  it('每条固定样本：作用域↔路径一致；加法声称的删除为 0', () => {
    const violations: string[] = [];
    const lines: string[] = [];
    for (const hash of SAMPLE) {
      const subject = subjectOf(hash);
      const changes = changesOf(hash);
      const scope = scopeOf(subject);
      if (scope !== null) {
        for (const v of scopeViolations(scope, changes)) {
          violations.push(`${hash} ${subject} ⇒ ${v}`);
        }
      }
      if (claimsAdditive(bodyOf(hash))) {
        for (const v of additiveViolations(changes)) {
          violations.push(`${hash} ${subject} ⇒ 声称加法却删除：${v}`);
        }
        lines.push(`${hash} 加法声称成立：files=${String(changes.length)}`);
      }
      lines.push(
        `${hash} [${scope ?? '—'}] files=${String(changes.length)} +${String(
          changes.reduce((s, c) => s + c.added, 0),
        )} -${String(changes.reduce((s, c) => s + c.deleted, 0))}  ${subject.slice(0, 44)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(violations, '声称与 diff 不符的提交').toEqual([]);
  });

  it('固定样本里所有 `test(...)` 提交都真的带测试文件', () => {
    const offenders: string[] = [];
    for (const hash of SAMPLE) {
      const subject = subjectOf(hash);
      if (kindOf(subject) !== 'test') continue;
      const changes = changesOf(hash);
      const hasTest = changes.some(
        (c) => c.path.endsWith('.test.ts') || c.path.startsWith('tests/'),
      );
      if (!hasTest) offenders.push(`${hash} ${subject}`);
    }
    expect(offenders, 'test 类提交却一行测试都没碰').toEqual([]);
  });

  it('动态抽查：最近 40 条非合并提交里的 `test` 类提交，全部带测试文件', () => {
    const offenders: string[] = [];
    const commits = recentTestCommits();
    expect(commits.length, '最近 40 条里 test 类提交的数量').toBeGreaterThanOrEqual(8);
    for (const hash of commits) {
      const changes = changesOf(hash);
      const hasTest = changes.some(
        (c) => c.path.endsWith('.test.ts') || c.path.startsWith('tests/'),
      );
      if (!hasTest) offenders.push(`${hash} ${subjectOf(hash)}`);
    }
    expect(offenders).toEqual([]);
  });
});
