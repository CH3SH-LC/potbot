/**
 * 字符属性级联测试（R122/R124 的字符侧，WF-037/038）。
 *
 * 判据：字符样式链与直接格式的覆盖方向正确、来源层标得对、坏链有限终止。
 */

import { describe, expect, it } from 'vitest';
import type { StyleDefinition, StyleTable } from '../model/types.js';
import { TOGGLE_ON } from '../model/types.js';
import { resolveRunCascade } from './run-cascade.js';
import { modifyNamedStyle } from './named.js';

function style(style_id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'character',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...extra,
  };
}

describe('字符样式级联', () => {
  it('basedOn 链：祖先先应用，后代覆盖', () => {
    const table: StyleTable = {
      styles: [
        style('Base', { run_properties: { bold: TOGGLE_ON } }),
        style('Strong', { based_on: 'Base', run_properties: { color: { state: 'set', value: { kind: 'rgb', hex: 'ff0000' } } } }),
      ],
    };
    const result = resolveRunCascade({ styles: table, style_ref: 'Strong', direct: null });
    expect(result.status).toBe('ok');
    expect(result.properties.bold.value).toBe(true);
    expect(result.properties.bold.origin?.style_name).toBe('Base');
    expect(result.properties.color.value).toEqual({ kind: 'rgb', hex: 'ff0000' });
    expect(result.applied_chain.map((item) => item.style_id)).toEqual(['Base', 'Strong']);
  });

  it('直接格式压住样式（origin = direct）', () => {
    const table: StyleTable = { styles: [style('Strong', { run_properties: { bold: TOGGLE_ON } })] };
    const result = resolveRunCascade({
      styles: table,
      style_ref: 'Strong',
      direct: { bold: { state: 'off' } },
    });
    expect(result.properties.bold.value).toBe(false);
    expect(result.properties.bold.origin?.layer).toBe('direct');
  });

  it('文档默认字符样式在最底层', () => {
    const table: StyleTable = {
      styles: [style('DefaultChar', { is_default: true, run_properties: { size: { state: 'set', value: { kind: 'pt', value: 10 } } } })],
    };
    const result = resolveRunCascade({ styles: table, style_ref: null, direct: null });
    expect(result.properties.size.value).toEqual({ kind: 'pt', value: 10 });
    expect(result.properties.size.origin?.layer).toBe('document_default');
  });

  it('每层都不设的属性保持 unspecified（不伪装成某个值）', () => {
    const table: StyleTable = { styles: [style('Strong', { run_properties: { bold: TOGGLE_ON } })] };
    const result = resolveRunCascade({ styles: table, style_ref: 'Strong', direct: null });
    expect(result.properties.italic).toEqual({ specified: false, value: null, origin: null });
  });

  it('对象型值（fonts）与样式表不共享引用', () => {
    const fonts = { state: 'set' as const, value: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '宋体', cs: null } };
    const table: StyleTable = { styles: [style('Strong', { run_properties: { fonts } })] };
    const result = resolveRunCascade({ styles: table, style_ref: 'Strong', direct: null });
    expect(result.properties.fonts.value).toEqual(fonts.value);
    expect(result.properties.fonts.specified && result.properties.fonts.value).not.toBe(fonts.value);
  });

  it('坏链有限终止：循环 basedOn 记 conflict 而非抛错', () => {
    const table: StyleTable = {
      styles: [style('A', { based_on: 'B', run_properties: { bold: TOGGLE_ON } }), style('B', { based_on: 'A' })],
    };
    const result = resolveRunCascade({ styles: table, style_ref: 'A', direct: null });
    expect(result.status).toBe('conflict');
    expect(result.problems[0]?.kind).toBe('cycle');
  });
});

describe('改字符样式 → 一致更新（WF-037）', () => {
  it('改样式后所有引用它的文字读回都变；直接覆盖仍生效', () => {
    const table: StyleTable = { styles: [style('Emph', { run_properties: { bold: TOGGLE_ON } })] };
    const before = resolveRunCascade({ styles: table, style_ref: 'Emph', direct: null });
    expect(before.properties.bold.value).toBe(true);

    const changed = modifyNamedStyle(table, 'Emph', {
      run_properties: { bold: { state: 'off' }, italic: TOGGLE_ON },
    });
    if (!changed.ok) throw new Error('改样式失败');

    const after = resolveRunCascade({ styles: changed.table, style_ref: 'Emph', direct: null });
    expect(after.properties.bold.value).toBe(false);
    expect(after.properties.italic.value).toBe(true);

    // 直接覆盖过 bold 的那一段：样式改了，它仍按直接格式。
    const overridden = resolveRunCascade({
      styles: changed.table,
      style_ref: 'Emph',
      direct: { bold: TOGGLE_ON },
    });
    expect(overridden.properties.bold.value).toBe(true);
    expect(overridden.properties.bold.origin?.layer).toBe('direct');
    // 但它没直接设的 italic 跟着样式变了。
    expect(overridden.properties.italic.value).toBe(true);
  });
});
