/**
 * **被测源码树的摘要算法**（F11 / 合同 R38.1–R38.3）。
 *
 * 本文件是纯算法层：它只回答"给定仓库根与摘要域，被测源码的摘要是什么"，
 * **不**读取冻结点登记记录、**不**判断是否通过。身份与放行判定见
 * `tests/acceptance/freeze-identity.ts`。
 *
 * ---------------------------------------------------------------------------
 * ## 固定口径（R38.2：路径归一化 / 排序 / 字节编码 / 摘要域，逐条写死）
 *
 * 必须与历史 FREEZE-3 记录**逐字节**一致，否则会把历史正确的摘要误报成损坏（R38.3）。
 * 历史值由 Windows Git Bash 的下述命令产生，本实现复刻其全部可观察行为：
 *
 * ```sh
 * find src tests -name "*.ts" | sort | xargs sha256sum | sha256sum
 * find src      -name "*.ts" | sort | xargs sha256sum | sha256sum
 * ```
 *
 * 1. **摘要域**：`src/**` + `tests/**`（全量），或仅 `src/**`（src-only）。
 *    两者是**不同域，不可互相换算**。生成证据的 `freeze-identity.json` **不在域内**
 *    （它不是 `.ts`），因此"写下摘要"不会改变摘要（R32.1 自指问题）。
 * 2. **文件筛选**：`find -name "*.ts"`——即**条目名以 `.ts` 结尾**。`find` 的 `*`
 *    可以匹配前导点，故 `.hidden.ts` 也入选；`*` 可匹配空串，故名为 `.ts` 的文件同样入选。
 *    `find` 默认也会匹配名为 `*.ts` 的**目录**，但目录无法哈希；本实现只收**非目录条目**，
 *    并对此差异显式声明（当前仓库不存在此类目录）。
 * 3. **路径归一化**：相对于仓库根的 POSIX 路径（正斜杠），与 `find` 的打印一致；
 *    **不**去前导 `./`（`find src tests` 本身不打印 `./`）。不做大小写折叠、不做 Unicode 归一化。
 * 4. **排序**：按路径的 **UTF-8 字节序**升序（等价于 `LC_ALL=C sort`）。刻意**不用**
 *    JS 默认的 UTF-16 码元序——两者对非 ASCII 路径会分歧，用字节序才与 `sort` 一致。
 * 5. **每行编码**：`${sha256hex} *${path}\n`，UTF-8，无 BOM，行尾固定为 `\n`（LF，不是 CRLF）。
 *    ` *` 是 Windows Git 的 `sha256sum` 在**二进制模式**下的分隔符（`hash *path`）；
 *    在文本模式下它是两个空格（`hash  path`）。**本实现固定用 `*` 形式**，
 *    因为历史 FREEZE-3 由 Windows Git 产生——这正是 R38.3 要求"不得因换算法误报"的点。
 * 6. **整体摘要**：把第 5 步的全部行**按第 4 步的顺序直接拼接**（每行已含 `\n`），
 *    对拼接后的字节做 sha256。不额外添加分隔符、不添加结尾换行（最后一行自带）。
 *
 * 以上口径有**金标准向量**锁定（`tests/acceptance/p7p8/freeze-identity.test.ts` 的
 * `GOLDEN_FIXTURE`），该向量由上面第一条 shell 命令在真实夹具目录上跑出，与本实现比对。
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 全量摘要域：`find src tests -name "*.ts"`。 */
export const TREE_SCOPE_DIRS: readonly string[] = Object.freeze(['src', 'tests']);

/** 仅 src 摘要域：`find src -name "*.ts"`（与全量**不同域**）。 */
export const SRC_ONLY_SCOPE_DIRS: readonly string[] = Object.freeze(['src']);

/**
 * 会影响执行的配置 / 依赖清单（R38.2 的"单独可核对摘要"）。
 * 这些文件**不**在 `.ts` 摘要域内，若被改动，源码摘要不会变化——故单独登记一条摘要。
 */
export const CONFIG_MANIFEST_FILES: readonly string[] = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vitest.config.ts',
]);

/** 摘要口径的人读原文（证据 JSON 里逐字带上，便于独立复算者核对）。 */
export const DIGEST_ALGORITHM_NOTE =
  'line = `${sha256hex(file bytes)} *${posix-rel-path}\\n`; ' +
  'paths from `${dir}/**` entries whose name ends with ".ts", non-directory only; ' +
  'sorted by UTF-8 byte order (LC_ALL=C); lines concatenated as UTF-8 (LF, no BOM); ' +
  'overall = sha256(concatenation). Byte-identical to Windows Git ' +
  '`find <dirs> -name "*.ts" | sort | xargs sha256sum | sha256sum`.';

/** 一个被测文件的路径与内容摘要。 */
export interface SourceFileEntry {
  /** 相对仓库根的 POSIX 路径（正斜杠）。 */
  readonly path: string;
  /** 该文件**内容字节**的 sha256（小写十六进制）。 */
  readonly sha256: string;
}

/** 一次摘要计算的结果（文件清单 + 整体摘要）。 */
export interface SourceTreeDigest {
  /** 摘要域目录清单（相对仓库根）。 */
  readonly scope: readonly string[];
  /** 参与摘要的文件清单，已按口径排序。 */
  readonly files: readonly SourceFileEntry[];
  /** 整体摘要（sha256，小写十六进制）。 */
  readonly sha256: string;
}

/** 字节 / 字符串的 sha256（小写十六进制）。 */
export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** UTF-8 字节序比较（等价于 `LC_ALL=C sort`）。 */
export function compareByByteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** `find <dir> -name "*.ts"` 的条目判据：名字以 `.ts` 结尾（`*` 允许前导点与空串）。 */
function matchesTsName(name: string): boolean {
  return name.endsWith('.ts');
}

/**
 * 列出摘要域内的相对路径（POSIX 正斜杠），已排序。
 *
 * 递归 **不** 跟随目录符号链接（`find` 默认也不跟随目录链接）；
 * 非目录条目（普通文件、指向文件的符号链接）只要名字匹配即入选。
 */
export function listTsFilesSorted(root: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (absoluteDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      // 目录不存在等价于空集：`find <missing>` 会报错并非零退出，但这里按"该域为空"处理，
      // 由上层（登记记录）决定域是否应当存在。
      return;
    }
    for (const entry of entries) {
      const absolute = join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!matchesTsName(entry.name)) continue;
      // 只收非目录条目（find 也会打印同名目录，但目录无法哈希）。
      let isDirectory = false;
      try {
        isDirectory = statSync(absolute).isDirectory();
      } catch {
        isDirectory = true; // 读不到的条目不参与摘要
      }
      if (isDirectory) continue;
      out.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  out.sort(compareByByteOrder);
  return out;
}

/** 按口径编码每行：`${sha256hex} *${path}\n`（UTF-8，LF）。 */
export function encodeDigestLines(entries: readonly SourceFileEntry[]): Buffer {
  return Buffer.from(
    entries.map((entry) => `${entry.sha256} *${entry.path}\n`).join(''),
    'utf8',
  );
}

/**
 * **纯函数**：从文件清单算出整体摘要（内部按字节序排序，故入参顺序不影响结果）。
 *
 * 单测用**注入清单**构造"域内新增 / 删除 / 重命名"，无需真的改动仓库源码。
 */
export function digestFromEntries(entries: readonly SourceFileEntry[]): string {
  const sorted = [...entries].sort((a, b) => compareByByteOrder(a.path, b.path));
  return sha256Hex(encodeDigestLines(sorted));
}

/** 读取给定域内的全部 `.ts` 文件并计算摘要（真实文件系统）。 */
export function computeSourceTreeDigest(
  root: string,
  dirs: readonly string[],
): SourceTreeDigest {
  const paths = listTsFilesSorted(root, dirs);
  const files: SourceFileEntry[] = paths.map((path) => ({
    path,
    sha256: sha256Hex(readFileSync(join(root, ...path.split('/')))),
  }));
  return Object.freeze({
    scope: Object.freeze([...dirs]),
    files: Object.freeze(files),
    // 入参已排序，digestFromEntries 再排一次是幂等的（纯函数入口统一走它）。
    sha256: digestFromEntries(files),
  });
}

/** 全量（`src` + `tests`）摘要。 */
export function computeTreeDigest(root: string): SourceTreeDigest {
  return computeSourceTreeDigest(root, TREE_SCOPE_DIRS);
}

/** 仅 `src` 摘要（**与全量不同域，不可比较**）。 */
export function computeSrcOnlyDigest(root: string): SourceTreeDigest {
  return computeSourceTreeDigest(root, SRC_ONLY_SCOPE_DIRS);
}

/**
 * 配置 / 依赖清单的**独立**摘要（R38.2）。
 *
 * 与源码摘要**同一编码口径**，但域是 `CONFIG_MANIFEST_FILES` 中**实际存在**的那些文件。
 * 缺失的文件在结果里以 `present: false` 显式标出，不静默跳过——否则"删掉 lockfile
 * 来让摘要匹配"就成了绕过路径。
 */
export function computeConfigDigest(root: string): {
  readonly files: readonly (SourceFileEntry & { readonly present: boolean })[];
  readonly sha256: string;
} {
  const present: SourceFileEntry[] = [];
  const files: (SourceFileEntry & { present: boolean })[] = [];
  for (const path of CONFIG_MANIFEST_FILES) {
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(join(root, ...path.split('/')));
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      files.push({ path, sha256: '', present: false });
      continue;
    }
    const digest = sha256Hex(bytes);
    present.push({ path, sha256: digest });
    files.push({ path, sha256: digest, present: true });
  }
  return Object.freeze({
    files: Object.freeze(files),
    sha256: digestFromEntries(present),
  });
}
