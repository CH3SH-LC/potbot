/**
 * 纸张 / 方向 / 页边距 / 分栏 / 垂直对齐的单元测试（WF-045–047、050、055）。
 *
 * 判据里点名的两条在这里：
 * - **单位**：所有尺寸换算都过 `units/**`；测试直接断言 twips 值（11907 / 12240 这类），
 *   一旦有人在别处复写换算，这些数字会对不上；
 * - **横向时宽高匹配**：不是"把宽高对调就算完"——测试钉住"方向与尺寸的一致性"、
 *   "重复设置幂等"、"页边距**不**随方向对调"这三条。
 */

import { describe, expect, it } from 'vitest';
import { DocumentModelError } from '../model/errors.js';
import { lengthToTwips } from '../units/length.js';
import { defaultSectionProperties } from '../model/nodes.js';
import { INHERIT_VALUE } from '../model/attributes.js';
import { sectionWith, cm, mm, inch, marginBox, sectionAt, sectPrXml, A4 } from './testing.js';
import {
  applyOrientation,
  applyPageSetup,
  applyPageSize,
  isOrientationConsistent,
  orientSize,
  orientationOfSize,
  setOrientation,
  setPageSize,
  setPageSizePreset,
  unsetOrientation,
  unsetPageSize,
} from './page-setup.js';
import { marginsSymmetric, setGutter, setMarginEdge, setMargins, unsetMargins } from './margins.js';
import { buildSectionsFixture } from './testing.js';
import {
  applyColumnCount,
  columnCountOf,
  columnWidthsInTwips,
  customColumns,
  equalColumns,
  setColumnCount,
  setColumnLayout,
  unsetColumns,
} from './columns.js';
import { DOUBLE_COLUMN, SINGLE_COLUMN } from './types.js';
import { applyVerticalAlign, requireVerticalAlign, setVerticalAlign, unsetVerticalAlign, verticalAlignOf } from './vertical-align.js';
import { textAreaOf } from './values.js';
import { PAGE_SIZE_PRESETS, PAGE_SIZE_PRESET_NAMES } from './types.js';

function expectModelError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentModelError);
    expect((error as DocumentModelError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛 DocumentModelError(${code})，但没有抛错`);
}

describe('WF-045 纸张大小', () => {
  it('A4 预设 = 210 × 297 mm，且与模型的 A4_PAGE_SIZE 同口径', () => {
    const a4 = PAGE_SIZE_PRESETS.A4;
    expect(a4.width).toEqual(mm(210));
    expect(a4.height).toEqual(mm(297));
    expect(a4).toEqual(A4);
  });

  it('每个预设都是"纵向"形状（宽 ≤ 高），且宽高都不为零', () => {
    for (const name of PAGE_SIZE_PRESET_NAMES) {
      const size = PAGE_SIZE_PRESETS[name];
      expect(lengthToTwips(size.width), name).toBeGreaterThan(0);
      expect(isOrientationConsistent(size, 'portrait'), name).toBe(true);
    }
  });

  it('Letter = 8.5 × 11 inch，换算成 twips 是 12240 × 15840（换算走 units）', () => {
    const letter = PAGE_SIZE_PRESETS.Letter;
    expect(letter.width).toEqual(inch(8.5));
    expect(lengthToTwips(letter.width)).toBe(12240);
    expect(lengthToTwips(letter.height)).toBe(15840);
  });

  it('A4 宽 210mm → 11907 twips（本项目的 567 twips/cm 口径）', () => {
    // 注意：Word 自己写的是 11906。差 1 twip 来自"1 cm = 567 twips"这个**单位层**的约定
    // （`units/constants.ts`），不是本包的事；本包只保证"不另造一份换算"。
    // 这条断言把项目口径钉死，顺带把与 Word 的 1 twip 差异写在明面上（不是悄悄放过）。
    expect(lengthToTwips(mm(210))).toBe(11907);
    expect(lengthToTwips(mm(297))).toBe(16840);
  });

  it('自定义尺寸按给定单位原样保存（不被迫改成 pt）', () => {
    const section = setPageSize(defaultSectionProperties(), { width: cm(21), height: cm(29.7) });
    expect(section.pageSize).toEqual({ state: 'set', value: { width: cm(21), height: cm(29.7) } });
  });

  it('非法尺寸被拒绝：零 / 负 / 非有限 / 单位非法 / 超出可表达范围', () => {
    const base = defaultSectionProperties();
    expectModelError(() => setPageSize(base, { width: cm(0), height: cm(29.7) }), 'invalid_node');
    expectModelError(() => setPageSize(base, { width: cm(-1), height: cm(29.7) }), 'invalid_node');
    expectModelError(() => setPageSize(base, { width: { unit: 'cm', value: Number.NaN }, height: cm(29.7) }), 'invalid_node');
    expectModelError(
      () => setPageSize(base, { width: { unit: 'px', value: 100 } as never, height: cm(29.7) }),
      'invalid_node',
    );
    // 22 英寸 = 31680 twips 是格式域上限；23 英寸越界。
    expectModelError(() => setPageSize(base, { width: inch(23), height: inch(23) }), 'invalid_node');
  });

  it('清除纸张尺寸 = 回到"未指定"，sectPr 里不写 pgSz（不是写 0，R118）', () => {
    const withSize = setPageSizePreset(defaultSectionProperties(), 'A4');
    expect(sectPrXml(withSize)).toContain('w:pgSz');
    const cleared = unsetPageSize(withSize);
    expect(cleared.pageSize).toEqual({ state: 'unspecified' });
    expect(sectPrXml(cleared)).not.toContain('w:pgSz');
  });
});

describe('WF-046 横向 / 纵向：宽高必须与方向匹配', () => {
  it('A4 纵向 → 横向：宽高互换，orient 落成 landscape', () => {
    const portrait = setPageSizePreset(defaultSectionProperties(), 'A4');
    const landscape = setOrientation(portrait, 'landscape');
    const size = landscape.pageSize;
    expect(size.state).toBe('set');
    if (size.state !== 'set') throw new Error('unreachable');
    expect(size.value.width).toEqual(mm(297));
    expect(size.value.height).toEqual(mm(210));
    expect(landscape.orientation).toEqual({ state: 'set', value: 'landscape' });
    expect(sectPrXml(landscape)).toContain('w:orient="landscape"');
  });

  it('重复设置同一方向**幂等**：第二次不改动尺寸（不会来回翻转）', () => {
    const portrait = setPageSizePreset(defaultSectionProperties(), 'A4');
    const once = setOrientation(portrait, 'landscape');
    const twice = setOrientation(once, 'landscape');
    expect(twice.pageSize).toBe(once.pageSize);
    expect(sectPrXml(twice)).toBe(sectPrXml(once));
  });

  it('切回纵向能回到原尺寸', () => {
    const portrait = setPageSizePreset(defaultSectionProperties(), 'A4');
    const roundTrip = setOrientation(setOrientation(portrait, 'landscape'), 'portrait');
    const size = roundTrip.pageSize;
    if (size.state !== 'set') throw new Error('unreachable');
    expect(size.value).toEqual(A4);
  });

  it('**页边距不随方向对调**：切横向后 left 还是左边那条边，变的是正文区', () => {
    const portrait = setMargins(
      setPageSizePreset(defaultSectionProperties(), 'A4'),
      marginBox(2, 3, 2, 3),
    );
    const landscape = setOrientation(portrait, 'landscape');

    // 四边仍是同名边（未被对调）
    const before = portrait.margins;
    const after = landscape.margins;
    if (before.state !== 'set' || after.state !== 'set') throw new Error('unreachable');
    expect(after.value).toEqual(before.value);
    expect(after.value.left).toEqual(cm(3));

    // 正文区变了：横向 = (297−30−30)mm 宽 × (210−20−20)mm 高
    const size = landscape.pageSize;
    if (size.state !== 'set') throw new Error('unreachable');
    const area = textAreaOf(size.value, after.value);
    // 断言落在 **twips** 上：mm 值会带一点量化尾巴（297mm→16840 twips、30mm→1701 twips，
    // 相减回 mm 是 237.0017…），这是"1 cm = 567 twips"整数口径的必然结果，不是错误。
    expect(lengthToTwips(area.width)).toBe(13438);
    expect(lengthToTwips(area.height)).toBe(9639);
    expect(area.width.unit).toBe('mm'); // 单位仍是纸张的单位，没被悄悄换成 pt/twips

    // 正文区的长宽比与纸的长宽比**不相等**：边距不随方向翻，所以正文区不可能也是同一比例。
    // 这条正是"横向不是简单把宽高对调"的算术证据。
    const paperRatio = lengthToTwips(size.value.width) / lengthToTwips(size.value.height);
    const areaRatio = lengthToTwips(area.width) / lengthToTwips(area.height);
    expect(areaRatio).not.toBeCloseTo(paperRatio, 3);
  });

  it('先设方向、后设纸张：方向字段被同步到与新尺寸一致（不留下矛盾数据）', () => {
    const landscapeNoSize = setOrientation(defaultSectionProperties(), 'landscape');
    expect(landscapeNoSize.pageSize).toEqual({ state: 'unspecified' }); // 不臆造尺寸

    const withA4 = setPageSize(landscapeNoSize, A4);
    expect(withA4.orientation).toEqual({ state: 'set', value: 'portrait' });
    expect(sectPrXml(withA4)).toContain('w:orient="portrait"');
  });

  it('未指定尺寸时设置方向 + fallback_size：连尺寸一起摆正（调用方显式要求才猜）', () => {
    const section = setOrientation(defaultSectionProperties(), 'landscape', { fallback_size: A4 });
    const size = section.pageSize;
    if (size.state !== 'set') throw new Error('unreachable');
    expect(size.value).toEqual({ width: mm(297), height: mm(210) });
  });

  it('orientSize / orientationOfSize 的语义：正方形两边都算一致', () => {
    const square = { width: cm(20), height: cm(20) };
    expect(orientationOfSize(square)).toBeNull();
    expect(isOrientationConsistent(square, 'portrait')).toBe(true);
    expect(isOrientationConsistent(square, 'landscape')).toBe(true);
    expect(orientSize(square, 'landscape')).toBe(square); // 幂等、原对象
  });

  it('全文改横向时**逐节**摆正各自的尺寸（不是把某一节的尺寸复制给所有节）', () => {
    const model = buildSectionsFixture({
      sections: [
        sectionWith({ size: A4, orientation: 'portrait' }),
        sectionWith({ size: PAGE_SIZE_PRESETS.A3, orientation: 'portrait' }),
      ],
      blocks_per_section: 1,
    });
    const next = applyOrientation(model, { kind: 'all' }, 'landscape');
    const first = next.sections[0]?.pageSize;
    const second = next.sections[1]?.pageSize;
    if (first?.state !== 'set' || second?.state !== 'set') throw new Error('unreachable');
    expect(first.value).toEqual({ width: mm(297), height: mm(210) }); // A4 横向
    expect(second.value).toEqual({ width: mm(420), height: mm(297) }); // A3 横向
  });

  it('未知方向被拒绝（unsupported）', () => {
    expectModelError(
      () => setOrientation(defaultSectionProperties(), 'sideways' as never),
      'unsupported',
    );
  });

  it('清除方向不动纸张（清方向不该顺手改尺寸）', () => {
    const landscape = setOrientation(setPageSizePreset(defaultSectionProperties(), 'A4'), 'landscape');
    const cleared = unsetOrientation(landscape);
    expect(cleared.orientation).toEqual({ state: 'unspecified' });
    expect(cleared.pageSize).toEqual(landscape.pageSize);
    expect(sectPrXml(cleared)).toContain('w:w="16840"');
  });
});

describe('WF-047 页边距与装订线', () => {
  it('四边 + 装订线都能设置并落成 pgMar', () => {
    const section = setMargins(defaultSectionProperties(), marginBox(2.54, 3.18, 2.54, 3.18, 1));
    const xml = sectPrXml(section);
    expect(xml).toContain('w:pgMar');
    expect(xml).toContain('w:gutter="567"'); // 1cm = 567 twips
    expect(xml).toContain(`w:left="1803"`); // 3.18cm = 1803 twips（走 units，不自己算）
  });

  it('只改一条边：其余各边保留', () => {
    const base = setMargins(defaultSectionProperties(), marginBox(2, 3, 2, 3));
    const changed = setMarginEdge(base, 'left', cm(4));
    const margins = changed.margins;
    if (margins.state !== 'set') throw new Error('unreachable');
    expect(margins.value.left).toEqual(cm(4));
    expect(margins.value.right).toEqual(cm(3));
    expect(margins.value.top).toEqual(cm(2));
  });

  it('尚未设过页边距时"只改一条边"被拒绝（不把未指定混成 0，R118）', () => {
    expectModelError(() => setMarginEdge(defaultSectionProperties(), 'top', cm(2)), 'unsupported');
    expectModelError(() => setGutter(defaultSectionProperties(), cm(1)), 'unsupported');
  });

  it('装订线单独可改，不影响四边', () => {
    const base = setMargins(defaultSectionProperties(), marginBox(2, 3, 2, 3));
    const withGutter = setGutter(base, cm(1.5));
    const margins = withGutter.margins;
    if (margins.state !== 'set') throw new Error('unreachable');
    expect(margins.value.gutter).toEqual(cm(1.5));
    expect(margins.value.top).toEqual(cm(2));
  });

  it('页边距比纸还大 → 操作前拒绝（不在消费端排版时才炸）', () => {
    const section = setPageSizePreset(defaultSectionProperties(), 'A4'); // 210mm 宽
    expectModelError(() => setMargins(section, marginBox(2, 11, 2, 11)), 'invalid_node');
  });

  it('负页边距被拒绝', () => {
    expectModelError(
      () => setMargins(defaultSectionProperties(), { top: cm(-1), right: cm(2), bottom: cm(2), left: cm(2), gutter: cm(0) }),
      'invalid_node',
    );
  });

  it('对称性判断在共同刻度上做（mm 与 cm 混用也能判对）', () => {
    expect(marginsSymmetric(marginBox(2, 3, 2, 3))).toEqual({ horizontal: true, vertical: true });
    expect(
      marginsSymmetric({ top: mm(20), right: cm(2), bottom: mm(20), left: cm(2), gutter: cm(0) }),
    ).toEqual({ horizontal: true, vertical: true });
    expect(marginsSymmetric(marginBox(2, 3, 2, 4))).toEqual({ horizontal: false, vertical: true });
  });

  it('清除页边距 = 回到未指定，sectPr 不再写 pgMar', () => {
    const section = setMargins(defaultSectionProperties(), marginBox(2, 3, 2, 3));
    expect(sectPrXml(unsetMargins(section))).not.toContain('w:pgMar');
  });

  it('换页边距能覆盖"清除覆盖回继承"的旧状态（不把 inherit 当值）', () => {
    const inherited = { ...defaultSectionProperties(), margins: INHERIT_VALUE };
    const filled = setMargins(inherited, marginBox(2, 2, 2, 2));
    expect(filled.margins.state).toBe('set');
  });
});

describe('WF-050 分栏', () => {
  it('单栏 / 双栏落成 w:cols/@w:num', () => {
    const single = setPageSizePreset(defaultSectionProperties(), 'A4');
    expect(sectPrXml(single)).not.toContain('w:cols');
    const two = applyColumnCount(
      buildSectionsFixture({ sections: [single], blocks_per_section: 1 }),
      { kind: 'current', index: 0 },
      2,
    );
    expect(sectPrXml(sectionAt(two, 0))).toContain('w:cols w:num="2"');
  });

  it('栏数范围 1–45：0 / 46 / 非整数都拒绝', () => {
    const base = defaultSectionProperties();
    expectModelError(
      () => applyColumnCount(buildSectionsFixture({ sections: [base], blocks_per_section: 1 }), { kind: 'current', index: 0 }, 0),
      'invalid_node',
    );
    expectModelError(
      () => applyColumnCount(buildSectionsFixture({ sections: [base], blocks_per_section: 1 }), { kind: 'current', index: 0 }, 46),
      'invalid_node',
    );
    expectModelError(
      () => applyColumnCount(buildSectionsFixture({ sections: [base], blocks_per_section: 1 }), { kind: 'current', index: 0 }, 2.5),
      'invalid_node',
    );
    expectModelError(() => equalColumns(0), 'invalid_node');
    expectModelError(() => customColumns([]), 'invalid_node');
  });

  it('自定义栏宽/间距算出的是 twips（将来 w:col 要填的值），换算走 units', () => {
    const layout = customColumns([
      { width: cm(6), space: cm(1) },
      { width: cm(8), space: cm(2) },
    ]);
    expect(columnWidthsInTwips(layout)).toEqual([
      { width: 3402, space: 567 },
      { width: 4536, space: 1134 },
    ]);
  });

  it('等宽栏不给具体宽度（宽度由消费端按正文区均分，不在这里猜）', () => {
    expect(columnWidthsInTwips(equalColumns(3))).toEqual([]);
  });

  it('单栏 / 双栏两个常量可用，且清除栏数回到"未指定"', () => {
    expect(columnCountOf(SINGLE_COLUMN)).toBe(1);
    expect(columnCountOf(DOUBLE_COLUMN)).toBe(2);

    const two = setColumnCount(defaultSectionProperties(), 2);
    expect(two.columns).toEqual({ state: 'set', value: 2 });
    expect(unsetColumns(two).columns).toEqual({ state: 'unspecified' });
    expect(sectPrXml(unsetColumns(two))).not.toContain('w:cols');
  });

  it('自定义栏宽放不下时拒绝', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ size: A4, margins: marginBox(2, 2, 2, 2) })],
      blocks_per_section: 1,
    });
    // A4 宽 210mm − 左右各 2cm = 170mm = 9639 twips 可用；给两栏各 10cm 必然放不下。
    expectModelError(
      () => setColumnLayout(model, 0, customColumns([{ width: cm(10), space: cm(1) }, { width: cm(10), space: cm(1) }])),
      'invalid_node',
    );
  });

  it('自定义栏宽放得下时通过，且栏数字段同步写上（w:cols 不能只有子元素）', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ size: A4, margins: marginBox(2, 2, 2, 2) })],
      blocks_per_section: 1,
    });
    // 可用宽度 9639 twips ≈ 17cm；两栏各 7cm + 间距 1cm = 16cm，放得下。
    const next = setColumnLayout(model, 0, customColumns([{ width: cm(7), space: cm(1) }, { width: cm(7), space: cm(1) }]));
    const section = sectionAt(next, 0);
    expect(section.columns).toEqual({ state: 'set', value: 2 });
    expect(sectPrXml(section)).toContain('w:cols w:num="2"');
  });
});

describe('WF-055 页内垂直对齐（作用范围为节）', () => {
  it('四个取值都能落成 w:vAlign，且互斥不是开关组合', () => {
    for (const align of ['top', 'center', 'bottom', 'both'] as const) {
      const section = setVerticalAlign(defaultSectionProperties(), align);
      expect(sectPrXml(section)).toContain(`w:vAlign w:val="${align}"`);
      expect(verticalAlignOf(section)).toBe(align);
    }
  });

  it('未设置 ≠ top：清除后读回 null，sectPr 里没有 vAlign', () => {
    const cleared = unsetVerticalAlign(setVerticalAlign(defaultSectionProperties(), 'center'));
    expect(verticalAlignOf(cleared)).toBeNull();
    expect(sectPrXml(cleared)).not.toContain('w:vAlign');
    expect(verticalAlignOf(defaultSectionProperties())).toBeNull();
  });

  it('作用范围落到节上：按节索引设置只影响那一节', () => {
    const model = buildSectionsFixture({
      sections: [defaultSectionProperties(), defaultSectionProperties()],
      blocks_per_section: 1,
    });
    const next = applyVerticalAlign(model, { kind: 'current', index: 1 }, 'bottom');
    expect(sectPrXml(sectionAt(next, 0))).not.toContain('w:vAlign');
    expect(sectPrXml(sectionAt(next, 1))).toContain('w:vAlign w:val="bottom"');
  });

  it('未知取值被拒绝', () => {
    expectModelError(() => requireVerticalAlign('middle'), 'unsupported');
  });
});

describe('R136 原子性：复合页面设置失败时整条不生效', () => {
  it('页边距放不下 → 抛错，且原模型的节**引用未变**', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ size: A4 }), sectionWith({ size: A4 })],
      blocks_per_section: 1,
    });
    const before = model.sections[0];

    expectModelError(
      () =>
        applyPageSetup(model, { kind: 'all' }, {
          orientation: 'landscape',
          margins: marginBox(2, 20, 2, 20), // 横向 210mm 高 − 上下各 20cm → 正文区为负
        }),
      'invalid_node',
    );
    expect(model.sections[0]).toBe(before);
  });

  it('复合生效时三样一起落到同一节（不是分三步各写一次），且只落这一节', () => {
    const model = buildSectionsFixture({
      sections: [defaultSectionProperties(), sectionWith({ size: A4 })],
      blocks_per_section: 1,
    });
    const next = applyPageSetup(model, { kind: 'current', index: 0 }, {
      size: A4,
      orientation: 'landscape',
      margins: marginBox(2, 2, 2, 2),
    });
    const section = sectionAt(next, 0);
    expect(section.pageSize).toEqual({ state: 'set', value: { width: mm(297), height: mm(210) } });
    expect(section.orientation).toEqual({ state: 'set', value: 'landscape' });
    expect(section.margins.state).toBe('set');
    expect(next.sections[1]).toBe(model.sections[1]);
  });
});
