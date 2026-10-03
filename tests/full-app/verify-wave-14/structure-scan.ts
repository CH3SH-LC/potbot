/**
 * FA-VERIFY-WAVE-14 · 结构扫描器（**纯函数，只读文本**）。
 *
 * 本批协调者在合并时反复踩同一个坑：**冲突按"并集"手解**，把代码块的一半吃掉、
 * 或让一段 jsdoc 与其声明分家。tsc 不一定报错（吃掉的可能是**注释**、或结果是合法语法），
 * 单元测试也不一定报错（被吃的分支可能本来就没被覆盖）。本扫描器专盯这类"**语法合法、
 * 结构半截**"的残留：
 *
 * 三类判据（每类都有"能变红"的判别力，见 T2 的合成反例）：
 *
 * 1. `decapitated-block`：`if (...) {` / `for (...) {` 之类的**块首行**，其后第一条实质
 *    语句就是 `}`（中间只剩注释/空行）——并集解把块体整段吃掉，只剩一对空壳大括号。
 * 2. `orphan-jsdoc`：一段**完整**的 `/** ... *\/` 单行 jsdoc，紧跟着又开一段 `/**`。
 *    这是"新声明连注释一起插进了某个 jsdoc 与它声明之间"的指纹——前一段注释从此悬空。
 * 3. `orphan-jsdoc-continuation`：一行 ` * ...`（或 ` *\/`）的上一行**既不是** `/**`、
 *    也**不是** ` *` 续行——块注释的开口行被吃掉了，续行主语丢失。
 *
 * 另加一条与"结构完整性"直接相关的：`unbalanced-brace`（全文件大括号不平衡；
 * 字符串 / 模板 / 正则里的括号已被遮罩掉，不误算）。
 *
 * ## 如实记录的边界
 *
 * - **文本级**扫描，不做完整 AST / 不做正则字面量的精确判定：正则字面量里的引号可能让
 *   遮罩状态机走偏（与 `route-dispatch-scan.ts` 同一条已记录的边界）。因此本扫描器
 *   只用于**申报**，最终判定仍以 tsc 与真机证据为准。
 * - 遮罩函数**保持行号与偏移不变**（注释 / 字符串体替换成空格，换行保留），因此报出的
 *   行号可直接 `sed -n` 复查。
 */

/** 结构扫描的一条发现。 */
export interface StructuralFinding {
  readonly kind: StructuralFindingKind;
  /** 1 基行号（在原文上）。 */
  readonly line: number;
  readonly detail: string;
}

export type StructuralFindingKind =
  | 'decapitated-block'
  | 'orphan-jsdoc'
  | 'orphan-jsdoc-continuation'
  | 'unbalanced-brace';

/**
 * 把**注释体与字符串 / 模板体**替换成空格（换行保留、偏移与行号不变）。
 *
 * 与 `route-dispatch-scan.ts` 的 `stripComments` 的关键差别：本函数**连注释一起抹平**
 * （包括注释的 `/**` 定界符），因为"空壳块"判定只看**代码**。jsdoc 相关的判定走原文。
 */
export function maskCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' = 'code';
  let lastSignificant = '\n';
  let inCharClass = false;
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (mode === 'code') {
      if (c === '/' && next === '/') {
        mode = 'line';
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        mode = 'block';
        out.push('  ');
        i += 2;
        continue;
      }
      // 正则字面量：`/` 处于"值位置"（前一显著字符是运算符 / 分隔符）时开始一段正则。
      // 不识别它的话，`/"/g` 里的 `"` 会被误当成双引号串开头，把后面几十行吞进"字符串"。
      if (c === '/' && isRegexPosition(lastSignificant)) {
        mode = 'regex';
        inCharClass = false;
        out.push(' ');
        i += 1;
        continue;
      }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      if (c !== ' ' && c !== '\t' && c !== '\r') {
        lastSignificant = c;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out.push('\n');
      } else {
        out.push(' ');
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        out.push('  ');
        i += 2;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (c === '\\') {
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === '[') inCharClass = true;
      else if (c === ']') inCharClass = false;
      else if (c === '/' && !inCharClass) {
        mode = 'code';
        lastSignificant = '/';
        out.push(' ');
        i += 1;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      i += 1;
      continue;
    }
    // single / double / template：整体替换成空格，但换行保留（模板可跨行）。
    if (c === '\\') {
      out.push(' ');
      out.push(next === '\n' ? '\n' : ' ');
      i += 2;
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (c === closer) {
      mode = 'code';
      lastSignificant = closer;
      out.push(' ');
      i += 1;
      continue;
    }
    out.push(c === '\n' ? '\n' : ' ');
    i += 1;
    continue;
  }
  return out.join('');
}

/** 正则字面量可以出现的"值位置"：前一显著字符是这些符号之一（或行首）。 */
function isRegexPosition(previous: string): boolean {
  return '([{,;:=!&|?+-*%^~<>'.includes(previous) || previous === '\n';
}

/** 块首行的形态：`<关键字> ... {` 且 `{` 是行尾（中间不含 `;`，避免误判单行语句）。 */
const BLOCK_HEAD =
  /^\s*(?:\}\s*)?(?:if|for|while|switch|else|try|catch|finally|do)\b[^;{}]*\{\s*$/;
/** 纯闭括号行。 */
const CLOSE_ONLY = /^\s*\}\s*;?\s*$/;
/** jsdoc 续行或收尾行（行首是 `*`）。 */
const COMMENT_CONTINUATION = /^\s*\*/;
/** 某一行的上一行"属于注释"的形态：`/*` / `/**` 开口，或 `*` 续行。 */
const PREVIOUS_IS_COMMENT_LINE = (line: string): boolean =>
  /^\s*\/\*/.test(line) || /^\s*\*/.test(line);

/**
 * 判据 1：空壳块 —— 块首行之后第一条**原始非空行**就是 `}`。
 *
 * 用**原始行**（不是抹平后的行）判"中间有没有东西"：只含注释的 `} catch { // ... }`
 * 是**合法且常见**的写法，不该报红。真正的并集残留是"块体连注释一起被吃掉，
 * `{` 与 `}` 之间干干净净"——那才报。
 */
export function findDecapitatedBlocks(source: string): StructuralFinding[] {
  const masked = maskCommentsAndStrings(source);
  const maskedLines = masked.split('\n');
  const rawLines = source.split('\n');
  const findings: StructuralFinding[] = [];
  for (let i = 0; i < maskedLines.length; i += 1) {
    const line = maskedLines[i] ?? '';
    if (!BLOCK_HEAD.test(line)) {
      continue;
    }
    // 下一条**原始**非空行（注释行也算"有东西"）。
    let j = i + 1;
    while (j < rawLines.length && (rawLines[j] ?? '').trim() === '') {
      j += 1;
    }
    const afterRaw = (rawLines[j] ?? '').trim();
    if (CLOSE_ONLY.test(afterRaw)) {
      findings.push({
        kind: 'decapitated-block',
        line: i + 1,
        detail:
          `块首行 \`${(rawLines[i] ?? '').trim()}\` 之后第 ${String(j + 1)} 行直接就是 \`${afterRaw}\`：` +
          '块体为空（连注释都没有）——并集解只留下了壳',
      });
    }
  }
  return findings;
}

/** 判据 2 / 3：孤儿 jsdoc（悬空的注释块 / 丢失开口的续行）。 */
export function findOrphanJsdoc(source: string): StructuralFinding[] {
  const lines = source.split('\n');
  const findings: StructuralFinding[] = [];

  // 判据 2：一段**完整的块注释**（`/** ... */`，含单行与多行）之后，紧跟着**又开一段块注释**，
  // 中间没有任何代码 —— 说明前一段注释的"声明"要么被吃掉了、要么被别的东西插到中间去了。
  // 这是并集合并最典型的残留形态（本批在 `http.ts` / `main.ts` 各留了一处）。
  for (const block of blockComments(source)) {
    let next = block.closeLine + 1; // 0 基：从"闭括号所在行的下一行"开始找
    while (next < lines.length && (lines[next] ?? '').trim() === '') {
      next += 1;
    }
    const follow = lines[next] ?? '';
    if (/^\s*\/\*/.test(follow)) {
      findings.push({
        kind: 'orphan-jsdoc',
        line: block.openLine + 1,
        detail:
          `第 ${String(block.openLine + 1)}–${String(block.closeLine + 1)} 行是一段完整块注释，` +
          `紧接着第 ${String(next + 1)} 行（\`${follow.trim().slice(0, 40)}\`）又开一段注释：` +
          '中间没有任何声明 ⇒ 前一段 jsdoc 与它的声明分家（典型并集残留）',
      });
    }
  }

  // 判据 3：` * ...` / ` */` 续行的上一非空行不是注释 ⇒ 块注释开口行被吃掉。
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!COMMENT_CONTINUATION.test(line)) {
      continue;
    }
    let p = i - 1;
    while (p >= 0 && (lines[p] ?? '').trim() === '') {
      p -= 1;
    }
    const previous = p < 0 ? '' : (lines[p] ?? '');
    if (!PREVIOUS_IS_COMMENT_LINE(previous)) {
      findings.push({
        kind: 'orphan-jsdoc-continuation',
        line: i + 1,
        detail:
          `第 ${String(i + 1)} 行（\`${line.trim()}\`）是 jsdoc 续行，` +
          `但上一非空行（第 ${String(p + 1)} 行）不是注释：\`${previous.trim()}\` —— 注释开口行被吃掉了`,
      });
    }
  }
  return findings;
}

/** 一段块注释在源码里的起止（0 基行号）。 */
interface BlockComment {
  readonly openLine: number;
  readonly closeLine: number;
}

/**
 * 列出所有 `/* ... *\/` 块注释的起止行。
 *
 * 文本级配对（先 `/*` 后最近的 `*\/`）：对本仓库的源码足够，且**与 T2 的合成反例**一起
 * 保证了判别力。边界如实记录：字符串 / 模板里若出现 `/*` 会被误配（本文件的两个目标
 * 文件里没有这种形态）。
 */
export function blockComments(source: string): BlockComment[] {
  const found: BlockComment[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('/*', cursor);
    if (open === -1) break;
    const close = source.indexOf('*/', open + 2);
    if (close === -1) break;
    found.push({ openLine: lineIndexOf(source, open), closeLine: lineIndexOf(source, close) });
    cursor = close + 2;
  }
  return found;
}

function lineIndexOf(source: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charAt(i) === '\n') line += 1;
  }
  return line;
}

/** 判据 4：全文件大括号不平衡（抹掉注释与字符串后计数）。 */
export function findUnbalancedBraces(source: string): StructuralFinding[] {
  const masked = maskCommentsAndStrings(source);
  let depth = 0;
  let minDepth = 0;
  let firstNegativeLine = -1;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked.charAt(i);
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth < minDepth) {
        minDepth = depth;
        if (firstNegativeLine === -1) {
          firstNegativeLine = countLines(masked, i);
        }
      }
    }
  }
  if (depth !== 0) {
    return [
      {
        kind: 'unbalanced-brace',
        line: firstNegativeLine === -1 ? 1 : firstNegativeLine,
        detail: `大括号净深度 ${String(depth)}（应为 0）：结构不闭合或被多闭合`,
      },
    ];
  }
  return [];
}

function countLines(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charAt(i) === '\n') line += 1;
  }
  return line;
}

/** 四类判据合体。 */
export function scanStructure(source: string): StructuralFinding[] {
  return [
    ...findDecapitatedBlocks(source),
    ...findUnbalancedBraces(source),
    ...findOrphanJsdoc(source),
  ];
}

/** 人类可读的一行（报红与人工排查共用）。 */
export function formatStructuralFindings(findings: readonly StructuralFinding[]): string {
  return findings
    .map((f) => `  [${f.kind}] line ${String(f.line)}: ${f.detail}`)
    .join('\n');
}
