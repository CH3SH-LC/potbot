/**
 * MT-07 / MT-08 用例：交接的生成、参数绑定、四种失败分别处理、
 * 气泡过期 / 重复点击 / 返回，以及"**不直接购买/支付**、不把交接记为购买成功"。
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { createActionLedger } from '../clock/action-contract.js';
import { FORBIDDEN_MEITUAN_ACTIONS, assertNotPurchaseAction } from './contract.js';
import type { MeituanHandoffPort, TargetCheck } from './handoff.js';
import {
  HANDOFF_ACTION_NAME,
  assertTargetBoundToSelection,
  createHandoffLedger,
  generateHandoffBubble,
  settleOnReturn,
  verifyAndHandoff,
  type HandoffBubble,
  type HandoffLinkPort,
  type HandoffVerification,
  type SelectionState,
} from './handoff-verify.js';

const T = 1_780_000_000_000;

function linkPort(uri = 'meituan://shop/c1', expiresAtMs: number | null = T + 60_000): HandoffLinkPort {
  return {
    sourceId: 'controlled-link-1',
    buildTarget: () => Promise.resolve({ ok: true, kind: 'deeplink', uri, expiresAtMs }),
  };
}

function countingPort(delivered = true): { port: MeituanHandoffPort; calls: () => number } {
  let calls = 0;
  return {
    port: {
      open: () => {
        calls += 1;
        return Promise.resolve({ delivered, handlerLabel: '美团', detail: '已打开目标页' });
      },
    },
    calls: () => calls,
  };
}

const GOOD: TargetCheck = { appInstalled: true, linkValid: true, targetMatches: true };

async function bubbleFor(selection: SelectionState, bubbleId = 'b1'): Promise<HandoffBubble> {
  const generated = await generateHandoffBubble(linkPort(), selection, bubbleId);
  if (generated.status !== 'ok') throw new Error('气泡生成应当成功');
  return generated.bubble;
}

describe('MT-07：链接必须来自受控 / 已核实来源', () => {
  it('没有受控链接来源 ⇒ not_ready、bubble 为 null（不自造深链）', async () => {
    const generated = await generateHandoffBubble(null, { candidateId: 'c1', revision: 1 }, 'b1');
    expect(generated.status).toBe('not_ready');
    expect(generated.bubble).toBeNull();
    if (generated.bubble !== null) return;
    expect(generated.reason).toMatch(/不.*自造|未接通受控/);
  });

  it('受控来源不可用 ⇒ unavailable，bubble 仍为 null', async () => {
    const failing: HandoffLinkPort = {
      sourceId: 'controlled-link-1',
      buildTarget: () => Promise.resolve({ ok: false, reason: '门店未授权' }),
    };
    const generated = await generateHandoffBubble(failing, { candidateId: 'c1', revision: 1 }, 'b1');
    expect(generated.status).toBe('unavailable');
    expect(generated.bubble).toBeNull();
    if (generated.bubble !== null) return;
    expect(generated.reason).toContain('门店未授权');
  });
});

describe('MT-07：参数与**当前选择**绑定', () => {
  it('生成的气泡把选择版本写进目标', async () => {
    const bubble = await bubbleFor({ candidateId: 'c1', revision: 3 });
    expect(bubble.target.candidateId).toBe('c1');
    expect(bubble.target.selectionRevision).toBe(3);
    expect(() => assertTargetBoundToSelection(bubble)).not.toThrow();
  });

  it('**反向对照**：目标与气泡记录的选择不一致 ⇒ 当场抛错', async () => {
    const bubble = await bubbleFor({ candidateId: 'c1', revision: 3 });
    const tampered: HandoffBubble = {
      ...bubble,
      target: { ...bubble.target, candidateId: 'c2' },
    };
    expect(() => assertTargetBoundToSelection(tampered)).toThrow(/拒绝使用/);

    const wrongRevision: HandoffBubble = { ...bubble, target: { ...bubble.target, selectionRevision: 9 } };
    expect(() => assertTargetBoundToSelection(wrongRevision)).toThrow(/绑定不一致/);
  });
});

describe('MT-07：四种失败**分别处理**', () => {
  it('App 未安装 / 链接过期 / 目标不符 各自独立 code，且都不触碰外部', async () => {
    const cases: readonly { readonly name: string; readonly check: TargetCheck; readonly code: string }[] = [
      { name: 'App 未安装', check: { ...GOOD, appInstalled: false }, code: 'app_not_installed' },
      { name: '链接过期', check: { ...GOOD, linkValid: false }, code: 'link_expired' },
      { name: '目标不符', check: { ...GOOD, targetMatches: false }, code: 'target_mismatch' },
    ];
    const selection: SelectionState = { candidateId: 'c1', revision: 1 };
    for (const item of cases) {
      const { port, calls } = countingPort();
      const bubble = await bubbleFor(selection);
      const verification = await verifyAndHandoff(port, {
        bubble,
        currentSelection: selection,
        check: item.check,
        nowMs: T,
      });
      expect(verification.readiness?.kind, item.name).toBe('failure');
      if (verification.readiness?.kind !== 'failure') continue;
      expect(verification.readiness.code, item.name).toBe(item.code);
      expect(calls(), item.name).toBe(0); // 校验不过 ⇒ 不打开外部
      expect(verification.state).toBe('failed');
      expect(verification.purchase_confirmed).toBe(false);
    }
  });

  it('**气泡过期**（选择已变）⇒ stale_selection，不打开旧页面', async () => {
    const { port, calls } = countingPort();
    const bubble = await bubbleFor({ candidateId: 'c1', revision: 1 });
    const verification = await verifyAndHandoff(port, {
      bubble,
      currentSelection: { candidateId: 'c2', revision: 2 },
      check: GOOD,
      nowMs: T,
    });
    expect(verification.readiness?.kind).toBe('failure');
    if (verification.readiness?.kind !== 'failure') return;
    expect(verification.readiness.code).toBe('stale_selection');
    expect(verification.readiness.reason).toMatch(/过期/);
    expect(calls()).toBe(0);
    expect(verification.notes.join()).toMatch(/未触碰外部/);
  });

  it('链接超出有效期（now > expiresAtMs）⇒ link_expired', async () => {
    const { port } = countingPort();
    const bubble = await bubbleFor({ candidateId: 'c1', revision: 1 });
    const verification = await verifyAndHandoff(port, {
      bubble,
      currentSelection: { candidateId: 'c1', revision: 1 },
      check: GOOD,
      nowMs: T + 600_000,
    });
    expect(verification.readiness?.kind).toBe('failure');
    if (verification.readiness?.kind !== 'failure') return;
    expect(verification.readiness.code).toBe('link_expired');
  });
});

describe('MT-08：重复点击**不重复执行**', () => {
  it('同一气泡点两次 ⇒ 第二次 duplicate=true 且**不**再次打开外部', async () => {
    const { port, calls } = countingPort();
    const ledger = createActionLedger();
    const selection: SelectionState = { candidateId: 'c1', revision: 1 };
    const bubble = await bubbleFor(selection);
    const attempt = { bubble, currentSelection: selection, check: GOOD, nowMs: T };

    const first = await verifyAndHandoff(port, attempt, ledger);
    const second = await verifyAndHandoff(port, attempt, ledger);

    expect(first.duplicate).toBe(false);
    expect(first.state).toBe('handed_off');
    expect(second.duplicate).toBe(true);
    expect(second.state).toBe('handed_off'); // 复用既有条目状态
    expect(second.result).toBeNull();
    expect(second.readiness).toBeNull(); // 没有新的对外动作
    expect(calls()).toBe(1);
    expect(second.notes.join()).toMatch(/重复点击/);
    expect(ledger.activeCount()).toBe(1);
  });
});

describe('MT-08：交接成功最高只到「已交接」，永不记为购买成功', () => {
  it('正常交接 ⇒ handed_off，purchase_confirmed 恒为 false', async () => {
    const { port } = countingPort(true);
    const selection: SelectionState = { candidateId: 'c1', revision: 1 };
    const bubble = await bubbleFor(selection);
    const verification = await verifyAndHandoff(port, {
      bubble,
      currentSelection: selection,
      check: GOOD,
      nowMs: T,
    });
    expect(verification.state).toBe('handed_off');
    expect(verification.state).not.toBe('confirmed');
    expect(verification.purchase_confirmed).toBe(false);
    expect(verification.notes.join()).toMatch(/不等于下单成功/);

    // 类型层：purchase_confirmed 必须是字面量 false，否则这行编译不过。
    type MustBeFalse<T extends false> = T;
    const literalCheck: MustBeFalse<HandoffVerification['purchase_confirmed']> = false;
    expect(literalCheck).toBe(false);
  });

  it('打开失败 ⇒ failed，也不记为购买成功', async () => {
    const { port } = countingPort(false);
    const selection: SelectionState = { candidateId: 'c1', revision: 1 };
    const bubble = await bubbleFor(selection);
    const verification = await verifyAndHandoff(port, {
      bubble,
      currentSelection: selection,
      check: GOOD,
      nowMs: T,
    });
    expect(verification.state).toBe('failed');
    expect(verification.purchase_confirmed).toBe(false);
  });
});

describe('MT-08：返回后结算 —— 外部结果不可读 ⇒ 保留未知', () => {
  it('不可读回 ⇒ unknown，不记为购买成功', () => {
    const verification = settleOnReturn('handed_off', { readable: false, detail: '页面没有可读回执' });
    expect(verification.state).toBe('unknown');
    expect(verification.purchase_confirmed).toBe(false);
    expect(verification.notes.join()).toMatch(/不.*记为购买成功/);
    expect(verification.readiness).toBeNull();
  });

  it('**可读回**且带观测 ⇒ 才可确认完成（唯一路径）', () => {
    const verification = settleOnReturn('handed_off', {
      readable: true,
      detail: '订单已存在',
      observed: { orderId: 'o-1' },
    });
    expect(verification.state).toBe('confirmed');
    expect(verification.result?.receipt.kind).toBe('readback');
    expect(verification.purchase_confirmed).toBe(false); // 仍不把"完成"说成"已购买"
  });
});

describe('MT-08 / R246：不直接购买 / 支付', () => {
  it('交接动作名不是购买/支付类（过 assertNotPurchaseAction 不抛）', () => {
    expect(() => assertNotPurchaseAction(HANDOFF_ACTION_NAME)).not.toThrow();
  });

  it('**反向对照**：把动作名换成支付/下单类 ⇒ 当场抛错', () => {
    for (const forbidden of FORBIDDEN_MEITUAN_ACTIONS) {
      expect(() => assertNotPurchaseAction(forbidden), forbidden).toThrow(/不直接购买\/支付/);
    }
  });
});

// ---------------------------------------------------------------------------
// I-5 生产接线：默认台账（createHandoffLedger）必须按**版本**判重
// ---------------------------------------------------------------------------

describe('I-5：createHandoffLedger（生产默认台账）按版本敏感判重', () => {
  it('同 requestId、revision 1 vs 999 ⇒ **不是**同一动作（改前 duplicate=true 且复用旧条目）', () => {
    const ledger = createHandoffLedger();
    const first = ledger.begin({ requestId: 'mt-1', toolId: 'cap.meituan.handoff', revision: 1 }, 0);
    const second = ledger.begin({ requestId: 'mt-1', toolId: 'cap.meituan.handoff', revision: 999 }, 1);
    expect(first.duplicate).toBe(false);
    // 改前（默认无参 createActionLedger）：second.duplicate === true，且请求版本被复用为 1。
    expect(second.duplicate).toBe(false);
    expect(second.entry.request.revision).toBe(999);
    // 被取代的旧版本条目不计入未决。
    expect(ledger.activeCount()).toBe(1);
    expect(ledger.supersededEntries().map((entry) => entry.request.revision)).toEqual([1]);
  });

  it('【反向对照】同 requestId、同 revision 的重复点击**仍**命中既有条目', () => {
    const ledger = createHandoffLedger();
    const first = ledger.begin({ requestId: 'mt-2', toolId: 'cap.meituan.handoff', revision: 3 }, 0);
    const again = ledger.begin({ requestId: 'mt-2', toolId: 'cap.meituan.handoff', revision: 3 }, 1);
    expect(again.duplicate).toBe(true);
    expect(again.entry).toBe(first.entry);
  });

  it('【源码级】verifyAndHandoff 的默认台账来自 createHandoffLedger（注入了版本敏感选项）', () => {
    const text = readFileSync(new URL('./handoff-verify.ts', import.meta.url), 'utf8');
    expect(text).toMatch(/ledger:\s*ActionLedger\s*=\s*createHandoffLedger\(\)/);
    const calls = [...text.matchAll(/createActionLedger\(([^)]*)\)/g)].map((match) => match[1] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args.trim()).toContain('versionAwareClockLedgerOptions');
  });
});
