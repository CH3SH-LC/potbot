/**
 * 夹具落盘 —— **运行期生成**，不进版本库。
 *
 * 关键：CRLF 夹具**不能**作为 tracked 文件提交（根的 `.gitattributes` 会把它规范化成 LF，
 * 夹具就失效了）。所以一律写进 `.dev-evidence/`（已 gitignore）再由测试读回。
 *
 * 并且 `.dev-evidence/` 在仓库内 ⇒ `git check-attr` 对其中路径仍按 `.gitattributes`
 * 规则求值，反向对照才能测到**真实**的保护判定，而不是靠桩。
 */

import fs from 'node:fs';
import path from 'node:path';

import { FIXTURE_BODY, LF_SHEBANG_LINE, CRLF_SHEBANG_LINE } from './hashbang-probe.js';

export interface FixtureSet {
  dir: string;
  /** label -> 绝对路径（label 同时是 vite root 下的 URL 名，如 'lf' → '/lf.mjs'） */
  paths: Record<string, string>;
  dispose(): void;
}

export function scratchDir(repoRoot: string): string {
  return path.join(repoRoot, '.dev-evidence', 'crlf-shebang-scan');
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(text, 'utf8'));
}

/**
 * 三层根因探针的夹具：同内容（同 shebang、同导出），只差行尾。
 *  - lf   ：`#!/usr/bin/env node\n` + body（LF）
 *  - crlf ：`#!/usr/bin/env node\r\n` + body（CRLF）
 */
export function makeHashbangFixtures(repoRoot: string): FixtureSet {
  const dir = path.join(scratchDir(repoRoot), 'vite-root');
  const paths: Record<string, string> = {};
  for (const [label, shebang] of [
    ['lf', LF_SHEBANG_LINE],
    ['crlf', CRLF_SHEBANG_LINE],
  ] as const) {
    const file = path.join(dir, `${label}.mjs`);
    write(file, shebang + FIXTURE_BODY);
    paths[label] = file;
  }
  return {
    dir,
    paths,
    dispose: () => fs.rmSync(scratchDir(repoRoot), { recursive: true, force: true }),
  };
}

/**
 * 反向对照夹具（**故意**落成不同扩展名，以覆盖不同 `.gitattributes` 规则）：
 *  - `ctrl-crlf.js`      shebang + CRLF + `.js`（无属性覆盖）⇒ 扫描器**必须报红**
 *  - `ctrl-lf.js`        shebang + LF   + `.js`                ⇒ 不报红
 *  - `ctrl-noshebang.js` 无 shebang + CRLF + `.js`             ⇒ 不报红（无 shebang）
 *  - `ctrl-crlf.mjs`     shebang + CRLF + `.mjs`（`eol=lf` 覆盖）⇒ 不报红但计入 ADVISORY
 *                         —— 这条同时是**保护规则本身**的正对照：规则真的在挡。
 */
export function makeControlFixtures(repoRoot: string): FixtureSet {
  const dir = path.join(scratchDir(repoRoot), 'control');
  const body = 'export const marker = "ok";\n';
  const files: Record<string, string> = {
    'ctrl-crlf.js': CRLF_SHEBANG_LINE + body.replace(/\n/g, '\r\n'),
    'ctrl-lf.js': LF_SHEBANG_LINE + body,
    'ctrl-noshebang.js': body.replace(/\n/g, '\r\n'),
    'ctrl-crlf.mjs': CRLF_SHEBANG_LINE + body.replace(/\n/g, '\r\n'),
  };
  const paths: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    write(file, text);
    paths[name] = file;
  }
  return {
    dir,
    paths,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
