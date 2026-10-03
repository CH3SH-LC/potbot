/**
 * **X01-nul-control-byte-scan**：表格线源码里**不得出现裸 NUL / 控制字节**的回归门。
 *
 * ## 为什么需要这条门
 *
 * 第一波报告把 `src/spreadsheets/xlsx-preservation/roundtrip-audit.ts` 标为 PARTIAL，理由是
 * 文件里出现了裸 `0x00`。**该结论是陈旧的**：现文件用的是转义序列 `\u0000`（六个可见字符
 * `\` `u` `0` `0` `0` `0`），不是裸字节；对整条表格线源码做字节扫描，裸 NUL 为 0。
 * 但"裸字节会被某些编辑器 / 工具悄悄写进源文件"这一类问题是**可复发**的，因此本条门
 * **独立**扫描 `src/spreadsheets` 与 `src/mobile-plugins/spreadsheets` 的**每一个字节**：
 * 只要出现一个裸 NUL 或裸控制字节（TAB / LF / CR 之外的 C0 控制符，以及 DEL），即红。
 *
 * ## 判据
 *
 * - 允许：`0x09`(TAB) / `0x0A`(LF) / `0x0D`(CR)——正常文本文件排版；
 * - 禁止：`0x00`（NUL）以及 `0x01–0x08`、`0x0B`、`0x0C`、`0x0E–0x1F`、`0x7F`(DEL)。
 * - UTF-8 多字节序列（中文等）的续字节在 `0x80–0xBF`，**不在**禁止区间，故不误报。
 *
 * ## 反空洞自检
 *
 * 用例自带一条"扫描器会红"的证据：在一段**故意植入裸 NUL**的内存字节上，扫描器必须报出
 * 该偏移——否则"全绿"可能只是因为扫描器恒真。
 */

import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCAN_ROOTS = ['src/spreadsheets', 'src/mobile-plugins/spreadsheets'] as const;

/** 文本文件里正常出现的控制符：TAB / LF / CR。 */
const ALLOWED_CONTROL_BYTES = new Set<number>([0x09, 0x0a, 0x0d]);

export interface ControlByteHit {
  readonly offset: number;
  readonly byte: number;
}

/** 返回一段字节里所有**裸控制字节**的位置（允许 TAB/LF/CR）。 */
export function findControlBytes(bytes: Uint8Array): readonly ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index] as number;
    if (ALLOWED_CONTROL_BYTES.has(byte)) continue;
    if (byte === 0x00 || byte < 0x20 || byte === 0x7f) hits.push({ offset: index, byte });
  }
  return hits;
}

/** 递归列出一个目录下的**全部**文件（相对仓库根的 POSIX 路径，字典序）。 */
function listFiles(absoluteDir: string): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  walk(absoluteDir);
  return out.sort();
}

describe('X01 裸 NUL / 控制字节回归门：表格线源码', () => {
  it('扫描器本身会红：植入的裸 NUL 被报出（反空洞自检）', () => {
    const planted = Uint8Array.from([0x61, 0x00, 0x62, 0x09, 0x0a, 0x1b, 0x7f]);
    const hits = findControlBytes(planted);
    expect(hits.map((hit) => hit.offset)).toEqual([1, 5, 6]);
    expect(hits[0]?.byte).toBe(0x00);
  });

  it('src/spreadsheets 与 src/mobile-plugins/spreadsheets 的每个字节都无裸 NUL / 控制字节', () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      const absolute = join(REPO_ROOT, root);
      const listed = listFiles(absolute);
      // 防止"根目录搬走了 ⇒ 扫了个空 ⇒ 恒绿"
      expect(listed.length, `${root} 下应有源码文件`).toBeGreaterThan(0);
      files.push(...listed);
    }

    const offenders: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(join(REPO_ROOT, file));
      const hits = findControlBytes(bytes);
      if (hits.length > 0) {
        const shown = hits
          .slice(0, 8)
          .map((hit) => `@${String(hit.offset)}=0x${hit.byte.toString(16).padStart(2, '0')}`)
          .join(' ');
        offenders.push(`${file}（${String(hits.length)} 处：${shown}）`);
      }
    }

    expect(offenders, `发现裸 NUL / 控制字节：\n${offenders.join('\n')}`).toEqual([]);
    // 证据规模：确实扫过一批文件（当前 ASCII 全部 .ts）
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it('陈旧结论的落点自查：roundtrip-audit.ts 用的是转义序列而不是裸字节', () => {
    const path = 'src/spreadsheets/xlsx-preservation/roundtrip-audit.ts';
    const bytes = readFileSync(join(REPO_ROOT, path));
    expect(findControlBytes(bytes)).toEqual([]);
    // 文件里应存在**可见**的六字符转义序列 `\u0000`（反斜杠 + u + 0000），而非裸 NUL
    const text = new TextDecoder().decode(bytes);
    expect(text.includes('\\u0000')).toBe(true);
  });
});
