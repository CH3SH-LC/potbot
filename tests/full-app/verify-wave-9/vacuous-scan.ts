/**
 * FA-VERIFY-WAVE-9 · 验证方自写的**恒真 / 空断言扫描器**（TS AST，不用正则）。
 *
 * 规则（每条先过合成源码正/负对照，见 T5）：
 * - {@link TautologySameExpr}：`expect(A).<matcher>(A)` —— 两侧**文本相同**的表达式。
 * - {@link TautologyLiteral}：`expect(true).toBe(true)` / `expect(false).toBe(false)` 等字面量自比。
 * - {@link NullProxy}：同一块内 `const x = null;` 后接 `expect(x).toBeNull()` —— 断言刚被赋 null 的局部量。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import ts from 'typescript';

export interface VacuousHit {
  readonly kind: 'tautology-same-expr' | 'tautology-literal' | 'null-proxy';
  readonly line: number;
  readonly snippet: string;
}

const norm = (s: string): string => s.replace(/\s+/g, '');

/** 扫描一段源码文本，返回恒真/空断言命中。 */
export function scanSource(text: string, fileName = 'x.ts'): VacuousHit[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: VacuousHit[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  // 收集"被赋 null 的局部名 → 行"
  const nullLocals = new Map<string, number>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      if (node.initializer.kind === ts.SyntaxKind.NullKeyword) nullLocals.set(node.name.text, lineOf(node));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
      const actualArg = node.arguments[0];
      // `expect(...)` 后面跟属性访问（`.toBe`）再跟调用 —— 从父链取 matcher 名。
      const parent = node.parent;
      if (parent !== undefined && ts.isPropertyAccessExpression(parent) && ts.isCallExpression(parent.parent)) {
        const matcher = parent.name.text;
        {
          const matcherCall = parent.parent;
          const expectedArg = matcherCall.arguments[0];
          const actualText = actualArg === undefined ? '' : norm(actualArg.getText(source));
          // 规则 1：same-expr
          if (expectedArg !== undefined && actualText !== '' && norm(expectedArg.getText(source)) === actualText) {
            hits.push({
              kind: 'tautology-same-expr',
              line: lineOf(node),
              snippet: `${node.getText(source)}.${matcher}(...)`,
            });
          }
          // 规则 2：字面量
          if (
            actualArg !== undefined &&
            (actualArg.kind === ts.SyntaxKind.TrueKeyword || actualArg.kind === ts.SyntaxKind.FalseKeyword) &&
            ['toBe', 'toEqual', 'toBeTruthy', 'toBeFalsy', 'toStrictEqual'].includes(matcher)
          ) {
            hits.push({ kind: 'tautology-literal', line: lineOf(node), snippet: node.parent?.getText(source) ?? '' });
          }
          // 规则 3：null-proxy
          if (
            matcher === 'toBeNull' &&
            actualArg !== undefined &&
            ts.isIdentifier(actualArg) &&
            nullLocals.has(actualArg.text)
          ) {
            hits.push({ kind: 'null-proxy', line: lineOf(node), snippet: `expect(${actualArg.text}).toBeNull()` });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}
