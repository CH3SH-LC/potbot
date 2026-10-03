/**
 * **W-R05 live 消费端重开派生器**（测试侧宿主）——在**测试运行时**真的调用 python-docx
 * 打开并另存真实语料 `source-corpusA.docx`，把产出字节交回给测试。
 *
 * ## 为什么需要它
 *
 * `real-corpus/consumer-python-docx-1.2.0.docx` 是**已提交**的独立消费端重开产物。只比对
 * 已提交的字节，只能证明「提交的那份文件没被改」，**不能**证明「它可被重新派生」（即那份
 * 字节确实来自文档记录的那条命令）。本模块把那条命令在测试时**重跑一遍**，让
 * 「消费端重开」从一个**静态 fixture** 变成一个**可复现的动作**。
 *
 * 复现命令（与原 fixture 的来源命令一致，仅本地、无网络、无密钥）：
 * ```
 * python -c "from docx import Document; Document('source-corpusA.docx').save(<out>)"
 * ```
 *
 * ## 守卫与如实标注
 *
 * - 找不到可用 python（或没有 `python-docx`）时，**不抛异常**，返回 `available:false` 并给出
 *   **具体原因**；测试据此 `ctx.skip(reason)`，不虚报成功。
 * - 设 `WR05_FORCE_NO_PYTHON=1` 可**强制**走不可用分支——用于在环境里有 python 时也能
 *   实跑一遍「守卫确实干净跳过」的路径（否则该分支永远不被执行）。
 * - 这是**测试侧宿主**，允许 `node:*`；`verifier/**` 核心仍保持零 `node:*`。
 *
 * ## 一个重要事实（本增量实测发现）
 *
 * python-docx 给 ZIP 条目写入的是**运行时刻**（DOS date/time，2 秒粒度），因此
 * **整体容器字节逐次不同**；但**解压后的部件内容字节完全一致**。所以「可复现」的判据是
 * **部件级 digest**，不是容器级整体 sha256（详见 `live-reopen.test.ts` 的注释与断言）。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRealCorpusManifest } from './real-corpus.js';

/** 探测解释器与 `python-docx` 是否就绪；输出 JSON 便于稳定解析。 */
const PROBE_SCRIPT = [
  'import json, sys',
  'try:',
  '    import docx',
  'except Exception as exc:',
  '    print(json.dumps({"ok": False, "error": "import docx failed: %s" % exc}))',
  '    sys.exit(0)',
  'version = getattr(docx, "__version__", None)',
  'if not version:',
  '    try:',
  '        import importlib.metadata as md',
  '        version = md.version("python-docx")',
  '    except Exception:',
  '        version = "unknown"',
  'print(json.dumps({"ok": True, "python": sys.version.split()[0], "docx": version}))',
].join('\n');

/** 真正执行「打开→另存」，argv[1]=源，argv[2]=产物。 */
const REOPEN_SCRIPT = [
  'import sys',
  'from docx import Document',
  'Document(sys.argv[1]).save(sys.argv[2])',
].join('\n');

/** 候选解释器名，按平台排序（Windows 上 `python` 优先，避免 Store 版 `python3` 别名）。 */
const EXECUTABLES: readonly string[] =
  process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];

const PROBE_TIMEOUT_MS = 30_000;
const REOPEN_TIMEOUT_MS = 60_000;

export interface PythonReopenOutcome {
  /** 是否真的跑完了一次 python-docx 打开→另存。 */
  readonly available: boolean;
  /** 不可用时是具体 skip 原因；可用时是一条如实的说明。 */
  readonly reason: string;
  readonly executable: string | null;
  readonly pythonVersion: string | null;
  readonly pythonDocxVersion: string | null;
  readonly elapsedMs: number;
  /** 产出字节（`available` 为 true 时非空）。 */
  readonly bytes: Uint8Array | null;
}

interface ProbeSuccess {
  readonly executable: string;
  readonly pythonVersion: string;
  readonly docxVersion: string;
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
}

function truncate(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function run(executable: string, args: readonly string[]): CommandResult {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    timeout: REOPEN_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? result.error.message : null,
  };
}

type ProbeOutcome = { readonly ok: true; readonly value: ProbeSuccess } | { readonly ok: false; readonly reason: string };

function probe(): ProbeOutcome {
  const failures: string[] = [];
  for (const executable of EXECUTABLES) {
    const result = run(executable, ['-c', PROBE_SCRIPT]);
    if (result.error) {
      failures.push(`${executable}: ${result.error}`);
      continue;
    }
    if (result.status !== 0) {
      failures.push(`${executable}: exit ${String(result.status)} ${truncate(result.stderr, 160)}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      failures.push(`${executable}: probe output not JSON`);
      continue;
    }
    const record = parsed as { ok?: boolean; error?: string; python?: string; docx?: string };
    if (record.ok !== true) {
      failures.push(`${executable}: ${record.error ?? 'import docx failed'}`);
      continue;
    }
    return {
      ok: true,
      value: {
        executable,
        pythonVersion: String(record.python ?? ''),
        docxVersion: String(record.docx ?? ''),
      },
    };
  }
  return {
    ok: false,
    reason: failures.length > 0 ? failures.join('; ') : 'no python interpreter found on PATH',
  };
}

function unavailable(reason: string, startedAt: number, partial: Partial<PythonReopenOutcome> = {}): PythonReopenOutcome {
  return {
    available: false,
    reason,
    executable: partial.executable ?? null,
    pythonVersion: partial.pythonVersion ?? null,
    pythonDocxVersion: partial.pythonDocxVersion ?? null,
    elapsedMs: Date.now() - startedAt,
    bytes: null,
  };
}

function derive(): PythonReopenOutcome {
  const startedAt = Date.now();

  if (process.env.WR05_FORCE_NO_PYTHON === '1') {
    return unavailable(
      'forced unavailable for guard-path verification (WR05_FORCE_NO_PYTHON=1)',
      startedAt,
    );
  }

  const probed = probe();
  if (!probed.ok) {
    return unavailable(probed.reason, startedAt);
  }
  const { executable, pythonVersion, docxVersion } = probed.value;

  const manifest = loadRealCorpusManifest();
  const sourcePath = fileURLToPath(new URL(`./real-corpus/${manifest.source.file}`, import.meta.url));

  const dir = mkdtempSync(join(tmpdir(), 'wr05-live-'));
  const outputPath = join(dir, 'consumer-reopen.docx');
  try {
    const result = run(executable, ['-c', REOPEN_SCRIPT, sourcePath, outputPath]);
    if (result.error) {
      return unavailable(`${executable}: ${result.error}`, startedAt, {
        executable,
        pythonVersion,
        pythonDocxVersion: docxVersion,
      });
    }
    if (result.status !== 0) {
      return unavailable(
        `${executable} reopen exited ${String(result.status)}: ${truncate(result.stderr, 300)}`,
        startedAt,
        { executable, pythonVersion, pythonDocxVersion: docxVersion },
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(outputPath));
    } catch (error) {
      return unavailable(
        `reopen produced no readable file: ${error instanceof Error ? error.message : String(error)}`,
        startedAt,
        { executable, pythonVersion, pythonDocxVersion: docxVersion },
      );
    }
    return {
      available: true,
      reason: `python-docx open+save re-derivation succeeded (${executable}, python ${pythonVersion}, python-docx ${docxVersion})`,
      executable,
      pythonVersion,
      pythonDocxVersion: docxVersion,
      elapsedMs: Date.now() - startedAt,
      bytes,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let cached: PythonReopenOutcome | undefined;

/**
 * 返回一次 python-docx 打开→另存的结果（**记忆化**：整个测试文件只跑一次 python）。
 *
 * 任何失败都收敛成 `available:false` + 具体 `reason`，绝不抛异常——保证「python-docx 缺失」
 * 走的是**干净跳过**而非文件级报错。
 */
export function deriveConsumerReopen(): PythonReopenOutcome {
  if (cached === undefined) {
    cached = derive();
  }
  return cached;
}

/** 仅测试用：清空记忆化（正常流程无需调用）。 */
export function resetConsumerReopenCache(): void {
  cached = undefined;
}
