/**
 * **X06（增量 / X-I11）**：`<sheetProtection>` **注入助手**的独立验收。
 *
 * 判据不是"函数返回了东西"，而是"元素落在 CT_Worksheet 序列里的**正确位置**"：
 *
 * 1. **插入下标**：给定工作表现有子元素序列，`sheetProtectionInsertIndex` 必须把保护元素
 *    放在 `sheetData`（及可选 `sheetCalcPr`）之后、`mergeCells` / `conditionalFormatting` /
 *    `dataValidations` / `tableParts` 等**后继**元素之前（ECMA-376 §18.3.1.99）；
 * 2. **不改原数据**：注入返回**新**数组 / 新元素，原数组 / 原元素不变（纯函数）；
 * 3. **不静默重复**：已存在 `<sheetProtection>` 时抛错；非保护元素 / 非 worksheet 根抛错；
 * 4. **投影往返**：注入 → 序列化 → `parseSheetProtectionXml`（读侧对偶）读回模型，
 *    且 `build(parse(build(m))) === build(m)` 逐字节相同；
 * 5. **前置检查仍生效**：`sheet !== true` 的模型拒绝注入（不产出空保护）。
 */

import { describe, expect, it } from 'vitest';

import {
  attr,
  el,
  serializeXmlNode,
  type XmlElement,
} from '../../../../src/artifacts/ooxml/index.js';
import { SPREADSHEETML_NAMESPACE } from '../../../../src/artifacts/templates/xlsx.js';
import { childElements, parseXml } from '../../../../src/documents/docx/xml-parse.js';
import {
  buildSheetProtectionElement,
  buildSheetProtectionXml,
  injectSheetProtection,
  insertSheetProtectionElement,
  parseSheetProtectionXml,
  protectSheet,
  sheetProtectionInsertIndex,
  SHEET_PROTECTION_PRECEDING,
  withSheetProtection,
} from '../../../../src/spreadsheets/protection/index.js';

/** 构造一个工作表的子元素列表（只关心名字，内容从简）。 */
function named(...names: readonly string[]): readonly XmlElement[] {
  return names.map((name) => el(name, [], []));
}

describe('X06-I §1 插入下标（CT_Worksheet 序列）', () => {
  it('空工作表 ⇒ 插到最前（下标 0）', () => {
    expect(sheetProtectionInsertIndex([])).toBe(0);
  });

  it('只有后继元素（mergeCells / dataValidations）⇒ 仍插到最前', () => {
    expect(sheetProtectionInsertIndex(named('mergeCells', 'dataValidations'))).toBe(0);
  });

  it('紧跟 sheetData 之后', () => {
    expect(sheetProtectionInsertIndex(named('sheetViews', 'sheetData'))).toBe(2);
  });

  it('sheetData 与 mergeCells 之间（核心用例）', () => {
    expect(sheetProtectionInsertIndex(named('dimension', 'sheetViews', 'sheetData', 'mergeCells'))).toBe(3);
  });

  it('在 sheetCalcPr 之后（若该元素存在）', () => {
    expect(sheetProtectionInsertIndex(named('sheetData', 'sheetCalcPr'))).toBe(2);
  });

  it('多个后继元素（dataValidations / tableParts / extLst）都排在保护之后', () => {
    expect(
      sheetProtectionInsertIndex(named('sheetData', 'mergeCells', 'conditionalFormatting', 'dataValidations', 'tableParts', 'extLst')),
    ).toBe(1);
  });

  it('带命名空间前缀的元素按本地名识别（外部工作表）', () => {
    expect(sheetProtectionInsertIndex(named('x:sheetViews', 'x:sheetData', 'x:mergeCells'))).toBe(2);
  });

  it('SHEET_PROTECTION_PRECEDING 与规范前缀段一致（含 sheetData 与 sheetCalcPr）', () => {
    expect(SHEET_PROTECTION_PRECEDING).toContain('sheetData');
    expect(SHEET_PROTECTION_PRECEDING).toContain('sheetCalcPr');
    expect(SHEET_PROTECTION_PRECEDING).not.toContain('mergeCells');
  });
});

describe('X06-I §2 注入是纯函数（不改原数据）', () => {
  it('insertSheetProtectionElement 返回新数组，原数组不变', () => {
    const original = named('sheetViews', 'sheetData', 'mergeCells');
    const before = original.map((child) => child.name);
    const element = buildSheetProtectionElement(protectSheet({ password: 'a' }));
    const injected = insertSheetProtectionElement(original, element);
    expect(injected).toHaveLength(original.length + 1);
    expect(injected[2]).toBe(element);
    expect(original.map((child) => child.name)).toEqual(before);
    expect(original).toHaveLength(3);
  });

  it('withSheetProtection 返回新工作表元素，原元素子节点不变', () => {
    const worksheet = el('worksheet', [attr('xmlns', SPREADSHEETML_NAMESPACE)], named('sheetViews', 'sheetData'));
    const injected = withSheetProtection(worksheet, protectSheet({ password: 'a' }));
    expect(worksheet.children).toHaveLength(2);
    expect(injected.children).toHaveLength(3);
    expect(injected.attributes).toBe(worksheet.attributes);
    expect(injected.name).toBe('worksheet');
  });

  it('注入结果不可变（冻结）', () => {
    const injected = injectSheetProtection(named('sheetData'), protectSheet({}));
    expect(Object.isFrozen(injected)).toBe(true);
  });
});

describe('X06-I §3 拒绝静默重复 / 非法输入', () => {
  it('工作表里已有 <sheetProtection> ⇒ 抛错（不并排写两个）', () => {
    const element = buildSheetProtectionElement(protectSheet({}));
    expect(() => insertSheetProtectionElement([element], element)).toThrow(/已存在|重复注入/);
  });

  it('插入非 <sheetProtection> 元素 ⇒ 抛错', () => {
    expect(() => insertSheetProtectionElement(named('sheetData'), el('mergeCells', [], []))).toThrow(
      /必须是 <sheetProtection>/,
    );
  });

  it('withSheetProtection 的根不是 <worksheet> ⇒ 抛错', () => {
    expect(() => withSheetProtection(el('sheet', [], []), protectSheet({}))).toThrow(/<worksheet>/);
  });

  it('sheet:false 的模型 ⇒ buildSheetProtectionElement 抛错，注入链随之失败', () => {
    expect(() => injectSheetProtection(named('sheetData'), { sheet: false })).toThrow(/sheet=true/);
  });
});

describe('X06-I §4 注入 → 序列化 → 读回（投影往返）', () => {
  it('保护元素落在 sheetData 之后、mergeCells 之前（读回核对位置）', () => {
    const worksheet = el('worksheet', [attr('xmlns', SPREADSHEETML_NAMESPACE)], named('sheetViews', 'sheetData', 'mergeCells'));
    const injected = withSheetProtection(worksheet, protectSheet({ password: 'a' }));
    const root = parseXml(serializeXmlNode(injected));
    const order = childElements(root).map((child) => child.localName);
    expect(order.indexOf('sheetProtection')).toBe(order.indexOf('sheetData') + 1);
    expect(order.indexOf('sheetProtection')).toBeLessThan(order.indexOf('mergeCells'));
  });

  it('把整张工作表交给 parseSheetProtectionXml ⇒ 模型与序列化后逐字节可往返', () => {
    const model = protectSheet({ password: 'a', format_cells: false, select_locked_cells: true });
    const worksheet = el('worksheet', [attr('xmlns', SPREADSHEETML_NAMESPACE)], named('sheetViews', 'sheetData'));
    const serialized = serializeXmlNode(withSheetProtection(worksheet, model));
    const back = parseSheetProtectionXml(serialized);
    expect(back.sheet).toBe(true);
    expect(back.password_hash).toBe('CE88');
    expect(back.format_cells).toBe(false);
    expect(back.select_locked_cells).toBe(true);
    // 读回后重新写出，应与直接 build 的片段逐字节一致。
    expect(buildSheetProtectionXml(back)).toBe(buildSheetProtectionXml(model));
  });
});
