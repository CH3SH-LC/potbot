/**
 * FA-VERIFY-WAVE-7 · §4 恒真 / 空断言猎捕（本轮新增测试）。
 *
 * 扫描对象 = **自第五轮验证提交 `22735b2` 以来新增/改动的测试文件**（本轮交付物）。
 * 用 TS 语法树找三类形态（并先用合成源码做正/负对照，证明尺子有刻度）：
 *  1. `expect(A).toBe(A)` 自比（同一实参文本）；
 *  2. 整个 `it` 里**只有** `.not.toThrow()` 或**只有**弱匹配（toBeDefined/toBeTruthy/…）；
 *  3. `expect(<常量>).toContain('<字符串字面量>')` —— 对**源码常量**的字面量断言（语义恒真）。
 *
 * 另做人工核查项（§4.4）：断言由被测对象自身产出（自证循环）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** 本轮新增/改动的测试文件（`git diff --name-status 22735b2..HEAD` 中 A/M 的 `.test.ts`）。 */
const NEW_TESTS: readonly string[] = [
  'apps/demo/server/adapters-reach.test.ts',
  'apps/demo/server/e2e-doc-research.test.ts',
  'apps/demo/server/mem-inject-product.test.ts',
  'apps/demo/server/ppt-facts-product.test.ts',
  'apps/demo/server/roles-wiring.test.ts',
  'apps/demo/server/xls-facts-product.test.ts',
  'apps/demo/server/documents-routes.test.ts',
];

const WEAK = new Set(['toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toBeNull', 'toBeUndefined', 'toBeNaN']);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function readCallText(node: ts.Node): string {
  return node.getText().replace(/\s+/g, ' ');
}

export function scanFile(file: string): Finding[] {
  const sf = parse(file);
  const out: Finding[] = [];

  // 收集"来自被测模块的常量"：import 进来的名字 + 顶层 `const X = readFileSync(...)`。
  const importedNames = new Set<string>();
  const sourceConsts = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings) {
      const nb = stmt.importClause.namedBindings;
      if (ts.isNamedImports(nb)) for (const el of nb.elements) importedNames.add(el.name.text);
      else if (ts.isNamespaceImport(nb)) importedNames.add(nb.name.text);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && d.initializer.getText().includes('readFileSync')) {
          sourceConsts.add(d.name.text);
        }
      }
    }
  }

  const walk = (node: ts.Node): void => {
    // 规则 1 / 3：expect(X).<matcher>(B)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text;
      const lhsOwner = node.expression.expression;
      const isExpectCall =
        ts.isCallExpression(lhsOwner) &&
        ts.isIdentifier(lhsOwner.expression) &&
        lhsOwner.expression.text === 'expect' &&
        lhsOwner.arguments.length === 1;
      const lhsArg = ts.isCallExpression(lhsOwner) ? lhsOwner.arguments[0] : undefined;
      const rhsArg = node.arguments[0];
      if (isExpectCall && lhsArg !== undefined && rhsArg !== undefined && node.arguments.length === 1) {
        const a = lhsArg.getText().replace(/\s+/g, ' ');
        const b = rhsArg.getText().replace(/\s+/g, ' ');
        // 规则 1：自比
        if (['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject'].includes(matcher) && a === b && a.length > 0) {
          out.push({ file, line: lineOf(sf, node), rule: 'tautology-same-expr', text: a });
        }
        // 规则 3：expect(<来自被测模块的常量>).toContain('<字符串字面量>')
        if (
          ['toContain', 'toContainEqual'].includes(matcher) &&
          ts.isIdentifier(lhsArg) &&
          (importedNames.has(lhsArg.text) || sourceConsts.has(lhsArg.text)) &&
          (ts.isStringLiteral(rhsArg) || ts.isNoSubstitutionTemplateLiteral(rhsArg))
        ) {
          out.push({ file, line: lineOf(sf, node), rule: 'const-contains-literal', text: readCallText(node) });
        }
      }
    }

    // 规则 2：it 块里唯一的断言是 not.toThrow / 唯一断言是弱匹配
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'it') {
      const cb = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        const asserts: { matcher: string; text: string }[] = [];
        const inner = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const m = n.expression.name.text;
            const base = n.expression.expression;
            const isNot =
              ts.isPropertyAccessExpression(base) &&
              base.name.text === 'not' &&
              ts.isCallExpression(base.expression) &&
              ts.isIdentifier(base.expression.expression) &&
              base.expression.expression.text === 'expect';
            const isPlain =
              ts.isCallExpression(base) &&
              ts.isIdentifier(base.expression) &&
              base.expression.text === 'expect';
            if (isNot || isPlain) asserts.push({ matcher: m, text: readCallText(n) });
          }
          ts.forEachChild(n, inner);
        };
        inner(cb);
        const onlyNotThrow = asserts.length > 0 && asserts.every((a) => a.matcher === 'toThrow' && a.text.includes('.not.toThrow'));
        const onlyWeak = asserts.length > 0 && asserts.every((a) => WEAK.has(a.matcher));
        if (onlyNotThrow) out.push({ file, line: lineOf(sf, node), rule: 'not-throw-only', text: asserts[0]?.text ?? '' });
        if (onlyWeak) out.push({ file, line: lineOf(sf, node), rule: 'weak-only', text: asserts.map((a) => a.matcher).join('+') });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

describe('§4.0 尺子自检（合成源码正/负对照）', () => {
  it('对合成源码分别报出 恒真 / 常量断言 / not-throw / 弱断言，且放行有判别力的断言', () => {
    const probe = `
      import { K } from './k.js';
      const SOURCE = readFileSync('x', 'utf8');
      it('self', () => { const x = 1; expect(x).toBe(x); });
      it('const-imported', () => { expect(K).toContain('abc'); });
      it('const-source', () => { expect(SOURCE).toContain('abc'); });
      it('nothrow', () => { expect(() => f()).not.toThrow(); });
      it('weak', () => { expect(a).toBeDefined(); });
      it('good', () => { expect(a).toBe(2); expect(b).toEqual([1,2]); expect(codes).toContain('x'); });
    `;
    const tmp = join(mkdtempSync(join(tmpdir(), 'vw7-vac-')), 'probe.ts');
    writeFileSync(tmp, probe);
    const rules = new Set(scanFile(tmp).map((f) => f.rule));
    expect(rules.has('tautology-same-expr')).toBe(true);
    expect(rules.has('const-contains-literal')).toBe(true);
    expect(rules.has('not-throw-only')).toBe(true);
    expect(rules.has('weak-only')).toBe(true);
    // 反向：good 用例（含对**运行时局部** codes 的 toContain）不该被命中
    const once = scanFile(tmp);
    expect(once.filter((f) => f.text.includes('toBe(2)'))).toEqual([]);
    expect(once.filter((f) => f.text.includes('codes'))).toEqual([]);
    // 正例：import 进来的常量与 readFileSync 常量两种都要报
    expect(once.filter((f) => f.text.includes('(K)')).length).toBe(1);
    expect(once.filter((f) => f.text.includes('(SOURCE)')).length).toBe(1);
  });
});

describe('§4.1 本轮新增测试的扫描结果', () => {
  it('扫描 7 个文件并打印命中（file:line + 规则 + 最小复现片段）', () => {
    const all = NEW_TESTS.flatMap((f) => scanFile(f));
    // eslint-disable-next-line no-console
    console.log('W7 vacuous findings:');
    for (const f of all) {
      // eslint-disable-next-line no-console
      console.log(`  ${f.file}:${String(f.line)} [${f.rule}] ${f.text.slice(0, 120)}`);
    }
    expect(Array.isArray(all)).toBe(true);
  });

  it('(b) 类"常量对字面量"断言确实存在（xls-facts 的可达性自证）', () => {
    const hits = scanFile('apps/demo/server/xls-facts-product.test.ts').filter(
      (f) => f.rule === 'const-contains-literal',
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('§4.4 断言由被测对象自身产出（自证循环，人工核查）', () => {
  it('roles-wiring.test.ts：实际值与被期望值都来自被测模块导出的同一个常量', () => {
    const src = readFileSync('apps/demo/server/roles-wiring.test.ts', 'utf8');
    expect(src.includes('expect(result.body.reachable_modules).toEqual([...ROLES_MODULES_REACHABLE_BY_WIRING])')).toBe(true);
    // 该常量本身又是 roles-wiring.ts 在 statusBody 里直接回显的那一份。
    const mod = readFileSync('apps/demo/server/roles-wiring.ts', 'utf8');
    expect(mod.includes('reachable_modules: ROLES_MODULES_REACHABLE_BY_WIRING')).toBe(true);
  });

  it('documents-routes.test.ts：coverage 期望值 === 被测模块自己导出的常量', () => {
    const src = readFileSync('apps/demo/server/documents-routes.test.ts', 'utf8');
    expect(src.includes("expect(body['coverage']).toEqual(DOCUMENTS_ROUTE_MODULE_COVERAGE)")).toBe(true);
  });

  it('自证循环的反向对照：它结构上测不到"有 import 边但没派发"', () => {
    // 这类自证只核对"源码文本里出现过说明符"，与运行时是否被派发无关。
    const src = readFileSync('apps/demo/server/documents-routes.test.ts', 'utf8');
    expect(src.includes('expect(source.includes(specifier)')).toBe(true);
  });
});
