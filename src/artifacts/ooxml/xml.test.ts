/**
 * 确定性 XML 写入器单测（W-A）。
 *
 * 锁定四件事（都是"字节可复现"的必要条件）：
 * - 转义规则固定；
 * - **属性顺序 = 传入顺序**（换序 ⇒ 字节不同）；
 * - **无 BOM**、换行固定 `\n`；
 * - 数字只走定点/整数格式化（不经 `toLocaleString` / `toFixed`）。
 */

import { describe, expect, it } from 'vitest';

import {
  attr,
  el,
  escapeAttribute,
  escapeText,
  formatDecimal,
  formatInteger,
  serializeXmlDocument,
  serializeXmlNode,
  utf8Bytes,
  XML_DECLARATION,
  XmlError,
} from './xml.js';

describe('xml —— 转义', () => {
  it('文本转义 & < >', () => {
    expect(escapeText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeText('引号 " 与 \' 原样保留')).toBe('引号 " 与 \' 原样保留');
  });

  it('属性转义 & < > " \'（并转义回车/换行/制表符，避免解析期属性值规范化改变内容）', () => {
    expect(escapeAttribute('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f',
    );
    expect(escapeAttribute('l1\nl2\ttab\r')).toBe('l1&#10;l2&#9;tab&#13;');
  });

  it('中文与 emoji 原样按 UTF-8 写出（不转义、不转数字引用）', () => {
    expect(serializeXmlNode(el('t', [], ['十人 · 合计 100 元']))).toBe('<t>十人 · 合计 100 元</t>');
    expect(Array.from(utf8Bytes('中'))).toEqual([0xe4, 0xb8, 0xad]);
  });
});

describe('xml —— 结构序列化', () => {
  it('无子节点 ⇒ 自闭合；有子节点（含空文本）⇒ 成对标签', () => {
    expect(serializeXmlNode(el('a'))).toBe('<a/>');
    expect(serializeXmlNode(el('a', [attr('k', 'v')]))).toBe('<a k="v"/>');
    expect(serializeXmlNode(el('a', [], ['']))).toBe('<a></a>');
    expect(serializeXmlNode(el('a', [], [el('b')]))).toBe('<a><b/></a>');
  });

  it('属性按显式传入顺序输出，换序 ⇒ 字节不同', () => {
    const namespaceFirst = el('w:p', [attr('xmlns:w', 'W'), attr('xml:space', 'preserve')], ['x']);
    expect(serializeXmlNode(namespaceFirst)).toBe('<w:p xmlns:w="W" xml:space="preserve">x</w:p>');

    const swapped = el('w:p', [attr('xml:space', 'preserve'), attr('xmlns:w', 'W')], ['x']);
    expect(serializeXmlNode(swapped)).not.toBe(serializeXmlNode(namespaceFirst));
  });

  it('嵌套与兄弟节点保序（不排序、不缩进、不加空白）', () => {
    const tree = el('w:body', [], [el('w:p', [], ['一']), el('w:p', [], ['二'])]);
    expect(serializeXmlNode(tree)).toBe('<w:body><w:p>一</w:p><w:p>二</w:p></w:body>');
  });

  it('非法元素名/属性名 ⇒ 抛 XmlError', () => {
    for (const name of ['', '1a', 'a b', 'a<b']) {
      expect(() => el(name)).toThrowError(XmlError);
      expect(() => attr(name, 'v')).toThrowError(XmlError);
    }
  });
});

describe('xml —— 声明 / BOM / 换行', () => {
  it('声明是固定常量，其后固定一个 \\n', () => {
    expect(XML_DECLARATION).toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    const document = serializeXmlDocument(el('Types', [attr('xmlns', 'N')]));
    expect(document).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="N"/>',
    );
  });

  it('无 BOM：首字节是 "<"，字节流不含 EF BB BF 前缀', () => {
    const bytes = utf8Bytes(serializeXmlDocument(el('a')));
    expect(bytes[0]).toBe(0x3c);
    expect(Array.from(bytes.subarray(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('换行统一 \\n：输出里不出现 \\r', () => {
    const document = serializeXmlDocument(el('a', [], ['l1', el('b', [], ['l2'])]));
    expect(document.includes('\r')).toBe(false);
    expect(document.includes('\n')).toBe(true);
    expect(document.split('\n').length).toBe(2);
  });
});

describe('xml —— 数字格式化（定点/整数，不经本地化路径）', () => {
  it('formatInteger：安全整数 → 十进制；非整数显式抛错', () => {
    expect(formatInteger(0)).toBe('0');
    expect(formatInteger(10)).toBe('10');
    expect(formatInteger(-7)).toBe('-7');
    expect(formatInteger(9007199254740991)).toBe('9007199254740991');
    for (const value of [1.5, NaN, Infinity, -Infinity, 2 ** 53]) {
      expect(() => formatInteger(value)).toThrowError(XmlError);
    }
  });

  it('formatDecimal：恰好 scale 位、half away from zero、不经 toFixed', () => {
    expect(formatDecimal(10, 2)).toBe('10.00');
    expect(formatDecimal(0, 3)).toBe('0.000');
    expect(formatDecimal(0.1, 2)).toBe('0.10');
    expect(formatDecimal(1234.5, 2)).toBe('1234.50');
    expect(formatDecimal(2.675, 2)).toBe('2.68');
    expect(formatDecimal(1.005, 2)).toBe('1.01');
    expect(formatDecimal(-1.005, 2)).toBe('-1.01');
    expect(formatDecimal(1.005, 1)).toBe('1.0');
    expect(formatDecimal(-0.001, 2)).toBe('0.00');
    expect(formatDecimal(1e21, 0)).toBe('1000000000000000000000');
    expect(formatDecimal(1e-7, 3)).toBe('0.000');
    expect(formatDecimal(9.999, 2)).toBe('10.00');
  });

  it('formatDecimal：非法 scale / 非有限数显式抛错', () => {
    for (const scale of [-1, 1.5, 21, NaN]) {
      expect(() => formatDecimal(1, scale)).toThrowError(XmlError);
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => formatDecimal(value, 2)).toThrowError(XmlError);
    }
  });
});
