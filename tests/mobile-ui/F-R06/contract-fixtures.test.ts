/**
 * F-R06 契约一致性守卫（canonical 位置 `tests/mobile-ui/F-R06/`）。
 *
 * `apps/mobile-ui/src/system-actions/contract-fixtures/*.json` 是**生成**的命令样本，
 * 交给仓根**真实**校验器 `node contracts/mobile-v1/validate.mjs <该目录>` 用
 * `schemas/command.schema.json` 校验（契约层证据）。
 *
 * 两件事：
 *   1) **防漂移**：重新构造同样的命令，必须与已提交 fixture 的 `value` **逐字段相等**；
 *      改了构造逻辑却忘了重生成 fixture ⇒ 本测试变红。
 *   2) **真实契约校验**：实跑冻结 validator，断言 5 PASS / 0 FAIL / exit 0 —— fixture 不是
 *      自说自话，而是真过 schema（fixture 目录只读，属 F-R06 包，本测试不改写）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildCalendarEventCommand,
  buildReminderCommand,
  buildResearchDeletionCommand,
  buildResearchQueryCommand,
  resolvedTime,
} from '../../../apps/mobile-ui/src/system-actions/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const fixturesDir = join(here, '..', '..', '..', 'apps', 'mobile-ui', 'src', 'system-actions', 'contract-fixtures');
const TZ = 'Asia/Shanghai';
const T1 = '2026-10-04T01:00:00Z';

function fixture(name: string): unknown {
  const envelope = JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as {
    $schemaRef: string;
    value: unknown;
  };
  expect(envelope.$schemaRef).toBe('schemas/command.schema.json');
  return envelope.value;
}

describe('F-R06 / contract fixtures 防漂移', () => {
  it('calendar-create 与构造结果一致', () => {
    const fresh = buildCalendarEventCommand({
      conversationId: 'conv-1',
      title: '评审会',
      time: resolvedTime(T1, TZ),
      timezone: TZ,
      accountRef: 'acct:cal-work',
    });
    expect(fresh).toEqual(fixture('calendar-create.json'));
  });

  it('calendar-mutate 与构造结果一致', () => {
    const fresh = buildCalendarEventCommand({
      conversationId: 'conv-1',
      eventId: 'ev-1',
      title: '评审会',
      time: resolvedTime(T1, TZ),
      timezone: TZ,
      accountRef: 'acct:cal-work',
      recurrence: { rule: 'FREQ=WEEKLY' },
      occurrenceScope: 'this-and-future',
      expectedRevision: 3,
    });
    expect(fresh).toEqual(fixture('calendar-mutate.json'));
  });

  it('reminder-create 与构造结果一致', () => {
    const fresh = buildReminderCommand({
      conversationId: 'conv-1',
      kind: 'alarm',
      label: '吃药',
      owner: 'self',
      time: resolvedTime(T1, TZ),
      permission: 'granted',
    });
    expect(fresh).toEqual(fixture('reminder-create.json'));
  });

  it('research-query 与构造结果一致', () => {
    const fresh = buildResearchQueryCommand({
      conversationId: 'conv-1',
      sourceId: 'src-1',
      title: '官方文档',
      originUri: 'https://example.com/doc',
      state: 'read',
      fetchedAt: T1,
      evidenceSnippet: '片段',
    });
    expect(fresh).toEqual(fixture('research-query.json'));
  });

  it('research-delete 与构造结果一致', () => {
    const fresh = buildResearchDeletionCommand(
      {
        conversationId: 'conv-1',
        sourceId: 'src-1',
        title: '官方文档',
        originUri: 'https://example.com/doc',
        state: 'read',
        fetchedAt: T1,
        evidenceSnippet: '片段',
        expectedRevision: 4,
      },
      { index: 'cascade', snippet: 'cascade', citations: 'cascade', derivedFacts: 'retain' },
    );
    expect(fresh).toEqual(fixture('research-delete.json'));
  });
});

describe('F-R06 / 真实冻结 validator 校验 fixture', () => {
  it('node contracts/mobile-v1/validate.mjs <fixtures> → 5 PASS / 0 FAIL / exit 0', () => {
    const stdout = execFileSync(
      process.execPath,
      ['contracts/mobile-v1/validate.mjs', 'apps/mobile-ui/src/system-actions/contract-fixtures'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(stdout).toContain('summary: 5 PASS, 0 FAIL');
    expect(stdout).not.toContain('FAIL  ');
    expect(stdout).toContain('schemas/command.schema.json');
  });
});
