/**
 * FA-VERIFY-WAVE-9 · 收尾独立验证 —— 验证方自写的**源码文本探针**与**调用点计数器**。
 *
 * 用途：为"闭环复核"提供**不依赖实现者说法**的事实（某闸门是否在生产路径上被调用、
 * 某字面量类型是否仍在、某段派发代码是否仍在）。
 *
 * 判据口径：
 * - {@link codeLines} 先把**注释行**剥离（`//`、`/* … *\/`、行首 `*`），避免把注释里的字符串
 *   当代码命中——上一轮曾出现过"注释里的 token 被当代码"的误报。
 * - {@link countCalls} 用 TS AST 数"函数名作为被调用方（`f(` / `new f(`）"的出现次数，
 *   **不含** import 绑定与注释。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

export const toRel = (root: string, p: string): string => relative(root, p).split('\\').join('/');

/** 去掉注释（状态机：块注释 / 行注释 / 字符串里的 `//` 不被误删）。 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    // 字符串状态：原样保留，处理转义与闭合
    if (c === '\\') {
      out += c + (n ?? '');
      i += 2;
      continue;
    }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
      state = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 某文件的**代码**（已剥离注释）。 */
export function codeOf(root: string, relPath: string): string {
  return stripComments(readFileSync(join(root, relPath), 'utf8'));
}

/** 该文件的**全部文本**（含注释）——仅在"注释也算事实"时使用。 */
export function rawOf(root: string, relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8');
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** 列出 `src/**` 与 `apps/**` 下的**非测试** `.ts` 文件（排除 `.d.ts`）。 */
export function nonTestFiles(root: string): string[] {
  const out: string[] = [];
  for (const base of ['src', 'apps']) {
    for (const f of walk(join(root, base))) {
      if (!f.endsWith('.ts')) continue;
      if (f.endsWith('.d.ts')) continue;
      if (/\.(test|spec)\.ts$/.test(f)) continue;
      out.push(toRel(root, f));
    }
  }
  return out.sort();
}

/** 列出 `src/**` 与 `apps/**` 下的**测试** `.ts` 文件。 */
export function testFilesOf(root: string): string[] {
  const out: string[] = [];
  for (const base of ['src', 'apps']) {
    for (const f of walk(join(root, base))) {
      if (/\.(test|spec)\.ts$/.test(f)) out.push(toRel(root, f));
    }
  }
  return out.sort();
}

/**
 * 在**非测试代码**里按名找**调用点**（`f(` / `new f(` / 模板标签）。
 * 返回 `file:line` 列表。注释里的名字**不计**（用 AST，天然不看注释）。
 */
export function countCalls(root: string, names: readonly string[]): { file: string; line: number }[] {
  const wanted = new Set(names);
  const hits: { file: string; line: number }[] = [];
  for (const rel of nonTestFiles(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      let callee: ts.Node | undefined;
      if (ts.isCallExpression(node)) callee = node.expression;
      else if (ts.isNewExpression(node)) callee = node.expression;
      else if (ts.isTaggedTemplateExpression(node)) callee = node.tag;
      if (callee !== undefined && ts.isIdentifier(callee) && wanted.has(callee.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        hits.push({ file: rel, line: line + 1 });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

/** 在**非测试代码**里按名找**任意引用**（含值位置与类型位置）——用于"符号是否被消费"。 */
export function findReferences(root: string, names: readonly string[]): { file: string; line: number }[] {
  const wanted = new Set(names);
  const hits: { file: string; line: number }[] = [];
  for (const rel of nonTestFiles(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && wanted.has(node.text)) {
        const p = node.parent;
        const isImportBinding =
          p !== undefined && (ts.isImportClause(p) || ts.isImportSpecifier(p) || ts.isNamespaceImport(p));
        if (!isImportBinding) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          hits.push({ file: rel, line: line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}
