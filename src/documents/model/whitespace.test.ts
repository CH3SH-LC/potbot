/**
 * R104 空白与换行保真。
 *
 * 挡住的错误实现：导入时 `text.trim()` / `text.replace(/\s+/g,' ')` / `tab → 空格`，
 * 或者把 `w:br` 直接当成段落结束。判据是"读回来逐字符等于原串"与
 * "软换行仍在同一段里"。
 *
 * 注：源文件里不含任何字面 U+00A0 / U+2028 等字符，全部用 `String.fromCodePoint` 构造，
 * 免得源码本身被行终止符类字符弄坏。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentModel } from './document.js';
import { DocumentModelError } from './errors.js';
import { breakNode, paragraphNode, runNode } from './nodes.js';
import { documentParagraphTexts, paragraphPlainText, paragraphRunTexts } from './text.js';
import type { DocumentModel } from './types.js';
import { validateDocument } from './validation.js';
import {
  assertTextVerbatim,
  breakCharacterOffsets,
  isBreakCharacter,
  requiresPreserveSpace,
  textFidelity,
  WHITESPACE_FIDELITY_STATEMENT,
} from './whitespace.js';
import { AWKWARD_TEXT, paragraphBlockAt } from './fixtures.js';

const NBSP = String.fromCodePoint(0x00a0);

describe('R104 文本保真画像', () => {
  it('识别首尾空白、连续空格、tab 与码位数', () => {
    const fidelity = textFidelity(AWKWARD_TEXT);
    expect(fidelity.has_leading_whitespace).toBe(true);
    expect(fidelity.has_trailing_whitespace).toBe(true);
    expect(fidelity.tab_count).toBe(1);
    expect(fidelity.max_consecutive_spaces).toBeGreaterThanOrEqual(2);
    expect(fidelity.code_point_length).toBe([...AWKWARD_TEXT].length);
  });

  it('码位数按 Unicode 码位算，不按 UTF-16 码元', () => {
    const emoji = String.fromCodePoint(0x1f642);
    expect(textFidelity(emoji).code_point_length).toBe(1);
    expect(emoji.length).toBe(2);
  });

  it('普通文本无需 preserve', () => {
    const fidelity = textFidelity('正常的一段中文和 ascii');
    expect(fidelity.requires_preserve_space).toBe(false);
    expect(fidelity.max_consecutive_spaces).toBe(1);
  });

  it('空串既不需要 preserve，也不含任何空白', () => {
    const fidelity = textFidelity('');
    expect(fidelity.requires_preserve_space).toBe(false);
    expect(fidelity.code_point_length).toBe(0);
    expect(fidelity.has_leading_whitespace).toBe(false);
  });
});

describe('R104 xml:space="preserve" 语义可表达', () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['普通中文', '中文标题', false],
    ['单个内部空格', 'a b', false],
    ['空串', '', false],
    ['前导空格', ' x', true],
    ['尾随空格', 'x ', true],
    ['连续两个空格', 'a  b', true],
    ['含 tab', 'a\tb', true],
    ['纯 tab', '\t', true],
    ['含换行', 'a\nb', true],
  ];

  for (const [name, text, expected] of cases) {
    it(`${name}（${JSON.stringify(text)}）⇒ preserve=${String(expected)}`, () => {
      expect(requiresPreserveSpace(text)).toBe(expected);
    });
  }

  it('不间断空格 U+00A0 是普通字符：既不是换行类字符，也不需要 preserve', () => {
    expect(isBreakCharacter(NBSP)).toBe(false);
    expect(requiresPreserveSpace(`a${NBSP}b`)).toBe(false);
    expect(textFidelity(`a${NBSP}b`).requires_preserve_space).toBe(false);
  });
});

describe('R104 换行类字符识别', () => {
  it('LF / CR / 垂直制表 / 换页 / U+2028 / U+2029 都算', () => {
    for (const code of [0x0a, 0x0d, 0x0b, 0x0c, 0x2028, 0x2029]) {
      expect(isBreakCharacter(String.fromCodePoint(code))).toBe(true);
    }
    expect(isBreakCharacter('a')).toBe(false);
  });

  it('偏移按码位计（emoji 占 1）', () => {
    const emoji = String.fromCodePoint(0x1f642);
    expect(breakCharacterOffsets(`${emoji}\n`)).toEqual([1]);
    expect(breakCharacterOffsets('ab\ncd\r')).toEqual([2, 5]);
    expect(breakCharacterOffsets('没有换行')).toEqual([]);
  });
});

describe('R104 防折叠断言', () => {
  it('逐字符相同即通过', () => {
    expect(() => {
      assertTextVerbatim(AWKWARD_TEXT, AWKWARD_TEXT, '原样写回');
    }).not.toThrow();
  });

  it('被折叠即抛 text_fidelity_violation', () => {
    let code: string | null = null;
    try {
      assertTextVerbatim('a  b', 'a b', '写回');
    } catch (error) {
      code = error instanceof DocumentModelError ? error.code : 'not-model-error';
    }
    expect(code).toBe('text_fidelity_violation');
    expect(() => assertTextVerbatim(' x ', 'x', '写回')).toThrow(DocumentModelError);
    expect(() => assertTextVerbatim('a\tb', 'a b', '写回')).toThrow(DocumentModelError);
  });
});

describe('R104 模型层：run 文本原样保存', () => {
  const model: DocumentModel = createDocumentModel({
    document_id: 'doc-ws',
    blocks: [
      paragraphNode({
        source: 'imported',
        inlines: [runNode({ text: AWKWARD_TEXT, source: 'imported' })],
      }),
    ],
  });

  it('读回的文本与写入的字符串逐字符相同（tab 与连续空格都在）', () => {
    const paragraph = paragraphBlockAt(model, 0);
    expect(paragraphRunTexts(paragraph)).toEqual([AWKWARD_TEXT]);
    const text = paragraphRunTexts(paragraph)[0] ?? '';
    expect(text.includes('\t')).toBe(true);
    expect(text.includes('  ')).toBe(true);
    expect(text.startsWith('  ')).toBe(true);
    expect(text.endsWith('  ')).toBe(true);
    expect(text).toBe(AWKWARD_TEXT);
  });

  it('JSON 往返后仍然逐字符相同', () => {
    const revived = JSON.parse(JSON.stringify(model)) as DocumentModel;
    expect(paragraphRunTexts(paragraphBlockAt(revived, 0))).toEqual([AWKWARD_TEXT]);
  });

  it('run 文本里的换行字符只是 warning，不阻断导入（R104 + 严重度判据）', () => {
    const withNewline = createDocumentModel({
      document_id: 'doc-ws2',
      blocks: [
        paragraphNode({
          source: 'imported',
          inlines: [runNode({ text: 'a\nb', source: 'imported' })],
        }),
      ],
    });
    const report = validateDocument(withNewline);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((problem) => problem.code)).toContain(
      'text_contains_break_character',
    );
    // 未被折叠：文本原样保留，警告只是"应改用 BreakNode"
    expect(paragraphRunTexts(paragraphBlockAt(withNewline, 0))).toEqual(['a\nb']);
  });
});

describe('R104 软换行不是段落边界', () => {
  const model = createDocumentModel({
    document_id: 'doc-br',
    blocks: [
      paragraphNode({
        source: 'imported',
        inlines: [
          runNode({ text: '前', source: 'imported' }),
          breakNode({ breakType: 'line', source: 'imported' }),
          runNode({ text: '后', source: 'imported' }),
        ],
      }),
    ],
  });

  it('软换行留在同一段里（块数仍为 1）', () => {
    expect(model.blocks.length).toBe(1);
    expect(paragraphBlockAt(model, 0).inlines.map((inline) => inline.kind)).toEqual([
      'run',
      'break',
      'run',
    ]);
  });

  it('投影里软换行是换行符，但段落文本仍是一段', () => {
    expect(paragraphPlainText(paragraphBlockAt(model, 0))).toBe('前\n后');
    expect(documentParagraphTexts(model)).toEqual(['前\n后']);
  });

  it('分页/分栏断点也只是 BreakNode，不是新段落', () => {
    const paged = createDocumentModel({
      document_id: 'doc-br2',
      blocks: [
        paragraphNode({
          source: 'imported',
          inlines: [breakNode({ breakType: 'page', source: 'imported' })],
        }),
      ],
    });
    expect(paged.blocks.length).toBe(1);
    expect(paragraphBlockAt(paged, 0).inlines[0]?.kind).toBe('break');
  });

  it('口径声明非空（供证据文本引用）', () => {
    expect(WHITESPACE_FIDELITY_STATEMENT.length).toBeGreaterThan(10);
  });
});
