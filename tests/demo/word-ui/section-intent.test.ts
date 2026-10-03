/**
 * WCF-D72：`section-intent.js` 的判据。
 *
 * 核心一条（与 D34 的 `edit-intent.test.ts` 同一条纪律）：**页面的镜像不能漂移**。
 * 凡是页面敢提交的节操作，都必须被内核**真实的** `compileSectionIntent` 接受，
 * 并且编译出来的作用范围与操作值与页面送出去的一模一样；凡是页面拒绝的，
 * 内核也必须拒绝（或根本不该发出）。两边用**同一个函数**对拍，而不是对字符串。
 *
 * 还钉住两件容易悄悄坏掉的事：
 *   - `scopeLabel` 与内核 `sectionScopeLabel` 逐字一致（含去重升序）；
 *   - 作用范围**没有默认值**：`null`（页面上"未指定"）必须以 `no_scope` 拒绝，
 *     绝不退化成"全文"。
 */

import { describe, expect, it } from 'vitest';

import {
  PAGE_NUMBER_FORMATS as KERNEL_PAGE_NUMBER_FORMATS,
  PAGE_SIZE_PRESET_NAMES as KERNEL_PRESET_NAMES,
} from '../../../src/documents/sections/types.js';
import { compileSectionIntent, sectionScopeLabel } from '../../../src/documents/session/section-ops.js';
import type { SectionScope } from '../../../src/documents/sections/types.js';
import { loadWebGlobal } from './harness.js';

interface StepShape {
  readonly domain: string;
  readonly section: SectionScope;
  readonly operation: Record<string, unknown>;
  readonly label: string;
}

interface BuildResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly step?: StepShape;
}

interface ControlShape {
  readonly id: string;
  readonly label: string;
  readonly input: string;
  readonly values?: readonly string[];
}

interface SectionIntentModule {
  readonly PAGE_SIZE_PRESET_NAMES: readonly string[];
  readonly PAGE_NUMBER_FORMATS: readonly string[];
  readonly ORIENTATIONS: readonly string[];
  readonly LENGTH_UNITS: readonly string[];
  readonly CONTROLS: readonly ControlShape[];
  controlById(id: string): ControlShape | null;
  scopeAll(): SectionScope;
  scopeCurrent(index: number): SectionScope;
  scopeIndices(indices: readonly number[]): SectionScope;
  scopeLabel(scope: SectionScope): string;
  scopeOptions(sectionCount: number): ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readScopeFromChoice(choice: string | null): SectionScope | null;
  buildStep(scope: SectionScope | null, controlId: string, value?: unknown): BuildResult;
  localRejection(step: unknown): { readonly code: string; readonly message: string } | null;
  toSectionIntent(steps: readonly StepShape[]): { readonly steps: ReadonlyArray<Record<string, unknown>> };
  isSectionStep(step: unknown): boolean;
}

const lib = loadWebGlobal<SectionIntentModule>('section-intent.js', 'PotbotSectionIntent');

/** 把页面产出的一步喂给**真实的**内核编译器，返回它的判决。 */
function kernelVerdict(steps: readonly StepShape[]): ReturnType<typeof compileSectionIntent> {
  return compileSectionIntent(lib.toSectionIntent(steps));
}

describe('WCF-D72 section-intent：镜像与内核对拍', () => {
  it('镜像的关键字面量与内核一致（预设名 / 页码格式逐字）', () => {
    expect([...lib.PAGE_SIZE_PRESET_NAMES]).toEqual([...KERNEL_PRESET_NAMES]);
    expect([...lib.PAGE_NUMBER_FORMATS]).toEqual([...KERNEL_PAGE_NUMBER_FORMATS]);
    expect([...lib.ORIENTATIONS]).toEqual(['portrait', 'landscape']);
  });

  it('每个控件的每个取值，内核真实编译器都接受（无漂移）', () => {
    const scope = lib.scopeCurrent(0);
    for (const control of lib.CONTROLS) {
      const values = control.input === 'choice'
        ? (control.values ?? [])
        : control.input === 'margins'
          ? [{ unit: 'mm', top: 20, right: 20, bottom: 20, left: 20 }]
          : [undefined];
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        const built = lib.buildStep(scope, control.id, value);
        expect(built.ok, `${control.id} 的取值 ${JSON.stringify(value)} 页面应当接受`).toBe(true);
        const verdict = kernelVerdict([built.step as StepShape]);
        expect(
          verdict.ok,
          `${control.id}=${JSON.stringify(value)} 内核应接受，实际：${verdict.ok === false ? `${verdict.code} ${verdict.message}` : ''}`,
        ).toBe(true);
      }
    }
  });

  it('页面送出的作用范围与操作值，就是内核编译出来的那一个', () => {
    const built = lib.buildStep(lib.scopeCurrent(1), 'orientation', 'landscape');
    expect(built.ok).toBe(true);
    const step = built.step as StepShape;
    /* 页面侧的形状（送出去的字节长这样） */
    expect(step.section).toEqual({ kind: 'current', index: 1 });
    expect(step.operation).toEqual({ kind: 'setOrientation', orientation: 'landscape' });
    expect(step.label).toBe('第2节');

    const verdict = kernelVerdict([step]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok === false) return;
    expect(verdict.value.steps).toHaveLength(1);
    expect(verdict.value.steps[0]?.scope).toEqual({ kind: 'current', index: 1 });
    expect(verdict.value.steps[0]?.operation).toEqual({ kind: 'setOrientation', orientation: 'landscape' });
    /* `label` 是**派生**的：内核派生出来的与页面显示的必须逐字相同。 */
    expect(verdict.value.steps[0]?.label).toBe(step.label);
  });

  it('纸张预设交给内核查表：页面只送名字，尺寸由内核给', () => {
    const built = lib.buildStep(lib.scopeAll(), 'pageSizePreset', 'A4');
    expect(built.ok).toBe(true);
    const verdict = kernelVerdict([built.step as StepShape]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok === false) return;
    expect(verdict.value.steps[0]?.operation).toEqual({
      kind: 'setPageSize',
      size: { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } },
    });
  });

  it('页码格式与"本节从 1 重新开始"都能被内核接受，且语义正确', () => {
    const format = lib.buildStep(lib.scopeAll(), 'pageNumberFormat', 'upperRoman');
    const restart = lib.buildStep(lib.scopeAll(), 'restartPageNumbering');
    const carryOn = lib.buildStep(lib.scopeAll(), 'continuePageNumbering');
    expect([format.ok, restart.ok, carryOn.ok]).toEqual([true, true, true]);

    const verdict = kernelVerdict([format.step as StepShape, restart.step as StepShape, carryOn.step as StepShape]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok === false) return;
    expect(verdict.value.steps.map((step) => step.operation)).toEqual([
      { kind: 'setPageNumberFormat', format: 'upperRoman' },
      { kind: 'setPageNumberStart', start: 1 },
      { kind: 'setPageNumberStart', start: null },
    ]);
  });

  it('页边距四边原样搬运（页面不换算单位）', () => {
    const built = lib.buildStep(lib.scopeCurrent(0), 'margins', {
      unit: 'cm', top: 2.5, right: 2, bottom: 2, left: 2, gutter: 0,
    });
    expect(built.ok).toBe(true);
    const verdict = kernelVerdict([built.step as StepShape]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok === false) return;
    expect(verdict.value.steps[0]?.operation).toEqual({
      kind: 'setMargins',
      margins: {
        top: { unit: 'cm', value: 2.5 }, right: { unit: 'cm', value: 2 },
        bottom: { unit: 'cm', value: 2 }, left: { unit: 'cm', value: 2 },
        gutter: { unit: 'cm', value: 0 },
      },
    });
  });
});

describe('WCF-D72 section-intent：作用节必须显式', () => {
  it('未指定作用节（null）⇒ no_scope，绝不退化成全文（R108）', () => {
    const built = lib.buildStep(null, 'orientation', 'landscape');
    expect(built.ok).toBe(false);
    expect(built.code).toBe('no_scope');
    expect(built.step).toBeUndefined();
    expect(String(built.message)).toContain('还没有指定作用节');
  });

  it('下拉框的"未指定"取值读成 null（不是默认全文）', () => {
    expect(lib.readScopeFromChoice('')).toBeNull();
    expect(lib.readScopeFromChoice(null)).toBeNull();
    expect(lib.readScopeFromChoice('abc')).toBeNull();
    expect(lib.readScopeFromChoice('all')).toEqual({ kind: 'all' });
    expect(lib.readScopeFromChoice('2')).toEqual({ kind: 'current', index: 2 });
  });

  it('下拉框第一项是空的"未指定"，不是某一节', () => {
    const options = lib.scopeOptions(3);
    expect(options[0]?.value).toBe('');
    expect(options.map((option) => option.value)).toEqual(['', '0', '1', '2', 'all']);
  });

  it('空节列表被拒（R112）：页面与内核同时拒', () => {
    const built = lib.buildStep(lib.scopeIndices([]), 'orientation', 'landscape');
    expect(built.ok).toBe(false);
    expect(built.code).toBe('empty_range');
    const kernel = compileSectionIntent({ steps: [{ section: { kind: 'indices', indices: [] }, operation: { kind: 'setOrientation', orientation: 'landscape' } }] });
    expect(kernel.ok).toBe(false);
    if (kernel.ok === false) expect(kernel.code).toBe('empty_range');
  });

  it('非法取值一律本地拒绝，且**不产出一颗会发出去的步骤**', () => {
    const cases: Array<[string, unknown]> = [
      ['pageSizePreset', 'B5'],
      ['orientation', 'sideways'],
      ['pageNumberFormat', 'chineseCountingUpper'],
      ['margins', { unit: 'furlong', top: 1, right: 1, bottom: 1, left: 1 }],
      ['margins', { unit: 'mm', top: -1, right: 1, bottom: 1, left: 1 }],
    ];
    for (const [controlId, value] of cases) {
      const built = lib.buildStep(lib.scopeAll(), controlId, value);
      expect(built.ok, `${controlId}=${JSON.stringify(value)} 应当被拒`).toBe(false);
      expect(built.step).toBeUndefined();
      expect(typeof built.message).toBe('string');
      expect(String(built.message).length).toBeGreaterThan(0);
    }
    const unknown = lib.buildStep(lib.scopeAll(), 'nope', undefined);
    expect(unknown.code).toBe('unknown_control');
  });
});

describe('WCF-D72 section-intent：范围标签与内核逐字一致', () => {
  const scopes: SectionScope[] = [
    { kind: 'all' },
    { kind: 'current', index: 0 },
    { kind: 'current', index: 9 },
    { kind: 'indices', indices: [2, 0, 1] },
    { kind: 'indices', indices: [1, 1, 1] },
  ];

  it('派生标签与 sectionScopeLabel 相同（含去重与升序）', () => {
    for (const scope of scopes) {
      expect(lib.scopeLabel(scope), JSON.stringify(scope)).toBe(sectionScopeLabel(scope));
    }
  });

  it('步骤上的 label 就是派生出来的那一个，不接受自报', () => {
    const built = lib.buildStep(lib.scopeIndices([3, 1, 1]), 'orientation', 'portrait');
    expect(built.ok).toBe(true);
    expect((built.step as StepShape).label).toBe(sectionScopeLabel({ kind: 'indices', indices: [3, 1, 1] }));
  });

  it('isSectionStep 只认节步：段落步不会被误判（保存分流靠它）', () => {
    expect(lib.isSectionStep({ domain: 'section' })).toBe(true);
    expect(lib.isSectionStep({ range: '第1段', operation: {} })).toBe(false);
    expect(lib.isSectionStep(null)).toBe(false);
    expect(lib.isSectionStep('section')).toBe(false);
  });
});
