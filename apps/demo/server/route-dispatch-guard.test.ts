/**
 * 机器化守卫：禁止"只 import 不派发"与"只赋值不读取的宿主常量"。
 *
 * 本批踩过两次的同一类缺陷，这里把它钉成机器可判：
 * - `95e0f45`：`http.ts` import 了 `handleDocumentsRequest` / `handleResearchRequest`、
 *   造了 `documentsHost` / `researchOptions`，**却没有派发** ⇒ tsc 绿、in-process 测试绿、
 *   真服务两个前缀全 404（`tsconfig` 未开 `noUnusedLocals`，死 import 骗过编译器）。
 * - 并集合并吞掉 `xlsFacts` 派发块的 `return; }` ⇒ 语法错（那一类由 tsc 兜住）。
 * - `fa/verify-wave-8` 的 T5 独立复算量出：规则 C 的 `MOUNTED_PREFIXES` 是**手写 10 条常量表**，
 *   漏了本轮新挂的 `/api/facts`（规则 A 覆盖它、规则 C 不覆盖）。**本文件把它改成现推**。
 *
 * 证据结构（自证不是空转）：
 * 1. 真实 `http.ts` ⇒ **必须绿**；
 * 2. 自造坏样例（只 import 不调用 / 只赋值不读取 / 两者合体）⇒ **必须报红**；
 * 3. 自造好样例 ⇒ 必须绿；
 * 4. **变异真实文件**（抹掉一行真实派发行）⇒ 必须报红；
 * 5. **历史复现**：`git show 95e0f45:apps/demo/server/http.ts` 那份真实坏版本 ⇒ 必须报红；
 * 6. **规则 C 现推表的防走空**：≥12 条、含 `/api/facts`，每条都能在 `http.ts` 里找到派发行
 *    （前缀表按"http.ts 直接 import 的模块所声明的 `*_ROOT`"现推，含嵌套前缀如 `/api/memory/facts`）；
 * 7. **规则 C 的反向对照**：① 抹掉 `/api/facts`、`/api/session-adapters`、`/api/krn-barrel`
 *    三条派发行 ⇒ 各自单独报红；② 加一条"有 import、有派发、模块却没有 `/api/<name>` 常量"
 *    的幽灵路由 ⇒ 报"前缀表与模块不一致"，而不是静默通过；③（正对照）同样的幽灵路由，只要
 *    模块真的声明了 `*_ROOT` ⇒ 绿，证明规则 C 不是"一见新派发就报红"。
 *
 * 全部纯读源码文本，**不起服务、不 import 被扫描模块**。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createWorkspaceModuleReader,
  deriveMountedPrefixes,
  extractDispatchSites,
  extractImportedModules,
  extractValueImports,
  findHandleImportsNotDispatched,
  findUnreadHostConstants,
  formatFindings,
  handleFunctionBody,
  scanHttpSource,
  stripComments,
} from './route-dispatch-scan.js';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HTTP_FILE = join(SERVER_DIR, 'http.ts');
const REAL_SOURCE = readFileSync(HTTP_FILE, 'utf8');
const REAL_STRIPPED = stripComments(REAL_SOURCE);
const READER = createWorkspaceModuleReader(SERVER_DIR);

/** 真实文件上现推出的规则 C 两侧（下面多处复用）。 */
const REAL_TABLE = deriveMountedPrefixes(REAL_SOURCE, READER);
const REAL_PREFIXES = REAL_TABLE.prefixes.map((entry) => entry.prefix);

const REAL_HOST_CONSTANTS = [
  'memoryHost',
  'pluginOptions',
  'loopRoutes',
  'documentsHost',
  'researchOptions',
  'xlsFactsHost',
  'factsHost',
] as const;

const REAL_HANDLE_IMPORTS = [
  'handleMemoryRequest',
  'handlePluginRequest',
  'handleDocumentsRequest',
  'handleResearchRequest',
  'handlePptxFactsRequest',
  'handleToolLoopRequest',
  'handleXlsFactsRequest',
  'handleFactsRequest',
] as const;

/** 产品入口当前真正派发的**顶层**前缀（本轮补齐后的完整集合；探针下限见下面的 ≥12 断言）。 */
const EXPECTED_PREFIXES = [
  '/api/adapters',
  '/api/conversation-loop',
  '/api/documents',
  '/api/facts',
  '/api/krn-barrel',
  '/api/memory',
  '/api/plugins',
  '/api/ppt-facts',
  '/api/research',
  '/api/roles',
  '/api/session-adapters',
  '/api/tool-loop',
  '/api/xls-facts',
] as const;

function findRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`从 ${startDir} 向上找不到带 .git 的仓库根`);
    }
    current = parent;
  }
}

/** 取 `95e0f45` 那份**真实的历史坏版本**（走 git 对象库，不依赖任何自造样例）。 */
function readHistoricalHttpSource(): string {
  const repoRoot = findRepoRoot(SERVER_DIR);
  return String(
    execFileSync('git', ['show', '95e0f45:apps/demo/server/http.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

/** 抹掉真实源里含某段文字的整行（模拟"派发行被合并 / 编辑吞掉"）。 */
function dropLinesContaining(source: string, needle: string): string {
  return source
    .split('\n')
    .map((line) => (line.includes(needle) ? '' : line))
    .join('\n');
}

describe('route-dispatch-guard / 前置事实（防守卫空转）', () => {
  it('stripComments 抹掉注释但保住字符串字面量里的 //', () => {
    const sample = ["const url = new URL(x, 'http://127.0.0.1');", '// 这行注释里有 handleFooRequest', '/* 块注释 */'].join(
      '\n',
    );
    const stripped = stripComments(sample);
    expect(stripped).toContain("'http://127.0.0.1'");
    expect(stripped).not.toContain('这行注释');
    expect(stripped).not.toContain('块注释');
    // 行号结构不变
    expect(stripped.split('\n')).toHaveLength(sample.split('\n').length);
  });

  it('真实 http.ts 经抹平后仍含 handle() 与七个宿主常量声明（扫描器没有把文件读废）', () => {
    expect(REAL_STRIPPED).toContain('const handle = async');
    for (const name of REAL_HOST_CONSTANTS) {
      expect(REAL_STRIPPED).toContain(`const ${name}`);
    }
  });

  it('真实 http.ts 确实 import 了八个 handle* 符号（规则 A 在真文件上非空转）', () => {
    const imported = new Set(extractValueImports(REAL_STRIPPED).map((entry) => entry.name));
    for (const name of REAL_HANDLE_IMPORTS) {
      expect(imported.has(name), `未在 import 里找到 ${name}`).toBe(true);
    }
  });

  it('现推的派发点解析出六个 `.handle(` 接收者（规则 C 的派发侧非空转）', () => {
    const sites = extractDispatchSites(REAL_STRIPPED, REAL_STRIPPED.indexOf('const handle = async'));
    const receivers = sites.filter((site) => site.receiver).map((site) => site.identifier).sort();
    // 六个接收者：既有五个 + FA-KRN-ORPHANS 新增的 `krnOrphansRoutes`（本清单随真实 http.ts 更新）。
    expect(receivers).toEqual([
      'adapters',
      'krnBarrelRoutes',
      'krnOrphansRoutes',
      'loopRoutes',
      'rolesWiring',
      'sessionAdaptersRoutes',
    ]);
  });

  it('现推的模块表收全了 http.ts 里所有相对 import（声明侧非空转）', () => {
    const modules = extractImportedModules(REAL_STRIPPED).map((entry) => entry.moduleFile);
    expect(modules).toContain('facts-routes.ts');
    expect(modules).toContain('session-adapters-wiring.ts');
    expect(modules).toContain('krn-barrel.ts');
    // 相对路径已归一化成 `.ts`，绝对/裸模块（node:fs 等）一概不收。
    expect(modules.every((entry) => entry.endsWith('.ts') || entry.includes('..'))).toBe(true);
    expect(modules.some((entry) => entry.startsWith('node:'))).toBe(false);
  });
});

describe('route-dispatch-guard / 规则 C 的现推表（防走空 + 与真实派发集合一致）', () => {
  it('现推前缀数 ≥ 12 且含 /api/facts（手写 10 条表的缺口已闭合）', () => {
    expect(REAL_PREFIXES.length).toBeGreaterThanOrEqual(12);
    expect(REAL_PREFIXES).toContain('/api/facts');
  });

  it('现推表 ⊇ 产品入口真正派发的 13 个顶层前缀（超集，新路由自动纳表不靠手抄）', () => {
    for (const prefix of EXPECTED_PREFIXES) {
      expect(REAL_PREFIXES, `现推表漏了 ${prefix}`).toContain(prefix);
    }
  });

  it('每条现推前缀都能在 http.ts 里找到派发行，且没有"派发了却无模块"的孤儿', () => {
    const body = handleFunctionBody(REAL_STRIPPED);
    expect(body).not.toBeNull();
    for (const entry of REAL_TABLE.prefixes) {
      expect(entry.dispatch, `${entry.prefix} 解析不到任何派发标识符`).not.toBeNull();
      expect(entry.dispatchedBy.length, `${entry.prefix} 的派发标识符为空`).toBeGreaterThan(0);
      expect(entry.dispatch?.test(body ?? ''), `${entry.prefix} 缺派发行 ${String(entry.dispatchLabel)}`).toBe(true);
    }
    expect(REAL_TABLE.unownedDispatches).toEqual([]);
  });

  it('两条已知的子前缀（/api/adapters/actions、/api/adapters/extra）由父前缀覆盖，不在顶层表里', () => {
    expect(REAL_PREFIXES).not.toContain('/api/adapters/actions');
    expect(REAL_PREFIXES).not.toContain('/api/adapters/extra');
    expect(REAL_PREFIXES).toContain('/api/adapters');
  });

  it('如实记录边界：http.ts 自实现的前缀不在规则 C 覆盖范围（本地函数解析不到模块）', () => {
    for (const own of ['/health', '/api/identity', '/api/conversations', '/api/tasks', '/api/artifacts']) {
      expect(REAL_PREFIXES).not.toContain(own);
    }
    // `/api/conversations` 的派发标识符是 http.ts 自己的本地函数，因此被本规则有意跳过。
    expect(REAL_STRIPPED).toContain('async function handleConversationRoute(');
  });
});

describe('route-dispatch-guard / 正对照：真实文件必须绿', () => {
  it('apps/demo/server/http.ts ⇒ 零报红', () => {
    const findings = scanHttpSource(REAL_SOURCE, READER);
    expect(findings, `真实 http.ts 被报红：\n${formatFindings(findings)}`).toEqual([]);
  });
});

describe('route-dispatch-guard / 反对照：自造坏样例必须报红', () => {
  it('规则 A：import 了 handle* 却没有调用点 ⇒ 报红', () => {
    const bad = [
      "import { handleFooRequest } from './foo-routes.js';",
      'const handle = async (req: unknown, res: unknown): Promise<void> => {',
      '  void req;',
      '  void res;',
      '};',
    ].join('\n');
    const findings = findHandleImportsNotDispatched(bad);
    expect(findings.map((f) => `${f.kind}:${f.symbol}`)).toEqual(['handle-import-not-dispatched:handleFooRequest']);
  });

  it('规则 B：宿主常量只赋值不读取 ⇒ 报红', () => {
    const bad = ['const fooHost: FooHost = bar ?? {};', 'export function nope(): unknown {', '  return null;', '}'].join(
      '\n',
    );
    const findings = findUnreadHostConstants(bad);
    expect(findings.map((f) => `${f.kind}:${f.symbol}`)).toEqual(['host-constant-never-read:fooHost']);
  });

  it('半截接线合体样例（照抄 95e0f45 的形态）⇒ 两条规则同时报红', () => {
    const halfWired = [
      "import { handleBarRequest } from './bar-routes.js';",
      'const barHost: BarHost = bar ?? {};',
      'const handle = async (req: unknown, res: unknown): Promise<void> => {',
      '  void req;',
      '  void res;',
      '};',
    ].join('\n');
    const findings = scanHttpSource(halfWired, READER, { checkMountedPrefixes: false });
    expect(findings.map((f) => `${f.kind}:${f.symbol}`).sort()).toEqual([
      'handle-import-not-dispatched:handleBarRequest',
      'host-constant-never-read:barHost',
    ]);
  });

  it('正样例（import + 调用 + 常量被读）⇒ 绿（守卫不是恒红）', () => {
    const good = [
      "import { handleBazRequest } from './baz-routes.js';",
      'const bazHost: BazHost = baz ?? {};',
      'const handle = async (req: unknown, res: unknown): Promise<void> => {',
      '  if (await handleBazRequest({ req, res, host: bazHost })) {',
      '    return;',
      '  }',
      '};',
    ].join('\n');
    expect(scanHttpSource(good, READER, { checkMountedPrefixes: false })).toEqual([]);
  });

  it('变异真实文件：抹掉 handleXlsFactsRequest 派发行 ⇒ 三条规则同时报红', () => {
    const mutated = dropLinesContaining(REAL_SOURCE, 'await handleXlsFactsRequest(');
    expect(mutated).not.toBe(REAL_SOURCE);
    const keys = scanHttpSource(mutated, READER).map((f) => `${f.kind}:${f.symbol}`);
    expect(keys).toContain('handle-import-not-dispatched:handleXlsFactsRequest');
    expect(keys).toContain('host-constant-never-read:xlsFactsHost');
    expect(keys).toContain('mounted-prefix-not-dispatched:/api/xls-facts');
  });
});

describe('route-dispatch-guard / 规则 C 反向对照①：抹掉派发行 ⇒ 逐条报红', () => {
  const cases: readonly { readonly prefix: string; readonly needle: string; readonly label: string }[] = [
    { prefix: '/api/facts', needle: 'await handleFactsRequest(', label: 'handleFactsRequest' },
    { prefix: '/api/session-adapters', needle: 'sessionAdaptersRoutes.handle(', label: 'sessionAdaptersRoutes' },
    { prefix: '/api/krn-barrel', needle: 'krnBarrelRoutes.handle(', label: 'krnBarrelRoutes' },
    { prefix: '/api/tool-loop', needle: 'await handleToolLoopRequest(', label: 'handleToolLoopRequest' },
    { prefix: '/api/adapters', needle: 'adapters.handle(', label: 'adapters' },
  ];

  for (const item of cases) {
    it(`抹掉 ${item.label} 的派发行 ⇒ mounted-prefix-not-dispatched:${item.prefix}`, () => {
      const mutated = dropLinesContaining(REAL_SOURCE, item.needle);
      expect(mutated, `探针 ${item.needle} 在真实源里没找到`).not.toBe(REAL_SOURCE);
      const findings = scanHttpSource(mutated, READER);
      const keys = findings.map((f) => `${f.kind}:${f.symbol}`);
      expect(keys, `未报红：\n${formatFindings(findings)}`).toContain(
        `mounted-prefix-not-dispatched:${item.prefix}`,
      );
      // 其余前缀不能被连坐（守卫只钉住被抹掉的那一条）。
      for (const other of EXPECTED_PREFIXES) {
        if (other !== item.prefix) {
          expect(keys).not.toContain(`mounted-prefix-not-dispatched:${other}`);
        }
      }
    });
  }
});

describe('route-dispatch-guard / 规则 C 反向对照②：派发与模块对不上 ⇒ 报"前缀表与模块不一致"', () => {
  const GHOST_MODULE = 'ghost-routes.ts';
  const GHOST_WITHOUT_ROOT = [
    "// 幽灵路由模块：有 handle 入口，但没有导出的顶层 /api/<name> ROOT 常量。",
    'export async function handleGhostRequest(input: unknown): Promise<boolean> {',
    '  void input;',
    '  return false;',
    '}',
  ].join('\n');
  const GHOST_WITH_ROOT = [
    `export const GHOST_ROOT = '/api/ghost';`,
    'export async function handleGhostRequest(input: unknown): Promise<boolean> {',
    '  void input;',
    '  return false;',
    '}',
  ].join('\n');

  const MARKER = "    if (pathname.startsWith('/api/')) {";

  function plantGhost(moduleSource: string): { readonly source: string; readonly reader: (m: string) => string } {
    expect(REAL_SOURCE).toContain(MARKER);
    const imported = `import { handleGhostRequest } from './ghost-routes.js';\n${REAL_SOURCE}`;
    const dispatched = imported.replace(
      MARKER,
      `    if (await handleGhostRequest({ req, res, url })) {\n      return;\n    }\n${MARKER}`,
    );
    expect(dispatched).toContain('await handleGhostRequest(');
    return {
      source: dispatched,
      reader: (moduleFile) => (moduleFile === GHOST_MODULE ? moduleSource : READER(moduleFile)),
    };
  }

  it('派人一条"有 import、有派发、模块却无 ROOT"的幽灵路由 ⇒ 报红（不是静默通过）', () => {
    const ghost = plantGhost(GHOST_WITHOUT_ROOT);
    const findings = scanHttpSource(ghost.source, ghost.reader);
    const keys = findings.map((f) => `${f.kind}:${f.symbol}`);
    expect(keys, `幽灵路由被静默放过：\n${formatFindings(findings)}`).toContain(
      'mounted-prefix-not-owned-by-module:handleGhostRequest',
    );
  });

  it('同一幽灵路由，模块一旦真的声明 *_ROOT ⇒ 绿（证明规则 C 的两侧是双向对表）', () => {
    const ghost = plantGhost(GHOST_WITH_ROOT);
    const table = deriveMountedPrefixes(ghost.source, ghost.reader);
    expect(table.prefixes.map((entry) => entry.prefix)).toContain('/api/ghost');
    expect(table.unownedDispatches).toEqual([]);
    expect(scanHttpSource(ghost.source, ghost.reader), '有 ROOT 的幽灵路由被误报').toEqual([]);
  });
});

describe('route-dispatch-guard / 历史复现：95e0f45 的真实坏版本必须被报出', () => {
  it('git show 95e0f45:apps/demo/server/http.ts ⇒ 报出半截接线与幽灵常量', () => {
    const historical = readHistoricalHttpSource();
    // 这份版本确实是被记入历史的坏版本：import 与宿主常量都在，派发不在。
    expect(historical).toContain('handleDocumentsRequest');
    expect(historical).toContain('handleResearchRequest');
    expect(historical).toContain('const documentsHost: DocumentsRouteHost');
    expect(historical).toContain('const researchOptions: ResearchRoutesOptions');

    const findings = scanHttpSource(historical, READER);
    const keys = findings.map((f) => `${f.kind}:${f.symbol}`);

    expect(keys, `历史坏版本未被完整报出：\n${formatFindings(findings)}`).toContain(
      'handle-import-not-dispatched:handleDocumentsRequest',
    );
    expect(keys).toContain('handle-import-not-dispatched:handleResearchRequest');
    expect(keys).toContain('host-constant-never-read:documentsHost');
    expect(keys).toContain('host-constant-never-read:researchOptions');
    expect(keys).toContain('mounted-prefix-not-dispatched:/api/documents');
    expect(keys).toContain('mounted-prefix-not-dispatched:/api/research');
    // 同一份文件里**已经接好的**那些派发不能被误伤，否则守卫就是"全盘报红"的噪声。
    expect(keys).not.toContain('handle-import-not-dispatched:handleMemoryRequest');
    expect(keys).not.toContain('handle-import-not-dispatched:handlePluginRequest');
    expect(keys).not.toContain('host-constant-never-read:memoryHost');
  });
});
