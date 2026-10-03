/**
 * 确定性 XML 写入器（归属 W-A）——只做"把显式结构写成固定字节"，不做任何推测。
 *
 * ## 为什么不能直接用现成 XML 库 / 模板字符串
 * 容器字节要能**逐字节复现**（design-02 的核心判据 J8：同场景跑两次摘要相等）。任何"按对象
 * 键序输出属性""按平台换行""按本地化规则格式化数字"的做法都会让同一语义产出不同字节，
 * 于是摘要比对失去意义。本文件把三件事钉死：
 *
 * 1. **属性顺序 = 显式传入顺序**（`readonly XmlAttribute[]`，绝不用 `Record<string,string>`，
 *    因为对象键序取决于构造顺序，而 OOXML 的 `xmlns:*` 又必须排在最前）。
 * 2. **文本/属性的转义规则固定**，且**不产生 BOM**；换行一律 `\n`（不随平台）。
 * 3. **数字只走定点/整数格式化**（`formatInteger` / `formatDecimal`），实现基于
 *    ECMAScript 规范定义的 `Number.prototype.toString()` 十进制展开 + BigInt 进位，
 *    **不经 `toLocaleString()`，也不经 `toFixed()`**（后者对中值/边界的舍入行为不在这里依赖）。
 *
 * ## 不做的事
 * - **不缩进、不换行排版**：XML 里空白是内容（`<w:t>` 里的空格会被 Word 原样显示），
 *   任何"美化输出"都会改变语义。本模块只在 XML 声明与根元素之间加一个 `\n`。
 * - **不校验元素名对应的 OOXML 模式**：只做"是不是合法 XML 名"的字符级检查。
 * - **不自动补命名空间**：`xmlns` 就是普通属性，由调用方按显式顺序声明。
 */

/** 固定 XML 声明（`\n` 之前的部分；序列化文档时其后跟一个 `\n`）。 */
export const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** 文档级序列化时，声明与根元素之间的换行符（固定 `\n`，不随平台）。 */
export const XML_NEWLINE = '\n';

/** XML 名（元素名/属性名）的字符级白名单：`w:p`、`mc:AlternateContent`、`xmlns:w` 均合法。 */
const XML_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export type XmlErrorReason =
  | 'invalid_name'
  | 'invalid_attribute'
  | 'not_an_integer'
  | 'not_finite'
  | 'invalid_scale';

export class XmlError extends Error {
  readonly reason: XmlErrorReason;

  constructor(reason: XmlErrorReason, message: string) {
    super(message);
    this.name = 'XmlError';
    this.reason = reason;
  }
}

/** 一个属性：名字 + 值。顺序由数组顺序决定，**没有任何隐式排序**。 */
export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
}

/** 一个元素：名字 + 显式有序属性 + 显式子节点。文本节点直接用 `string` 表示。 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
}

/** 节点 = 元素 | 文本。 */
export type XmlNode = XmlElement | string;

/** 构造属性（`el(...)` 的第二个参数按给定顺序逐个传入即可）。 */
export function attr(name: string, value: string): XmlAttribute {
  if (!XML_NAME_PATTERN.test(name)) {
    throw new XmlError('invalid_name', `非法 XML 属性名：${JSON.stringify(name)}`);
  }
  return { name, value };
}

/**
 * 构造元素。
 *
 * @param name      元素名（可带前缀，如 `w:p`）。
 * @param attributes 属性数组，**输出顺序 = 本数组顺序**。
 * @param children  子节点数组，**输出顺序 = 本数组顺序**；`string` 视为文本节点。
 *                  空数组 ⇒ 自闭合 `<name/>`；非空 ⇒ `<name>…</name>`（即使是空文本节点也一样，
 *                  因此"要不要自闭合"完全由调用方通过 `children` 决定，不存在隐式判断）。
 */
export function el(
  name: string,
  attributes: readonly XmlAttribute[] = [],
  children: readonly XmlNode[] = [],
): XmlElement {
  if (!XML_NAME_PATTERN.test(name)) {
    throw new XmlError('invalid_name', `非法 XML 元素名：${JSON.stringify(name)}`);
  }
  return { name, attributes, children };
}

const TEXT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
]);

const ATTRIBUTE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
  // 空白若以字面量出现在属性值里，XML 解析器会做属性值规范化（换行/制表符→空格），
  // 逐字节写下去就等于"写的时候是这样、读回来是别的"。转成字符引用可原样往返。
  ['\n', '&#10;'],
  ['\r', '&#13;'],
  ['\t', '&#9;'],
]);

/** 文本节点转义：`&` `<` `>`（文本里不需要转义引号，就不转，减少无谓差异）。 */
export function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (ch) => TEXT_ESCAPES.get(ch) as string);
}

/** 属性值转义：`&` `<` `>` `"` `'` + 回车/换行/制表符（字符引用）。 */
export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"'\n\r\t]/g, (ch) => ATTRIBUTE_ESCAPES.get(ch) as string);
}

/**
 * 序列化单个节点（不含 XML 声明）。
 * 无缩进、无额外空白、换行固定 `\n`——除文本节点自身的字符外不写入任何字节。
 */
export function serializeXmlNode(node: XmlNode): string {
  if (typeof node === 'string') return escapeText(node);

  const attributes = node.attributes
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join('');

  if (node.children.length === 0) return `<${node.name}${attributes}/>`;

  const inner = node.children.map((child) => serializeXmlNode(child)).join('');
  return `<${node.name}${attributes}>${inner}</${node.name}>`;
}

/** 序列化完整 OPC 部件：声明 + `\n` + 根元素（无 BOM，末尾无额外换行）。 */
export function serializeXmlDocument(root: XmlElement): string {
  return `${XML_DECLARATION}${XML_NEWLINE}${serializeXmlNode(root)}`;
}

/**
 * 文本 → UTF-8 字节。`TextEncoder` **从不写 BOM**（这是"任何部件不得有 BOM"的结构性保证：
 * 本仓没有任何一处走 `'utf8' + BOM` 的路径）。
 */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 整数格式化：安全整数 → 十进制字符串。
 * 非安全整数（含小数、`NaN`、`Infinity`、超出 ±2^53）一律**显式抛错**，不静默截断。
 */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) {
    throw new XmlError('not_finite', `整数格式化收到非有限数：${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new XmlError('not_an_integer', `整数格式化收到非安全整数：${String(value)}`);
  }
  // Number.prototype.toString(10) 的输出由规范完整定义，与 locale / 平台无关。
  return String(value);
}

/**
 * 定点小数格式化：`value` 按 `scale` 位小数输出，**四舍五入远离零**（half away from zero），
 * 结果**恰好** `scale` 位小数（不足补零）。
 *
 * 实现要点：先把 `value` 用 `toString()` 展开成精确十进制字符串（`Number::toString` 给出
 * 最短可往返表示，规范定义、非本地化），再交给 `BigInt` 做字符串级进位——**全程没有浮点乘除**，
 * 因此 `formatDecimal(2.675, 2)` 得到 `'2.68'`（按字面十进制展开判定），不会因二进制表示
 * 的误差漂移成 `'2.67'` 或 `'2.6750000000000003'`。
 *
 * @param value 有限数字。
 * @param scale 小数位数，`0` … `20` 的整数（0 即"定点整数"）。
 */
export function formatDecimal(value: number, scale: number): string {
  if (!Number.isFinite(value)) {
    throw new XmlError('not_finite', `定点格式化收到非有限数：${String(value)}`);
  }
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 20) {
    throw new XmlError('invalid_scale', `小数位数必须是 0…20 的整数，收到：${String(scale)}`);
  }

  const negative = value < 0;
  const scaled = scaleDecimal(Math.abs(value), scale).toString();
  const padded = scaled.padStart(scale + 1, '0');
  const splitAt = padded.length - scale;
  const integerPart = padded.slice(0, splitAt);
  const fractionPart = padded.slice(splitAt);
  const sign = negative && /[1-9]/.test(padded) ? '-' : '';

  return scale === 0 ? `${sign}${integerPart}` : `${sign}${integerPart}.${fractionPart}`;
}

/**
 * 把非负有限数 `value` 精确展开成十进制数字串，并缩放到 `scale` 位（half away from zero）。
 * 返回整数（已含全部小数位），例如 `scaleDecimal(2.675, 2) === 268n`。
 */
function scaleDecimal(value: number, scale: number): bigint {
  const plain = expandPlainDecimal(value);
  const dot = plain.indexOf('.');
  const integerPart = dot === -1 ? plain : plain.slice(0, dot);
  const fractionPart = dot === -1 ? '' : plain.slice(dot + 1);

  if (fractionPart.length <= scale) {
    return BigInt(integerPart + fractionPart.padEnd(scale, '0'));
  }

  const kept = fractionPart.slice(0, scale);
  const dropped = fractionPart.slice(scale);
  const truncated = BigInt(integerPart + kept);
  // 半值进位：被丢弃的第一位 ≥ 5 即进位（远离零）。
  return (dropped.charCodeAt(0) >= 0x35 ? truncated + 1n : truncated);
}

/**
 * 把非负数转成"无指数"的十进制字符串（`1e+21` → `1000000000000000000000`）。
 * 输入必须是非负有限数（调用方已保证）。
 */
function expandPlainDecimal(value: number): string {
  const text = value.toString();
  if (!/[eE]/.test(text)) return text;

  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (match === null) {
    // 理论上不可达：非负有限数的 toString 只会是定点或 `d(.d)?e±d` 两种形态。
    throw new XmlError('not_finite', `无法展开的十进制表示：${JSON.stringify(text)}`);
  }
  const integerDigits = match[1] as string;
  const fractionDigits = match[2] ?? '';
  const exponent = Number(match[3] as string);
  const digits = integerDigits + fractionDigits;
  const pointAt = integerDigits.length + exponent;

  if (pointAt <= 0) return `0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return digits + '0'.repeat(pointAt - digits.length);
  return `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}
