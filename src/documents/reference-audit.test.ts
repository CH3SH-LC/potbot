/**
 * 引用完整性**审阅报告**单测（WF-071–076 的审阅侧收口）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 全绿文档 ⇒ `healthy:true`、`dangling` 为空、报告写"悬空引用：无" | ① |
 * | 书签目标段落没了 ⇒ **具名**列出（不静默），带"重建书签"建议 | ② |
 * | 书签 `intact:false`（文字被删）⇒ 归入 `broken_bookmark` | ③ |
 * | 内部超链接指向不存在的书签 ⇒ 悬空 + "移除/重建"建议 | ④ |
 * | 书签范围越界 ⇒ `range_out_of_bounds` | ⑤ |
 * | **外部超链接只记录、不抓取**（R161）：指向不可达 URL 也不报错、不悬空 | ⑥ |
 * | 外部超链接记的 `r:id` 在关系表里找不到 ⇒ 警告（不是悬空） | ⑦ |
 * | 交叉引用目标已删 ⇒ 悬空；可解析但缓存旧 ⇒ 警告 | ⑧ |
 * | 页码型交叉引用 ⇒ 归入"需要排版证据"警告（R158），**不伪造页码** | ⑨ |
 * | 目录条目：标题节点没了 ⇒ 悬空；段落还在但已不是标题 ⇒ 警告 | ⑩ |
 * | `counts` 与 `findings` 一致（可机器核对） | ⑪ |
 *
 * 未验证声明：本报告是**模型层**自查，未经任何消费端（Word / WPS）读回核对 ⇒
 * "消费端会认为这些引用有效"标 **未验证（需消费端）**。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentModel } from './model/document.js';
import { textParagraphNode } from './model/nodes.js';
import type { DocumentModel } from './model/types.js';
import {
  buildToc,
  createCrossReference,
  emptyReferenceIndex,
  tocCache,
  type Bookmark,
  type CrossReference,
  type ReferenceIndex,
  type TocCache,
  type TocEntry,
} from './references/index.js';
import {
  auditReferences,
  formatReferenceAudit,
  hasDanglingReferences,
  referenceAuditFixes,
} from './reference-audit.js';
import { collectParagraphs, replaceParagraph } from './selection/structure.js';

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

function modelOf(texts: readonly string[]): DocumentModel {
  return createDocumentModel({
    document_id: 'audit-under-test',
    blocks: texts.map((text) => textParagraphNode({ text, source: 'user_request' })),
  });
}

/** 把某段标记为标题（大纲级别 0 ⇒ 标题 1）。 */
function makeHeading(model: DocumentModel, index: number): DocumentModel {
  const paragraph = collectParagraphs(model.blocks)[index]!;
  const patched = requireOk(
    replaceParagraph(model, paragraph.id, {
      ...paragraph,
      properties: { ...paragraph.properties, outlineLevel: { state: 'set', value: 0 } },
    }),
  );
  return patched.value;
}

function bookmark(overrides: Partial<Bookmark> & Pick<Bookmark, 'id' | 'name' | 'range'>): Bookmark {
  return { hidden: false, intact: true, ...overrides };
}

describe('引用审阅报告（reference-audit）', () => {
  it('① 全绿文档：healthy、无悬空、报告写"悬空引用：无"', () => {
    const model = modelOf(['甲乙丙丁']);
    const paragraph = collectParagraphs(model.blocks)[0]!;
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      bookmarks: [bookmark({ id: 'bm1', name: '锚点一', range: { node_id: paragraph.id, start: 0, end: 2 } })],
      hyperlinks: [
        {
          id: 'link1',
          range: { node_id: paragraph.id, start: 0, end: 2 },
          target: { kind: 'internal', bookmark: '锚点一' },
          text: '甲乙',
          screen_tip: null,
          intact: true,
        },
      ],
    };
    const report = auditReferences({ model, index });
    expect(report.healthy).toBe(true);
    expect(report.dangling).toEqual([]);
    expect(hasDanglingReferences(report)).toBe(false);
    expect(formatReferenceAudit(report)).toContain('悬空引用：无');
    expect(report.checked.bookmarks).toBe(1);
    expect(report.checked.hyperlinks).toBe(1);
  });

  it('② 书签目标段落没了 ⇒ 具名列出，并给"重建书签"建议', () => {
    const model = modelOf(['甲乙丙丁']);
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      bookmarks: [bookmark({ id: 'bm-lost', name: '丢了的目标', range: { node_id: 'n/nope:0', start: 0, end: 2 } })],
    };
    const report = auditReferences({ model, index });
    expect(report.healthy).toBe(false);
    expect(report.dangling).toHaveLength(1);
    const finding = report.dangling[0]!;
    expect(finding.code).toBe('missing_paragraph');
    expect(finding.name).toBe('丢了的目标');
    expect(finding.fix.action).toBe('remove_bookmark');
    // 具名出现在人类可读报告里（不是"有 1 条问题"）。
    expect(formatReferenceAudit(report)).toContain('丢了的目标');
  });

  it('③ 书签 intact:false（文字被删）⇒ broken_bookmark，建议重建', () => {
    const model = modelOf(['甲乙丙丁']);
    const paragraph = collectParagraphs(model.blocks)[0]!;
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      bookmarks: [
        bookmark({
          id: 'bm-dead',
          name: '被删的目标',
          range: { node_id: paragraph.id, start: 0, end: 0 },
          intact: false,
        }),
      ],
    };
    const report = auditReferences({ model, index });
    expect(report.dangling.map((finding) => finding.code)).toEqual(['broken_bookmark']);
    expect(report.dangling[0]!.fix.action).toBe('rebuild_bookmark');
  });

  it('④ 内部超链接指向不存在的书签 ⇒ 悬空 + 移除建议', () => {
    const model = modelOf(['甲乙丙丁']);
    const paragraph = collectParagraphs(model.blocks)[0]!;
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      hyperlinks: [
        {
          id: 'link-dead',
          range: { node_id: paragraph.id, start: 0, end: 2 },
          target: { kind: 'internal', bookmark: '不存在的锚' },
          text: '甲乙',
          screen_tip: null,
          intact: true,
        },
      ],
    };
    const report = auditReferences({ model, index });
    expect(report.dangling.map((finding) => finding.code)).toEqual(['missing_target']);
    expect(report.dangling[0]!.fix.action).toBe('remove_reference');
    expect(formatReferenceAudit(report)).toContain('不存在的锚');
  });

  it('⑤ 书签范围越界 ⇒ range_out_of_bounds', () => {
    const model = modelOf(['甲乙丙丁']); // 长度 4
    const paragraph = collectParagraphs(model.blocks)[0]!;
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      bookmarks: [bookmark({ id: 'bm-oob', name: '越界书签', range: { node_id: paragraph.id, start: 2, end: 9 } })],
    };
    const report = auditReferences({ model, index });
    expect(report.dangling.map((finding) => finding.code)).toEqual(['range_out_of_bounds']);
    expect(report.dangling[0]!.fix.action).toBe('rebuild_bookmark');
  });

  it('⑥ 外部目标只记录、不抓取（R161）：不可达 URL 也不报错、不算悬空', () => {
    const model = modelOf(['甲乙丙丁']);
    const paragraph = collectParagraphs(model.blocks)[0]!;
    // 指向一个**必然不可达**的地址：若本模块真去访问，就会抛错或挂起。
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      hyperlinks: [
        {
          id: 'link-ext',
          range: { node_id: paragraph.id, start: 0, end: 2 },
          target: { kind: 'external', url: 'http://127.0.0.1:1/never', relationship_id: null },
          text: '甲乙',
          screen_tip: null,
          intact: true,
        },
      ],
    };
    const report = auditReferences({ model, index });
    expect(report.healthy).toBe(true);
    expect(report.dangling).toEqual([]);
    const info = report.findings.find((finding) => finding.code === 'external_not_fetched');
    expect(info).toBeDefined();
    expect(info!.severity).toBe('info');
    expect(info!.name).toBe('http://127.0.0.1:1/never');
    expect(info!.fix.action).toBe('none');
    // 记录原样呈现（不抓取、不验证可达）。
    expect(formatReferenceAudit(report)).toContain('http://127.0.0.1:1/never');
  });

  it('⑦ 外部超链接记的 r:id 在关系表里找不到 ⇒ 警告（不是悬空）', () => {
    const model = modelOf(['甲乙丙丁']);
    const paragraph = collectParagraphs(model.blocks)[0]!;
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      hyperlinks: [
        {
          id: 'link-rel',
          range: { node_id: paragraph.id, start: 0, end: 2 },
          target: { kind: 'external', url: 'https://example.com/x', relationship_id: 'rId99' },
          text: '甲乙',
          screen_tip: null,
          intact: true,
        },
      ],
    };
    const report = auditReferences({ model, index });
    expect(report.healthy).toBe(true);
    const warning = report.warnings.find((finding) => finding.code === 'missing_relationship');
    expect(warning).toBeDefined();
    expect(warning!.fix.action).toBe('declare_relationship');
  });

  it('⑧ 交叉引用：目标已删 ⇒ 悬空；可解析但缓存未刷新 ⇒ 警告', () => {
    const model = modelOf(['标题一', '正文']);
    const paragraphs = collectParagraphs(model.blocks);
    const heading = paragraphs[0]!;

    const badRef: CrossReference = {
      id: 'xref-bad',
      range: { node_id: paragraphs[1]!.id, start: 0, end: 2 },
      target: { kind: 'heading', node_id: 'n/nope:0', bookmark_id: null },
      show: 'text',
      cached_text: null,
      refresh_state: 'unknown',
      intact: true,
    };
    const reportBad = auditReferences({
      model,
      index: { ...emptyReferenceIndex(), cross_references: [badRef] },
    });
    expect(reportBad.dangling.map((finding) => finding.code)).toEqual(['missing_target']);
    expect(reportBad.dangling[0]!.fix.action).toBe('remove_reference');

    const created = requireOk(
      createCrossReference(model, emptyReferenceIndex(), {
        id: 'xref-ok',
        range: { node_id: paragraphs[1]!.id, start: 0, end: 2 },
        target: { kind: 'heading', node_id: heading.id, bookmark_id: null },
        show: 'text',
      }),
    );
    const reportOk = auditReferences({ model, index: created.value });
    expect(reportOk.healthy).toBe(true);
    expect(reportOk.warnings.map((finding) => finding.code)).toEqual(['stale_reference']);
    expect(reportOk.warnings[0]!.fix.action).toBe('refresh_reference');
  });

  it('⑨ 页码型交叉引用 ⇒ "需要排版证据"警告（R158），不伪造页码', () => {
    const model = modelOf(['标题一', '正文']);
    const paragraphs = collectParagraphs(model.blocks);
    const created = requireOk(
      createCrossReference(model, emptyReferenceIndex(), {
        id: 'xref-page',
        range: { node_id: paragraphs[1]!.id, start: 0, end: 0 },
        target: { kind: 'heading', node_id: paragraphs[0]!.id, bookmark_id: null },
        show: 'page',
      }),
    );
    const report = auditReferences({ model, index: created.value });
    expect(report.healthy).toBe(true);
    const warning = report.warnings.find((finding) => finding.code === 'needs_layout_evidence');
    expect(warning).toBeDefined();
    expect(warning!.fix.action).toBe('recompute_field');
  });

  it('⑩ 目录条目：标题节点没了 ⇒ 悬空；段落还在但不是标题 ⇒ 警告', () => {
    const headingModel = makeHeading(modelOf(['标题一', '正文']), 0);
    const entries = requireOk(buildToc(headingModel));
    const cache: TocCache = tocCache(entries.value);
    expect(cache.entries).toHaveLength(1);

    // 段落还在、仍是标题 ⇒ 全绿。
    const healthy = auditReferences({ model: headingModel, index: emptyReferenceIndex(), toc: cache });
    expect(healthy.healthy).toBe(true);
    expect(healthy.checked.toc_entries).toBe(1);

    // 段落还在、但已不是标题 ⇒ 警告（不是悬空）。
    const demoted = auditReferences({ model: modelOf(['标题一', '正文']), index: emptyReferenceIndex(), toc: cache });
    expect(demoted.healthy).toBe(true);
    expect(demoted.warnings.map((finding) => finding.code)).toEqual(['toc_heading_demoted']);

    // 标题节点整个没了 ⇒ 悬空。
    const lostEntry: TocEntry = {
      level: 1,
      text: '消失的标题',
      node_id: 'n/nope:0',
      paragraph_index: 1,
      children: [],
    };
    const lost = auditReferences({
      model: headingModel,
      index: emptyReferenceIndex(),
      toc: tocCache([lostEntry]),
    });
    expect(lost.dangling.map((finding) => finding.code)).toEqual(['toc_heading_lost']);
    expect(formatReferenceAudit(lost)).toContain('消失的标题');
  });

  it('⑪ counts 与 findings 一致，修复清单不含"无需动作"', () => {
    const model = modelOf(['甲乙丙丁']);
    const paragraph = collectParagraphs(model.blocks)[0]!;
    const index: ReferenceIndex = {
      ...emptyReferenceIndex(),
      bookmarks: [bookmark({ id: 'bm-oob', name: '越界书签', range: { node_id: paragraph.id, start: 2, end: 9 } })],
      hyperlinks: [
        {
          id: 'link-ext',
          range: { node_id: paragraph.id, start: 0, end: 2 },
          target: { kind: 'external', url: 'https://example.com/x', relationship_id: null },
          text: '甲乙',
          screen_tip: null,
          intact: true,
        },
      ],
    };
    const report = auditReferences({ model, index });
    const total = Object.values(report.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(report.findings.length);
    // 外部目标的信息项不进修复清单（它没有"要修"的东西）。
    expect(referenceAuditFixes(report).every((fix) => fix.action !== 'none')).toBe(true);
    expect(referenceAuditFixes(report)).toHaveLength(1);
    // 反向对照：健康文档的 counts 全零。
    const healthy = auditReferences({ model, index: emptyReferenceIndex() });
    expect(Object.values(healthy.counts).every((value) => value === 0)).toBe(true);
  });
});
