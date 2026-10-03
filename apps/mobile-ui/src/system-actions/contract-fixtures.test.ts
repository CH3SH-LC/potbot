/**
 * F-R06 契约一致性守卫：`contract-fixtures/*.json` 是生成的命令，交给仓根**真实**
 * 校验器 `node contracts/mobile-v1/validate.mjs <本目录>/contract-fixtures` 用
 * command.schema.json 校验（契约层证据，见 README）。
 *
 * 本测试防漂移：重新构造同样的命令，必须与已提交 fixture 的 `value` **逐字段相等**。
 * 改了构造逻辑却忘了重生成 fixture ⇒ 本测试变红。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildCalendarEventCommand,
  buildReminderCommand,
  buildResearchDeletionCommand,
  buildResearchQueryCommand,
  resolvedTime,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const TZ = 'Asia/Shanghai';
const T1 = '2026-10-04T01:00:00Z';

function fixture(name: string): unknown {
  const envelope = JSON.parse(readFileSync(join(here, 'contract-fixtures', name), 'utf8')) as {
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
