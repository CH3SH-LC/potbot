/**
 * **节操作的会话侧接入**单测（design-05-P4 的产品路径；合同 R108 / R117–R131 / R136 / R140）。
 *
 * ## 每个用例在证明什么
 *
 * | 组 | 判据 |
 * |---|---|
 * | 编译正例 | 三种作用范围 + 各操作种类都能编译成**确定**的计划；`indices` 去重升序；标签由范围**派生** |
 * | 编译反例 | 缺范围 / 未知操作 / 非法单位 / 非法预设 / 非法页码格式 / 空 steps / 空 indices ⇒ 结构化拒绝（R140） |
 * | 应用正例 | 改第 2 节：第 1、3 节的 `sectPr` **逐字符不变**、对象引用不换；第 2 节**真的变了**（R108） |
 * | 应用反例 | 越界节索引 ⇒ 失败，且调用方手里的模型**一个引用都没换**（R136 全成功或全不修改） |
 * | 版本 | 一次计划 = 一次 revision 递增（R141 号 ① 的口径与 `applyEditPlan` 一致） |
 *
 * 这里的"逐字符"对照用的是**生产序列化器**（`docx/word-xml.ts` 的
 * `serializeSectionProperties`，经 `sections/testing.ts` 的 `sectPrXml` 调用），
 * 不是本文件另写的一套"看起来差不多"的渲染（R167 的取向）。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../model/types.js';
import {
  allSectPrXml,
  buildSectionsFixture,
  marginBox,
  mm,
  sectionAt,
  sectionWith,
} from '../sections/testing.js';
import { applySectionPlan, compileSectionIntent, sectionScopeLabel } from './section-ops.js';
import type { SectionEditIntent, SectionEditPlan } from './section-ops.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 三节夹具：三节页面设置互不相同，好让"污染"一定看得出来（与 D51 的 `isolation.test.ts` 同形态）。 */
function threeSectionFixture(): DocumentModel {
  return buildSectionsFixture({
    sections: [
      sectionWith({ size: { width: mm(210), height: mm(297) }, orientation: 'portrait', margins: marginBox(2, 3, 2, 3) }),
      sectionWith({ size: { width: mm(210), height: mm(297) }, orientation: 'portrait', margins: marginBox(1.5, 2.5, 1.5, 2.5) }),
      sectionWith({ size: { width: mm(297), height: mm(420) }, orientation: 'portrait', margins: marginBox(3, 2, 3, 2) }),
    ],
    blocks_per_section: 2,
  });
}

/** 编译成功即返回计划（失败时让用例炸在编译上，而不是拿着 `undefined` 继续）。 */
function compileOrThrow(intent: unknown): SectionEditPlan {
  const compiled = compileSectionIntent(intent);
  if (!compiled.ok) {
    throw new Error(`预期编译成功，实际失败：${compiled.code} ${compiled.message}`);
  }
  return compiled.value;
}

/** 应用成功即返回模型（失败时抛出，避免"静默拿到旧模型"的假通过）。 */
function applyOrThrow(model: DocumentModel, plan: SectionEditPlan): DocumentModel {
  const applied = applySectionPlan(model, plan);
  if (!applied.ok) {
    throw new Error(`预期应用成功，实际失败：${applied.code} ${applied.message}`);
  }
  return applied.value.model;
}

// ---------------------------------------------------------------------------
// 编译 —— 正例
// ---------------------------------------------------------------------------

describe('编译节意图 —— 正例', () => {
  it('三种作用范围都能编译，且标签由范围**派生**（不是调用方自报）', () => {
    const plan = compileOrThrow({
      steps: [
        { section: { kind: 'all' }, operation: { kind: 'setOrientation', orientation: 'landscape' } },
        { section: { kind: 'current', index: 1 }, operation: { kind: 'restartPageNumbering' } },
        { section: { kind: 'indices', indices: [2, 0] }, operation: { kind: 'setColumnCount', count: 2 } },
      ],
    });
    expect(plan.steps.map((step) => step.label)).toEqual(['全文', '第2节', '第1,3节']);
    expect(plan.steps.map((step) => sectionScopeLabel(step.scope))).toEqual(['全文', '第2节', '第1,3节']);
  });

  it('`indices` 去重并升序（确定性 R133 与幂等指纹 R137 的前提）', () => {
    const plan = compileOrThrow({
      steps: [{ section: { kind: 'indices', indices: [3, 1, 3, 0] }, operation: { kind: 'setVerticalAlign', align: 'center' } }],
    });
    expect(plan.steps[0]?.scope).toEqual({ kind: 'indices', indices: [0, 1, 3] });
  });

  it('纸张预设编译成模型侧的尺寸值（A4 = 210×297 mm，与 `PAGE_SIZE_PRESETS` 同源）', () => {
    const plan = compileOrThrow({
      steps: [{ section: { kind: 'all' }, operation: { kind: 'setPageSizePreset', preset: 'A4' } }],
    });
    expect(plan.steps[0]?.operation).toEqual({
      kind: 'setPageSize',
      size: { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } },
    });
  });

  it('横纵：**不给兜底尺寸**时只设方向（不替用户猜 A4，R118 的延伸）', () => {
    const plan = compileOrThrow({
      steps: [{ section: { kind: 'all' }, operation: { kind: 'setOrientation', orientation: 'landscape' } }],
    });
    expect(plan.steps[0]?.operation).toEqual({ kind: 'setOrientation', orientation: 'landscape' });
  });

  it('横纵：给了兜底尺寸就一并带上（要猜，也由调用方明说）', () => {
    const plan = compileOrThrow({
      steps: [
        {
          section: { kind: 'current', index: 0 },
          operation: {
            kind: 'setOrientation',
            orientation: 'landscape',
            fallback_size: { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } },
          },
        },
      ],
    });
    expect(plan.steps[0]?.operation).toEqual({
      kind: 'setOrientation',
      orientation: 'landscape',
      fallback_size: { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } },
    });
  });

  it('页边距：四边必给，装订线可省（省 = 0，是 OOXML `w:gutter` 的规范缺省，不是臆造）', () => {
    const withGutter = compileOrThrow({
      steps: [
        {
          section: { kind: 'all' },
          operation: {
            kind: 'setMargins',
            margins: {
              top: { unit: 'cm', value: 2 },
              right: { unit: 'cm', value: 2.5 },
              bottom: { unit: 'cm', value: 2 },
              left: { unit: 'cm', value: 2.5 },
              gutter: { unit: 'cm', value: 0.5 },
            },
          },
        },
      ],
    });
    expect(withGutter.steps[0]?.operation).toEqual({
      kind: 'setMargins',
      margins: {
        top: { unit: 'cm', value: 2 },
        right: { unit: 'cm', value: 2.5 },
        bottom: { unit: 'cm', value: 2 },
        left: { unit: 'cm', value: 2.5 },
        gutter: { unit: 'cm', value: 0.5 },
      },
    });

    const withoutGutter = compileOrThrow({
      steps: [
        {
          section: { kind: 'all' },
          operation: {
            kind: 'setMargins',
            margins: {
              top: { unit: 'cm', value: 1 },
              right: { unit: 'cm', value: 1 },
              bottom: { unit: 'cm', value: 1 },
              left: { unit: 'cm', value: 1 },
            },
          },
        },
      ],
    });
    expect(withoutGutter.steps[0]?.operation).toEqual({
      kind: 'setMargins',
      margins: {
        top: { unit: 'cm', value: 1 },
        right: { unit: 'cm', value: 1 },
        bottom: { unit: 'cm', value: 1 },
        left: { unit: 'cm', value: 1 },
        gutter: { unit: 'pt', value: 0 },
      },
    });
  });

  it('页码：格式 / 起始（含"续前节"的 null）/ 节内重启三态都能编译且**互不混同**', () => {
    const plan = compileOrThrow({
      steps: [
        { section: { kind: 'current', index: 0 }, operation: { kind: 'setPageNumberFormat', format: 'upperRoman' } },
        { section: { kind: 'current', index: 1 }, operation: { kind: 'restartPageNumbering' } },
        { section: { kind: 'current', index: 2 }, operation: { kind: 'setPageNumberStart', start: null } },
      ],
    });
    expect(plan.steps[0]?.operation).toEqual({ kind: 'setPageNumberFormat', format: 'upperRoman' });
    expect(plan.steps[1]?.operation).toEqual({ kind: 'setPageNumberStart', start: 1 });
    expect(plan.steps[2]?.operation).toEqual({ kind: 'setPageNumberStart', start: null });
  });

  it('同一意图两次编译得到**逐字段相同**的计划（可复算，R133）', () => {
    const intent: SectionEditIntent = {
      steps: [
        { section: { kind: 'indices', indices: [2, 1] }, operation: { kind: 'setPageSizePreset', preset: 'Letter' } },
        { section: { kind: 'all' }, operation: { kind: 'setVerticalAlign', align: 'both' } },
      ],
    };
    const first = compileOrThrow(intent);
    const second = compileOrThrow(intent);
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });
});

// ---------------------------------------------------------------------------
// 编译 —— 反例
// ---------------------------------------------------------------------------

describe('编译节意图 —— 反例（R140：不支持的输入在操作前拒绝）', () => {
  const reject = (intent: unknown): { readonly ok: boolean; readonly code?: string } => {
    const compiled = compileSectionIntent(intent);
    return compiled.ok ? { ok: true } : { ok: false, code: compiled.code };
  };

  it('形状不对：非对象 / steps 不是数组 / 空 steps', () => {
    expect(reject(null).code).toBe('invalid_expression');
    expect(reject(42).code).toBe('invalid_expression');
    expect(reject({ steps: 'nope' }).code).toBe('invalid_expression');
    expect(reject({ steps: [] }).code).toBe('empty_range');
  });

  it('缺作用范围一律拒绝——**没有默认范围**（否则"改一节"会静默变成"改全文"）', () => {
    const codes = [
      reject({ steps: [{ operation: { kind: 'restartPageNumbering' } }] }).code,
      reject({ steps: [{ section: {}, operation: { kind: 'restartPageNumbering' } }] }).code,
      reject({ steps: [{ section: { kind: '全文' }, operation: { kind: 'restartPageNumbering' } }] }).code,
      reject({ steps: [{ section: { kind: 'current', index: -1 }, operation: { kind: 'restartPageNumbering' } }] }).code,
      reject({ steps: [{ section: { kind: 'current', index: 1.5 }, operation: { kind: 'restartPageNumbering' } }] }).code,
    ];
    expect(codes).toEqual([
      'invalid_expression',
      'invalid_expression',
      'invalid_expression',
      'invalid_expression',
      'invalid_expression',
    ]);
  });

  it('空的节列表 = 命中零项 ⇒ `empty_range`，不是"静默什么都不做"（R112）', () => {
    const result = compileSectionIntent({
      steps: [{ section: { kind: 'indices', indices: [] }, operation: { kind: 'restartPageNumbering' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('empty_range');
  });

  it('未支持 / 非法的操作种类一律 `unsupported`，且明说它是什么', () => {
    const cases: readonly unknown[] = [
      { kind: 'setPageSizePreset', preset: 'B5' },
      { kind: 'setPageSizePreset', preset: 42 },
      { kind: 'setOrientation', orientation: 'diagonal' },
      { kind: 'setPageNumberFormat', format: 'hieroglyphs' },
      { kind: 'setVerticalAlign', align: 'middle' },
      { kind: 'setWatermark', text: '机密' },
    ];
    for (const operation of cases) {
      const result = compileSectionIntent({ steps: [{ section: { kind: 'all' }, operation }] });
      expect(result.ok, `预期拒绝：${JSON.stringify(operation)}`).toBe(false);
      if (!result.ok) {
        expect(['unsupported', 'invalid_expression']).toContain(result.code);
        // "拒绝"必须**说得出是什么**，不能只回一句"失败了"。
        expect(result.message.length).toBeGreaterThan(0);
        expect(result.detail.extra?.['step']).toBe(1);
      }
    }
  });

  it('长度：缺单位 / 单位不认识 / 数值不是有限数 ⇒ 拒绝（R127）', () => {
    const bad = [
      { unit: 'px', value: 2 },
      { unit: 'cm' },
      { unit: 'cm', value: Number.NaN },
      { unit: 'cm', value: Number.POSITIVE_INFINITY },
      'cm',
    ];
    for (const width of bad) {
      const result = compileSectionIntent({
        steps: [
          {
            section: { kind: 'all' },
            operation: { kind: 'setPageSize', width, height: { unit: 'cm', value: 29.7 } },
          },
        ],
      });
      expect(result.ok, `预期拒绝：${JSON.stringify(width)}`).toBe(false);
    }
  });

  it('页边距缺一条边 ⇒ 拒绝（OOXML 四边是必填属性，不替它填 0）', () => {
    const result = compileSectionIntent({
      steps: [
        {
          section: { kind: 'all' },
          operation: {
            kind: 'setMargins',
            margins: { top: { unit: 'cm', value: 2 }, right: { unit: 'cm', value: 2 }, bottom: { unit: 'cm', value: 2 } },
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('起始页码：负数 / 小数 / 字符串 ⇒ 拒绝（`null` 才是"续前节"）', () => {
    for (const start of [-1, 1.5, '1']) {
      const result = compileSectionIntent({
        steps: [{ section: { kind: 'all' }, operation: { kind: 'setPageNumberStart', start } }],
      });
      expect(result.ok, `预期拒绝：${JSON.stringify(start)}`).toBe(false);
    }
  });

  it('三步里第 2 步坏了 ⇒ 整份意图被拒（不留"前一步已编译"的半成品）', () => {
    const result = compileSectionIntent({
      steps: [
        { section: { kind: 'all' }, operation: { kind: 'restartPageNumbering' } },
        { section: { kind: 'all' }, operation: { kind: 'setOrientation', orientation: 'sideways' } },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 应用 —— 正例（节隔离，R108）
// ---------------------------------------------------------------------------

describe('应用节计划 —— R108：改第 2 节不污染第 1、3 节', () => {
  it('改第 2 节页边距：第 1、3 节的 `sectPr` 逐字符不变，第 2 节真的变了', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    const plan = compileOrThrow({
      steps: [
        {
          section: { kind: 'current', index: 1 },
          operation: {
            kind: 'setMargins',
            margins: {
              top: { unit: 'cm', value: 4 },
              right: { unit: 'cm', value: 4 },
              bottom: { unit: 'cm', value: 4 },
              left: { unit: 'cm', value: 4 },
              gutter: { unit: 'cm', value: 0.5 },
            },
          },
        },
      ],
    });
    const next = applyOrThrow(model, plan);
    const after = allSectPrXml(next);

    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    // 反向对照：被改的那一节必须真的变了，否则上面的"不变"是假通过。
    expect(after[1]).not.toBe(before[1]);
  });

  it('改第 2 节：第 1、3 节的节属性对象**引用都没换**（强于逐字节相等）', () => {
    const model = threeSectionFixture();
    const plan = compileOrThrow({
      steps: [
        { section: { kind: 'current', index: 1 }, operation: { kind: 'setOrientation', orientation: 'landscape' } },
      ],
    });
    const next = applyOrThrow(model, plan);
    expect(next.sections[0]).toBe(model.sections[0]);
    expect(next.sections[2]).toBe(model.sections[2]);
    expect(next.sections[1]).not.toBe(model.sections[1]);
  });

  it('一次提交里的多步（横纵 + 页码重启 + 某节栏数）：只有命中的节变了', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);
    const plan = compileOrThrow({
      steps: [
        { section: { kind: 'current', index: 1 }, operation: { kind: 'setOrientation', orientation: 'landscape' } },
        { section: { kind: 'current', index: 1 }, operation: { kind: 'restartPageNumbering' } },
        { section: { kind: 'indices', indices: [2] }, operation: { kind: 'setColumnCount', count: 2 } },
      ],
    });
    const next = applyOrThrow(model, plan);
    const after = allSectPrXml(next);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(next.sections[0]).toBe(model.sections[0]);
  });

  it('节内重启页码只动那一节：前一节的 `w:pgNumType` 一个字符没变', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);

    const plan = compileOrThrow({
      steps: [
        { section: { kind: 'current', index: 0 }, operation: { kind: 'setPageNumberFormat', format: 'upperRoman' } },
        { section: { kind: 'current', index: 2 }, operation: { kind: 'restartPageNumbering' } },
      ],
    });
    const next = applyOrThrow(model, plan);
    const after = allSectPrXml(next);

    expect(after[1]).toBe(before[1]); // 第 2 节没有被要求改
    expect(after[0]).not.toBe(before[0]);
    expect(after[2]).not.toBe(before[2]);
    expect(next.sections[1]).toBe(model.sections[1]);
  });

  it('回执：命中节数 = 作用范围内的节数；值没变时 `changed:false`', () => {
    const model = threeSectionFixture();
    // 先把三节都设成 A4：1、2 节本来就是 A4（引用不会换），第 3 节（A3）会变。
    const first = applySectionPlan(
      model,
      compileOrThrow({ steps: [{ section: { kind: 'all' }, operation: { kind: 'setPageSizePreset', preset: 'A4' } }] }),
    );
    if (!first.ok) throw new Error(`预期成功：${first.message}`);
    expect(first.value.steps[0]).toEqual({ range: '全文', domain: 'section', hitCount: 3, changed: true });

    // 再来一次同一操作 ⇒ `setPageSize` 幂等，三节引用都没换 ⇒ `changed:false`（R137）。
    const second = applySectionPlan(
      first.value.model,
      compileOrThrow({ steps: [{ section: { kind: 'all' }, operation: { kind: 'setPageSizePreset', preset: 'A4' } }] }),
    );
    if (!second.ok) throw new Error(`预期成功：${second.message}`);
    expect(second.value.steps[0]).toEqual({ range: '全文', domain: 'section', hitCount: 3, changed: false });
  });

  it('一次计划 = 一次 revision 递增（与 `applyEditPlan` 同口径）', () => {
    const model = threeSectionFixture();
    const plan = compileOrThrow({
      steps: [
        { section: { kind: 'all' }, operation: { kind: 'setVerticalAlign', align: 'center' } },
        { section: { kind: 'current', index: 0 }, operation: { kind: 'restartPageNumbering' } },
      ],
    });
    const applied = applySectionPlan(model, plan);
    if (!applied.ok) throw new Error(`预期成功：${applied.message}`);
    expect(applied.value.model.revision).toBe(model.revision + 1);
    expect(applied.value.previous_revision).toBe(model.revision);
    // 输入模型**没有被改**（不可变更新，R136）。
    expect(model.revision).toBe(threeSectionFixture().revision);
  });
});

// ---------------------------------------------------------------------------
// 应用 —— 反例
// ---------------------------------------------------------------------------

describe('应用节计划 —— 反例（R136：全成功或全不修改）', () => {
  it('节索引越界 ⇒ 失败，且**不带模型**；输入模型一个引用都没换', () => {
    const model = threeSectionFixture();
    const plan = compileOrThrow({
      steps: [
        { section: { kind: 'current', index: 1 }, operation: { kind: 'setOrientation', orientation: 'landscape' } },
        { section: { kind: 'current', index: 7 }, operation: { kind: 'restartPageNumbering' } },
      ],
    });
    const before = allSectPrXml(model);
    const sectionRefs = [...model.sections];
    const applied = applySectionPlan(model, plan);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.code).toBe('invalid_range');
      expect(applied.detail.extra?.['step']).toBe(2);
      expect('model' in applied).toBe(false);
    }
    // 第 1 步虽然合法，但整批失败 ⇒ 原模型逐字符不变（第 1 步的产物在局部变量里被丢弃）。
    expect(allSectPrXml(model)).toEqual(before);
    model.sections.forEach((section, index) => {
      expect(section).toBe(sectionRefs[index]);
    });
  });

  it('"边距比纸还大" ⇒ 被 `sections/**` 的操作前校验拒绝，模型不变（R140）', () => {
    const model = threeSectionFixture();
    const plan = compileOrThrow({
      steps: [
        {
          section: { kind: 'current', index: 0 },
          operation: {
            kind: 'setMargins',
            margins: {
              top: { unit: 'cm', value: 30 },
              right: { unit: 'cm', value: 30 },
              bottom: { unit: 'cm', value: 30 },
              left: { unit: 'cm', value: 30 },
            },
          },
        },
      ],
    });
    const before = allSectPrXml(model);
    const applied = applySectionPlan(model, plan);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.code).toBe('invalid_expression');
    expect(allSectPrXml(model)).toEqual(before);
  });

  it('空计划不算一次事务（`empty_range`）', () => {
    const model = threeSectionFixture();
    const applied = applySectionPlan(model, { steps: [] });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.code).toBe('empty_range');
  });
});

// ---------------------------------------------------------------------------
// 正向对照：被"污染"会长什么样（证明上面那套断言有判别力）
// ---------------------------------------------------------------------------

describe('判据的判别力（反面教材）', () => {
  it('若把"只改命中节"写成"重建整份 sections"，第 1、3 节的 `sectPr` 就会变——本用例证明断言抓得住', () => {
    const model = threeSectionFixture();
    const before = allSectPrXml(model);
    // 故意做一个**会污染**的更新：无差别克隆每一节（顺手 `{...section}`），
    // 并把被改节的值套到全体上——这正是 R108 要挡的错法。
    const polluted: DocumentModel = {
      ...model,
      sections: model.sections.map((section) => ({
        ...section,
        pageSize: sectionAt(model, 1).pageSize,
        orientation: sectionAt(model, 1).orientation,
        margins: sectionAt(model, 1).margins,
      })),
    };
    const after = allSectPrXml(polluted);

    expect(after[0]).not.toBe(before[0]);
    expect(after[2]).not.toBe(before[2]);
  });
});
