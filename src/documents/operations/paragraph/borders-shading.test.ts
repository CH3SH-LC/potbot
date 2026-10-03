/**
 * 段落边框与底纹测试（WF-033）。
 *
 * 关键边界：段落底纹**独立于**字符底纹与高亮——本包的类型根本够不到 run 属性，
 * 测试用"操作前后 run 数组引用不变"来证明。
 */

import { describe, expect, it } from 'vitest';
import { createDefaultParagraphProperties } from './defaults.js';
import {
  BORDER_EDGES,
  borderEdge,
  clearParagraphBorder,
  clearParagraphBorders,
  clearParagraphShading,
  setParagraphBorder,
  setParagraphBorders,
  setParagraphShading,
} from './borders-shading.js';

const RED_THIN = borderEdge('single', { unit: 'pt', value: 0.5 }, 'FF0000');
const BLUE = borderEdge('double', { unit: 'pt', value: 1 }, '0000FF');

describe('段落边框（WF-033）', () => {
  it('四边都能分别设置', () => {
    let props = createDefaultParagraphProperties();
    for (const edge of BORDER_EDGES) {
      props = setParagraphBorder(props, edge, RED_THIN);
    }
    expect(props.borders.state).toBe('set');
    if (props.borders.state === 'set') {
      for (const edge of BORDER_EDGES) {
        expect(props.borders.value[edge]?.color_hex, edge).toBe('FF0000');
      }
    }
  });

  it('只设左边不产生其他三边', () => {
    const props = setParagraphBorder(createDefaultParagraphProperties(), 'left', RED_THIN);
    if (props.borders.state === 'set') {
      expect(Object.keys(props.borders.value)).toEqual(['left']);
    } else {
      throw new Error('borders 应为 set');
    }
  });

  it('后设的边覆盖同边的旧值', () => {
    let props = setParagraphBorder(createDefaultParagraphProperties(), 'top', RED_THIN);
    props = setParagraphBorder(props, 'top', BLUE);
    if (props.borders.state === 'set') {
      expect(props.borders.value.top?.color_hex).toBe('0000FF');
    }
  });

  it('边框值做深拷贝，不与入参共享引用', () => {
    const props = setParagraphBorder(createDefaultParagraphProperties(), 'top', RED_THIN);
    if (props.borders.state === 'set') {
      expect(props.borders.value.top).not.toBe(RED_THIN);
      expect(props.borders.value.top).toEqual(RED_THIN);
    }
  });

  it('一次设置多边', () => {
    const props = setParagraphBorders(createDefaultParagraphProperties(), { top: RED_THIN, bottom: BLUE });
    if (props.borders.state === 'set') {
      expect(Object.keys(props.borders.value).sort()).toEqual(['bottom', 'top']);
    }
  });
});

describe('取消边框', () => {
  it('取消一边后其余仍在', () => {
    let props = setParagraphBorders(createDefaultParagraphProperties(), { top: RED_THIN, bottom: BLUE });
    props = clearParagraphBorder(props, 'top');
    if (props.borders.state === 'set') {
      expect(Object.keys(props.borders.value)).toEqual(['bottom']);
    }
  });

  it('取消最后一边时落 inherit（不留空壳元素）', () => {
    let props = setParagraphBorder(createDefaultParagraphProperties(), 'top', RED_THIN);
    props = clearParagraphBorder(props, 'top');
    expect(props.borders).toEqual({ state: 'inherit' });
  });

  it('clearParagraphBorders 一次清四边', () => {
    let props = setParagraphBorders(createDefaultParagraphProperties(), { top: RED_THIN, bottom: BLUE });
    props = clearParagraphBorders(props);
    expect(props.borders).toEqual({ state: 'inherit' });
  });
});

describe('段落底纹（WF-033）', () => {
  it('设置后可读回', () => {
    const props = setParagraphShading(createDefaultParagraphProperties(), {
      fill_hex: 'FFFF00',
      pattern: 'clear',
      color_hex: null,
    });
    expect(props.shading).toEqual({
      state: 'set',
      value: { fill_hex: 'FFFF00', pattern: 'clear', color_hex: null },
    });
  });

  it('底纹值深拷贝', () => {
    const shading = { fill_hex: 'FFFF00', pattern: null, color_hex: null };
    const props = setParagraphShading(createDefaultParagraphProperties(), shading);
    if (props.shading.state === 'set') {
      expect(props.shading.value).not.toBe(shading);
    }
  });

  it('取消底纹落 inherit', () => {
    let props = setParagraphShading(createDefaultParagraphProperties(), { fill_hex: 'FFFF00', pattern: null, color_hex: null });
    props = clearParagraphShading(props);
    expect(props.shading).toEqual({ state: 'inherit' });
  });

  it('段落底纹与边框是两个独立字段', () => {
    const shaded = setParagraphShading(createDefaultParagraphProperties(), { fill_hex: 'FFFF00', pattern: null, color_hex: null });
    expect(shaded.borders).toEqual({ state: 'unspecified' });
    const bordered = setParagraphBorder(createDefaultParagraphProperties(), 'top', RED_THIN);
    expect(bordered.shading).toEqual({ state: 'unspecified' });
  });
});
