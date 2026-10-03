/**
 * W06 独立测试：**从真实 OOXML 读回修订 + 未处理范围不损坏**（WF-078/WF-079）。
 *
 * 本用例对准 W06 的独立验收口径：
 * - **外部语料真实 XML 语义正确**：从 `word/document.xml` 的 `w:ins` / `w:del` 读出
 *   作者 / 日期 / 类别 / 文字 / 顺序 / 码位区间，语料为 `tests/word-acceptance/fixtures/`
 *   的真实 DOCX（corpus-d、corpus-e 含 `w:ins`/`w:del`；corpus-a 无修订作反向对照）。
 * - **未处理范围不损坏**：部分接受后，同一段里未处理的记录其 `range` 被**重定基**，
 *   仍指向自身那段文字；重叠无法重定基的**具名**进 `damaged`。
 *
 * ## 身份 / 边界声明
 *
 * 本用例由 **DS worker W06** 在**主树**内产出（未建 worktree）。它证明的是
 * "XML → 记录 → 模型 → 判决"这条链在**字节/模型层**的自洽，**不是**消费端（Word / WPS）
 * 会如何显示这些修订 —— 消费端读回 **未验证（本批无设备与授权）**。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { planRevisionExport, insertRevisionElement } from '../../../../src/documents/revisions-export.js';
import {
  acceptRevisions,
  acceptRevisionsRebased,
  rejectRevisions,
  rejectRevisionsRebased,
} from '../../../../src/documents/review/accept.js';
import {
  hasUnreadableRevisions,
  materializeRevisionModel,
  projectParagraphText,
  readRevisionsFromDocumentXml,
} from '../../../../src/documents/review/index.js';
import { trackInsert } from '../../../../src/documents/review/revisions.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures');
const CORPUS_A = join(FIXTURES, 'corpus-a-independent-deflate.docx');
const CORPUS_D = join(FIXTURES, 'corpus-d-reference-elements.docx');
const CORPUS_E = join(FIXTURES, 'corpus-e-annotation-export.docx');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function documentXmlOf(path: string): string {
  const archive = readZip(new Uint8Array(readFileSync(path)));
  const entry = archive.by_path.get('word/document.xml');
  if (entry === undefined) throw new Error(`fixture 缺少 word/document.xml：${path}`);
  return new TextDecoder().decode(entry.data);
}

function wrapBody(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W_NS}"><w:body>${inner}</w:body></w:document>`;
}

function paragraphAt(inner: string): string {
  return wrapBody(`<w:p>${inner}</w:p>`);
}

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`setup/under-test failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

// ---------------------------------------------------------------------------

describe('真实语料：corpus-d / corpus-e 的 w:ins / w:del 读回', () => {
  it('① corpus-d：读出 1 插入 + 1 删除，作者 / 日期 / 文字 / 码位区间正确', () => {
    const result = readRevisionsFromDocumentXml(documentXmlOf(CORPUS_D));

    expect(result.records).toHaveLength(2);
    const [ins, del] = result.records;
    expect(ins?.kind).toBe('insert');
    expect(ins?.source_id).toBe(1);
    expect(ins?.author).toBe('reviewer');
    expect(ins?.date).toBe('2026-10-03T00:00:00Z');
    expect(ins?.text).toBe('新增');
    expect(ins?.paragraph_index).toBe(7);
    expect({ start: ins?.start, end: ins?.end }).toEqual({ start: 0, end: 2 });

    expect(del?.kind).toBe('delete');
    expect(del?.source_id).toBe(2);
    expect(del?.text).toBe('删除');
    expect(del?.paragraph_index).toBe(8);
    expect({ start: del?.start, end: del?.end }).toEqual({ start: 0, end: 2 });

    // 无移动 / 无格式修订 / 无嵌套 ⇒ 不该有告警（尽读出来了）。
    expect(result.warnings).toEqual([]);
    expect(hasUnreadableRevisions(result)).toBe(false);
  });

  it('② corpus-d：删除段落 rendered="删除保留"、final="保留"、original="删除保留"', () => {
    const result = readRevisionsFromDocumentXml(documentXmlOf(CORPUS_D));
    const paragraph = result.paragraphs[8]!;
    expect(paragraph.rendered_text).toBe('删除保留');
    expect(projectParagraphText(paragraph, 'accept')).toBe('保留');
    expect(projectParagraphText(paragraph, 'reject')).toBe('删除保留');

    // 插入段落：rendered="新增"、final="新增"、original=""。
    const inserted = result.paragraphs[7]!;
    expect(inserted.rendered_text).toBe('新增');
    expect(projectParagraphText(inserted, 'accept')).toBe('新增');
    expect(projectParagraphText(inserted, 'reject')).toBe('');
  });

  it('③ corpus-e：跨两个 run 的 w:del 合并成一条，ins/del 偏移各自正确', () => {
    const result = readRevisionsFromDocumentXml(documentXmlOf(CORPUS_E));
    expect(result.records).toHaveLength(2);

    // 文档顺序：del(id=2) 在 ins(id=1) 之前。
    const [del, ins] = result.records;
    expect(del?.kind).toBe('delete');
    expect(del?.source_id).toBe(2);
    expect(del?.author).toBe('审阅人');
    // "见" 与 "总" 分处两个 run，但同属 id=2 的 w:del ⇒ 合并为一条 "见总"。
    expect(del?.text).toBe('见总');

    expect(ins?.kind).toBe('insert');
    expect(ins?.source_id).toBe(1);
    expect(ins?.text).toBe('正文');

    const paragraph = result.paragraphs[del!.paragraph_index]!;
    expect(paragraph.rendered_text).toBe('点这里 见总则 正文');
    expect({ start: del?.start, end: del?.end }).toEqual({ start: 4, end: 6 });
    expect({ start: ins?.start, end: ins?.end }).toEqual({ start: 8, end: 10 });
    expect(projectParagraphText(paragraph, 'accept')).toBe('点这里 则 正文');
    expect(projectParagraphText(paragraph, 'reject')).toBe('点这里 见总则 ');
  });

  it('④ 反向对照：corpus-a 无 w:ins/w:del ⇒ 零记录、零告警', () => {
    const result = readRevisionsFromDocumentXml(documentXmlOf(CORPUS_A));
    expect(result.records).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('手工 XML：码位口径与具名告警', () => {
  it('⑤ 一个 w:ins 跨多 run 合并成一条；emoji 按码位（非 UTF-16 码元）计偏移', () => {
    // 👨‍👩‍👧 = 5 码位 / 8 UTF-16 码元；插在 "AB" 与 "CD" 之间。
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const xml = paragraphAt(
      `<w:r><w:t>AB</w:t></w:r>` +
        `<w:ins w:id="9" w:author="审阅人" w:date="2026-10-03T00:00:00Z">` +
        `<w:r><w:t>${family}</w:t></w:r>` +
        `</w:ins>` +
        `<w:r><w:t>CD</w:t></w:r>`,
    );
    const result = readRevisionsFromDocumentXml(xml);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.kind).toBe('insert');
    expect(record.text).toBe(family);
    // 起点 = "AB" 2 码位；终点 = 2 + 5 码位（不是 10）。
    expect({ start: record.start, end: record.end }).toEqual({ start: 2, end: 7 });
    expect(result.paragraphs[0]!.rendered_text).toBe(`AB${family}CD`);
  });

  it('⑥ 具名告警：移动修订 / 格式修订 / 嵌套 / del 外的 delText 各自被报告', () => {
    const xml = paragraphAt(
      `<w:r><w:t>甲</w:t></w:r>` +
        `<w:moveFrom w:id="3"><w:r><w:delText>移</w:delText></w:r></w:moveFrom>` +
        `<w:moveTo w:id="4"><w:r><w:t>移</w:t></w:r></w:moveTo>` +
        `<w:ins w:id="5"><w:r><w:rPr><w:rPrChange w:id="6" w:author="a"><w:rPr/></w:rPrChange></w:rPr><w:t>新</w:t></w:r></w:ins>` +
        `<w:del w:id="7"><w:ins w:id="8"><w:r><w:t>嵌套</w:t></w:r></w:ins></w:del>` +
        `<w:delText>野</w:delText>`,
    );
    const result = readRevisionsFromDocumentXml(xml);
    const joined = result.warnings.join('\n');
    expect(joined).toContain('移动修订');
    expect(joined).toContain('格式修订');
    expect(joined).toContain('嵌套');
    expect(joined).toContain('w:delText 出现在 w:del 之外');
    // 文字不静默丢：告警归告警，文字照收。
    const rendered = result.paragraphs[0]!.rendered_text;
    expect(rendered).toBe('甲移移新嵌套野');
  });

  it('⑦ 无 w:id 的 w:ins ⇒ source_id=null，仍读出（不因缺 id 丢整条）', () => {
    const result = readRevisionsFromDocumentXml(
      paragraphAt(`<w:ins w:author="匿名"><w:r><w:t>X</w:t></w:r></w:ins>`),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.source_id).toBeNull();
    expect(result.records[0]!.author).toBe('匿名');
  });
});

// ---------------------------------------------------------------------------

describe('导出 → 读回一致性（本包写权内两模块互证）', () => {
  it('⑧ 用 revisions-export 写出的 w:ins/w:del 片段，能被 reader 原样读回', () => {
    const tracking = { enabled: true, author: '审阅人' } as const;
    const ins = trackInsert(tracking, [], {
      id: 'i1',
      date: '2026-10-03T00:00:00Z',
      range: { node_id: 'p', start: 0, end: 2 },
      text: '新增',
    }).records[0]!;
    const del = trackInsert(tracking, [], {
      id: 'd1',
      date: '2026-10-03T01:00:00Z',
      range: { node_id: 'p', start: 0, end: 2 },
      text: '删除',
    }).records[0]!;
    // 造一条删除记录（trackInsert 产出的 kind 是 insert，这里直接用 writer 的片段生成入口）。
    const deleteRecord = { ...del, kind: 'delete' as const, text: '删除' };

    const insXml = planRevisionExport([ins], 5).fragments[0]!.xml;
    const delXml = planRevisionExport([deleteRecord], 6).fragments[0]!.xml;
    const result = readRevisionsFromDocumentXml(paragraphAt(insXml + delXml));

    expect(result.records).toHaveLength(2);
    const [readIns, readDel] = result.records;
    expect(readIns?.kind).toBe('insert');
    expect(readIns?.source_id).toBe(5);
    expect(readIns?.author).toBe('审阅人');
    expect(readIns?.date).toBe('2026-10-03T00:00:00Z');
    expect(readIns?.text).toBe('新增');
    expect(readDel?.kind).toBe('delete');
    expect(readDel?.source_id).toBe(6);
    expect(readDel?.text).toBe('删除');
    // 单用 writer 的入口，与 planRevisionExport 的片段一致。
    expect(planRevisionExport([ins], 5).fragments[0]!.element).toEqual(insertRevisionElement(ins, 5));
  });
});

// ---------------------------------------------------------------------------

describe('未处理范围不损坏（部分批处理的重定基）', () => {
  /** 一段里两条删除夹一段普通文字：A[BB]CC[DD]EE。 */
  const TWO_DELETES = paragraphAt(
    `<w:r><w:t>A</w:t></w:r>` +
      `<w:del w:id="1" w:author="审阅人" w:date="2026-10-03T00:00:00Z"><w:r><w:delText>BB</w:delText></w:r></w:del>` +
      `<w:r><w:t>CC</w:t></w:r>` +
      `<w:del w:id="2" w:author="审阅人" w:date="2026-10-03T00:00:00Z"><w:r><w:delText>DD</w:delText></w:r></w:del>` +
      `<w:r><w:t>EE</w:t></w:r>`,
  );

  it('⑨ 接受第一条删除后，未处理的第二条记录 range 被重定基，仍指向 "DD"', () => {
    const parsed = readRevisionsFromDocumentXml(TWO_DELETES);
    expect(parsed.paragraphs[0]!.rendered_text).toBe('ABBCCDDEE');
    expect(parsed.records.map((record) => record.text)).toEqual(['BB', 'DD']);
    expect({ start: parsed.records[1]!.start, end: parsed.records[1]!.end }).toEqual({ start: 5, end: 7 });

    const { model, records } = materializeRevisionModel(parsed, 'rebase-under-test');
    // 物化后段落文字恰为 rendered_text。
    expect(paragraphText(collectParagraphs(model.blocks)[0]!)).toBe('ABBCCDDEE');

    const outcome = requireOk(acceptRevisionsRebased(model, records, { kind: 'ids', ids: [records[0]!.id] }));
    // 第一条被接受 ⇒ "BB" 从正文移除。
    expect(paragraphText(collectParagraphs(outcome.value.model.blocks)[0]!)).toBe('ACCDDEE');
    expect(outcome.value.removed).toEqual([{ node_id: records[0]!.range.node_id, start: 1, end: 3 }]);
    expect(outcome.value.damaged).toEqual([]);

    // 关键：未处理的第二条**仍在**，且其 range 已左移 2 码位 —— 在新模型里仍指向 "DD"。
    expect(outcome.value.remaining).toHaveLength(1);
    const remaining = outcome.value.remaining[0]!;
    expect(remaining.id).toBe(records[1]!.id);
    expect({ start: remaining.range.start, end: remaining.range.end }).toEqual({ start: 3, end: 5 });
    const newParagraph = collectParagraphs(outcome.value.model.blocks)[0]!;
    expect(paragraphText(newParagraph).slice(remaining.range.start, remaining.range.end)).toBe('DD');

    // 接着接受这条重定基后的记录 ⇒ 完整"接受全部"的结果。
    const second = requireOk(acceptRevisions(outcome.value.model, outcome.value.remaining, { kind: 'all' }));
    expect(paragraphText(collectParagraphs(second.value.model.blocks)[0]!)).toBe('ACCEE');
  });

  it('⑩ 反向对照：不重定基的原引擎会把剩余记录指向错位文字（证明重定基确有必要）', () => {
    const parsed = readRevisionsFromDocumentXml(TWO_DELETES);
    const { model, records } = materializeRevisionModel(parsed, 'no-rebase-control');
    const outcome = requireOk(acceptRevisions(model, records, { kind: 'ids', ids: [records[0]!.id] }));
    const stale = outcome.value.remaining[0]!;
    const newParagraph = collectParagraphs(outcome.value.model.blocks)[0]!;
    // 旧 range [5,7) 在新文字 "ACCDDEE" 上指向 "EE"，**不再**是 "DD"。
    expect(newParagraph && paragraphText(newParagraph).slice(stale.range.start, stale.range.end)).toBe('EE');
  });

  it('⑪ 与本次移除重叠的剩余记录 ⇒ 具名进 damaged，不静默沿用', () => {
    const parsed = readRevisionsFromDocumentXml(TWO_DELETES);
    const { model, records } = materializeRevisionModel(parsed, 'overlap-under-test');
    // 人为造一条与 [1,3) 重叠的剩余记录（区间 [2,4)）——它跨越了本次移除的边界。
    const overlapping = { ...records[1]!, id: 'overlap', range: { ...records[1]!.range, start: 2, end: 4 } };
    const all = [records[0]!, overlapping];
    const outcome = requireOk(acceptRevisionsRebased(model, all, { kind: 'ids', ids: [records[0]!.id] }));
    expect(outcome.value.damaged).toEqual(['overlap']);
  });

  it('⑫ corpus-d 真实记录：接受删除不影响另一段的插入记录', () => {
    const parsed = readRevisionsFromDocumentXml(documentXmlOf(CORPUS_D));
    const { model, records } = materializeRevisionModel(parsed, 'corpus-d-rebase');
    const deleteRecord = records.find((record) => record.kind === 'delete')!;
    const insertRecord = records.find((record) => record.kind === 'insert')!;

    const outcome = requireOk(acceptRevisionsRebased(model, records, { kind: 'ids', ids: [deleteRecord.id] }));
    expect(outcome.value.damaged).toEqual([]);
    expect(outcome.value.remaining.map((record) => record.id)).toEqual([insertRecord.id]);
    // 插入记录在段落 7（另一段），偏移不受该删除影响。
    const paragraphs = collectParagraphs(outcome.value.model.blocks);
    expect(paragraphText(paragraphs[7]!)).toBe('新增');
  });
});

// ---------------------------------------------------------------------------

describe('引擎结果与纯投影互证（accept-all / reject-all）', () => {
  for (const [label, path] of [
    ['corpus-d', CORPUS_D],
    ['corpus-e', CORPUS_E],
  ] as const) {
    it(`⑬ ${label}：接受全部 = final_text，拒绝全部 = original_text`, () => {
      const parsed = readRevisionsFromDocumentXml(documentXmlOf(path));
      expect(parsed.records.length).toBeGreaterThan(0);

      const accepted = requireOk(
        acceptRevisions(
          materializeRevisionModel(parsed, `${label}-accept`).model,
          materializeRevisionModel(parsed, `${label}-accept`).records,
          { kind: 'all' },
        ),
      );
      const acceptedParagraphs = collectParagraphs(accepted.value.model.blocks);
      parsed.paragraphs.forEach((paragraph, index) => {
        expect(paragraphText(acceptedParagraphs[index]!), `${label} 接受全部 段${String(index)}`).toBe(
          projectParagraphText(paragraph, 'accept'),
        );
      });

      const rejected = requireOk(
        rejectRevisions(
          materializeRevisionModel(parsed, `${label}-reject`).model,
          materializeRevisionModel(parsed, `${label}-reject`).records,
          { kind: 'all' },
        ),
      );
      const rejectedParagraphs = collectParagraphs(rejected.value.model.blocks);
      parsed.paragraphs.forEach((paragraph, index) => {
        expect(paragraphText(rejectedParagraphs[index]!), `${label} 拒绝全部 段${String(index)}`).toBe(
          projectParagraphText(paragraph, 'reject'),
        );
      });
    });
  }

  it('⑭ 拒绝插入用 rejectRevisionsRebased：同段删除记录被重定基且不损', () => {
    const parsed = readRevisionsFromDocumentXml(
      paragraphAt(
        `<w:r><w:t>AB</w:t></w:r>` +
          `<w:ins w:id="1" w:author="审阅人" w:date="2026-10-03T00:00:00Z"><w:r><w:t>XY</w:t></w:r></w:ins>` +
          `<w:del w:id="2" w:author="审阅人" w:date="2026-10-03T00:00:00Z"><w:r><w:delText>CD</w:delText></w:r></w:del>`,
      ),
    );
    const { model, records } = materializeRevisionModel(parsed, 'reject-rebase');
    expect(parsed.paragraphs[0]!.rendered_text).toBe('ABXYCD');
    const insertRecord = records.find((record) => record.kind === 'insert')!;
    const deleteRecord = records.find((record) => record.kind === 'delete')!;

    const outcome = requireOk(rejectRevisionsRebased(model, records, { kind: 'ids', ids: [insertRecord.id] }));
    // 拒绝插入 = 删掉 "XY" ⇒ "ABCD"。
    expect(paragraphText(collectParagraphs(outcome.value.model.blocks)[0]!)).toBe('ABCD');
    expect(outcome.value.damaged).toEqual([]);
    const remaining = outcome.value.remaining[0]!;
    expect(remaining.id).toBe(deleteRecord.id);
    // "CD" 原在 [4,6)，左移 2 ⇒ [2,4)。
    expect({ start: remaining.range.start, end: remaining.range.end }).toEqual({ start: 2, end: 4 });
    expect(paragraphText(collectParagraphs(outcome.value.model.blocks)[0]!).slice(2, 4)).toBe('CD');
  });
});
