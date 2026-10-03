/**
 * **最小 XML 读取器**（归属 WCF-D02）——`src/artifacts/ooxml/xml.ts` 的读侧对偶。
 *
 * ## 为什么自己写、不用现成库
 *
 * 1. **零新增依赖**：本仓的依赖只有 typescript / vitest / @types/node，新增运行时依赖要动
 *    `package.json`——那不在 D02 的写权范围内。
 * 2. **要的东西很窄**：只需要"元素树 + 属性（保序）+ 文本（保空白）+ 命名空间解析"，
 *    再加一个能把**未建模片段原样写回**的序列化器。
 * 3. **确定性**：输出顺序、转义规则、属性引号都与 `ooxml/xml.ts` 一致，避免"同一个值两种写法"。
 *
 * ## 保真的边界（说清楚，不含糊）
 *
 * 本读取器**不保真**的部分只有三样，且都不影响语义：
 * - 注释 / 处理指令 / DOCTYPE 在解析时**丢弃**（它们不是文档内容）。真实 Word 的 DOCX
 *   部件里这三样基本不出现；出现时丢弃它们改变的是"字节"，不是"文档"。
 * - 实体形式归一化（`&#65;` 与 `A` 解析后都是 `A`，再写回时按需要转义）。
 * - 属性引号统一为双引号。
 *
 * **真正影响语义的四样全部保留**：元素与子节点顺序、属性顺序、文本空白
 * （含 `xml:space="preserve"` 的原始字符，本读取器**从不**折叠空白）、命名空间绑定。
 */

import { escapeAttribute, escapeText } from '../../artifacts/ooxml/xml.js';

/** 预定义命名空间绑定（XML 规范规定，不需要声明即可使用）。 */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** 解析错误（带字符位置，便于定位到具体部件）。 */
export class XmlParseError extends Error {
  /** 出错处相对 XML 文本起点的字符偏移。 */
  readonly position: number;

  constructor(position: number, message: string) {
    super(`XML 解析失败（偏移 ${String(position)}）：${message}`);
    this.name = 'XmlParseError';
    this.position = position;
  }
}

/** 属性：名字**原样**（含前缀）+ 已解码的值。 */
export interface ParsedXmlAttribute {
  readonly name: string;
  readonly value: string;
}

/** 元素：名字、拆分后的前缀 / 本地名、解析出的命名空间 URI、属性（保序）、子节点（保序）。 */
export interface ParsedXmlElement {
  readonly kind: 'element';
  /** 原样名字（如 `w:p`、`mc:AlternateContent`）。 */
  readonly name: string;
  readonly prefix: string;
  readonly localName: string;
  /** 该元素自身名字解析到的命名空间 URI；无前缀且无默认命名空间时是 `''`。 */
  readonly namespace: string;
  readonly attributes: readonly ParsedXmlAttribute[];
  readonly children: readonly ParsedXmlNode[];
  /** **在作用域内**的前缀 → URI 绑定（继承链已合并）。 */
  readonly namespaces: Readonly<Record<string, string>>;
}

/** 文本节点：值已做实体解码，**空白原样**。 */
export interface ParsedXmlText {
  readonly kind: 'text';
  readonly value: string;
}

export type ParsedXmlNode = ParsedXmlElement | ParsedXmlText;

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

const ENTITY_PATTERN = /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

/** 实体解码：五个预定义实体 + 十进制 / 十六进制字符引用。未识别的实体**显式抛错**。 */
export function decodeEntities(text: string, position: number): string {
  return text.replace(ENTITY_PATTERN, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointFromNumber(Number.parseInt(body.slice(2), 16), whole, position);
    }
    if (body.startsWith('#')) {
      return codePointFromNumber(Number.parseInt(body.slice(1), 10), whole, position);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) {
      throw new XmlParseError(position, `未识别的实体引用 ${whole}（不做"猜一个"的降级）`);
    }
    return named;
  });
}

function codePointFromNumber(codePoint: number, whole: string, position: number): string {
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    throw new XmlParseError(position, `字符引用 ${whole} 的码位非法`);
  }
  return String.fromCodePoint(codePoint);
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;
const WHITESPACE = /[ \t\r\n]/;

class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  parseDocument(): ParsedXmlElement {
    // 根元素之前可能有 XML 声明、注释、DOCTYPE、处理指令（Word 的部件一定有声明）。
    this.skipMisc();
    const root = this.parseElement(ROOT_SCOPE);
    // 根元素之后只允许空白与杂项（注释 / PI）。有第二个根元素 ⇒ 不是合法 XML 文档。
    this.skipMisc();
    if (this.position !== this.source.length) {
      throw new XmlParseError(this.position, '根元素之后出现了额外内容（XML 文档只能有一个根元素）');
    }
    return root;
  }

  private parseElement(scope: Readonly<Record<string, string>>): ParsedXmlElement {
    this.expect('<');
    const name = this.readName();
    const attributes: ParsedXmlAttribute[] = [];
    const declarations: Record<string, string> = {};

    for (;;) {
      const before = this.position;
      this.skipWhitespace();
      const next = this.source[this.position];
      if (next === undefined) {
        throw new XmlParseError(this.position, `元素 <${name}> 的开始标签未闭合`);
      }
      if (next === '>' || next === '/') break;
      if (this.position === before) {
        throw new XmlParseError(this.position, `元素 <${name}> 的属性之间缺少空白`);
      }
      const attributeName = this.readName();
      this.skipWhitespace();
      this.expect('=');
      this.skipWhitespace();
      const value = decodeEntities(this.readQuotedValue(), this.position);
      attributes.push({ name: attributeName, value });
      if (attributeName === 'xmlns') {
        declarations[''] = value;
      } else if (attributeName.startsWith('xmlns:')) {
        declarations[attributeName.slice('xmlns:'.length)] = value;
      }
    }

    const namespaces =
      Object.keys(declarations).length === 0 ? scope : { ...scope, ...declarations };
    const { prefix, localName } = splitName(name);
    const namespace = namespaces[prefix] ?? '';

    if (this.source[this.position] === '/') {
      this.position += 1;
      this.expect('>');
      return { kind: 'element', name, prefix, localName, namespace, attributes, children: [], namespaces };
    }
    this.expect('>');

    const children: ParsedXmlNode[] = [];
    for (;;) {
      if (this.position >= this.source.length) {
        throw new XmlParseError(this.position, `元素 <${name}> 没有对应的结束标签`);
      }
      const character = this.source[this.position] as string;
      if (character === '<') {
        const following = this.source[this.position + 1];
        if (following === '/') {
          this.position += 2;
          const closing = this.readName();
          this.skipWhitespace();
          this.expect('>');
          if (closing !== name) {
            throw new XmlParseError(
              this.position,
              `结束标签 </${closing}> 与开始标签 <${name}> 不匹配`,
            );
          }
          return { kind: 'element', name, prefix, localName, namespace, attributes, children, namespaces };
        }
        if (following === '!') {
          const consumed = this.tryConsumeMiscOrCdata();
          if (consumed !== null) {
            if (consumed !== '') children.push({ kind: 'text', value: consumed });
            continue;
          }
        }
        if (following === '?') {
          this.skipProcessingInstruction();
          continue;
        }
        children.push(this.parseElement(namespaces));
        continue;
      }
      const textStart = this.position;
      while (this.position < this.source.length && this.source[this.position] !== '<') {
        this.position += 1;
      }
      const raw = this.source.slice(textStart, this.position);
      children.push({ kind: 'text', value: decodeEntities(raw, textStart) });
    }
  }

  /**
   * 处理 `<!…>`：注释 / DOCTYPE 丢弃（返回 `''`），CDATA 返回其字面内容。
   * 返回 `null` 表示不是可识别的 `<!` 结构。
   */
  private tryConsumeMiscOrCdata(): string | null {
    if (this.source.startsWith('<!--', this.position)) {
      const end = this.source.indexOf('-->', this.position + 4);
      if (end === -1) throw new XmlParseError(this.position, '注释未闭合');
      this.position = end + 3;
      return '';
    }
    if (this.source.startsWith('<![CDATA[', this.position)) {
      const end = this.source.indexOf(']]>', this.position + 9);
      if (end === -1) throw new XmlParseError(this.position, 'CDATA 段未闭合');
      const content = this.source.slice(this.position + 9, end);
      this.position = end + 3;
      return content;
    }
    if (this.source.startsWith('<!DOCTYPE', this.position)) {
      const end = this.source.indexOf('>', this.position);
      if (end === -1) throw new XmlParseError(this.position, 'DOCTYPE 未闭合');
      this.position = end + 1;
      return '';
    }
    return null;
  }

  private skipProcessingInstruction(): void {
    const end = this.source.indexOf('?>', this.position);
    if (end === -1) throw new XmlParseError(this.position, '处理指令未闭合');
    this.position = end + 2;
  }

  /** 跳过根元素前后的空白、注释、处理指令与 DOCTYPE。 */
  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.source.startsWith('<?', this.position)) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.source.startsWith('<!', this.position)) {
        const consumed = this.tryConsumeMiscOrCdata();
        if (consumed !== null) continue;
      }
      return;
    }
  }

  private skipWhitespace(): void {
    while (this.position < this.source.length && WHITESPACE.test(this.source[this.position] as string)) {
      this.position += 1;
    }
  }

  private readName(): string {
    const start = this.position;
    const first = this.source[this.position];
    if (first === undefined || !NAME_START.test(first)) {
      throw new XmlParseError(this.position, `期望一个 XML 名字，实际看到 ${JSON.stringify(first ?? '')}`);
    }
    this.position += 1;
    while (this.position < this.source.length && NAME_CHAR.test(this.source[this.position] as string)) {
      this.position += 1;
    }
    return this.source.slice(start, this.position);
  }

  private readQuotedValue(): string {
    const quote = this.source[this.position];
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseError(this.position, '属性值必须用引号包起来');
    }
    const end = this.source.indexOf(quote, this.position + 1);
    if (end === -1) throw new XmlParseError(this.position, '属性值缺少结束引号');
    const value = this.source.slice(this.position + 1, end);
    this.position = end + 1;
    return value;
  }

  private expect(character: string): void {
    if (this.source[this.position] !== character) {
      throw new XmlParseError(
        this.position,
        `期望 ${JSON.stringify(character)}，实际看到 ${JSON.stringify(this.source[this.position] ?? '<流末尾>')}`,
      );
    }
    this.position += 1;
  }
}

const ROOT_SCOPE: Readonly<Record<string, string>> = Object.freeze({
  xml: XML_NAMESPACE,
  xmlns: XMLNS_NAMESPACE,
});

function splitName(name: string): { prefix: string; localName: string } {
  const colon = name.indexOf(':');
  return colon === -1
    ? { prefix: '', localName: name }
    : { prefix: name.slice(0, colon), localName: name.slice(colon + 1) };
}

/** 解析 XML 文本。返回根元素。 */
export function parseXml(xml: string): ParsedXmlElement {
  return new Parser(xml).parseDocument();
}

/** 解析 XML 字节（按 UTF-8；**不剥离 BOM**——BOM 会作为文本节点出现在根元素之前，
 *  由 `skipMisc` 前的空白跳过逻辑处理，因此带 BOM 的部件同样能读进来）。 */
export function parseXmlBytes(bytes: Uint8Array): ParsedXmlElement {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // UTF-8 BOM（U+FEFF）不是内容：剥掉再解析，避免它变成根元素前的一个文本节点。
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  return parseXml(text);
}

// ---------------------------------------------------------------------------
// 序列化（把未建模片段原样写回）
// ---------------------------------------------------------------------------

/** 序列化一个节点（不含 XML 声明）。转义规则与 `ooxml/xml.ts` 一致。 */
export function serializeParsedXmlNode(node: ParsedXmlNode): string {
  if (node.kind === 'text') return escapeText(node.value);
  const attributes = node.attributes
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join('');
  if (node.children.length === 0) return `<${node.name}${attributes}/>`;
  const inner = node.children.map((child) => serializeParsedXmlNode(child)).join('');
  return `<${node.name}${attributes}>${inner}</${node.name}>`;
}

// ---------------------------------------------------------------------------
// 查询助手（命名空间感知）
// ---------------------------------------------------------------------------

/** 子**元素**（忽略文本节点；`w:p` 之间的排版空白不会混进来）。 */
export function childElements(element: ParsedXmlElement): readonly ParsedXmlElement[] {
  return element.children.filter((child): child is ParsedXmlElement => child.kind === 'element');
}

/**
 * 直接子元素里第一个 `{namespace}localName`；没有（或**父元素本身就是 `null`**）则 `null`。
 *
 * 接受 `null` 父元素是刻意的：`findChild(findChild(p, …), …)` 这种"可选链"是 OOXML 解析里
 * 最常见的形状（`w:pPr/w:spacing` 两层都可能不存在），让调用方到处写判空只会淹没真正的分支。
 */
export function findChild(
  element: ParsedXmlElement | null,
  namespace: string,
  localName: string,
): ParsedXmlElement | null {
  if (element === null) return null;
  for (const child of childElements(element)) {
    if (child.namespace === namespace && child.localName === localName) return child;
  }
  return null;
}

/** 直接子元素里全部 `{namespace}localName`（保序）；父元素为 `null` 时返回空数组。 */
export function findChildren(
  element: ParsedXmlElement | null,
  namespace: string,
  localName: string,
): readonly ParsedXmlElement[] {
  if (element === null) return [];
  return childElements(element).filter(
    (child) => child.namespace === namespace && child.localName === localName,
  );
}

/** 属性解析：属性前缀按元素作用域解析；无前缀的属性**没有命名空间**（XML 规范）。 */
function attributeNamespace(element: ParsedXmlElement, attributeName: string): string {
  const { prefix } = splitName(attributeName);
  if (prefix === '') return '';
  return element.namespaces[prefix] ?? '';
}

/** 取 `{namespace}localName` 属性的值；没有该属性返回 `null`。 */
export function attributeValue(
  element: ParsedXmlElement,
  namespace: string,
  localName: string,
): string | null {
  for (const attribute of element.attributes) {
    if (splitName(attribute.name).localName !== localName) continue;
    if (attributeNamespace(element, attribute.name) !== namespace) continue;
    return attribute.value;
  }
  return null;
}

/** 是否存在 `{namespace}localName` 属性（值无关）。 */
export function hasAttribute(
  element: ParsedXmlElement,
  namespace: string,
  localName: string,
): boolean {
  return attributeValue(element, namespace, localName) !== null;
}

/** 元素下所有文本子节点的拼接（**不递归**：OOXML 的 `w:t` 只放直接文本）。 */
export function directText(element: ParsedXmlElement): string {
  let text = '';
  for (const child of element.children) {
    if (child.kind === 'text') text += child.value;
  }
  return text;
}
