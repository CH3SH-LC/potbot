/**
 * FA-Q —— 三对判据的**咬合力**证明（变异/反例）
 *
 * 目的不是"跑通一个函数"，而是证明这些判据**会咬人**：
 *  - 正例（强主张成立的诚实证据）必须判**过**；
 *  - 反例/变异体（把强主张降级成弱证据）必须判**败**。
 *
 * 纪律（任务要求）：对**未实现**的功能显式标「未实现」，且**把跳过原因写进用例名**；
 * **跳过 ≠ 通过**——`self-check.md` 单独统计 skipped。
 *
 * 本文件**不 import 任何产品实现**，因此无论产品是否实现都能运行；产品侧的
 * 真实文件/真机路径在下面以 it.skip 显式登记为未实现。
 */
import { describe, expect, it } from 'vitest';

import {
  checkFirstSave,
  checkFreshCreate,
  checkImportThenModify,
  checkJumpHandledHonestly,
  checkReopenThenEdit,
  checkWriteComplete,
  asJumpOnlyClaim,
  type ImportModifyObservation,
  type ReopenEditObservation,
  type WriteCompletionObservation,
} from './three-pairs.js';

// ---------------------------------------------------------------------------
// 对 1：创建 vs 导入后修改
// ---------------------------------------------------------------------------

const importedGood: ImportModifyObservation = {
  origin: 'imported',
  source_ref: 'artifact://task-1/plan.xlsx@rev1',
  preserved_unknown_parts: ['docProps/custom.xml', 'xl/calcChain.xml'],
  changed_refs: ['Sheet1!B2'],
  readback_of_changed: { 'Sheet1!B2': '10' },
  expected_of_changed: { 'Sheet1!B2': '10' },
};

const createdGood: ImportModifyObservation = {
  origin: 'created',
  declared_no_unknown_parts: true,
  changed_refs: ['Sheet1!B2'],
  readback_of_changed: { 'Sheet1!B2': '10' },
  expected_of_changed: { 'Sheet1!B2': '10' },
};

describe('对1 · 创建 vs 导入后修改（分别验收）', () => {
  it('正例：诚实的「从零创建」证据判过（checkFreshCreate）', () => {
    expect(checkFreshCreate(createdGood)).toEqual({ ok: true, reasons: [] });
  });

  it('正例：诚实的「导入后修改」证据判过（checkImportThenModify）', () => {
    expect(checkImportThenModify(importedGood)).toEqual({ ok: true, reasons: [] });
  });

  it('★判别力核心：从零创建的证据**不能**充当「导入后修改」', () => {
    const v = checkImportThenModify(createdGood);
    expect(v.ok).toBe(false);
    expect(v.reasons.join('|')).toContain('导入后修改');
  });

  it('★判别力核心：导入修改的证据**不能**充当「从零创建」', () => {
    expect(checkFreshCreate(importedGood).ok).toBe(false);
  });

  const mutations: ReadonlyArray<readonly [string, ImportModifyObservation]> = [
    [
      '变异1 把「从零新建」冒充「导入后修改」',
      { ...importedGood, origin: 'created', source_ref: undefined },
    ],
    ['变异2 缺 source_ref（无法证明基于既有文件）', { ...importedGood, source_ref: undefined }],
    [
      '变异3 未知部件既没保留也没声明（缺失≠没有）',
      { ...importedGood, preserved_unknown_parts: [], declared_no_unknown_parts: false },
    ],
    ['变异4 changed_refs 为空', { ...importedGood, changed_refs: [] }],
    ['变异5 打开/存在≠写入：改动目标无读回值', { ...importedGood, readback_of_changed: {} }],
    ['变异6 读回值≠期望值（假称改了）', { ...importedGood, readback_of_changed: { 'Sheet1!B2': '8' } }],
  ];

  for (const [name, obs] of mutations) {
    it(`反例被咬住：${name}`, () => {
      const v = checkImportThenModify(obs);
      expect(v.ok).toBe(false);
      expect(v.reasons.length).toBeGreaterThan(0);
    });
  }

  it.skip(
    '未实现：对真实导入的 XLSX 做单元格改写并逐字节确认未知部件保留（需 XLSX 导入/读回实现）',
    () => {},
  );
});

// ---------------------------------------------------------------------------
// 对 2：首次保存 vs 重开后再编辑
// ---------------------------------------------------------------------------

const reopenGood: ReopenEditObservation = {
  after_first_save_readback: '<w:document>draft-v1</w:document>',
  after_reopen_readback: '<w:document>draft-v1</w:document>',
  post_reopen_edit_ref: 'w:p[3]',
  post_reopen_expected: 'draft-v2',
  post_reopen_readback: 'draft-v2',
  in_memory_only: false,
};

describe('对2 · 首次保存 vs 重开后再编辑（分别验收）', () => {
  it('正例：首次保存（已落盘）判过', () => {
    expect(checkFirstSave(reopenGood)).toEqual({ ok: true, reasons: [] });
  });

  it('正例：重开后再编辑判过', () => {
    expect(checkReopenThenEdit(reopenGood)).toEqual({ ok: true, reasons: [] });
  });

  it('★判别力核心：内存副本**不能**充当「首次保存」', () => {
    expect(checkFirstSave({ ...reopenGood, in_memory_only: true }).ok).toBe(false);
  });

  const mutations: ReadonlyArray<readonly [string, ReopenEditObservation]> = [
    ['变异1 内存副本冒充重开（in_memory_only）', { ...reopenGood, in_memory_only: true }],
    [
      '变异2 重开读回≠首次保存读回（没落盘/重开丢内容）',
      { ...reopenGood, after_reopen_readback: '<w:document></w:document>' },
    ],
    ['变异3 缺重开后的编辑目标', { ...reopenGood, post_reopen_edit_ref: '' }],
    ['变异4 重开后编辑读回≠期望（改了但没生效）', { ...reopenGood, post_reopen_readback: 'draft-v1' }],
  ];

  for (const [name, obs] of mutations) {
    it(`反例被咬住：${name}`, () => {
      const v = checkReopenThenEdit(obs);
      expect(v.ok).toBe(false);
      expect(v.reasons.length).toBeGreaterThan(0);
    });
  }

  it.skip(
    '未实现：真机保存 DOCX/XLSX/PPTX 后关闭 App、重开再改同一对象（需真机 + 三模板实现）',
    () => {},
  );
});

// ---------------------------------------------------------------------------
// 对 3：跳转  vs  写入完成
// ---------------------------------------------------------------------------

const writeGood: WriteCompletionObservation = {
  action_state: 'confirmed_complete',
  receipt_ref: 'receipt://calendar/evt-42@rev1',
  readback_of_target: 'evt-42',
  readback_expected: 'evt-42',
};

describe('对3 · 跳转 vs 写入完成（分别验收）', () => {
  it('正例：已确认完成 + 可信回执/一致读回 判过', () => {
    expect(checkWriteComplete(writeGood)).toEqual({ ok: true, reasons: [] });
  });

  it('正例：仅有一致读回、无回执，也判过（读回即证据）', () => {
    expect(checkWriteComplete({ ...writeGood, receipt_ref: undefined }).ok).toBe(true);
  });

  it('★判别力核心：只打开了目标 App（handed_off）不算写入完成', () => {
    const v = checkWriteComplete(asJumpOnlyClaim());
    expect(v.ok).toBe(false);
    expect(v.reasons.join('|')).toContain('打开');
  });

  it('★判别力核心：只跳转时，系统被要求如实标注为非完成态', () => {
    expect(checkJumpHandledHonestly(asJumpOnlyClaim())).toEqual({ ok: true, reasons: [] });
    // 若把只跳转的观测标成 confirmed_complete，则"如实处理"判据必须判负
    expect(checkJumpHandledHonestly({ ...asJumpOnlyClaim(), action_state: 'confirmed_complete' }).ok).toBe(false);
  });

  const mutations: ReadonlyArray<readonly [string, WriteCompletionObservation]> = [
    ['变异1 已提交但未确认（submitted）', { ...writeGood, action_state: 'submitted' }],
    ['变异2 结果未知（unknown_result）冒充完成', { ...writeGood, action_state: 'unknown_result' }],
    [
      '变异3 用户报告完成（user_reported_complete）冒充系统写入完成',
      { ...writeGood, action_state: 'user_reported_complete', user_reported: true },
    ],
    ['变异4 宣称完成但既无回执又无读回', { action_state: 'confirmed_complete' }],
    ['变异5 读回与期望不一致（写错了还宣称完成）', { ...writeGood, readback_of_target: 'evt-999' }],
  ];

  for (const [name, obs] of mutations) {
    it(`反例被咬住：${name}`, () => {
      const v = checkWriteComplete(obs);
      expect(v.ok).toBe(false);
      expect(v.reasons.length).toBeGreaterThan(0);
    });
  }

  it.skip(
    '未实现：真机跳转日历/时钟编辑页后返回，验证内核不把它记为写入完成（需真机 + 适配器）',
    () => {},
  );
});
