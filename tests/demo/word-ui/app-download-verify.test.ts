/**
 * WCF-D08 缺口 3 的**端到端复现**：在真实 `apps/demo/web/app.js` 上点「下载到手机
 * （浏览器路径）」，验证：
 *   - 不能计算摘要时**不会**产生 download_verified 事件；
 *   - 「未计算」与「计算不符」是两种可区分的状态；
 *   - 校验不符时放弃保存（不触发下载、不发事件）。
 */

import { describe, expect, it } from 'vitest';

import { createAppHarness } from './harness.js';

function observationKinds(entries: ReadonlyArray<{ body: Record<string, unknown> }>): string[] {
  return entries.map((entry) => String(entry.body['kind']));
}

describe('browserSave：摘要未计算', () => {
  it('不发布 download_verified，只记交接观察，并在文案里写明未核对校验值', async () => {
    const harness = await createAppHarness({ digestMode: 'unavailable' });
    harness.click('save-browser-btn');
    await harness.flush();

    const kinds = observationKinds(harness.observations);
    expect(kinds).not.toContain('download_verified');
    expect(kinds).toContain('handoff_requested');

    expect(harness.anchorClicks).toHaveLength(1);
    const status = harness.debug.downloadStatusText();
    expect(status).toContain('未核对校验值');
    expect(status).not.toContain('校验值都与电脑端登记一致');
  });
});

describe('browserSave：摘要已计算且一致', () => {
  it('发布 download_verified，且不额外发交接观察', async () => {
    const harness = await createAppHarness({ digestMode: 'match' });
    harness.click('save-browser-btn');
    await harness.flush();

    const kinds = observationKinds(harness.observations);
    expect(kinds).toEqual(['download_verified']);
    expect(harness.anchorClicks).toHaveLength(1);
    expect(harness.debug.downloadStatusText()).toContain('长度与校验值都与电脑端登记一致');
  });
});

describe('browserSave：摘要计算不符', () => {
  it('放弃保存：不下载、不发任何事件，且文案与「未计算」不同', async () => {
    const mismatch = await createAppHarness({ digestMode: 'mismatch' });
    mismatch.click('save-browser-btn');
    await mismatch.flush();

    const unavailable = await createAppHarness({ digestMode: 'unavailable' });
    unavailable.click('save-browser-btn');
    await unavailable.flush();

    expect(mismatch.anchorClicks).toHaveLength(0);
    expect(mismatch.observations).toHaveLength(0);

    const mismatchStatus = mismatch.debug.downloadStatusText();
    const unavailableStatus = unavailable.debug.downloadStatusText();
    expect(mismatchStatus).toContain('校验值与登记不符');
    expect(mismatchStatus).not.toBe(unavailableStatus);
    expect(mismatchStatus).not.toContain('未核对校验值');
  });
});

describe('browserSave：长度不符', () => {
  it('即使摘要能对上，长度不符也放弃保存且不发事件', async () => {
    const harness = await createAppHarness({ digestMode: 'match', recordedByteLength: 99 });
    harness.click('save-browser-btn');
    await harness.flush();

    expect(harness.anchorClicks).toHaveLength(0);
    expect(harness.observations).toHaveLength(0);
    expect(harness.debug.downloadStatusText()).toContain('长度与登记不一致');
  });
});
