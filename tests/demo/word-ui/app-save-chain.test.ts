/**
 * WCF-D08 缺口 1 的**端到端复现**：在真实 `apps/demo/web/app.js` 上点真按钮、
 * 走真回执回调，验证「并发 / 迟到 / 旧超时 / 无身份回执」不串单。
 *
 * 夹具用 node:vm + 最小 DOM 桩执行线上那一份 app.js（不复制实现）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WEB_DIR, createAppHarness } from './harness.js';

describe('app.js：桥回执绑定操作身份', () => {
  it('并发两次应用内保存、回执乱序到达时各自归位', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    expect(harness.nativeCalls).toHaveLength(0);

    harness.click('save-native-btn');
    harness.click('save-copy-btn');

    expect(harness.nativeCalls).toHaveLength(2);
    const callA = harness.nativeCalls[0];
    const callB = harness.nativeCalls[1];
    expect(callA?.method).toBe('saveDocx');
    expect(callB?.method).toBe('saveCopy');
    expect(callA?.args).toHaveLength(5);
    expect(callB?.args).toHaveLength(5);

    const opA = String(callA?.args[4]);
    const opB = String(callB?.args[4]);
    expect(opA).not.toBe(opB);

    /* 乱序：后发的 B 先回执，先发的 A 后回执。 */
    harness.bridgeResult(opB, true, '副本已写入');
    harness.bridgeResult(opA, false, '系统拒绝');

    const records = harness.debug.bridgeRecords();
    expect(records).toHaveLength(2);

    const recordA = records.find((r) => r['operationId'] === opA);
    const recordB = records.find((r) => r['operationId'] === opB);

    expect(recordA?.['ok']).toBe(false);
    expect(recordA?.['message']).toBe('系统拒绝');
    expect(recordA?.['method']).toBe('saveDocx');
    expect(recordA?.['terminalReason']).toBe('callback');
    expect(recordB?.['ok']).toBe(true);
    expect(recordB?.['message']).toBe('副本已写入');
    expect(recordB?.['method']).toBe('saveCopy');
    expect(harness.debug.pendingCount()).toBe(0);
  });

  it('每次桥调用都记录 documentId 与 revision', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable', taskRevision: 7 });
    harness.click('save-native-btn');
    const record = harness.debug.bridgeRecords()[0];
    expect(record?.['documentId']).toBe('task-1');
    expect(record?.['revision']).toBe(7);
    expect(record?.['artifactId']).toBe('art-1');
  });

  it('请求参数仍是原来的四元组顺序，operationId 只作为第 5 个追加参数', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-native-btn');
    const args = harness.nativeCalls[0]?.args ?? [];
    expect(args[0]).toBe('/api/artifacts/art-1/download');
    expect(args[1]).toBe('document.docx');
    expect(typeof args[2]).toBe('string');
    expect(typeof args[3]).toBe('number');
    expect(String(args[4])).toMatch(/^bop-/);
  });
});

describe('app.js：旧 90 秒计时器不串单', () => {
  it('旧计时器只终结自己那条，不清掉他人待决状态、也不发迟到请求', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-native-btn');
    harness.clock.advance(1000);        /* 第一次请求先登记，它的 90 秒先到 */
    harness.click('save-copy-btn');

    const opA = String(harness.nativeCalls[0]?.args[4]);
    const opB = String(harness.nativeCalls[1]?.args[4]);

    const callsBefore = harness.nativeCalls.length;
    harness.clock.advance(89000);       /* 只跨过第一次请求自己的期限 */

    /* 不得发任何迟到请求。 */
    expect(harness.nativeCalls).toHaveLength(callsBefore);

    const records = harness.debug.bridgeRecords();
    expect(records.find((r) => r['operationId'] === opA)?.['terminalReason']).toBe('timeout');
    expect(records.find((r) => r['operationId'] === opB)?.['terminal']).toBe(false);
    expect(harness.debug.pendingCount()).toBe(1);

    /* 界面仍显示 B 在等待，而不是被 A 的超时文案顶掉。 */
    const status = harness.debug.downloadStatusText();
    expect(status).toContain('等待回执');
    expect(status).not.toContain('一直没有收到完成回执');

    /* B 随后回执 ⇒ 界面切到 B 的结果。 */
    harness.bridgeResult(opB, true, '另存完成');
    expect(harness.debug.downloadStatusText()).toContain('已交给系统软件处理');
    expect(harness.debug.pendingCount()).toBe(0);
  });

  it('超时后到达的迟到回执不产生副作用', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-native-btn');
    harness.clock.advance(1000);
    harness.click('save-copy-btn');

    const opA = String(harness.nativeCalls[0]?.args[4]);
    const opB = String(harness.nativeCalls[1]?.args[4]);
    harness.clock.advance(89000);

    const statusBefore = harness.debug.downloadStatusText();
    harness.bridgeResult(opA, true, '迟到的成功');

    const recordA = harness.debug.bridgeRecords().find((r) => r['operationId'] === opA);
    expect(recordA?.['ok']).toBe(false);
    expect(recordA?.['message']).toBe('');
    expect(recordA?.['terminalReason']).toBe('timeout');
    expect(harness.debug.downloadStatusText()).toBe(statusBefore);
    expect(harness.debug.pendingCount()).toBe(1);
    expect(String(harness.nativeCalls[1]?.args[4])).toBe(opB);
  });
});

describe('app.js：无身份回执的兜底', () => {
  it('多条待决时，旧签名回执被拒绝归位（不猜、不串单）', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-native-btn');
    harness.click('save-copy-btn');

    const statusBefore = harness.debug.downloadStatusText();
    harness.bridgeResult(true, '没有身份的野生回执');

    expect(harness.debug.pendingCount()).toBe(2);
    for (const record of harness.debug.bridgeRecords()) {
      expect(record['terminal']).toBe(false);
    }
    expect(harness.debug.downloadStatusText()).toBe(statusBefore);
  });

  it('恰好一条待决时，旧签名回执仍能归位（兼容未升级的原生实现）', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-native-btn');
    harness.bridgeResult(true, '系统已接收');

    const record = harness.debug.bridgeRecords()[0];
    expect(record?.['ok']).toBe(true);
    expect(record?.['message']).toBe('系统已接收');
    expect(record?.['terminalReason']).toBe('callback_legacy');
    expect(harness.debug.downloadStatusText()).toContain('已交给系统软件处理');
  });

  it('原生实现拒不接收第 5 参数时退回旧签名，并标记该回执没有身份', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable', nativeApi: 'arity-strict' });
    harness.click('save-native-btn');

    expect(harness.nativeCalls).toHaveLength(1);
    expect(harness.nativeCalls[0]?.args).toHaveLength(4);

    const record = harness.debug.bridgeRecords()[0];
    expect(record?.['legacy']).toBe(true);
    expect(record?.['terminal']).toBe(false);

    harness.bridgeResult(true, '旧桥回执');
    expect(harness.debug.bridgeRecords()[0]?.['ok']).toBe(true);
  });

  it('没有待决操作时，旧签名回执不会凭空造出状态', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-native-btn');
    const op = String(harness.nativeCalls[0]?.args[4]);
    harness.bridgeResult(op, true, '第一次');
    const settledText = harness.debug.downloadStatusText();

    harness.bridgeResult(true, '多出来的回执');

    expect(harness.debug.bridgeRecords()).toHaveLength(1);
    expect(harness.debug.downloadStatusText()).toBe(settledText);
  });
});

describe('app.js：应用内交接观察', () => {
  it('请求交接的观察记录里带操作身份', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-native-btn');
    const op = String(harness.nativeCalls[0]?.args[4]);
    const handoff = harness.observations.filter((entry) => entry.body['kind'] === 'handoff_requested');
    expect(handoff).toHaveLength(1);
    expect(String(handoff[0]?.body['detail'])).toContain(op);
  });
});

describe('页面装配', () => {
  it('index.html 在 app.js 之前加载 bridge-ops.js 与 download-verify.js', () => {
    const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
    const bridgeAt = html.indexOf('./bridge-ops.js');
    const verifyAt = html.indexOf('./download-verify.js');
    const appAt = html.indexOf('./app.js');
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(-1);
    expect(bridgeAt).toBeLessThan(appAt);
    expect(verifyAt).toBeLessThan(appAt);
  });
});
