/**
 * 页码（WF-053）：格式、起始、**节内重启**，以及它与"域"的关系。
 *
 * 判据里点名的一条：**某节设起始页码 1，前一节的页码不受影响**——这里用真实序列化
 * 逐字符对照来验（不是看模型对象"感觉没变"）。
 *
 * 另一条是本模块的诚实口径（R158）：本包写的是**指令**，不是"页码已算好"。
 * `pageNumberingClaim` 的输出被钉死在 `unspecified` / `directive_written` / `field_present`
 * 三档，任何"已计算 / 已验证"的说法都拿不到。
 */

import { describe, expect, it } from 'vitest';
import { DocumentModelError } from '../model/errors.js';
import { buildSectionsFixture, sectionAt, sectionWith, sectPrXml } from './testing.js';
import {
  applyPageNumberFormat,
  applyPageNumberRestart,
  applyPageNumberStart,
  clearPageNumbering,
  continuePageNumbering,
  numberFormatFieldSwitch,
  numberingMatchesField,
  pageNumberFormatOf,
  pageNumberingClaim,
  pageNumberingOf,
  pageNumberStaleHint,
  pageNumberStartOf,
  restartPageNumbering,
  restartsPageNumbering,
  setPageNumberFormat,
  setPageNumberStart,
} from './page-numbering.js';
import { PAGE_NUMBER_FORMATS, type PageNumberFormat } from './types.js';
import type { DocumentModel } from '../model/types.js';

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

/** 三节文档：每节设置都不同，方便看出"哪一节被动过"。 */
function fixture(): DocumentModel {
  return buildSectionsFixture({
    sections: [sectionWith({ columns: 1 }), sectionWith({ columns: 2 }), sectionWith({})],
    blocks_per_section: 1,
  });
}

describe('WF-053 页码格式', () => {
  it('八种格式都能设置并落成 w:pgNumType/@w:fmt', () => {
    for (const format of PAGE_NUMBER_FORMATS) {
      const section = setPageNumberFormat(sectionWith({}), format);
      expect(pageNumberFormatOf(section)).toBe(format);
      expect(sectPrXml(section)).toContain(`<w:pgNumType w:fmt="${format}"/>`);
    }
  });

  it('罗马 / 字母 / 十进制 / 中文都在名单里（枚举覆盖）', () => {
    expect([...PAGE_NUMBER_FORMATS]).toContain('decimal');
    expect([...PAGE_NUMBER_FORMATS]).toContain('upperRoman');
    expect([...PAGE_NUMBER_FORMATS]).toContain('lowerLetter');
    expect([...PAGE_NUMBER_FORMATS]).toContain('chineseCounting');
  });

  it('未知格式被拒绝（不"看着像就套"，R140）', () => {
    expectModelError(
      () => setPageNumberFormat(sectionWith({}), 'roman' as unknown as PageNumberFormat),
      'unsupported',
    );
    expectModelError(
      () => applyPageNumberFormat(fixture(), { kind: 'current', index: 0 }, 'I' as unknown as PageNumberFormat),
      'unsupported',
    );
  });

  it('没设过 ≠ decimal：读回 null，且 sectPr 里没有 pgNumType', () => {
    expect(pageNumberFormatOf(sectionWith({}))).toBeNull();
    expect(sectPrXml(sectionWith({}))).not.toContain('w:pgNumType');
  });
});

describe('WF-053 起始页码与节内重启', () => {
  it('起始页 1 = 节内重启，落成 w:start="1"', () => {
    const section = setPageNumberStart(sectionWith({}), 1);
    expect(sectPrXml(section)).toContain('w:start="1"');
    expect(restartsPageNumbering(section)).toBe(true);
    expect(pageNumberStartOf(section)).toBe(1);
  });

  it('续前节 = 不写 @w:start（不是"写 0"，R118）', () => {
    const restarted = setPageNumberStart(setPageNumberFormat(sectionWith({}), 'upperRoman'), 1);
    const continued = continuePageNumbering(restarted);
    expect(pageNumberStartOf(continued)).toBeNull();
    expect(pageNumberFormatOf(continued)).toBe('upperRoman'); // 续前节只影响编号是否重启，不动格式
    const xml = sectPrXml(continued);
    expect(xml).toContain('w:pgNumType');
    expect(xml).not.toContain('w:start=');
  });

  it('格式与起始页可以并存（整条设置可一次读回）', () => {
    let section = setPageNumberFormat(sectionWith({}), 'lowerLetter');
    section = setPageNumberStart(section, 5);
    const xml = sectPrXml(section);
    expect(xml).toContain('w:fmt="lowerLetter"');
    expect(xml).toContain('w:start="5"');
    expect(pageNumberingOf(section)).toEqual({ format: 'lowerLetter', start: 5 });
    expect(pageNumberingOf(sectionWith({}))).toBeNull();
  });

  it('节内重启的便捷入口：restartPageNumbering 等价于"起始页设为 1"', () => {
    const section = restartPageNumbering(sectionWith({}));
    expect(pageNumberStartOf(section)).toBe(1);
    expect(pageNumberingOf(section)).toEqual({ format: '', start: 1 });
  });

  it('起始页必须是非负整数', () => {
    expectModelError(() => setPageNumberStart(sectionWith({}), -1), 'invalid_node');
    expectModelError(() => setPageNumberStart(sectionWith({}), 1.5), 'invalid_node');
  });

  it('清除整条页码设置：sectPr 里连 pgNumType 都不写（与"续前节"不同）', () => {
    const section = setPageNumberStart(setPageNumberFormat(sectionWith({}), 'upperRoman'), 3);
    const cleared = clearPageNumbering(section);
    expect(pageNumberFormatOf(cleared)).toBeNull();
    expect(sectPrXml(cleared)).not.toContain('w:pgNumType');
  });

  it('pgNumType 排在 cols 之前（CT_SectPr 是序列，顺序不能乱）', () => {
    const section = setPageNumberStart(setPageNumberFormat(sectionWith({ columns: 2 }), 'decimal'), 1);
    const xml = sectPrXml(section);
    expect(xml.indexOf('w:pgNumType')).toBeGreaterThan(-1);
    expect(xml.indexOf('w:pgNumType')).toBeLessThan(xml.indexOf('w:cols'));
  });
});

describe('WF-053 判据：某节设起始页 1，**前一节的页码不受影响**', () => {
  it('改第 2 节：第 1、3 节的 sectPr 逐字符不变，且属性对象引用未换', () => {
    const model = fixture();
    const before = model.sections.map((section) => sectPrXml(section));

    const next = applyPageNumberRestart(model, { kind: 'current', index: 1 });

    expect(sectPrXml(sectionAt(next, 0))).toBe(before[0]);
    expect(sectPrXml(sectionAt(next, 2))).toBe(before[2]);
    expect(next.sections[0]).toBe(model.sections[0]);
    expect(next.sections[2]).toBe(model.sections[2]);

    expect(sectPrXml(sectionAt(next, 1))).toContain('w:start="1"');
    expect(pageNumberStartOf(sectionAt(next, 1))).toBe(1);
    expect(pageNumberStartOf(sectionAt(next, 0))).toBeNull(); // 前一节没有重启
  });

  it('格式 + 起始页一起设，也只影响那一节', () => {
    const model = fixture();
    const withFormat = applyPageNumberFormat(model, { kind: 'current', index: 2 }, 'upperRoman');
    const restarted = applyPageNumberRestart(withFormat, { kind: 'current', index: 2 });

    expect(sectPrXml(sectionAt(restarted, 0))).toBe(sectPrXml(sectionAt(model, 0)));
    expect(sectPrXml(sectionAt(restarted, 1))).toBe(sectPrXml(sectionAt(model, 1)));
    expect(sectPrXml(sectionAt(restarted, 2))).toContain('w:fmt="upperRoman"');
    expect(sectPrXml(sectionAt(restarted, 2))).toContain('w:start="1"');
  });

  it('续前节：把某节的起始页清掉，前一节仍然各自为政', () => {
    const model = applyPageNumberRestart(fixture(), { kind: 'current', index: 1 });
    const continued = applyPageNumberStart(model, { kind: 'current', index: 1 }, null);
    expect(pageNumberStartOf(sectionAt(continued, 1))).toBeNull();
    expect(sectPrXml(sectionAt(continued, 0))).toBe(sectPrXml(sectionAt(model, 0)));
  });

  it('范围 = 全文时每节都重启到 1', () => {
    const next = applyPageNumberRestart(fixture(), { kind: 'all' });
    for (const [index, section] of next.sections.entries()) {
      expect(pageNumberStartOf(section), `第 ${String(index)} 节`).toBe(1);
    }
  });
});

describe('WF-053 与"域"的关系（R158：指令 ≠ 已计算）', () => {
  it('格式 → PAGE 域的 \\* 开关映射', () => {
    expect(numberFormatFieldSwitch('decimal')).toBeNull();
    expect(numberFormatFieldSwitch('upperRoman')).toBe('\\* ROMAN');
    expect(numberFormatFieldSwitch('lowerRoman')).toBe('\\* roman');
    expect(numberFormatFieldSwitch('upperLetter')).toBe('\\* ALPHABETIC');
    expect(numberFormatFieldSwitch('lowerLetter')).toBe('\\* alphabetic');
  });

  it('节属性里的格式与域指令里的开关能对账（不一致要能发现，不假装没这回事）', () => {
    const roman = setPageNumberFormat(sectionWith({}), 'upperRoman');
    expect(numberingMatchesField(roman, 'PAGE \\* ROMAN')).toBe(true);
    expect(numberingMatchesField(roman, 'PAGE')).toBe(false);

    const decimal = setPageNumberFormat(sectionWith({}), 'decimal');
    expect(numberingMatchesField(decimal, 'PAGE')).toBe(true);
    expect(numberingMatchesField(decimal, 'PAGE \\* roman')).toBe(false);

    // 没设过格式时谈不上"一致"。
    expect(numberingMatchesField(sectionWith({}), 'PAGE')).toBe(false);
  });

  it('声明口径只有三档，且**永远**不会给出"已计算 / 已验证"', () => {
    const bare = sectionWith({});
    expect(pageNumberingClaim(bare)).toBe('unspecified');

    const configured = setPageNumberStart(sectionWith({}), 1);
    expect(pageNumberingClaim(configured)).toBe('directive_written');
    // 调用方告知页眉里确实有 PAGE 域时，也只到 field_present —— 不是"页码已算好"。
    expect(pageNumberingClaim(configured, { page_field_present: true })).toBe('field_present');

    const claims = [
      pageNumberingClaim(bare),
      pageNumberingClaim(configured),
      pageNumberingClaim(configured, { page_field_present: true }),
    ];
    for (const claim of claims) {
      expect(['unspecified', 'directive_written', 'field_present']).toContain(claim);
    }
  });

  it('域缓存过期提示：改过页码设置的节会给出提示，没设过的节不给', () => {
    expect(pageNumberStaleHint(sectionWith({}))).toBeNull();
    const hint = pageNumberStaleHint(setPageNumberStart(sectionWith({}), 1));
    expect(hint).not.toBeNull();
    expect(hint).toContain('缓存');
    expect(hint).toContain('R158');
  });
});
