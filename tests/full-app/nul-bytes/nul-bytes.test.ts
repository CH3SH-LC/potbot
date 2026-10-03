/**
 * FA-FIX-NUL-BYTES —— **裸 NUL 守卫**（回归防护）。
 *
 * ## 判据
 *
 * 1. **全仓扫描**：`apps/**` 与 `src/**` 下的**源码文件**（`SOURCE_EXT`）中，
 *    裸 NUL 字节（0x00）数必须为 **0**。命中即报红，并把命中清单打进断言消息。
 * 2. **判别力自证**（防止守卫本身变成「永远绿的空壳」）：
 *    - 正例：喂一个**确实含 0x00** 的临时 `.ts` 文件 ⇒ 必须被列为命中；
 *    - 对照 A：同目录喂一个**不含 0x00** 的 `.ts` ⇒ 不得命中；
 *    - 对照 B：喂一个**含 0x00 但扩展名非源码**（`.bin`）⇒ 不得命中（避免误报二进制资产）。
 *
 * 仅对照 A 满足不了「判别力」——一个 `return []` 的空实现也能过对照 A。正例与对照 B
 * 一正一反，才把「漏报」和「误报」同时钉住。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { repoRoot, scanDirForNulBytes } from './scan-nul-bytes.js';

const REPO = repoRoot();

describe('裸 NUL 守卫 · 全仓扫描', () => {
  it('apps/** 与 src/** 的源码文件中 0 个裸 NUL 字节', () => {
    const hits = [
      ...scanDirForNulBytes(join(REPO, 'apps')).map((f) => `apps/${f}`),
      ...scanDirForNulBytes(join(REPO, 'src')).map((f) => `src/${f}`),
    ];
    expect(
      hits,
      `以下源码文件含裸 NUL 字节（0x00）：git 会判其为二进制、丧失行级三方合并，且 diff/review 失效。\n` +
        `修法：把裸 NUL 改成等价转义写法（运行期取值不变，见 FA-FIX-NUL-BYTES）。\n` +
        `命中清单：\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});

describe('★判别力自证：守卫能同时抓住漏报与误报', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nul-guard-'));
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('正例：含 0x00 的 .ts 必须被列为命中', () => {
    const dir = join(tmp, 'apps');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bad.ts'),
      Buffer.concat([Buffer.from('const s = "a'), Buffer.from([0]), Buffer.from('b";')]),
    );
    expect(scanDirForNulBytes(dir)).toContain('bad.ts');
  });

  it('对照 A：不含 0x00 的 .ts 不得命中', () => {
    const dir = join(tmp, 'src-clean');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'good.ts'), Buffer.from('const s = "ab";'));
    expect(scanDirForNulBytes(dir)).toEqual([]);
  });

  it('对照 B：含 0x00 但扩展名非源码的 .bin 不得命中（不误报二进制资产）', () => {
    const dir = join(tmp, 'assets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    expect(scanDirForNulBytes(dir)).toEqual([]);
  });

  it('对照 C：真正的二进制资产（.docx 式扩展名）即使含 0x00 也不扫', () => {
    const dir = join(tmp, 'fixtures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'template.docx'), Buffer.from([0x50, 0x4b, 0, 3]));
    expect(scanDirForNulBytes(dir)).toEqual([]);
  });
});
