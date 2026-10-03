/**
 * FA-VERIFY-WAVE-8 · 独立验证方的**源码结构扫描器**（自研，不复用实现方的任何工具）。
 *
 * 本轮怀疑对象：**合并把东西吃掉了**。本文件提供四类可机器判定的探测：
 *
 * 1. `parseDiagnosticsOf` —— TS 语法诊断（抓到"多余的 `}`"/"被截断的 if"这类结构性破坏）；
 * 2. `unusedImportsOf` —— 被 import 但**零引用**的标识符（"handler 只 import 未派发"那一类的近亲）；
 * 3. `orphanCommentsOf` —— **悬空注释块**：一个 `/** … *​/` 之后（跳过空白与其它注释）
 *    紧跟着 `}` 或文件末尾 ⇒ 注释本想标注的那条语句被合并吞掉了；
 * 4. `emptyThenBlocksOf` —— `if (...) {}` 空主体（被吞掉主体的弱信号，供人工复核）。
 *
 * 全部基于 TypeScript 自己的解析器/扫描器（**不改产品代码**，只读）。
 */

import ts from 'typescript';

export interface CommentRange {
  readonly pos: number;
  readonly end: number;
  readonly text: string;
  readonly kind: 'line' | 'block';
}

export interface LexResult {
  readonly comments: readonly CommentRange[];
  /** `{` 减 `}`（字符串 / 模板 / 正则 / 注释内部不计）。0 = 配平。 */
  readonly braceDelta: number;
  readonly parenDelta: number;
  readonly bracketDelta: number;
  /** 过程中出现过"闭多于开"（多余 `}` 的强信号）。 */
  readonly dipped: boolean;
}

/** 这些关键字之后出现的 `/` 是**正则**而不是除号。 */
const KEYWORD_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

/**
 * 自研 tokenizer-lite：一趟扫过源文本，同时产出**注释表**与**分隔符配平**。
 *
 * 为什么不直接用 `ts.createScanner` 裸 `scan()` 循环（独立验证方实测过这个坑）：
 * 那个用法在模板字面量的 `${}` 替换之后不会 `reScanTemplateToken`，于是模板之后的文本
 * 会被当代码继续扫。本仓 `http.ts` 的注释里大量出现 `` `/api/**` `` 这类反引号片段，
 * 正好把裸扫描器带偏——它把 1826 行的一条**行注释**误判成一个横跨 3 行的**块注释**。
 *
 * `/` 的正则 / 除号判定用**上一个 token 能否收尾操作数**的经典启发式；本仓 4 个目标文件
 * 实测配平（见 T2），若将来引入歧义构造（如 `if (x) /re/.test(y)`）会如实报红、交人工复核。
 */
export function lexSource(text: string): LexResult {
  const comments: CommentRange[] = [];
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let dipped = false;
  const n = text.length;
  let i = 0;
  let prevCanEndOperand = false;
  while (i < n) {
    const ch = text[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n' && text[j] !== '\r') j += 1;
      comments.push({ pos: i, end: j, text: text.slice(i, j), kind: 'line' });
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      comments.push({ pos: i, end, text: text.slice(i, end), kind: 'block' });
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(text, i);
      prevCanEndOperand = true;
      continue;
    }
    if (ch === '/') {
      if (!prevCanEndOperand) {
        i = skipRegex(text, i);
        prevCanEndOperand = true;
        continue;
      }
      prevCanEndOperand = false;
      i += 1;
      continue;
    }
    if (ch === '{') {
      brace += 1;
      prevCanEndOperand = false;
      i += 1;
      continue;
    }
    if (ch === '}') {
      brace -= 1;
      if (brace < 0) dipped = true;
      prevCanEndOperand = true;
      i += 1;
      continue;
    }
    if (ch === '(') {
      paren += 1;
      prevCanEndOperand = false;
      i += 1;
      continue;
    }
    if (ch === ')') {
      paren -= 1;
      if (paren < 0) dipped = true;
      prevCanEndOperand = true;
      i += 1;
      continue;
    }
    if (ch === '[') {
      bracket += 1;
      prevCanEndOperand = false;
      i += 1;
      continue;
    }
    if (ch === ']') {
      bracket -= 1;
      if (bracket < 0) dipped = true;
      prevCanEndOperand = true;
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j] ?? '')) j += 1;
      prevCanEndOperand = !KEYWORD_BEFORE_REGEX.has(text.slice(i, j));
      i = j;
      continue;
    }
    prevCanEndOperand = false;
    i += 1;
  }
  return { comments, braceDelta: brace, parenDelta: paren, bracketDelta: bracket, dipped };
}

/** 所有注释。 */
export function commentRangesOf(text: string): readonly CommentRange[] {
  return lexSource(text).comments;
}

/** 分隔符配平报告。 */
export function delimiterBalanceOf(text: string): BalanceReport {
  const { braceDelta, parenDelta, bracketDelta, dipped } = lexSource(text);
  return { braceDelta, parenDelta, bracketDelta, dipped };
}

/** `text[i]` 是一个引号（`'` / `"` / `` ` ``）；返回它之后的下标。 */
function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (quote === '`' && c === '$' && text[j + 1] === '{') {
      j = skipBraceExpression(text, j + 1);
      continue;
    }
    if (quote !== '`' && (c === '\n' || c === '\r')) return j; // 未闭合的普通字符串
    j += 1;
  }
  return n;
}

/** `text[i] === '{'`（模板替换的起始）；返回与它配对的 `}` 之后的下标。 */
function skipBraceExpression(text: string, i: number): number {
  const n = text.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = text[j];
    if (c === '{') {
      depth += 1;
      j += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      j += 1;
      if (depth === 0) return j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      j = skipQuoted(text, j);
      continue;
    }
    if (c === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
      // 模板替换里的注释也一并跳过（不收集——它不在语句位置）
      if (text[j + 1] === '/') {
        while (j < n && text[j] !== '\n' && text[j] !== '\r') j += 1;
      } else {
        const close = text.indexOf('*/', j + 2);
        j = close === -1 ? n : close + 2;
      }
      continue;
    }
    j += 1;
  }
  return n;
}

/** `text[i]` 是一个 `/` 且被判为正则字面量；返回它（含 flags）之后的下标。 */
function skipRegex(text: string, i: number): number {
  const n = text.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = text[j] ?? '';
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n' || c === '\r') return j; // 未闭合：别吞过头
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
    j += 1;
  }
  return n;
}

export interface BalanceReport {
  /** 最终余量（`{` 数减 `}` 数；字符串/注释/模板内不计）。0 = 平衡。 */
  readonly braceDelta: number;
  readonly parenDelta: number;
  readonly bracketDelta: number;
  /** 过程中是否出现"多于闭"的瞬间（多余 `}` 的强信号）。 */
  readonly dipped: boolean;
}

/**
 * **针对本仓"并集解决把 `if` 块主体吞掉"那一次事故的直接探测器**。
 *
 * 事故形态（`ec22773` 修的就是它）：派发写成
 * ```ts
 * if (await handleXlsFactsRequest(...)) {
 *   // ← 主体（`return;`）被吞，`}` 也丢了
 * if (await handleToolLoopRequest(...)) { return; }
 * ```
 * 结果外层 `if` 的 then 块**只剩一个没有 return 的嵌套 if**——**语法合法**，
 * 于是 `tsc` 一声不吭，只有当命中的前缀恰好被外层 if 的守卫条件挡掉时才暴露。
 *
 * 本函数返回"表达式里引用了派发标识符、但 then 块里**没有 return**"的 if 行号。
 */
export function dispatchIfWithoutReturnOf(fileName: string, text: string, identifier: RegExp): readonly number[] {
  const sf = parseSource(fileName, text);
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && identifier.test(node.expression.getText(sf))) {
      const then = node.thenStatement;
      const statements = ts.isBlock(then) ? then.statements : [then];
      const hasReturn = statements.some((stmt) => ts.isReturnStatement(stmt));
      if (!hasReturn) out.push(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 解析一个 TS 源文本。 */
export function parseSource(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
}

/** TS 语法诊断消息（空数组 = 语法结构完好）。 */
export function parseDiagnosticsOf(fileName: string, text: string): readonly string[] {
  const sf = parseSource(fileName, text);
  // createSourceFile 的 parseDiagnostics 不在公开类型里，但运行期存在（TS 自身也这么用）。
  const diagnostics = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

/**
 * 被 import 但**在全文中零引用**的本地名（不含 import 语句自身）。
 *
 * 这正是"多行 replace 因 CRLF 静默失效 ⇒ handler 只 import 未派发"那一类的可机器化探测：
 * 一旦某条 import 后的使用点被吃掉，这个函数就会把那个名字报出来。
 */
export function unusedImportsOf(fileName: string, text: string): readonly string[] {
  const sf = parseSource(fileName, text);
  const importNodes: ts.ImportDeclaration[] = [];
  const imported: { name: string; node: ts.ImportDeclaration }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    importNodes.push(stmt);
    const clause = stmt.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) imported.push({ name: clause.name.text, node: stmt });
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imported.push({ name: element.name.text, node: stmt });
      }
    }
  }
  const used = new Set<string>();
  const inImport = (node: ts.Node): boolean =>
    importNodes.some((decl) => node.getStart() >= decl.getStart() && node.getEnd() <= decl.getEnd());
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !inImport(node)) {
      used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return imported.filter((entry) => !used.has(entry.name)).map((entry) => entry.name);
}

const isTriviaChar = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

/**
 * 悬空注释块：块注释之后（跳过空白与其它注释）紧跟着 `}` 或文件末尾。
 *
 * 判定规则只看**紧随其后的非琐碎字符**，因此合并把注释后面那条语句吞掉时会命中。
 */
export function orphanCommentsOf(fileName: string, text: string): readonly { readonly line: number; readonly text: string }[] {
  const comments = commentRangesOf(text);
  const out: { line: number; text: string }[] = [];
  for (const comment of comments) {
    if (comment.kind !== 'block') continue;
    let index = comment.end;
    // 跳过空白与后续注释
    for (;;) {
      while (index < text.length && isTriviaChar(text[index] ?? '')) index += 1;
      if (text.startsWith('//', index)) {
        const nl = text.indexOf('\n', index);
        index = nl === -1 ? text.length : nl + 1;
        continue;
      }
      if (text.startsWith('/*', index)) {
        const close = text.indexOf('*/', index + 2);
        index = close === -1 ? text.length : close + 2;
        continue;
      }
      break;
    }
    const next = index >= text.length ? '' : (text[index] ?? '');
    if (next === '}' || next === '') {
      const line = text.slice(0, comment.pos).split('\n').length;
      out.push({ line, text: comment.text.split('\n')[0] ?? comment.text });
    }
  }
  return out;
}

/** `if (...) {}` 空主体（`thenStatement` 是空块）——被吞掉主体的弱信号。 */
export function emptyThenBlocksOf(fileName: string, text: string): readonly number[] {
  const sf = parseSource(fileName, text);
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && ts.isBlock(node.thenStatement) && node.thenStatement.statements.length === 0) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      out.push(line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * **只赋值不读取**的 `const` 声明名（含函数作用域）。
 *
 * 针对本轮任务的第 2 条疑点：`const xxxHost / xxxOptions / xxxRoutes` 里有没有
 * "赋值了但从未被读"的——那是"派发被吃掉"留下的另一个痕迹（宿主建好了却没接上）。
 * `noUnusedLocals` 在本仓**未开启**，所以 tsc 不会替我们发现这一类。
 */
export function unusedConstsOf(fileName: string, text: string): readonly string[] {
  const sf = parseSource(fileName, text);
  const names: string[] = [];
  const visitDecls = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visitDecls);
  };
  visitDecls(sf);

  const refCounts = new Map<string, number>();
  const visitRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) refCounts.set(node.text, (refCounts.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, visitRefs);
  };
  visitRefs(sf);

  // 每个声明自身的标识符会贡献 1 次；若注册名只出现 1 次 ⇒ 除声明外零引用。
  return names.filter((name) => (refCounts.get(name) ?? 0) <= 1);
}

/** 从 import 声明里取出「来自本地相对模块」的值导入名（排除 `type`-only）。 */
export function localValueImportsOf(fileName: string, text: string): readonly { readonly name: string; readonly from: string }[] {
  const sf = parseSource(fileName, text);
  const out: { name: string; from: string }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!spec.text.startsWith('.')) continue;
    const clause = stmt.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) out.push({ name: clause.name.text, from: spec.text });
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        out.push({ name: element.name.text, from: spec.text });
      }
    }
  }
  return out;
}

/** 某标识符在**非 import** 位置被**调用**（`name(`）的所有行号。 */
export function callSitesOf(fileName: string, text: string, name: string): readonly number[] {
  const sf = parseSource(fileName, text);
  const importNodes: ts.ImportDeclaration[] = [];
  for (const stmt of sf.statements) if (ts.isImportDeclaration(stmt)) importNodes.push(stmt);
  const inImport = (node: ts.Node): boolean =>
    importNodes.some((decl) => node.getStart() >= decl.getStart() && node.getEnd() <= decl.getEnd());
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name &&
      !inImport(node)
    ) {
      out.push(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
