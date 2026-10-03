/**
 * FA-CRLF-SHEBANG-SCAN —— 根因探针（**只读、机读**）
 *
 * 背景：`scripts/demo/honor-connect.mjs` 等带 shebang 的 `.mjs` 在工作区是 CRLF。
 * Vite 7.3.6 的 `hashbangRE = /^#!.*\n/` **不匹配 CRLF**（JS 的 `.` 不匹配 `\r`），
 * 于是 `fileStartIndex` 退化为 0，导出注册代码被 `appendLeft(0, …)` 插到 `#!` **之前**
 * ⇒ 收集期 SyntaxError（0 tests）。
 *
 * 本模块**不复制**任何结论：它从**实际安装的 vite / @vitest/mocker 发行文件**里
 * 把正则源码抠出来再编译，并在**真实 Vite SSR 加载器**上跑最小夹具。
 *
 * 证据分三层（见 `hashbang-rootcause.test.ts`）：
 *   ① 正则层 —— 从 dist 抠出 `hashbangRE` 原文 + `fileStartIndex` 赋值行，直接跑
 *   ② 变换层 —— `server.transformRequest(url, { ssr: true })` 观察产物头部
 *   ③ 加载层 —— `server.ssrLoadModule(url)` 真实求值（CRLF 抛 SyntaxError，LF 正常）
 *   ④ 复核层 —— vitest 自己的 mock 提升 `hoistMocks()`（`@vitest/mocker`）同一正则同一病灶
 *
 * 说明：vite / @vitest/mocker 不是本仓库的直接依赖（只装了 vitest），
 * 故不能静态 import；这里借 `createRequire` 从 **vitest 自己的解析前缀** 定位。
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** `#!/usr/bin/env node\n` —— LF 版 shebang 行的精确长度 */
export const LF_SHEBANG_LINE = '#!/usr/bin/env node\n';
/** `#!/usr/bin/env node\r\n` —— CRLF 版 shebang 行 */
export const CRLF_SHEBANG_LINE = '#!/usr/bin/env node\r\n';

/** 探针用最小夹具：shebang + 一个具名导出（触发 vite 的导出注册注入） */
export const FIXTURE_BODY = 'export const marker = "ok";\n';

export interface HashbangRegexObservation {
  /** 实际被读的发行文件绝对路径 */
  modulePath: string;
  /** 正则字面量原文，如 `/^#!.*\n/` */
  literal: string;
  /** 正则源码（不含斜杠），可直接 `new RegExp(source)` 复现 */
  regexSource: string;
  /** 抠出的 `fileStartIndex` 赋值行原文（证明该正则真的决定插入位置）；mocker 无此行则为 null */
  fileStartIndexLine: string | null;
  /** 在 LF 代码上的匹配长度；null = 不匹配 */
  matchLengthLf: number | null;
  /** 在 CRLF 代码上的匹配长度；null = 不匹配 */
  matchLengthCrlf: number | null;
  /** 由 `?? 0` 推出的插入位置 */
  fileStartIndexLf: number;
  fileStartIndexCrlf: number;
  /** 用抠出的源码在 LF / CRLF 上跑出的真实匹配 */
  matchedLf: boolean;
  matchedCrlf: boolean;
}

export interface ViteLoadObservation {
  /** 夹具标签（'lf' / 'crlf'） */
  label: string;
  /** 夹具 URL（相对于 vite root） */
  url: string;
  /** transformRequest(ssr) 的产物头部（前 120 字符） */
  transformedHead: string;
  /** 产物是否仍以 `#!` 开头（= 插入位置正确） */
  transformedStartsWithShebang: boolean;
  /** ssrLoadModule 是否成功求值 */
  loaded: boolean;
  /** 求值成功时的导出值 */
  marker: string | null;
  /** 求值失败时的错误构造器名（如 SyntaxError） */
  errorName: string | null;
  /** 求值失败时的错误首行 */
  errorMessage: string | null;
}

export interface MockerHoistObservation {
  label: string;
  modulePath: string;
  literal: string;
  regexSource: string;
  /** hoistMocks 产物是否仍以 `#!` 开头 */
  hoistedStartsWithShebang: boolean;
  /** hoistMocks 产物头部 */
  hoistedHead: string;
}

interface ViteServerLike {
  transformRequest(
    url: string,
    opts?: { ssr?: boolean },
  ): Promise<{ code?: string } | null | undefined>;
  ssrLoadModule(url: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface ViteModuleLike {
  createServer(opts: Record<string, unknown>): Promise<ViteServerLike>;
  parseAst: (code: string, opts?: unknown) => unknown;
  version: string;
}

interface MockerNodeLike {
  hoistMocks: (
    code: string,
    id: string,
    parse: (code: string, opts?: unknown) => unknown,
    options?: Record<string, unknown>,
  ) => { code: string } | undefined;
}

/**
 * 从 **vitest 的解析前缀** 定位一个包。理由：vite / @vitest/mocker 未提升到仓库
 * 顶层 `node_modules`（pnpm），从本测试文件直接 `import('vite')` 会 MODULE_NOT_FOUND。
 */
export function resolveViaVitest(specifier: string): string {
  const fromTestFile = createRequire(import.meta.url);
  const vitestEntry = fromTestFile.resolve('vitest');
  const fromVitestPkg = createRequire(vitestEntry);
  return fromVitestPkg.resolve(specifier);
}

const HASHBANG_ASSIGN_RE = /const hashbangRE = \/(.*?)\/;/;
const FILE_START_INDEX_RE = /const fileStartIndex = hashbangRE\.exec\(code\)\?\.\[0\]\.length \?\? 0;/;

/**
 * 包入口往往只是 re-export 桶（vite 的 `dist/node/index.js`），真身在 `dist/node/chunks/*.js`。
 * 这里从入口目录递归找**第一个含 `const hashbangRE = /…/` 的发行文件**，找不到就抛错
 * （不静默降级成"自己手写一个正则"——那会变成自证）。
 */
function locateDistFileWithHashbang(entryPath: string): { file: string; text: string } {
  const visited = new Set<string>();
  const queue: string[] = [path.dirname(entryPath)];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        queue.push(p);
      } else if (ent.isFile() && /\.(?:js|cjs|mjs)$/.test(ent.name)) {
        const text = fs.readFileSync(p, 'utf8');
        if (HASHBANG_ASSIGN_RE.test(text)) return { file: p, text };
      }
    }
  }
  throw new Error(
    `在 ${path.dirname(entryPath)} 下找不到含 hashbangRE 的发行文件 —— 发行结构已变，请更新探针`,
  );
}

/**
 * 从发行文件里抠出 `hashbangRE` 原文，**用抠出的源码**在给定代码上跑真实匹配。
 *
 * `requireFileStartIndex`：只有 Vite 的 SSR 变换里才有 `const fileStartIndex = hashbangRE.exec(code)?.[0].length ?? 0;`
 * 这一行（`@vitest/mocker` 用自己的 `let hoistIndex = …`），故按需索取。
 */
export function observeHashbangRegex(
  modulePath: string,
  lfCode: string,
  crlfCode: string,
  requireFileStartIndex = true,
): HashbangRegexObservation {
  const located = locateDistFileWithHashbang(modulePath);
  const text = located.text;
  const m = HASHBANG_ASSIGN_RE.exec(text);
  if (m === null || m[1] === undefined) {
    throw new Error(`无法从 ${located.file} 中抠出 hashbangRE —— 发行文件结构已变，请更新探针`);
  }
  const regexSource = m[1];
  const literal = `/${regexSource}/`;
  // 注意：原文是 `/^#!.*\n/`（无 flags）。忠实复现 ⇒ 不带任何 flags。
  const re = new RegExp(regexSource);
  const lfMatch = re.exec(lfCode);
  const crlfMatch = re.exec(crlfCode);
  const startIndexLine = FILE_START_INDEX_RE.exec(text)?.[0] ?? null;
  if (requireFileStartIndex && startIndexLine === null) {
    throw new Error(
      `无法从 ${modulePath} 中抠出 fileStartIndex 赋值行 —— 发行文件结构已变，请更新探针`,
    );
  }
  return {
    // 报**真身**文件（入口桶只是 re-export），让断言能钉住"这段代码确实来自该发行文件"
    modulePath: located.file,
    literal,
    regexSource,
    fileStartIndexLine: startIndexLine,
    matchLengthLf: lfMatch === null ? null : lfMatch[0].length,
    matchLengthCrlf: crlfMatch === null ? null : crlfMatch[0].length,
    fileStartIndexLf: lfMatch?.[0].length ?? 0,
    fileStartIndexCrlf: crlfMatch?.[0].length ?? 0,
    matchedLf: lfMatch !== null,
    matchedCrlf: crlfMatch !== null,
  };
}

/** 真实 Vite SSR 加载器：对给定 root 下的 lf/crlf 夹具做 transform + 求值。 */
export async function observeViteSsrLoad(
  fixtureDir: string,
  labels: readonly string[],
): Promise<{ viteVersion: string; rest: ViteLoadObservation[] }> {
  const viteEntry = resolveViaVitest('vite');
  const vite = (await import(pathToFileURL(viteEntry).href)) as unknown as ViteModuleLike;
  const server = await vite.createServer({
    configFile: false,
    root: fixtureDir,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  const out: ViteLoadObservation[] = [];
  try {
    for (const label of labels) {
      const url = `/${label}.mjs`;
      const obs: ViteLoadObservation = {
        label,
        url,
        transformedHead: '',
        transformedStartsWithShebang: false,
        loaded: false,
        marker: null,
        errorName: null,
        errorMessage: null,
      };
      const res = await server.transformRequest(url, { ssr: true });
      const code = res?.code ?? '';
      obs.transformedHead = code.slice(0, 120);
      obs.transformedStartsWithShebang = code.startsWith('#!');
      try {
        const mod = await server.ssrLoadModule(url);
        obs.loaded = true;
        obs.marker = typeof mod['marker'] === 'string' ? (mod['marker'] as string) : null;
      } catch (err) {
        const e = err as Error;
        obs.errorName = e.constructor.name;
        obs.errorMessage = (e.message.split('\n')[0] ?? '').trim();
      }
      out.push(obs);
    }
  } finally {
    await server.close();
  }
  return { viteVersion: vite.version, rest: out };
}

/** vitest 自己的 mock 提升路径（`@vitest/mocker`）—— 同一正则、同一病灶的另一处。 */
export async function observeMockerHoist(
  labels: readonly { label: string; code: string }[],
): Promise<MockerHoistObservation[]> {
  const viteEntry = resolveViaVitest('vite');
  const vite = (await import(pathToFileURL(viteEntry).href)) as unknown as ViteModuleLike;
  const mockerEntry = resolveViaVitest('@vitest/mocker/dist/node.js');
  const mocker = (await import(pathToFileURL(mockerEntry).href)) as unknown as MockerNodeLike;
  const regex = observeHashbangRegex(mockerEntry, '', '', false);
  const out: MockerHoistObservation[] = [];
  for (const { label, code } of labels) {
    const res = mocker.hoistMocks(code, `fixture-${label}.mjs`, vite.parseAst, {});
    const hoisted = res?.code ?? '';
    out.push({
      label,
      modulePath: mockerEntry,
      literal: regex.literal,
      regexSource: regex.regexSource,
      hoistedStartsWithShebang: hoisted.startsWith('#!'),
      hoistedHead: hoisted.slice(0, 120),
    });
  }
  return out;
}
