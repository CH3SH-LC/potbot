/**
 * 长度换算判据测试（R127/R128/R131）。
 *
 * 钉死本项目采用的换算口径：1 pt = 20 twips、1 inch = 1440、1 cm = 567（Word 约定）、
 * 1 mm = 567/10。
 */

import { describe, expect, it } from 'vitest';
import {
  isLengthUnit,
  lengthToPoints,
  lengthToTwips,
  pointsToTwips,
  twipsToLength,
  twipsToPoints,
} from './length.js';
import { TWIPS_PER_CM, TWIPS_PER_INCH, TWIPS_PER_POINT } from './constants.js';

describe('长度 → twips', () => {
  it('常量口径', () => {
    expect(TWIPS_PER_POINT).toBe(20);
    expect(TWIPS_PER_INCH).toBe(1440);
    expect(TWIPS_PER_CM).toBe(567);
  });

  it('pt → twips', () => {
    expect(lengthToTwips({ unit: 'pt', value: 20 })).toBe(400);
    expect(lengthToTwips({ unit: 'pt', value: 18 })).toBe(360);
    expect(lengthToTwips({ unit: 'pt', value: 12 })).toBe(240);
    expect(lengthToTwips({ unit: 'pt', value: 0 })).toBe(0);
  });

  it('cm → twips（2 cm = 1134）', () => {
    expect(lengthToTwips({ unit: 'cm', value: 2 })).toBe(1134);
    expect(lengthToTwips({ unit: 'cm', value: 1 })).toBe(567);
  });

  it('mm → twips 走有理数，10 mm 恰好 567', () => {
    expect(lengthToTwips({ unit: 'mm', value: 10 })).toBe(567);
  });

  it('inch → twips', () => {
    expect(lengthToTwips({ unit: 'inch', value: 1 })).toBe(1440);
    expect(lengthToTwips({ unit: 'inch', value: 0.5 })).toBe(720);
  });

  it('twips 原样通过', () => {
    expect(lengthToTwips({ unit: 'twips', value: 400 })).toBe(400);
  });
});

describe('长度 → pt', () => {
  it('20pt 仍是 20pt；2cm 约 56.7pt', () => {
    expect(lengthToPoints({ unit: 'pt', value: 20 })).toBe(20);
    expect(lengthToPoints({ unit: 'cm', value: 2 })).toBe(56.7);
  });
});

describe('twips → 长度', () => {
  it('反解回原单位的长度', () => {
    expect(twipsToLength(400, 'pt')).toEqual({ unit: 'pt', value: 20 });
    expect(twipsToLength(1134, 'cm')).toEqual({ unit: 'cm', value: 2 });
    expect(twipsToLength(1440, 'inch')).toEqual({ unit: 'inch', value: 1 });
  });

  it('往返稳定：pt/cm/inch 整数点', () => {
    for (const [value, unit] of [[20, 'pt'], [2, 'cm'], [1, 'inch']] as const) {
      const twips = lengthToTwips({ unit, value });
      expect(twipsToLength(twips, unit)).toEqual({ unit, value });
    }
  });
});

describe('便捷入口与单位守卫', () => {
  it('pointsToTwips / twipsToPoints', () => {
    expect(pointsToTwips(12)).toBe(240);
    expect(twipsToPoints(240)).toBe(12);
  });

  it('isLengthUnit', () => {
    for (const unit of ['pt', 'mm', 'cm', 'inch', 'twips']) {
      expect(isLengthUnit(unit)).toBe(true);
    }
    expect(isLengthUnit('px')).toBe(false);
    expect(isLengthUnit('')).toBe(false);
  });
});

describe('R131：不存在"一个数字到处复用"', () => {
  it('12 这个数在三种单位下是三个不同的量', () => {
    expect(lengthToTwips({ unit: 'pt', value: 12 })).toBe(240);
    expect(lengthToTwips({ unit: 'cm', value: 12 })).toBe(6804);
    expect(lengthToTwips({ unit: 'twips', value: 12 })).toBe(12);
  });
});
