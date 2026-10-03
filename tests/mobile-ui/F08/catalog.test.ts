/**
 * F08 / 目录完整性：七个模板**恒可见**，未安装也不隐藏（FRONTEND.md F08 行）。
 */

import { describe, expect, it } from 'vitest';

import {
  TEMPLATE_DEFINITIONS,
  TEMPLATE_IDS,
  catalogRows,
  createTemplatesState,
  getTemplateDefinition,
  isTemplateId,
} from '../../../apps/mobile-ui/src/templates/index.js';
import { fixtureState } from './fixtures.js';

const SEVEN = [
  'template.document',
  'template.spreadsheet',
  'template.presentation',
  'template.meituan',
  'template.clock',
  'template.calendar',
  'template.research',
];

describe('F08 / 七模板目录', () => {
  it('规范 id 恰好七个，顺序与本包展示顺序一致', () => {
    expect([...TEMPLATE_IDS]).toEqual(SEVEN);
    expect(TEMPLATE_DEFINITIONS.map((def) => def.id)).toEqual(SEVEN);
  });

  it('空状态（全部未安装）下目录仍有七行', () => {
    const rows = catalogRows(createTemplatesState());
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.id)).toEqual(SEVEN);
    // 未安装：四态全 false，但行依然在。
    for (const row of rows) {
      expect(row.readiness).toEqual({
        installed: false,
        enabled: false,
        authorized: false,
        portReady: false,
      });
      expect(row.installedVersion).toBeNull();
      expect(row.catalogVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('夹具状态下目录仍是同样七行、同样顺序（安装与否不改变目录集合）', () => {
    const rows = catalogRows(fixtureState());
    expect(rows.map((row) => row.id)).toEqual(SEVEN);
  });

  it('每个模板 id 都能取到静态定义；未知 id 抛错而非返回 undefined', () => {
    for (const id of TEMPLATE_IDS) {
      expect(getTemplateDefinition(id).id).toBe(id);
    }
    expect(() => getTemplateDefinition('template.nope')).toThrowError(/未知模板 id/);
    try {
      getTemplateDefinition('template.nope');
      throw new Error('不应到达');
    } catch (error) {
      expect((error as { code: string }).code).toBe('unknown-template');
    }
  });

  it('isTemplateId 只认规范七个', () => {
    expect(SEVEN.every((id) => isTemplateId(id))).toBe(true);
    expect(isTemplateId('template.bogus')).toBe(false);
    expect(isTemplateId('')).toBe(false);
  });

  it('文件格式与模板分离：只有 docx/xlsx/pptx 三个办公模板产出 OOXML', () => {
    const produces = TEMPLATE_DEFINITIONS.filter((def) => def.producesFileFormats.length > 0);
    expect(produces.map((def) => def.id)).toEqual([
      'template.document',
      'template.spreadsheet',
      'template.presentation',
    ]);
    for (const def of produces) {
      expect(def.producesFileFormats.every((fmt) => ['docx', 'xlsx', 'pptx'].includes(fmt))).toBe(true);
    }
    // 美团 / 时钟 / 日历 / 资料检索不产出任何 OOXML。
    for (const id of ['template.meituan', 'template.clock', 'template.calendar', 'template.research'] as const) {
      expect(getTemplateDefinition(id).producesFileFormats).toEqual([]);
    }
  });
});
