/**
 * FA-FIX-NUL-BYTES —— **裸 NUL 字节扫描器**（独立自研，不复用实现方任何工具）。
 *
 * ## 为什么需要它
 *
 * 源码里出现**真正的 0x00 字节**（而非转义写法）时，git 的二进制探测会把该文件判为
 * 二进制（`git ls-files --eol` 显示 `-text`）。后果是**灾难性的**：
 * - 没有**行级**三方合并——冲突只能整份取边；
 * - `git diff` / review 对该文件失效。
 * 在一个「多 worktree 并行、最后合并」的仓里，这是真实风险面。
 *
 * 本扫描器只认**字节**：把文件按原始字节读入，逐字节找 `0x00`。它**不**依赖任何
 * 字符串解码，因此不受编码 / 转义写法影响——这正是它能在「转义写法合法、裸字节非法」
 * 之间做出**判别**的原因。
 *
 * ## 边界
 *
 * - 只扫**源码扩展名**（见 `SOURCE_EXT`）：真正的二进制资产（图片 / docx / 编译产物）
 *   不在此列，避免误报。
 * - 跳过依赖与生成目录（`SKIP_DIRS`）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 视为「源码」的扩展名：只扫这些，避免把真正的二进制资产误报。 */
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/** 不进入的目录（依赖树与生成物）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', 'build', 'dist', 'out', 'coverage']);

/**
 * 深度遍历 `rootDir`，返回其中**含裸 NUL 字节（0x00）**的源码文件的**相对路径**
 * （相对 `rootDir`，POSIX 分隔符，已排序）。返回空数组即「干净」。
 */
export function scanDirForNulBytes(rootDir: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不可读（权限 / 竞态）：跳过，不把「读不到」当成「干净」以外的结论
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p);
      } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        const bytes = readFileSync(p);
        // Buffer.includes(number) 按**字节值**匹配；0 即 0x00。
        if (bytes.includes(0)) hits.push(relative(rootDir, p).split(sep).join('/'));
      }
    }
  };
  walk(rootDir);
  hits.sort();
  return hits;
}

/** 仓库根：本文件位于 `tests/full-app/nul-bytes/`，向上一级 ×3。 */
export function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}
