/**
 * F04 验收：本包构造的 v1 命令/事件交给**真校验器**实跑。
 *
 * 用冻结合入 main 的 `contracts/mobile-v1/validate.mjs`（按 schemas/*.json 实跑），
 * 证明本包构造的对象不是「自己说自己对」——附带反向对照，证明校验器不是空转：
 *   - mutate 命令缺 expectedRevision ⇒ 必须 FAIL；
 *   - cancel 命令既无 conversationId 也无 taskId ⇒ 必须 FAIL；
 *   - status='succeeded' 缺 resultRef 的事件 ⇒ 必须 FAIL（fail-closed）。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/F04/contract.test.ts --reporter=basic`
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildCancelCommand,
  buildChangeConditionsCommand,
  buildPauseCommand,
  buildResumeCommand,
  type Command,
} from '../../../apps/mobile-ui/src/groups/index.js';
import { IDS, makeEvent } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');
const COMMAND_SCHEMA = 'schemas/command.schema.json';
const EVENT_SCHEMA = 'schemas/event.schema.json';

function runValidator(fixturesDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, fixturesDir], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

function withTempFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'f04-contract-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir: string, name: string, schemaRef: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify({ $schemaRef: schemaRef, note: name, value }, null, 2), 'utf8');
}

const BASE = { taskId: IDS.weeklyTask, conversationId: IDS.convWeekly, expectedRevision: 1 } as const;

describe('F04 / 契约校验器实跑', () => {
  it('校验器存在', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
  });

  it('暂停/恢复/取消/改条件命令全部通过 command.schema.json', () => {
    const commands: Record<string, Command> = {
      'cmd-pause.json': buildPauseCommand({ ...BASE, reason: '用户暂离' }),
      'cmd-resume.json': buildResumeCommand(BASE),
      'cmd-cancel.json': buildCancelCommand({ ...BASE, reason: '用户取消' }),
      'cmd-conditions.json': buildChangeConditionsCommand({
        ...BASE,
        changes: [{ field: 'budget', value: '已增加' }],
      }),
    };
    withTempFixtures((dir) => {
      for (const [name, value] of Object.entries(commands)) writeFixture(dir, name, COMMAND_SCHEMA, value);
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('summary: 4 PASS, 0 FAIL');
      expect(status).toBe(0);
    });
  });

  it('任务事件通过 event.schema.json；completed 事件带 resultRef', () => {
    const events = {
      'evt-stage.json': makeEvent(
        { taskId: IDS.weeklyTask, kind: 'stage', at: '2026-10-03T10:40:00Z', stageId: 'review', stageStatus: 'active' },
        { revision: 2, seq: 1 },
      ),
      'evt-completed.json': makeEvent(
        { taskId: IDS.weeklyTask, kind: 'state', at: '2026-10-03T10:41:00Z', to: 'completed' },
        { revision: 3, seq: 2, status: 'succeeded', resultRef: 'artifact:art-draft@2', verificationMode: 'real' },
      ),
    };
    withTempFixtures((dir) => {
      for (const [name, value] of Object.entries(events)) writeFixture(dir, name, EVENT_SCHEMA, value);
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('summary: 2 PASS, 0 FAIL');
      expect(status).toBe(0);
    });
  });

  it('反向对照：mutate 命令缺 expectedRevision 必须 FAIL', () => {
    const bad: Command = {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-bad-1',
      operation: 'mutate',
      idempotencyKey: 'idem-bad-1',
      payload: { taskId: IDS.weeklyTask },
    };
    withTempFixtures((dir) => {
      writeFixture(dir, 'cmd-bad-mutate.json', COMMAND_SCHEMA, bad);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  cmd-bad-mutate.json');
    });
  });

  it('反向对照：cancel 命令无 conversationId/taskId 必须 FAIL', () => {
    const bad: Command = {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-bad-2',
      operation: 'cancel',
      idempotencyKey: 'idem-bad-2',
      payload: {},
    };
    withTempFixtures((dir) => {
      writeFixture(dir, 'cmd-bad-cancel.json', COMMAND_SCHEMA, bad);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  cmd-bad-cancel.json');
    });
  });

  it('反向对照：succeeded 事件缺 resultRef 必须 FAIL（fail-closed）', () => {
    const bad = {
      eventId: 'evt-bad',
      seq: 1,
      commandId: 'cmd-1',
      revision: 2,
      status: 'succeeded',
    };
    withTempFixtures((dir) => {
      writeFixture(dir, 'evt-bad-succeeded.json', EVENT_SCHEMA, bad);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  evt-bad-succeeded.json');
    });
  });
});
