/**
 * 机器化静态守卫：**只读源码文本**，不起服务、不 import 被扫描模块。
 *
 * ## 为什么需要它（同一条纪律在本批踩过两次）
 *
 * 1. `95e0f45`：`http.ts` 里**import 了** `handleDocumentsRequest` / `handleResearchRequest`，
 *    也**构造了** `documentsHost` / `researchOptions` 两个宿主常量，**却没有在 `handle()` 里派发**。
 *    两个 tsc 全绿（`tsconfig.json` / `tsconfig.demo.json` 都没开 `noUnusedLocals`），
 *    in-process 测试也全绿——**真服务上这两个前缀全是 404**。这是"看起来接线了"的典型形态。
 * 2. 合并 `fa/krn-tool-loop-product` 时，并集解把 `xlsFacts` 那个 `if` 块的 `return; }` 吞掉
 *    ⇒ 语法错。**那一类由 tsc 兜住**；本守卫管的是**语法合法、语义半截**的那一类（第 1 种）。
 *
 * ## 三条规则
 *
 * - **A. 半截接线**：凡是被 import 的 `handle*` 值符号，必须在 `handle()` 函数体里有调用点
 *   （`await <name>(`）。只有 import 没有调用 ⇒ 报红。
 * - **B. 幽灵宿主常量**：`const xxxHost / xxxOptions / xxxRoutes` 若除声明处外在本文件零引用
 *   ⇒ 报红（这正是 `95e0f45` 的形态：宿主造好了，却没人读它）。
 * - **C. `/api/**` 派发覆盖**：**前缀表不再手抄**——每次扫描都从源码现推两份，再互相对表：
 *   - **声明侧**：对 `http.ts` 每一条 `import` 指向的模块，读出它导出的 `/api/...`
 *     的 `*_ROOT` 常量（含嵌套前缀如 `/api/memory/facts`——是否成为独立挂载点，取决于
 *     **http.ts 是否直接 import 该模块**；`adapters-actions.ts` 只被 `adapters-host.ts`
 *     二次 import，不在 http.ts 的 import 表里，因此 `/api/adapters/actions` 不进表，由父前缀覆盖）。
 *   - **派发侧**：在 `handle()` 体里找真实派发调用点（`await handleXxx(` 与 `recv.handle(`），
 *     再把标识符解析回模块——值 `import` 直接命中；`adapters` / `rolesWiring` / `loopRoutes`
 *     这类经由 `const x: T = ...` 的类型标注、或 `options` 解构键在 `DemoHttpOptions` 里的
 *     属性类型，同样解析回模块。
 *   - 两侧必须**一一对上**：声明了却没有任何派发点 ⇒ `mounted-prefix-not-dispatched`
 *     （整片落到 `/api/**` 兜底 404）；派发了却找不到拥有 `/api/<name>` 常量的模块 ⇒
 *     `mounted-prefix-not-owned-by-module`（前缀表与模块不一致）。
 *
 *   因为**没有可忘的登记表**（两侧都从源码现推），"新增路由却忘了登记"在结构上不可能：
 *   新模块一旦被 `import` 进来，声明侧立刻多一条；它若没被派发，规则 C 当场报红。
 *   （旧版是手写 10 条常量表，`fa/verify-wave-8` 的 T5 独立复算量出它漏了 `/api/facts`。）
 *
 * ## 如实记录的边界
 *
 * 1. **只覆盖"独立路由模块 + 顶层 `*_ROOT` 常量"这一类**。`http.ts` **自己实现**的路由
 *    （`/health`、`/api/identity`、`/api/conversations`、`/api/tasks`、`/api/artifacts`、
 *    `/api/sessions`、`/api/deliverables`）不在本规则内：它们的派发标识符是本地函数
 *    （`handleConversationRoute` / `matchConversationRoute` 等），解析不到被 `import` 的模块，
 *    本规则**一律跳过**（不猜、不报），如实记录为"本守卫不覆盖"。
 * 2. 某个模块被派发、但**源码读不出来**（文件搬走 / 改名）⇒ 也跳过：那一类由 `tsc` 兜住，
 *    本守卫不去猜它的前缀。
 * 3. 文本级静态扫描，**不做完整 AST 解析**。注释会被抹平（按字符替换成空格，**行号与偏移保持不变**），
 *    字符串字面量里的 `//` / `/*` 不会被误当成注释（见 `stripComments` 的极小状态机）。
 *    正则字面量中的引号仍可能让状态机走偏——因此扫描结果只用来**申报**，判定护栏仍是 `tsc` 与真机证据。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 被扫描的 HTTP 层文件名（相对 `apps/demo/server/`）。 */
export const HTTP_SERVER_FILE = 'http.ts';

export type FindingKind =
  | 'handle-import-not-dispatched'
  | 'host-constant-never-read'
  | 'mounted-prefix-not-owned-by-module'
  | 'mounted-prefix-not-dispatched';

export interface Finding {
  readonly kind: FindingKind;
  readonly symbol: string;
  readonly message: string;
  /** 1 基行号（在**抹平注释后**的文本上算，与原文件行号一致）。 */
  readonly line: number;
}

/**
 * 抹平注释：`//` 与 `/* *\/` 的字符替换成空格（换行保留），字符串 / 模板字面量原样保留。
 *
 * 为什么要抹：`http.ts` 的文档注释里**提到了** `handleMemoryRequest` / `handleXlsFactsRequest`
 * 这些名字（第 125 / 153 行）。不算行号也不抹注释的话，"只 import 不调用"会被注释里的提及
 * 蒙混过关（假绿）。
 */
export function stripComments(source: string): string {
  const chunks: string[] = [];
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (mode === 'code') {
      if (c === '/' && next === '/') {
        mode = 'line';
        chunks.push('  ');
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        mode = 'block';
        chunks.push('  ');
        i += 2;
        continue;
      }
      if (c === "'") {
        mode = 'single';
      } else if (c === '"') {
        mode = 'double';
      } else if (c === '`') {
        mode = 'template';
      }
      chunks.push(c);
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        chunks.push(c);
      } else {
        chunks.push(' ');
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        chunks.push('  ');
        i += 2;
        continue;
      }
      chunks.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    // single / double / template
    if (c === '\\') {
      chunks.push(c);
      chunks.push(next);
      i += 2;
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (c === closer) {
      mode = 'code';
    }
    chunks.push(c);
    i += 1;
    continue;
  }
  return chunks.join('');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  const end = Math.min(index, source.length);
  for (let i = 0; i < end; i += 1) {
    if (source.charAt(i) === '\n') {
      line += 1;
    }
  }
  return line;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 取 `handle()` 函数体的文本（从 `const handle = async` 起，到文件末）。
 *
 * 末尾多带了 `return (req, res) => {...}` 的包装层——这不影响正确性：那层里没有任何
 * 路由派发，多出来的文本只会让"调用点"更容易被找到（偏向**不漏报**）。找不到 `const handle`
 * 时退回全文并如实让调用方知道（返回 `null`）。
 */
export function handleFunctionBody(source: string): string | null {
  const index = source.indexOf('const handle = async');
  return index === -1 ? null : source.slice(index);
}

export interface ValueImport {
  readonly name: string;
  readonly specifier: string;
  readonly index: number;
}

/** 抽出**值** import 的标识符（`import type {...}` 与子句里的 `type X` 一律不算值）。 */
export function extractValueImports(source: string): ValueImport[] {
  const re = /import\s+(type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  const found: ValueImport[] = [];
  let match = re.exec(source);
  while (match !== null) {
    const statementIsType = match[1] !== undefined;
    const clause = match[2] ?? '';
    const specifier = match[3] ?? '';
    for (const rawItem of clause.split(',')) {
      const item = rawItem.trim();
      if (item === '') {
        continue;
      }
      const itemIsType = statementIsType || /^type\s/.test(item);
      const nameMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(item);
      const name = nameMatch === null ? null : (nameMatch[1] ?? null);
      if (name !== null && !itemIsType) {
        found.push({ name, specifier, index: match.index });
      }
    }
    match = re.exec(source);
  }
  return found;
}

/**
 * 规则 A：被 import 的 `handle*` 值符号必须在 `handle()` 里有 `await <name>(` 调用点。
 *
 * 只看 `handle` 前缀的符号，不做"通用未使用 import"检查——`http.ts` 里存在与路由无关的
 * 未使用 import（如 `CONVERSATION_LIMITS`），把守卫做成通用 unused-import 检查会让真实文件
 * 长期报红，反而失去信号。本条只钉住"整段路由没接上"这一种致命形态。
 */
export function findHandleImportsNotDispatched(source: string): Finding[] {
  const stripped = stripComments(source);
  const body = handleFunctionBody(stripped) ?? stripped;
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const imported of extractValueImports(stripped)) {
    if (!/^handle[A-Z]/.test(imported.name) || seen.has(imported.name)) {
      continue;
    }
    seen.add(imported.name);
    const call = new RegExp(`\\bawait\\s+${escapeRe(imported.name)}\\s*\\(`);
    if (!call.test(body)) {
      findings.push({
        kind: 'handle-import-not-dispatched',
        symbol: imported.name,
        line: lineOf(stripped, imported.index),
        message:
          `import 了 ${imported.name}（来自 ${imported.specifier}），` +
          `但 handle() 里找不到 \`await ${imported.name}(\` 调用点：真服务上这一段会整片 404`,
      });
    }
  }
  return findings;
}

/** 规则 B 的候选名形态：`xxxHost` / `xxxOptions` / `xxxRoutes`。 */
const HOST_CONST_DECL = /\b(?:const|let)\s+([A-Za-z_$][\w$]*(?:Host|Options|Routes))\s*[:=]/g;

/**
 * 规则 B：`const xxxHost / xxxOptions / xxxRoutes` 若除声明处外**零引用** ⇒ 报红。
 *
 * 这条钉的是 `95e0f45` 的形态：宿主常量造出来了（`documentsHost` / `researchOptions`），
 * 但没有任何路由读它——说明派发那一半被合并 / 编辑弄丢了。
 */
export function findUnreadHostConstants(source: string): Finding[] {
  const stripped = stripComments(source);
  const findings: Finding[] = [];
  const re = new RegExp(HOST_CONST_DECL.source, 'g');
  let match = re.exec(stripped);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) {
      const uses = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
      const count = (stripped.match(uses) ?? []).length;
      if (count <= 1) {
        findings.push({
          kind: 'host-constant-never-read',
          symbol: name,
          line: lineOf(stripped, match.index),
          message:
            `const ${name} 只被赋值、全文件再无读取点：` +
            '宿主造好了却没人用它（95e0f45 的"半截接线"形态）',
        });
      }
    }
    match = re.exec(stripped);
  }
  return findings;
}

/** 读路由模块源码（静态读文本即可，不需要也不应该 import 它们）。 */
export type ModuleSourceReader = (moduleFile: string) => string;

/**
 * 根前缀的 `*_ROOT` 声明：`export const DOCUMENTS_ROOT = '/api/documents'`。
 *
 * 也收**嵌套**前缀（`/api/memory/facts`、`/api/adapters/actions`）：前缀段只允许
 * `[A-Za-z0-9_-]`，因此不会吞掉尾随 `/`，也不会把 `'/api/x' + y` 之类的拼接误当字面量。
 *
 * 为什么收嵌套：真值取决于 **http.ts 是否直接 import 该模块**——
 * - `trace-fact-versions.ts`（`FACT_VERSIONS_ROOT = '/api/memory/facts'`）**被 http.ts 直接 import 并转交**，
 *   它是 `/api/memory/facts` 这个挂载点的真拥有者（父模块 `memory-routes.ts` 对这条路径
 *   `matchMemoryRoute` 返回 `null`）。原先只收顶层前缀，导致这条合法派发被误报
 *   `mounted-prefix-not-owned-by-module`；
 * - `adapters-actions.ts` / `adapters-extra-routes.ts` 只被 `adapters-host.ts` 二次 import，
 *   **不在** http.ts 的 import 表里，因此它们的前缀本来就不会进表（由父前缀 `/api/adapters` 覆盖）。
 */
const ROOT_DECL = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*'(\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)'/g;

export interface RootDeclaration {
  /** `/api/<name>` 或 `/api/<a>/<b>` 前缀（不含尾随 `/`）。 */
  readonly prefix: string;
  /** 声明它的 `*_ROOT` 常量名。 */
  readonly rootConstant: string;
}

/**
 * 从模块源码里抽出它导出的 `/api/...` 根前缀常量（含嵌套前缀，见 `ROOT_DECL` 的说明）。
 *
 * 是否构成 http.ts 的独立挂载点，由调用方按"该模块是否被 http.ts 直接 import"判定，
 * 本函数只负责把模块声明的前缀**如实**读出来。
 */
export function findTopLevelRootDeclarations(moduleSource: string): RootDeclaration[] {
  const re = new RegExp(ROOT_DECL.source, 'g');
  const found: RootDeclaration[] = [];
  let match = re.exec(moduleSource);
  while (match !== null) {
    const rootConstant = match[1];
    const prefix = match[2];
    if (rootConstant !== undefined && prefix !== undefined) {
      found.push({ prefix, rootConstant });
    }
    match = re.exec(moduleSource);
  }
  return found;
}

/** `http.ts` 里被 import 的一个模块（值 import 与 `import type` 都收，归一化成 `.ts` 相对路径）。 */
export interface ImportedModule {
  /** 归一化后的相对路径（`./facts-routes.js` ⇒ `facts-routes.ts`）。 */
  readonly moduleFile: string;
  /** import 语句在**抹平注释后**源码里的偏移（算行号用）。 */
  readonly index: number;
  /** 该模块在本文件里被引入的标识符（含 `type X` / `import type {X}`）。 */
  readonly names: readonly string[];
}

function normalizeModuleSpecifier(specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return null;
  }
  // `./facts-routes.js` ⇒ `facts-routes.ts`（去掉同目录的 `./`，保留 `../` 上行路径）。
  const withoutCurrentDir = specifier.startsWith('./') ? specifier.slice(2) : specifier;
  return withoutCurrentDir.endsWith('.js') ? `${withoutCurrentDir.slice(0, -3)}.ts` : withoutCurrentDir;
}

/**
 * 抽出 `http.ts` 里所有**相对路径 import** 的模块及标识符。
 *
 * 只收 `{ ... }` 具名子句（本文件与各路由模块都用具名 import）；默认导入 / 命名空间
 * `* as ns` 若将来出现也不影响：那种写法下解析不到标识符 ⇒ 本规则跳过，不误报。
 */
export function extractImportedModules(source: string): ImportedModule[] {
  const stripped = stripComments(source);
  const re = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  const byModule = new Map<string, { index: number; names: string[] }>();
  let match = re.exec(stripped);
  while (match !== null) {
    const moduleFile = normalizeModuleSpecifier(match[2] ?? '');
    if (moduleFile !== null) {
      const existing = byModule.get(moduleFile);
      const names = existing?.names ?? [];
      for (const rawItem of (match[1] ?? '').split(',')) {
        const item = rawItem.trim();
        if (item === '') {
          continue;
        }
        const nameMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(item);
        const name = nameMatch === null ? null : (nameMatch[1] ?? null);
        if (name !== null && !names.includes(name)) {
          names.push(name);
        }
      }
      byModule.set(moduleFile, { index: existing?.index ?? match.index, names });
    }
    match = re.exec(stripped);
  }
  return [...byModule.entries()].map(([moduleFile, value]) => ({
    moduleFile,
    index: value.index,
    names: value.names,
  }));
}

/** 把一段类型文本切成标识符，用来判断它是否引用了某个被 import 的符号。 */
function identifiersIn(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/**
 * 解析"本地变量 ⇒ 它承载的路由模块"。
 *
 * 两条通道（覆盖 `http.ts` 里三种非 `handle*` 的派发对象）：
 * - `const loopRoutes: ConversationLoopRoutes = ...`：类型标注里的符号若是 import 来的，
 *   就把变量归属到该模块（`loopRoutes` / `sessionAdaptersRoutes` / `krnBarrelRoutes`）；
 * - `const { adapters = null, rolesWiring = null } = options;`：解构键去 `DemoHttpOptions`
 *   接口里取属性类型（`AdaptersHost | null` / `ReturnType<typeof createRolesWiring> | null`），
 *   类型里出现的 import 符号同样把键归属到模块（`adapters` / `rolesWiring`）。
 */
export function resolveLocalVariableModules(
  source: string,
  symbolModules: ReadonlyMap<string, string>,
): Map<string, string> {
  const stripped = stripComments(source);
  const resolved = new Map<string, string>();
  const attribute = (name: string, typeText: string): void => {
    for (const token of identifiersIn(typeText)) {
      const moduleFile = symbolModules.get(token);
      if (moduleFile !== undefined && !resolved.has(name)) {
        resolved.set(name, moduleFile);
        return;
      }
    }
  };

  const typedConst = /(?:const|let)\s+([a-z_$][\w$]*)\s*:\s*([^=;\n]+?)\s*=/g;
  let match = typedConst.exec(stripped);
  while (match !== null) {
    const name = match[1];
    const typeText = match[2];
    if (name !== undefined && typeText !== undefined) {
      attribute(name, typeText);
    }
    match = typedConst.exec(stripped);
  }

  const interfaceMatch = /\bexport\s+interface\s+DemoHttpOptions\s*\{([\s\S]*?)\n\}/.exec(stripped);
  const optionsBlock = interfaceMatch === null ? null : (interfaceMatch[1] ?? null);
  const destructure = /const\s*\{([^}]*)\}\s*=\s*options\s*;/.exec(stripped);
  if (optionsBlock !== null && destructure !== null) {
    for (const rawKey of (destructure[1] ?? '').split(',')) {
      const key = rawKey.split('=')[0]?.trim() ?? '';
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
        continue;
      }
      const prop = new RegExp(`(?:readonly\\s+)?${escapeRe(key)}\\s*\\??\\s*:\\s*([^;]+);`).exec(optionsBlock);
      const typeText = prop === null ? null : (prop[1] ?? null);
      if (typeText !== null) {
        attribute(key, typeText);
      }
    }
  }
  return resolved;
}

/** `handle()` 体里一处**派发调用点**。 */
export interface DispatchSite {
  /** 调用标识符：`handleFactsRequest` 或接收者 `loopRoutes`。 */
  readonly identifier: string;
  /** `true` = `recv.handle(...)`；`false` = `handleXxx(...)`。 */
  readonly receiver: boolean;
  /** 人类可读的派发行形态。 */
  readonly label: string;
  /** 1 基行号。 */
  readonly line: number;
}

/**
 * 在 `handle()` 体里找派发调用点。只有两种形态算**派发**：
 * `await <handleXxx>(`（转交独立路由模块）与 `<recv>.handle(`（转交"线束"对象）。
 *
 * 故意不做的：不把 `sendJson(` / `readBody(` 这类本地辅助、也不把 `taskCompletionOf(` 这类
 * 非路由的 import 当派发——它们解析不到"拥有 `/api/<name>` 常量的模块"，会被上层直接丢弃。
 */
export function extractDispatchSites(strippedSource: string, bodyOffset: number): DispatchSite[] {
  const body = strippedSource.slice(bodyOffset);
  const sites: DispatchSite[] = [];
  const direct = /\b(handle[A-Z][\w$]*)\s*\(/g;
  let match = direct.exec(body);
  while (match !== null) {
    const identifier = match[1];
    if (identifier !== undefined) {
      sites.push({ identifier, receiver: false, label: `await ${identifier}(`, line: lineOf(strippedSource, bodyOffset + match.index) });
    }
    match = direct.exec(body);
  }
  const receiver = /\b([a-z_$][\w$]*)\s*\.\s*handle\s*\(/g;
  match = receiver.exec(body);
  while (match !== null) {
    const identifier = match[1];
    if (identifier !== undefined) {
      sites.push({ identifier, receiver: true, label: `${identifier}.handle(`, line: lineOf(strippedSource, bodyOffset + match.index) });
    }
    match = receiver.exec(body);
  }
  return sites;
}

/** 一条"声明侧"前缀（由某个被 import 的模块用 `*_ROOT` 声明）。 */
export interface MountedPrefix {
  /** 顶层前缀字面量。 */
  readonly prefix: string;
  /** 拥有该前缀的路由模块（相对 `apps/demo/server/`）。 */
  readonly moduleFile: string;
  /** 该模块里声明前缀的 `*_ROOT` 常量名。 */
  readonly rootConstant: string;
  /** `http.ts` 里解析出的派发行形态；该模块**没有任何派发点**时为 `null`。 */
  readonly dispatch: RegExp | null;
  /** 报红时给运维看的人类可读派发行；无派发点时为 `null`。 */
  readonly dispatchLabel: string | null;
  /** 解析到该模块的派发标识符（人类排查用）。 */
  readonly dispatchedBy: readonly string[];
  /** 该模块 import 语句的行号。 */
  readonly importLine: number;
}

/** 派发了、但对应模块没有顶层 `/api/<name>` 常量的调用点（前缀表与模块不一致）。 */
export interface UnownedDispatch {
  readonly identifier: string;
  readonly moduleFile: string;
  readonly label: string;
  readonly line: number;
}

/** 规则 C 的两侧现推结果。 */
export interface DerivedPrefixTable {
  readonly prefixes: readonly MountedPrefix[];
  readonly unownedDispatches: readonly UnownedDispatch[];
}

function buildDispatchRegex(sites: readonly DispatchSite[]): RegExp {
  const patterns = sites.map((site) =>
    site.receiver
      ? `\\b${escapeRe(site.identifier)}\\s*\\.\\s*handle\\s*\\(`
      : `\\b(?:await\\s+)?${escapeRe(site.identifier)}\\s*\\(`,
  );
  return new RegExp(patterns.join('|'));
}

/**
 * 规则 C 的**现推**：从 `httpSource` 与各路由模块源码，推出"声明侧"前缀表与"派发侧"调用点。
 *
 * 关键点：**没有任何手写前缀表**。前缀来自模块导出的 `*_ROOT` 常量，模块来自 `http.ts` 的
 * `import`；派发点来自 `handle()` 体。因此新增路由模块会被自动纳入，忘不掉。
 */
export function deriveMountedPrefixes(
  httpSource: string,
  readModuleSource: ModuleSourceReader,
): DerivedPrefixTable {
  const stripped = stripComments(httpSource);
  const bodyIndex = stripped.indexOf('const handle = async');
  const bodyOffset = bodyIndex === -1 ? 0 : bodyIndex;

  const modules = extractImportedModules(stripped);
  const symbolModules = new Map<string, string>();
  for (const imported of modules) {
    for (const name of imported.names) {
      if (!symbolModules.has(name)) {
        symbolModules.set(name, imported.moduleFile);
      }
    }
  }
  const localVariables = resolveLocalVariableModules(stripped, symbolModules);

  /** 归属得上的派发点（解析不到模块的本地函数调用不在此列）。 */
  const ownedSites: { readonly site: DispatchSite; readonly moduleFile: string }[] = [];
  for (const site of extractDispatchSites(stripped, bodyOffset)) {
    const moduleFile = symbolModules.get(site.identifier) ?? localVariables.get(site.identifier);
    if (moduleFile !== undefined) {
      ownedSites.push({ site, moduleFile });
    }
  }

  const moduleSources = new Map<string, string | null>();
  const readModule = (moduleFile: string): string | null => {
    if (moduleSources.has(moduleFile)) {
      return moduleSources.get(moduleFile) ?? null;
    }
    let text: string | null;
    try {
      text = readModuleSource(moduleFile);
    } catch {
      text = null;
    }
    moduleSources.set(moduleFile, text);
    return text;
  };

  const rootsByModule = new Map<string, RootDeclaration[]>();
  for (const imported of modules) {
    const text = readModule(imported.moduleFile);
    if (text === null) {
      continue;
    }
    const roots = findTopLevelRootDeclarations(text);
    if (roots.length > 0) {
      rootsByModule.set(imported.moduleFile, roots);
    }
  }

  const prefixes: MountedPrefix[] = [];
  for (const [moduleFile, roots] of rootsByModule) {
    const imported = modules.find((entry) => entry.moduleFile === moduleFile);
    const sites = ownedSites.filter((entry) => entry.moduleFile === moduleFile).map((entry) => entry.site);
    for (const root of roots) {
      prefixes.push({
        prefix: root.prefix,
        moduleFile,
        rootConstant: root.rootConstant,
        dispatch: sites.length === 0 ? null : buildDispatchRegex(sites),
        dispatchLabel: sites.length === 0 ? null : sites.map((site) => site.label).join(' | '),
        dispatchedBy: sites.map((site) => site.label),
        importLine: imported === undefined ? 1 : lineOf(stripped, imported.index),
      });
    }
  }
  prefixes.sort((a, b) => a.prefix.localeCompare(b.prefix));

  const unownedDispatches: UnownedDispatch[] = [];
  for (const { site, moduleFile } of ownedSites) {
    if (rootsByModule.has(moduleFile) || (moduleSources.get(moduleFile) ?? null) === null) {
      continue;
    }
    unownedDispatches.push({
      identifier: site.identifier,
      moduleFile,
      label: site.label,
      line: site.line,
    });
  }

  return { prefixes, unownedDispatches };
}

/**
 * 规则 C：**声明侧**与**派发侧**必须一一对上。
 *
 * - 声明了却没派发（整片落 `/api/**` 兜底 404）⇒ `mounted-prefix-not-dispatched`；
 * - 派发了却没有拥有该前缀的模块（前缀表与模块不一致）⇒ `mounted-prefix-not-owned-by-module`。
 */
export function findMissingMountedPrefixes(httpSource: string, readModuleSource: ModuleSourceReader): Finding[] {
  const stripped = stripComments(httpSource);
  const bodyIndex = stripped.indexOf('const handle = async');
  const body = bodyIndex === -1 ? stripped : stripped.slice(bodyIndex);
  const fallbackIndex = stripped.indexOf("pathname.startsWith('/api/')");
  const fallbackLine = fallbackIndex === -1 ? 1 : lineOf(stripped, fallbackIndex);
  const derived = deriveMountedPrefixes(httpSource, readModuleSource);
  const findings: Finding[] = [];
  for (const entry of derived.prefixes) {
    if (entry.dispatch !== null && entry.dispatch.test(body)) {
      continue;
    }
    findings.push({
      kind: 'mounted-prefix-not-dispatched',
      symbol: entry.prefix,
      line: entry.importLine === 1 ? fallbackLine : entry.importLine,
      message:
        `前缀 ${entry.prefix} 由 ${entry.moduleFile}（${entry.rootConstant}）声明并被 http.ts import，` +
        `但 handle() 里解析不到它的派发点` +
        (entry.dispatchLabel === null ? '' : `（期望形态：${entry.dispatchLabel}）`) +
        '：真服务会落到 /api/** 兜底 404',
    });
  }
  for (const unowned of derived.unownedDispatches) {
    findings.push({
      kind: 'mounted-prefix-not-owned-by-module',
      symbol: unowned.identifier,
      line: unowned.line,
      message:
        `handle() 里在派发 \`${unowned.label}\`（来自 ${unowned.moduleFile}），` +
        `但该模块没有导出顶层 \`/api/<name>\` 的 \`*_ROOT\` 常量：` +
        '派发与模块的前缀声明对不上（前缀表与模块不一致），守卫无法把它纳入覆盖',
    });
  }
  return findings;
}

export interface ScanOptions {
  /** 是否执行规则 C。合成样例可关掉它，只验规则 A / B。默认 `true`。 */
  readonly checkMountedPrefixes?: boolean;
}

/** 三条规则的合体。返回空数组 = 绿。 */
export function scanHttpSource(
  source: string,
  readModuleSource: ModuleSourceReader,
  options: ScanOptions = {},
): Finding[] {
  const findings = [...findHandleImportsNotDispatched(source), ...findUnreadHostConstants(source)];
  if (options.checkMountedPrefixes !== false) {
    findings.push(...findMissingMountedPrefixes(source, readModuleSource));
  }
  return findings;
}

/** 从 `apps/demo/server/` 目录读模块源码的现成 reader。 */
export function createWorkspaceModuleReader(serverDir: string): ModuleSourceReader {
  return (moduleFile: string): string => readFileSync(join(serverDir, moduleFile), 'utf8');
}

/** 人类可读的报红行（测试与人工排查共用同一格式）。 */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  [${f.kind}] ${f.symbol} @ line ${String(f.line)}: ${f.message}`).join('\n');
}
