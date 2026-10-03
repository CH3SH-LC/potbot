/**
 * F07 验收：操作 → v1 命令（契约对齐）。
 *
 * 两件事都要真跑：
 *   1) 模块构造出的命令对象，与磁盘上的 fixture **逐字段相等**；
 *   2) 这些 fixture 经**真实**的契约校验器 `contracts/mobile-v1/validate.mjs` 验证通过
 *      （真实 schema，非手写断言）。校验器任一失败 → exit 1 → 本用例失败。
 *
 * 若 `node` 不可用或校验器路径变更，本用例**失败**而不是跳过——契约对齐不能被静默跳过。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildEditCommand,
  buildForgetCommand,
  buildRecallCommand,
  buildStatusCommand,
} from '../../../apps/mobile-ui/src/memory/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const FIXTURES_DIR = resolve(HERE, 'fixtures/contract');

function fixtureValue(name: string): unknown {
  const raw = JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8')) as {
    value: unknown;
  };
  return raw.value;
}

const ENVELOPE = {
  commandId: 'cmd-f07-edit-1',
  idempotencyKey: 'idem-f07-edit-1',
  conversationId: 'conv-1',
} as const;

describe('F07 / 操作构造的命令与 fixture 一致', () => {
  it('编辑命令', () => {
    const cmd = buildEditCommand({
      envelope: ENVELOPE,
      memoryId: 'mem-1',
      expectedRevision: 3,
      patch: { body: '偏好喝拿铁' },
    });
    expect(cmd).toEqual(fixtureValue('command-edit.json'));
  });

  it('停用命令', () => {
    const cmd = buildStatusCommand({
      envelope: { ...ENVELOPE, commandId: 'cmd-f07-disable-1', idempotencyKey: 'idem-f07-disable-1' },
      memoryId: 'mem-1',
      expectedRevision: 3,
      action: 'disable',
    });
    expect(cmd).toEqual(fixtureValue('command-disable.json'));
  });

  it('遗忘命令', () => {
    const cmd = buildForgetCommand({
      envelope: { ...ENVELOPE, commandId: 'cmd-f07-forget-1', idempotencyKey: 'idem-f07-forget-1' },
      expectedRevision: 3,
      scope: { kind: 'owner' },
    });
    expect(cmd).toEqual(fixtureValue('command-forget.json'));
  });

  it('检索命令', () => {
    const cmd = buildRecallCommand({
      envelope: { ...ENVELOPE, commandId: 'cmd-f07-recall-1', idempotencyKey: 'idem-f07-recall-1' },
      filters: { kinds: ['preference'], statuses: ['active'], text: '咖啡' },
    });
    expect(cmd).toEqual(fixtureValue('command-recall.json'));
  });

  it('mutation 分支必带 expectedRevision 与 conversationId（结构自检）', () => {
    const cmd = buildEditCommand({
      envelope: ENVELOPE,
      memoryId: 'mem-1',
      expectedRevision: 3,
      patch: { body: 'x' },
    });
    const payload = cmd.payload as Record<string, unknown>;
    expect(payload.expectedRevision).toBe(3);
    expect(payload.conversationId).toBe('conv-1');
  });
});

describe('F07 / 真实契约校验器', () => {
  it('contracts/mobile-v1/validate.mjs 对本包 fixtures 全部 PASS（exit 0）', () => {
    const out = execFileSync(
      process.execPath,
      ['contracts/mobile-v1/validate.mjs', 'tests/mobile-ui/F07/fixtures/contract'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(out).toContain('4 PASS');
    expect(out).toContain('0 FAIL');
  });
});
