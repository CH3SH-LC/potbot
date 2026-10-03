/**
 * S6 独立验收的共享工具（**不是**被测实现的一部分）。
 *
 * 纪律：本目录的用例**不 import** `apps/demo/**` 或 `src/**` 的内部函数来自证；
 * 只做三件事——(1) 以文本方式静态扫描实现源码、(2) 以黑盒方式打 HTTP、(3) 用
 * 独立工具（Python `zipfile`/`xml.etree`）读回产物。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** 仓库根（`tests/demo/support.ts` 向上两级）。 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** 本机 Python 解释器：优先环境变量，其次工程实测路径，最后 PATH 上的 `python`。 */
export function pythonExecutable(): string {
  const fromEnv = process.env['DEMO_PYTHON'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const known = 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
  if (existsSync(known)) return known;
  return 'python';
}

/** 独立 DOCX 读回器的绝对路径。 */
export const VERIFY_DOCX_PY = join(REPO_ROOT, 'scripts', 'demo', 'verify-docx.py');

export interface DocxReadback {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly parsed: {
    readonly ok: boolean;
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly byteLength?: number;
    readonly document: {
      readonly part: string;
      readonly paragraphs: readonly string[];
      readonly non_empty_count: number;
      readonly title: string | null;
      readonly body: readonly string[];
      readonly presentation?: string | null;
    } | null;
    readonly checks?: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
  } | null;
  readonly stdout: string;
}

/**
 * 用 Python 独立读回器读一个 DOCX。**不抛异常**——失败也是结果（`ok:false`）。
 */
export function readbackDocx(path: string): DocxReadback {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  try {
    const stdout = execFileSync(pythonExecutable(), [VERIFY_DOCX_PY, path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
      env,
    });
    return { ok: true, exitCode: 0, parsed: JSON.parse(stdout.trim()), stdout };
  } catch (error) {
    const withStdout = error as { status?: number | null; stdout?: unknown };
    const code = typeof withStdout.status === 'number' ? withStdout.status : 1;
    const stdout = typeof withStdout.stdout === 'string' ? withStdout.stdout : '';
    let parsed: DocxReadback['parsed'] = null;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      parsed = null;
    }
    return { ok: false, exitCode: code, parsed, stdout };
  }
}

/** 递归列出目录下所有文件（绝对路径）。目录不存在 ⇒ 空数组。 */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** 读文本文件（UTF-8）。 */
export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** 仓库相对路径（正斜杠，便于断言消息阅读）。 */
export function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}
