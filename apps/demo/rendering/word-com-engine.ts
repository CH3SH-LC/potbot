/**
 * {@link PdfEngine} 的**真实实现**：驱动本机 Microsoft Word 的 COM `ExportAsFixedFormat`。
 *
 * 这是 WF-089 在本机**唯一实测可用**的真实排版引擎路线（WCF-D06：本机无 LibreOffice、无 WPS，
 * 只有 `C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE`，16.0.20430，未授权但 COM 可用）。
 *
 * ## 平台边界（**必须**随交付带出）
 *
 * Word COM 是 **Windows 桌面专属**。目标平台是 **Android**，二者不等价。
 * 本实现**只覆盖电脑侧**；手机端 PDF 导出**未实现、未验证**。
 *
 * ## 超时与孤儿进程
 *
 * `ExportAsFixedFormat` 是阻塞的，无法从 python 内部中断，所以超时在**这里**用
 * `spawnSync` 的 `timeout` 实现。Python 侧把 `word_pid` **分阶段增量写**进报告文件，
 * 因此超时后我们能读到它并 `taskkill /F /PID`——**只杀我们起的那个 Word**，
 * 绝不 `IM WINWORD.EXE`（那会连用户自己打开的文档一起杀）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  engineFailure,
  isPdfEngineFailureKind,
  type PdfEngine,
  type PdfEngineFailureKind,
  type PdfEngineIdentity,
  type PdfEngineOutcome,
  type PdfEngineRequest,
} from './pdf-engine.js';

/** 引擎脚本相对本模块的位置。 */
const DEFAULT_SCRIPT = resolve(import.meta.dirname, 'python', 'word-export-pdf.py');

export interface WordComEngineOptions {
  /** Python 解释器；默认按环境变量 → 本机实测路径 → PATH 顺序解析。 */
  readonly pythonPath?: string;
  /** 引擎脚本路径；默认 {@link DEFAULT_SCRIPT}。 */
  readonly scriptPath?: string;
  /** 报告文件目录；默认 `%TEMP%/potbot-pdf-export`（**不污染仓库**）。 */
  readonly reportDir?: string;
}

/** 本机 Python 解释器：环境变量 → 工程实测路径 → PATH 上的 `python`。 */
export function pythonExecutable(): string {
  const fromEnv = process.env['DEMO_PYTHON'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const known = 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
  if (existsSync(known)) return known;
  return 'python';
}

/** 引擎脚本内部返回的报告形状（只声明我们用到的字段）。 */
interface EngineReport {
  readonly ok?: boolean;
  readonly stage?: string;
  readonly word_pid?: number | null;
  readonly engine?: { name?: string; version?: string; build?: string; route?: string };
  readonly license?: { state?: string; evidence?: string; unlicensed_but_usable_observed?: boolean };
  readonly failure?: { kind?: string; message?: string; traceback?: string };
  readonly output?: { path?: string; bytes?: number; sha256?: string; magic?: string; magic_ok?: boolean };
  readonly cleanup?: string;
  readonly timing?: Record<string, number>;
}

function readReport(path: string): EngineReport | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EngineReport;
  } catch {
    return null;
  }
}

/** 杀掉我们记录在案的 Word 进程（按 PID）。返回一行证据文本。 */
function killWordByPid(pid: number | null | undefined): string {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return 'skip: 报告里没有可用 word_pid';
  }
  const done = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true });
  const text = `${done.stdout ?? ''}${done.stderr ?? ''}`.trim().replace(/\r?\n/g, ' ');
  return `taskkill /F /PID ${pid} -> rc=${String(done.status)} ${text}`;
}

function identityOf(report: EngineReport): PdfEngineIdentity {
  const engine = report.engine ?? {};
  const license = report.license ?? {};
  return {
    name: engine.name ?? '(未报告)',
    version: engine.version ?? '(未报告)',
    build: engine.build ?? '(未报告)',
    route: engine.route ?? 'microsoft-word-com/ExportAsFixedFormat',
    platform: 'windows-desktop',
    license: {
      state: license.state === 'licensed' || license.state === 'unlicensed' ? license.state : 'unknown',
      evidence: license.evidence ?? '',
      unlicensedButUsableObserved: license.unlicensed_but_usable_observed === true,
    },
  };
}

function asKind(value: string | undefined): PdfEngineFailureKind {
  if (value !== undefined && isPdfEngineFailureKind(value)) return value;
  return 'engine_error';
}

export function createWordComPdfEngine(options: WordComEngineOptions = {}): PdfEngine {
  const python = options.pythonPath ?? pythonExecutable();
  const script = options.scriptPath ?? DEFAULT_SCRIPT;
  const reportDir = options.reportDir
    ?? process.env['POTBOT_PDF_REPORT_DIR']
    ?? join(tmpdir(), 'potbot-pdf-export');

  const run = (args: readonly string[], timeoutMs: number) =>
    spawnSync(python, [script, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });

  return {
    async probe(): Promise<PdfEngineIdentity | null> {
      if (!existsSync(script)) return null;
      const reportPath = join(mkdtempSafe(reportDir), 'probe.json');
      const done = run(['--probe', '--report', reportPath], 120_000);
      const report = readReport(reportPath);
      if (report === null || report.ok !== true) return null;
      const identity = identityOf(report);
      void done;
      return identity;
    },

    async export(request: PdfEngineRequest): Promise<PdfEngineOutcome> {
      const started = Date.now();
      if (!existsSync(script)) {
        return {
          ok: false,
          failure: engineFailure('engine_unavailable', `引擎脚本不存在：${script}`),
          durationMs: Date.now() - started,
          raw: '',
        };
      }

      const reportPath = join(mkdtempSafe(reportDir), 'export.json');
      const done = run(
        [request.sourceDocxPath, request.targetPdfPath, '--report', reportPath],
        request.timeoutMs,
      );
      const stdout = done.stdout ?? '';
      const stderr = done.stderr ?? '';
      let report = readReport(reportPath);

      // 超时：spawnSync 用 SIGTERM 收掉 python，但 Word 是**另一个进程**，必须按 PID 清。
      const timedOut = done.error !== undefined
        && (done.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      if (timedOut) {
        const cleanup = killWordByPid(report?.word_pid);
        return {
          ok: false,
          failure: engineFailure(
            'engine_timeout',
            `引擎在 ${request.timeoutMs}ms 内未返回`,
            `${cleanup}\nstdout=${stdout.slice(0, 2000)}\nstderr=${stderr.slice(0, 2000)}`,
          ),
          durationMs: Date.now() - started,
          raw: JSON.stringify({ timedOut: true, cleanup, stdout, stderr, report }),
        };
      }

      if (report === null) {
        // 连报告都没写出来 ⇒ 引擎在起 Word 之前就失败了（python 缺失 / 脚本语法错）。
        const kind: PdfEngineFailureKind = done.error !== undefined ? 'engine_unavailable' : 'engine_error';
        return {
          ok: false,
          failure: engineFailure(
            kind,
            done.error !== undefined
              ? `引擎脚本无法执行：${(done.error as NodeJS.ErrnoException).message}`
              : `引擎未产出报告（退出码 ${String(done.status)}）`,
            `stdout=${stdout.slice(0, 2000)}\nstderr=${stderr.slice(0, 2000)}`,
          ),
          durationMs: Date.now() - started,
          raw: JSON.stringify({ status: done.status, stdout, stderr }),
        };
      }

      if (report.ok !== true) {
        const failure = report.failure ?? {};
        return {
          ok: false,
          failure: engineFailure(
            asKind(failure.kind),
            failure.message ?? `引擎失败（stage=${report.stage ?? '?'}）`,
            `${failure.traceback ?? ''}${report.cleanup ? `\ncleanup=${report.cleanup}` : ''}`.trim()
              || undefined,
          ),
          durationMs: Date.now() - started,
          raw: JSON.stringify(report),
        };
      }

      // 引擎侧还做一次**自报**的魔数核对；读回器会**独立**再核一次（两层都要）。
      const output = report.output ?? {};
      return {
        ok: true,
        identity: identityOf(report),
        artifact: {
          path: output.path ?? request.targetPdfPath,
          byteLength: output.bytes ?? 0,
          magic: output.magic ?? '',
          magicOk: output.magic_ok === true,
        },
        durationMs: Date.now() - started,
        raw: JSON.stringify(report),
      };
    },
  };
}

/** 每个产物一个独立临时目录（默认在 `%TEMP%` 下，**不污染仓库**）。 */
function mkdtempSafe(parent: string): string {
  try {
    mkdirSync(parent, { recursive: true });
    return mkdtempSync(join(parent, 'run-'));
  } catch {
    return mkdtempSync(join(tmpdir(), 'potbot-pdf-'));
  }
}
