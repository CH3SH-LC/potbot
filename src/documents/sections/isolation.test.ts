/**
 * R108 判据的正面与反面证据：**局部页面设置不得污染其他节**（WF-046/049）。
 *
 * 为什么这个文件单独存在：这是本包**最容易做错**的地方。错法不是"崩了"，而是
 * "看起来对"——`sections` 数组长度对、被改的那节也对，但别的节的属性在中间某处
 * 被顺手重建/错位了。所以这里用**三层**证据同时钉：
 *
 * 1. **对象引用相等**：未命中的节连对象都是同一个（最强）；
 * 2. **生产序列化的 XML 字符串逐字符相等**：真导出器渲染出来的 `w:sectPr` 一模一样；
 * 3. **反向对照（正例/反例）**：故意做一个"会污染"的操作，证明这套断言有判别力
 *    ——如果断言太松，反例就不会被抓住。
 */

import { describe, expect, it } from 'vitest';
import {
  allSectPrXml,
  blockAt,
  buildSectionsFixture,
  cm,
  mm,
  marginBox,
  sectionAt,
  sectionWith,
  sectPrXml,
} from './testing.js';
import { applyMargins, applyOrientation, applyPageSetup, isOrientationConsistent, orientSize } from './page-setup.js';
import { applyColumnCount, setColumnLayout, customColumns } from './columns.js';
import { applyVerticalAlign } from './vertical-align.js';
import { applyPageNumberRestart, applyPageNumberFormat } from './page-numbering.js';
import { insertSectionBreak, removeSectionBreak, checkSectionMarkers, sectionStartTypeOf } from './section-breaks.js';
import { updateSections } from './targets.js';
import type { DocumentModel } from '../model/types.js';

/** 三节夹具：三节的页面设置**互不相同**，好让"污染"一定看得出来。 */
function threeSectionFixture(): DocumentModel {
  return buildSectionsFixture({
    sections: [
      sectionWith({ size: { width: mm(210), height: mm(297) }, orientation: 'portrait', margins: marginBox(2, 3, 2, 3) }),
      sectionWith({ size: { width: mm(210), height: mm(297) }, orientation: 'portrait', margins: marginBox(1.5, 2.5, 1.5, 2.5) }),
      sectionWith({ size: { width: mm(297), height: mm(420) }, orientation: 'portrait', margins: marginBox(3, 2, 3, 2), columns: 2, titlePage: true }),
    ],
    blocks_per_section: 2,
  });
}

describe('R108：给第 2 节设横向 / 自定义页边距，第 1、3 节不变', () => {
  it('改第 2 节方向：第 1、3 节的 sectPr XML 逐字符不变', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    const next = applyOrientation(model, { kind: 'current', index: 1 }, 'landscape');

    const after = allSectPrXml(next);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    // 被改的那一节**必须**真的变了，否则上面的"不变"是假通过。
    expect(after[1]).not.toBe(before[1]);
  });

  it('改第 2 节方向：第 1、3 节的属性对象引用都没换（强于逐字节相等）', () => {
    const model = threeSectionFixture();
    const next = applyOrientation(model, { kind: 'current', index: 1 }, 'landscape');

    expect(next.sections[0]).toBe(model.sections[0]);
    expect(next.sections[2]).toBe(model.sections[2]);
    expect(next.sections[1]).not.toBe(model.sections[1]);
  });

  it('改第 2 节页边距：第 1、3 节的 sectPr XML 逐字符不变', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    const next = applyMargins(model, { kind: 'current', index: 1 }, marginBox(4, 4, 4, 4, 0.5));

    const after = allSectPrXml(next);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(next.sections[0]).toBe(model.sections[0]);
    expect(next.sections[2]).toBe(model.sections[2]);
  });

  it('一次复合设置（横向 + 页边距 + 2 栏 + 居中）也只动第 2 节', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    let next = applyPageSetup(model, { kind: 'current', index: 1 }, {
      orientation: 'landscape',
      margins: marginBox(2, 2, 2, 2),
    });
    next = applyColumnCount(next, { kind: 'current', index: 1 }, 2);
    next = applyVerticalAlign(next, { kind: 'current', index: 1 }, 'center');

    const after = allSectPrXml(next);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(next.sections[0]).toBe(model.sections[0]);
    expect(next.sections[2]).toBe(model.sections[2]);
    expect(sectionAt(next, 1).columns).toEqual({ state: 'set', value: 2 });
  });

  it('范围 = 全文时，三节都被改（范围语义确实生效，不是"只改第一个"）', () => {
    const model = threeSectionFixture();
    const next = applyOrientation(model, { kind: 'all' }, 'landscape');
    for (const [index, section] of next.sections.entries()) {
      expect(section.orientation, `第 ${String(index)} 节`).toEqual({ state: 'set', value: 'landscape' });
      const size = section.pageSize;
      expect(size.state).toBe('set');
      if (size.state === 'set') {
        expect(isOrientationConsistent(size.value, 'landscape')).toBe(true);
      }
    }
  });

  it('页码：某节设起始页 1，前一节的 sectPr 逐字符不变', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    const next = applyPageNumberRestart(model, { kind: 'current', index: 1 });

    const after = allSectPrXml(next);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(next.sections[0]).toBe(model.sections[0]);
  });

  it('页码格式与起始页可以并存，且不碰别节', () => {
    const model = threeSectionFixture();
    const withFormat = applyPageNumberFormat(model, { kind: 'current', index: 1 }, 'upperRoman');
    const restarted = applyPageNumberRestart(withFormat, { kind: 'current', index: 1 });
    expect(sectionAt(restarted, 1).pageNumbering).toEqual({ format: 'upperRoman', start: 1 });
    expect(restarted.sections[0]).toBe(model.sections[0]);
    expect(restarted.sections[2]).toBe(model.sections[2]);
  });

  it('指定若干节（indices）时只碰那几节', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);
    const next = applyOrientation(model, { kind: 'indices', indices: [0, 2] }, 'landscape');

    const after = allSectPrXml(next);
    expect(after[1]).toBe(before[1]);
    expect(next.sections[1]).toBe(model.sections[1]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[2]).not.toBe(before[2]);
  });
});

describe('R108 反例：这些写法**会**污染，本包的断言必须抓得住', () => {
  it('反例一：范围写宽了（把三节都设成横向）—— 逐字符断言抓得住', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    // 一个"范围写错"的实现：本想只改第 2 节，实际改了全文。
    const tooWide = applyOrientation(model, { kind: 'all' }, 'landscape');

    expect(allSectPrXml(tooWide)[0]).not.toBe(before[0]);
    expect(allSectPrXml(tooWide)[2]).not.toBe(before[2]);
    // 对照：正确的范围下这两节逐字符不变。
    const correct = applyOrientation(model, { kind: 'current', index: 1 }, 'landscape');
    expect(allSectPrXml(correct)[0]).toBe(before[0]);
    expect(allSectPrXml(correct)[2]).toBe(before[2]);
  });

  it('反例二：值一样但把每节都重建（引用变了）—— 逐字符抓不住，引用断言抓得住', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    // 这是最难发现的一类：`{...section}` 重建后**值完全一样**，
    // 逐字符断言会放过它；但"未命中的节必须还是同一个对象"这条能抓住。
    const rebuilt = updateSections(model, { kind: 'all' }, (section) => ({ ...section }));

    expect(allSectPrXml(rebuilt)).toEqual(before);
    expect(rebuilt.sections[0] === model.sections[0]).toBe(false);
    expect(rebuilt.sections[2] === model.sections[2]).toBe(false);
  });

  it('反例三：横向只写 orient、宽高不动 —— 一致性校验必须判为不一致', () => {
    const portrait = { width: mm(210), height: mm(297) };
    expect(isOrientationConsistent(portrait, 'landscape')).toBe(false);
    expect(isOrientationConsistent(orientSize(portrait, 'landscape'), 'landscape')).toBe(true);
  });
});

describe('插入 / 删除分节符时的节隔离（WF-049 + R108）', () => {
  it('在中间插入分节符后，前面各节的对象引用与 sectPr 都不变', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);
    // 正文下标 2 = 第 2 节的第一个段落；在它之后插入一个"奇数页"分节符。
    const target = blockAt(model, 2);

    const next = insertSectionBreak(model, target.id, 'oddPage');

    expect(checkSectionMarkers(next)).toEqual([]);
    expect(next.sections.length).toBe(model.sections.length + 1);
    const after = allSectPrXml(next);
    // 第 1 节（下标 0）不变；被切开的第 2 节（下标 1）对象与 sectPr 都不变（只是提前结束）；
    // 原本的第 3 节被推到下标 3，属性对象原样搬运。
    expect(next.sections[0]).toBe(model.sections[0]);
    expect(after[0]).toBe(before[0]);
    expect(next.sections[1]).toBe(model.sections[1]);
    expect(after[1]).toBe(before[1]);
    expect(next.sections[3]).toBe(model.sections[2]);
    expect(after[3]).toBe(before[2]);
    // 新节的分节符类型是请求的那个（w:type 属于它开始的那一节）。
    expect(sectionStartTypeOf(next, 2)).toBe('oddPage');
    expect(sectionStartTypeOf(next, 1)).toBeNull();
  });

  it('删除刚插入的分节符：节数回到原值，标记重新自洽，其余节的引用样式保留', () => {
    const model = threeSectionFixture();
    const target = blockAt(model, 2);

    const inserted = insertSectionBreak(model, target.id, 'continuous');
    const removed = removeSectionBreak(inserted, target.id);

    expect(checkSectionMarkers(removed)).toEqual([]);
    expect(removed.sections.length).toBe(model.sections.length);
    // 逐字段等价（不要求引用相等：插入时新增过一个属性副本，这是 Word 的行为）。
    expect(removed.sections.map((section) => sectPrXml(section))).toEqual(
      model.sections.map((section) => sectPrXml(section)),
    );
  });
});

describe('自定义栏宽走附加项通道时也不污染别节', () => {
  it('给第 3 节设自定义栏宽：第 1、2 节的节属性与 sectPr 都不变', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    const next = setColumnLayout(
      model,
      2,
      customColumns([
        { width: cm(6), space: cm(1) },
        { width: cm(6), space: cm(1) },
      ]),
    );

    const after = allSectPrXml(next);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(next.sections[0]).toBe(model.sections[0]);
    expect(next.sections[1]).toBe(model.sections[1]);
  });

  /**
   * **缺口钉（characterization test）**：自定义栏宽目前**只落在模型的附加项通道里**，
   * 现有导出器读不到它，因此这一节的 `w:sectPr` 字符串**与改之前完全一样**。
   *
   * 这条断言是**故意**写成"相等"的：它把"尚未接线"这个事实钉成可执行的证据。
   * 接线波次（D50 及其后）把 `w:col` 写出来后，**这条会变红**——那时应当把它改成
   * "不等"并补上逐列宽度的断言，而不是把缺口留在注释里。
   */
  it('缺口钉：自定义栏宽尚未接线到 w:sectPr（接线后本断言应变红并改写）', () => {
    const model = threeSectionFixture();
    const before = sectPrXml(sectionAt(model, 2));

    const next = setColumnLayout(
      model,
      2,
      customColumns([
        { width: cm(6), space: cm(1) },
        { width: cm(6), space: cm(1) },
      ]),
    );

    expect(sectPrXml(sectionAt(next, 2))).toBe(before);
  });
});
