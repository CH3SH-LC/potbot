/**
 * `styles.xml` 写出侧（design-05-P3 / WCF-D50）。
 *
 * 判据集中在本文件：
 * - **未改动** ⇒ `stylesPartUnchanged` 为真（⇒ 导出走"原字节"分支，R151 的入口条件）；
 * - **改动后重建** ⇒ 模型改到的字段变了，而 `w:docDefaults` / `w:latentStyles` /
 *   `w:uiPriority` / `w:qFormat` / `w:pPr` 里的 `w:numPr` / `w:style@w:default` 全**还在**（R105）；
 * - **环 / 坏引用** ⇒ 结构化拒绝（R123），`reason === 'style_chain_invalid'`。
 */

import { describe, expect, it } from 'vitest';
import type { StyleDefinition, StyleTable } from '../model/types.js';
import { modifyNamedStyle } from '../styles/named.js';
import { DocxError } from './docx-error.js';
import { parseStyles } from './import.js';
import { assertStyleChainHealthy, stylesPartUnchanged, stylesPartXml } from './styles-part.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const bytes = (xml: string): Uint8Array => new TextEncoder().encode(xml);

/**
 * 一份**带齐未建模内容**的 `styles.xml`：`w:docDefaults`、`w:latentStyles`、
 * 样式上的 `w:default` 属性、`w:uiPriority` / `w:qFormat`、以及 `w:pPr` 里的 `w:numPr`。
 * 这些正是 R105 要求"重建后仍在"的东西。
 */
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  `<w:styles xmlns:w="${W}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:latentStyles w:defLockedState="0" w:count="1"><w:lsdException w:name="Normal"/></w:latentStyles>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
  '<w:basedOn w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
  '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:eastAsia="宋体"/></w:rPr></w:style>' +
  '</w:styles>';

function style(style_id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...extra,
  };
}

describe('styles.xml —— 未改动即等价（R151 的入口条件）', () => {
  it('从原字节解析出来的表与自身等价', () => {
    const parsed = parseStyles(bytes(STYLES_XML), 'word/styles.xml');
    expect(stylesPartUnchanged(parsed, bytes(STYLES_XML))).toBe(true);
    expect(parsed.styles.map((entry) => entry.style_id)).toEqual(['Normal', 'Heading1']);
  });

  it('改一个命名样式的 run_properties ⇒ 判定为"改动"', () => {
    const parsed = parseStyles(bytes(STYLES_XML), 'word/styles.xml');
    const changed = modifyNamedStyle(parsed, 'Heading1', {
      run_properties: { ...parsed.styles[1]?.run_properties, size: { state: 'set', value: { kind: 'pt', value: 18 } } },
    });
    if (!changed.ok) throw new Error('改样式失败');
    expect(stylesPartUnchanged(changed.table, bytes(STYLES_XML))).toBe(false);
  });

  it('样式数组顺序不同也算改动（顺序参与比较，不会被漏判）', () => {
    const parsed = parseStyles(bytes(STYLES_XML), 'word/styles.xml');
    const reordered: StyleTable = { styles: [...parsed.styles].reverse() };
    expect(stylesPartUnchanged(reordered, bytes(STYLES_XML))).toBe(false);
  });
});

describe('styles.xml —— 重建保住未建模内容（R105）', () => {
  const original = bytes(STYLES_XML);
  const parsed = parseStyles(original, 'word/styles.xml');

  it('改字号后：新值出现，而 docDefaults / latentStyles / uiPriority / qFormat 全在', () => {
    const changed = modifyNamedStyle(parsed, 'Heading1', {
      run_properties: { ...parsed.styles[1]?.run_properties, size: { state: 'set', value: { kind: 'pt', value: 18 } } },
    });
    if (!changed.ok) throw new Error('改样式失败');

    const xml = stylesPartXml(changed.table, original);
    expect(xml).toContain('<w:sz w:val="36"/>'); // 18pt = 36 半点
    expect(xml).not.toContain('<w:sz w:val="32"/>');
    // —— 未建模内容：一条都不能少 ——
    expect(xml).toContain('<w:docDefaults>');
    expect(xml).toContain('<w:latentStyles');
    expect(xml).toContain('<w:lsdException w:name="Normal"/>');
    expect(xml).toContain('<w:uiPriority w:val="9"/>');
    expect(xml).toContain('<w:qFormat/>');
  });

  it('`w:pPr` 里的 `w:numPr` 与 `w:outlineLvl` 在重建后仍在', () => {
    const changed = modifyNamedStyle(parsed, 'Heading1', {
      paragraph_properties: { ...parsed.styles[1]?.paragraph_properties, alignment: { state: 'set', value: 'center' } },
    });
    if (!changed.ok) throw new Error('改样式失败');
    const xml = stylesPartXml(changed.table, original);
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('<w:numId w:val="7"/>');
    expect(xml).toContain('<w:outlineLvl w:val="0"/>');
  });

  it('`w:style@w:default="1"` 不会被顺手抹掉（模型表达不了"明确不是默认"）', () => {
    const changed = modifyNamedStyle(parsed, 'Heading1', {
      run_properties: { ...parsed.styles[1]?.run_properties, bold: { state: 'off' } },
    });
    if (!changed.ok) throw new Error('改样式失败');
    const xml = stylesPartXml(changed.table, original);
    expect(xml).toContain('w:default="1"');
    expect(xml).toContain('w:styleId="Normal"');
  });

  it('清掉粗体：`<w:b/>` 消失（模型槽位是真被改写的，不是只加不改）', () => {
    const changed = modifyNamedStyle(parsed, 'Heading1', {
      run_properties: { ...parsed.styles[1]?.run_properties, bold: { state: 'unspecified' } },
    });
    if (!changed.ok) throw new Error('改样式失败');
    const xml = stylesPartXml(changed.table, original);
    expect(xml).not.toContain('<w:b/>');
    expect(xml).toContain('<w:sz w:val="32"/>'); // 其余槽位不受影响
  });

  it('原包里没有 styles.xml 时按模型新建（此时没有可保留的未建模内容）', () => {
    const xml = stylesPartXml({ styles: [style('Heading1', { name: '标题 1' })] }, null);
    expect(xml).toContain('<w:styles xmlns:w=');
    expect(xml).toContain('w:styleId="Heading1"');
    expect(xml).toContain('<w:name w:val="标题 1"/>');
  });
});

describe('styles.xml —— basedOn 环 / 坏引用在写出前拒绝（R123/R140）', () => {
  it('成环 ⇒ 抛 DocxError，reason = style_chain_invalid', () => {
    const cyclic: StyleTable = {
      styles: [style('A', { based_on: 'B' }), style('B', { based_on: 'A' })],
    };
    let caught: unknown = null;
    try {
      assertStyleChainHealthy(cyclic);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxError);
    expect((caught as DocxError).reason).toBe('style_chain_invalid');
    expect((caught as DocxError).message).toMatch(/cycle|环/);
  });

  it('指向不存在的样式 ⇒ 同样拒绝', () => {
    let caught: unknown = null;
    try {
      assertStyleChainHealthy({ styles: [style('A', { based_on: '不存在' })] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxError);
    expect((caught as DocxError).reason).toBe('style_chain_invalid');
  });

  it('健康的链（Heading1 → Normal）**不**被误拒', () => {
    expect(() => assertStyleChainHealthy(parseStyles(bytes(STYLES_XML), 'word/styles.xml'))).not.toThrow();
  });
});
