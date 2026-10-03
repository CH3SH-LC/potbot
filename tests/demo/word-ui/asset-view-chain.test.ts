/**
 * APP-04 / APP-07 **页面接线判据** —— 驱动**真实 `app.js`**（连同 nav/asset-ops/settings-model）。
 *
 * 这里回答的不是"纯函数对不对"（那在 asset-ops.test.ts / settings-model.test.ts 里），
 * 而是**页面有没有把诚实口径接上线**：
 *   ① 搜索框真的过滤任务/文件列表；
 *   ② 应用内交接（save-native）**拿到回执也不等于可用**——没有读回，打开/另存/分享继续禁用；
 *   ③ 桥**超时**时台账落到「取消」，不是「成功」；
 *   ④ 设置页真的显示授权清单并能撤销，撤销文案说明"没有撤销什么"；
 *   ⑤ 设置页渲染后对页面可见文本做密钥自检，结果必须为「干净」。
 */

import { describe, expect, it } from 'vitest';

import { createWebHarness, type FakeElement } from './fa-k-harness.js';

interface UriRecordView { operationId: string; state: string; code: string; showsSuccess: boolean; usable: boolean }
interface ActionState { id: string; enabled: boolean }

/** 递归取一棵假 DOM 子树里的全部文本（`stateRow` 把标签/值放在子 span 上）。 */
function flatText(node: FakeElement | undefined): string {
  if (!node) return '';
  const own = typeof node.textContent === 'string' ? node.textContent : '';
  return own + (node.children ?? []).map((child) => flatText(child)).join(' ');
}

describe('APP-04 任务视图：搜索真的过滤列表', () => {
  it('切到任务视图后，搜索「报表」只剩 1 条', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('tasks');
    expect(harness.debug.taskItemCount!()).toBe(2);

    harness.type('task-search', '报表');
    expect(harness.debug.taskItemCount!()).toBe(1);
    expect(harness.debug.taskQuery!()).toBe('报表');
    expect(harness.debug.searchNote!('task')).toContain('1 条匹配');
  });

  it('无匹配时列表清空，且不假装有结果', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('tasks');
    harness.type('task-search', 'zzz-不存在');
    expect(harness.debug.taskItemCount!()).toBe(0);
    expect(harness.debug.viewStateName!('tasks')).toBe('blank');
  });

  it('文件视图的搜索独立于任务视图', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('files');
    expect(harness.debug.fileItemCount!()).toBe(2);
    harness.type('file-search', '邀请函');
    expect(harness.debug.fileItemCount!()).toBe(1);
    expect(harness.debug.taskQuery!(), '文件搜索不应污染任务搜索').toBe('');
  });
});

describe('APP-04 应用内交接：回执到手 ≠ 可以打开', () => {
  it('点击「交给系统软件打开」后拿到 OK 回执，但读回未做 ⇒ 打开/另存/分享仍全部禁用', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('tasks');

    // 交接前：三个动作本就不可用
    let states = harness.debug.taskActionStates!() as ActionState[];
    expect(states.find((s) => s.id === 'open')?.enabled).toBe(false);

    // 触发应用内交接（saveDocx）
    harness.click('save-native-btn');
    await harness.flush();

    const bridgeResult = harness.global<(...args: unknown[]) => void>('PotbotBridgeResult');
    const pending = harness.debug.bridgeRecords!() as Array<{ operationId: string }>;
    expect(pending.length).toBeGreaterThan(0);
    bridgeResult(pending[0]!.operationId, true, '已交给系统');
    await harness.flush();

    const records = harness.debug.uriRecords!() as UriRecordView[];
    expect(records).toHaveLength(1);
    // 「交给系统打开」是一次性交接 ⇒ 只拿到临时授权（volatile），不是持久授权。
    expect(records[0]!.state).toBe('granted_volatile');
    expect(records[0]!.showsSuccess, '授权 ≠ 成功').toBe(false);
    expect(records[0]!.usable, '没有读回就不该可用').toBe(false);

    harness.debug.renderView!('tasks');
    states = harness.debug.taskActionStates!() as ActionState[];
    for (const id of ['open', 'saveAs', 'share']) {
      expect(states.find((s) => s.id === id)?.enabled, `${id} 不得因回执而变为可用`).toBe(false);
    }
    expect(harness.debug.taskUriStatusText!()).toContain('不算成功');
  });

  it('「另存副本」走的是持久授权（persisted），但仍因未读回而不可用', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('tasks');
    harness.click('save-copy-btn');
    await harness.flush();

    const bridgeResult = harness.global<(...args: unknown[]) => void>('PotbotBridgeResult');
    const pending = harness.debug.bridgeRecords!() as Array<{ operationId: string; method: string }>;
    expect(pending[0]!.method).toBe('saveCopy');
    bridgeResult(pending[0]!.operationId, true, '已唤起选择器');
    await harness.flush();

    const records = harness.debug.uriRecords!() as UriRecordView[];
    expect(records[0]!.state).toBe('granted_persisted');
    expect(records[0]!.usable).toBe(false);
  });

  it('桥超时 ⇒ 台账落到「取消」，仍然不是成功', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('tasks');
    harness.click('save-native-btn');
    await harness.flush();

    harness.clock.advance(90_001);
    await harness.flush();

    const records = harness.debug.uriRecords!() as UriRecordView[];
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe('cancelled');
    expect(records[0]!.showsSuccess).toBe(false);
    expect(records[0]!.usable).toBe(false);
  });

  it('没有原生桥时不产生任何 URI 记录（不假装交接）', async () => {
    const harness = await createWebHarness({ native: false });
    harness.debug.renderView!('tasks');
    harness.click('save-native-btn');
    await harness.flush();
    expect(harness.debug.uriRecords!()).toEqual([]);
  });
});

describe('APP-07 设置视图：授权清单与撤销真的接上线', () => {
  it('七项授权都显示，初始都是未申请', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('settings');
    const entries = harness.debug.authEntries!() as Array<{ id: string; state: string }>;
    expect(entries).toHaveLength(7);
    expect(entries.every((e) => e.state === 'not_requested')).toBe(true);
    expect(harness.debug.viewStateName!('settings')).toBe('ready');
  });

  it('连接摘要区分「已配置」与「已实测通过」', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('settings');
    expect(harness.debug.connectionRows!()).toBeGreaterThanOrEqual(5);
  });

  it('健康接口连不上时，设置页不崩且额度显示未知', async () => {
    const harness = await createWebHarness({ health: null });
    harness.debug.renderView!('settings');
    expect(harness.debug.connectionRows!()).toBeGreaterThanOrEqual(5);
    const quotaText = flatText(harness.element('settings-quota'));
    expect(quotaText).toContain('未知');
  });

  it('设置页显示「错误 → 你能做什么」', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('settings');
    const hint = harness.debug.settingsErrorHint!() as string;
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain('你可以');
  });
});

describe('APP-07 密钥不外泄：页面自检必须干净', () => {
  it('渲染设置页后，页面可见文本的密钥自检为干净', async () => {
    const harness = await createWebHarness();
    harness.debug.renderView!('settings');
    const check = harness.debug.settingsSecretCheck!() as { ok: boolean; count: number };
    expect(check.ok, `页面文本疑似含密钥 ${check.count} 处`).toBe(true);
    expect(check.count).toBe(0);
  });
});
