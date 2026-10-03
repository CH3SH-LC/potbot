/**
 * **极简 XML 起止标记扫描器**（W-R05）——只为从 OOXML 的
 * `[Content_Types].xml` 与 `*.rels` 里抽出**元素名 + 属性**，不是通用 XML 解析器。
 *
 * 为什么不用正则：属性顺序、自闭合与否、单双引号、前缀命名空间都可能变，正则会脆。
 * 为什么不上完整解析器：本复核器零依赖，且 OPC 的这两个部件结构极窄（只有 `Default`
 * / `Override` / `Relationship` 三种元素），扫描器足够且**可审计**。
 *
 * 不处理（如实登记的局限）：CDATA、注释内的假标记（注释会被跳过）、DTD/实体定义。
 * 这些在 DOCX 的 `[Content_Types].xml` / `.rels` 里都不出现；若真出现，本扫描器可能
 * 误判——属于「复核器的局限」，已在 README 登记。
 */

export interface XmlTag {
  /** 带命名空间前缀的完整元素名（如 `Relationships`）。 */
  readonly qualifiedName: string;
  /** 去掉 `前缀:` 后的本地名（如 `Relationship`）。 */
  readonly localName: string;
  /** 属性名 → 值（属性名保留前缀原样；值已解实体）。 */
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function decodeEntities(value: string): string {
  if (value.indexOf('&') < 0) {
    return value;
  }
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 扫描出文档里**所有**起止标记（起始标签 / 自闭合标签），跳过注释、PI、结束标签与 DOCTYPE。 */
export function scanStartTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  let cursor = 0;
  const length = xml.length;

  while (cursor < length) {
    const lt = xml.indexOf('<', cursor);
    if (lt < 0) {
      break;
    }
    const next = xml.charAt(lt + 1);

    // 注释 `<!-- -->`、PI `<? ?>`、DOCTYPE `<! >`、结束标签 `</ >`：整体跳过。
    if (next === '!') {
      const close = xml.indexOf('>', lt + 1);
      if (close < 0) {
        break;
      }
      cursor = close + 1;
      continue;
    }
    if (next === '?') {
      const close = xml.indexOf('?>', lt + 1);
      if (close < 0) {
        break;
      }
      cursor = close + 2;
      continue;
    }
    if (next === '/') {
      const close = xml.indexOf('>', lt + 1);
      if (close < 0) {
        break;
      }
      cursor = close + 1;
      continue;
    }

    // 读元素名。
    let nameEnd = lt + 1;
    while (
      nameEnd < length &&
      !isSpace(xml.charAt(nameEnd)) &&
      xml.charAt(nameEnd) !== '>' &&
      xml.charAt(nameEnd) !== '/'
    ) {
      nameEnd += 1;
    }
    const qualifiedName = xml.slice(lt + 1, nameEnd);
    const attributes = new Map<string, string>();
    let selfClosing = false;

    let scan = nameEnd;
    while (scan < length) {
      while (scan < length && isSpace(xml.charAt(scan))) {
        scan += 1;
      }
      const ch = xml.charAt(scan);
      if (ch === '>') {
        scan += 1;
        break;
      }
      if (ch === '/') {
        selfClosing = true;
        scan += 1;
        continue;
      }
      if (ch === '') {
        break; // 文档在标签中途结束：停止，不构造半截标记。
      }

      // 属性名。
      let attrEnd = scan;
      while (
        attrEnd < length &&
        !isSpace(xml.charAt(attrEnd)) &&
        xml.charAt(attrEnd) !== '=' &&
        xml.charAt(attrEnd) !== '>' &&
        xml.charAt(attrEnd) !== '/'
      ) {
        attrEnd += 1;
      }
      const attrName = xml.slice(scan, attrEnd);
      scan = attrEnd;
      while (scan < length && isSpace(xml.charAt(scan))) {
        scan += 1;
      }
      if (xml.charAt(scan) === '=') {
        scan += 1;
        while (scan < length && isSpace(xml.charAt(scan))) {
          scan += 1;
        }
        const quote = xml.charAt(scan);
        if (quote === '"' || quote === "'") {
          const valueStart = scan + 1;
          let valueEnd = valueStart;
          while (valueEnd < length && xml.charAt(valueEnd) !== quote) {
            valueEnd += 1;
          }
          attributes.set(attrName, decodeEntities(xml.slice(valueStart, valueEnd)));
          scan = valueEnd + 1;
        } else {
          const valueStart = scan;
          while (
            scan < length &&
            !isSpace(xml.charAt(scan)) &&
            xml.charAt(scan) !== '>'
          ) {
            scan += 1;
          }
          attributes.set(attrName, decodeEntities(xml.slice(valueStart, scan)));
        }
      } else {
        attributes.set(attrName, '');
      }
    }

    // 空元素名（如 `< >`）不入账。
    if (qualifiedName.length > 0) {
      const colon = qualifiedName.indexOf(':');
      tags.push({
        qualifiedName,
        localName: colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName,
        attributes,
        selfClosing,
      });
    }
    cursor = scan;
  }

  return tags;
}
