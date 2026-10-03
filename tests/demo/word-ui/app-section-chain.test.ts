/**
 * WCF-D72：在**线上那一份 `app.js`** 上走完整的**节操作**链
 * （导入多节文档 → 选作用节 → 点控件 → 暂存 → 保存 → 回执）。
 *
 * 判据（与任务书逐条对应）：
 *   ① 节操作发出的 payload **能被服务端形状接受**——用与 `session-host.ts` 同源的
 *      `compileSectionIntent` 断言，而不是字符串比对；
 *   ② **指明节**：多节文档下只作用于被选中的那一节；**不选就报错**且不发请求；
 *   ③ `stale_revision` / `unsupported` 时**不显示成功**、**不清理**待保存状态；
 *   ④ 未算出摘要时**不发布** `download_verified`（复用 D08 的分类器，不另造判据）；
 *   ⑤ **一次复合指令 = 一次 revision**（多步节操作只发一次 `/edits`）。
 *
 * 夹具用 `node:vm` + 最小 DOM 桩执行真实文件（见 `editor-harness.ts`），不复制实现。
 */

import { describe, expect, it } from 'vitest';

import { compileSectionIntent } from '../../../src/documents/session/section-ops.js';
import {
  SECTPR_PORTRAIT_PLAIN,
  buildDocx,
  multiSectionBlocks,
} from './docx-fixtures.js';
import { createEditorHarness } from './editor-harness.js';

/** 三节样张：第1节横向 / 第2节纵向+罗马页码 / 第3节（body 级）纵向。 */
const MULTI = buildDocx(multiSectionBlocks(), { bodySectPrXml: SECTPR_PORTRAIT_PLAIN });

interface SectionRequestStep {
  readonly section: { readonly kind: string; readonly index?: number; readonly indices?: readonly number[] };
  readonly operation: Record<string, unknown>;
}

function sectionStepsOf(body: Record<string, unknown> | null): readonly SectionRequestStep[] {
  const intent = body?.['sectionIntent'] as { steps?: readonly SectionRequestStep[] } | undefined;
  return intent?.steps ?? [];
}

function editCalls(harness: { fetches: ReadonlyArray<{ url: string; body: Record<string, unknown> | null }> }) {
  return harness.fetches.filter((entry) => entry.url.endsWith('/edits'));
}

describe('app.js 节链：节列表来自服务端返回的字节', () => {
  it('导入多节文档后，面板能说出有几节、每一节现在是什么样', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(MULTI);

    expect(harness.debug.sectionCount()).toBe(3);
    const sections = harness.debug.sections();
    expect(sections.map((section) => section.number)).toEqual([1, 2, 3]);
    /* 第 1 节横向（文档声明）、第 3 节页边距未指定——读的是字节，不是猜的。 */
    expect(sections[0]?.pageSize?.orientation).toBe('landscape');
    expect(sections[0]?.pageSize?.orientationSource).toBe('attr');
    expect(sections[2]?.margins).toBeNull();
    /* 下拉框初始是**空的「未指定」**，不是"默认全文"。 */
    expect(harness.debug.sectionScopeValue()).toBe('');
    expect(harness.debug.sectionScopeLabel()).toBe('');
  });

  it('还没导入文档时不会有节可改（面板说明可读，不崩）', async () => {
    const harness = await createEditorHarness();
    expect(harness.debug.sectionCount()).toBe(0);
    expect(harness.debug.sectionStatusText()).toContain('作用节');
  });

  it('节控件**不依赖文字选区**：没有选中文字时也照样可用（否则真机上改不了页边距）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(MULTI);
    expect(harness.debug.selectionExpression()).toBe('');

    /* 段落控件在没选区时是禁用的（既有行为，不动它）。 */
    expect(harness.element('ctl-bold').getAttribute('disabled')).not.toBeNull();
    /* 节控件必须**不**被那份开关带上：它们按节索引寻址，与选区无关。 */
    for (const id of ['ctl-section-margins-apply', 'ctl-section-orientation-landscape', 'ctl-section-restartPageNumbering']) {
      expect(harness.element(id).getAttribute('disabled'), id + ' 不应被选区开关禁用').toBeNull();
    }

    /* 真的能用：没选区也能把页边距加进暂存。 */
    harness.setValue('ctl-section-scope', '0');
    harness.setValue('ctl-margins-top', '25');
    harness.setValue('ctl-margins-unit', 'mm');
    harness.click('ctl-section-margins-apply');
    expect(harness.debug.stagedSize()).toBe(1);
    const steps = harness.debug.stagedSteps() as unknown as SectionRequestStep[];
    expect(steps[0]?.operation).toEqual({
      kind: 'setMargins',
      margins: {
        top: { unit: 'mm', value: 25 },
        right: { unit: 'mm', value: 2.54 },
        bottom: { unit: 'mm', value: 2.54 },
        left: { unit: 'mm', value: 2.54 },
        gutter: { unit: 'mm', value: 0 },
      },
    });
  });
});

describe('app.js 节链：作用节必须显式指定（R108）', () => {
  it('不选作用节就点控件 ⇒ 不发请求、不加暂存、如实说明原因', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(MULTI);

    harness.click('ctl-section-orientation-landscape');
    await harness.flush();

    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.stagedDomains()).toEqual([]);
    expect(harness.debug.editStatusText()).toContain('还没有指定作用节');
    expect(editCalls(harness)).toHaveLength(0);
  });

  it('选「全文」与选「第 3 节」是两种不同的作用范围（不会互相顶替）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(MULTI);

    harness.setValue('ctl-section-scope', 'all');
    expect(harness.debug.sectionScopeLabel()).toBe('全文');
    harness.click('ctl-section-orientation-portrait');
    expect(harness.debug.stagedSize()).toBe(1);

    harness.setValue('ctl-section-scope', '2');
    expect(harness.debug.sectionScopeLabel()).toBe('第3节');
    harness.click('ctl-section-orientation-landscape');
    expect(harness.debug.stagedSize()).toBe(2);

    const steps = harness.debug.stagedSteps() as unknown as SectionRequestStep[];
    expect(steps[0]?.section).toEqual({ kind: 'all' });
    expect(steps[1]?.section).toEqual({ kind: 'current', index: 2 });
  });
});

describe('app.js 节链：一次复合指令 = 一次 revision', () => {
  it('多步节操作作为**一个** sectionIntent 提交，只发一次 /edits，revision 只 +1', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(MULTI);

    harness.setValue('ctl-section-scope', '1');
    harness.click('ctl-section-orientation-landscape');
    harness.click('ctl-section-pageSizePreset-A4');
    harness.click('ctl-section-restartPageNumbering');
    expect(harness.debug.stagedSize()).toBe(3);
    expect(harness.debug.stagedDomains()).toEqual(['section', 'section', 'section']);

    const before = editCalls(harness).length;
    harness.click('save-edit-btn');
    await harness.flush();

    const calls = editCalls(harness);
    expect(calls.length - before).toBe(1);
    const body = calls[0]?.body as Record<string, unknown>;

    /* 二选一：给了 sectionIntent 就**不能**再给 intent（服务端会 400）。 */
    expect(body['sectionIntent']).toBeDefined();
    expect(body['intent']).toBeUndefined();
    expect(body['baseRevision']).toBe(0);
    expect(String(body['baseDigest'])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(body['idempotencyKey'])).toMatch(/^edit-/);

    const steps = sectionStepsOf(body);
    expect(steps).toHaveLength(3);
    expect(steps[0]?.section).toEqual({ kind: 'current', index: 1 });
    expect(steps[0]?.operation).toEqual({ kind: 'setOrientation', orientation: 'landscape' });
    expect(steps[1]?.operation).toEqual({ kind: 'setPageSizePreset', preset: 'A4' });
    expect(steps[2]?.operation).toEqual({ kind: 'restartPageNumbering' });

    /* ① 服务端形状接受：直接用**真实**编译器吃这一份 payload。 */
    const verdict = compileSectionIntent(body['sectionIntent']);
    expect(verdict.ok, verdict.ok === false ? `${verdict.code} ${verdict.message}` : '').toBe(true);
    if (verdict.ok === true) {
      expect(verdict.value.steps).toHaveLength(3);
      expect(verdict.value.steps[0]?.scope).toEqual({ kind: 'current', index: 1 });
      expect(verdict.value.steps[0]?.label).toBe('第2节');
      expect(verdict.value.steps[2]?.operation).toEqual({ kind: 'setPageNumberStart', start: 1 });
    }

    /* ⑤ 一个版本，不是三步各一个。 */
    expect(harness.debug.session()?.editRevision).toBe(1);
    expect(harness.debug.lastVerdict()).toEqual({ kind: 'applied', showsSuccess: true });
    expect(harness.debug.editStatusText()).toContain('已发布新版本');
    expect(harness.debug.stagedSize()).toBe(0);
  });

  it('节步与段落步混在暂存里 ⇒ 拒绝提交并说明原因（不悄悄拆成两个版本）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(MULTI);

    harness.selectParagraph(1);
    harness.click('ctl-bold');
    harness.setValue('ctl-section-scope', '0');
    harness.click('ctl-section-orientation-landscape');
    expect(harness.debug.stagedDomains()).toEqual(['paragraph', 'section']);

    harness.click('save-edit-btn');
    await harness.flush();

    expect(editCalls(harness)).toHaveLength(0);
    expect(harness.debug.editStatusText()).toContain('同时有段落格式');
    /* 两步都还在，用户没有丢东西。 */
    expect(harness.debug.stagedSize()).toBe(2);
  });
});

describe('app.js 节链：失败如实显示', () => {
  it('stale_revision ⇒ 不显示成功、不清暂存、提示重取', async () => {
    const harness = await createEditorHarness({
      docx: MULTI,
      editScript: [{ status: 409, body: { code: 'stale_revision', message: '基线已过期。', currentRevision: 7, requestedRevision: 0, reason: 'revision' } }],
    });
    await harness.importDocx(MULTI);

    harness.setValue('ctl-section-scope', '0');
    harness.click('ctl-section-orientation-landscape');
    harness.click('save-edit-btn');
    await harness.flush();

    const verdict = harness.debug.lastVerdict();
    expect(verdict).toEqual({ kind: 'conflict', showsSuccess: false });
    const status = harness.debug.editStatusText();
    expect(status).not.toContain('已发布新版本');
    expect(status).toContain('过期');
    expect(status).toContain('第 7 版');
    /* ③ 待保存的步骤**没有**被清掉：用户不必重新点一遍。 */
    expect(harness.debug.stagedSize()).toBe(1);
    expect(harness.debug.stagedDomains()).toEqual(['section']);
    /* 也没有产生新版本。 */
    expect(harness.debug.session()?.editRevision).toBe(0);
  });

  it('unsupported（422）⇒ 不显示成功、不清暂存', async () => {
    const harness = await createEditorHarness({
      docx: MULTI,
      editScript: [{ status: 422, body: { code: 'unsupported', message: '内核不承认这个节操作。', retryable: false } }],
    });
    await harness.importDocx(MULTI);

    harness.setValue('ctl-section-scope', '1');
    harness.click('ctl-section-orientation-landscape');
    harness.click('save-edit-btn');
    await harness.flush();

    const verdict = harness.debug.lastVerdict();
    expect(verdict?.showsSuccess).toBe(false);
    expect(verdict?.kind).toBe('rejected');
    expect(harness.debug.editStatusText()).toContain('unsupported');
    expect(harness.debug.editStatusText()).not.toContain('已发布新版本');
    expect(harness.debug.stagedSize()).toBe(1);
  });

  it('取回新版本但**没有算出摘要** ⇒ 不发布 download_verified（复用 D08 分类器）', async () => {
    const harness = await createEditorHarness({ docx: MULTI, digestMode: 'unavailable' });
    await harness.importDocx(MULTI);

    harness.setValue('ctl-section-scope', '0');
    harness.click('ctl-section-orientation-landscape');
    harness.click('save-edit-btn');
    await harness.flush();
    expect(harness.debug.lastVerdict()?.showsSuccess).toBe(true);

    harness.click('download-version-btn');
    await harness.flush();

    const kinds = harness.observations.map((entry) => String(entry.body['kind']));
    expect(kinds).not.toContain('download_verified');
    expect(harness.debug.versionDownloadStatusText()).toContain('未核对校验值');
  });
});
