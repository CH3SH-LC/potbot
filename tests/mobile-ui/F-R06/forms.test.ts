/**
 * F-R06 独立验收（canonical 位置 `tests/mobile-ui/F-R06/`）：
 * 日历 / 提醒 / 资料来源详情表单 + 「回统一对话」+ 屏幕适配 + `KernelClient` 接线。
 *
 * 本测试**只经包 barrel**（`apps/mobile-ui/src/system-actions/index.js`）消费；不 mock、不读
 * 网络 / 时钟，断言全部为真实值比较与 fail-closed 反向对照（期望抛错必须抛错，错误 code 精确匹配）。
 *
 * 覆盖不变量：I-A 绝对时间、I-B 重复范围、I-C 账号引用、I-D 提醒归属/权限、
 * I-E dismiss ≠ delete、I-F 来源诚实、I-G 回统一对话、I-H 修订守卫、命令确定性幂等。
 *
 * 集成（本包新增）：
 *   - 屏幕适配：`*FormView` → 渲染底座 `ViewNode`（屏幕 T06/T07/C05），树必须过
 *     `render/view.ts` 的 fail-closed 校验；
 *   - 内核接线：`dispatchSystemActionCommand(build*Command(...), 真实 KernelClient)` ——
 *     断流 / 坏终局 / 提交被拒 / 客户端关闭一律 `progressUnknown`，绝不伪造 `succeeded`。
 */

import { describe, expect, it } from 'vitest';

import {
  SystemActionError,
  buildCalendarEventCommand,
  buildCalendarForm,
  buildCalendarScreen,
  buildReminderCommand,
  buildReminderForm,
  buildReminderScreen,
  buildResearchDeletionCommand,
  buildResearchForm,
  buildResearchQueryCommand,
  buildResearchScreen,
  buildResultRef,
  buildSystemActionScreen,
  dispatchSystemActionCommand,
  reminderActionEffect,
  planSourceDeletion,
  relativeTime,
  requireResolvedTime,
  requireSourceDeletionScope,
  resolvedTime,
  returnTargetFor,
  returnToConversation,
  resultRefKindFor,
  summarizeTime,
  type CalendarEventInput,
  type ResearchSourceInput,
  type ReminderInput,
} from '../../../apps/mobile-ui/src/system-actions/index.js';

import { renderText, validateViewNode } from '../../../apps/mobile-ui/src/render/index.js';
import { SCREEN_DEFS } from '../../../apps/mobile-ui/src/shell/index.js';

import {
  createKernelClient,
  type CallerIdentity,
  type Command,
  type Event,
  type KernelTransport,
  type KernelTransportBreakNotice,
} from '../../../apps/mobile-ui/src/platform/index.js';

const T1 = '2026-10-04T01:00:00Z';
const T2 = '2026-10-04T02:00:00Z';
const TZ = 'Asia/Shanghai';
const CONV = 'conv-1';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof SystemActionError ? error.code : `non-system-action-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

function baseCalendar(over: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    conversationId: CONV,
    anchorMessageId: 'msg-9',
    title: '评审会',
    time: resolvedTime(T1, TZ),
    endTime: resolvedTime(T2, TZ),
    timezone: TZ,
    accountRef: 'acct:cal-work',
    ...over,
  };
}

function baseReminder(over: Partial<ReminderInput> = {}): ReminderInput {
  return {
    conversationId: CONV,
    kind: 'alarm',
    label: '吃药',
    owner: 'self',
    time: resolvedTime(T1, TZ),
    permission: 'granted',
    ...over,
  };
}

function baseSource(over: Partial<ResearchSourceInput> = {}): ResearchSourceInput {
  return {
    conversationId: CONV,
    sourceId: 'src-1',
    title: '官方文档',
    originUri: 'https://example.com/doc',
    state: 'read',
    fetchedAt: T1,
    evidenceSnippet: '第 3.2 节：…',
    ...over,
  };
}

describe('F-R06 / I-A 绝对时间：相对表达不得作为执行摘要', () => {
  it('已解析时间 → 执行摘要由绝对字段拼成', () => {
    const form = buildCalendarForm(baseCalendar());
    expect(form.timeSummary).toBe(`${T1}@${TZ}`);
    expect(form.endSummary).toBe(`${T2}@${TZ}`);
  });

  it('反向对照：相对表达一律 relative-time-not-resolved', () => {
    expect(codeOf(() => buildCalendarForm(baseCalendar({ time: relativeTime('明天上午9点') })))).toBe(
      'relative-time-not-resolved',
    );
    expect(codeOf(() => summarizeTime(relativeTime('下午三点'), 'time'))).toBe('relative-time-not-resolved');
    expect(codeOf(() => requireResolvedTime(undefined, 'time'))).toBe('relative-time-not-resolved');
  });

  it('时区非法（local / 空）被拒，UTC 合法', () => {
    expect(codeOf(() => buildCalendarForm(baseCalendar({ timezone: 'local' })))).toBe('invalid-timezone');
    expect(codeOf(() => buildCalendarForm(baseCalendar({ timezone: '' })))).toBe('missing-timezone');
    expect(buildCalendarForm(baseCalendar({ timezone: 'UTC' })).timezone).toBe('UTC');
  });

  it('结束早于开始 → end-before-start', () => {
    const bad = baseCalendar({ time: resolvedTime(T2, TZ), endTime: resolvedTime(T1, TZ) });
    expect(codeOf(() => buildCalendarForm(bad))).toBe('end-before-start');
  });
});

describe('F-R06 / I-B 重复范围必须显式', () => {
  const recurrence = { rule: 'FREQ=WEEKLY;BYDAY=MO' };

  it('修改重复日程缺范围 → missing-recurrence-scope', () => {
    const input = baseCalendar({ eventId: 'ev-1', recurrence, expectedRevision: 3 });
    expect(codeOf(() => buildCalendarForm(input))).toBe('missing-recurrence-scope');
  });

  it('修改重复日程给出范围 → 记录范围并提示', () => {
    const input = baseCalendar({
      eventId: 'ev-1',
      recurrence,
      occurrenceScope: 'this-and-future',
      expectedRevision: 3,
    });
    const form = buildCalendarForm(input);
    expect(form.occurrenceScope).toBe('this-and-future');
    expect(form.recurrenceRule).toBe(recurrence.rule);
    expect(form.warnings.some((w) => w.code === 'recurrence-scope')).toBe(true);
  });

  it('新建重复系列无需范围；非法范围被拒', () => {
    expect(buildCalendarForm(baseCalendar({ recurrence })).occurrenceScope).toBeNull();
    const bad = baseCalendar({ eventId: 'ev-1', recurrence, occurrenceScope: 'everyone' as never });
    expect(codeOf(() => buildCalendarForm(bad))).toBe('invalid-recurrence-scope');
  });
});

describe('F-R06 / I-C 账号是引用 + 冲突不被静默丢弃', () => {
  it('明文账号被拒，引用合法', () => {
    expect(codeOf(() => buildCalendarForm(baseCalendar({ accountRef: 'me@example.com' })))).toBe(
      'invalid-account-ref',
    );
    expect(codeOf(() => buildCalendarForm(baseCalendar({ accountRef: '' })))).toBe('missing-account-ref');
    expect(buildCalendarForm(baseCalendar({ accountRef: 'cal:primary' })).accountRef).toBe('cal:primary');
  });

  it('冲突引用原样保留并生成可见告警', () => {
    const form = buildCalendarForm(baseCalendar({ conflictRefs: ['ev-a', 'ev-b'] }));
    expect(form.conflicts).toEqual(['ev-a', 'ev-b']);
    expect(form.warnings.some((w) => w.code === 'schedule-conflict' && w.severity === 'warn')).toBe(true);
  });
});

describe('F-R06 / I-D + I-E 提醒归属、权限与 dismiss ≠ delete', () => {
  it('自管 + 已授权 → armed', () => {
    const form = buildReminderForm(baseReminder());
    expect(form.armed).toBe(true);
    expect(form.blockedReason).toBeNull();
    expect(form.timeSummary).toBe(`${T1}@${TZ}`);
  });

  it('权限拒绝 → 可构建但未武装，且不假报已设置', () => {
    const form = buildReminderForm(baseReminder({ permission: 'denied' }));
    expect(form.armed).toBe(false);
    expect(form.blockedReason).toBe('permission-denied');
    expect(form.warnings.some((w) => w.severity === 'error')).toBe(true);
  });

  it('system 归属缺系统通道 → missing-system-channel', () => {
    expect(codeOf(() => buildReminderForm(baseReminder({ owner: 'system' })))).toBe('missing-system-channel');
    const ok = buildReminderForm(baseReminder({ owner: 'system', systemChannel: 'ref:sys-alarm' }));
    expect(ok.systemChannel).toBe('ref:sys-alarm');
    expect(ok.warnings.some((w) => w.code === 'system-owned')).toBe(true);
  });

  it('timer 缺时长、world-clock 缺时区分别被拒', () => {
    expect(codeOf(() => buildReminderForm(baseReminder({ kind: 'timer' })))).toBe('missing-duration');
    expect(codeOf(() => buildReminderForm(baseReminder({ kind: 'world-clock' })))).toBe('missing-timezone');
  });

  it('I-E：dismiss 只停触发不删记录；delete 才删记录', () => {
    const dismiss = reminderActionEffect('dismiss');
    const del = reminderActionEffect('delete');
    expect(dismiss.removesRecord).toBe(false);
    expect(dismiss.stopsFutureFire).toBe(true);
    expect(del.removesRecord).toBe(true);
    expect(dismiss.removesRecord).not.toBe(del.removesRecord);
    expect(reminderActionEffect('disable').removesRecord).toBe(false);
    expect(codeOf(() => reminderActionEffect('purge'))).toBe('invalid-reminder-action');
  });
});

describe('F-R06 / I-F 来源诚实', () => {
  it('read 缺证据/时间 → source-evidence-missing', () => {
    expect(codeOf(() => buildResearchForm(baseSource({ evidenceSnippet: undefined })))).toBe(
      'source-evidence-missing',
    );
    expect(codeOf(() => buildResearchForm(baseSource({ fetchedAt: undefined })))).toBe('source-evidence-missing');
  });

  it('unread 携带证据 → unread-claims-evidence（未读取不得伪装）', () => {
    expect(codeOf(() => buildResearchForm(baseSource({ state: 'unread' })))).toBe('unread-claims-evidence');
    const ok = buildResearchForm(baseSource({ state: 'unread', fetchedAt: undefined, evidenceSnippet: undefined }));
    expect(ok.honesty).toBe('unknown');
    expect(ok.evidenceSnippet).toBeNull();
    expect(ok.warnings.some((w) => w.code === 'source-unread')).toBe(true);
  });

  it('conflict 必须列出冲突来源', () => {
    expect(codeOf(() => buildResearchForm(baseSource({ state: 'conflict' })))).toBe('missing-conflict-refs');
    const ok = buildResearchForm(baseSource({ state: 'conflict', conflictWith: ['src-2'] }));
    expect(ok.honesty).toBe('conflicting');
    expect(ok.conflicts).toEqual(['src-2']);
  });

  it('电脑绝对路径被拒；合法 scheme 通过', () => {
    expect(codeOf(() => buildResearchForm(baseSource({ originUri: 'C:\\docs\\a.md' })))).toBe(
      'absolute-path-not-allowed',
    );
    expect(codeOf(() => buildResearchForm(baseSource({ originUri: '/home/user/a.md' })))).toBe(
      'absolute-path-not-allowed',
    );
    expect(codeOf(() => buildResearchForm(baseSource({ originUri: 'ftp://example.com/a' })))).toBe(
      'invalid-origin-uri',
    );
    expect(buildResearchForm(baseSource({ originUri: 'content://media/src/1' })).originUri).toBe(
      'content://media/src/1',
    );
  });

  it('read 保留时间与证据；私有资料联动删除计划列出引用与派生事实', () => {
    const form = buildResearchForm(baseSource({ private: true }));
    expect(form.honesty).toBe('verifiable');
    expect(form.fetchedAt).toBe(T1);
    expect(form.evidenceSnippet).toBe('第 3.2 节：…');
    expect(form.warnings.some((w) => w.code === 'source-private')).toBe(true);

    const plan = planSourceDeletion(form, { citationRefs: ['c-1'], factRefs: ['fact-1'] });
    expect(plan.requiresExplicitScope).toBe(true);
    expect(plan.citationRefs).toEqual(['c-1']);
    expect(plan.factRefs).toEqual(['fact-1']);

    expect(codeOf(() => requireSourceDeletionScope(undefined))).toBe('missing-delete-scope');
    expect(codeOf(() => requireSourceDeletionScope({ index: 'cascade' }))).toBe('delete-scope-incomplete');
    const scope = requireSourceDeletionScope({
      index: 'cascade',
      snippet: 'cascade',
      citations: 'retain',
      derivedFacts: 'cascade',
    });
    expect(scope.citations).toBe('retain');
  });
});

describe('F-R06 / I-G 回统一对话', () => {
  it('有锚点 → restore=anchor；无锚点 → restore=latest；始终同一会话', () => {
    const withAnchor = returnTargetFor(CONV, 'msg-9');
    expect(withAnchor.conversationId).toBe(CONV);
    expect(returnToConversation(withAnchor)).toEqual({
      conversationId: CONV,
      anchorMessageId: 'msg-9',
      restore: 'anchor',
    });
    expect(returnToConversation(returnTargetFor(CONV)).restore).toBe('latest');
  });

  it('缺失/非法返回目标被拒', () => {
    expect(codeOf(() => returnToConversation(undefined as never))).toBe('missing-return-target');
    expect(codeOf(() => returnToConversation({ conversationId: '', anchorMessageId: null, origin: 'chat' } as never))).toBe(
      'missing-return-target',
    );
    expect(
      codeOf(() => returnToConversation({ conversationId: CONV, anchorMessageId: '  ', origin: 'chat' } as never)),
    ).toBe('invalid-return-anchor');
    expect(
      codeOf(() => returnToConversation({ conversationId: CONV, anchorMessageId: null, origin: 'docs' } as never)),
    ).toBe('missing-return-target');
  });

  it('表单自带返回目标；结果引用种类映射正确', () => {
    const form = buildCalendarForm(baseCalendar());
    expect(form.returnTarget.conversationId).toBe(CONV);
    expect(form.returnTarget.origin).toBe('system-actions');
    expect(resultRefKindFor('calendar-event')).toBe('task');
    expect(resultRefKindFor('reminder')).toBe('task');
    expect(resultRefKindFor('research-source')).toBe('artifact');
    expect(buildResultRef('research-source', 'src-1', '官方文档', 2).kind).toBe('artifact');
  });
});

describe('F-R06 / I-H + 命令：确定性幂等与修订守卫', () => {
  it('新建日历命令：create + 契约字段齐全 + 可复现', () => {
    const input = baseCalendar();
    const a = buildCalendarEventCommand(input);
    const b = buildCalendarEventCommand(input);
    expect(a).toEqual(b);
    expect(a.schemaVersion).toBe('mobile-v1');
    expect(a.operation).toBe('create');
    expect(a.commandId.startsWith('cmd-calendar-event-')).toBe(true);
    expect(a.idempotencyKey.startsWith('idem-calendar-event-')).toBe(true);
    expect(a.payload).toMatchObject({ conversationId: CONV });
    expect((a.metadata as Record<string, unknown>).returnTarget).toEqual(returnTargetFor(CONV, 'msg-9'));
  });

  it('内容变化 → 幂等键变化；同内容重发 → 同键', () => {
    const k1 = buildCalendarEventCommand(baseCalendar()).idempotencyKey;
    const k2 = buildCalendarEventCommand(baseCalendar({ title: '评审会2' })).idempotencyKey;
    const k1again = buildCalendarEventCommand(baseCalendar()).idempotencyKey;
    expect(k1).not.toBe(k2);
    expect(k1).toBe(k1again);
  });

  it('修改未带 expectedRevision → missing-expected-revision；带了则 mutate', () => {
    expect(codeOf(() => buildCalendarEventCommand(baseCalendar({ eventId: 'ev-1' })))).toBe(
      'missing-expected-revision',
    );
    const cmd = buildCalendarEventCommand(baseCalendar({ eventId: 'ev-1', expectedRevision: 7 }));
    expect(cmd.operation).toBe('mutate');
    expect((cmd.payload as { expectedRevision?: number }).expectedRevision).toBe(7);
    expect((cmd.payload as { targetId?: string }).targetId).toBe('ev-1');
  });

  it('提醒命令：新建可构造，未带 revision 的修改被拒', () => {
    const cmd = buildReminderCommand(baseReminder());
    expect(cmd.operation).toBe('create');
    expect(cmd.idempotencyKey.startsWith('idem-reminder-')).toBe(true);
    expect(codeOf(() => buildReminderCommand(baseReminder({ reminderId: 'r-1' })))).toBe(
      'missing-expected-revision',
    );
  });

  it('来源查询命令只读且不授权；删除命令需 revision + 完整范围', () => {
    const q = buildResearchQueryCommand(baseSource());
    expect(q.operation).toBe('query');
    expect((q.payload as { filters?: Record<string, unknown> }).filters).toMatchObject({
      sourceId: 'src-1',
      refresh: true,
      authorize: false,
    });

    const src: ResearchSourceInput = { ...baseSource(), expectedRevision: 4 };
    expect(codeOf(() => buildResearchDeletionCommand(src, { index: 'cascade' } as never))).toBe(
      'delete-scope-incomplete',
    );
    const del = buildResearchDeletionCommand(src, {
      index: 'cascade',
      snippet: 'cascade',
      citations: 'cascade',
      derivedFacts: 'retain',
    });
    expect(del.operation).toBe('mutate');
    expect((del.payload as { patch?: Record<string, unknown> }).patch).toMatchObject({ deleted: true });
  });
});

// ---------------------------------------------------------------------------
// 屏幕适配：*FormView → ViewNode（T06 / T07 / C05）
// ---------------------------------------------------------------------------

const SHELL_SCREEN_IDS = new Set(SCREEN_DEFS.map((s) => s.id));

describe('F-R06 / screen adapter：*FormView → 渲染底座 ViewNode', () => {
  it('三类屏幕 id 与 F-UI01 SCREEN_DEFS 对齐（T06/T07/C05 均已登记）', () => {
    expect(SHELL_SCREEN_IDS.has('T06')).toBe(true);
    expect(SHELL_SCREEN_IDS.has('T07')).toBe(true);
    expect(SHELL_SCREEN_IDS.has('C05')).toBe(true);
  });

  it('日历表单 → T06：树过 fail-closed 校验，文本含绝对摘要/账号/标题', () => {
    const form = buildCalendarForm(baseCalendar({ conflictRefs: ['ev-a'] }));
    const model = buildCalendarScreen(form);
    expect(model.screen).toBe('T06');
    expect(model.kind).toBe('calendar-event');
    expect(validateViewNode(model.root)).toEqual([]);
    const text = renderText(model.root);
    expect(text).toContain(form.title);
    expect(text).toContain(form.timeSummary);
    expect(text).toContain(form.accountRef);
    expect(text).toContain('ev-a'); // 冲突不被静默丢弃
    expect(model.returnInstruction).toEqual({ conversationId: CONV, anchorMessageId: 'msg-9', restore: 'anchor' });
  });

  it('提醒表单 → T07：未武装态可见、系统通道与告警落到节点', () => {
    const form = buildReminderForm(
      baseReminder({ owner: 'system', systemChannel: 'ref:sys-alarm', permission: 'denied' }),
    );
    const model = buildReminderScreen(form);
    expect(model.screen).toBe('T07');
    expect(validateViewNode(model.root)).toEqual([]);
    const text = renderText(model.root);
    expect(text).toContain('ref:sys-alarm');
    expect(text).toContain('未生效'); // armed=false 不假报已设置
    expect(model.warnings.some((w) => w.severity === 'error')).toBe(true);
  });

  it('来源表单 → C05：隐私/冲突/不可访问等诚实性落到 status 节点', () => {
    const form = buildResearchForm(
      baseSource({ state: 'inaccessible', fetchedAt: undefined, evidenceSnippet: undefined, private: true }),
    );
    const model = buildResearchScreen(form);
    expect(model.screen).toBe('C05');
    expect(validateViewNode(model.root)).toEqual([]);
    const text = renderText(model.root);
    expect(text).toContain('inaccessible');
    expect(text).toContain('inaccessible'); // honesty 派生值
    expect(text).toContain('私有资料');
  });

  it('统一入口按 kind 分派；每个动作按钮都有可访问名与合法 role', () => {
    const calendar = buildSystemActionScreen(buildCalendarForm(baseCalendar()));
    const reminder = buildSystemActionScreen(buildReminderForm(baseReminder()));
    const research = buildSystemActionScreen(buildResearchForm(baseSource()));
    expect(calendar.screen).toBe('T06');
    expect(reminder.screen).toBe('T07');
    expect(research.screen).toBe('C05');

    for (const model of [calendar, reminder, research]) {
      expect(model.actions.length).toBeGreaterThan(0);
      for (const action of model.actions) {
        expect(action.node.tag).toBe('button');
        expect(action.node.role).toBe('button');
        expect(action.node.ariaLabel).toBe(action.label);
        expect(action.label.length).toBeGreaterThan(0);
      }
    }
    // 删除来源是危险动作，用 danger 背景，不与普通主动作混用。
    const del = research.actions.find((a) => a.id === 'delete');
    expect(del?.emphasis).toBe('destructive');
    expect(del?.node.style?.background).toBe('danger');
  });

  it('模型深冻结：不可被下游篡改', () => {
    const model = buildCalendarScreen(buildCalendarForm(baseCalendar()));
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.root)).toBe(true);
    expect(Object.isFrozen(model.actions[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KernelClient 接线：命令 → 手机内核，断流绝不伪造成功
// ---------------------------------------------------------------------------

const CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };

function makeEvent(overrides: Partial<Event> & Pick<Event, 'seq' | 'commandId' | 'status'>): Event {
  return {
    eventId: `evt-${overrides.seq}`,
    revision: 0,
    verificationMode: 'fixture',
    ...overrides,
  };
}

interface ScriptedTransport {
  readonly transport: KernelTransport;
  emit(event: Event): void;
  emitBreak(notice: KernelTransportBreakNotice): void;
}

function scriptedTransport(options: { submit?: (command: unknown) => Promise<Event> } = {}): ScriptedTransport {
  const listeners = new Set<(event: Event) => void>();
  const breakListeners = new Set<(notice: KernelTransportBreakNotice) => void>();
  const transport: KernelTransport = {
    submit: options.submit ?? (() => Promise.resolve(makeEvent({ seq: 99, commandId: 'cmd-1', status: 'failed' }))),
    subscribe(listener) {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    cancel() {
      return true;
    },
    onBreak(listener) {
      breakListeners.add(listener);
      return { unsubscribe: () => breakListeners.delete(listener) };
    },
  };
  return {
    transport,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    emitBreak(notice) {
      for (const listener of [...breakListeners]) listener(notice);
    },
  };
}

describe('F-R06 / KernelClient 接线：build*Command → dispatch（fail-closed）', () => {
  it('成功：带 resultRef 的终局 → succeeded，命令 id 与幂等键原样透传', async () => {
    const cmd = buildCalendarEventCommand(baseCalendar());
    const terminal = makeEvent({
      seq: 1,
      commandId: cmd.commandId,
      status: 'succeeded',
      resultRef: 'task:cal-1@1',
      revision: 1,
      verificationMode: 'real',
    });
    const s = scriptedTransport({ submit: () => Promise.resolve(terminal) });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });

    const res = await dispatchSystemActionCommand(client, cmd);
    expect(res.status).toBe('succeeded');
    expect(res.commandId).toBe(cmd.commandId);
    expect(res.resultRef).toBe('task:cal-1@1');
    expect(res.verificationMode).toBe('real');
    expect(res.breakReason).toBeNull();
  });

  it('四个 build*Command 产物都能接线派发（真实 KernelClient）', async () => {
    const commands: readonly Command[] = [
      buildCalendarEventCommand(baseCalendar()),
      buildReminderCommand(baseReminder()),
      buildResearchQueryCommand(baseSource()),
      buildResearchDeletionCommand({ ...baseSource(), expectedRevision: 4 }, {
        index: 'cascade',
        snippet: 'cascade',
        citations: 'cascade',
        derivedFacts: 'retain',
      }),
    ];
    for (const cmd of commands) {
      const terminal = makeEvent({
        seq: 1,
        commandId: cmd.commandId,
        status: 'succeeded',
        resultRef: 'task:x@1',
      });
      const s = scriptedTransport({ submit: () => Promise.resolve(terminal) });
      const client = createKernelClient({ transport: s.transport, caller: CALLER });
      const res = await dispatchSystemActionCommand(client, cmd);
      expect(res.status).toBe('succeeded');
      expect(res.resultRef).not.toBeNull();
    }
  });

  it('失败：终局 failed 带 error → failed + errorCode，resultRef 恒 null', async () => {
    const cmd = buildReminderCommand(baseReminder());
    const terminal = makeEvent({
      seq: 1,
      commandId: cmd.commandId,
      status: 'failed',
      error: { code: 'REMINDER_PERMISSION_DENIED', message: '权限被拒' },
    });
    const s = scriptedTransport({ submit: () => Promise.resolve(terminal) });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });

    const res = await dispatchSystemActionCommand(client, cmd);
    expect(res.status).toBe('failed');
    expect(res.errorCode).toBe('REMINDER_PERMISSION_DENIED');
    expect(res.resultRef).toBeNull();
  });

  it('断流：running 后通道断开 ⇒ progressUnknown，绝不 succeeded', async () => {
    const cmd = buildCalendarEventCommand(baseCalendar());
    let resolveSubmit!: (event: Event) => void;
    const s = scriptedTransport({
      submit: () =>
        new Promise<Event>((resolve) => {
          resolveSubmit = resolve;
        }),
    });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const pending = dispatchSystemActionCommand(client, cmd);

    s.emit(makeEvent({ seq: 1, commandId: cmd.commandId, status: 'running' }));
    client.signalStreamBreak('transport-closed', 'WebView 已卸载');
    // 迟到的成功事件不得翻案。
    resolveSubmit(makeEvent({ seq: 2, commandId: cmd.commandId, status: 'succeeded', resultRef: 'task:late@1' }));

    const res = await pending;
    expect(res.status).toBe('progressUnknown');
    expect(res.resultRef).toBeNull();
    expect(res.breakReason).toBe('transport-closed');
    expect(res.lastEvent?.seq).toBe(1);
  });

  it('坏终局：succeeded 缺 resultRef ⇒ progressUnknown（invalid-terminal）', async () => {
    const cmd = buildCalendarEventCommand(baseCalendar());
    const bad = makeEvent({ seq: 1, commandId: cmd.commandId, status: 'succeeded' });
    const s = scriptedTransport({ submit: () => Promise.resolve(bad) });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });

    const res = await dispatchSystemActionCommand(client, cmd);
    expect(res.status).toBe('progressUnknown');
    expect(res.resultRef).toBeNull();
  });

  it('提交被拒：submit reject ⇒ progressUnknown（submit-rejected），不静默成功', async () => {
    const cmd = buildResearchQueryCommand(baseSource());
    const failure = Object.assign(new Error('命令形状非法'), { code: 'COMMAND_INVALID' });
    const s = scriptedTransport({ submit: () => Promise.reject(failure) });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });

    const res = await dispatchSystemActionCommand(client, cmd);
    expect(res.status).toBe('progressUnknown');
    expect(res.breakReason).toBe('submit-rejected');
    expect(res.resultRef).toBeNull();
  });

  it('客户端已关闭：不提交，直接 progressUnknown', async () => {
    const cmd = buildCalendarEventCommand(baseCalendar());
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    client.signalStreamBreak('transport-closed');
    expect(client.state).toBe('closed');

    const res = await dispatchSystemActionCommand(client, cmd);
    expect(res.status).toBe('progressUnknown');
    expect(res.resultRef).toBeNull();
  });

  it('反向对照：非 system-action 命令被拒（unknown-system-action-kind）', async () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const foreign: Command = {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-foreign',
      operation: 'create',
      idempotencyKey: 'idem-foreign',
      payload: { goal: '无关命令' },
    };
    await expect(dispatchSystemActionCommand(client, foreign)).rejects.toBeInstanceOf(SystemActionError);
    await expect(dispatchSystemActionCommand(client, foreign)).rejects.toMatchObject({
      code: 'unknown-system-action-kind',
    });
  });
});
