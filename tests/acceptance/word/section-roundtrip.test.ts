/**
 * 节的三个可选字段**必须能往返**（协调者收口 WCF-D51 报出的不对称缺陷）。
 *
 * ## 为什么单独立一条用例
 *
 * `serializeSectionProperties`（导出）早就从模型写 `w:type` / `w:pgNumType` / `w:vAlign`，
 * 而 `parseSectionProperties`（导入）此前**不解析**它们。因为导出判"改没改"用的是
 * **同一套解析**，所以"未改动 ⇒ 两侧同样为空 ⇒ 判等 ⇒ 写回原字节"——**看起来没事**。
 * 真正的后果要**改了别处**才现形：主部件按模型重建，这三个字段**静默消失**。
 *
 * 因此本用例刻意走"**先制造带这三个字段的文档，再改一段无关的文字**"这条路——
 * 只测"导入导出一次"是测不出这个缺陷的（那正是它藏了这么久的原因）。
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../src/artifacts/ooxml/index.js';
import { exportDocx, importDocx } from '../../../src/documents/docx/index.js';
import { applyEditPlan } from '../../../src/documents/edit/plan.js';
import type { DocumentModel } from '../../../src/documents/model/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);
const EVIDENCE_DIR = join(
  REPO_ROOT,
  '.dev-evidence',
  'word-common-features',
  'WCF-20261002-A',
  'section-roundtrip',
);

const MAIN_PART = 'word/document.xml';

function loadFixture(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE));
}

function documentXmlOf(bytes: Uint8Array): string {
  return Buffer.from(readZip(bytes).by_path.get(MAIN_PART)!.data).toString('utf8');
}

/** 给模型的第一个节装上三个可选字段（模拟"文档本来就有这些设置"）。 */
function withSectionExtras(model: DocumentModel): DocumentModel {
  const first = model.sections[0];
  if (first === undefined) throw new Error('夹具：语料没有任何节');
  return {
    ...model,
    sections: [
      { ...first, sectionType: { state: 'set', value: 'nextPage' } },
      { ...first, pageNumbering: { format: 'upperRoman', start: 3 } },
      { ...first, verticalAlign: { state: 'set', value: 'center' } },
    ],
  };
}

describe('节的 w:type / w:pgNumType / w:vAlign 往返（R151 的"未修改区域保留"）', () => {
  it('先制造带这三个字段的文档：导出后 XML 里确实有它们', () => {
    const exported = exportDocx(withSectionExtras(importDocx(loadFixture())));
    const xml = documentXmlOf(exported);

    expect(xml).toMatch(/<w:type[^>]*w:val="nextPage"/);
    expect(xml).toMatch(/<w:pgNumType[^>]*w:fmt="upperRoman"/);
    expect(xml).toMatch(/<w:pgNumType[^>]*w:start="3"/);
    expect(xml).toMatch(/<w:vAlign[^>]*w:val="center"/);
  });

  it('**改了别处的文字**之后，这三个字段仍在（缺陷当初就是在这里丢的）', () => {
    // ① 造一份带节字段的文档，② 重新导入（走真实的解析路径），③ 改一段无关文字，④ 再导出。
    const seeded = exportDocx(withSectionExtras(importDocx(loadFixture())));
    const model = importDocx(seeded);

    // ②′ 导入必须**真的读到了**这三个字段——否则后面"还在"只是巧合（原字节被写回）。
    expect(model.sections[0]?.sectionType).toEqual({ state: 'set', value: 'nextPage' });
    expect(model.sections[1]?.pageNumbering).toEqual({ format: 'upperRoman', start: 3 });
    expect(model.sections[2]?.verticalAlign).toEqual({ state: 'set', value: 'center' });

    // ③ 改一段文字——这一步是让主部件**必须被重建**的开关。
    const applied = applyEditPlan(model, {
      steps: [
        {
          range: '指定文本:分散对齐固定行距段落。',
          operation: {
            domain: 'character',
            operation: { kind: 'setToggle', property: 'bold', value: true },
          },
        },
      ],
    });
    if (!applied.ok) throw new Error(`计划被拒绝：${applied.message}`);

    // ④ 重建后的 XML 里，节字段必须一个不少。
    const rebuilt = documentXmlOf(exportDocx(applied.value.model));
    expect(rebuilt).toMatch(/<w:type[^>]*w:val="nextPage"/);
    expect(rebuilt).toMatch(/<w:pgNumType[^>]*w:fmt="upperRoman"/);
    expect(rebuilt).toMatch(/<w:pgNumType[^>]*w:start="3"/);
    expect(rebuilt).toMatch(/<w:vAlign[^>]*w:val="center"/);
    // 且这次改动本身确实生效了（否则"重建"没发生，上面的断言就毫无判别力）。
    expect(rebuilt).toMatch(/<w:b\/>/);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, 'section-roundtrip.docx'), exportDocx(applied.value.model));
  });

  it('反例：**不设**这三个字段时，重建后的 XML 里不该凭空多出它们', () => {
    const model = importDocx(exportDocx(importDocx(loadFixture())));
    const applied = applyEditPlan(model, {
      steps: [
        {
          range: '指定文本:分散对齐固定行距段落。',
          operation: { domain: 'character', operation: { kind: 'setToggle', property: 'bold', value: true } },
        },
      ],
    });
    if (!applied.ok) throw new Error(applied.message);

    const rebuilt = documentXmlOf(exportDocx(applied.value.model));
    expect(rebuilt).not.toMatch(/<w:type /);
    expect(rebuilt).not.toMatch(/<w:pgNumType/);
    expect(rebuilt).not.toMatch(/<w:vAlign/);
  });
});
