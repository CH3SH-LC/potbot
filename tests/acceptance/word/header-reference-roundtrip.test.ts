/**
 * 页眉 / 页脚**引用**必须能往返（协调者收口 WCF-D51/D61 报出的 R151 丢数据路径）。
 *
 * ## 这条缺陷为什么藏得久
 *
 * `serializeSectionProperties`（导出）早就写 `w:headerReference`，而 `parseSectionProperties`
 * （导入）**不解析**它。因为导出判"改没改"用的是**同一套解析**：
 *
 * - 未改动 ⇒ 两侧同样拿不到引用 ⇒ 判等 ⇒ **写回原字节**（看起来完全正常）；
 * - **改了别处** ⇒ 主部件按模型重建 ⇒ 引用**静默消失**——页眉部件还在包里躺着，
 *   但没有任何节引用它，Word 打开后页眉不显示，**且没有任何错误**。
 *
 * WCF-D61 用探针实测过这条路径（A0–A3），本文件把它固化成回归：
 * **先制造带引用的包，再改一段无关文字**——只测"导入导出一次"是测不出缺陷的。
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
const FIXTURE = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures', 'corpus-a-independent-deflate.docx');
const EVIDENCE_DIR = join(REPO_ROOT, '.dev-evidence', 'word-common-features', 'WCF-20261002-A', 'header-reference');

const MAIN_PART = 'word/document.xml';
const HEADER_PART = 'word/header1.xml';
const HEADER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const HEADER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:p><w:r><w:t>页眉证据</w:t></w:r></w:p></w:hdr>';

function loadFixture(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE));
}

function documentXmlOf(bytes: Uint8Array): string {
  return Buffer.from(readZip(bytes).by_path.get(MAIN_PART)!.data).toString('utf8');
}

/** 造一份**带页眉引用**的包：把页眉部件放进 `opaque_parts`，节上挂引用，然后让导出器落地关系。 */
function seedWithHeaderReference(): Uint8Array {
  const model = importDocx(loadFixture());
  const first = model.sections[0];
  if (first === undefined) throw new Error('夹具：语料没有任何节');

  const seeded: DocumentModel = {
    ...model,
    // 页眉部件走 `opaque_parts`：导出时未改动就原字节写回；内容类型显式声明为 header（Override）。
    opaque_parts: [
      ...model.opaque_parts,
      { path: HEADER_PART, content_type: HEADER_CONTENT_TYPE, bytes: new TextEncoder().encode(HEADER_XML) },
    ],
    content_types: {
      ...model.content_types,
      overrides: [
        ...model.content_types.overrides,
        { part_name: `/${HEADER_PART}`, content_type: HEADER_CONTENT_TYPE },
      ],
    },
    sections: [{ ...first, headers: [{ part_path: HEADER_PART, kind: 'default' }] }],
  };
  return exportDocx(seeded);
}

describe('节引用（w:headerReference）往返 —— R151「未修改区域保留」', () => {
  it('① 制造带引用的包：导出后主部件里确实有 headerReference，且关系与部件都在', () => {
    const seeded = seedWithHeaderReference();
    const archive = readZip(seeded);

    expect(documentXmlOf(seeded)).toMatch(/<w:headerReference[^>]*w:type="default"/);
    expect(documentXmlOf(seeded)).toMatch(/<w:headerReference[^>]*r:id="/);
    // 部件在包里；关系表里有指向它的记录（无悬空）。
    expect(archive.by_path.has(HEADER_PART)).toBe(true);
    const rels = Buffer.from(archive.by_path.get('word/_rels/document.xml.rels')!.data).toString('utf8');
    // 关系目标写的是**相对主部件的**路径（`header1.xml`），不是包内全路径——这是 OPC 的写法。
    expect(rels).toMatch(/Type="[^"]*\/header"[^>]*Target="header1\.xml"/);
    // 主部件里的 `r:id` 必须能在关系表里找到（否则就是悬空引用）。
    const referencedId = /<w:headerReference[^>]*r:id="([^"]+)"/.exec(documentXmlOf(seeded))?.[1];
    expect(referencedId).toBeDefined();
    expect(rels).toContain(`Id="${referencedId ?? ''}"`);
  });

  it('② 重新导入：模型里**能读到**这条引用（缺陷就在这一步：此前读到的是 undefined）', () => {
    const model = importDocx(seedWithHeaderReference());
    const headers = model.sections[0]?.headers;
    expect(headers).toBeDefined();
    expect(headers).toHaveLength(1);
    expect(headers?.[0]).toEqual({ part_path: HEADER_PART, kind: 'default' });
  });

  it('③ **改了别处的文字**之后，引用仍在（这是当初真正丢数据的那一步）', () => {
    const model = importDocx(seedWithHeaderReference());

    const applied = applyEditPlan(model, {
      steps: [
        {
          range: '指定文本:分散对齐固定行距段落。',
          operation: { domain: 'character', operation: { kind: 'setToggle', property: 'bold', value: true } },
        },
      ],
    });
    if (!applied.ok) throw new Error(`计划被拒绝：${applied.message}`);

    const out = exportDocx(applied.value.model);
    const xml = documentXmlOf(out);

    expect(xml).toMatch(/<w:headerReference[^>]*w:type="default"/);
    // 且这次编辑真的生效了（否则"重建"没发生，上面的断言就没有判别力）。
    expect(xml).toMatch(/<w:b\/>/);

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, 'header-reference-roundtrip.docx'), out);
  });

  it('④ 未改动时仍满足 R151：主部件写回原字节（导入侧新增的解析不得破坏字节不变）', () => {
    const seeded = seedWithHeaderReference();
    // 再导入一次、不改任何东西、导出 —— 主部件必须与原字节逐字节相同。
    const untouched = exportDocx(importDocx(seeded));
    const before = readZip(seeded).by_path.get(MAIN_PART)!.data;
    const after = readZip(untouched).by_path.get(MAIN_PART)!.data;
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });
});
