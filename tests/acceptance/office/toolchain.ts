/**
 * **独立验证工具的门禁**（design-02 A 批；合同 v1.4 R53.2 / R53.3）。
 *
 * ## 为什么要一个"门"而不是"检测到就跳过"
 *
 * design-02 的 P1 要求产物**交付前经实际生成工具与检查流程验证**，并且把
 * "用模拟结果冒充实测结论"列为**不达标**。因此"本机没有 Python / unzip"这件事
 * **不能**降级成 `skip` / `todo` —— 那等于静默地把判据换成恒真。
 *
 * 本模块的语义是：**要么拿到可用的工具并记录它到底是什么，要么显式抛错**。
 * 抛出的错误必须写明：缺什么、试过哪些候选、因此哪条判据无法成立。
 *
 * ## 为什么必须记录**实际解释器**
 *
 * 本机实测有两个不同的 Python：`python` → `…\Python313\python.exe`（3.13.13），
 * `py -3` → **3.14.4**。只写"用了 python"是不够的——证据里必须能看出到底是哪一个，
 * 否则换机器跑出来的结论无法归因。因此 `ResolvedTool` 记录**候选命令原文 + 实际解释器路径 + 版本**。
 *
 * ## 本模块刻意不做的事
 *
 * - **不写墙钟时间**：产物与其证据的可复现性已经因为 `executed_at_utc` 吃过一次亏
 *   （W3 记录的 N2）。工具信息因此**不含时间戳**，只含可复算的路径与版本。
 * - 不 import 任何 `src/**`：验收侧独立于被测内核。
 */

import { execFileSync } from 'node:child_process';

/** 一个**已解析**的工具：怎么调、自述是什么、版本几。 */
export interface ResolvedTool {
  /** 候选命令原文（证据里要写清"用哪个命令解析到的"）。 */
  readonly via: string;
  /** **实际调用的**命令或路径（就是 spawn 用的那个；不是工具自述）。 */
  readonly executable: string;
  /** 工具自述的绝对路径（Python 的 `sys.executable`；unzip 在拿不到时为 `null`）。 */
  readonly resolved_path: string | null;
  /** 自述版本字符串。 */
  readonly version: string;
  /** 自述原文（取证：换机器时能看出到底跑的是哪一个）。 */
  readonly self_report: string;
  /** 试过但失败的候选（保留取证：为什么最后落到这个）。 */
  readonly rejected_candidates: readonly string[];
}

/** 独立验证工具不可用（**不是**"跳过"的理由）。 */
export class ToolchainUnavailableError extends Error {
  readonly missing: readonly string[];
  readonly tried: readonly string[];

  constructor(tool: string, tried: readonly string[], detail: string) {
    super(
      `独立验证工具不可用：缺少 ${tool}。已尝试的候选：${tried.join(' / ') || '（无）'}。` +
        `因此 design-02-P1 的「独立读回」判据**无法成立**——` +
        `按合同 v1.4 R53.3，此时不得跳过或降级，必须显式失败。` +
        `细节：${detail}`,
    );
    this.name = 'ToolchainUnavailableError';
    this.missing = Object.freeze([tool]);
    this.tried = Object.freeze([...tried]);
  }
}

export interface ToolchainInfo {
  readonly python: ResolvedTool;
  readonly unzip: ResolvedTool;
}

const PROBE_TIMEOUT_MS = 30_000;

/** 跑一个候选：成功返回 stdout，失败返回 `{ error }`（不抛）。 */
function tryExec(
  exe: string,
  args: readonly string[],
): { readonly stdout: string } | { readonly error: string } {
  try {
    const stdout = execFileSync(exe, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return { stdout };
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    const message = error instanceof Error ? error.message : String(error);
    return { error: `${message}${stderr === '' ? '' : ` | stderr: ${stderr.trim().slice(0, 200)}`}` };
  }
}

/** 依次尝试候选，返回第一个跑得通的（带自述 stdout）。全失败即抛。 */
function firstWorking(
  tool: string,
  candidates: readonly { readonly via: string; readonly exe: string; readonly args: readonly string[] }[],
): { readonly via: string; readonly exe: string; readonly stdout: string; readonly rejected: readonly string[] } {
  const rejected: string[] = [];
  for (const candidate of candidates) {
    const result = tryExec(candidate.exe, candidate.args);
    if ('error' in result) {
      rejected.push(`${candidate.via}（${result.error}）`);
      continue;
    }
    return { via: candidate.via, exe: candidate.exe, stdout: result.stdout, rejected };
  }
  throw new ToolchainUnavailableError(
    tool,
    candidates.map((candidate) => candidate.via),
    rejected.length === 0 ? '没有任何候选可用' : rejected.join(' ; '),
  );
}

/**
 * Python 候选：**优先 `python`**（合同 R53.2 钉的就是它，本机是 3.13.13 的具名安装），
 * 其次 `py -3`（本机是 **3.14.4** —— 与前者不同，所以落回时必须如实记录）。
 *
 * 自检脚本同时导入 `zipfile` / `xml.etree.ElementTree` / `hashlib`：
 * 只验证"解释器在"是不够的，独立读回真正依赖的是这三个标准库模块。
 */
const PYTHON_PROBE =
  'import sys, zipfile, xml.etree.ElementTree as ET, hashlib;' +
  'print(sys.executable);print(sys.version.split()[0])';

const PYTHON_CANDIDATES = Object.freeze([
  { via: 'python', exe: 'python', args: ['-c', PYTHON_PROBE] as const },
  { via: 'py -3', exe: 'py', args: ['-3', '-c', PYTHON_PROBE] as const },
]);

/**
 * unzip 候选：先命令名（本机 `C:\Program Files\Git\usr\bin\unzip.exe` 在 PATH 里），
 * 再 Git 的常见安装位置（Node 进程的 PATH 未必与 Git Bash 相同，这条路是兜底）。
 */
const UNZIP_CANDIDATES = Object.freeze([
  { via: 'unzip', exe: 'unzip', args: ['-v'] as const },
  {
    via: 'C:\\Program Files\\Git\\usr\\bin\\unzip.exe',
    exe: 'C:\\Program Files\\Git\\usr\\bin\\unzip.exe',
    args: ['-v'] as const,
  },
]);

/** 解析 Python（**优先 `python`**，落回 `py -3` 时把实际解释器记进证据）。 */
export function resolvePython(): ResolvedTool {
  const working = firstWorking('Python 解释器（独立读回用）', PYTHON_CANDIDATES);
  const lines = working.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const executable = lines[0];
  if (executable === undefined) {
    throw new ToolchainUnavailableError(
      'Python 解释器（独立读回用）',
      PYTHON_CANDIDATES.map((candidate) => candidate.via),
      `解释器自述输出无法解析：${JSON.stringify(working.stdout.slice(0, 200))}`,
    );
  }
  return Object.freeze({
    via: working.via,
    executable: working.exe,
    resolved_path: executable,
    version: lines[1] ?? 'unknown',
    self_report: executable,
    rejected_candidates: Object.freeze([...working.rejected]),
  });
}

/**
 * 解析 `unzip`。
 *
 * **`executable` 记的是实际调用的命令**（`unzip` 或绝对路径），**不是**自述首行——
 * `unzip -v` 的首行是版本横幅（`UnZip 6.00 of 20 April 2009, by Info-ZIP.`），
 * 早期版本错把它当成路径去 spawn，得到 `ENOENT`。自述另存 `self_report`。
 */
export function resolveUnzip(): ResolvedTool {
  const working = firstWorking('unzip（独立校验 ZIP 容器用）', UNZIP_CANDIDATES);
  const banner =
    working.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('UnZip')) ?? working.stdout.trim().slice(0, 100);
  return Object.freeze({
    via: working.via,
    executable: working.exe,
    resolved_path: null,
    version: banner,
    self_report: banner,
    rejected_candidates: Object.freeze([...working.rejected]),
  });
}

/**
 * **工具门**：取齐两个工具，取不齐就抛 `ToolchainUnavailableError`。
 *
 * 调用方（验收夹具）**不得**捕获它去 `skip`——只能在失败信息里如实呈现，
 * 并把 P1 判为不成立。
 */
export function requireToolchain(): ToolchainInfo {
  return Object.freeze({ python: resolvePython(), unzip: resolveUnzip() });
}
