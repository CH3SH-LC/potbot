/**
 * K01 独立验证 ①：命令形状校验对齐**冻结契约**。
 *
 * 判据不是自证：把 `contracts/mobile-v1/fixtures/**` 里所有 `$schemaRef` 指向
 * `command.schema.json` 的正例喂给 `validateCommand`，必须全部通过；再构造一批
 * 反例（缺必需字段 / 分支违规 / 未知键），必须**逐条**报出预期原因码。
 *
 * 若契约 fixture 与本地校验器出现偏差（例如契约新增必需字段），本文件立刻变红。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateCommand } from '../../../apps/mobile-kernel/bootstrap/index.js';
import { makeCommand } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, '../../../contracts/mobile-v1/fixtures');

interface Envelope {
  $schemaRef?: string;
  value?: unknown;
}

function collectCommandFixtures(): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  for (const dir of readdirSync(fixturesRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const groupDir = join(fixturesRoot, dir.name);
    for (const file of readdirSync(groupDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const full = join(groupDir, file.name);
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as Envelope;
      if (parsed.$schemaRef === 'schemas/command.schema.json') {
        out.push({ path: `${dir.name}/${file.name}`, value: parsed.value });
      }
    }
  }
  return out;
}

describe('K01 命令校验：对齐冻结契约正例', () => {
  const fixtures = collectCommandFixtures();

  it('至少能读到契约里的 command 正例（防止路径写错导致空跑）', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
  });

  it.each(fixtures)('$path 通过本地校验', ({ value }) => {
    const result = validateCommand(value);
    expect(result.issues, JSON.stringify(value)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('K01 命令校验：反例必须被逐条拒绝', () => {
  it('schemaVersion 非 mobile-v1', () => {
    const result = validateCommand(makeCommand({ schemaVersion: 'mobile-v2' as never }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('NOT_MOBILE_V1');
  });

  it('缺 idempotencyKey', () => {
    const command = makeCommand();
    delete (command as { idempotencyKey?: unknown }).idempotencyKey;
    const result = validateCommand(command);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'idempotencyKey' && i.code === 'INVALID_ID')).toBe(true);
  });

  it('未知 operation', () => {
    const result = validateCommand(makeCommand({ operation: 'launch-missile' as never }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('UNKNOWN_OPERATION');
  });

  it('mutation 缺 expectedRevision', () => {
    const result = validateCommand(
      makeCommand({ operation: 'mutate', payload: { conversationId: 'conv-42', patch: { op: 'replace' } } }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'payload.expectedRevision' && i.code === 'MISSING')).toBe(true);
  });

  it('mutation 缺 conversationId 与 taskId', () => {
    const result = validateCommand(
      makeCommand({ operation: 'mutate', payload: { targetId: 'doc-7', expectedRevision: 1 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'MISSING_TARGET')).toBe(true);
  });

  it('query 缺 conversationId 与 taskId', () => {
    const result = validateCommand(makeCommand({ operation: 'inspect', payload: { filters: {} } }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'MISSING_TARGET')).toBe(true);
  });

  it('payload 出现分支不允许的键', () => {
    const result = validateCommand(
      makeCommand({ operation: 'inspect', payload: { taskId: 'task-9', goal: '不该出现在 query 分支' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'payload.goal' && i.code === 'UNKNOWN_KEY')).toBe(true);
  });

  it('create 分支允许 goal/templateId（正例对照：不要过度拒绝）', () => {
    const result = validateCommand(makeCommand());
    expect(result.ok).toBe(true);
  });

  it('非对象输入', () => {
    expect(validateCommand(null).ok).toBe(false);
    expect(validateCommand('nope').ok).toBe(false);
    expect(validateCommand([]).issues.map((i) => i.code)).toContain('NOT_AN_OBJECT');
  });
});
