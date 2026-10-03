/**
 * WCF-D34：在**线上那一份 `app.js`** 上走完整的编辑链（导入 → 选区 → 控件 → 保存）。
 *
 * 判据（与任务书一致）：
 *   ① 选中文字翻出的范围表达式，能被内核 `parseRangeExpression` 解析；
 *   ② `stale_revision` 时显示冲突、**不**显示成功、**不**清理待保存状态；
 *   ③ 保存失败不显示成功；下载新版本时未算出摘要**不**发布 `download_verified`；
 *   ④ 一次复合指令只产生**一次** revision 递增（也只发一次 /edits）；
 *   ⑤ 翻不出来的选区不提交（不用近似表达式替用户猜）。
 *
 * 夹具用 node:vm + 最小 DOM 桩执行真实文件（不复制实现），见 `editor-harness.ts`。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseRangeExpression } from '../../../src/documents/selection/expression.js';
import { compileEditIntent } from '../../../src/documents/session/intent.js';
import { buildDocx, sampleBlocks } from './docx-fixtures.js';
import { createEditorHarness } from './editor-harness.js';
import { WEB_DIR } from './harness.js';

const SAMPLE = buildDocx(sampleBlocks());

describe('app.js 编辑链：导入与预览', () => {
  it('导入 DOCX 后渲染出可选中预览，会话版本从服务端回执来', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    expect(harness.debug.previewParagraphCount()).toBe(7);
    expect(harness.debug.previewTableCount()).toBe(1);
    expect(harness.debug.previewTexts()[0]).toBe('新生读书会邀请函');
    expect(harness.debug.session()?.editRevision).toBe(0);
    expect(harness.debug.editorErrorText()).toBe('');

    /* 上传的 base64 就是所选文件的字节（没有被页面改过）。 */
    const create = harness.fetches.find((entry) => entry.url === '/api/sessions');
    expect(create?.method).toBe('POST');
    expect(String(create?.body?.['docxBase64'])).toBe(Buffer.from(SAMPLE).toString('base64'));
  });

  it('选中整段后，页面给出的范围表达式内核认得（不是"看起来像"）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.selectParagraph(2);
    const expression = harness.debug.selectionExpression();
    expect(expression).toBe('第2段');
    const parsed = parseRangeExpression(expression);
    expect(parsed.ok).toBe(true);

    harness.selectParagraph(2, 0, 4, '亲爱的同');
    const textExpression = harness.debug.selectionExpression();
    expect(textExpression).toBe('指定文本:亲爱的同');
    expect(parseRangeExpression(textExpression).ok).toBe(true);
  });

  it('表格里的整格选区翻成表格表达式', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.selectParagraph(3);
    expect(harness.debug.selectionExpression()).toBe('第1个表格第1行第1列');
    expect(parseRangeExpression(harness.debug.selectionExpression()).ok).toBe(true);
  });

  it('翻不出来的选区：不生成表达式，也不提交任何步骤', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    /* 跨段但两端都没对齐到段落边界。 */
    harness.selectAcross(1, 3, 2, 5, '邀请函\n亲爱的同');
    expect(harness.debug.selectionExpression()).toBe('');

    harness.click('ctl-bold');
    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.editStatusText()).toContain('选中');
    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
  });
});

describe('app.js 编辑链：一次复合指令 = 一次事务', () => {
  it('多步格式作为**一个** intent 提交，只发一次 /edits，revision 只 +1', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.selectParagraph(2);
    harness.click('ctl-bold');
    harness.selectParagraph(1);
    harness.click('ctl-alignment-center');
    harness.click('ctl-firstLineIndent-apply');
    expect(harness.debug.stagedSize()).toBe(3);

    const editsBefore = harness.fetches.filter((entry) => entry.url.endsWith('/edits')).length;
    harness.click('save-edit-btn');
    await harness.flush();

    const editCalls = harness.fetches.filter((entry) => entry.url.endsWith('/edits'));
    expect(editCalls.length - editsBefore).toBe(1);

    const body = editCalls[0]?.body;
    const steps = (body?.['intent'] as { steps?: unknown[] } | undefined)?.steps ?? [];
    expect(steps).toHaveLength(3);
    expect(body?.['baseRevision']).toBe(0);
    expect(String(body?.['baseDigest'])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(body?.['idempotencyKey'])).toMatch(/^edit-/);

    /* 版本号只 +1（不是每步一次）。 */
    expect(harness.debug.session()?.editRevision).toBe(1);
    expect(harness.debug.lastVerdict()).toEqual({ kind: 'applied', showsSuccess: true });
    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.editStatusText()).toContain('已发布新版本');

    /* 提交的每一步范围表达式都是内核语法。 */
    for (const step of steps) {
      const range = (step as { range?: string }).range ?? '';
      expect(parseRangeExpression(range).ok).toBe(true);
    }
  });

  it('文档更新后旧选区作废（R114），不让旧偏移落到新文本上', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);
    expect(harness.debug.selectionExpression()).toBe('第2段');

    harness.click('ctl-bold');
    harness.click('save-edit-btn');
    await harness.flush();

    expect(harness.debug.selectionExpression()).toBe('');
    expect(harness.debug.selectionText()).toBe('');

    /* 作废之后不再默默沿用旧范围：此时点控件会被本地拒绝。 */
    harness.click('ctl-italic');
    expect(harness.debug.stagedSize()).toBe(0);
  });

  it('保存后按新版本取回预览（重新读服务端返回的字节）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);
    harness.click('ctl-bold');

    harness.click('save-edit-btn');
    await harness.flush();

    const versionFetches = harness.fetches.filter((entry) => /\/versions\/\d+\/download$/.test(entry.url));
    expect(versionFetches.length).toBeGreaterThanOrEqual(1);
    expect(versionFetches[0]?.url).toMatch(/^\/api\/sessions\/[^/]+\/versions\/1\/download$/);
  });
});

describe('app.js 编辑链：冲突与失败如实显示', () => {
  it('stale_revision：显示冲突、不显示成功、**保留**待保存的步骤', async () => {
    const harness = await createEditorHarness({
      editScript: [{
        status: 409,
        body: {
          code: 'stale_revision',
          message: '基线已过期',
          retryable: true,
          currentRevision: 5,
          requestedRevision: 0,
          reason: 'revision',
        },
      }],
    });
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);
    harness.click('ctl-bold');
    expect(harness.debug.stagedSize()).toBe(1);

    harness.click('save-edit-btn');
    await harness.flush();

    const verdict = harness.debug.lastVerdict();
    expect(verdict?.kind).toBe('conflict');
    expect(verdict?.showsSuccess).toBe(false);

    const status = harness.debug.editStatusText();
    expect(status).toContain('没有改动文档');
    expect(status).toContain('第 5 版');
    expect(status).not.toContain('已发布新版本');

    /* 用户没白点：待保存的步骤还在。 */
    expect(harness.debug.stagedSize()).toBe(1);

    /* 页面顺手取了最新状态，好让用户按新的 base 重新提交。 */
    const statusFetches = harness.fetches.filter((entry) =>
      entry.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(entry.url));
    expect(statusFetches.length).toBeGreaterThanOrEqual(1);
  });

  it('下游失败（502）：不显示成功，保留步骤并说明可重试', async () => {
    const harness = await createEditorHarness({
      editScript: [{ status: 502, body: { code: 'publish_failed', message: '发布链没交付', retryable: true } }],
    });
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);
    harness.click('ctl-bold');
    harness.click('save-edit-btn');
    await harness.flush();

    expect(harness.debug.lastVerdict()?.kind).toBe('failed');
    expect(harness.debug.lastVerdict()?.showsSuccess).toBe(false);
    expect(harness.debug.editStatusText()).toContain('没有确认改动生效');
    expect(harness.debug.editStatusText()).not.toContain('已发布新版本');
    expect(harness.debug.stagedSize()).toBe(1);
    expect(harness.debug.session()?.editRevision).toBe(0);
  });

  it('没有待保存步骤时不提交（不发 /edits）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.click('save-edit-btn');
    await harness.flush();

    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
    expect(harness.debug.editStatusText()).toContain('还没有待保存的步骤');
  });
});

describe('app.js 编辑链：撤销 / 重做与控件纪律', () => {
  it('撤销 / 重做只动待保存栈，不发请求、不改版本号', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.selectParagraph(2);
    harness.click('ctl-bold');
    harness.click('ctl-italic');
    harness.click('ctl-alignment-center');
    expect(harness.debug.stagedSize()).toBe(3);

    harness.click('undo-btn');
    expect(harness.debug.stagedSize()).toBe(2);
    expect(harness.debug.undoneSize()).toBe(1);

    harness.click('redo-btn');
    expect(harness.debug.stagedSize()).toBe(3);

    harness.click('undo-btn');
    harness.click('ctl-strike');
    expect(harness.debug.stagedSize()).toBe(3);
    expect(harness.debug.undoneSize()).toBe(0);

    harness.click('clear-staged-btn');
    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.session()?.editRevision).toBe(0);
    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
  });

  it('没有选区时点格式控件：本地拒绝并说明，不发任何编辑请求', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);
    harness.clearSelection();

    harness.click('ctl-bold');
    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.editStatusText()).toContain('请先在预览里选中');
    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
  });

  it('意图层仍未开放的带值属性（下划线样式 / 颜色 / 高亮 / 上下标）：不提交，并说明原因', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);

    harness.click('ctl-underlineStyle');
    harness.click('ctl-color');
    harness.click('ctl-highlight');
    harness.click('ctl-vertAlign');
    expect(harness.debug.stagedSize()).toBe(0);
    const status = harness.debug.editStatusText();
    expect(status).toContain('setValue');
    expect(status).not.toContain('已发布新版本');
    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
  });

  it('字体 + 字号（FA-P）：控件 → 待保存 → 保存为**一次** /edits，payload 被内核真实编译器接受', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);

    harness.setValue('ctl-fonts-ascii', 'Times New Roman');
    harness.setValue('ctl-fonts-eastAsia', '宋体');
    harness.click('ctl-fonts-apply');
    harness.setValue('ctl-size-mode', 'chinese');
    harness.setValue('ctl-size-name', '小四');
    harness.click('ctl-size-apply');
    expect(harness.debug.stagedSize()).toBe(2);

    const editsBefore = harness.fetches.filter((entry) => entry.url.endsWith('/edits')).length;
    harness.click('save-edit-btn');
    await harness.flush();

    const editCalls = harness.fetches.filter((entry) => entry.url.endsWith('/edits'));
    expect(editCalls.length - editsBefore).toBe(1);

    const steps = (((editCalls[0]?.body?.['intent'] as { steps?: unknown[] } | undefined)?.steps) ?? []) as Array<{
      range: string;
      operation: Record<string, unknown>;
    }>;
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      const verdict = compileEditIntent({ steps: [step] });
      expect(verdict.ok, `内核拒绝了页面发出的 setValue：${JSON.stringify(step.operation)}`).toBe(true);
    }

    /* 一次复合 = 一次 revision（两个字符合并成**一个** intent）。 */
    expect(harness.debug.session()?.editRevision).toBe(1);
    expect(harness.debug.lastVerdict()).toEqual({ kind: 'applied', showsSuccess: true });
  });

  it('字体四槽全留空 / 字号非法：本地拒绝，不发请求', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);

    harness.setValue('ctl-fonts-ascii', '');
    harness.setValue('ctl-fonts-eastAsia', '');
    harness.click('ctl-fonts-apply');
    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.editStatusText()).toContain('至少要填一个槽位');

    harness.setValue('ctl-size-mode', 'pt');
    harness.setValue('ctl-size-pt', '12.3');
    harness.click('ctl-size-apply');
    expect(harness.debug.stagedSize()).toBe(0);
    expect(harness.debug.editStatusText()).toContain('0.5pt');
    expect(harness.fetches.some((entry) => entry.url.endsWith('/edits'))).toBe(false);
  });

  it('格式检查读出选区当前状态（含混合）', async () => {
    const harness = await createEditorHarness();
    await harness.importDocx(SAMPLE);

    harness.selectParagraph(1);
    const state = harness.debug.formatState() as { toggles?: Record<string, string> } | null;
    expect(state?.toggles?.['bold']).toBe('on');

    harness.selectParagraph(2);
    const plain = harness.debug.formatState() as { toggles?: Record<string, string> } | null;
    expect(plain?.toggles?.['bold']).toBe('unset');
  });
});

describe('app.js 编辑链：新版本下载的核对纪律（复用 D08 分类器）', () => {
  async function savedHarness(digestMode: 'unavailable' | 'match' | 'mismatch') {
    const harness = await createEditorHarness({ digestMode });
    await harness.importDocx(SAMPLE);
    harness.selectParagraph(2);
    harness.click('ctl-bold');
    harness.click('save-edit-btn');
    await harness.flush();
    return harness;
  }

  it('算不出摘要时：不发布 download_verified，只记交接观察', async () => {
    const harness = await savedHarness('unavailable');
    harness.click('download-version-btn');
    await harness.flush();

    const kinds = harness.observations.map((entry) => String(entry.body['kind']));
    expect(kinds).not.toContain('download_verified');
    expect(kinds).toContain('handoff_requested');
    expect(harness.debug.versionDownloadStatusText()).toContain('未核对校验值');
  });

  it('摘要一致时：才发布 download_verified', async () => {
    const harness = await savedHarness('match');
    harness.click('download-version-btn');
    await harness.flush();

    const kinds = harness.observations.map((entry) => String(entry.body['kind']));
    expect(kinds).toContain('download_verified');
    expect(harness.debug.versionDownloadStatusText()).toContain('长度与校验值都与电脑端登记一致');
    expect(harness.anchorClicks).toHaveLength(1);
  });

  it('摘要不符时：放弃保存，不下载、不发事件', async () => {
    const harness = await savedHarness('mismatch');
    harness.click('download-version-btn');
    await harness.flush();

    expect(harness.anchorClicks).toHaveLength(0);
    const kinds = harness.observations.map((entry) => String(entry.body['kind']));
    expect(kinds).toEqual([]);
    expect(harness.debug.versionDownloadStatusText()).toContain('校验值与登记不符');
  });
});

describe('页面装配（编辑区）', () => {
  it('index.html 在 app.js 之前加载 doc-read.js 与 edit-intent.js', () => {
    const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
    const docReadAt = html.indexOf('./doc-read.js');
    const editIntentAt = html.indexOf('./edit-intent.js');
    const appAt = html.indexOf('./app.js');
    expect(docReadAt).toBeGreaterThan(-1);
    expect(editIntentAt).toBeGreaterThan(-1);
    expect(docReadAt).toBeLessThan(appAt);
    expect(editIntentAt).toBeLessThan(appAt);
  });
});
