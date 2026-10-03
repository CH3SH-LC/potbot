/**
 * WCF-D53 的共享测试工具（**不是**被测实现的一部分）。
 *
 * 纪律：
 * * 用例**只注入假端口**跑编排器，**日常不启动 Word**（引擎是显式 opt-in）。
 * * **缺工具必须显式失败**：`assertReadbackToolsAvailable()` 在 reportlab/pypdf
 *   缺失时**抛错**（测试变红），不 skip、不降级。
 * * 产物一律落 `.dev-evidence/.../D53/**`（已 gitignore）与 `%TEMP%`，**不污染别处**。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { pythonExecutable } from '../../../apps/demo/rendering/index.js';

/** 仓库根（`tests/word-acceptance/pdf/support.ts` 向上三级）。 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** D53 证据目录（gitignore；**开发期证据**，非正式冻结点）。 */
export const D53_EVIDENCE_DIR = join(
  REPO_ROOT, '.dev-evidence', 'word-common-features', 'WCF-20261002-A', 'D53',
);

/** 夹具生成器（真 PDF / 假 PDF）。 */
export const MAKE_PDF_PY = join(REPO_ROOT, 'tests', 'word-acceptance', 'pdf', 'fixtures', 'make-pdf.py');

/** 真实引擎：Word COM 导出脚本。 */
export const WORD_EXPORT_PY = join(REPO_ROOT, 'apps', 'demo', 'rendering', 'python', 'word-export-pdf.py');

/** 真实读回器：pypdf 脚本。 */
export const PDF_READBACK_PY = join(REPO_ROOT, 'apps', 'demo', 'rendering', 'python', 'pdf-readback.py');

/** 带页脚域的多页 DOCX 夹具生成器。 */
export const MAKE_FOOTER_FIXTURE_PY = join(
  REPO_ROOT, 'apps', 'demo', 'rendering', 'python', 'make-footer-fixture.py',
);

export interface PyRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;
}

/** 跑一段 Python 脚本；任何退出码都如实返回（**不抛**）。 */
export function runPython(args: readonly string[], timeoutMs = 60_000): PyRun {
  const python = pythonExecutable();
  const command = [python, ...args].join(' ');
  try {
    const stdout = execFileSync(python, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    return { exitCode: 0, stdout, stderr: '', command };
  } catch (error) {
    const withOutput = error as { status?: number | null; stdout?: unknown; stderr?: unknown };
    return {
      exitCode: typeof withOutput.status === 'number' ? withOutput.status : 1,
      stdout: typeof withOutput.stdout === 'string' ? withOutput.stdout : '',
      stderr: typeof withOutput.stderr === 'string' ? withOutput.stderr : '',
      command,
    };
  }
}

/**
 * 缺工具就**显式失败**（抛错 ⇒ 测试变红；**绝不** skip 计通过）。
 *
 * 判据：python 解释器可执行 + reportlab + pypdf 都在 + 夹具生成器在。
 */
export function assertReadbackToolsAvailable(): void {
  const python = pythonExecutable();
  if ((python.includes('/') || python.includes('\\')) && !existsSync(python)) {
    throw new Error(`找不到 Python 解释器：${python}（可设 DEMO_PYTHON 覆盖）`);
  }
  if (!existsSync(MAKE_PDF_PY)) throw new Error(`找不到夹具生成器：${MAKE_PDF_PY}`);
  const check = runPython([MAKE_PDF_PY, '--check-tools'], 60_000);
  if (check.exitCode !== 0) {
    throw new Error(
      `缺 PDF 读回/生成工具（退出码 ${check.exitCode}）：${check.stdout.trim()} ${check.stderr.trim()}`,
    );
  }
}

/** 造一份**真 PDF**（reportlab），返回绝对路径。产物落 D53 证据目录。 */
export function makeRealPdf(name: string, pages: number, footerPrefix = 'potbot-footer'): string {
  mkdirSync(D53_EVIDENCE_DIR, { recursive: true });
  const out = join(D53_EVIDENCE_DIR, name);
  const run = runPython([MAKE_PDF_PY, out, '--mode', 'pdf', '--pages', String(pages),
    '--footer-prefix', footerPrefix]);
  if (run.exitCode !== 0) {
    throw new Error(`造真 PDF 失败（退出码 ${run.exitCode}）：${run.stdout} ${run.stderr}`);
  }
  return out;
}

/** 造一份"改了扩展名"的假 PDF（内容不是 PDF），返回绝对路径。 */
export function makeRenamedNotPdf(name: string): string {
  mkdirSync(D53_EVIDENCE_DIR, { recursive: true });
  const out = join(D53_EVIDENCE_DIR, name);
  const run = runPython([MAKE_PDF_PY, out, '--mode', 'notpdf']);
  if (run.exitCode !== 0) {
    throw new Error(`造假 PDF 失败（退出码 ${run.exitCode}）：${run.stdout} ${run.stderr}`);
  }
  return out;
}

/** 读 JSON（期望文件 / 报告）。 */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
