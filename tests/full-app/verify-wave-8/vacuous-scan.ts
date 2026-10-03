/**
 * FA-VERIFY-WAVE-8 · **空断言猎捕**（本轮第五疑点）。
 *
 * "空断言"指：**用例在，断言不在**，或断言被一个恒假的守卫包住，于是合并把实现吞掉、
 * 测试照绿。本扫描在**实现方自己的测试**上找三类模式：
 *
 * 1. `it` / `test` 回调里**一条 `expect(` 都没有**（且没有委托给会断言的本地助手）；
 * 2. `expect(` 被包在 `if (…) { … }` 里（守卫为假时静默通过）；
 * 3. `expect(<字面量>).toBe(<同一个字面量>)` 这类恒真自证。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 SD/DS**。
 */

import ts from 'typescript';

export interface VacuousHit {
  readonly file: string;
  readonly line: number;
  readonly kind: 'no-assertion' | 'conditional-assertion' | 'tautology';
  readonly detail: string;
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const countMatches = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

/** 本文件里声明的（可能是"会断言"的）助手函数名。 */
function localHelperNames(sf: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) names.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** 扫描单个测试文件文本。 */
export function scanFileForVacuous(file: string, text: string): readonly VacuousHit[] {
  const sf = parse(file, text);
  const hits: VacuousHit[] = [];
  const helpers = localHelperNames(sf);
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const callsLocalHelper = (body: string): boolean => {
    for (const name of helpers) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(body)) return true;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    // 1. it(...) / test(...) —— 回调里没有 expect，也没委托给本文件的会断言的助手
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if ((callee === 'it' || callee === 'test') && node.arguments.length >= 2) {
        // 注意：`it('...', fn, 60000)` 的**最后一个**实参是超时毫秒数，不是回调。
        // 必须挑第一个函数实参，否则会把"带时限的用例"误判成空断言（本扫描第一版就踩了这个坑）。
        const callback = node.arguments.find(
          (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
        );
        const body = callback?.getText(sf) ?? '';
        if (callback !== undefined && countMatches(body, /\bexpect\s*\(/g) === 0 && !callsLocalHelper(body)) {
          hits.push({ file, line: lineOf(node), kind: 'no-assertion', detail: node.arguments[0]?.getText(sf).slice(0, 70) ?? '' });
        }
      }
    }

    // 2. expect 被 if 守卫包住
    if (ts.isIfStatement(node)) {
      const inner = node.getText(sf);
      if (/\bexpect\s*\(/.test(inner)) {
        hits.push({ file, line: lineOf(node), kind: 'conditional-assertion', detail: inner.slice(0, 70).replace(/\s+/g, ' ') });
      }
    }

    // 3. expect(字面量).toBe(同字面量)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression.name.text;
      if ((prop === 'toBe' || prop === 'toEqual') && node.arguments.length === 1) {
        const inner = node.expression.expression;
        if (ts.isCallExpression(inner) && inner.arguments.length === 1) {
          const a = inner.arguments[0];
          const b = node.arguments[0];
          if (
            a !== undefined &&
            b !== undefined &&
            (ts.isStringLiteral(a) || ts.isNumericLiteral(a) || a.kind === ts.SyntaxKind.TrueKeyword || a.kind === ts.SyntaxKind.FalseKeyword || a.kind === ts.SyntaxKind.NullKeyword) &&
            a.getText(sf) === b.getText(sf)
          ) {
            hits.push({ file, line: lineOf(node), kind: 'tautology', detail: `${inner.getText(sf)} === ${b.getText(sf)}` });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
