/**
 * `numbering.xml` 读 / 写（design-05-P3 / WCF-D50）。
 *
 * 关键判据：**既有 `w:numId` / `w:abstractNumId` 与顺序逐条不变**（R106 的同类纪律），
 * 以及重建后未建模内容（`w:numPicBullet`、`w:nsid`、`w:rPr@w:hint`）仍在（R105）。
 */

import { describe, expect, it } from 'vitest';
import { nextNumId, updateLevelForInstance } from '../numbering/table.js';
import type { NumberingTable } from '../numbering/types.js';
import { parseNumberingPart, numberingPartUnchanged, numberingPartXml } from './numbering-part.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const bytes = (xml: string): Uint8Array => new TextEncoder().encode(xml);

/**
 * 一份带齐未建模内容的编号表：`w:numPicBullet`、`w:nsid`、`w:rPr@w:hint="default"`。
 * abstractNum 0 是多级（decimal），abstractNum 1 是单级（bullet）；两个实例，其一有 `w:lvlOverride`。
 */
const NUMBERING_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  `<w:numbering xmlns:w="${W}">` +
  '<w:numPicBullet w:numPicBulletId="0"><w:pict/></w:numPicBullet>' +
  '<w:abstractNum w:abstractNumId="0" w:multiLevelType="hybridMultilevel">' +
  '<w:nsid w:val="1A2B3C4D"/><w:styleLink w:val="ListParagraph"/>' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:suff w:value="space"/>' +
  '<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
  '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>' +
  '</w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1" w:multiLevelType="singleLevel">' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>' +
  '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>' +
  '</w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/>' +
  '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>' +
  '</w:numbering>';

const ORIGINAL = bytes(NUMBERING_XML);
const PARSED = parseNumberingPart(ORIGINAL);

/** 某个 `w:numId="n"` / `w:abstractNumId="n"` 在文本里的位置（用于断言"顺序不变"）。 */
const indexOfNum = (xml: string, id: string): number => xml.indexOf(`<w:num w:numId="${id}"`);
const indexOfAbstract = (xml: string, id: string): number =>
  xml.indexOf(`<w:abstractNum w:abstractNumId="${id}"`);

describe('numbering.xml —— 解析', () => {
  it('抽象定义、实例、级别覆盖都读出来了，id 原样', () => {
    expect(PARSED.abstract.map((entry) => entry.abstract_num_id)).toEqual(['0', '1']);
    expect(PARSED.instances.map((entry) => entry.num_id)).toEqual(['1', '2']);
    expect(PARSED.abstract[0]?.levels[0]?.format).toBe('decimal');
    expect(PARSED.abstract[1]?.levels[0]?.format).toBe('bullet');
    expect(PARSED.abstract[1]?.levels[0]?.text_template).toBe('•');
    expect(PARSED.instances[1]?.overrides[0]?.start_override).toBe(5);
  });

  it('缩进按 **twips** 读（无损），字符缩进走 `Chars` 槽位', () => {
    // 720 twips = 0.5 英寸；按 twips 读避免 pt 换算的浮点尾数。
    expect(PARSED.abstract[0]?.levels[0]?.indent_left).toEqual({ unit: 'twips', value: 720 });
    expect(PARSED.abstract[0]?.levels[0]?.indent_hanging).toEqual({ unit: 'twips', value: 360 });
  });

  it('从原字节解析出来的表与自身等价（R151 的入口条件）', () => {
    expect(numberingPartUnchanged(PARSED, ORIGINAL)).toBe(true);
  });

  it('原字节**读不出来** ⇒ 判"未改动"（保守回退：宁可保原样，不让看不懂的字节把导出弄失败）', () => {
    expect(numberingPartUnchanged(PARSED, bytes('<not-numbering/>'))).toBe(true);
  });

  it('"解析 → 规范化序列化 → 再解析"是不动点（指纹稳）', () => {
    const once = numberingPartXml(PARSED, null);
    const twice = numberingPartXml(parseNumberingPart(new TextEncoder().encode(once)), null);
    expect(twice).toBe(once);
  });
});

describe('numbering.xml —— 重建', () => {
  it('改一级的编号格式：新值出现，其余级别与未建模内容全在', () => {
    const table = updateLevelForInstance(PARSED, '1', 0, (current) => ({ ...current, format: 'lowerRoman' }));
    if (!table.ok) throw new Error(`改级别失败：${table.detail}`);

    const xml = numberingPartXml(table.table, ORIGINAL);
    expect(xml).toContain('<w:numFmt w:val="lowerRoman"/>');
    // 未建模内容（R105）
    expect(xml).toContain('<w:numPicBullet w:numPicBulletId="0">');
    expect(xml).toContain('<w:nsid w:val="1A2B3C4D"/>');
    expect(xml).toContain('<w:styleLink w:val="ListParagraph"/>');
    expect(xml).toContain('<w:suff w:value="space"/>');
    expect(xml).toContain('w:hint="default"');
    // 另一个抽象定义（bullet）没被牵连
    expect(xml).toContain('<w:numFmt w:val="bullet"/>');
    expect(xml).toContain('<w:lvlText w:val="•"/>');
  });

  it('既有 `w:numId` / `w:abstractNumId` 与顺序逐条不变', () => {
    const table = updateLevelForInstance(PARSED, '1', 0, (current) => ({ ...current, format: 'upperRoman' }));
    if (!table.ok) throw new Error('改级别失败');
    const xml = numberingPartXml(table.table, ORIGINAL);

    for (const id of ['0', '1']) {
      expect(indexOfAbstract(xml, id)).toBeGreaterThanOrEqual(0);
    }
    for (const id of ['1', '2']) {
      expect(indexOfNum(xml, id)).toBeGreaterThanOrEqual(0);
    }
    expect(indexOfAbstract(xml, '0')).toBeLessThan(indexOfAbstract(xml, '1'));
    expect(indexOfNum(xml, '1')).toBeLessThan(indexOfNum(xml, '2'));
    expect(xml).toContain('<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/>');
  });

  it('新增一个实例：`w:numId` 取**未占用**值且既有编号一个不动', () => {
    const newId = nextNumId(PARSED);
    expect(newId).toBe('3'); // 既有 1、2 ⇒ 最小未占用是 3

    const added: NumberingTable = {
      ...PARSED,
      instances: [...PARSED.instances, { num_id: newId, abstract_num_id: '1', overrides: [] }],
    };
    const xml = numberingPartXml(added, ORIGINAL);
    expect(xml).toContain('<w:num w:numId="3">');
    // 既有编号与顺序没被重排：新条目追加在末尾。
    expect(indexOfNum(xml, '1')).toBeLessThan(indexOfNum(xml, '2'));
    expect(indexOfNum(xml, '2')).toBeLessThan(indexOfNum(xml, '3'));
    // 既有的覆盖项还在（没有"顺手重建把别人的 lvlOverride 冲掉"）。
    expect(xml).toContain('<w:startOverride w:val="5"/>');
  });

  it('新增一个抽象定义：插在第一个 `w:num` **之前**（CT_Numbering 的 schema 顺序）', () => {
    const added: NumberingTable = {
      ...PARSED,
      abstract: [
        ...PARSED.abstract,
        {
          abstract_num_id: '2',
          multi_level_type: 'singleLevel',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text_template: '%1.',
              start: 1,
              indent_left: { unit: 'twips', value: 720 },
              indent_hanging: { unit: 'twips', value: 360 },
              style_ref: null,
              alignment: 'left',
              bullet_font: null,
              restart_after_level: null,
            },
          ],
        },
      ],
    };
    const xml = numberingPartXml(added, ORIGINAL);
    expect(indexOfAbstract(xml, '2')).toBeGreaterThan(indexOfAbstract(xml, '1'));
    expect(indexOfAbstract(xml, '2')).toBeLessThan(indexOfNum(xml, '1'));
    expect(indexOfNum(xml, '1')).toBeLessThan(indexOfNum(xml, '2'));
  });

  it('原包里没有 numbering.xml 时按模型新建（此时没有可保留的未建模内容）', () => {
    const table: NumberingTable = {
      abstract: [
        {
          abstract_num_id: 'abs1',
          multi_level_type: 'singleLevel',
          levels: [
            {
              level: 0,
              format: 'bullet',
              text_template: '•',
              start: 1,
              indent_left: { unit: 'twips', value: 720 },
              indent_hanging: { unit: 'twips', value: 360 },
              style_ref: null,
              alignment: 'left',
              bullet_font: 'Symbol',
              restart_after_level: null,
            },
          ],
        },
      ],
      instances: [{ num_id: '1', abstract_num_id: 'abs1', overrides: [] }],
    };
    const xml = numberingPartXml(table, null);
    expect(xml).toContain('<w:numbering xmlns:w=');
    expect(xml).toContain('<w:numFmt w:val="bullet"/>');
    expect(xml).toContain('<w:lvlText w:val="•"/>');
    // `bullet_font: 'Symbol'` 经 D32 的 `fontSetOf` 铺满四个槽位（这是它的既有行为）。
    expect(xml).toContain('<w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:eastAsia="Symbol" w:cs="Symbol"/>');
  });
});
