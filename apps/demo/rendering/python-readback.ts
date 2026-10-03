/**
 * {@link PdfReadback} 的**真实实现**：调 Python `pypdf` 读回 PDF。
 *
 * **独立**是重点：本驱动程序与 TS 侧**没有任何共享解析代码**（合同 R167）。
 * TS 只负责起进程、把 JSON 载荷映射成端口形状；页数、魔数、逐页文本全部来自 Python。
 *
 * **缺工具必须显式失败**：没装 `pypdf`（脚本退出码 3）→ `tool_missing`，
 * **不是** skip、**不是**降级通过。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  readbackFailure,
  type PdfPageText,
  type PdfReadback,
  type PdfReadbackFailureKind,
  type PdfReadbackOutcome,
} from './pdf-readback.js';
import { pythonExecutable } from './word-com-engine.js';

const DEFAULT_SCRIPT = resolve(import.meta.dirname, 'python', 'pdf-readback.py');

export interface PythonReadbackOptions {
  readonly pythonPath?: string;
  readonly scriptPath?: string;
  readonly timeoutMs?: number;
  readonly reportDir?: string;
}

/** 读回器脚本打印的 JSON 形状（只声明我们用到的字段）。 */
interface ReadbackJson {
  readonly ok?: boolean;
  readonly path?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly magic?: string;
  readonly magic_ok?: boolean;
  readonly pdf_version?: string | null;
  readonly page_count?: number;
  readonly encrypted?: boolean;
  readonly pages?: readonly { readonly page?: number; readonly text?: string }[];
  readonly text_truncated?: boolean;
  readonly tool?: string;
  readonly error?: { readonly code?: string; readonly message?: string } | null;
}

function mapFailureCode(code: string | undefined): PdfReadbackFailureKind {
  switch (code) {
    case 'tool_missing':
      return 'tool_missing';
    case 'file_missing':
      return 'file_missing';
    default:
      return 'read_error';
  }
}

export function createPythonPdfReadback(options: PythonReadbackOptions = {}): PdfReadback {
  const python = options.pythonPath ?? pythonExecutable();
  const script = options.scriptPath ?? DEFAULT_SCRIPT;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const reportDir = options.reportDir
    ?? process.env['POTBOT_PDF_REPORT_DIR']
    ?? join(tmpdir(), 'potbot-pdf-export');

  return {
    async inspect(path: string): Promise<PdfReadbackOutcome> {
      if (!existsSync(script)) {
        return {
          ok: false,
          failure: readbackFailure('tool_missing', `读回器脚本不存在：${script}`),
        };
      }

      let reportPath = '';
      try {
        mkdirSync(reportDir, { recursive: true });
        reportPath = join(mkdtempSync(join(reportDir, 'readback-')), 'readback.json');
      } catch {
        reportPath = '';
      }

      const args = [script, path];
      if (reportPath.length > 0) args.push('--report', reportPath);
      const done = spawnSync(python, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });

      const stdout = done.stdout ?? '';
      const stderr = done.stderr ?? '';

      if (done.error !== undefined) {
        const code = (done.error as NodeJS.ErrnoException).code;
        return {
          ok: false,
          failure: readbackFailure(
            code === 'ETIMEDOUT' ? 'tool_crashed' : 'tool_missing',
            code === 'ETIMEDOUT'
              ? `读回器在 ${timeoutMs}ms 内未返回`
              : `无法执行读回器（python=${python}）：${done.error.message}`,
            stderr.slice(0, 2000),
          ),
        };
      }

      const payload = parseJson(stdout) ?? (reportPath.length > 0 ? readReport(reportPath) : null);
      if (payload === null) {
        return {
          ok: false,
          failure: readbackFailure(
            'tool_crashed',
            `读回器未产出可解析的 JSON（退出码 ${String(done.status)}）`,
            `stdout=${stdout.slice(0, 2000)}\nstderr=${stderr.slice(0, 2000)}`,
          ),
        };
      }

      if (payload.ok !== true) {
        const error = payload.error ?? {};
        return {
          ok: false,
          failure: readbackFailure(
            mapFailureCode(error.code),
            error.message ?? `读回失败（退出码 ${String(done.status)}）`,
            `stdout=${stdout.slice(0, 2000)}`,
          ),
        };
      }

      const pages: PdfPageText[] = (payload.pages ?? []).map((page) => ({
        page: page.page ?? 0,
        text: page.text ?? '',
      }));

      return {
        ok: true,
        result: {
          path: payload.path ?? path,
          byteLength: payload.bytes ?? 0,
          sha256: payload.sha256 ?? '',
          magic: payload.magic ?? '',
          magicOk: payload.magic_ok === true,
          pdfVersion: payload.pdf_version ?? null,
          pageCount: payload.page_count ?? 0,
          encrypted: payload.encrypted === true,
          pages,
          textTruncated: payload.text_truncated === true,
          tool: payload.tool ?? 'pypdf',
        },
      };
    },
  };
}

function parseJson(text: string): ReadbackJson | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as ReadbackJson;
  } catch {
    return null;
  }
}

function readReport(path: string): ReadbackJson | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReadbackJson;
  } catch {
    return null;
  }
}
