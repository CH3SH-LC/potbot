/**
 * **X06（增量 / X-I11）**：**工作簿保护**的往返与边界的独立验收。
 *
 * 与工作表保护共享同一套遗留口令哈希，但**缺省值相反**（CT_WorkbookProtection 的
 * `lockStructure` / `lockWindows` / `lockRevision` 缺省 `false`），且**两套口令**分开
 * （`workbookPassword` 管结构 / 窗口，`revisionsPassword` 管修订）。判据：
 *
 * 1. **字节往返恒等**：`build(parse(build(m))) === build(m)`；
 * 2. **缺省补全**：解析 Excel 风格最小片段时，缺失的锁定项必须是 `false`（不是套用工作表那张 true 表）；
 * 3. **两套口令分别校验**：kind 选错不得匹配；无口令 ⇒ `password_required=false`；
 * 4. **现代强哈希显式拒绝**：`workbookAlgorithmName` / `revisionsAlgorithmName` ⇒ 抛错，不假装通过；
 * 5. **不存明文**：`protectWorkbook({ workbook_password: … })` 的模型里只有哈希。
 */

import { describe, expect, it } from 'vitest';

import { parseXml } from '../../../../src/documents/docx/xml-parse.js';
import {
  buildWorkbookProtectionXml,
  parseWorkbookProtectionXml,
  protectWorkbook,
  verifyWorkbookProtectionPassword,
} from '../../../../src/spreadsheets/protection/index.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function attrOf(root: ReturnType<typeof parseXml>, localName: string): string | null {
  for (const attribute of root.attributes) {
    if (attribute.name === localName) return attribute.value;
  }
  return null;
}

describe('X06-W §1 工作簿保护写出 / 读回（字节往返）', () => {
  it('结构口令 + 三项锁定 ⇒ 往返逐字节相同', () => {
    const model = protectWorkbook({ lock_structure: true, lock_windows: true, lock_revision: true, workbook_password: 'a' });
    const xml = buildWorkbookProtectionXml(model);
    const back = parseWorkbookProtectionXml(xml);
    expect(back.lock_structure).toBe(true);
    expect(back.lock_windows).toBe(true);
    expect(back.lock_revision).toBe(true);
    expect(back.workbook_password_hash).toBe('CE88');
    expect(buildWorkbookProtectionXml(back)).toBe(xml);
  });

  it('两套口令各自往返（结构与修订独立）', () => {
    const model = protectWorkbook({ lock_structure: true, lock_revision: true, workbook_password: 'a', revisions_password: 'ab' });
    const xml = buildWorkbookProtectionXml(model);
    const back = parseWorkbookProtectionXml(xml);
    expect(back.workbook_password_hash).toBe('CE88');
    expect(back.revisions_password_hash).toBe('CF03');
    expect(buildWorkbookProtectionXml(back)).toBe(xml);
  });

  it('lockStructure 缺省 false ⇒ 不写该属性；lockWindows=true 才写 "1"（反向对照）', () => {
    const xml = buildWorkbookProtectionXml(protectWorkbook({ lock_windows: true }));
    const root = parseXml(xml);
    expect(attrOf(root, 'lockStructure')).toBeNull();
    expect(attrOf(root, 'lockRevision')).toBeNull();
    expect(attrOf(root, 'lockWindows')).toBe('1');
  });

  it('整个模型为空 ⇒ 元素无任何属性（不凭空造锁定）', () => {
    const xml = buildWorkbookProtectionXml(protectWorkbook({}));
    const root = parseXml(xml);
    expect(root.localName).toBe('workbookProtection');
    expect(root.attributes.filter((attribute) => attribute.name !== 'xmlns')).toHaveLength(0);
  });
});

describe('X06-W §2 缺省补全（缺省是 false，不是工作表那张 true 表）', () => {
  it('解析 Excel 风格最小片段：缺失的锁定项全部为 false', () => {
    const model = parseWorkbookProtectionXml(`<workbookProtection xmlns="${NS}" workbookPassword="CE88"/>`);
    expect(model.workbook_password_hash).toBe('CE88');
    expect(model.lock_structure).toBeUndefined();
    expect(model.lock_windows).toBeUndefined();
    expect(model.lock_revision).toBeUndefined();
  });

  it('只写 lockRevision="1" 的片段 ⇒ 读回仅该项为 true', () => {
    const model = parseWorkbookProtectionXml(`<workbookProtection xmlns="${NS}" lockRevision="1" revisionsPassword="CF03"/>`);
    expect(model.lock_revision).toBe(true);
    expect(model.lock_structure).toBeUndefined();
    expect(model.revisions_password_hash).toBe('CF03');
  });

  it('没有 <workbookProtection> 的片段 ⇒ 抛错', () => {
    expect(() => parseWorkbookProtectionXml(`<workbook xmlns="${NS}"/>`)).toThrow(/workbookProtection/);
  });
});

describe('X06-W §3 口令校验（两套口令分别校验）', () => {
  const model = protectWorkbook({ lock_structure: true, lock_revision: true, workbook_password: 'a', revisions_password: 'ab' });
  const xml = buildWorkbookProtectionXml(model);

  it('结构口令：正确匹配 / 错误不匹配', () => {
    expect(verifyWorkbookProtectionPassword(xml, 'a', 'structure').matched).toBe(true);
    expect(verifyWorkbookProtectionPassword(xml, 'b', 'structure').matched).toBe(false);
  });

  it('修订口令：正确匹配 / 错误不匹配', () => {
    expect(verifyWorkbookProtectionPassword(xml, 'ab', 'revisions').matched).toBe(true);
    expect(verifyWorkbookProtectionPassword(xml, 'a', 'revisions').matched).toBe(false);
  });

  it('kind 选错 ⇒ 拿错哈希，不得误判为匹配', () => {
    const onlyStructure = buildWorkbookProtectionXml(protectWorkbook({ workbook_password: 'a' }));
    // 该文件没有 revisionsPassword ⇒ 修订侧 password_required=false（不能拿结构哈希来比）。
    const revisions = verifyWorkbookProtectionPassword(onlyStructure, 'a', 'revisions');
    expect(revisions.password_required).toBe(false);
    expect(revisions.matched).toBe(true);
  });

  it('无口令文件 ⇒ password_required=false / matched=true（不是"校验失败"）', () => {
    const open = buildWorkbookProtectionXml(protectWorkbook({ lock_structure: true }));
    const check = verifyWorkbookProtectionPassword(open, 'anything', 'structure');
    expect(check.password_required).toBe(false);
    expect(check.matched).toBe(true);
  });
});

describe('X06-W §4 现代强哈希显式拒绝（workbook / revisions）', () => {
  it('workbookAlgorithmName ⇒ 结构校验抛错，不假装通过', () => {
    const modern = `<workbookProtection xmlns="${NS}" lockStructure="1" workbookAlgorithmName="SHA-512" workbookHashValue="AA" workbookSaltValue="BB" workbookSpinCount="100"/>`;
    expect(() => verifyWorkbookProtectionPassword(modern, 'x', 'structure')).toThrow(/无法校验|拒绝绕过/);
    const model = parseWorkbookProtectionXml(modern);
    expect(model.workbook_modern?.algorithm).toBe('SHA-512');
    expect(model.workbook_modern?.spin_count).toBe(100);
  });

  it('revisionsAlgorithmName ⇒ 修订校验抛错', () => {
    const modern = `<workbookProtection xmlns="${NS}" revisionsAlgorithmName="SHA-512" revisionsHashValue="AA" revisionsSaltValue="BB" revisionsSpinCount="50000"/>`;
    expect(() => verifyWorkbookProtectionPassword(modern, 'x', 'revisions')).toThrow(/无法校验|拒绝绕过/);
  });

  it('现代哈希只在结构侧 ⇒ 修订侧仍可正常校验（不误伤另一套）', () => {
    const mixed = `<workbookProtection xmlns="${NS}" workbookAlgorithmName="SHA-512" workbookHashValue="AA" workbookSaltValue="BB" revisionsPassword="CF03"/>`;
    expect(() => verifyWorkbookProtectionPassword(mixed, 'x', 'structure')).toThrow();
    expect(verifyWorkbookProtectionPassword(mixed, 'ab', 'revisions').matched).toBe(true);
  });
});

describe('X06-W §5 不存明文口令', () => {
  it('模型只含哈希字段，键名不含明文 password', () => {
    const model = protectWorkbook({ lock_structure: true, workbook_password: 'a', revisions_password: 'ab' });
    const keys = Object.keys(model);
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('workbook_password');
    expect(keys).not.toContain('revisions_password');
    expect(model.workbook_password_hash).toBe('CE88');
    expect(model.revisions_password_hash).toBe('CF03');
  });

  it('序列化文本里不出现明文口令', () => {
    const xml = buildWorkbookProtectionXml(protectWorkbook({ workbook_password: 'a', revisions_password: 'ab' }));
    expect(xml).not.toContain('>a<');
    expect(xml).not.toContain('"a"');
    expect(xml).not.toContain('"ab"');
  });
});
