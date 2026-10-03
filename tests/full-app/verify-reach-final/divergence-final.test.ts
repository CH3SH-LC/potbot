/**
 * FA-VERIFY-REACH-FINAL · 口径分叉复查（第六轮复算，HEAD `e4bb1b7`）。
 *
 * **第六轮登记的"过期描述"分叉已闭合**：`src/plugins/catalog.ts` 里三个基础角色的
 * `stub_reason` 曾在第五轮如实写着"**`src/roles/**` 整包产品不可达**（5 个模块全在产品入口
 * import 闭包之外…）"；`apps/demo/server/roles-wiring.ts` 把 roles 真接进产品后，roles 5 个
 * 模块**全部产品可达**，该描述随之过期。本轮 `catalog.ts` 已改写为"角色整包【产品可达】"。
 * 本文件据此**翻正**为"描述与代码树一致"，并**保留**反向对照：把旧措辞喂回判据必须报红。
 *
 * 1. **两套会话 schema**（`apps/demo/server/conversation-store.ts` vs
 *    `src/conversation/session-model.ts`）：第四轮判定"**没有**适配层、产品侧零提及"。
 *    本轮 **已有变化** —— 显式适配层 `src/conversation/adapter-to-store.ts` 已落地、
 *    已产品可达，两端文件头互相点名并登记分工。**但**：两份 schema 仍**未合并**，
 *    产品运行时路径（`conversation-host.ts`）仍只走产品 store ⇒ 这是"**有适配层的显式分叉**"，
 *    不是"已收敛"。下面逐条按现状断言，并保留反向对照。
 * 2. **`src/plugins/catalog.ts` 的不实描述**：第四轮点名它写着"基线提交无 src/adapters/**"，
 *    与代码树矛盾。本轮 `fa/catalog-truth` 已改正 —— 现在每条 `stub_reason` 都按
 *    "承载模块**已存在** + 真实缺口"如实书写。判据翻成"**现已一致**"，
 *    并**保留**反向对照：喂一份故意矛盾的描述 ⇒ 判据必须报红。
 *
 * 每条结论都配**反向对照**，避免"扫描器永远返回空"的假绿。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { repoRootOf, scanReachability } from './reach-scan.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = repoRootOf(HERE);
const scan = scanReachability(ROOT);

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const exists = (rel: string): boolean => {
  try {
    statSync(join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
};

/** 收集 src/** 与 apps/demo/** 下的非测试 .ts 文件（相对路径）。 */
function nonTestSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name === 'node_modules' || name === 'build') continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(rel);
    }
  };
  walk('src');
  walk('apps/demo');
  return out;
}

const SOURCES = nonTestSources();
const filesMentioning = (needle: string): string[] =>
  SOURCES.filter((f) => read(f).includes(needle));

// ===========================================================================
// 0. 判据本体的辨别力（反向对照，纯函数）
// ===========================================================================

/** 从任意文本里抽出被点名的 src/** / apps/** 路径。 */
export function namedSourcePaths(text: string): readonly string[] {
  return [...text.matchAll(/(?:src|apps)\/[A-Za-z0-9_./*-]+/g)].map((m) => m[0]);
}

/**
 * 抽出"**缺 / 无**"式断言里的路径（例：`基线提交无 src/adapters/research/**`）。
 *
 * 只认紧贴在路径前的否定词，避免把"无授权源时 cap…"这类无关句子误伤。
 */
export function absentClaims(text: string): readonly string[] {
  const re = /(?:不存在|未见|尚无|未找到|没有|缺|无)\s*[*：:（(]{0,3}\s*((?:src|apps)\/[A-Za-z0-9_./*-]+)/g;
  return [...text.matchAll(re)].map((m) => m[1] ?? '');
}

/** 把 `src/a/**` 归一成 `src/a` 后核对存在性。 */
export function pathExistsIn(root: string, token: string): boolean {
  const cleaned = token.replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');
  try {
    statSync(join(root, cleaned));
    return true;
  } catch {
    return false;
  }
}

describe('0. 判据本体的辨别力（自造文本反向对照）', () => {
  it('namedSourcePaths 能抽到路径，且不会把普通英文/包名当路径', () => {
    expect(namedSourcePaths('承载模块已存在：src/adapters/clock/** 共 17 个')).toEqual([
      'src/adapters/clock/**',
    ]);
    expect(namedSourcePaths('cap.meituan.search 与 not_ready 都不是路径')).toEqual([]);
  });

  it('absentClaims 能认出"基线提交无 <路径>"这句**已过期的**旧措辞', () => {
    const old = '基线提交无 src/adapters/research/**，未见实现。';
    expect(absentClaims(old)).toEqual(['src/adapters/research/**']);
    // 而"已存在"式陈述**不该**被认成缺-断言（否则判据会自己变红）
    expect(absentClaims('承载模块**已存在**：src/adapters/research/**')).toEqual([]);
  });

  it('pathExistsIn 对存在 / 不存在两类路径给出不同答案（判据不是恒真）', () => {
    expect(pathExistsIn(ROOT, 'src/adapters/clock/**')).toBe(true);
    expect(pathExistsIn(ROOT, 'src/adapters/definitely-absent/**')).toBe(false);
  });
});

// ===========================================================================
// 1. 会话存储：两套 schema 是否收敛 / 是否有适配层
// ===========================================================================

describe('1. 会话存储口径分叉复查（第四轮"无适配层"的结论已过期）', () => {
  const storeSchemaOf = /export const CONVERSATION_SCHEMA = '([^']+)'/;
  const sessionSchemaOf = /export const CONVERSATION_SESSION_SCHEMA = '([^']+)'/;

  it('两套 schema 常量仍在，且互不相同（**仍未**合并成一个真相源）', () => {
    const store = storeSchemaOf.exec(read('apps/demo/server/conversation-store.ts'));
    const session = sessionSchemaOf.exec(read('src/conversation/session-model.ts'));
    expect(store?.[1]).toBe('potbot-conversation-store.v1');
    expect(session?.[1]).toBe('potbot-conversation-sessions.v1');
    expect(store?.[1]).not.toBe(session?.[1]);
  });

  it('产品侧（apps/** 非测试）现在**点名**了内核会话 schema —— 但只是文档登记，不是运行时收敛', () => {
    const hits = filesMentioning('potbot-conversation-sessions.v1').filter((f) => f.startsWith('apps/'));
    // 第四轮这里为 []；本轮 conversation-store.ts 的文件头登记了两套 schema 的分工。
    expect(hits, '产品侧现在登记了内核 schema（如实写明分工）').toEqual([
      'apps/demo/server/conversation-store.ts',
    ]);
    // 关键辨别力：登记 ≠ 收敛。**承载产品存储的那个文件**仍然不 import 内核会话包。
    const store = read('apps/demo/server/conversation-store.ts');
    expect(store.includes('本文件不 import 内核会话包'), '文件头明写"不 import 内核会话包"').toBe(true);
    // 产品侧**确实**经 barrel 够到了内核会话包（conversation-loop.ts 用 TurnModel / RunConstraintBoard），
    // 但那是会话**轮次**模型，不是适配层 —— 适配层的三个映射函数在产品侧**零调用**。
    const adapterCallers = SOURCES.filter(
      (f) =>
        f.startsWith('apps/') &&
        /\b(toConversationSession|headerFromSession|recordFromSession)\b/.test(read(f)),
    );
    expect(adapterCallers, '适配层尚未接入产品路径（产品侧零调用它的映射函数）').toEqual([]);
  });

  it('适配层**已存在**（不再是第四轮的"没有任何适配层"）：adapter-to-store.ts 同时点名两套 schema 且产品可达', () => {
    const rel = 'src/conversation/adapter-to-store.ts';
    expect(exists(rel), '适配层文件存在').toBe(true);
    const adapter = read(rel);
    expect(adapter.includes('potbot-conversation-store.v1'), '点名产品侧 schema').toBe(true);
    expect(adapter.includes('potbot-conversation-sessions.v1'), '点名内核侧 schema').toBe(true);
    // 产品可达（落在 main.ts 的 import 闭包内）—— 经 barrel re-export
    const row = scan.srcModules.find((r) => r.module === rel);
    expect(row?.product, '适配层产品可达').toBe(true);
    expect(row?.nonTestImporters, '经 barrel 被产品侧够到').toEqual(['src/conversation/index.ts']);
    // 提供可测的双向投影（不是只有文档）
    expect(adapter.includes('export function toConversationSession')).toBe(true);
    expect(adapter.includes('export function headerFromSession')).toBe(true);
    expect(adapter.includes('export function recordFromSession')).toBe(true);
  });

  it('反向对照：**同时**出现两套 schema 串的文件恰好是三个"登记点"（判据能数清楚，不是恒真）', () => {
    const both = SOURCES.filter(
      (f) =>
        read(f).includes('potbot-conversation-store.v1') &&
        read(f).includes('potbot-conversation-sessions.v1'),
    );
    // 两端各登记一次 + 适配层登记一次；多一个少一个都会让本用例变红
    expect([...both].sort()).toEqual([
      'apps/demo/server/conversation-store.ts',
      'src/conversation/adapter-to-store.ts',
      'src/conversation/session-model.ts',
    ]);
    // 单串文件**不**应被判进"both"（否则判据恒真）
    expect(both).not.toContain('src/plugins/catalog.ts');
    expect(both).not.toContain('src/conversation/index.ts');
  });

  it('内核会话包的 barrel 自己把"未收敛"登记为已知缺口（诚实标注，但缺口仍在）', () => {
    const barrel = read('src/conversation/index.ts');
    expect(barrel.includes('尚未收敛')).toBe(true);
    expect(barrel.includes('已知缺口')).toBe(true);
  });

  it('反向对照：`conversation-store.ts` 的 schema 串在产品里**确实**被引用（证明检索有辨别力）', () => {
    const hits = filesMentioning('potbot-conversation-store.v1');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.startsWith('apps/'))).toBe(true);
  });

  it('内核会话持久化模型（createConversationSessions）在产品侧零调用', () => {
    const callers = filesMentioning('createConversationSessions').filter(
      (f) => !f.startsWith('src/conversation/'),
    );
    expect(callers, '产品未使用内核会话持久化模型').toEqual([]);
  });
});

// ===========================================================================
// 2. catalog.ts 的 stub_reason 真实性复查（第四轮"不实描述"→ 本轮"现已一致"）
// ===========================================================================

describe('2. src/plugins/catalog.ts 的 stub_reason 真实性复查（现已与代码树一致）', () => {
  const catalog = read('src/plugins/catalog.ts');

  /** 取某个 plugin_id 段落里的 stub_reason 文本。 */
  const reasonOf = (pluginId: string): string => {
    const at = catalog.indexOf(`plugin_id: '${pluginId}'`);
    expect(at, `${pluginId} 应存在`).toBeGreaterThan(-1);
    const slice = catalog.slice(at, at + 4000);
    const m = /stub_reason:\s*((?:'[^']*'\s*\+?\s*)*'[^']*')/.exec(slice);
    return m === null ? '' : m[1] ?? '';
  };

  const PLUGIN_IDS = [
    'template.document',
    'template.spreadsheet',
    'template.presentation',
    'template.meituan',
    'template.clock',
    'template.calendar',
    'template.research',
    'role.front_agent',
    'role.group_follower',
    'role.experience_maintainer',
  ] as const;

  it('catalog.ts 本身是**产品可达**的（描述会经 /api/plugins 呈现给用户）', () => {
    const row = scan.srcModules.find((r) => r.module === 'src/plugins/catalog.ts');
    expect(row?.product).toBe(true);
    expect(row?.nonTestImporters.length ?? 0).toBeGreaterThan(0);
  });

  it('逐条：stub_reason 里点名的每个 src/** 路径都**真的存在**（存在性断言与代码树一致）', () => {
    const violations: string[] = [];
    for (const id of PLUGIN_IDS) {
      for (const token of namedSourcePaths(reasonOf(id))) {
        if (!pathExistsIn(ROOT, token)) violations.push(`${id} 点名了不存在的路径 ${token}`);
      }
    }
    expect(violations, '第四轮的不实描述已改正；再写回假路径会立刻报红').toEqual([]);
  });

  it('逐条：stub_reason 里**没有**任何"缺 / 无 <已存在路径>"式断言（旧的过期措辞已清除）', () => {
    const violations: string[] = [];
    for (const id of PLUGIN_IDS) {
      for (const token of absentClaims(reasonOf(id))) {
        if (pathExistsIn(ROOT, token)) violations.push(`${id} 声称缺少已存在的 ${token}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('反向对照（关键）：把第四轮的**旧措辞**喂回判据 ⇒ 必须报红', () => {
    const stale = '基线提交无 src/adapters/research/**，claude 未见实现。';
    const claims = absentClaims(stale);
    expect(claims, '旧措辞必须被识别为缺-断言').toEqual(['src/adapters/research/**']);
    const flagged = claims.filter((t) => pathExistsIn(ROOT, t));
    expect(flagged, '该路径实际存在 ⇒ 判据必须判它不实').toEqual(['src/adapters/research/**']);
    // 另一个方向：点名一个**不存在**的路径也必须报红
    const bogus = namedSourcePaths('承载模块已存在：src/adapters/definitely-absent/**');
    expect(bogus.filter((t) => !pathExistsIn(ROOT, t))).toEqual(['src/adapters/definitely-absent/**']);
  });

  it('template.research：点名 src/adapters/research/** 且该包 29 个模块**全部**产品可达', () => {
    const reason = reasonOf('template.research');
    expect(reason.includes('src/adapters/research/**')).toBe(true);
    expect(exists('src/adapters/research')).toBe(true);
    const mods = scan.srcModules.filter((r) => r.module.startsWith('src/adapters/research/'));
    expect(mods.length).toBe(29);
    expect(mods.filter((r) => !r.product), '29 个全部产品可达').toEqual([]);
  });

  it('template.clock：点名 src/adapters/clock/**，17 个模块**全部**产品可达（第六轮仅 reminder-restore 不可达）', () => {
    const reason = reasonOf('template.clock');
    expect(reason.includes('src/adapters/clock/**')).toBe(true);
    const clock = scan.srcModules.filter((r) => r.module.startsWith('src/adapters/clock/'));
    expect(clock.length).toBe(17);
    // 判别力：回退 adapters-extra-routes.ts 对 reminder-restore 的接线 ⇒ 本行立刻重新变红
    expect(clock.filter((r) => !r.product).map((r) => r.module), '17 个全部产品可达').toEqual([]);
    // 描述与本轮扫描一致：点名了接线入口，且不再把 reminder-restore 说成不可达
    expect(reason.includes('src/adapters/clock/reminder-restore.ts')).toBe(true);
    expect(reason.includes('adapters-extra-routes.ts')).toBe(true);
  });

  it('template.calendar：点名 src/adapters/calendar/**，13 个模块**全部**产品可达', () => {
    const reason = reasonOf('template.calendar');
    expect(reason.includes('src/adapters/calendar/**')).toBe(true);
    const calendar = scan.srcModules.filter((r) => r.module.startsWith('src/adapters/calendar/'));
    expect(calendar.length).toBe(13);
    expect(calendar.filter((r) => !r.product)).toEqual([]);
  });

  it('template.meituan：点名 src/adapters/meituan/**，11 个模块**全部**产品可达（第六轮 5 可达 / 6 不可达）', () => {
    const reason = reasonOf('template.meituan');
    expect(reason.includes('src/adapters/meituan/**')).toBe(true);
    const meituan = scan.srcModules.filter((r) => r.module.startsWith('src/adapters/meituan/'));
    expect(meituan.length).toBe(11);
    // 判别力：回退 meituan/index.ts 对 6 个叶子模块的再导出 ⇒ 本行立刻重新变红
    expect(meituan.filter((r) => !r.product).map((r) => r.module), '11 个全部产品可达').toEqual([]);
    // 描述与本轮扫描一致：点名了接线入口
    expect(reason.includes('adapters-extra-routes.ts')).toBe(true);
  });

  it('role.experience_maintainer：点名 src/memory/experience.ts，而 memory 已整包可达', () => {
    const reason = reasonOf('role.experience_maintainer');
    expect(reason.includes('src/memory/experience.ts')).toBe(true);
    const memory = scan.srcModules.filter((r) => r.module.startsWith('src/memory/'));
    expect(memory.length).toBe(16);
    expect(memory.every((r) => r.product), 'memory 整包已可达').toBe(true);
  });

  it('**本轮翻正**：三个基础角色的 stub_reason 已不再写"整包产品不可达"，与 roles 整包可达一致', () => {
    const roles = scan.srcModules.filter((r) => r.module.startsWith('src/roles/'));
    expect(roles.length).toBe(5);
    expect(roles.every((r) => r.product), 'HEAD 上 roles 整包产品可达（roles-wiring.ts 真接线）').toBe(true);
    for (const id of ['role.front_agent', 'role.group_follower', 'role.experience_maintainer']) {
      const reason = reasonOf(id);
      // 判别力：把 catalog.ts 改回过期措辞（"整包产品不可达"）⇒ 本行立刻重新变红
      expect(
        reason.includes('整包产品不可达'),
        `${id} 的 stub_reason 不得再留"整包产品不可达"（roles 已整包可达，该描述已过期）`,
      ).toBe(false);
      expect(
        reason.includes('产品可达'),
        `${id} 的 stub_reason 现应如实写"产品可达"`,
      ).toBe(true);
    }
    // 反向对照：判据能看见"可达"这一事实（不是恒真地只读文本）
    expect(scan.srcModules.find((r) => r.module === 'src/roles/index.ts')?.label).toBe('产品可达');
  });

  it('反向对照：stub_reason 的抽取器能抽到东西（不是永远返回空串）', () => {
    expect(reasonOf('template.research').length).toBeGreaterThan(20);
    expect(reasonOf('template.clock').length).toBeGreaterThan(20);
  });
});
