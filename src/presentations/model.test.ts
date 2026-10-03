/**
 * 演示域**模型层**用例（design-06 P9）。
 *
 * 覆盖三条与合同直接挂钩的语义：
 * - R232「模板 / 工具 / 文件格式分开」——演示格式枚举里不得出现工具名；
 * - R248「缺失不当零」——事实引用查不到时渲染成占位，**不是** `0`；
 * - PPT-01「页数由任务决定」——模型层不存在"固定两页"的概念（见 operations 用例的页数增减）。
 */

import { describe, expect, it } from 'vitest';

import {
  MISSING_FACT_PLACEHOLDER,
  PRESENTATION_FILE_FORMATS,
  SLIDE_SIZE_16_9,
  SLIDE_SIZE_4_3,
  literalText,
  resolveRunText,
  transform,
  type FactSnapshot,
  type RunSource,
  type Shape,
  type Slide,
  type SlidePartRef,
} from './model.js';

const SNAPSHOT: FactSnapshot = [
  { fact_key: 'headcount', value: { type: 'number', amount: 8, unit: '人', currency: null } },
  { fact_key: 'budget.total', value: { type: 'number', amount: 600, unit: '元', currency: 'CNY' } },
  { fact_key: 'event.date', value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' } },
];

describe('R232：模板 / 工具 / 文件格式分开建模', () => {
  it('演示文件格式枚举只含办公文件格式，不含任何工具 / 模板名', () => {
    expect([...PRESENTATION_FILE_FORMATS]).toEqual(['pptx']);
    // 反面：工具与模板名**不得**混进文件格式枚举（R232 逐字要求）。
    for (const forbidden of ['meituan', 'clock', 'calendar', 'research', '美团', '时钟', '日历', '检索']) {
      expect(PRESENTATION_FILE_FORMATS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('R248：事实引用求值（缺失不当零）', () => {
  it('正例：字面量 run 原样返回', () => {
    const source: RunSource = { kind: 'literal', text: '年会筹备' };
    expect(resolveRunText(source, SNAPSHOT)).toBe('年会筹备');
  });

  it('正例：事实 run 命中快照 ⇒ 用与 pptx.ts 同口径的数值渲染', () => {
    expect(resolveRunText({ kind: 'fact', fact_key: 'headcount' }, SNAPSHOT)).toBe('8 人');
    expect(resolveRunText({ kind: 'fact', fact_key: 'budget.total' }, SNAPSHOT)).toBe('600 元 CNY');
    expect(resolveRunText({ kind: 'fact', fact_key: 'event.date' }, SNAPSHOT)).toBe(
      '2026-10-02（Asia/Shanghai）',
    );
  });

  it('反例：事实 run 查不到 ⇒ 占位文本，**绝不**退化成 0 或空串', () => {
    expect(resolveRunText({ kind: 'fact', fact_key: '不存在的键' }, SNAPSHOT)).toBe(MISSING_FACT_PLACEHOLDER);
    expect(resolveRunText({ kind: 'fact', fact_key: '不存在的键' }, SNAPSHOT)).not.toBe('0');
    expect(resolveRunText({ kind: 'fact', fact_key: '不存在的键' }, SNAPSHOT)).not.toBe('');
    expect(resolveRunText({ kind: 'fact', fact_key: '不存在的键' }, [])).toBe(MISSING_FACT_PLACEHOLDER);
  });
});

describe('尺寸与几何构造子', () => {
  it('标准尺寸为 4:3 与 16:9，且都是正数 EMU', () => {
    expect(SLIDE_SIZE_4_3.cx_emu / SLIDE_SIZE_4_3.cy_emu).toBeCloseTo(4 / 3, 3);
    expect(SLIDE_SIZE_16_9.cx_emu / SLIDE_SIZE_16_9.cy_emu).toBeCloseTo(16 / 9, 3);
    expect(SLIDE_SIZE_16_9.cx_emu).toBeGreaterThan(SLIDE_SIZE_4_3.cx_emu);
  });

  it('transform 默认不旋转不翻转，可显式覆盖', () => {
    const plain = transform(1, 2, 3, 4);
    expect(plain).toEqual({ x_emu: 1, y_emu: 2, cx_emu: 3, cy_emu: 4, rotation_deg: 0, flip_h: false, flip_v: false });
    const rotated = transform(0, 0, 10, 10, { rotation_deg: 45 });
    expect(rotated.rotation_deg).toBe(45);
  });

  it('literalText 造出单段落、无项目符号、左对齐的文本体', () => {
    const body = literalText('标题', { size_pt: 40 });
    expect(body.paragraphs).toHaveLength(1);
    expect(body.paragraphs[0]?.alignment).toBe('left');
    expect(body.paragraphs[0]?.runs[0]?.source).toEqual({ kind: 'literal', text: '标题' });
  });
});

// ---------------------------------------------------------------------------
// 模型形状：接线新增的可选字段（P-I19）
// ---------------------------------------------------------------------------

/** 一个两端绑定（且带连接点索引）的连接符。 */
function boundConnector(): Shape {
  return {
    kind: 'connector',
    shape_id: 7,
    name: 'C1',
    transform: transform(0, 0, 100, 100),
    preset: 'bentConnector3',
    outline: null,
    start_shape_id: 2,
    end_shape_id: 3,
    start_connection_site: 1,
    end_connection_site: 4,
  };
}

/** 一个不带可选字段（等价于既有数据）的连接符。 */
function legacyConnector(): Shape {
  return {
    kind: 'connector',
    shape_id: 7,
    name: 'C1',
    transform: transform(0, 0, 100, 100),
    preset: 'line',
    outline: null,
    start_shape_id: 2,
    end_shape_id: null,
  };
}

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

describe('模型形状：连接符端点（形状 id + 连接点索引）', () => {
  it('连接符端点与连接点索引经 JSON 序列化后逐字段保留', () => {
    const before = boundConnector();
    const after = JSON.parse(JSON.stringify(before)) as Shape;
    expect(after).toEqual(before);
    expect(after.kind).toBe('connector');
    if (after.kind !== 'connector') throw new Error('expected connector');
    expect(after.start_shape_id).toBe(2);
    expect(after.end_shape_id).toBe(3);
    expect(after.start_connection_site).toBe(1);
    expect(after.end_connection_site).toBe(4);
  });

  it('旧数据（不带连接点索引）序列化后不凭空多出该键（向后兼容）', () => {
    const legacy = legacyConnector();
    const after = JSON.parse(JSON.stringify(legacy)) as Shape;
    expect(after).toEqual(legacy);
    expect(has(after, 'start_connection_site')).toBe(false);
    expect(has(after, 'end_connection_site')).toBe(false);
  });
});

function slideWithRefs(): Slide {
  const notesPart: SlidePartRef = { part_path: 'ppt/notesSlides/notesSlide1.xml', relationship_id: 'rId3' };
  const commentsPart: SlidePartRef = { part_path: 'ppt/comments/comment1.xml', relationship_id: 'rId5' };
  return {
    slide_id: 1,
    layout: { master_id: 'master1', layout_id: 'title_and_content' },
    hidden: false,
    shapes: [boundConnector()],
    transition: null,
    animations: [],
    notes: literalText('备注正文'),
    notes_part: notesPart,
    comments_part: commentsPart,
  };
}

describe('模型形状：版式 id 与备注 / 批注部件引用', () => {
  it('版式引用（master_id + layout_id）经 JSON 序列化后逐字段保留', () => {
    const before = slideWithRefs();
    const after = JSON.parse(JSON.stringify(before)) as Slide;
    expect(after.layout).toEqual({ master_id: 'master1', layout_id: 'title_and_content' });
    expect(after.layout.layout_id).toBe('title_and_content');
  });

  it('备注 / 批注部件引用经 JSON 序列化后逐字段保留（路径 + 关系 id）', () => {
    const before = slideWithRefs();
    const after = JSON.parse(JSON.stringify(before)) as Slide;
    expect(after.notes_part).toEqual({ part_path: 'ppt/notesSlides/notesSlide1.xml', relationship_id: 'rId3' });
    expect(after.comments_part).toEqual({ part_path: 'ppt/comments/comment1.xml', relationship_id: 'rId5' });
  });

  it('既有幻灯片（无部件引用）序列化后不凭空多出 notes_part / comments_part', () => {
    const plain: Slide = {
      slide_id: 1,
      layout: { master_id: 'master1', layout_id: 'blank' },
      hidden: false,
      shapes: [],
      transition: null,
      animations: [],
      notes: null,
    };
    const after = JSON.parse(JSON.stringify(plain)) as Slide;
    expect(after).toEqual(plain);
    expect(has(after, 'notes_part')).toBe(false);
    expect(has(after, 'comments_part')).toBe(false);
  });
});
