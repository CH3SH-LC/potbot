/**
 * **W03 / W-I02 — DOCX 写出器按「写意图」处理 remove vs omit（清除不得静默残留）**。
 *
 * 触发点（W03 交付说明 `integrationRequests[1]`）：`src/documents/docx/word-xml.ts` 的
 * `serializeToggle` / `serializeValued` 原先把 `unspecified` 与 `inherit` **一起**塌缩成
 * "无元素"，于是 `model/attributes.ts` 明文规定的 R118 机器可读写意图契约（`omit` ≠ `remove`）
 * 在写出层丢失。后果：局部重建（R151，见 `xml-patch.ts` 的 `patchChildren`——模型槽位 `null`
 * ⇒ 删除原树同名元素）**分不出**"该不该删"，`unsetPagination` / 各 clear 入口"取消格式"
 * 会在写回时留下旧元素。
 *
 * 本文件钉死三件事（都用**真实字节**，不照抄实现内部量）：
 *
 * | § | 判据 | 反向对照 |
 * |---|---|---|
 * | A | 写出器按写意图分流（直接调 `serializeRunProperties`）：`off` ⇒ `w:val="false"`；`inherit`/`unspecified` ⇒ 无元素，**绝不**写成 `false` | `off` 与 `inherit` 产出不同字节 |
 * | B | `exportDocx → importDocx`：**预先存在**的开关元素被清除（inherit/remove）后**真的消失** | 不清除时该元素仍在（证明"确实删掉了"而非"本来就没写"） |
 * | C | 带值属性同理：预先存在的 `w:highlight` 被清除后消失；`set('none')`（write_value）与 inherit（remove）是两条路 | `set('none')` 往返后仍是"显式 none"，不是"未指定" |
 * | D | `omit`（未指定）不产出元素；与 remove 的字节相同但在 R118 契约上不同 | 未指定段落往返后读回 unspecified，不是 off |
 *
 * ## 与 W03 §F 的关系（不重复）
 *
 * `paragraph-format-readback.test.ts` §F 只在**从零新建**的段落上证明"清除后读回未指定"；
 * 本文件 §B/§C 的关键区别是**原字节里先有该元素**（经真实 `exportDocx` 造出、再 `importDocx`
 * 得到"预先存在"的事实），因此能证明写意图 `remove` 的动作**真的删掉了一个已存在的元素**——
 * 这正是 W03 上报的"局部重建会残留"缺陷的字节级对照。
 *
 * ## 已知边界
 *
 * - 未做手机端（on-device）与真实 Word/WPS 消费端重开；本文件只到内核字节层。
 * - 主部件仍走**全量重建 / 最小差分**（`export.ts` 的 `collectParts`）：`omit` 与 `remove`
 *   在从零重建里字节相同是 OOXML 规范决定的（"继承"就是"没有该属性"）；本文件证明的是
 *   写意图契约在写出层**没有丢**，以及 `remove` 的删除动作在字节结果上成立。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { serializeXmlNode } from '../../../../src/artifacts/ooxml/xml.js';
import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';

import { createDocumentModel } from '../../../../src/documents/model/document.js';
import { defaultRunProperties, paragraphNode, runNode } from '../../../../src/documents/model/nodes.js';
import { toggleWriteIntent, valuedWriteIntent } from '../../../../src/documents/model/attributes.js';
import {
  TOGGLE_INHERIT,
  TOGGLE_OFF,
  TOGGLE_ON,
  TOGGLE_UNSPECIFIED,
} from '../../../../src/documents/model/types.js';
import type {
  DocumentModel,
  HighlightColor,
  ParagraphNode,
  RunNode,
  RunProperties,
} from '../../../../src/documents/model/types.js';

import { serializeRunProperties } from '../../../../src/documents/docx/word-xml.js';
import { exportDocx } from '../../../../src/documents/docx/export.js';
import { importDocx } from '../../../../src/documents/docx/import.js';

// ---------------------------------------------------------------------------
// 夹具工具
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

/** 一个合法包（含 [Content_Types].xml / .rels / styles / sectPr）；块区被 replacement 覆盖。 */
function modelWithBlocks(blocks: readonly ReturnType<typeof paragraphNode>[]): DocumentModel {
  const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
  const created = createDocumentModel({ document_id: 'w03-wi', blocks });
  return { ...base, blocks: created.blocks };
}

/** 覆盖默认 run 属性（默认全 `unspecified`）。 */
function runProps(overrides: Partial<RunProperties>): RunProperties {
  return { ...defaultRunProperties(), ...overrides };
}

const PARAGRAPH_TEXT = 'W-I02 写意图';

function paragraphWithRun(properties: RunProperties): ReturnType<typeof paragraphNode> {
  return paragraphNode({
    source: 'user_request',
    inlines: [runNode({ text: PARAGRAPH_TEXT, source: 'user_request', properties })],
  });
}

/** 从模型里取正文段落（按 run 文本定位）。 */
function findParagraphByText(model: DocumentModel, text: string): ParagraphNode {
  for (const block of model.blocks) {
    if (block.kind !== 'paragraph') continue;
    if (block.inlines.some((inline) => inline.kind === 'run' && inline.text === text)) return block;
  }
  throw new Error(`未找到文本为 ${text} 的段落`);
}

function firstRun(paragraph: ParagraphNode): RunNode {
  const run = paragraph.inlines.find((inline): inline is RunNode => inline.kind === 'run');
  if (run === undefined) throw new Error('段落里没有 run');
  return run;
}

const MAIN_PART = 'word/document.xml';

/** 从真实 DOCX 字节里独立读出主部件文本（**不走**导出器的接口）。 */
function mainPartXmlOf(bytes: Uint8Array): string {
  const entry = readZip(bytes).by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error(`导出的包里没有 ${MAIN_PART}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
}

/** 元素开标签匹配：`<w:b/>`、`<w:b …>`、`<w:b>` 都算；不会误吞 `<w:body>` / `<w:bCs>` / `<w:br>`。 */
function hasElement(xml: string, localName: string): boolean {
  return new RegExp(`<w:${localName}[\\s/>]`).test(xml);
}

// ===========================================================================
// §A 写出器按写意图分流（直接钉 serializeRunProperties）
// ===========================================================================

describe('§A 写出器的写意图分流（R118）', () => {
  it('对照先钉契约：四态写意图两两不同，omit ≠ remove', () => {
    expect(toggleWriteIntent(TOGGLE_UNSPECIFIED)).toBe('omit');
    expect(toggleWriteIntent(TOGGLE_ON)).toBe('write_true');
    expect(toggleWriteIntent(TOGGLE_OFF)).toBe('write_false');
    expect(toggleWriteIntent(TOGGLE_INHERIT)).toBe('remove');
    expect(new Set([TOGGLE_UNSPECIFIED, TOGGLE_ON, TOGGLE_OFF, TOGGLE_INHERIT].map(toggleWriteIntent)).size).toBe(4);
    expect(valuedWriteIntent({ state: 'inherit' })).toBe('remove');
    expect(valuedWriteIntent({ state: 'unspecified' })).toBe('omit');
    expect(valuedWriteIntent({ state: 'set', value: false })).toBe('write_value');
  });

  it('off ⇒ 写 <w:b w:val="false"/>；on ⇒ 写 <w:b/>（两者字节必须不同）', () => {
    const off = serializeXmlNode(serializeRunProperties(runProps({ bold: TOGGLE_OFF }))!);
    const on = serializeXmlNode(serializeRunProperties(runProps({ bold: TOGGLE_ON }))!);
    expect(off).toContain('<w:b w:val="false"/>');
    expect(on).toContain('<w:b/>');
    expect(on).not.toContain('w:val="false"');
    expect(off).not.toBe(on);
  });

  it('inherit 与 unspecified 都不产出元素，且**绝不**写成 off 的字节', () => {
    // 单独一个 inherit 字段 ⇒ 整个 rPr 为空 ⇒ 返回 null（没有任何要写的内容）。
    expect(serializeRunProperties(runProps({ bold: TOGGLE_INHERIT }))).toBeNull();
    expect(serializeRunProperties(runProps({ bold: TOGGLE_UNSPECIFIED }))).toBeNull();

    // 混合：inherit 的字段缺席、同段落其它字段照写 ⇒ 能看清"缺的是被删的，不是被写成 false"
    const inherited = serializeXmlNode(
      serializeRunProperties(runProps({ bold: TOGGLE_INHERIT, italic: TOGGLE_ON }))!,
    );
    expect(inherited).toContain('<w:i/>');
    expect(hasElement(inherited, 'b')).toBe(false);
    expect(inherited).not.toContain('w:val="false"');

    const explicitOff = serializeXmlNode(
      serializeRunProperties(runProps({ bold: TOGGLE_OFF, italic: TOGGLE_ON }))!,
    );
    expect(explicitOff).toContain('<w:b w:val="false"/>');
    expect(explicitOff).toContain('<w:i/>');
  });

  it('带值属性：set 产出元素（含显式 false/0 值），inherit 缺席', () => {
    const setYellow = serializeXmlNode(
      serializeRunProperties(runProps({ highlight: { state: 'set', value: 'yellow' } }))!,
    );
    expect(setYellow).toContain('<w:highlight w:val="yellow"/>');

    // 显式 "none"（显式取消）走 set ⇒ write_value，是一个**值**，不是 remove/omit
    const setNone = serializeXmlNode(
      serializeRunProperties(runProps({ highlight: { state: 'set', value: 'none' } }))!,
    );
    expect(setNone).toContain('<w:highlight w:val="none"/>');

    // 混合：highlight 清除（inherit）缺席、同段落 bold 照写 ⇒ 能看清"缺的是被删的"
    const inherited = serializeXmlNode(
      serializeRunProperties(runProps({ highlight: { state: 'inherit' }, bold: TOGGLE_ON }))!,
    );
    expect(inherited).toContain('<w:b/>');
    expect(hasElement(inherited, 'highlight')).toBe(false);
    // 单独一个 inherit 字段 ⇒ rPr 为空 ⇒ 返回 null（不写空壳）
    expect(serializeRunProperties(runProps({ highlight: { state: 'inherit' } }))).toBeNull();
  });
});

// ===========================================================================
// §B 预先存在的开关元素：remove（清除）真的删掉它
// ===========================================================================

describe('§B export→import：清除一个**已存在**的开关元素', () => {
  // 先经真实字节造出"原字节里就有 <w:b/>"这一事实
  function sourceBytesWithBoldOn(): Uint8Array {
    return exportDocx(modelWithBlocks([paragraphWithRun(runProps({ bold: TOGGLE_ON }))]));
  }

  it('前提起点：导出的原字节里确实有 <w:b/>，且重开后读回 on', () => {
    const bytes = sourceBytesWithBoldOn();
    expect(hasElement(mainPartXmlOf(bytes), 'b')).toBe(true);
    const reopened = importDocx(bytes);
    expect(firstRun(findParagraphByText(reopened, PARAGRAPH_TEXT)).properties.bold).toEqual(TOGGLE_ON);
  });

  it('清除（inherit ⇒ remove）：原字节里有 <w:b/>，清除后导出**没有**该元素，重开读回未指定', () => {
    const before = sourceBytesWithBoldOn();
    const imported = importDocx(before);
    // 原字节里有 bold，模型读回 on —— 这是"预先存在"的证据
    expect(firstRun(findParagraphByText(imported, PARAGRAPH_TEXT)).properties.bold).toEqual(TOGGLE_ON);

    // 清除：把 bold 落成 inherit（write-intent remove）
    const cleared = paragraphWithRun(runProps({ bold: TOGGLE_INHERIT }));
    const model3: DocumentModel = { ...imported, blocks: createDocumentModel({ document_id: 'w03-wi-clr', blocks: [cleared] }).blocks };
    const after = exportDocx(model3);

    const xml = mainPartXmlOf(after);
    expect(hasElement(xml, 'b')).toBe(false);
    // 尤其不能"清除写成显式关"
    expect(/<w:b[^>]*w:val="false"/.test(xml)).toBe(false);

    const reopened = importDocx(after);
    const bold = firstRun(findParagraphByText(reopened, PARAGRAPH_TEXT)).properties.bold;
    expect(bold.state).toBe('unspecified');
    expect(bold).not.toEqual(TOGGLE_OFF);
    expect(bold).not.toEqual(TOGGLE_ON);
  });

  it('反向对照：不清除时元素仍在（证明 §B 的"消失"确实是被删除，而非从来没写）', () => {
    const before = sourceBytesWithBoldOn();
    const imported = importDocx(before);
    // 不改动 ⇒ R151 原字节写回，元素保留
    const same = exportDocx(imported);
    expect(hasElement(mainPartXmlOf(same), 'b')).toBe(true);
    expect(firstRun(findParagraphByText(importDocx(same), PARAGRAPH_TEXT)).properties.bold).toEqual(TOGGLE_ON);
  });

  it('显式关（off ⇒ write_false）：写出 w:val="false"，往返读回 off（不是未指定、不是 on）', () => {
    const bytes = exportDocx(modelWithBlocks([paragraphWithRun(runProps({ bold: TOGGLE_OFF }))]));
    const xml = mainPartXmlOf(bytes);
    expect(/<w:b[^>]*w:val="false"/.test(xml)).toBe(true);
    const reopened = importDocx(bytes);
    const bold = firstRun(findParagraphByText(reopened, PARAGRAPH_TEXT)).properties.bold;
    expect(bold).toEqual(TOGGLE_OFF);
    expect(bold.state).not.toBe('unspecified');
    expect(bold).not.toEqual(TOGGLE_ON);
  });
});

// ===========================================================================
// §C 预先存在的带值元素：remove 删掉它，set('none') 不是 remove
// ===========================================================================

describe('§C export→import：带值元素的 remove vs write_value', () => {
  function sourceBytesWithHighlight(color: HighlightColor): Uint8Array {
    return exportDocx(modelWithBlocks([paragraphWithRun(runProps({ highlight: { state: 'set', value: color } }))]));
  }

  it('清除（inherit ⇒ remove）删掉预先存在的 <w:highlight>', () => {
    const before = sourceBytesWithHighlight('yellow');
    expect(hasElement(mainPartXmlOf(before), 'highlight')).toBe(true);
    const imported = importDocx(before);
    expect(firstRun(findParagraphByText(imported, PARAGRAPH_TEXT)).properties.highlight).toEqual({
      state: 'set',
      value: 'yellow',
    });

    const cleared = paragraphWithRun(runProps({ highlight: { state: 'inherit' } }));
    const model3: DocumentModel = { ...imported, blocks: createDocumentModel({ document_id: 'w03-wi-clr', blocks: [cleared] }).blocks };
    const after = exportDocx(model3);

    const xml = mainPartXmlOf(after);
    expect(hasElement(xml, 'highlight')).toBe(false);
    const highlight = firstRun(findParagraphByText(importDocx(after), PARAGRAPH_TEXT)).properties.highlight;
    expect(highlight.state).toBe('unspecified');
  });

  it('反向对照：显式 set("none") 是 write_value ⇒ 写出 w:val="none"，读回仍是显式 none', () => {
    const bytes = sourceBytesWithHighlight('none');
    const xml = mainPartXmlOf(bytes);
    expect(xml).toContain('<w:highlight w:val="none"/>');
    const highlight = firstRun(findParagraphByText(importDocx(bytes), PARAGRAPH_TEXT)).properties.highlight;
    expect(highlight).toEqual({ state: 'set', value: 'none' });
    // "显式 none" 与 "清除 inherit" 判然不同
    expect(highlight.state).not.toBe('unspecified');
  });
});

// ===========================================================================
// §D omit（未指定）不产出元素
// ===========================================================================

describe('§D 未指定（omit）不产出元素，往返读回 unspecified', () => {
  it('新建段落（全未指定）导出后没有 <w:b> / <w:highlight>，重开读回 unspecified', () => {
    const bytes = exportDocx(modelWithBlocks([paragraphWithRun(defaultRunProperties())]));
    const xml = mainPartXmlOf(bytes);
    expect(hasElement(xml, 'b')).toBe(false);
    expect(hasElement(xml, 'highlight')).toBe(false);
    expect(xml).not.toContain('w:val="false"');

    const run = firstRun(findParagraphByText(importDocx(bytes), PARAGRAPH_TEXT));
    expect(run.properties.bold).toEqual(TOGGLE_UNSPECIFIED);
    expect(run.properties.highlight).toEqual({ state: 'unspecified' });
  });
});
