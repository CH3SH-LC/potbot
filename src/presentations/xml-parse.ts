/**
 * 演示域专用的**最小 XML 读取器**（design-06 P9；服务 PPT-01「导入 PPTX」/ PPT-03「保留」/ PPT-14「导入后改指定对象」）。
 *
 * ## 为什么需要它
 *
 * `import.ts` 的部件级保留原语（`openPresentation` / `savePresentation`）把**部件**当作不透明字节，
 * 这足以满足「未列出的部件逐字节写回」。但 PPT-14 还要求「导入既有文件后**仍能改指定对象**」——
 * 要改对象，就必须**读懂**那一页的 XML，把它变成 `model.ts` 的对象图。
 * 本模块只负责"把 XML 文本变成一棵树"，**不含任何 PPT 语义**（语义在 `roundtrip.ts`）。
 *
 * ## 为什么不用正则
 *
 * FA-F 的导入层用文本级扫描定位幻灯片部件路径，那是**包结构**层面的定位，够用且不解析内容。
 * 但一旦要读 `a:t`、`a:rPr`、`a:xfrm` 这些**嵌套且同名前缀会变**的内容，
 * 正则就会把"没匹配上"变成"静默当成空"——正是本项目禁止的静默降级。
 * 本模块因此做**真正的解析**：解析不了 ⇒ 抛 `XmlParseError`，绝不返回半个树。
 *
 * ## 已知边界（**失败即抛错**，不静默）
 *
 * - 只做解析，**不做**命名空间解析：元素名按**限定名原样**（`p:sld`、`a:t`）匹配。
 *   前缀被改写过的文件会在语义层匹配不到目标元素而报错，**不会**被当成空内容。
 * - 不处理 DOCTYPE 与内部实体声明（OOXML 部件里没有；遇到当作普通文本，由上层拒绝）。
 * - 不做规范化：属性顺序、命名空间声明都**原样保留**在树上（写回不经过本模块，见 `roundtrip.ts`）。
 */

/** 解析失败的原因（供用例断言；全部是**具名**失败面）。 */
export type XmlParseErrorReason =
  | 'unexpected_end_of_input'
  | 'malformed_tag'
  | 'unexpected_close'
  | 'unclosed_element'
  | 'misplaced_text'
  | 'malformed_attribute';

/** 解析错误：**失败即抛错**，不返回部分结果。 */
export class XmlParseError extends Error {
  readonly reason: XmlParseErrorReason;

  constructor(reason: XmlParseErrorReason, message: string) {
    super(message);
    this.name = 'XmlParseError';
    this.reason = reason;
  }
}

/** 元素节点。子节点顺序 = 文档顺序（文本节点与元素节点混排）。 */
export interface XmlElementNode {
  readonly kind: 'element';
  /** 限定名（含前缀），如 `p:sld`。 */
  readonly name: string;
  /** 属性名 → 属性值（已解引用字符引用），顺序无关。 */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
}

/** 文本节点。 */
export interface XmlTextNode {
  readonly kind: 'text';
  readonly text: string;
}

export type XmlNode = XmlElementNode | XmlTextNode;

// ---------------------------------------------------------------------------
// 字符引用
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

const ENTITY_PATTERN = /&(#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g;

/**
 * 解引用字符引用。
 *
 * 与 `ooxml/xml.ts` 的 `escapeText` / `escapeAttribute` **互为逆运算**：
 * 那是"写"的一侧，这是"读"的一侧——两边都由本仓维护，因此往返是闭合的。
 * 认不出的 `&xxx;` **原样保留**（不猜测、不吞掉），避免把内容悄悄改掉。
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES.get(body) ?? whole;
  });
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isNameChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === ':' ||
    ch === '-' ||
    ch === '.'
  );
}

/** 可变的在建元素（冻结后才对外暴露）。 */
interface PendingElement {
  readonly name: string;
  readonly attributes: Map<string, string>;
  readonly children: XmlNode[];
}

class XmlReader {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private fail(reason: XmlParseErrorReason, message: string): never {
    throw new XmlParseError(reason, `${message}（偏移 ${String(this.index)}）`);
  }

  private skipUntil(marker: string): void {
    const end = this.text.indexOf(marker, this.index);
    if (end < 0) {
      this.fail('unexpected_end_of_input', `注释 / 处理指令没有结束标记 ${marker}`);
    }
    this.index = end + marker.length;
  }

  /** 找到当前开始标签的 `>`（跳过属性值里的引号，含引号内的 `>`）。 */
  private findTagEnd(from: number): number {
    let quote: string | null = null;
    for (let i = from; i < this.text.length; i += 1) {
      const ch = this.text.charAt(i);
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '>') return i;
    }
    return -1;
  }

  /** 解析一个开始标签（`<` 已在 `this.index`）：返回名字、属性与是否自闭合。 */
  private readStartTag(): { name: string; attributes: Map<string, string>; selfClosing: boolean } {
    const end = this.findTagEnd(this.index);
    if (end < 0) {
      this.fail('unexpected_end_of_input', '开始标签没有结束的 >');
    }
    let cursor = this.index + 1;
    const nameStart = cursor;
    while (cursor < end && isNameChar(this.text.charAt(cursor))) cursor += 1;
    const name = this.text.slice(nameStart, cursor);
    if (name === '') {
      this.fail('malformed_tag', '标签没有名字');
    }

    const attributes = new Map<string, string>();
    while (cursor < end) {
      while (cursor < end && isWhitespace(this.text.charAt(cursor))) cursor += 1;
      if (cursor >= end) break;
      if (this.text.charAt(cursor) === '/') {
        cursor += 1;
        continue;
      }
      const attrStart = cursor;
      while (cursor < end && isNameChar(this.text.charAt(cursor))) cursor += 1;
      const attrName = this.text.slice(attrStart, cursor);
      if (attrName === '') {
        this.fail('malformed_attribute', `属性位置出现无法解析的字符 ${this.text.charAt(cursor)}`);
      }
      while (cursor < end && isWhitespace(this.text.charAt(cursor))) cursor += 1;
      if (this.text.charAt(cursor) !== '=') {
        this.fail('malformed_attribute', `属性 ${attrName} 没有取值`);
      }
      cursor += 1;
      while (cursor < end && isWhitespace(this.text.charAt(cursor))) cursor += 1;
      const quote = this.text.charAt(cursor);
      if (quote !== '"' && quote !== "'") {
        this.fail('malformed_attribute', `属性 ${attrName} 的取值没有引号`);
      }
      cursor += 1;
      const valueStart = cursor;
      while (cursor < end && this.text.charAt(cursor) !== quote) cursor += 1;
      if (cursor >= end) {
        this.fail('malformed_attribute', `属性 ${attrName} 的引号没有闭合`);
      }
      attributes.set(attrName, decodeEntities(this.text.slice(valueStart, cursor)));
      cursor += 1;
    }

    const selfClosing = this.text.slice(this.index, end).trimEnd().endsWith('/');
    this.index = end + 1;
    return { name, attributes, selfClosing };
  }

  private appendText(stack: readonly PendingElement[], raw: string): void {
    if (raw === '') return;
    const top = stack[stack.length - 1];
    if (top === undefined) {
      if (raw.trim() !== '') {
        this.fail('misplaced_text', '根元素之外出现了非空白文本');
      }
      return;
    }
    top.children.push({ kind: 'text', text: decodeEntities(raw) });
  }

  /** 解析整篇文档，返回根元素。 */
  parse(): XmlElementNode {
    const stack: PendingElement[] = [];
    let root: XmlElementNode | null = null;

    while (this.index < this.text.length) {
      const lt = this.text.indexOf('<', this.index);
      if (lt < 0) {
        this.appendText(stack, this.text.slice(this.index));
        break;
      }
      this.appendText(stack, this.text.slice(this.index, lt));
      this.index = lt;

      if (this.text.startsWith('<?', this.index)) {
        this.skipUntil('?>');
        continue;
      }
      if (this.text.startsWith('<!--', this.index)) {
        this.skipUntil('-->');
        continue;
      }
      if (this.text.startsWith('<![CDATA[', this.index)) {
        const end = this.text.indexOf(']]>', this.index);
        if (end < 0) {
          this.fail('unexpected_end_of_input', 'CDATA 段没有结束标记 ]]>');
        }
        this.appendText(stack, this.text.slice(this.index + 9, end));
        this.index = end + 3;
        continue;
      }
      if (this.text.startsWith('</', this.index)) {
        const end = this.text.indexOf('>', this.index);
        if (end < 0) {
          this.fail('unexpected_end_of_input', '结束标签没有 >');
        }
        const name = this.text.slice(this.index + 2, end).trim();
        const open = stack.pop();
        if (open === undefined || open.name !== name) {
          this.fail(
            'unexpected_close',
            `结束标签 </${name}> 与开始标签 <${open?.name ?? '(无)'}> 不配对`,
          );
        }
        this.index = end + 1;
        const closed: XmlElementNode = {
          kind: 'element',
          name: open.name,
          attributes: open.attributes,
          children: open.children,
        };
        const parent = stack[stack.length - 1];
        if (parent === undefined) {
          if (root !== null) {
            this.fail('malformed_tag', '文档里有多个根元素');
          }
          root = closed;
        } else {
          parent.children.push(closed);
        }
        continue;
      }

      const start = this.readStartTag();
      if (start.selfClosing) {
        const element: XmlElementNode = {
          kind: 'element',
          name: start.name,
          attributes: start.attributes,
          children: [],
        };
        const parent = stack[stack.length - 1];
        if (parent === undefined) {
          if (root !== null) {
            this.fail('malformed_tag', '文档里有多个根元素');
          }
          root = element;
        } else {
          parent.children.push(element);
        }
      } else {
        stack.push({ name: start.name, attributes: start.attributes, children: [] });
      }
    }

    if (stack.length > 0) {
      const open = stack[stack.length - 1];
      this.fail('unclosed_element', `元素 <${open?.name ?? '(未知)'}> 没有闭合`);
    }
    if (root === null) {
      this.fail('malformed_tag', '文档里没有根元素');
    }
    return root;
  }
}

/** 解析一份 XML 部件文本，返回根元素。解析不了 ⇒ 抛 `XmlParseError`。 */
export function parseXmlDocument(text: string): XmlElementNode {
  return new XmlReader(text).parse();
}

// ---------------------------------------------------------------------------
// 查询工具（所有调用点都**按限定名精确匹配**）
// ---------------------------------------------------------------------------

/** 某元素的子元素（可按限定名过滤），保持文档顺序。`node` 缺省 ⇒ 空列表。 */
export function childElements(node: XmlElementNode | undefined, name?: string): readonly XmlElementNode[] {
  if (node === undefined) return [];
  const elements: XmlElementNode[] = [];
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    if (name === undefined || child.name === name) elements.push(child);
  }
  return elements;
}

/** 第一个匹配的子元素；没有则 `undefined`。 */
export function firstElement(node: XmlElementNode | undefined, name: string): XmlElementNode | undefined {
  return node === undefined ? undefined : childElements(node, name)[0];
}

/** 属性值；没有该属性则 `undefined`（**不返回空串**，空串是合法取值）。 */
export function attributeOf(node: XmlElementNode | undefined, name: string): string | undefined {
  return node?.attributes.get(name);
}

/** 元素内全部文本节点拼接（含子元素内的文本）。 */
export function textContentOf(node: XmlElementNode): string {
  let text = '';
  for (const child of node.children) {
    text += child.kind === 'text' ? child.text : textContentOf(child);
  }
  return text;
}

// ---------------------------------------------------------------------------
// 内联块定位（schema 位置）与关系枚举（重开既有文件的读取器 seam）
// ---------------------------------------------------------------------------
//
// 下面两个辅助是给「重开既有文件」的读取器用的（P-I02 读回接线）：
// - `locateInlineChildBlock`：在**直接子元素**这一层按限定名定位内联块（如 CT_Slide 里的
//   `p:timing`，它按 schema 排在 `p:clrMapOvr` / `p:transition` 之后），并按调用方给出的
//   schema 顺序**报告**该块所在父元素是否出现逆序（报告，不静默丢弃、不猜测）；
// - `enumerateRelationships` / `relationshipOrderReport`：把 OPC 关系部件
//   （`Relationships/Relationship`）按**文档顺序**枚举 / 复算，供读取器稳定比对。
//
// 两者都**只读树、只新增导出**：既有 `parseXmlDocument` / `childElements` / `firstElement` /
// `attributeOf` / `textContentOf` 的行为与返回值一字未改，既有调用点不受影响。

/** 一个内联（直接子）块的 schema 位置快照。 */
export interface InlineBlockPosition {
  /** 命中的直接子元素本体。 */
  readonly node: XmlElementNode;
  /** 在**直接子元素**序列里的下标（0 起，文档顺序；文本节点不计）。 */
  readonly elementIndex: number;
  /** `schemaOrder` 里的下标；不在其中 ⇒ `-1`。 */
  readonly schemaIndex: number;
  /** 该名字是否在 `schemaOrder` 里声明过。 */
  readonly declared: boolean;
  /** 排在该块之前的直接子元素名（文档顺序）。 */
  readonly precedingElementNames: readonly string[];
  /**
   * 父元素直接子元素里，凡按 `schemaOrder` 检查出现**逆序**的名字（文档顺序）。
   *
   * 位置校验是**父元素级**的：与目标块无关的逆序也会被列出——因此"找到了块"与
   * "块的邻居是合法顺序"是两件独立的事，调用方都能看到（不把位置问题吞进"找不到"）。
   */
  readonly orderViolations: readonly string[];
}

/**
 * 在 `parent` 的**直接子元素**里按限定名定位内联块，并用 `schemaOrder` 校验其位置。
 *
 * - **只看一层**：不递归。`p:timing` 出现在更深层（如被包在别的元素里）时**不会**被误命中，
 *   这正是「内联块」的定义——顺手在深树里捞同名元素会把"该有的块没了"变成"捞到个别的"。
 * - `schemaOrder` 是该父元素允许的直接子元素名按 schema 的**完整有序**列表（如 CT_Slide 的
 *   `['p:cSld', 'p:clrMapOvr', 'p:transition', 'p:timing', 'p:extLst']`）。
 * - 命中 ⇒ 返回位置快照；名字不在 `schemaOrder` 里 ⇒ 仍返回快照但 `declared=false`（如实报告，
 *   不抛错——某些扩展块本就不在主序列里）。
 * - 该名字下没有直接子元素 ⇒ `undefined`（"这页没有这个块"是合法状态，不是解析失败）。
 */
export function locateInlineChildBlock(
  parent: XmlElementNode | undefined,
  name: string,
  schemaOrder: readonly string[],
): InlineBlockPosition | undefined {
  if (parent === undefined) return undefined;
  const siblings = childElements(parent);
  const elementIndex = siblings.findIndex((child) => child.name === name);
  if (elementIndex < 0) return undefined;
  const node = siblings[elementIndex] as XmlElementNode;

  // 文档顺序里"在 schemaOrder 内"的兄弟，其 schema 序号构成一条序列；出现下降即逆序，
  // 记下降点的元素名（确定性：按文档顺序，重复出现各记一次）。
  const orderViolations: string[] = [];
  let previousIndex = -1;
  for (const sibling of siblings) {
    const index = schemaOrder.indexOf(sibling.name);
    if (index < 0) continue;
    if (previousIndex >= 0 && index < previousIndex) orderViolations.push(sibling.name);
    previousIndex = index;
  }

  const schemaIndex = schemaOrder.indexOf(name);
  return {
    node,
    elementIndex,
    schemaIndex,
    declared: schemaIndex >= 0,
    precedingElementNames: siblings.slice(0, elementIndex).map((sibling) => sibling.name),
    orderViolations,
  };
}

/** 限定名去前缀后的本地名（`pr:Relationship` → `Relationship`；无前缀原样返回）。 */
function localNameOf(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

const RELATIONSHIP_ELEMENT = 'Relationship';

/** 一条 OPC 关系（关系部件里一个 `Relationship` 元素）在文档顺序里的快照。 */
export interface RelationshipEntry {
  /** 在 `Relationship` 兄弟序列里的下标（0 起，文档顺序）。 */
  readonly index: number;
  readonly node: XmlElementNode;
  /** `Id` 属性；缺失 ⇒ `undefined`（不编造）。 */
  readonly id: string | undefined;
  /** `Type` 属性。 */
  readonly type: string | undefined;
  /** `Target` 属性原样（**不**解引用成包内路径；那是调用方按自身部件位置做的换算）。 */
  readonly target: string | undefined;
  /** `TargetMode` 属性。 */
  readonly targetMode: string | undefined;
  /** 是否外部关系（`TargetMode="External"`，按 OPC 规范大小写敏感）。 */
  readonly external: boolean;
}

/**
 * 按**文档顺序**枚举关系部件里的 `Relationship` 直接子元素。
 *
 * 顺序即文件里出现的顺序（**不排序、不去重**）：同一份字节永远得到同一序列，因此可以拿来
 * 比对"重开后的 `_rels` 是否被重排"。名字按本地名匹配（容忍前缀改写），根元素名不参与匹配。
 * `relationshipsRoot` 缺省 ⇒ 空列表。
 */
export function enumerateRelationships(
  relationshipsRoot: XmlElementNode | undefined,
): readonly RelationshipEntry[] {
  if (relationshipsRoot === undefined) return [];
  const entries: RelationshipEntry[] = [];
  for (const child of relationshipsRoot.children) {
    if (child.kind !== 'element' || localNameOf(child.name) !== RELATIONSHIP_ELEMENT) continue;
    const targetMode = attributeOf(child, 'TargetMode');
    entries.push({
      index: entries.length,
      node: child,
      id: attributeOf(child, 'Id'),
      type: attributeOf(child, 'Type'),
      target: attributeOf(child, 'Target'),
      targetMode,
      external: targetMode === 'External',
    });
  }
  return entries;
}

const MISSING_RELATIONSHIP_ID = '<missing>';

/** 关系部件文档顺序的稳定报告。 */
export interface RelationshipOrderReport {
  readonly count: number;
  /** 按文档顺序的 `Id` 序列；缺失 `Id` 的位置记 `'<missing>'`（不编造 id）。 */
  readonly ids: readonly string[];
  /** 文档顺序里第二次及以后出现的重复 `Id`（按首次出现次序，去重后稳定）。 */
  readonly duplicateIds: readonly string[];
}

/**
 * 复算关系部件的文档顺序：`Id` 序列 + 重复 id。同一份字节 ⇒ 同一报告（确定性）。
 * 关系被重排后，`ids` 按新文件顺序变化——这是"重排被如实报出"的依据。
 */
export function relationshipOrderReport(
  relationshipsRoot: XmlElementNode | undefined,
): RelationshipOrderReport {
  const entries = enumerateRelationships(relationshipsRoot);
  const ids: string[] = [];
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const entry of entries) {
    const id = entry.id ?? MISSING_RELATIONSHIP_ID;
    ids.push(id);
    if (entry.id === undefined) continue;
    if (seen.has(id)) {
      if (!duplicateIds.includes(id)) duplicateIds.push(id);
    } else {
      seen.add(id);
    }
  }
  return { count: entries.length, ids, duplicateIds };
}
