/**
 * P-I20 · `xml-parse.ts` **内联块定位（schema 位置）+ 关系枚举**定向验收。
 *
 * ## 为什么单独测这一层
 *
 * P-I02 的「重开既有文件」读取器要稳定地把幻灯片里的**内联** `p:timing` 块抠出来（schema 里它排在
 * `p:clrMapOvr` / `p:transition` 之后），并把 `_rels` 的 `Relationship` 按**文档顺序**复算。这两件事
 * 原先只有通用查询（`childElements` / `firstElement`），既没有"只看一层、不递归"的内联块定位，也没有
 * 带位置校验 / 文档顺序报告的关系枚举——本单元补这两个 seam，并**只新增导出**，不改既有解析结果。
 *
 * ## 判据（不靠"看起来像"）
 *
 * - **位置**：同一条 `p:timing`，分别构造「`p:transition` 在它前面」与「它是最后一个子元素」两种
 *   文档，都必须命中且 `orderViolations` 为空；再构造逆序文档，`orderViolations` 必须如实报出逆序者。
 * - **有界**：把 `p:timing` 埋进**更深一层**，必须**不**命中（证明只扫直接子元素，不递归捞同名）。
 * - **关系顺序**：同一份 `_rels` 两次枚举深相等；把文件里的关系**重排**后，枚举序列按新文件顺序变化
 *   （确定性），重复 `Id`、缺失 `Id` 都按文档顺序如实报告。
 * - **不回归**：新辅助命中到的节点，与既有 `childElements` 返回的是**同一节点**（既有解析结果未变）。
 *
 * ## 未验证
 *
 * 真机 PowerPoint / WPS 打开未验证（本工作包不触设备）；本套件只到 XML 树 / 文档顺序层。
 */

import { describe, expect, it } from 'vitest';

import {
  childElements,
  enumerateRelationships,
  locateInlineChildBlock,
  parseXmlDocument,
  relationshipOrderReport,
} from '../../../../src/presentations/xml-parse.js';

/** CT_Slide 直接子元素的 schema 顺序（本单元取相关的下标：p:timing = 3）。 */
const SLIDE_SCHEMA: readonly string[] = ['p:cSld', 'p:clrMapOvr', 'p:transition', 'p:timing', 'p:extLst'];

/** 用给定的直接子元素正文拼一页 `p:sld`。 */
function slide(inner: string): string {
  return `<p:sld xmlns:p="urn:p" xmlns:a="urn:a">${inner}</p:sld>`;
}

const TIMING_BLOCK = '<p:timing><p:tnLst/></p:timing>';

describe('locateInlineChildBlock — 内联块定位 + schema 位置校验', () => {
  it('transition 在前时命中 p:timing，位置合法', () => {
    const sld = parseXmlDocument(
      slide(`<p:cSld/><p:clrMapOvr/><p:transition dur="1000"/>${TIMING_BLOCK}<p:extLst/>`),
    );

    const located = locateInlineChildBlock(sld, 'p:timing', SLIDE_SCHEMA);

    expect(located).toBeDefined();
    expect(located?.node.name).toBe('p:timing');
    expect(located?.declared).toBe(true);
    expect(located?.schemaIndex).toBe(3);
    expect(located?.precedingElementNames).toEqual(['p:cSld', 'p:clrMapOvr', 'p:transition']);
    expect(located?.orderViolations).toEqual([]);
  });

  it('p:timing 是最后一个子元素时同样命中，位置合法', () => {
    const sld = parseXmlDocument(slide(`<p:cSld/><p:clrMapOvr/>${TIMING_BLOCK}`));

    const located = locateInlineChildBlock(sld, 'p:timing', SLIDE_SCHEMA);

    expect(located?.node.name).toBe('p:timing');
    expect(located?.elementIndex).toBe(2);
    expect(located?.precedingElementNames).toEqual(['p:cSld', 'p:clrMapOvr']);
    expect(located?.orderViolations).toEqual([]);
  });

  it('p:timing 逆序出现在 p:transition 之前时，仍能定位但如实报告逆序者', () => {
    const sld = parseXmlDocument(slide(`<p:cSld/>${TIMING_BLOCK}<p:transition dur="500"/>`));

    const located = locateInlineChildBlock(sld, 'p:timing', SLIDE_SCHEMA);

    expect(located?.node.name).toBe('p:timing');
    // 文档顺序 schema 序号序列 = [0, 3, 2] ⇒ 在 p:transition 处下降。
    expect(located?.orderViolations).toEqual(['p:transition']);
  });

  it('有界：p:timing 埋在更深一层时**不**命中（只扫直接子元素）', () => {
    const sld = parseXmlDocument(slide(`<p:cSld>${TIMING_BLOCK}</p:cSld>`));

    expect(locateInlineChildBlock(sld, 'p:timing', SLIDE_SCHEMA)).toBeUndefined();
    // 反证：既有递归无关的 childElements 也只看一层，节点确实不在直接子层。
    expect(childElements(sld, 'p:timing')).toHaveLength(0);
  });

  it('缺少该块 ⇒ undefined；父节点缺省 ⇒ undefined', () => {
    const sld = parseXmlDocument(slide('<p:cSld/>'));
    expect(locateInlineChildBlock(sld, 'p:timing', SLIDE_SCHEMA)).toBeUndefined();
    expect(locateInlineChildBlock(undefined, 'p:timing', SLIDE_SCHEMA)).toBeUndefined();
  });

  it('名字不在 schemaOrder 里 ⇒ 命中但 declared=false、schemaIndex=-1（如实报告，不抛错）', () => {
    const sld = parseXmlDocument(slide(`<p:cSld/><p:extFoo/>`));

    const located = locateInlineChildBlock(sld, 'p:extFoo', SLIDE_SCHEMA);

    expect(located?.declared).toBe(false);
    expect(located?.schemaIndex).toBe(-1);
    expect(located?.orderViolations).toEqual([]);
  });

  it('不回归：命中节点与既有 childElements 返回的是同一节点', () => {
    const sld = parseXmlDocument(slide(`<p:cSld/><p:clrMapOvr/>${TIMING_BLOCK}`));
    const viaExisting = childElements(sld, 'p:timing')[0];
    const viaNew = locateInlineChildBlock(sld, 'p:timing', SLIDE_SCHEMA)?.node;

    expect(viaNew).toBe(viaExisting);
  });
});

/** 一份关系部件（默认命名空间下的 `Relationships` / `Relationship`）。 */
function rels(inner: string): string {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
}

describe('enumerateRelationships / relationshipOrderReport — 关系按文档顺序', () => {
  it('按文件里出现的顺序枚举，不排序、不去重', () => {
    const root = parseXmlDocument(
      rels(
        '<Relationship Id="rId2" Type="t/slide" Target="slides/slide2.xml"/>' +
          '<Relationship Id="rId1" Type="t/slide" Target="slides/slide1.xml"/>' +
          '<Relationship Id="rId1" Type="t/dupe" Target="slides/slide1.xml"/>',
      ),
    );

    const entries = enumerateRelationships(root);

    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(entries.map((entry) => entry.id)).toEqual(['rId2', 'rId1', 'rId1']);
    expect(entries.map((entry) => entry.target)).toEqual([
      'slides/slide2.xml',
      'slides/slide1.xml',
      'slides/slide1.xml',
    ]);
    expect(entries.every((entry) => entry.external === false)).toBe(true);
  });

  it('重排后的 rels 文件被确定性地报出（同一份字节，两次枚举深相等）', () => {
    const before = parseXmlDocument(
      rels('<Relationship Id="rId1" Target="a.xml"/><Relationship Id="rId2" Target="b.xml"/>'),
    );
    const after = parseXmlDocument(
      rels('<Relationship Id="rId2" Target="b.xml"/><Relationship Id="rId1" Target="a.xml"/>'),
    );

    const beforeIds = relationshipOrderReport(before).ids;
    const afterIds = relationshipOrderReport(after).ids;

    expect(beforeIds).toEqual(['rId1', 'rId2']);
    expect(afterIds).toEqual(['rId2', 'rId1']);
    // 确定性：同一节点重复调用结果一致。
    expect(relationshipOrderReport(after)).toEqual(relationshipOrderReport(after));
    expect(enumerateRelationships(after).map((entry) => entry.id)).toEqual(['rId2', 'rId1']);
  });

  it('识别外部关系与缺失字段（不编造 id）', () => {
    const root = parseXmlDocument(
      rels('<Relationship Id="rId9" Type="t/ext" Target="https://example.invalid/x" TargetMode="External"/>' +
        '<Relationship Type="t/no-id" Target="slides/slide1.xml"/>'),
    );

    const entries = enumerateRelationships(root);

    expect(entries[0]?.external).toBe(true);
    expect(entries[0]?.targetMode).toBe('External');
    expect(entries[1]?.id).toBeUndefined();
    expect(relationshipOrderReport(root).ids).toEqual(['rId9', '<missing>']);
  });

  it('重复 Id 按文档顺序稳定报告（去重后一次）', () => {
    const root = parseXmlDocument(
      rels(
        '<Relationship Id="rId1"/><Relationship Id="rId1"/><Relationship Id="rId2"/>' +
          '<Relationship Id="rId1"/>',
      ),
    );

    const report = relationshipOrderReport(root);

    expect(report.count).toBe(4);
    expect(report.ids).toEqual(['rId1', 'rId1', 'rId2', 'rId1']);
    expect(report.duplicateIds).toEqual(['rId1']);
  });

  it('根缺省 ⇒ 空枚举、零计数', () => {
    expect(enumerateRelationships(undefined)).toEqual([]);
    expect(relationshipOrderReport(undefined)).toEqual({ count: 0, ids: [], duplicateIds: [] });
  });

  it('忽略非 Relationship 的直接子元素', () => {
    const root = parseXmlDocument(
      rels('<Foo/><Relationship Id="rId1"/><Relationship Id="rId2"/>'),
    );
    expect(enumerateRelationships(root).map((entry) => entry.id)).toEqual(['rId1', 'rId2']);
    expect(relationshipOrderReport(root).count).toBe(2);
  });
});
