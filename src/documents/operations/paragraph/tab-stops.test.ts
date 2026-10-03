/**
 * 制表位操作测试（WF-030）。
 */

import { describe, expect, it } from 'vitest';
import { createDefaultParagraphProperties } from './defaults.js';
import {
  addTabStop,
  clearTabStops,
  getTabStops,
  normalizeTabStops,
  removeTabStop,
  setTabStops,
  tabStop,
} from './tab-stops.js';
import { tabStopsToOoxml } from '../../units/tab-stop.js';

const CM2 = { unit: 'cm', value: 2 } as const;
const CM4 = { unit: 'cm', value: 4 } as const;

describe('新增与读取（WF-030）', () => {
  it('新增后能读回，位置走 twips 换算', () => {
    const props = addTabStop(createDefaultParagraphProperties(), tabStop(CM2, 'left', 'none'));
    expect(getTabStops(props)).toHaveLength(1);
    expect(tabStopsToOoxml(getTabStops(props))[0]).toEqual({ pos: 1134, val: 'left', leader: 'none' });
  });

  it('新增多个后按位置升序', () => {
    let props = addTabStop(createDefaultParagraphProperties(), tabStop(CM4));
    props = addTabStop(props, tabStop(CM2));
    expect(tabStopsToOoxml(getTabStops(props)).map((t) => t.pos)).toEqual([1134, 2268]);
  });

  it('同位置后写覆盖先写', () => {
    let props = addTabStop(createDefaultParagraphProperties(), tabStop(CM2, 'left'));
    props = addTabStop(props, tabStop(CM2, 'right'));
    expect(getTabStops(props)).toHaveLength(1);
    expect(tabStopsToOoxml(getTabStops(props))[0]?.val).toBe('right');
  });

  it('未指定时读回空数组', () => {
    expect(getTabStops(createDefaultParagraphProperties())).toEqual([]);
  });
});

describe('删除（WF-030）', () => {
  it('按位置删除（删除与写入用同一套换算）', () => {
    let props = addTabStop(createDefaultParagraphProperties(), tabStop(CM2));
    props = addTabStop(props, tabStop(CM4));
    const removed = removeTabStop(props, CM2);
    expect(getTabStops(removed)).toHaveLength(1);
    expect(tabStopsToOoxml(getTabStops(removed))[0]?.pos).toBe(2268);
  });

  it('删到空时落 inherit，而不是"空数组的 set"', () => {
    const props = addTabStop(createDefaultParagraphProperties(), tabStop(CM2));
    const removed = removeTabStop(props, CM2);
    expect(getTabStops(removed)).toEqual([]);
    expect(removed.tabStops).toEqual({ state: 'inherit' });
  });

  it('删除不存在的位置不报错，列表不变', () => {
    const props = addTabStop(createDefaultParagraphProperties(), tabStop(CM2));
    const removed = removeTabStop(props, CM4);
    expect(getTabStops(removed)).toHaveLength(1);
  });

  it('clearTabStops 一次清空', () => {
    let props = addTabStop(createDefaultParagraphProperties(), tabStop(CM2));
    props = addTabStop(props, tabStop(CM4));
    expect(props.tabStops.state).toBe('set');
    expect(clearTabStops(props).tabStops).toEqual({ state: 'inherit' });
  });
});

describe('整组替换与规范化', () => {
  it('setTabStops 排序去重后写入', () => {
    const props = setTabStops(createDefaultParagraphProperties(), [tabStop(CM4), tabStop(CM2), tabStop(CM2, 'right')]);
    expect(tabStopsToOoxml(getTabStops(props)).map((t) => t.pos)).toEqual([1134, 2268]);
    expect(tabStopsToOoxml(getTabStops(props))[0]?.val).toBe('right');
  });

  it('normalizeTabStops 是纯函数，不改原数组', () => {
    const input = [tabStop(CM4), tabStop(CM2)];
    const out = normalizeTabStops(input);
    expect(out).toHaveLength(2);
    expect(input[0]).toEqual(tabStop(CM4));
  });

  it('setTabStops 空数组落 inherit', () => {
    expect(setTabStops(createDefaultParagraphProperties(), []).tabStops).toEqual({ state: 'inherit' });
  });

  it('制表位操作不触碰对齐（R107 边界外的职责分离）', () => {
    const base = createDefaultParagraphProperties();
    const props = addTabStop(base, tabStop(CM2));
    expect(props.alignment).toBe(base.alignment);
  });
});
