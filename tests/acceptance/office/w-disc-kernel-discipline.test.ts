/**
 * **W-DISC：内核纪律的机器化断言**（合同 v1.4 **R50.4** / **R51**）。
 *
 * 把"`src/**` 零文件 IO、零墙钟"从**口头纪律**变成**可失败的断言**——而不是靠 review 时
 * 用肉眼看。合同 R50.4 的原文是：本批唯一允许出现 `node:fs` / `node:child_process` 的位置是
 * **验收侧宿主实现**（`tests/acceptance/office/**`）；`src/**` 保持零文件 IO、零墙钟。
 * 本文件**就在**那个允许出现 `node:fs` 的目录里（它必须读源码文件，这正是"验收侧"的含义）。
 *
 * ## 判据：扫"代码"，不扫"注释"
 *
 * 断言的原始表述是"源码文本不含 X"。直接按裸文本扫会**必然失败**，因为 `src/**` 里本来就
 * 有若干**文档注释**在**声明**这条纪律，例如"本文件不 import `node:fs`"——把纪律写进注释，
 * 反而会被朴素的文本扫描判成违例。注释里的字句不是 IO，也不是墙钟。
 *
 * 因此本测试的判据是：**剥离注释后**的代码文本不含禁用 token。为了让这个豁免本身
 * **可机器复核**而不是黑箱，另有一条断言：**所有原始命中必须落在注释区间内**
 * （见「原始命中全部位于注释内」一例）——若哪天有人在**代码**里写下 `node:fs`，
 * 它不会落在注释内，这条断言会当场变红。
 *
 * ## 防假绿（对照）
 *
 * "全部通过"有两种可能：真的干净，或者**扫描器根本没生效**。故每个方向都有对照：
 * - 正向对照：对一段**自造的、含全部禁用 token 的代码**，扫描器必须**逐个命中**；
 * - 反向对照：同一段内容放进注释，扫描器必须**一个都不报**。
 *
 * 扫描器用 `typescript`（**本仓已有 devDependency，非新增**）的**解析器**取注释区间。
 * 不用 `ts.createScanner`：它是"裸词法扫描"，在本仓 `xlsx.ts` 上会中途失步
 * （漏掉大量注释区间 ⇒ 把注释内容当成代码 ⇒ 假红/假绿）。解析器没有这个问题。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 本文件 = `{root}/tests/acceptance/office/<this>.ts`，故上溯三层即仓库根。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/** 相对仓库根的 POSIX 路径（正斜杠），与既有冻结点记录同口径。 */
function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// 判据常量
// ---------------------------------------------------------------------------

/**
 * 禁用 token（R50.4 / R51）。
 *
 * 带 `(` 的（`Date.now(` 等）是"调用形态"：口径是**不许调用**，注释里写名字不算。
 * `process.pid` / `process.platform` 不带括号，因为二者的**读取**本身就泄露环境信息。
 */
const FORBIDDEN_TOKENS: readonly string[] = Object.freeze([
  'node:fs',
  'node:child_process',
  'node:zlib',
  'Date.now(',
  'new Date(',
  'performance.now(',
  'Math.random(',
  'process.pid',
  'process.platform',
  'toLocaleString',
]);

/** 源码树的文件扩展名（当前 `src/**` 只有 `.ts`；其它扩展名按"不剥注释"处理）。 */
const TYPESCRIPT_EXTENSION = '.ts';
/** 单元测试与被测模块同目录（`src/**`），按任务口径排除。 */
const TEST_FILE_SUFFIX = '.test.ts';

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

interface CommentRange {
  readonly start: number;
  readonly end: number;
}

interface TokenHit {
  readonly token: string;
  /** 在**被扫描文本**中的字符偏移。 */
  readonly index: number;
}

/** 第几行（1 起）——只用于失败信息，不参与判据。 */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * 取出一份 TypeScript 源码里的全部注释区间（行注释与块注释）。
 *
 * 为什么用解析器而不是词法扫描器：注释是**语法树节点的 trivia**，
 * `getLeadingCommentRanges` / `getTrailingCommentRanges` 由解析器给出，
 * 因而正确处理字符串、模板串、正则字面量与 `/` 的二义性。
 */
function collectCommentRanges(fileName: string, text: string): CommentRange[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
  const found: CommentRange[] = [];

  const visit = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      found.push({ start: range.pos, end: range.end });
    }
    for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) {
      found.push({ start: range.pos, end: range.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // 去重并丢弃被前一个区间包含的区间（同一段注释可能同时是前导与后随 trivia）。
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CommentRange[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start < last.end) continue;
    merged.push(range);
  }
  return merged;
}

/**
 * 把注释区间替换成**单个空格**（不用空串：避免把"标识符 + 块注释 + 标识符"
 * 拼成一个连续的标识符，从而**凭空造出**一个原本不存在的 token）。
 */
function stripComments(text: string, ranges: readonly CommentRange[]): string {
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += `${text.slice(cursor, range.start)} `;
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/** 在给定文本里逐个找出全部禁用 token 的出现位置。 */
function findForbiddenTokens(text: string): TokenHit[] {
  const hits: TokenHit[] = [];
  for (const token of FORBIDDEN_TOKENS) {
    let index = text.indexOf(token);
    while (index !== -1) {
      hits.push({ token, index });
      index = text.indexOf(token, index + token.length);
    }
  }
  return hits;
}

/** `import … from 'x'` / `import 'x'` / `export … from 'x'` 的模块说明符。 */
/**
 * 抽出一段代码里的**模块说明符**（`from 'x'` / `import 'x'` / `require('x')`）。
 *
 * ## 为什么必须走 TS 解析器，而不是正则
 *
 * 原实现用 `/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g` 这种**裸正则**，于是
 * `{ capability_id: 'cap.doc.import', label: '导入文档' }` 这类**普通字符串字面量**
 * 会被误判：正则从 `import'` 起匹配，把 `", label: "` 抓成了"包名"——
 * **一个完全合法的对象字面量让"src/** 不 import 任何裸包名"这条断言假红**
 * （FA-B 机器化复现：`captured specifier(s): [", label: "]`）。
 *
 * 正解是**修检测器，不是改产品数据去躲检测器**：把能力名改成不以 `import` 结尾，
 * 等于让数据迁就一个坏正则。本文件头部本就自述"用 `typescript` 的**解析器**取注释区间
 * （不用 `ts.createScanner`，它会失步）"——说明符抽取同样该走解析器。
 */
function importSpecifiers(codeText: string): string[] {
  const source = ts.createSourceFile('scan.ts', codeText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    // `import x from 'y'` / `import 'y'` / `export … from 'y'`
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        specifiers.push(specifier.text);
      }
    }
    // `import x = require('y')`
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression !== undefined && ts.isStringLiteral(expression)) {
        specifiers.push(expression.text);
      }
    }
    // `require('y')` —— 只认**调用表达式**，不认任何字符串字面量。
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteral(first)) specifiers.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return specifiers;
}

// ---------------------------------------------------------------------------
// 源码树遍历
// ---------------------------------------------------------------------------

interface SourceFile {
  readonly path: string;
  readonly absolute: string;
}

/** `src/**` 下全部**非测试**文件（`*.test.ts` 按任务口径排除）。 */
function listSourceFiles(dir: string = SRC_ROOT): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!statSync(absolute).isFile()) continue;
      if (entry.name.endsWith(TEST_FILE_SUFFIX)) continue;
      out.push({ path: repoPath(absolute), absolute });
    }
  };
  walk(dir);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

interface ScannedFile extends SourceFile {
  readonly raw: string;
  /** 剥离注释后的代码文本（非 `.ts` 文件等同于原文）。 */
  readonly code: string;
  readonly comments: readonly CommentRange[];
}

/**
 * 全 `src/**` 的扫描结果**在一次运行内只算一次**（惰性缓存）。
 *
 * `scanAll()` 是文件系统的**只读**函数；本文件的六个用例原各调一次，等于把"读 + TS 解析
 * 全部 src 文件"重复复算六遍——而一次运行内被测源码不会被本目录用例改动。缓存的是**同一份
 * 不变输入的重复复算**，取到的仍是同一结果：`listSourceFiles()` / `collectCommentRanges` /
 * `stripComments` 都不含随机或时钟。
 */
let scanCache: ScannedFile[] | undefined;

function scanAll(): ScannedFile[] {
  scanCache ??= listSourceFiles().map((file) => {
    const raw = readFileSync(file.absolute, 'utf8');
    if (!file.path.endsWith(TYPESCRIPT_EXTENSION)) {
      return { ...file, raw, code: raw, comments: [] };
    }
    const comments = collectCommentRanges(file.path, raw);
    return { ...file, raw, code: stripComments(raw, comments), comments };
  });
  return scanCache;
}

// ---------------------------------------------------------------------------
// 1. 判据：代码文本零禁用 token
// ---------------------------------------------------------------------------

describe('R50.4 内核纪律：src/** 零文件 IO、零墙钟（机器化断言）', () => {
  it('src/**（非测试）的**代码**文本不含任何禁用 token（白名单文件仅豁免 node:fs / node:path）', () => {
    const violations: string[] = [];

    for (const file of scanAll()) {
      for (const hit of findForbiddenTokens(file.code)) {
        // 白名单只豁免**具名文件的具名 IO specifier**；`Date.now()` / `Math.random()` /
        // `process.pid` 这类**非确定性 token 在白名单文件里同样禁止**——
        // 持久 Store 不需要墙钟，而它一旦引入墙钟/随机，整个内核的确定性就更难保。
        if (isAllowedIoAdapter(`${file.path} → ${hit.token}`)) continue;
        violations.push(`${file.path}:${lineOf(file.code, hit.index)} 出现 ${hit.token}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('对照（防假绿）：自造的违例代码 ⇒ 扫描器必须逐个命中', () => {
    const snippet = [
      "import { readFileSync } from 'node:fs';",
      "import { execSync } from 'node:child_process';",
      "import { deflateSync } from 'node:zlib';",
      'const a = Date.now();',
      'const b = new Date();',
      'const c = performance.now();',
      'const d = Math.random();',
      'const e = process.pid;',
      'const f = process.platform;',
      'const g = (1234).toLocaleString();',
    ].join('\n');

    const code = stripComments(snippet, collectCommentRanges('synthetic.ts', snippet));
    const found = new Set(findForbiddenTokens(code).map((hit) => hit.token));

    // "扫描器真的生效"的判据：每个禁用 token 都被这把尺子量到。
    for (const token of FORBIDDEN_TOKENS) {
      expect(found.has(token), `对照失败：扫描器没有命中 ${token}`).toBe(true);
    }
  });

  it('对照（反向）：同样的内容放进注释 ⇒ 一个都不报（注释豁免是**刻意**的）', () => {
    const lines = ["import { readFileSync } from 'node:fs';", 'const a = Date.now();'];
    const commented = [
      ...lines.map((line) => `// ${line}`),
      '/*',
      ...lines,
      '*/',
    ].join('\n');

    const code = stripComments(commented, collectCommentRanges('synthetic.ts', commented));
    expect(findForbiddenTokens(code)).toEqual([]);
  });

  it('原始命中全部位于注释内（豁免本身可复核，而非黑箱）', () => {
    const outsideComments: string[] = [];
    const insideComments: string[] = [];

    for (const file of scanAll()) {
      for (const hit of findForbiddenTokens(file.raw)) {
        const line = lineOf(file.raw, hit.index);
        const inComment = file.comments.some(
          (range) => hit.index >= range.start && hit.index < range.end,
        );
        const location = `${file.path}:${line} → ${hit.token}`;
        if (inComment) insideComments.push(location);
        // **R50.4 的 2026-10-03 修订**：具名 IO 适配器里的 `node:fs` / `node:path` 是放行的，
        // 不算"落在注释外"的违规；其余禁用 token（墙钟 / 随机 / 进程）在白名单文件里同样禁止。
        else if (isAllowedIoAdapter(`${file.path} → ${hit.token}`)) continue;
        else outsideComments.push(location);
      }
    }

    // 代码里的禁用 token 会落在注释外 ⇒ 这条断言是把"零命中"钉死的第二道闸门。
    expect(outsideComments).toEqual([]);

    // 把清单打出来，让"哪些文件因为文档注释而含有这些字符串"变成可审计的事实。
    console.log(
      `[w-disc] src/** 原始命中 ${insideComments.length} 处，全部位于注释内：\n` +
        insideComments.map((entry) => `  - ${entry}`).join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 交互：node:* import 白名单
// ---------------------------------------------------------------------------

/**
 * **允许出现文件系统内建的具名文件**（合同 R50.4 的 **2026-10-03 修订**）。
 *
 * ## 为什么必须开这个口子
 *
 * 老规则「`src/**` 零文件 IO、只允许 `node:crypto`」写于**内核还是纯函数**的阶段。
 * 2026-10-03 用户把范围扩为**完整手机 App + 可恢复的持久后台内核**，而
 * **持久 Store 本质上就需要文件 IO** —— 它不像 raw inflate 那样能用纯 TS 绕开：
 * 没有 `node:fs` 就没有"进程重启后数据还在"。
 *
 * ## 怎么收窄（保住规则的真实意图：内核核心仍然纯净、可确定性复现）
 *
 * 1. **逐个文件具名**，不用目录通配 —— 加一个必须改这个常量，改不动就红；
 * 2. 允许的 specifier 也是**具名小集**（`node:fs` / `node:path`），不是"这个文件随便 import"；
 * 3. **内核核心不得 import 它们**：内核只依赖 `Store` 接口，不依赖介质实现
 *    （见 `src/storage/store-core.ts` 与两个实现）。
 *
 * 现状只有一条：文件介质的 Store 实现。
 */
const IO_ADAPTER_ALLOWLIST: readonly string[] = ['src/storage/file-store.ts'];
const IO_ADAPTER_ALLOWED_SPECIFIERS: readonly string[] = ['node:fs', 'node:path'];

/** 把扫描器给出的路径归一成"仓库相对、无前导斜杠"的形态，避免两种写法造成假红/假绿。 */
function normalizeScanPath(path: string): string {
  return path.split('\\').join('/').replace(/^\/+/, '');
}

function isAllowedIoAdapter(entry: string): boolean {
  const separator = entry.indexOf(' → ');
  if (separator === -1) return false;
  const path = normalizeScanPath(entry.slice(0, separator));
  const specifier = entry.slice(separator + ' → '.length);
  return (
    IO_ADAPTER_ALLOWLIST.some((allowed) => path === allowed || path.endsWith(`/${allowed}`)) &&
    IO_ADAPTER_ALLOWED_SPECIFIERS.includes(specifier)
  );
}

describe('R50.4 交互：src/** 的 node:* import 白名单与运行期依赖', () => {
  it('src/** 的 `node:*` import 只有 `node:crypto`，外加**具名**的 IO 适配器白名单', () => {
    const allSpecifiers: string[] = [];
    const nodeSpecifiers: string[] = [];

    for (const file of scanAll()) {
      for (const specifier of importSpecifiers(file.code)) {
        allSpecifiers.push(specifier);
        if (specifier.startsWith('node:')) nodeSpecifiers.push(`${file.path} → ${specifier}`);
      }
    }

    // 对照：至少确实扫到过东西（否则"全是 node:crypto"会因空集而假绿）。
    expect(allSpecifiers.length).toBeGreaterThan(0);
    expect(nodeSpecifiers.length).toBeGreaterThan(0);

    const offenders = nodeSpecifiers.filter(
      (entry) => !entry.endsWith(' → node:crypto') && !isAllowedIoAdapter(entry),
    );
    expect(offenders).toEqual([]);

    // 白名单本身必须是**具名且最小**的：不得出现通配符 / 目录前缀（防止它悄悄长成"整个目录随便写"）。
    for (const allowed of IO_ADAPTER_ALLOWLIST) {
      expect(allowed.startsWith('src/'), `${allowed} 必须是 src/ 下的仓库相对路径`).toBe(true);
      expect(allowed.includes('*'), `${allowed} 不得含通配符`).toBe(false);
      expect(allowed.endsWith('/'), `${allowed} 不得是目录前缀`).toBe(false);
      expect(allowed.endsWith('.ts'), `${allowed} 必须是具体文件`).toBe(true);
    }
  });

  it('**内核核心不依赖介质实现**：除白名单外，没有任何 src/** 文件 import node:fs', () => {
    // 这条是上一条的**反向对照**：白名单是"放行一个具体文件"，不是"放行这一类 import"。
    const fsImporters = scanAll()
      .filter((file) => importSpecifiers(file.code).includes('node:fs'))
      .map((file) => normalizeScanPath(file.path))
      .filter((path) => !IO_ADAPTER_ALLOWLIST.includes(path));
    expect(fsImporters).toEqual([]);
  });

  it('src/** 不 import 任何裸包名（内核没有运行期依赖）', () => {
    const offenders: string[] = [];

    for (const file of scanAll()) {
      for (const specifier of importSpecifiers(file.code)) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
        if (specifier.startsWith('node:')) continue;
        offenders.push(`${file.path} → ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('package.json 无任何运行期依赖（dependencies / optional / peer 全空）', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;

    // 口径：**运行期**依赖为零。devDependencies 是工具链，不在本条判据内。
    expect(pkg['dependencies'] ?? {}).toEqual({});
    expect(pkg['optionalDependencies'] ?? {}).toEqual({});
    expect(pkg['peerDependencies'] ?? {}).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. ZIP 写入器不 import node:zlib（R51.1）
// ---------------------------------------------------------------------------

describe('R51.1 确定性：ZIP 写入器不用 node:zlib', () => {
  const ZIP_WRITER = 'src/artifacts/ooxml/zip.ts';

  it(`${ZIP_WRITER} 既不 import node:zlib，也没有任何 node:* import`, () => {
    const file = scanAll().find((candidate) => candidate.path === ZIP_WRITER);
    expect(file, `找不到 ${ZIP_WRITER}`).toBeDefined();
    if (file === undefined) return;

    // 对照：这个文件确实被扫到了非空内容。
    expect(file.code.length).toBeGreaterThan(0);

    expect(file.code.includes('node:zlib')).toBe(false);
    // 更强：整个写入器不依赖任何 node 内建模块（deflate 字节随 zlib 版本漂移）。
    expect(importSpecifiers(file.code).filter((s) => s.startsWith('node:'))).toEqual([]);
  });
});
