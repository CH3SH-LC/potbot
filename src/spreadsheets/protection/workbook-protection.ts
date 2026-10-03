/**
 * 表格域：**工作簿保护**（design-06-P8 / XLS-15 的工作簿一半）。
 *
 * 与工作表保护共用同一套遗留口令哈希（{@link hashSheetProtectionPassword}）：工作簿的
 * `workbookPassword` / `revisionsPassword` 属性都是 4 位十六进制哈希，明文不入文件。
 *
 * 与工作表保护的差别只有两点：
 * - **缺省值相反**：CT_WorkbookProtection 的 `lockStructure` / `lockWindows` / `lockRevision`
 *   缺省是 **false**（不锁定），而 CT_SheetProtection 的多数属性缺省是 true。这里如实按各自
 *   规范处理，不套用同一张缺省表。
 * - **两套口令**：`workbookPassword`（结构 / 窗口）与 `revisionsPassword`（修订）分开。
 *
 * 未知口令（现代 `workbookAlgorithmName` / `revisionsAlgorithmName`）同样**显式拒绝**，
 * 不返回"通过"。
 */

import { attr, el, serializeXmlNode, type XmlAttribute, type XmlElement } from '../../artifacts/ooxml/index.js';
import { SPREADSHEETML_NAMESPACE } from '../../artifacts/templates/xlsx.js';
import {
  attributeValue,
  findChild,
  parseXml,
  type ParsedXmlElement,
} from '../../documents/docx/xml-parse.js';
import { ValidationError } from '../../protocol/index.js';
import { hashSheetProtectionPassword, normalizeLegacyHash, type ModernPasswordHash } from './sheet-protection.js';

/** 工作簿保护模型（**不含明文口令**）。 */
export interface WorkbookProtection {
  readonly lock_structure?: boolean;
  readonly lock_windows?: boolean;
  readonly lock_revision?: boolean;
  /** `workbookPassword` 的遗留哈希。 */
  readonly workbook_password_hash?: string;
  /** `revisionsPassword` 的遗留哈希。 */
  readonly revisions_password_hash?: string;
  readonly workbook_modern?: ModernPasswordHash;
  readonly revisions_modern?: ModernPasswordHash;
}

/** {@link protectWorkbook} 的输入：可带两个明文口令。 */
export interface WorkbookProtectionOptions extends Omit<WorkbookProtection, 'workbook_password_hash' | 'revisions_password_hash'> {
  readonly workbook_password?: string;
  readonly revisions_password?: string;
}

/** 由选项生成工作簿保护模型。@throws {ValidationError} */
export function protectWorkbook(options: WorkbookProtectionOptions = {}): WorkbookProtection {
  const { workbook_password, revisions_password, ...rest } = options;
  const model: { -readonly [K in keyof WorkbookProtection]: WorkbookProtection[K] } = { ...rest };
  if (workbook_password !== undefined) model.workbook_password_hash = hashSheetProtectionPassword(workbook_password);
  if (revisions_password !== undefined) model.revisions_password_hash = hashSheetProtectionPassword(revisions_password);
  return Object.freeze(model);
}

interface LockSpec {
  readonly field: keyof WorkbookProtection;
  readonly ooxml: string;
}

/** 工作簿保护布尔属性（缺省都是 false ⇒ 只写显式 true 的项）。 */
const WORKBOOK_LOCKS: readonly LockSpec[] = Object.freeze([
  { field: 'lock_structure', ooxml: 'lockStructure' },
  { field: 'lock_windows', ooxml: 'lockWindows' },
  { field: 'lock_revision', ooxml: 'lockRevision' },
]);

function pushModern(prefix: string, modern: ModernPasswordHash | undefined, attributes: XmlAttribute[]): void {
  if (modern === undefined) return;
  if (typeof modern.algorithm !== 'string' || modern.algorithm.length === 0) {
    throw new ValidationError('现代口令哈希必须带非空 algorithmName');
  }
  attributes.push(attr(`${prefix}AlgorithmName`, modern.algorithm));
  if (modern.hash_value !== undefined) attributes.push(attr(`${prefix}HashValue`, modern.hash_value));
  if (modern.salt_value !== undefined) attributes.push(attr(`${prefix}SaltValue`, modern.salt_value));
  if (modern.spin_count !== undefined) attributes.push(attr(`${prefix}SpinCount`, String(modern.spin_count)));
}

/** 模型 → `<workbookProtection>` 元素。@throws {ValidationError} */
export function buildWorkbookProtectionElement(model: WorkbookProtection): XmlElement {
  const attributes: XmlAttribute[] = [];
  pushModern('workbook', model.workbook_modern, attributes);
  if (model.workbook_password_hash !== undefined) {
    attributes.push(attr('workbookPassword', normalizeLegacyHash(model.workbook_password_hash)));
  }
  pushModern('revisions', model.revisions_modern, attributes);
  if (model.revisions_password_hash !== undefined) {
    attributes.push(attr('revisionsPassword', normalizeLegacyHash(model.revisions_password_hash)));
  }
  for (const spec of WORKBOOK_LOCKS) {
    if (model[spec.field] === true) attributes.push(attr(spec.ooxml, '1'));
  }
  return el('workbookProtection', attributes);
}

function standalone(element: XmlElement): XmlElement {
  return el(element.name, [attr('xmlns', SPREADSHEETML_NAMESPACE), ...element.attributes], element.children);
}

/** `<workbookProtection …/>` 片段（自含命名空间）。@throws {ValidationError} */
export function buildWorkbookProtectionXml(model: WorkbookProtection): string {
  return serializeXmlNode(standalone(buildWorkbookProtectionElement(model)));
}

function readModern(element: ParsedXmlElement, prefix: string): ModernPasswordHash | undefined {
  const algorithm = attributeValue(element, '', `${prefix}AlgorithmName`);
  if (algorithm === null) return undefined;
  const modern: { -readonly [K in keyof ModernPasswordHash]: ModernPasswordHash[K] } = { algorithm };
  const hashValue = attributeValue(element, '', `${prefix}HashValue`);
  const saltValue = attributeValue(element, '', `${prefix}SaltValue`);
  const spinRaw = attributeValue(element, '', `${prefix}SpinCount`);
  if (hashValue !== null) modern.hash_value = hashValue;
  if (saltValue !== null) modern.salt_value = saltValue;
  if (spinRaw !== null) modern.spin_count = Number.parseInt(spinRaw, 10);
  return Object.freeze(modern);
}

/** `<workbookProtection>`（或含它的片段）→ 模型。@throws {ValidationError} */
export function parseWorkbookProtectionXml(xml: string): WorkbookProtection {
  const root = parseXml(xml);
  const element =
    root.localName === 'workbookProtection'
      ? root
      : findChild(root, SPREADSHEETML_NAMESPACE, 'workbookProtection');
  if (element === null) {
    throw new ValidationError('输入片段里没有 <workbookProtection> 元素');
  }
  const model: { -readonly [K in keyof WorkbookProtection]: WorkbookProtection[K] } = {};
  const workbookHash = attributeValue(element, '', 'workbookPassword');
  if (workbookHash !== null) model.workbook_password_hash = normalizeLegacyHash(workbookHash);
  const revisionsHash = attributeValue(element, '', 'revisionsPassword');
  if (revisionsHash !== null) model.revisions_password_hash = normalizeLegacyHash(revisionsHash);
  const workbookModern = readModern(element, 'workbook');
  if (workbookModern !== undefined) model.workbook_modern = workbookModern;
  const revisionsModern = readModern(element, 'revisions');
  if (revisionsModern !== undefined) model.revisions_modern = revisionsModern;
  for (const spec of WORKBOOK_LOCKS) {
    if (attributeValue(element, '', spec.ooxml) === '1') (model as Record<string, unknown>)[spec.field] = true;
  }
  return Object.freeze(model);
}

/** 要校验哪一口令。 */
export type WorkbookPasswordKind = 'structure' | 'revisions';

/** 口令校验结果。 */
export interface WorkbookPasswordCheck {
  readonly password_required: boolean;
  readonly matched: boolean;
}

/**
 * 校验工作簿保护口令；现代强哈希 ⇒ **显式拒绝**。
 * @throws {ValidationError} 现代算法 / 非法遗留哈希
 */
export function verifyWorkbookProtectionPassword(
  xml: string,
  password: string,
  kind: WorkbookPasswordKind = 'structure',
): WorkbookPasswordCheck {
  const model = parseWorkbookProtectionXml(xml);
  const modern = kind === 'structure' ? model.workbook_modern : model.revisions_modern;
  if (modern !== undefined) {
    throw new ValidationError(
      `工作簿保护（${kind}）使用现代口令哈希（algorithmName=${JSON.stringify(modern.algorithm)}），` +
        '本模块无法校验，拒绝绕过未知口令',
    );
  }
  const stored = kind === 'structure' ? model.workbook_password_hash : model.revisions_password_hash;
  if (stored === undefined) return Object.freeze({ password_required: false, matched: true });
  const expected = Number.parseInt(normalizeLegacyHash(stored), 16);
  const actual = Number.parseInt(hashSheetProtectionPassword(password), 16);
  return Object.freeze({ password_required: true, matched: expected === actual });
}
