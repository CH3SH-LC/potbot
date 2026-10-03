/**
 * **X06**：工作表 / 工作簿保护与单元格锁定（design-06-P8 / XLS-15）。
 *
 * 判据来自 ECMA-376 语义与"未知口令不绕过"的要求，不照抄实现：
 *
 * 1. **遗留哈希**用一个**手算**向量校验（不靠实现自证）：`"a" ⇒ CE88`、`"ab" ⇒ CF03`；
 * 2. **写出 → 读回**：字节往返 + 缺省项补全；
 * 3. **缺省值语义**：CT_SheetProtection 多数属性缺省是 true（锁定），只写与缺省不同的项；
 * 4. **未知口令显式拒绝**：现代 `algorithmName` 强哈希 ⇒ 抛错，而不是"通过"；
 * 5. **单元格锁定**：已保护 + 锁定格 + 无有效口令 ⇒ 拒绝修改；未锁定格 / 持口令 ⇒ 放行；
 * 6. **工作簿保护**：结构口令往返 + 现代算法拒绝。
 */

import { describe, expect, it } from 'vitest';

import { parseXml } from '../../../../src/documents/docx/xml-parse.js';
import {
  assertCellEditable,
  assertSheetUnlocked,
  buildSheetProtectionXml,
  buildWorkbookProtectionXml,
  hashSheetProtectionPassword,
  isCellEditable,
  parseSheetProtectionXml,
  parseWorkbookProtectionXml,
  protectSheet,
  protectWorkbook,
  verifySheetProtectionPassword,
  verifyWorkbookProtectionPassword,
} from '../../../../src/spreadsheets/protection/index.js';

/** 解析片段时取无命名空间属性的值。 */
function attrOf(element: ReturnType<typeof parseXml>, localName: string): string | null {
  for (const attribute of element.attributes) {
    if (attribute.name === localName) return attribute.value;
  }
  return null;
}

describe('X06 §1 遗留口令哈希（手算向量）', () => {
  it('"a" ⇒ CE88、字长 2 的 "ab" ⇒ CF03（与实现无关的手算对照）', () => {
    expect(hashSheetProtectionPassword('a')).toBe('CE88');
    expect(hashSheetProtectionPassword('ab')).toBe('CF03');
  });

  it('哈希是 1–4 位大写十六进制；空口令抛错（空 = 不设口令）', () => {
    const hash = hashSheetProtectionPassword('秘密');
    expect(hash).toMatch(/^[0-9A-F]{1,4}$/);
    expect(() => hashSheetProtectionPassword('')).toThrow(/非空字符串/);
  });

  it('哈希不可逆：模型里只有哈希，没有明文口令字段', () => {
    const model = protectSheet({ password: 'a' });
    expect(model.password_hash).toBe('CE88');
    expect(Object.keys(model)).not.toContain('password');
  });
});

describe('X06 §2 工作表保护写出 / 读回', () => {
  it('给口令 + 放开部分动作 ⇒ 只写与缺省不同的项', () => {
    const xml = buildSheetProtectionXml(
      protectSheet({ password: 'a', format_cells: false, sort: false, select_locked_cells: true }),
    );
    const root = parseXml(xml);
    expect(root.localName).toBe('sheetProtection');
    expect(attrOf(root, 'sheet')).toBe('1');
    expect(attrOf(root, 'password')).toBe('CE88');
    // formatCells 缺省 true ⇒ 显式 false 要写 "0"
    expect(attrOf(root, 'formatCells')).toBe('0');
    expect(attrOf(root, 'sort')).toBe('0');
    // selectLockedCells 缺省 false ⇒ 显式 true 要写 "1"
    expect(attrOf(root, 'selectLockedCells')).toBe('1');
    // formatColumns 仍是缺省 true ⇒ 不写
    expect(attrOf(root, 'formatColumns')).toBeNull();
  });

  it('字节往返：build(parse(build(m))) 与 build(m) 逐字节相同', () => {
    const model = protectSheet({ password: 'a', insert_rows: false, select_unlocked_cells: true });
    const first = buildSheetProtectionXml(model);
    const second = buildSheetProtectionXml(parseSheetProtectionXml(first));
    expect(second).toBe(first);
  });

  it('解析 Excel 风格的最小片段：缺失的布尔项按 OOXML 缺省补全', () => {
    const model = parseSheetProtectionXml('<sheetProtection xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" sheet="1" password="CE88"/>');
    expect(model.sheet).toBe(true);
    expect(model.password_hash).toBe('CE88');
    // 缺省 true（锁定）的一组
    expect(model.format_cells).toBe(true);
    expect(model.sort).toBe(true);
    expect(model.auto_filter).toBe(true);
    // 缺省 false 的一组
    expect(model.objects).toBe(false);
    expect(model.select_locked_cells).toBe(false);
  });

  it('反向对照：sheet != true 时拒绝写出', () => {
    expect(() => buildSheetProtectionXml({ sheet: false })).toThrow(/sheet=true/);
  });
});

describe('X06 §3 口令校验 / 未知口令显式拒绝', () => {
  const xml = buildSheetProtectionXml(protectSheet({ password: 'a' }));

  it('正确口令 ⇒ matched；错误口令 ⇒ 不匹配；无口令 ⇒ password_required=false', () => {
    expect(verifySheetProtectionPassword(xml, 'a').matched).toBe(true);
    expect(verifySheetProtectionPassword(xml, 'b').matched).toBe(false);
    const open = buildSheetProtectionXml(protectSheet({}));
    const check = verifySheetProtectionPassword(open, 'whatever');
    expect(check.password_required).toBe(false);
    expect(check.matched).toBe(true);
  });

  it('未知/不匹配口令 ⇒ assertSheetUnlocked 抛错（不绕过）', () => {
    expect(() => assertSheetUnlocked(xml, 'a')).not.toThrow();
    expect(() => assertSheetUnlocked(xml, 'wrong')).toThrow(/不匹配/);
  });

  it('现代强哈希（algorithmName）⇒ 显式拒绝，不返回"通过"', () => {
    const modern = '<sheetProtection xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" sheet="1" algorithmName="SHA-512" hashValue="AAAA" saltValue="BBBB" spinCount="100000"/>';
    expect(() => verifySheetProtectionPassword(modern, 'anything')).toThrow(/无法校验|拒绝绕过/);
    const model = parseSheetProtectionXml(modern);
    expect(model.modern?.algorithm).toBe('SHA-512');
    expect(model.modern?.spin_count).toBe(100000);
  });
});

describe('X06 §4 单元格锁定语义', () => {
  const locked = protectSheet({});
  const open = { sheet: false } as const;

  it('未保护 ⇒ 一律可编辑', () => {
    expect(isCellEditable(open, { locked: true }, false)).toBe(true);
  });

  it('已保护：锁定格在无有效口令时拒绝，未锁定格放行', () => {
    expect(isCellEditable(locked, { locked: true }, false)).toBe(false);
    expect(isCellEditable(locked, {}, false)).toBe(false); // 缺省即锁定
    expect(isCellEditable(locked, { locked: false }, false)).toBe(true);
  });

  it('持有已验证口令 ⇒ 锁定格也可编辑', () => {
    expect(isCellEditable(locked, { locked: true }, true)).toBe(true);
  });

  it('assertCellEditable 对被拒的锁定格抛错并带上上下文', () => {
    expect(() => assertCellEditable(locked, { locked: true }, false, '单元格 B2')).toThrow(/B2/);
    expect(() => assertCellEditable(locked, { locked: false }, false)).not.toThrow();
  });
});

describe('X06 §5 工作簿保护', () => {
  it('结构口令往返 + 校验', () => {
    const model = protectWorkbook({ lock_structure: true, workbook_password: 'a' });
    const xml = buildWorkbookProtectionXml(model);
    const back = parseWorkbookProtectionXml(xml);
    expect(back.lock_structure).toBe(true);
    expect(back.workbook_password_hash).toBe('CE88');
    expect(buildWorkbookProtectionXml(back)).toBe(xml);
    expect(verifyWorkbookProtectionPassword(xml, 'a', 'structure').matched).toBe(true);
    expect(verifyWorkbookProtectionPassword(xml, 'b', 'structure').matched).toBe(false);
  });

  it('lockStructure 缺省 false ⇒ 不写该属性（反向对照）', () => {
    const xml = buildWorkbookProtectionXml(protectWorkbook({ lock_windows: true }));
    const root = parseXml(xml);
    expect(attrOf(root, 'lockStructure')).toBeNull();
    expect(attrOf(root, 'lockWindows')).toBe('1');
  });

  it('修订口令与现代算法拒绝', () => {
    const rev = protectWorkbook({ lock_revision: true, revisions_password: 'ab' });
    const xml = buildWorkbookProtectionXml(rev);
    expect(parseWorkbookProtectionXml(xml).revisions_password_hash).toBe('CF03');
    expect(verifyWorkbookProtectionPassword(xml, 'ab', 'revisions').matched).toBe(true);

    const modern = '<workbookProtection xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" lockStructure="1" workbookAlgorithmName="SHA-512" workbookHashValue="AA" workbookSaltValue="BB" workbookSpinCount="100"/>';
    expect(() => verifyWorkbookProtectionPassword(modern, 'x', 'structure')).toThrow(/无法校验|拒绝绕过/);
  });
});
