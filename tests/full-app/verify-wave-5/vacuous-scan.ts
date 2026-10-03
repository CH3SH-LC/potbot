/**
 * FA-VERIFY-WAVE-5 · 恒真 / 空断言扫描器（TS AST，验证方自带）。
 *
 * 规则（每条都配"能变红"的反例，见 `T3-vacuous-hunt.test.ts`）：
 * - `not-throw-only`：一个 `it` 体里**只有**一条 `.not.toThrow()` 断言；
 * - `tautology-same-expr`：`expect(A).toBe(A)`（两侧同一段源码文本）；
 * - `tautology-literal`：`expect(true).toBe(true)` / `expect(1).toBe(1)` 之类字面量自比；
 * - `weak-only`：一个 `it` 体里**只有** `toBeDefined / toBeTruthy / not.toBeUndefined / not.toBeNull`；
 * - `trivial-bound`：`toBeGreaterThanOrEqual(0)` / `toBeGreaterThan(-1)` / `toBeLessThan(Infinity)`；
 * - `expect-true`：`expect(true).<matcher>`（排除 `expect(x).toBe(true)`——那是有判别力的）。
 */

import { readFileSync } from 'node:fs';

import ts from 'typescript';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly test: string;
  readonly detail: string;
}

export interface Assertion {
  readonly matcher: string;
  readonly negated: boolean;
  readonly argsText: readonly string[];
  readonly subjectText: string;
  readonly line: number;
}

const LINE = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** 收集子树里的 `expect(x)[.not].matcher(args)` 断言。 */
export function collectAssertions(subtree: ts.Node, source: ts.SourceFile): Assertion[] {
  const out: Assertion[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression; // expect(x).matcher  或  expect(x).not.matcher 里的 .matcher
      const inner = prop.expression;
      let base: ts.Expression | null = null;
      let negated = false;
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'expect') {
        base = inner;
      } else if (
        ts.isPropertyAccessExpression(inner) &&
        inner.name.text === 'not' &&
        ts.isCallExpression(inner.expression) &&
        ts.isIdentifier((inner.expression as ts.CallExpression).expression) &&
        ((inner.expression as ts.CallExpression).expression as ts.Identifier).text === 'expect'
      ) {
        base = inner.expression as ts.CallExpression;
        negated = true;
      }
      if (base !== null && ts.isCallExpression(base)) {
        out.push({
          matcher: prop.name.text,
          negated,
          argsText: node.arguments.map((a) => a.getText(source)),
          subjectText: base.arguments[0]?.getText(source) ?? '',
          line: LINE(source, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(subtree);
  return out;
}

export interface TestBlock {
  readonly title: string;
  readonly line: number;
  readonly assertions: readonly Assertion[];
}

/** 收集文件里的 `it(...)` / `test(...)` 块及其**范围内**的断言。 */
export function collectTestBlocks(source: ts.SourceFile): TestBlock[] {
  const blocks: TestBlock[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'it' || node.expression.text === 'test') &&
      node.arguments.length >= 2
    ) {
      const titleArg = node.arguments[0] as ts.Expression | undefined;
      const body = node.arguments[node.arguments.length - 1] as ts.Node;
      const titleText =
        titleArg !== undefined && ts.isStringLiteralLike(titleArg) ? titleArg.text : '(动态)';
      blocks.push({
        title: `${titleText} @L${String(LINE(source, node))}`,
        line: LINE(source, node),
        assertions: collectAssertions(body, source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return blocks;
}

const WEAK = new Set(['toBeDefined', 'toBeTruthy', 'toBeUndefined', 'toBeNull']);
/**
 * 只把**恒真**的上下界算作 trivial。`toBeGreaterThan(0)` 用在 `length` 上是有判别力的
 * （"至少有一条"），故**不**列入。
 */
const TRIVIAL = new Set(['0', '-1', 'Infinity', '-Infinity']);
const TRIVIAL_MATCHERS = new Set(['toBeGreaterThanOrEqual', 'toBeLessThanOrEqual', 'toBeGreaterThan']);

/** 扫描一个测试文件，返回全部可疑断言。 */
export function scanTestText(rootRel: string, text: string): Finding[] {
  const source = ts.createSourceFile(rootRel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  for (const block of collectTestBlocks(source)) {
    const list = block.assertions;
    if (list.length === 1) {
      const only = list[0] as Assertion;
      if (only.matcher === 'toThrow' && only.negated) {
        findings.push({ file: rootRel, line: only.line, rule: 'not-throw-only', test: block.title, detail: '整个 it 体只有一条 .not.toThrow()' });
      }
      if (WEAK.has(only.matcher) && (only.negated || only.matcher !== 'toBeUndefined')) {
        findings.push({
          file: rootRel,
          line: only.line,
          rule: 'weak-only',
          test: block.title,
          detail: `唯一断言是 ${only.negated ? 'not.' : ''}${only.matcher}`,
        });
      }
    }
    for (const a of list) {
      if (a.matcher === 'toBe' && a.argsText.length === 1) {
        const expected = (a.argsText[0] as string).trim();
        const subject = a.subjectText.trim();
        if (expected === subject && subject.length > 0) {
          findings.push({ file: rootRel, line: a.line, rule: 'tautology-same-expr', test: block.title, detail: `expect(${subject}).toBe(${expected})` });
        }
      }
      const bound = (a.argsText[0] ?? '').trim();
      // `>= 0` / `> -1` / `<= Infinity` 对任何数值恒真；`> 0` 不在此列（长度断言是承重的）
      if (TRIVIAL_MATCHERS.has(a.matcher) && TRIVIAL.has(bound) && !(a.matcher === 'toBeGreaterThan' && bound === '0')) {
        findings.push({ file: rootRel, line: a.line, rule: 'trivial-bound', test: block.title, detail: `${a.matcher}(${bound})` });
      }
      if (a.subjectText.trim() === 'true') {
        findings.push({ file: rootRel, line: a.line, rule: 'expect-true', test: block.title, detail: `expect(true).${a.negated ? 'not.' : ''}${a.matcher}` });
      }
    }
  }
  return findings;
}

export function scanTestFile(rootRel: string, file: string): Finding[] {
  return scanTestText(rootRel, readFileSync(file, 'utf8'));
}
