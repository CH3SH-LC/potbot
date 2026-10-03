/**
 * FA-VERIFY-WAVE-14 · 第 4b 项 —— **派发守卫与真实 http.ts 的一致性**（含一次"合并把旧守卫弄红"的历史）。
 *
 * ## 历史事实（本条目的由来，可复现）
 *
 * 在本轮**开工时**的 main（`fa1d6e2`）上，两个**早已合入 main** 的验证文件是**红的**：
 *
 * ```
 * npx --no-install vitest run tests/full-app/verify-wave-10/T5-dispatch-guard.test.ts        # 2 failed @ fa1d6e2
 * npx --no-install vitest run tests/full-app/verify-wave-11/T4-dispatch-guard-prefix.test.ts # 2 failed @ fa1d6e2
 * ```
 *
 * 成因（机制可判，不是"产品坏了"）：`fa/trace-fact-versions`（`6198fae`）接入的
 * `handleFactVersionsRequest` 真实前缀是 **嵌套的** `/api/memory/facts`；而当时守卫的
 * `TOP_LEVEL_ROOT_DECL` 正则 `'/api/[^'/]+'` **只认顶层前缀**，于是把这条合法派发误报为
 * `mounted-prefix-not-owned-by-module`。`9ad653e` 把正则放宽到嵌套前缀后消解。
 *
 * 顺序证据（两条**互为反向**的 ancestry 断言）：`6198fae` 是 wave-11 的 merge `225b413` 的祖先
 * （派发先上 main），却**不是** `fa/verify-wave-11` 的分支 tip `b60a754` 的祖先（守卫被写/被测的
 * 地方不含该派发）⇒ 守卫在分支上绿、**合并进 main 后才红**。这正是本批要查的"合并完整性"：
 * 合并新包时没有在合并后的 main 上重跑此前的守卫。
 *
 * ## 本项现在断言什么
 *
 * 1. **当前不变量**：`scanHttpSource(真实 http.ts)` 零报红（守卫与模块前缀声明一致）；
 * 2. **修复的机制**：`findTopLevelRootDeclarations(trace-fact-versions.ts)` 能读嵌套前缀
 *    `/api/memory/facts`；
 * 3. **★反向对照（关键）**：把正则放宽以消除误报，**不能**把规则变成恒真 —— 用一个"被 http.ts
 *    直接 import + 派发、却没有 `/api/...` 常量"的**合成**模块，守卫**必须**照旧报
 *    `mounted-prefix-not-owned-by-module`；
 * 4. **顺序证据**（上面两条 ancestry）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createWorkspaceModuleReader,
  findTopLevelRootDeclarations,
  formatFindings,
  scanHttpSource,
} from '../../../apps/demo/server/route-dispatch-scan.js';

const REPO = process.cwd();
const SERVER_DIR = join(REPO, 'apps', 'demo', 'server');
const REAL_HTTP = readFileSync(join(SERVER_DIR, 'http.ts'), 'utf8');
const READER = createWorkspaceModuleReader(SERVER_DIR);

function gitOk(args: readonly string[]): boolean {
  try {
    execFileSync('git', [...args], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 造一份 http.ts：注入"一条 import + 一条派发"，并给出对应的模块 reader。 */
export function httpWithSyntheticRoute(input: {
  readonly importLine: string;
  readonly dispatchLine: string;
  readonly moduleFile: string;
  readonly moduleSource: string;
}): { readonly http: string; readonly reader: (rel: string) => string } {
  const anchor = 'const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {';
  expect(REAL_HTTP.includes(anchor), '真实 http.ts 里应有 handle 的锚点（否则本项判据不成立）').toBe(true);
  const http = `${input.importLine}\n${REAL_HTTP.replace(anchor, `${anchor}\n    ${input.dispatchLine}`)}`;
  return {
    http,
    reader: (rel: string): string => (rel === input.moduleFile ? input.moduleSource : READER(rel)),
  };
}

describe('W14-T5 · 派发守卫一致性（含历史红的机制还原）', () => {
  it('当前不变量：守卫在**真实** http.ts 上零报红', () => {
    const findings = scanHttpSource(REAL_HTTP, READER);
    // eslint-disable-next-line no-console
    console.log(`[guard findings on real http.ts] ${String(findings.length)}\n${formatFindings(findings)}`);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  it('修复的机制：`findTopLevelRootDeclarations` 现在能读出**嵌套**前缀 `/api/memory/facts`', () => {
    const source = readFileSync(join(SERVER_DIR, 'trace-fact-versions.ts'), 'utf8');
    const roots = findTopLevelRootDeclarations(source);
    const prefixes = roots.map((r) => r.prefix);
    expect(prefixes).toContain('/api/memory/facts');
    // 反向对照：这个前缀**真的**带 `/`（即"只认顶层前缀"的旧规则一定读不到它）。
    expect(prefixes.some((p) => p.split('/').length > 3)).toBe(true);
  });

  it('★反向对照（关键）：放宽正则**没有**把规则变成恒真 —— 无主模块仍必须报红', () => {
    const injected = httpWithSyntheticRoute({
      importLine: "import { handleW14Rootless } from './w14-rootless.js';",
      dispatchLine: 'if (await handleW14Rootless()) { return; }',
      moduleFile: 'w14-rootless.ts',
      // 故意**没有** `/api/...` 的 `*_ROOT` 常量。
      moduleSource: 'export async function handleW14Rootless(): Promise<boolean> { return false; }\n',
    });
    const findings = scanHttpSource(injected.http, injected.reader);
    const unowned = findings.filter((f) => f.kind === 'mounted-prefix-not-owned-by-module');
    expect(unowned.map((f) => f.symbol), formatFindings(findings)).toContain('handleW14Rootless');
  });

  it('★反向对照之二：合成一个**有**嵌套 `*_ROOT` 的模块 ⇒ 不再被报"无主"（修复正向生效）', async () => {
    const injected = httpWithSyntheticRoute({
      importLine: "import { handleW14Nested } from './w14-nested.js';",
      dispatchLine: 'if (await handleW14Nested()) { return; }',
      moduleFile: 'w14-nested.ts',
      moduleSource:
        "export const W14_NESTED_ROOT = '/api/w14/nested';\n" +
        'export async function handleW14Nested(): Promise<boolean> { return false; }\n',
    });
    const findings = scanHttpSource(injected.http, injected.reader);
    expect(findings.filter((f) => f.kind === 'mounted-prefix-not-owned-by-module')).toEqual([]);
    // 而且它确实**进了现推表**（嵌套前缀成为独立挂载点）。
    const { deriveMountedPrefixes } = await import('../../../apps/demo/server/route-dispatch-scan.js');
    const table = deriveMountedPrefixes(injected.http, injected.reader);
    expect(table.prefixes.map((p) => p.prefix)).toContain('/api/w14/nested');
  });

  it('顺序证据之一：派发 `6198fae` 先上 main（是 wave-11 的 merge `225b413` 的祖先）', () => {
    expect(gitOk(['merge-base', '--is-ancestor', '6198fae', '225b413']), '6198fae 应在 225b413 之前').toBe(true);
  });

  it('★顺序证据之二：wave-11 的分支 tip（守卫被写/被测处）**不含**该派发 ⇒ 合并后才红', () => {
    expect(
      gitOk(['merge-base', '--is-ancestor', '6198fae', 'b60a754']),
      'fa/verify-wave-11 的分支 tip 不应含 6198fae（否则"合并后才红"不成立）',
    ).toBe(false);
  });

  it('修复提交 `9ad653e` 确实改的是守卫本身（route-dispatch-scan.ts），且已在 main', () => {
    const files = execFileSync('git', ['show', '--name-only', '--format=', '9ad653e'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(files).toContain('apps/demo/server/route-dispatch-scan.ts');
    expect(gitOk(['merge-base', '--is-ancestor', '9ad653e', 'HEAD']), '9ad653e 应在 HEAD 的历史里').toBe(true);
  });
});
