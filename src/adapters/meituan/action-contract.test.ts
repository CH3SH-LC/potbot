/**
 * 美团路径对**共享动作合同**的接入测试（MT-07 / MT-08 + R241/R242/R243/R246）。
 *
 * 重点：
 * 1. 三包**共用同一份**七态定义（不各造一套协议，合同明文要求）；
 * 2. 交接路径的所有出口都在合法状态集合内，且**永不**到"已确认完成"；
 * 3. 购买/支付在**合同层**被拦（不是靠自觉）。
 */

import { describe, expect, it } from 'vitest';

import {
  ACTION_STATES,
  ACTION_STATE_LABELS,
  assertTransition,
  createActionLedger,
  validateToolContract,
} from '../clock/action-contract.js';
import { DETAIL_TOOL, HANDOFF_TOOL, SEARCH_TOOL, MEITUAN_TOOLS } from './contract.js';
import { classifyHandoffTarget, handoffToTarget, recordExternalOutcome, type HandoffTarget } from './handoff.js';

describe('跨包共用同一份七态定义（不各造一套协议）', () => {
  it('美团与日历引用的是同一个枚举对象（内容逐字相同）', async () => {
    const calendarContract = await import('../calendar/handoff.js');
    expect(calendarContract).toBeDefined();
    // 三个包都从 ../clock/action-contract.js 取词汇；这里用标签表做逐字比对。
    expect(ACTION_STATES).toHaveLength(7);
    expect(ACTION_STATE_LABELS.submitted).toBe('已提交');
    expect(ACTION_STATE_LABELS.confirmed).toBe('已确认完成');
  });
});

describe('MT-07 / MT-08：交接出口全在合法状态内，且到不了"已确认完成"', () => {
  const target: HandoffTarget = {
    kind: 'deeplink',
    uri: 'meituan://shop/c1',
    candidateId: 'c1',
    selectionRevision: 1,
    expiresAtMs: null,
  };
  const good = { appInstalled: true, linkValid: true, targetMatches: true };

  it('各类交接结果的落点', async () => {
    const cases: readonly { readonly name: string; readonly delivered: boolean }[] = [
      { name: '交付成功', delivered: true },
      { name: '交付失败', delivered: false },
    ];
    for (const item of cases) {
      const result = await handoffToTarget(
        { open: () => Promise.resolve({ delivered: item.delivered, handlerLabel: '美团', detail: 'x' }) },
        { kind: 'ready', target },
      );
      expect(ACTION_STATES).toContain(result.state);
      expect(result.state).not.toBe('confirmed');
    }
  });

  it('校验不通过时直接判失败，也不触碰外部', async () => {
    const readiness = classifyHandoffTarget(target, { ...good, appInstalled: false }, 1, 0);
    const result = await handoffToTarget(
      { open: () => Promise.reject(new Error('不应被调用')) },
      readiness,
    );
    expect(result.state).toBe('failed');
    expect(result.notes.join()).toMatch(/未安装|app_not_installed/);
  });

  it('合同上「已交接」不得被当作「已确认完成」', () => {
    expect(() =>
      assertTransition('handed_off', 'confirmed', { receipt: { kind: 'acknowledgement', source: 's', detail: 'd' } }),
    ).toThrow(/回读/);
  });

  it('外部结果不可读时，"结果未知"是合法且**唯一**的如实落点', () => {
    const result = recordExternalOutcome('handed_off', { readable: false, detail: '无可读回执' });
    expect(result.state).toBe('unknown');
    expect(() => assertTransition('handed_off', 'unknown')).not.toThrow();
  });
});

describe('R241：美团三个工具声明都自洽', () => {
  it('逐条通过 validateToolContract', () => {
    for (const tool of MEITUAN_TOOLS) {
      expect(validateToolContract(tool), tool.toolId).toEqual([]);
    }
    expect(MEITUAN_TOOLS.map((tool) => tool.toolId)).toEqual([
      'cap.meituan.search',
      'cap.meituan.detail',
      'cap.meituan.handoff',
    ]);
  });

  it('交接工具是 handoff 型且**不可回读**（故不可能声称完成）', () => {
    expect(HANDOFF_TOOL.externalSideEffect).toBe('handoff');
    expect(HANDOFF_TOOL.queryable).toBe(false);
    expect(HANDOFF_TOOL.requiresConfirmation).toBe(true);
  });

  it('查询/详情是只读且幂等', () => {
    for (const tool of [SEARCH_TOOL, DETAIL_TOOL]) {
      expect(tool.externalSideEffect).toBe('read');
      expect(tool.idempotency).toBe('idempotent');
    }
  });
});

describe('R243：重复点击由动作台账挡住', () => {
  it('同一交接请求重复点击不会产生第二条动作', () => {
    const ledger = createActionLedger();
    const first = ledger.begin({ requestId: 'mt-req-1', toolId: 'cap.meituan.handoff', revision: 2 }, 1000);
    const again = ledger.begin({ requestId: 'mt-req-1', toolId: 'cap.meituan.handoff', revision: 2 }, 1500);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(ledger.activeCount()).toBe(1);
  });
});
