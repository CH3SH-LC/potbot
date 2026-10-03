/**
 * **W-I06 独立验证**：`DocumentModel → { spec, paragraph_node_ids }` 单源构造。
 *
 * ## 这一组在证明什么
 *
 * 判据只有一句：**行盒的 `paragraphIndex` 必须唯一地落到它自己那个段落 `node_id` 上**。
 * 为了不"自证"，每个用例都把 W09 的**真实分页引擎**（`layoutDocument`）跑一遍，再独立地用
 * `collectParagraphs`（模型的文档顺序）复算一遍期望映射；两边逐项相等才算过。
 *
 * ## 反向对照（每例只差一处，防"断言是空壳"）
 *
 * | 输入 | 期望 |
 * |---|---|
 * | 9 段、小页每页 4 行 ⇒ 3 页 | 每个 `paragraphIndex` 都出现（total）且扫描时非降（ordered） |
 * | 把 `paragraph_node_ids` 反过来 | `verifyLayoutDocumentSpec` 拒绝（`precondition`）——W09 与 W04 查不出 |
 * | 只把 `spec.paragraphs` 反过来 | 指纹对不上 ⇒ 拒绝 |
 * | 少一个 `node_id` / 换 `bindings` | 长度 / 逐项不一致 ⇒ 拒绝 |
 * | 段落 id 重复 | 构造期拒绝（映射多义） |
 * | 空文档 / `sectionIndex` 越界 | 构造期拒绝，不产出空表 |
 *
 * ## 层与未验证（不得当作已验证）
 *
 * - **本测试是 unit 层**：排版是 W09 的**真实分页计算**，但字体度量来自 W09 夹具端口
 *   （`verificationMode = fixture`）。真机字体表、Android 渲染、Word/WPS 消费端、真实语料
 *   端到端均在**未验证层**（见 `src/mobile-plugins/word/rendering/document-spec.ts` 文末）。
 *
 * ## runbook
 *
 * ```
 * npx vitest run tests/mobile-office/word/W09/document-spec.test.ts --reporter=basic
 * # 预期：Test Files 1 passed，用例全绿（真实分页 + 单源映射，无 mock 页号）
 * ```
 */

import { describe, expect, it } from 'vitest';

import {
  buildLayoutDocumentSpec,
  DEFAULT_PAGE_GEOMETRY,
  nodeIdForParagraphIndex,
  verifyLayoutDocumentSpec,
} from '../../../../src/mobile-plugins/word/rendering/document-spec.js';
import { layoutDocument } from '../../../../src/mobile-plugins/word/rendering/layout.js';
import { createFixtureFontPort } from './fixtures/font-port.js';
import {
  breakNode,
  cell,
  defaultSection,
  document,
  field,
  paragraph,
  row,
  run,
  runProperties,
  table,
} from '../../../../src/documents/selection/testing.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';
import { lengthToTwips } from '../../../../src/documents/units/length.js';
import type {
  BlockNode,
  DocumentModel,
  SectionProperties,
} from '../../../../src/documents/model/types.js';

const port = createFixtureFontPort();

/** 夹具端口认识的衬线字体，四个槽位都指它。 */
const SERIF = { ascii: 'Test Serif', hAnsi: 'Test Serif', eastAsia: 'Test Serif', cs: null } as const;

function serifRun(id: string, text: string, pt = 10) {
  return run(
    id,
    text,
    runProperties({
      fonts: { state: 'set', value: { ...SERIF } },
      size: { state: 'set', value: { kind: 'pt', value: pt } },
    }),
  );
}

function sectionWith(overrides: Partial<SectionProperties>): SectionProperties {
  return { ...defaultSection(), ...overrides };
}

/** 小页：内容区 200 × 40 pt、四边 0 ⇒ 10pt 正文每页 4 行。 */
function smallPage(): SectionProperties {
  return sectionWith({
    pageSize: {
      state: 'set',
      value: { width: { unit: 'pt', value: 200 }, height: { unit: 'pt', value: 40 } },
    },
    margins: {
      state: 'set',
      value: {
        top: { unit: 'pt', value: 0 },
        right: { unit: 'pt', value: 0 },
        bottom: { unit: 'pt', value: 0 },
        left: { unit: 'pt', value: 0 },
        gutter: { unit: 'pt', value: 0 },
      },
    },
  });
}

/** `count` 个正文段（每段一行），放在小页上 ⇒ 每页 4 段。 */
function makeDoc(count: number, sections: readonly SectionProperties[] = [smallPage()]): DocumentModel {
  const blocks: BlockNode[] = [];
  for (let index = 0; index < count; index += 1) {
    blocks.push(paragraph(`p${index}`, [serifRun(`r${index}`, `Para ${index}`)]));
  }
  return document(blocks, { sections: [...sections] });
}

/** 把真实布局结果里的所有 `paragraphIndex` 扫出来（顺序 = 页序内行序）。 */
function scanParagraphIndexes(result: ReturnType<typeof layoutDocument>): number[] {
  const out: number[] = [];
  for (const page of result.pages) for (const line of page.lines) out.push(line.paragraphIndex);
  return out;
}

// ---------------------------------------------------------------------------
// §A 单源构造 + 真实分页：映射 total / ordered / 正确
// ---------------------------------------------------------------------------

describe('§A 单源产物驱动真实排版，paragraphIndex → node_id 唯一', () => {
  it('段落 node_id 顺序 = 模型文档顺序（独立复算），绑定逐项有序', () => {
    const model = makeDoc(9);
    const built = buildLayoutDocumentSpec(model);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const pair = built.value;

    const expectedIds = collectParagraphs(model.blocks).map((para) => para.id);
    expect(pair.spec.paragraphs.length).toBe(9);
    expect(pair.paragraph_node_ids).toEqual(expectedIds); // 独立复算，与被测构造逐项相等
    expect(pair.bindings.map((b) => b.node_id)).toEqual(expectedIds);
    expect(pair.bindings.map((b) => b.paragraph_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    // 自检通过。
    const check = verifyLayoutDocumentSpec(pair);
    expect(check.ok).toBe(true);
  });

  it('真实排版 3 页：每个下标都出现（total）、扫描非降（ordered）、每行落回自己的 id', () => {
    const model = makeDoc(9);
    const built = buildLayoutDocumentSpec(model);
    if (!built.ok) throw new Error('setup');
    const pair = built.value;

    const result = layoutDocument(pair.spec, port);
    expect(result.ok).toBe(true);
    expect(result.pages.length).toBe(3); // 每页 4 行 × 9 段
    // 几何确实来自模型小节（内容区宽 = 200pt = 4000 twips）。
    expect(result.contentBox.widthTwips).toBe(lengthToTwips({ unit: 'pt', value: 200 }));

    const indexes = scanParagraphIndexes(result);
    // total：0..8 全部出现（空段也产一行，故不会漏）。
    expect([...new Set(indexes)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // ordered：页序 / 行序扫描时 paragraphIndex 非降。
    let last = -1;
    for (const index of indexes) {
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }

    // 正确：每一行的 paragraphIndex 经单源表落回的 id，等于独立复算的文档顺序段落 id。
    const expectedIds = collectParagraphs(model.blocks).map((para) => para.id);
    for (const page of result.pages) {
      for (const line of page.lines) {
        expect(pair.paragraph_node_ids[line.paragraphIndex]).toBe(expectedIds[line.paragraphIndex]);
      }
    }
  });

  it('段内文本与选区偏移空间同源：run + 软换行 + 域 拼接 == paragraphText', () => {
    const para = paragraph('p0', [
      serifRun('r1', 'Hello'),
      breakNode('b1'),
      field('f1', 'PAGE'), // 无缓存 ⇒ 占一个 U+FFFC
      serifRun('r2', '世界'),
    ]);
    const model = document([para], { sections: [smallPage()] });
    const built = buildLayoutDocumentSpec(model);
    if (!built.ok) throw new Error('setup');

    const specPara = built.value.spec.paragraphs[0];
    expect(specPara).toBeDefined();
    if (specPara === undefined) return;
    expect(specPara.runs.length).toBe(4); // 每个行内节点一个 run
    expect(specPara.runs.map((r) => r.text).join('')).toBe(paragraphText(para));
    expect(specPara.runs.map((r) => r.text).join('')).toBe('Hello\n￼世界');
  });

  it('字体选择确定：含 CJK 取 eastAsia，纯西文取 ascii', () => {
    const ascii = runProperties({
      fonts: { state: 'set', value: { ascii: 'Test Mono', hAnsi: 'Test Mono', eastAsia: 'Test Serif', cs: null } },
      size: { state: 'set', value: { kind: 'pt', value: 10 } },
    });
    const cjk = paragraph('p-cjk', [run('r-cjk', '世界', ascii)]);
    const latin = paragraph('p-lat', [run('r-lat', 'ABC', ascii)]);
    const model = document([cjk, latin], { sections: [smallPage()] });
    const built = buildLayoutDocumentSpec(model);
    if (!built.ok) throw new Error('setup');
    expect(built.value.spec.paragraphs[0]?.runs[0]?.fontFamily).toBe('Test Serif');
    expect(built.value.spec.paragraphs[1]?.runs[0]?.fontFamily).toBe('Test Mono');
  });
});

// ---------------------------------------------------------------------------
// §B 表格单元格段落平铺进同一条流（total 仍成立）
// ---------------------------------------------------------------------------

describe('§B 表格内段落进入文档顺序的单一流', () => {
  it('p0 + 表格两格 + p3：顺序为 p0,c1,c2,p3 且排版 total', () => {
    const tbl = table('t1', [
      row('row1', [
        cell('c1', [paragraph('cell-a', [serifRun('ca', 'A')])]),
        cell('c2', [paragraph('cell-b', [serifRun('cb', 'B')])]),
      ]),
    ]);
    const model = document([paragraph('p0', [serifRun('r0', 'zero')]), tbl, paragraph('p3', [serifRun('r3', 'three')])], {
      sections: [smallPage()],
    });
    const built = buildLayoutDocumentSpec(model);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.paragraph_node_ids).toEqual(['p0', 'cell-a', 'cell-b', 'p3']);
    const result = layoutDocument(built.value.spec, port);
    expect(result.ok).toBe(true);
    expect([...new Set(scanParagraphIndexes(result))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// §C 被改动的顺序必须被拒（W09 / W04 查不出，靠本模块的见证）
// ---------------------------------------------------------------------------

describe('§C 同基数置换被判据捕获', () => {
  it('把 paragraph_node_ids 反过来 ⇒ verify 拒绝；而排版引擎照样 ok（所以见证是必要的）', () => {
    const built = buildLayoutDocumentSpec(makeDoc(3));
    if (!built.ok) throw new Error('setup');
    const good = built.value;
    const reversedIds = [...good.paragraph_node_ids].reverse();
    const mutated = { ...good, paragraph_node_ids: reversedIds };

    // W09 不关心 node_id：对改过的 spec 依旧排得出来（正说明"顺序"不归它管）。
    expect(layoutDocument(mutated.spec, port).ok).toBe(true);

    const check = verifyLayoutDocumentSpec(mutated);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('precondition');

    // 顺带确认：换序后下标 0 指向了别的段落（旧的 p0 变成 p2）。
    expect(good.paragraph_node_ids[0]).toBe('p0');
    expect(reversedIds[0]).toBe('p2');
  });

  it('只把 spec.paragraphs 反过来 ⇒ 指纹对不上 ⇒ 拒绝', () => {
    const built = buildLayoutDocumentSpec(makeDoc(3));
    if (!built.ok) throw new Error('setup');
    const good = built.value;
    const mutated = { ...good, spec: { ...good.spec, paragraphs: [...good.spec.paragraphs].reverse() } };
    const check = verifyLayoutDocumentSpec(mutated);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('precondition');
  });

  it('少一个 node_id / 交换 bindings ⇒ 拒绝', () => {
    const built = buildLayoutDocumentSpec(makeDoc(3));
    if (!built.ok) throw new Error('setup');
    const good = built.value;

    const tooShort = { ...good, paragraph_node_ids: good.paragraph_node_ids.slice(0, 2) };
    expect(verifyLayoutDocumentSpec(tooShort).ok).toBe(false);

    const b0 = good.bindings[0];
    const b1 = good.bindings[1];
    if (b0 === undefined || b1 === undefined) throw new Error('setup');
    const swapped = { ...good, bindings: [b1, b0, ...good.bindings.slice(2)] };
    expect(verifyLayoutDocumentSpec(swapped).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §D fail-closed：空文档 / 重复 id / sectionIndex 越界 / 越界访问
// ---------------------------------------------------------------------------

describe('§D 构造与访问 fail-closed', () => {
  it('空文档 ⇒ precondition（不产出空表）', () => {
    const built = buildLayoutDocumentSpec(document([], { sections: [smallPage()] }));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe('precondition');
  });

  it('段落 node_id 重复 ⇒ precondition（映射多义）', () => {
    const dup = document(
      [paragraph('dup', [serifRun('a', 'A')]), paragraph('dup', [serifRun('b', 'B')])],
      { sections: [smallPage()] },
    );
    const built = buildLayoutDocumentSpec(dup);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe('precondition');
  });

  it('sectionIndex 越界 / 非法 ⇒ invalid_range', () => {
    const model = makeDoc(2);
    const outOfRange = buildLayoutDocumentSpec(model, { sectionIndex: 5 });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.code).toBe('invalid_range');

    const negative = buildLayoutDocumentSpec(model, { sectionIndex: -1 });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.code).toBe('invalid_range');
  });

  it('nodeIdForParagraphIndex：范围内取值、越界拒绝', () => {
    const built = buildLayoutDocumentSpec(makeDoc(3));
    if (!built.ok) throw new Error('setup');
    const pair = built.value;

    const first = nodeIdForParagraphIndex(pair, 0);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toBe('p0');

    const last = nodeIdForParagraphIndex(pair, 2);
    expect(last.ok).toBe(true);
    if (last.ok) expect(last.value).toBe('p2');

    const beyond = nodeIdForParagraphIndex(pair, 3);
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.code).toBe('invalid_range');

    const negative = nodeIdForParagraphIndex(pair, -1);
    expect(negative.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §E 页面几何：默认回落 + 显式小节 + 方向归一化
// ---------------------------------------------------------------------------

describe('§E 页面几何来自小节，缺省有显式回落', () => {
  it('小节未指定 pageSize/margins ⇒ 等于 DEFAULT_PAGE_GEOMETRY', () => {
    const model = makeDoc(2, [defaultSection()]);
    const built = buildLayoutDocumentSpec(model);
    if (!built.ok) throw new Error('setup');
    expect(built.value.spec.geometry).toEqual(DEFAULT_PAGE_GEOMETRY);
    expect(built.value.spec.geometry.headerHeightTwips).toBe(0);
    expect(built.value.spec.geometry.footerHeightTwips).toBe(0);
  });

  it('显式 mm 页面 + landscape ⇒ 宽高归一化，margins 走唯一换算来源', () => {
    const landscape = sectionWith({
      pageSize: {
        state: 'set',
        value: { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } },
      },
      orientation: { state: 'set', value: 'landscape' },
      margins: {
        state: 'set',
        value: {
          top: { unit: 'mm', value: 10 },
          right: { unit: 'mm', value: 10 },
          bottom: { unit: 'mm', value: 10 },
          left: { unit: 'mm', value: 10 },
          gutter: { unit: 'mm', value: 0 },
        },
      },
    });
    const model = makeDoc(1, [landscape]);
    const built = buildLayoutDocumentSpec(model);
    if (!built.ok) throw new Error('setup');
    const geometry = built.value.spec.geometry;
    // 210mm = 11907 twips，297mm = 16840 twips；landscape 交换后宽 > 高。
    expect(geometry.widthTwips).toBe(lengthToTwips({ unit: 'mm', value: 297 }));
    expect(geometry.heightTwips).toBe(lengthToTwips({ unit: 'mm', value: 210 }));
    expect(geometry.widthTwips).toBeGreaterThan(geometry.heightTwips);
    expect(geometry.marginsTwips.top).toBe(lengthToTwips({ unit: 'mm', value: 10 }));
  });

  it('默认字体/字号选项作用于未指定字体字号的 run', () => {
    const model = document([paragraph('p0', [run('r0', 'abc')])], { sections: [smallPage()] });
    const built = buildLayoutDocumentSpec(model, { defaultFontFamily: 'Fallback Sans', defaultSizePt: 12 });
    if (!built.ok) throw new Error('setup');
    const specRun = built.value.spec.paragraphs[0]?.runs[0];
    expect(specRun?.fontFamily).toBe('Fallback Sans');
    expect(specRun?.sizePt).toBe(12);
  });
});
