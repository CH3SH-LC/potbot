/**
 * **独立读回**（design-02 A 批；合同 v1.4 R53.1 第二层）。
 *
 * ## 为什么不能用我们自己的代码读回
 *
 * 内核侧已有"结构自检"，但它与我们自己的 ZIP/XML **写入器同源**——用它读回只能证明
 * "构建器内部自洽"，证明不了容器格式本身是对的。因此这一层刻意**换实现、换语言**：
 * Python 的 `zipfile` + `xml.etree.ElementTree`（标准库）与 Info-ZIP 的 `unzip -t`。
 *
 * ## 这一层能证明什么、不能证明什么（**不得混淆**）
 *
 * - **能**：ZIP 容器结构合法（CRC 逐条自校验）、每个 XML 部件可被独立 XML 解析器解析、
 *   部件与关系引用自洽、**关键文本可按任务版本比对**、无 BOM。
 * - **不能**：Word / Excel / PowerPoint 能打开它。那是第三层（`office-open-check.ts`）。
 *
 * ## 编码纪律
 *
 * Windows 上 Python 的 stdout 默认随代码页（GBK）转码，中文会烂掉。因此：
 * 用 `json.dumps(..., ensure_ascii=True)`（输出全 ASCII，中文件转成 `\uXXXX`），
 * 并同时设 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` 作为双保险。
 */

import { execFileSync } from 'node:child_process';

import type { ResolvedTool } from './toolchain.js';

/** 单个 ZIP 条目（独立读回所见，用于与写入器自报的数对照）。 */
export interface ReadbackEntry {
  readonly name: string;
  readonly size: number;
  readonly crc32: number;
}

export interface ReadbackXmlProblem {
  readonly name: string;
  readonly error: string;
}

/** 独立读回结果（**确定性**：不含时间戳，不含墙钟）。 */
export interface ReadbackResult {
  /** `zipfile.testzip()` 通过、`unzip -t` 退出码 0、且无 XML 解析失败。 */
  readonly ok: boolean;
  readonly path: string;
  readonly entries: readonly ReadbackEntry[];
  /** `testzip()` 报出的第一个坏条目（`null` = 全好）。 */
  readonly bad_entry: string | null;
  readonly xml_problems: readonly ReadbackXmlProblem[];
  /** 部件名 → 该部件全部文本节点拼接（断言"关键内容符合任务版本"的素材）。 */
  readonly part_text: Readonly<Record<string, string>>;
  /** 部件名 → 该部件是否以 UTF-8 BOM 开头（**必须全 false**）。 */
  readonly part_has_bom: Readonly<Record<string, boolean>>;
  /** `.rels` 部件名 → 其声明的 `Target` 列表（用于断言关系自洽）。 */
  readonly rels_targets: Readonly<Record<string, readonly string[]>>;
  /** `unzip -t` 的独立结论。 */
  readonly unzip_test: {
    readonly exit_code: number;
    readonly stdout_tail: string;
  };
  readonly python: {
    readonly via: string;
    readonly executable: string;
    readonly version: string;
  };
  readonly unzip: {
    readonly via: string;
    readonly executable: string;
    readonly version: string;
  };
}

/**
 * 内嵌的 Python 读回脚本：`sys.argv[1]` 是待读文件。
 * 只依赖标准库；输出**单行 JSON**（`ensure_ascii=True`，全 ASCII）。
 */
const READBACK_SCRIPT = String.raw`
import json, sys, zipfile, xml.etree.ElementTree as ET

path = sys.argv[1]
out = {"entries": [], "bad_entry": None, "xml_problems": [], "part_text": {},
       "part_has_bom": {}, "rels_targets": []}
with zipfile.ZipFile(path) as zf:
    out["bad_entry"] = zf.testzip()
    for info in zf.infolist():
        out["entries"].append({"name": info.filename, "size": info.file_size,
                               "crc32": info.CRC})
        raw = zf.read(info.filename)
        if info.filename.endswith(".xml") or info.filename.endswith(".rels"):
            out["part_has_bom"][info.filename] = raw.startswith(b"\xef\xbb\xbf")
            try:
                root = ET.fromstring(raw)
            except Exception as exc:
                out["xml_problems"].append({"name": info.filename, "error": str(exc)})
                continue
            text = "".join(root.itertext())
            out["part_text"][info.filename] = text
            if info.filename.endswith(".rels"):
                targets = [el.get("Target") for el in root.iter()
                           if el.tag.endswith("Relationship") and el.get("Target")]
                out["rels_targets"].append({"name": info.filename, "targets": targets})
print(json.dumps(out, ensure_ascii=True, sort_keys=True))
`;

interface PythonRaw {
  readonly entries: readonly ReadbackEntry[];
  readonly bad_entry: string | null;
  readonly xml_problems: readonly ReadbackXmlProblem[];
  readonly part_text: Readonly<Record<string, string>>;
  readonly part_has_bom: Readonly<Record<string, boolean>>;
  readonly rels_targets: readonly { readonly name: string; readonly targets: readonly string[] }[];
}

function tail(text: string, limit = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}

/**
 * 用 Python + `unzip -t` **独立读回**一个产物。
 *
 * @throws {Error} 工具本身跑不起来时（脚本语法错、文件不可读）。**工具不可用**是另一回事——
 *   那由 `requireToolchain()` 在调用前就抛 `ToolchainUnavailableError`。
 */
export function readbackArtifact(
  tools: { readonly python: ResolvedTool; readonly unzip: ResolvedTool },
  absolutePath: string,
): ReadbackResult {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

  const stdout = execFileSync(tools.python.executable, ['-c', READBACK_SCRIPT, absolutePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    windowsHide: true,
    env,
  });

  const raw = JSON.parse(stdout.trim()) as PythonRaw;

  let unzipExitCode = -1;
  let unzipStdout = '';
  try {
    unzipStdout = execFileSync(tools.unzip.executable, ['-t', absolutePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    });
    unzipExitCode = 0;
  } catch (error) {
    const withStdout = error as { status?: number | null; stdout?: unknown };
    unzipExitCode = typeof withStdout.status === 'number' ? withStdout.status : 1;
    unzipStdout = typeof withStdout.stdout === 'string' ? withStdout.stdout : String(error);
  }

  const relsTargets: Record<string, readonly string[]> = {};
  for (const entry of raw.rels_targets) {
    relsTargets[entry.name] = Object.freeze([...entry.targets]);
  }

  return Object.freeze({
    ok:
      raw.bad_entry === null &&
      raw.xml_problems.length === 0 &&
      unzipExitCode === 0 &&
      Object.values(raw.part_has_bom).every((flagged) => !flagged),
    path: absolutePath,
    entries: Object.freeze([...raw.entries]),
    bad_entry: raw.bad_entry,
    xml_problems: Object.freeze([...raw.xml_problems]),
    part_text: Object.freeze({ ...raw.part_text }),
    part_has_bom: Object.freeze({ ...raw.part_has_bom }),
    rels_targets: Object.freeze(relsTargets),
    unzip_test: Object.freeze({ exit_code: unzipExitCode, stdout_tail: tail(unzipStdout) }),
    python: Object.freeze({
      via: tools.python.via,
      executable: tools.python.executable,
      version: tools.python.version,
    }),
    unzip: Object.freeze({
      via: tools.unzip.via,
      executable: tools.unzip.executable,
      version: tools.unzip.version,
    }),
  });
}

/** 全部 XML 部件的文本拼一起（断言"某个数字/名字出现在产物里"时用）。 */
export function allPartText(result: ReadbackResult): string {
  return Object.values(result.part_text).join('\n');
}

/** 部件名清单（升序；便于跨次运行比对，不受 ZIP 内顺序影响）。 */
export function partNames(result: ReadbackResult): readonly string[] {
  return Object.freeze(result.entries.map((entry) => entry.name).sort());
}
