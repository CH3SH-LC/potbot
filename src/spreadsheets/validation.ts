/**
 * 表格域：数据验证 / 下拉值 / 输入提示 / 错误提示（design-06-P8 / XLS-11 前半）。
 *
 * ## 为什么这里必须**产出 OOXML**
 *
 * XLS-11 的验收句写得很死：「**必须写入文件而非仅网页效果**」。一个只把"下拉有哪几个选项"
 * 记在 JS 对象里的实现，在真实 Excel 打开文件时**什么都不会出现**。因此本模块的出口是
 * `buildDataValidationsXml`——一段可原样嵌进 `xl/worksheets/sheetN.xml` 的
 * `<dataValidations>` 片段（用 `el` / `attr` / `serializeXmlNode`，不自己拼字符串，
 * 引号 / `<` / `&` 的转义全交给序列化器）。
 *
 * ## 一个必须点破的反直觉细节：`showDropDown` 是**反的**
 *
 * ECMA-376 里 `showDropDown="1"` 的含义是「**隐藏**单元格内的下拉箭头」，不是"显示"。
 * 直接把调用方的 `showDropDown: true` 映射过去，就会得到"想显示反而隐藏"的错文件。
 * 因此本模块的模型字段叫 {@link DataValidationRule.suppress_dropdown}（名字即语义），
 * 缺省**不写**该属性（= 显示下拉，Excel 的默认）。
 *
 * ## 内联下拉值的硬限制
 *
 * 内联列表 `formula1` 是形如 `"甲,乙,丙"` 的**带引号字符串**：值里不能再有逗号，
 * 且整串（含引号）不得超过 255 字符——这是 Excel 的硬限制，越界就抛，**不做静默截断**。
 *
 * ## `type` 的缺省值是 `none`
 *
 * ECMA-376 里 `type` 可省略，缺省即 `none`（"任意值"）——真实 Excel 对"只挂输入提示、不约束取值"
 * 的验证就是这么写的。因此读侧把缺失的 `type` 还原为 {@link ValidationType} 的 `none`，而非报错；
 * 只有**写出**时才显式带上 `type="none"`，使 `build(parse(build(x))) === build(x)` 成立。
 */

import { attr, el, serializeXmlNode, type XmlAttribute, type XmlElement } from '../artifacts/ooxml/index.js';
import { SPREADSHEETML_NAMESPACE } from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXml,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { ValidationError } from '../protocol/index.js';
import { parseRange } from './reference.js';

/** 验证类型（对应 OOXML `type`；`none` 即 OOXML 的默认值"任意值"）。 */
export type ValidationType = 'none' | 'list' | 'whole' | 'decimal' | 'date' | 'time' | 'textLength' | 'custom';

const KNOWN_TYPES: ReadonlySet<string> = new Set<ValidationType>([
  'none',
  'list',
  'whole',
  'decimal',
  'date',
  'time',
  'textLength',
  'custom',
]);

/** 比较算子（对应 OOXML `operator`）。 */
export type ValidationOperator =
  | 'between'
  | 'notBetween'
  | 'equal'
  | 'notEqual'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual';

/** 错误提示级别（对应 OOXML `errorStyle`）。 */
export type ValidationErrorStyle = 'stop' | 'warning' | 'information';

/** 内联下拉列表（含引号与逗号）的长度上限。 */
export const MAX_INLINE_LIST_LENGTH = 255;

const TYPES_WITH_OPERATOR: ReadonlySet<ValidationType> = new Set(['whole', 'decimal', 'date', 'time', 'textLength']);
const OPERATORS_REQUIRING_BOUND: ReadonlySet<ValidationOperator> = new Set(['between', 'notBetween']);

/** 一条数据验证规则。 */
export interface DataValidationRule {
  /** 应用范围（sqref；每项是 A1 区域文本，多项以空格拼接）。 */
  readonly ranges: readonly string[];
  readonly type: ValidationType;
  readonly operator?: ValidationOperator;
  /** 约束表达式之一（列表时可为区域引用，如 `$D$1:$D$3`）。 */
  readonly formula1?: string;
  /** 第二个约束（`between` / `notBetween` 必需）。 */
  readonly formula2?: string;
  /** 内联下拉值（与 `formula1` **互斥**）。 */
  readonly list_values?: readonly string[];
  readonly allow_blank?: boolean;
  /** `true` ⇒ 写 `showDropDown="1"`，即**隐藏**下拉箭头（见文件头）。 */
  readonly suppress_dropdown?: boolean;
  readonly show_input_message?: boolean;
  readonly prompt_title?: string;
  readonly prompt?: string;
  readonly show_error_message?: boolean;
  readonly error_title?: string;
  readonly error?: string;
  readonly error_style?: ValidationErrorStyle;
}

/** 把区域数组拼成 sqref，并逐个校验。@throws {ValidationError} */
export function buildSqref(ranges: readonly string[]): string {
  if (ranges.length === 0) {
    throw new ValidationError('数据验证的 ranges 不能为空（没有应用范围的规则没有意义）');
  }
  const parts = ranges.map((text) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ValidationError(`数据验证的 sqref 项非法：${JSON.stringify(text)}`);
    }
    parseRange(text); // 非法区域文本在此抛
    return text.trim();
  });
  return parts.join(' ');
}

/**
 * 内联下拉值 → OOXML `formula1` 文本（**含外层双引号**）。@throws {ValidationError} 值非法 / 超长
 */
export function buildInlineListFormula(values: readonly string[]): string {
  if (values.length === 0) {
    throw new ValidationError('内联下拉列表不能为空');
  }
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ValidationError('内联下拉列表的每一项都必须是非空字符串');
    }
    if (value.includes(',')) {
      throw new ValidationError(
        `内联下拉值 ${JSON.stringify(value)} 含逗号，无法在内联列表中表示（请改用区域引用的 formula1）`,
      );
    }
    if (value.includes('"')) {
      throw new ValidationError(`内联下拉值 ${JSON.stringify(value)} 含双引号，无法在内联列表中表示`);
    }
  }
  const text = `"${values.join(',')}"`;
  if (text.length > MAX_INLINE_LIST_LENGTH) {
    throw new ValidationError(
      `内联下拉列表长度 ${String(text.length)} 超过 Excel 上限 ${String(MAX_INLINE_LIST_LENGTH)}，不得静默截断`,
    );
  }
  return text;
}

/**
 * 校验规则形状（构造 / 序列化前都会调用；**不合法就抛，不产出半成品**）。
 * @throws {ValidationError}
 */
export function validateDataValidationRule(rule: DataValidationRule): void {
  buildSqref(rule.ranges);
  if (!KNOWN_TYPES.has(rule.type)) {
    throw new ValidationError(`未知的数据验证类型：${JSON.stringify(rule.type)}`);
  }
  if (!TYPES_WITH_OPERATOR.has(rule.type) && rule.operator !== undefined) {
    throw new ValidationError(`数据验证类型 ${rule.type} 不接受 operator（只有 whole / decimal / date / time / textLength 才带）`);
  }
  if (rule.type === 'none' && (rule.formula1 !== undefined || rule.list_values !== undefined)) {
    throw new ValidationError('type="none"（任意值）不接受 formula1 / list_values，只承载提示文案');
  }
  if (rule.operator !== undefined && OPERATORS_REQUIRING_BOUND.has(rule.operator) && rule.formula2 === undefined) {
    throw new ValidationError(`算子 ${rule.operator} 需要 formula2`);
  }
  if (rule.list_values !== undefined) {
    if (rule.type !== 'list') {
      throw new ValidationError('list_values 只对 type="list" 有意义');
    }
    if (rule.formula1 !== undefined) {
      throw new ValidationError('list_values 与 formula1 互斥：内联列表与区域引用只能二选一');
    }
    buildInlineListFormula(rule.list_values);
  }
  if (rule.type === 'list' && rule.list_values === undefined && rule.formula1 === undefined) {
    throw new ValidationError('type="list" 需要 list_values（内联）或 formula1（区域引用）');
  }
  if (TYPES_WITH_OPERATOR.has(rule.type) && rule.formula1 === undefined) {
    throw new ValidationError(`类型 ${rule.type} 需要 formula1`);
  }
  if (rule.type === 'custom' && rule.formula1 === undefined) {
    throw new ValidationError('type="custom" 需要 formula1（布尔表达式）');
  }
  if (rule.error_style !== undefined && rule.show_error_message !== true) {
    throw new ValidationError('error_style 只有在 show_error_message 为真时才有意义');
  }
}

/** 规则 → OOXML 属性（顺序即输出顺序；缺省项**不写**）。@throws {ValidationError} */
export function buildDataValidationAttributes(rule: DataValidationRule): readonly XmlAttribute[] {
  validateDataValidationRule(rule);
  const attributes: XmlAttribute[] = [attr('type', rule.type)];
  if (rule.operator !== undefined) attributes.push(attr('operator', rule.operator));
  attributes.push(attr('allowBlank', rule.allow_blank === true ? '1' : '0'));
  if (rule.suppress_dropdown === true) {
    // 只有 true 才写：这正是"想隐藏才写 1"的语义，缺省即显示
    attributes.push(attr('showDropDown', '1'));
  }
  attributes.push(attr('showInputMessage', rule.show_input_message === true ? '1' : '0'));
  attributes.push(attr('showErrorMessage', rule.show_error_message === true ? '1' : '0'));
  if (rule.error_style !== undefined) attributes.push(attr('errorStyle', rule.error_style));
  if (rule.error_title !== undefined) attributes.push(attr('errorTitle', rule.error_title));
  if (rule.error !== undefined) attributes.push(attr('error', rule.error));
  if (rule.prompt_title !== undefined) attributes.push(attr('promptTitle', rule.prompt_title));
  if (rule.prompt !== undefined) attributes.push(attr('prompt', rule.prompt));
  attributes.push(attr('sqref', buildSqref(rule.ranges)));
  return attributes;
}

/** 规则的公式子元素（`<formula1>` / `<formula2>`）。 */
function formulaChildren(rule: DataValidationRule): readonly XmlElement[] {
  const children: XmlElement[] = [];
  const first = rule.list_values === undefined ? rule.formula1 : buildInlineListFormula(rule.list_values);
  if (first !== undefined) children.push(el('formula1', [], [first]));
  if (rule.formula2 !== undefined) children.push(el('formula2', [], [rule.formula2]));
  return children;
}

/** 规则的 `<dataValidation>` 元素（**不带** `xmlns`：供程序化拼进工作表元素树）。@throws {ValidationError} */
export function buildDataValidationElement(rule: DataValidationRule): XmlElement {
  return el('dataValidation', buildDataValidationAttributes(rule), formulaChildren(rule));
}

/** 给根元素补上默认命名空间声明，使片段可**独立解析**（嵌进工作表时属合法冗余声明）。 */
function standalone(element: XmlElement): XmlElement {
  return el(element.name, [attr('xmlns', SPREADSHEETML_NAMESPACE), ...element.attributes], element.children);
}

/** 单条规则的 `<dataValidation>` 文本片段（自含命名空间，可独立读回）。@throws {ValidationError} */
export function buildDataValidationXml(rule: DataValidationRule): string {
  return serializeXmlNode(standalone(buildDataValidationElement(rule)));
}

/**
 * 多条规则 → `<dataValidations count="N">…</dataValidations>` 片段（自含命名空间）。
 *
 * **空数组返回 `null`**：宁可不写这个元素，也不写一个 `count="0"` 的空壳。
 * @throws {ValidationError} 任一条规则非法
 */
export function buildDataValidationsXml(rules: readonly DataValidationRule[]): string | null {
  if (rules.length === 0) return null;
  const elements = rules.map(buildDataValidationElement);
  return serializeXmlNode(standalone(el('dataValidations', [attr('count', String(rules.length))], elements)));
}

// ---------------------------------------------------------------------------
// 读回（XLS-11：真实 XML 往返的读侧对偶）
// ---------------------------------------------------------------------------

/** 取**无命名空间**属性的原始文本（OOXML 的非限定属性）。 */
function plainAttr(element: ParsedXmlElement, localName: string): string | null {
  return attributeValue(element, '', localName);
}

/** 布尔属性：`1`/`true` ⇒ true，`0`/`false`/缺失 ⇒ false（OOXML 用 1/0）。 */
function boolAttr(element: ParsedXmlElement, localName: string): boolean {
  const raw = plainAttr(element, localName);
  return raw === '1' || raw === 'true';
}

/** 解析内联列表公式 `"甲,乙"` → `['甲','乙']`；不是引号包围则返回 `null`。 */
function inlineListValues(formula1: string): readonly string[] | null {
  if (formula1.length < 2 || !formula1.startsWith('"') || !formula1.endsWith('"')) return null;
  return Object.freeze(formula1.slice(1, -1).split(','));
}

function childText(element: ParsedXmlElement, localName: string): string | null {
  const child = findChild(element, SPREADSHEETML_NAMESPACE, localName);
  return child === null ? null : directText(child);
}

function parseDataValidationElement(element: ParsedXmlElement): DataValidationRule {
  const sqref = plainAttr(element, 'sqref');
  if (sqref === null) {
    throw new ValidationError('dataValidation 缺少 sqref 属性');
  }
  const ranges = sqref.split(/\s+/).filter((part) => part.length > 0);
  // OOXML 的 type 缺省值是 "none"（任意值）——真实 Excel 对"只带输入提示"的验证会省略它
  const type = (plainAttr(element, 'type') ?? 'none') as ValidationType;
  const rule: { -readonly [K in keyof DataValidationRule]: DataValidationRule[K] } = { ranges, type };
  const operator = plainAttr(element, 'operator') as ValidationOperator | null;
  if (operator !== null) rule.operator = operator;
  if (boolAttr(element, 'allowBlank')) rule.allow_blank = true;
  if (boolAttr(element, 'showDropDown')) rule.suppress_dropdown = true;
  if (boolAttr(element, 'showInputMessage')) rule.show_input_message = true;
  if (boolAttr(element, 'showErrorMessage')) rule.show_error_message = true;
  const errorStyle = plainAttr(element, 'errorStyle') as ValidationErrorStyle | null;
  if (errorStyle !== null) rule.error_style = errorStyle;
  const errorTitle = plainAttr(element, 'errorTitle');
  if (errorTitle !== null) rule.error_title = errorTitle;
  const error = plainAttr(element, 'error');
  if (error !== null) rule.error = error;
  const promptTitle = plainAttr(element, 'promptTitle');
  if (promptTitle !== null) rule.prompt_title = promptTitle;
  const prompt = plainAttr(element, 'prompt');
  if (prompt !== null) rule.prompt = prompt;

  const formula1 = childText(element, 'formula1');
  if (formula1 !== null) {
    const inline = type === 'list' ? inlineListValues(formula1) : null;
    if (inline !== null) rule.list_values = inline;
    else rule.formula1 = formula1;
  }
  const formula2 = childText(element, 'formula2');
  if (formula2 !== null) rule.formula2 = formula2;

  validateDataValidationRule(rule); // 与写出侧同一把尺子：形状不对就抛，不产出半成品
  return Object.freeze(rule);
}

/**
 * `<dataValidations>`（或单条 `<dataValidation>`，或含它们的片段）→ 规则数组。@throws {ValidationError}
 *
 * 这是 {@link buildDataValidationsXml} 的读侧对偶：**写出去的字节能原样读回来**，
 * 且读回结果再次序列化与首次产出**逐字节相同**（见 `validation-roundtrip` 用例）。
 */
export function parseDataValidationsXml(xml: string): readonly DataValidationRule[] {
  const root = parseXml(xml);
  const container =
    root.localName === 'dataValidations'
      ? root
      : findChild(root, SPREADSHEETML_NAMESPACE, 'dataValidations');
  const source =
    container ??
    (root.localName === 'dataValidation' ? root : null);
  if (source === null) {
    throw new ValidationError('输入片段里没有 <dataValidations> / <dataValidation> 元素');
  }
  const elements =
    source.localName === 'dataValidation'
      ? [source]
      : childElements(source).filter(
          (child) => child.namespace === SPREADSHEETML_NAMESPACE && child.localName === 'dataValidation',
        );
  return Object.freeze(elements.map(parseDataValidationElement));
}
