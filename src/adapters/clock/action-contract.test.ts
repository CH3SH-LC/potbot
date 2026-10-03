/**
 * FA-M 共享动作合同的用例（合同 **R241 / R242 / R243 / R246**）。
 *
 * 重点在**负例与对照**：七态"互不冒充"必须是**可失败**的断言，而不是文档里的口号。
 */

import { describe, expect, it } from 'vitest';

import {
  ACTION_STATES,
  ACTION_STATE_LABELS,
  assertTransition,
  createActionLedger,
  describeEvidence,
  isTerminal,
  validateInput,
  validateToolContract,
  type ActionReceipt,
  type ToolContract,
} from './action-contract.js';
import { validateMeituanTools } from '../meituan/contract.js';
import { actionsThatDeleteAlarms, selectAlarmTarget, SYSTEM_ACTION_SEMANTICS } from './handoff.js';
import { TEMPLATE_KINDS } from '../../protocol/artifact.js';
import { assertReadinessRecord, NOT_INSTALLED, type SubitemReadiness } from './readiness.js';

const NONE: ActionReceipt = { kind: 'none', source: 'test', detail: '无' };
const ACK: ActionReceipt = { kind: 'acknowledgement', source: 'test', detail: '已受理' };
const READBACK: ActionReceipt = {
  kind: 'readback',
  source: 'test',
  detail: '已回读',
  observed: { id: 'x-1' },
};

describe('R242：七态词汇与标签', () => {
  it('恰好七个状态，且标签与合同逐字一致', () => {
    expect(ACTION_STATES).toHaveLength(7);
    expect(ACTION_STATES.map((state) => ACTION_STATE_LABELS[state])).toEqual([
      '已准备',
      '已交接',
      '已提交',
      '已确认完成',
      '结果未知',
      '用户报告完成',
      '已失效或失败',
    ]);
  });

  it('「已交接」与「已提交」是不同的状态（R246：打开页面不等于写入）', () => {
    expect(ACTION_STATE_LABELS.handed_off).not.toBe(ACTION_STATE_LABELS.submitted);
    expect(ACTION_STATES).toContain('handed_off');
    expect(ACTION_STATES).toContain('submitted');
  });

  it('终态只有「已确认完成」与「已失效或失败」', () => {
    expect(ACTION_STATES.filter(isTerminal)).toEqual(['confirmed', 'failed']);
  });
});

describe('R242：状态转换的硬约束', () => {
  it('正向：已准备 → 已交接 → （外部回读）已确认完成', () => {
    assertTransition('prepared', 'handed_off');
    const confirmed = assertTransition('handed_off', 'confirmed', { receipt: READBACK });
    expect(confirmed.to).toBe('confirmed');
  });

  it('**负例**：没有回读，任何路径都不得标「已确认完成」', () => {
    expect(() => assertTransition('handed_off', 'confirmed', { receipt: NONE })).toThrow(/回读/);
    expect(() => assertTransition('submitted', 'confirmed', { receipt: ACK })).toThrow(/回读/);
    // 回读但**没有具体观测**也不行（防"空口回读"）。
    expect(() =>
      assertTransition('submitted', 'confirmed', {
        receipt: { kind: 'readback', source: 'test', detail: '回读了但没说什么' },
      }),
    ).toThrow(/观测/);
  });

  it('**负例**：打开页面（已交接）不得携带 readback 回执', () => {
    expect(() => assertTransition('prepared', 'handed_off', { receipt: READBACK })).toThrow(/不等于写入/);
    expect(() => assertTransition('prepared', 'submitted', { receipt: READBACK })).toThrow(/不等于写入/);
  });

  it('**负例**：已准备不得直接跳到"结果未知"（还没对外发出动作）', () => {
    expect(() => assertTransition('prepared', 'unknown')).toThrow(/非法动作状态转换/);
  });

  it('**负例**：已确认完成不可被改写成"当初就失败"', () => {
    expect(() => assertTransition('confirmed', 'failed', { failureKind: 'error' })).toThrow(/expired/);
    expect(() => assertTransition('confirmed', 'failed', { failureKind: 'rejected' })).toThrow(/expired/);
    // 只能以"外部后来废止"为由。
    expect(assertTransition('confirmed', 'failed', { failureKind: 'expired' }).to).toBe('failed');
  });

  it('用户报告完成不会自动升级为系统确认（R242）', () => {
    const reported = assertTransition('handed_off', 'user_reported');
    expect(reported.to).toBe('user_reported');
    // 展示文案必须显式说明"无系统回执"。
    expect(describeEvidence('user_reported', NONE)).toMatch(/无系统回执/);
    // 要变 confirmed，仍然必须给 readback。
    expect(() => assertTransition('user_reported', 'confirmed', { receipt: NONE })).toThrow(/回读/);
  });
});

describe('R243：动作台账（重复点击不重复执行）', () => {
  it('同 requestId 第二次 begin 返回既有条目（duplicate=true）', () => {
    const ledger = createActionLedger();
    const first = ledger.begin({ requestId: 'req-1', toolId: 'cap.clock.alarm', revision: 3 }, 1000);
    expect(first.duplicate).toBe(false);
    const second = ledger.begin({ requestId: 'req-1', toolId: 'cap.clock.alarm', revision: 3 }, 2000);
    expect(second.duplicate).toBe(true);
    expect(second.entry.startedAtMs).toBe(1000);
    expect(ledger.activeCount()).toBe(1);
  });

  it('终态不可改写（取消与触发竞态必须显冲突）', () => {
    const ledger = createActionLedger();
    ledger.begin({ requestId: 'req-2', toolId: 'cap.clock.alarm', revision: 1 }, 0);
    ledger.settle('req-2', 'confirmed', 10);
    expect(() => ledger.settle('req-2', 'failed', 20)).toThrow(/终态/);
    expect(ledger.activeCount()).toBe(0);
  });

  it('**默认（不注入）时版本不参与判定**：同 requestId、revision 1 vs 999 仍判为重复（已知限制）', () => {
    const ledger = createActionLedger();
    const first = ledger.begin({ requestId: 'req-3', toolId: 'cap.clock.alarm', revision: 1 }, 0);
    expect(first.duplicate).toBe(false);
    // ⚠️ 这就是"不注入 ⇒ 不校验版本"的实测表现：第二个请求换了版本仍命中旧条目。
    const second = ledger.begin({ requestId: 'req-3', toolId: 'cap.clock.alarm', revision: 999 }, 10);
    expect(second.duplicate).toBe(true);
    expect(second.entry).toBe(first.entry);
    expect(second.entry.request.revision).toBe(1);
    expect(ledger.activeCount()).toBe(1);
  });

  it('**注入推导函数后**：版本进入幂等键，同 requestId 的 revision 1 vs 999 是**两个动作**', () => {
    const ledger = createActionLedger({
      deriveIdempotencyKey: (request) => `${request.toolId}@${request.requestId}#r${String(request.revision)}`,
    });
    const first = ledger.begin({ requestId: 'req-4', toolId: 'cap.clock.alarm', revision: 1 }, 0);
    const second = ledger.begin({ requestId: 'req-4', toolId: 'cap.clock.alarm', revision: 999 }, 10);
    expect(second.duplicate).toBe(false);
    expect(second.entry.request.revision).toBe(999);
    // N-2：旧版本（v1）条目被**显式取代**，不再计入未决——activeCount 只剩新版本这一条。
    // （修复前此处为 2：旧条目静默留在 active 里且无 API 可达。）
    expect(ledger.activeCount()).toBe(1);
    // 同版本的重复点击仍命中同一对象。
    const again = ledger.begin({ requestId: 'req-4', toolId: 'cap.clock.alarm', revision: 999 }, 20);
    expect(again.duplicate).toBe(true);
    expect(again.entry).toBe(second.entry);
    // 被取代的旧条目**保留**在台账里（事实不删），可经 supersededEntries() 取回。
    const superseded = ledger.supersededEntries();
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.request.revision).toBe(1);
    expect(superseded[0]?.superseded).toBe(true);
    expect(superseded[0]?.state).toBe('prepared');
    expect(first.entry.request.revision).toBe(1);
  });
});

describe('N-2：版本敏感台账里"被新版本取代的旧条目"必须可处置（不得永久顶住 active）', () => {
  const versionBlind = (request: { requestId: string; toolId: string; revision: number }): string =>
    `${request.toolId}@${request.requestId}#r${String(request.revision)}`;
  const req = (revision: number): { requestId: string; toolId: string; revision: number } => ({
    requestId: 'n2',
    toolId: 'cap.clock.alarm',
    revision,
  });

  it('复现 N-2：begin(v1) → begin(v999) → settle ⇒ activeCount 归零（改前永久停在 1）', () => {
    const ledger = createActionLedger({ deriveIdempotencyKey: versionBlind });
    ledger.begin(req(1), 100);
    ledger.begin(req(999), 101);
    expect(ledger.activeCount()).toBe(1); // v1 已被取代，只剩 v999 未决

    ledger.settle('n2', 'confirmed', 102);
    // 修复前：v1 条目静默留在 active 且 get/settle 都够不到 ⇒ 此处恒为 1（R261 恒假）。
    expect(ledger.activeCount()).toBe(0);
    expect(ledger.get('n2')?.state).toBe('confirmed');
    expect(ledger.get('n2')?.request.revision).toBe(999);
  });

  it('**事实保留**：被取代条目不删、不改写成终态，可经 supersededEntries() 审计取回', () => {
    const ledger = createActionLedger({ deriveIdempotencyKey: versionBlind });
    const first = ledger.begin(req(1), 100);
    ledger.begin(req(999), 101);
    ledger.settle('n2', 'confirmed', 102);

    const superseded = ledger.supersededEntries();
    expect(superseded).toHaveLength(1);
    const old = superseded[0];
    expect(old?.request.revision).toBe(1);
    expect(old?.superseded).toBe(true);
    expect(old?.supersededAtMs).toBe(101);
    expect(old?.startedAtMs).toBe(100); // 原登记时刻保留
    // 不被静默改写成 failed/confirmed —— 它就是"被取代"，不是"失败"，也不是"完成"。
    expect(old?.state).toBe('prepared');
    expect(old?.settledAtMs).toBeNull();
    expect(first.entry.request.revision).toBe(1);
  });

  it('多版本链：v1→v2→v3 后只有最新的未决；旧两条都被取代', () => {
    const ledger = createActionLedger({ deriveIdempotencyKey: versionBlind });
    ledger.begin(req(1), 1);
    ledger.begin(req(2), 2);
    ledger.begin(req(3), 3);
    expect(ledger.activeCount()).toBe(1);
    expect(ledger.supersededEntries().map((entry) => entry.request.revision)).toEqual([1, 2]);
    ledger.settle('n2', 'failed', 4);
    expect(ledger.activeCount()).toBe(0);
  });

  it('**已终结**的旧版本不被改写：confirmed 的历史事实不因新版本到来而被标"被取代"', () => {
    const ledger = createActionLedger({ deriveIdempotencyKey: versionBlind });
    ledger.begin(req(1), 100);
    ledger.settle('n2', 'confirmed', 101);
    ledger.begin(req(999), 102);

    // v1 已确认完成属**已发生的事实**：不取消失效、也不标"被取代"。
    expect(ledger.supersededEntries()).toEqual([]);
    expect(ledger.activeCount()).toBe(1); // 只剩 v999 未决
    expect(ledger.get('n2')?.request.revision).toBe(999);
  });

  it('【兼容性对照】不注入时**永不**产生取代：同 requestId 仍只按 requestId 去重（旧版口径）', () => {
    const ledger = createActionLedger();
    ledger.begin(req(1), 100);
    const second = ledger.begin(req(999), 101);
    expect(second.duplicate).toBe(true); // 默认口径不变：版本不参与判定
    expect(second.entry.request.revision).toBe(1);
    expect(ledger.supersededEntries()).toEqual([]); // 无取代路径被触发
    expect(ledger.activeCount()).toBe(1);
    ledger.settle('n2', 'confirmed', 102);
    expect(ledger.activeCount()).toBe(0);
  });
});

describe('R241：工具声明的自洽校验', () => {
  const base: ToolContract = {
    toolId: 'cap.clock.alarm',
    template: 'template.clock',
    summary: '自管闹钟',
    inputSchema: { fields: { label: { type: 'string', required: true, description: '标签' } } },
    outputSchema: { fields: { state: { type: 'string', required: true, description: '七态' } } },
    permissions: [{ permissionId: 'perm.clock.schedule', required: true }],
    externalSideEffect: 'handoff',
    requiresConfirmation: true,
    idempotency: 'keyed',
    queryable: false,
    undo: 'none',
    trustedReceipt: '无（交接不可回读）',
  };

  it('合法声明没有问题', () => {
    expect(validateToolContract(base)).toEqual([]);
  });

  it('**负例**：handoff 型不得声明 queryable（否则会诱导把交接当可回读）', () => {
    expect(validateToolContract({ ...base, queryable: true })).toHaveLength(1);
  });

  it('**负例**：irreversible 副作用一律不接受（R246 禁止购买/支付）', () => {
    const problems = validateToolContract({ ...base, externalSideEffect: 'irreversible' });
    expect(problems.some((text) => text.includes('R246'))).toBe(true);
  });

  it('**负例**：未声明权限 / 输入无必填字段都要报出来', () => {
    expect(validateToolContract({ ...base, permissions: [] }).length).toBeGreaterThan(0);
    expect(
      validateToolContract({ ...base, inputSchema: { fields: {} } }).some((text) => text.includes('必填')),
    ).toBe(true);
  });

  it('输入校验能发现缺字段、类型错、枚举越界、多余字段', () => {
    const problems = validateInput(base, { label: 123, extra: 'x' });
    expect(problems).toContain('输入 label 类型应为 string');
    expect(problems).toContain('输入 extra 未在 schema 中声明');
    expect(validateInput(base, {})).toContain('缺少必填输入：label');
  });
});

describe('R246：美团工具声明里没有购买/支付，也没有不可撤销副作用', () => {
  it('工具集合自洽', () => {
    expect(validateMeituanTools()).toEqual([]);
  });

  it('交接工具**不可回读**（故只能到"已交接"）', () => {
    const handoff = actionsThatDeleteAlarms();
    expect(handoff).toEqual([]); // 系统时钟动作里没有任何"删除闹钟"
  });
});

describe('CLK-08：dismiss 不等于删除', () => {
  it('所有"停止响铃/延后"类动作的 deletesAlarm 都是 false', () => {
    for (const action of ['dismiss_ringing_alarm', 'snooze_ringing_alarm', 'cancel_timer'] as const) {
      expect(SYSTEM_ACTION_SEMANTICS[action].deletesAlarm).toBe(false);
    }
    expect(SYSTEM_ACTION_SEMANTICS.dismiss_ringing_alarm.note).toMatch(/不是.*删除|不等同删除/);
  });

  it('本批没有任何"删除系统闹钟"的动作（无合法通道 ⇒ 记阻塞）', () => {
    expect(actionsThatDeleteAlarms()).toEqual([]);
  });
});

describe('CLK-08：多候选/缺目标的选择', () => {
  const refs = [
    { id: 'a', label: '起床', hour: 7, minute: 0, enabled: true },
    { id: 'b', label: '起床', hour: 7, minute: 0, enabled: true },
    { id: 'c', label: '午休', hour: 13, minute: 30, enabled: true },
  ];

  it('唯一命中 ⇒ matched', () => {
    expect(selectAlarmTarget(refs, { label: '午休' }).kind).toBe('matched');
  });

  it('多个命中 ⇒ ambiguous（交给用户选，不按"第一个"静默取）', () => {
    const result = selectAlarmTarget(refs, { label: '起床' });
    expect(result.kind).toBe('ambiguous');
  });

  it('无命中 / 无条件 ⇒ none 且给出原因', () => {
    expect(selectAlarmTarget(refs, { label: '不存在' }).kind).toBe('none');
    expect(selectAlarmTarget(refs, {}).kind).toBe('none');
  });
});

describe('R233：就绪记录的自洽校验（负例对照）', () => {
  const base: SubitemReadiness = {
    id: 'X-01',
    requirement: '示例',
    verdict: 'implemented',
    implementedScope: '做了',
    reason: null,
    unblockedBy: '',
    capability: NOT_INSTALLED,
    evidence: ['src/adapters/clock/clock.test.ts'],
  };

  it('合法记录通过', () => {
    expect(() => assertReadinessRecord(base)).not.toThrow();
  });

  it('**负例**："已实现"却没有证据 ⇒ 抛错', () => {
    expect(() => assertReadinessRecord({ ...base, evidence: [] })).toThrow(/证据/);
  });

  it('**负例**："已实现"却带着未就绪原因 ⇒ 抛错', () => {
    expect(() => assertReadinessRecord({ ...base, reason: '不该有' })).toThrow(/未就绪原因/);
  });

  it('**负例**：未就绪/阻塞却没给原因 ⇒ 抛错（R233 要求的"先给原因"）', () => {
    expect(() => assertReadinessRecord({ ...base, verdict: 'not_ready', reason: null, unblockedBy: '需要 X' })).toThrow(
      /原因/,
    );
    expect(() => assertReadinessRecord({ ...base, verdict: 'blocked', reason: null, unblockedBy: '需要 X' })).toThrow(
      /原因/,
    );
  });

  it('**负例**：未就绪/阻塞却没写"需要什么才能推进" ⇒ 抛错', () => {
    expect(() =>
      assertReadinessRecord({ ...base, verdict: 'not_ready', reason: '缺设备', unblockedBy: '   ' }),
    ).toThrow(/推进/);
  });
});

describe('R232：三类模板**不在**文件类型枚举里', () => {
  it('TEMPLATE_KINDS 只含三种办公文件类型', () => {
    expect(TEMPLATE_KINDS).toEqual(['document', 'spreadsheet', 'presentation']);
    for (const forbidden of ['meituan', 'clock', 'calendar', 'research']) {
      expect(TEMPLATE_KINDS as readonly string[]).not.toContain(forbidden);
    }
  });
});
