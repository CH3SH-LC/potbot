/**
 * FA-N：在**线上那一份 `app.js` / `list-intent.js`** 上验证**列表 / 编号入口已接线**。
 *
 * ## 这份用例为什么被改写过（如实记录口径变化）
 *
 * WCF-D72 的旧版记的是当时的事实，并且刻意装了一条**反向 tripwire**：
 * 「一旦内核真的加上列表意图，本用例**变红并指明去哪改**」。
 * FA-N 把缺的两段补上了（`http.ts` 的 `listIntent` 路由 + `session-host.ts` 的
 * `list_intent` 透传），旧用例因此**按设计变红**——这正是我们希望它变红的地方。
 * 本文件是那次变红之后的**新口径**。
 *
 * ## 新口径要证明的三件事
 *
 * 1. **真的接线了**：四个控件产出结构化操作，形状与
 *    `src/documents/session/list-ops.ts` 的 `ListIntentOperation` 逐字一致；
 * 2. **没有降级**：没有范围表达式就 `no_range`；不认识的控件就 `unknown_control`；
 *    混着段落步骤一起保存会被拒（服务端是**三选一**，不给"悄悄拆成两次版本"的机会）；
 * 3. **绝不伪造文本前缀**：`fabricatesTextPrefix` 恒为 `false`，且无论点多少次控件，
 *    预览正文**逐字不变**——正文里永远不会出现 `•` / `1.` 这类手打的假列表符号。
 *    列表是结构（`w:numPr` 引用 + `numbering.xml`），不是文字。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildDocx, sampleBlocks } from './docx-fixtures.js';
import { createEditorHarness } from './editor-harness.js';
import { loadWebGlobal, WEB_DIR } from './harness.js';

const SAMPLE = buildDocx(sampleBlocks());

/** 会被当成"伪造前缀"的字符：列表符号与常见手打编号（**不是**判据文本，是判别力）。 */
const FAKE_PREFIX_PATTERN = /(^|\s)([•▪◦●○※]|[-*+]\s|\d+[.)、]\s)/;

interface ListStep {
  readonly range: string;
  readonly operation: Record<string, unknown>;
}

interface ListModule {
  readonly KERNEL_LIST_OPERATION_KINDS: readonly string[];
  readonly MAX_LIST_LEVEL: number;
  readonly CONTROLS: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  capability(): string;
  gap(): {
    readonly capability: string;
    readonly kernelOperationKinds: readonly string[];
    readonly controls: readonly string[];
    readonly reason: string;
    readonly fabricatesTextPrefix: boolean;
    readonly kernelLayer: string;
    readonly httpEntry: string;
  };
  buildStep(
    range: string,
    controlId: string,
    value?: unknown,
  ): { readonly ok: boolean; readonly code?: string; readonly message?: string; readonly step?: ListStep };
  toListIntent(steps: readonly ListStep[]): { readonly steps: readonly ListStep[] };
  isListStep(step: unknown): boolean;
}

const ListLib = loadWebGlobal<ListModule>('list-intent.js', 'PotbotListIntent');

describe('FA-N list-intent：能力登记说的是实话（这次说的是"有"）', () => {
  it('内核列表意图已就绪 ⇒ capability 是 available，且仍然**没有任何**伪造文本前缀的路径', () => {
    expect(ListLib.gap().capability).toBe('available');
    expect(ListLib.gap().kernelOperationKinds).toEqual([
      'applyList', 'removeList', 'setListLevel', 'restartList',
    ]);
    /* 这一条**没有变**，也不能变：接线接了的是结构化列表，不是"往文字里塞符号"。 */
    expect(ListLib.gap().fabricatesTextPrefix).toBe(false);
    expect(ListLib.gap().kernelLayer).toContain('list-ops');
    expect(ListLib.gap().httpEntry).toContain('listIntent');
  });

  it('四个控件都产出**结构化操作**，形状与内核的 ListIntentOperation 一致', () => {
    expect(ListLib.CONTROLS.map((control) => control.id)).toEqual([
      'bullet', 'numbered', 'restartNumbering', 'removeList',
    ]);

    const bullet = ListLib.buildStep('第2段', 'bullet');
    expect(bullet.ok).toBe(true);
    expect(bullet.step).toEqual({ range: '第2段', operation: { kind: 'applyList', style: 'bullet', level: 0 } });

    /* 级别只认内核口径（0-based）：传 1 = 第 2 级。不在这里做 1-based 猜测——
       两套编号在 1–8 上完全重叠，猜错会把"1 级"静默变成"2 级"。 */
    const numbered = ListLib.buildStep('全文', 'numbered', 1);
    expect(numbered.step).toEqual({ range: '全文', operation: { kind: 'applyList', style: 'numbered', level: 1 } });

    const restart = ListLib.buildStep('第1段', 'restartNumbering');
    expect(restart.step).toEqual({ range: '第1段', operation: { kind: 'restartList' } });

    const remove = ListLib.buildStep('第1段', 'removeList');
    expect(remove.step).toEqual({ range: '第1段', operation: { kind: 'removeList' } });
  });

  it('**不降级**：没有范围表达式 / 不认识的控件 / 非法级别一律结构化拒绝，不给默认值', () => {
    expect(ListLib.buildStep('', 'bullet').code).toBe('no_range');
    expect(ListLib.buildStep('   ', 'bullet').code).toBe('no_range');
    expect(ListLib.buildStep('第1段', 'nope').code).toBe('unknown_control');
    expect(ListLib.buildStep('第1段', 'bullet', 99).code).toBe('invalid_value');
    expect(ListLib.buildStep('第1段', 'bullet', 1.5).code).toBe('invalid_value');
    for (const bad of ['', '   ', null, undefined]) {
      expect(ListLib.buildStep(bad as unknown as string, 'bullet').step).toBeUndefined();
    }
  });

  it('isListStep 只认列表域（段落 / 节步骤不会被误判成列表）', () => {
    expect(ListLib.isListStep({ range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 0 } })).toBe(true);
    expect(ListLib.isListStep({ range: '第1段', operation: { kind: 'setToggle', property: 'bold', value: true } })).toBe(false);
    expect(ListLib.isListStep({ range: '第1段', operation: { kind: 'setOrientation', orientation: 'landscape' } })).toBe(false);
    expect(ListLib.isListStep(null)).toBe(false);
  });
});

describe('FA-N 接线链路：三段都在（不是只改了文案）', () => {
  it('HTTP 面有 listIntent、会话宿主透传 list_intent、内核有 list-ops 编译器', () => {
    /* `WEB_DIR` 是 `<repo>/apps/demo/web`（见 harness.ts 的导出）。 */
    const repoRoot = join(WEB_DIR, '..', '..', '..');
    const httpSource = readFileSync(join(repoRoot, 'apps', 'demo', 'server', 'http.ts'), 'utf8');
    const hostSource = readFileSync(join(repoRoot, 'apps', 'demo', 'server', 'session-host.ts'), 'utf8');
    const opsSource = readFileSync(join(repoRoot, 'src', 'documents', 'session', 'list-ops.ts'), 'utf8');

    /* ① HTTP 入口：三选一里必须有列表那一条，而且必须是**排他**的。 */
    expect(httpSource).toContain('listIntent');
    expect(httpSource).toContain('list_intent');
    /* ② 宿主透传：不是把列表意图吞在 HTTP 层。 */
    expect(hostSource).toContain('list_intent');
    /* ③ 内核侧编译器（FA-D 的产物）确实存在，且**只写 numPr**。 */
    expect(opsSource).toContain('compileListIntent');
    expect(opsSource).toContain('numPr');
  });
});

describe('FA-N app.js 列表链：进暂存、不伪造、提交走 listIntent', () => {
  it('面板把四个控件标为**可用**，并写清列表是结构化引用', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    const note = harness.debug.listStatusText();
    expect(note).toContain('已接通');
    expect(note).toContain('available');
    expect(note).toContain('伪造文本前缀：false');
    for (const control of ListLib.CONTROLS) {
      const button = harness.element('ctl-list-' + control.id);
      expect(button.textContent).toBe(control.label);
      expect(button.textContent).not.toContain('暂不可用');
    }
    /* 级别控件只在"能应用列表"时才渲染出来。 */
    expect(harness.element('ctl-list-level')).toBeTruthy();
  });

  it('选中段落后点列表控件：进暂存、**一次请求都不发**、正文逐字不变、没有伪造前缀', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    const textsBefore = harness.debug.previewTexts();
    const requestsBefore = harness.fetches.length;

    harness.selectParagraph(1);
    harness.click('ctl-list-bullet');
    await harness.flush();

    const attempt = harness.debug.lastListAttempt();
    expect(attempt?.ok).toBe(true);
    expect(attempt?.code).toBeNull();
    /* 进暂存 ≠ 已保存：这里绝不能出现"成功"的假象。 */
    expect(attempt?.showsSuccess).toBe(false);
    expect(attempt?.stagedSize).toBe(1);

    expect(harness.debug.stagedDomains()).toEqual(['list']);
    expect(harness.debug.stagedSteps()[0]?.operation).toEqual({ kind: 'applyList', style: 'bullet', level: 0 });

    /* ① 一次 `/edits` 都没发出去（保存之前不发）。 */
    expect(harness.fetches.length).toBe(requestsBefore);
    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
    /* ② 正文逐字不变——没有 `•`、没有 `1.`、没有把文字挪进列表。 */
    expect(harness.debug.previewTexts()).toEqual(textsBefore);
    for (const text of harness.debug.previewTexts()) {
      expect(FAKE_PREFIX_PATTERN.test(text), `正文出现了伪造的列表前缀：${text}`).toBe(false);
    }
    /* ③ 状态区说的是"已加入待保存"，**不是**"已保存"。 */
    const status = harness.debug.editStatusText();
    expect(status).toContain('列表');
    expect(status).toContain('已加入待保存');
    expect(status).not.toContain('已保存');
  });

  it('没有选中范围就点控件：结构化拒绝，不进暂存、不发请求、不碰正文', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    const textsBefore = harness.debug.previewTexts();
    harness.clearSelection();
    harness.click('ctl-list-bullet');
    await harness.flush();

    const attempt = harness.debug.lastListAttempt();
    expect(attempt?.ok).toBe(false);
    expect(attempt?.code).toBe('no_range');
    expect(attempt?.message).toContain('范围表达式');
    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.previewTexts()).toEqual(textsBefore);
    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
  });

  it('保存：列表步骤走 `listIntent`（不是 intent / sectionIntent），且请求体里没有任何文本前缀', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.selectParagraph(1);
    harness.click('ctl-list-numbered');
    await harness.flush();
    expect(harness.debug.stagedDomains()).toEqual(['list']);

    harness.click('save-edit-btn');
    await harness.flush();

    const calls = harness.fetches.filter((entry) => entry.url.endsWith('/edits'));
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['listIntent']).toBeDefined();
    expect(body['intent']).toBeUndefined();
    expect(body['sectionIntent']).toBeUndefined();

    const steps = (body['listIntent'] as { steps?: readonly ListStep[] }).steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.operation).toEqual({ kind: 'applyList', style: 'numbered', level: 0 });
    /* 请求体里**没有**任何写文本的字段：列表是引用，不是文字。 */
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('insertText');
    expect(FAKE_PREFIX_PATTERN.test(serialized), '提交体里出现了伪造的列表前缀').toBe(false);
  });

  it('列表步骤与段落步骤混在一起保存：**拒绝**并说明（服务端是三选一，不悄悄拆成两个版本）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.selectParagraph(1);
    harness.click('ctl-list-bullet');
    harness.click('ctl-bold');
    await harness.flush();
    expect(harness.debug.stagedDomains()).toEqual(['list', 'paragraph']);

    harness.click('save-edit-btn');
    await harness.flush();

    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
    const status = harness.debug.editStatusText();
    expect(status).toContain('三选一');
    /* 暂存**没有被清空**：用户的步骤还在，改完还能再存。 */
    expect(harness.debug.stagedSize()).toBe(2);
  });
});
