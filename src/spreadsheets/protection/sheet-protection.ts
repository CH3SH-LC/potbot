/**
 * 表格域：**工作表保护 / 单元格锁定语义**（design-06-P8 / XLS-15）。
 *
 * ## 为什么必须"产出并读回 OOXML"
 *
 * XLS-15 的验收句是「**保存后保护状态正确**」且「**不绕过未知口令**」。只把 `sheet: true`
 * 记在 JS 对象里，真实 Excel 打开时什么保护都不会有。因此本模块的出口是一段可原样嵌进
 * `xl/worksheets/sheetN.xml` 的 `<sheetProtection …/>` 片段，并提供一个**对称的读数器**
 * {@link parseSheetProtectionXml}——写出去的字节能读回来，才是"往返"。
 *
 * ## 遗留口令哈希（ECMA-376 / MS-OFFCRYPTO §2.3.7.1 的 16 位算法）
 *
 * Excel 的 `password` 属性存的是**不可逆的 15 位哈希**（4 位十六进制），不是明文：
 *
 * ```text
 * hash = 0
 * for (i = len-1; i >= 0; i--) { hash = rotl15(hash); hash ^= code(i); }
 * hash = rotl15(hash); hash ^= len; hash ^= 0xCE4B;
 * ```
 *
 * `rotl15` 是**循环左移 1 位**（`((h>>14)&1) | ((h<<1)&0x7fff)`）。这是**可逆性的反面**：
 * 文件里没有明文，本模块也**不保存明文**——{@link protectSheet} 只把哈希放进模型。因此
 * "打开一个带口令的文件"只能靠**再次哈希后比对**（{@link verifySheetProtectionPassword}），
 * 不能"解密出原口令"，也**不允许**把"校验不了"当成"没有保护"。
 *
 * ## 未知口令的**显式拒绝**（XLS-15「不绕过未知口令」的落地）
 *
 * 现代 OOXML 用 `algorithmName` / `hashValue` / `saltValue` / `spinCount`（强哈希 + 随机盐 +
 * 迭代）表达口令，本模块**能读出这些属性但无法校验**（校验需要按 spinCount 迭代强哈希，
 * 且构建它们需要随机盐，与内核确定性纪律冲突）。对这些文件，{@link verifySheetProtectionPassword}
 * 与 {@link assertSheetUnlocked} **抛错**，而不是返回 `matched: true` 假装放行。
 *
 * ## 缺省值的坑：这些属性"缺失 = 锁定"
 *
 * CT_SheetProtection 的多数布尔属性**缺省为 true（= 该动作被禁止）**，与直觉相反。
 * 本模块的模型字段名与 OOXML 属性同名（值同义），写出时**只写与缺省不同的项**
 * （与真实 Excel 一致），读回时把缺失项**补成缺省值**——因此模型总是完全展开的。
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

/** 现代（强哈希）口令描述；存在时本模块**拒绝校验**（见文件头）。 */
export interface ModernPasswordHash {
  /** `algorithmName`，如 `SHA-512`。 */
  readonly algorithm: string;
  /** `hashValue`（base64）。 */
  readonly hash_value?: string;
  /** `saltValue`（base64）。 */
  readonly salt_value?: string;
  /** `spinCount`（迭代次数）。 */
  readonly spin_count?: number;
}

/**
 * 一条工作表保护（模型；**不含明文口令**）。
 *
 * 每个布尔字段与同名 OOXML 属性同义：`format_cells: true` ⇔ 写 `formatCells="1"`
 * ⇔ **禁止**格式化单元格（缺省即 true）。多数字段的 OOXML 缺省值是 `true`。
 */
export interface SheetProtection {
  /** `sheet="1"`——是否保护工作表。 */
  readonly sheet: boolean;
  /** 遗留口令哈希（1–4 位十六进制，大写）。**不是明文**。 */
  readonly password_hash?: string;
  /** 现代强哈希描述；存在 ⇒ 无法用遗留算法校验。 */
  readonly modern?: ModernPasswordHash;
  readonly objects?: boolean;
  readonly scenarios?: boolean;
  readonly format_cells?: boolean;
  readonly format_columns?: boolean;
  readonly format_rows?: boolean;
  readonly insert_columns?: boolean;
  readonly insert_rows?: boolean;
  readonly insert_hyperlinks?: boolean;
  readonly delete_columns?: boolean;
  readonly delete_rows?: boolean;
  readonly select_locked_cells?: boolean;
  readonly sort?: boolean;
  readonly auto_filter?: boolean;
  readonly pivot_tables?: boolean;
  readonly select_unlocked_cells?: boolean;
}

/** {@link protectSheet} 的输入：可带**明文口令**（仅用于当场算哈希，绝不入模型）。 */
export interface SheetProtectionOptions extends Omit<SheetProtection, 'sheet' | 'password_hash' | 'modern'> {
  /** 明文口令；给定时算出 {4 位 hex} 哈希。**不会被保存**。 */
  readonly password?: string;
}

interface FlagSpec {
  readonly field: keyof SheetProtection;
  readonly ooxml: string;
  /** 该属性在 OOXML 里**缺省**的取值（缺失时按它补全）。 */
  readonly whenAbsent: boolean;
}

/** CT_SheetProtection 的布尔属性表（顺序即写出顺序；`whenAbsent` 来自 ECMA-376 §18.3.1.85）。 */
const SHEET_FLAGS: readonly FlagSpec[] = Object.freeze([
  { field: 'objects', ooxml: 'objects', whenAbsent: false },
  { field: 'scenarios', ooxml: 'scenarios', whenAbsent: false },
  { field: 'format_cells', ooxml: 'formatCells', whenAbsent: true },
  { field: 'format_columns', ooxml: 'formatColumns', whenAbsent: true },
  { field: 'format_rows', ooxml: 'formatRows', whenAbsent: true },
  { field: 'insert_columns', ooxml: 'insertColumns', whenAbsent: true },
  { field: 'insert_rows', ooxml: 'insertRows', whenAbsent: true },
  { field: 'insert_hyperlinks', ooxml: 'insertHyperlinks', whenAbsent: true },
  { field: 'delete_columns', ooxml: 'deleteColumns', whenAbsent: true },
  { field: 'delete_rows', ooxml: 'deleteRows', whenAbsent: true },
  { field: 'select_locked_cells', ooxml: 'selectLockedCells', whenAbsent: false },
  { field: 'sort', ooxml: 'sort', whenAbsent: true },
  { field: 'auto_filter', ooxml: 'autoFilter', whenAbsent: true },
  { field: 'pivot_tables', ooxml: 'pivotTables', whenAbsent: true },
  { field: 'select_unlocked_cells', ooxml: 'selectUnlockedCells', whenAbsent: false },
]);

// ---------------------------------------------------------------------------
// 遗留口令哈希
// ---------------------------------------------------------------------------

/**
 * ECMA-376 遗留工作表口令哈希 → **4 位以内大写十六进制**。
 *
 * 手算对照（独立于实现，见 `protection.test.ts`）：`"a"` ⇒ `CE88`，`"ab"` ⇒ `CF03`。
 * @throws {ValidationError} 口令不是非空字符串（空口令 = 不设口令，不应产生哈希）
 */
export function hashSheetProtectionPassword(password: string): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new ValidationError('口令必须是非空字符串（空口令等于不设口令，不应生成哈希）');
  }
  let hash = 0;
  for (let index = password.length - 1; index >= 0; index -= 1) {
    hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7fff);
    hash ^= password.charCodeAt(index);
  }
  hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7fff);
  hash ^= password.length;
  hash ^= 0xce4b;
  return (hash & 0xffff).toString(16).toUpperCase();
}

/** 规范化并校验一个遗留哈希文本。@throws {ValidationError} 不是 1–4 位十六进制 */
export function normalizeLegacyHash(hash: string): string {
  if (typeof hash !== 'string' || !/^[0-9A-Fa-f]{1,4}$/.test(hash)) {
    throw new ValidationError(`遗留口令哈希必须是 1–4 位十六进制，收到 ${JSON.stringify(hash)}`);
  }
  return hash.toUpperCase();
}

/** 由选项生成一条保护模型（有 `password` 则算哈希；**不保存明文**）。@throws {ValidationError} */
export function protectSheet(options: SheetProtectionOptions = {}): SheetProtection {
  const { password, ...flags } = options;
  const model: { -readonly [K in keyof SheetProtection]: SheetProtection[K] } = { sheet: true, ...flags };
  if (password !== undefined) {
    model.password_hash = hashSheetProtectionPassword(password);
  }
  return Object.freeze(model);
}

// ---------------------------------------------------------------------------
// 写出
// ---------------------------------------------------------------------------

function modernElements(model: SheetProtection, attributes: XmlAttribute[]): void {
  const modern = model.modern;
  if (modern === undefined) return;
  if (typeof modern.algorithm !== 'string' || modern.algorithm.length === 0) {
    throw new ValidationError('现代口令哈希必须带非空 algorithmName');
  }
  attributes.push(attr('algorithmName', modern.algorithm));
  if (modern.hash_value !== undefined) attributes.push(attr('hashValue', modern.hash_value));
  if (modern.salt_value !== undefined) attributes.push(attr('saltValue', modern.salt_value));
  if (modern.spin_count !== undefined) attributes.push(attr('spinCount', String(modern.spin_count)));
}

/** 保护模型 → `<sheetProtection>` 元素（**不带** `xmlns`；供程序化拼进工作表）。@throws {ValidationError} */
export function buildSheetProtectionElement(model: SheetProtection): XmlElement {
  if (model.sheet !== true) {
    throw new ValidationError('只有 sheet=true 的保护才需要写出 <sheetProtection> 元素');
  }
  const attributes: XmlAttribute[] = [attr('sheet', '1')];
  if (model.password_hash !== undefined) {
    attributes.push(attr('password', normalizeLegacyHash(model.password_hash)));
  }
  modernElements(model, attributes);
  for (const spec of SHEET_FLAGS) {
    const value = model[spec.field] as boolean | undefined;
    const effective = value ?? spec.whenAbsent;
    if (effective !== spec.whenAbsent) {
      attributes.push(attr(spec.ooxml, effective ? '1' : '0'));
    }
  }
  return el('sheetProtection', attributes);
}

/** 给根元素补上默认命名空间声明，使片段可**独立解析**（嵌进工作表时属合法冗余声明）。 */
function standalone(element: XmlElement): XmlElement {
  return el(element.name, [attr('xmlns', SPREADSHEETML_NAMESPACE), ...element.attributes], element.children);
}

/** `<sheetProtection>` 文本片段（自含命名空间，可独立读回）。@throws {ValidationError} */
export function buildSheetProtectionXml(model: SheetProtection): string {
  return serializeXmlNode(standalone(buildSheetProtectionElement(model)));
}

// ---------------------------------------------------------------------------
// 读回
// ---------------------------------------------------------------------------

function boolAttribute(element: ParsedXmlElement, localName: string): boolean | undefined {
  const raw = attributeValue(element, '', localName);
  if (raw === null) return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new ValidationError(`属性 ${localName} 的布尔值非法：${JSON.stringify(raw)}`);
}

function readModern(element: ParsedXmlElement): ModernPasswordHash | undefined {
  const algorithm = attributeValue(element, '', 'algorithmName');
  if (algorithm === null) return undefined;
  const hashValue = attributeValue(element, '', 'hashValue');
  const saltValue = attributeValue(element, '', 'saltValue');
  const spinRaw = attributeValue(element, '', 'spinCount');
  const modern: { -readonly [K in keyof ModernPasswordHash]: ModernPasswordHash[K] } = { algorithm };
  if (hashValue !== null) modern.hash_value = hashValue;
  if (saltValue !== null) modern.salt_value = saltValue;
  if (spinRaw !== null) modern.spin_count = Number.parseInt(spinRaw, 10);
  return Object.freeze(modern);
}

/**
 * `<sheetProtection>` 片段 → 保护模型（缺失的布尔项按 OOXML 缺省补全）。@throws {ValidationError}
 *
 * 接受 `<sheetProtection>` 或任意以它为直接子元素的片段（如整张 `<worksheet>`）。
 */
export function parseSheetProtectionXml(xml: string): SheetProtection {
  const root = parseXml(xml);
  const element = root.localName === 'sheetProtection' ? root : findChild(root, SPREADSHEETML_NAMESPACE, 'sheetProtection');
  if (element === null) {
    throw new ValidationError('输入片段里没有 <sheetProtection> 元素');
  }
  const sheetRaw = boolAttribute(element, 'sheet');
  const model: { -readonly [K in keyof SheetProtection]: SheetProtection[K] } = { sheet: sheetRaw ?? false };
  const password = attributeValue(element, '', 'password');
  if (password !== null) model.password_hash = normalizeLegacyHash(password);
  const modern = readModern(element);
  if (modern !== undefined) model.modern = modern;
  for (const spec of SHEET_FLAGS) {
    const raw = boolAttribute(element, spec.ooxml);
    (model as Record<string, unknown>)[spec.field] = raw ?? spec.whenAbsent;
  }
  return Object.freeze(model);
}

// ---------------------------------------------------------------------------
// 口令校验 / 未解锁拒绝
// ---------------------------------------------------------------------------

/** 口令校验结果。 */
export interface SheetPasswordCheck {
  /** 恒为 true：拿到的就是一条保护。 */
  readonly protected: true;
  /** 该文件是否设了口令（无口令时任何人都能取消保护）。 */
  readonly password_required: boolean;
  /** 提供的口令是否匹配。 */
  readonly matched: boolean;
}

/**
 * 校验口令：**只做"再哈希后比对"**，不解密明文。
 *
 * @throws {ValidationError} 文件用现代强哈希（本模块无法校验）⇒ **显式拒绝**，不返回"通过"；
 *                            或遗留哈希字段本身非法。
 */
export function verifySheetProtectionPassword(xml: string, password: string): SheetPasswordCheck {
  const model = parseSheetProtectionXml(xml);
  if (model.modern !== undefined) {
    throw new ValidationError(
      `工作表保护使用现代口令哈希（algorithmName=${JSON.stringify(model.modern.algorithm)}），` +
        '本模块无法校验，拒绝绕过未知口令',
    );
  }
  if (model.password_hash === undefined) {
    return Object.freeze({ protected: true, password_required: false, matched: true });
  }
  const expected = Number.parseInt(normalizeLegacyHash(model.password_hash), 16);
  const actual = Number.parseInt(hashSheetProtectionPassword(password), 16);
  return Object.freeze({ protected: true, password_required: true, matched: expected === actual });
}

/**
 * 要求给定口令能解锁；不能则抛错（**不绕过未知口令**）。@throws {ValidationError}
 */
export function assertSheetUnlocked(xml: string, password: string): void {
  const check = verifySheetProtectionPassword(xml, password);
  if (!check.matched) {
    throw new ValidationError('工作表保护口令不匹配，拒绝修改');
  }
}

// ---------------------------------------------------------------------------
// 单元格锁定语义（XLS-15「有权限才修改」）
// ---------------------------------------------------------------------------

/** 单元格的锁定态（对应 styles 里的 protection）。默认 `locked = true`（Excel 约定）。 */
export interface CellLockState {
  readonly locked?: boolean;
}

/**
 * 该单元格当前是否可编辑。
 *
 * 语义：未保护 ⇒ 可编辑；已保护但持有已验证口令 ⇒ 可编辑；否则只有**未锁定格**可编辑。
 */
export function isCellEditable(model: SheetProtection, cell: CellLockState, hasUnlock: boolean): boolean {
  if (model.sheet !== true) return true;
  if (hasUnlock) return true;
  return cell.locked === false;
}

/** 要求该单元格可编辑，否则抛错。@throws {ValidationError} */
export function assertCellEditable(
  model: SheetProtection,
  cell: CellLockState,
  hasUnlock: boolean,
  context = '该单元格',
): void {
  if (!isCellEditable(model, cell, hasUnlock)) {
    throw new ValidationError(`工作表已保护且 ${context} 处于锁定状态，拒绝修改`);
  }
}
