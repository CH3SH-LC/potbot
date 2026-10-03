/**
 * F04 验收：守卫「原始 NUL 字节」缺陷类（permanent regression guard）。
 *
 * 背景：wave-1 的协调核对曾在 `groups/commands.ts` 标出 2 个裸 0x00 字节（NUL）。经核对，
 * 现在磁盘上是转义写法 `'\u0000'`（裸 NUL 计数为 0）——该字符是命令种子/幂等键的
 * join 分隔符，必须**始终**以转义序列出现在源码里：裸 NUL 会污染 diff、编辑器、某些
 * 工具链与终端，并可能被上游脚本按「文本文件」处理而截断。
 *
 * 本测试把这条约束机器化锁死，防止缺陷复发：
 *   1) `commands.ts` 字节流里**裸 0x00 计数为 0**；
 *   2) 源码文本里**出现转义序列** `\u0000`，且它正是 `.join(...)` 的分隔符实参；
 *   3) 扩大守卫到整个 `groups/` 目录（任何 .ts 都不得含裸 NUL）；
 *   4) 行为交叉验证：跑一次 `buildPauseCommand`，证明运行时 join 分隔符**就是**该转义
 *      对应的 NUL 字符（既非空串、也非别的字符）——把「源码转义」与「运行时语义」钉在一起。
 *
 * 定向往返：`npx vitest run tests/mobile-ui/F04/no-raw-nul.test.ts --reporter=basic`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPauseCommand, fnv1a64Hex } from '../../../apps/mobile-ui/src/groups/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const GROUPS_DIR = join(REPO_ROOT, 'apps', 'mobile-ui', 'src', 'groups');
const COMMANDS_TS = join(GROUPS_DIR, 'commands.ts');

/** 运行时构造 NUL 字符——本测试源码里不出现任何裸字节。 */
const NUL = String.fromCharCode(0x00);
/** 源码中期望出现的转义写法（6 个字符：反斜杠 u 0 0 0 0）。 */
const NUL_ESCAPE_TEXT = '\\u0000';

function rawNulCount(content: Buffer): number {
  let count = 0;
  for (const byte of content) if (byte === 0x00) count += 1;
  return count;
}

describe('F04 / raw-NUL 守卫：commands.ts', () => {
  it('commands.ts 存在且裸 0x00 字节计数为 0', () => {
    const bytes = readFileSync(COMMANDS_TS);
    expect(bytes.length).toBeGreaterThan(0);
    expect(rawNulCount(bytes)).toBe(0);
  });

  it('源码文本含转义 \\u0000 且不含裸 NUL 字符', () => {
    const text = readFileSync(COMMANDS_TS, 'utf8');
    expect(text.includes(NUL_ESCAPE_TEXT)).toBe(true);
    expect(text.includes(NUL)).toBe(false);
    // 该转义必须是 join 的分隔符实参，而不是只被提到。
    expect(/\.join\(\s*'\s*\\u0000'\s*\)/.test(text)).toBe(true);
  });

  it('运行时 join 分隔符就是 NUL 转义（非空串、非其它字符）', () => {
    const input = { taskId: 'task-1', conversationId: 'conv-1', expectedRevision: 2 };
    const command = buildPauseCommand(input);

    // 复刻 buildPauseCommand 的种子：[schemaVersion, action, taskId, conversationId, revision, extra]。
    const parts = ['mobile-v1', 'pause', input.taskId, input.conversationId, String(input.expectedRevision), 'pause'];
    const nulSeed = parts.join(NUL);
    const emptySeed = parts.join('');

    expect(NUL).toHaveLength(1);
    expect(command.idempotencyKey).toBe(`idem-pause-${fnv1a64Hex(`${nulSeed}|idempotencyKey`)}`);
    // 若分隔符被改成空串（或别的字符），下面的等号会成立——反证分隔符确为 NUL。
    expect(command.idempotencyKey).not.toBe(`idem-pause-${fnv1a64Hex(`${emptySeed}|idempotencyKey`)}`);
  });
});

describe('F04 / raw-NUL 守卫：整个 groups/ 目录', () => {
  it('所有 .ts 源文件均不含裸 0x00 字节', () => {
    const files = readdirSync(GROUPS_DIR).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of files) {
      if (rawNulCount(readFileSync(join(GROUPS_DIR, name))) > 0) offenders.push(name);
    }
    expect(offenders).toEqual([]);
    // commands.ts 必须在扫描集合里（避免 glob 漂移导致守卫空转）。
    expect(files).toContain('commands.ts');
  });
});
