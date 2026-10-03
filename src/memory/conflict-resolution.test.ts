/**
 * 当前指令优先 + 事实留痕更新单测（design-06 P4 / MEM-03；合同 R235 / R236 / R240）。
 *
 * 核心断言：**当前明确指令覆盖旧偏好并说明差异**；
 * **更新任务事实留来源与版本、旧版本仍可读、能指出新旧差异**；
 * **失败如实标注，不编造差异**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../protocol/index.js';
import {
  resolveCurrentInstructionAgainstMemory,
  traceFactVersions,
  type FactUpdateRequest,
} from './conflict-resolution.js';
import { readTaskFactHistory } from './fact-update.js';
import { createMemoryRepository, type MemoryRepository } from './repository.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type OwnerId,
  type PreferenceMemory,
} from './types.js';

const U1: OwnerId = asOwnerId('user-a');
const TASK = asTaskId('task-1');
const AT = asLogicalTime(10);

let counter = 0;
function nextId(): ReturnType<typeof asMemoryId> {
  counter += 1;
  return asMemoryId(`cr-${String(counter)}`);
}

function preference(key: string, value: string): PreferenceMemory {
  return createMemoryEntry({
    kind: 'preference',
    memory_id: `pref-${key}`,
    owner_id: U1,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_confirmation', detail: '早先确认' },
    confirmation: 'confirmed',
    created_at: 1,
    updated_at: 1,
    version: 0,
    status: 'active',
    preference_key: key,
    value_text: value,
  }) as PreferenceMemory;
}

function factUpdate(overrides: Partial<FactUpdateRequest> = {}): FactUpdateRequest {
  return {
    task_id: TASK,
    fact_key: 'paper_size',
    value_text: 'A4',
    source: { kind: 'user_statement', detail: '本轮明确要求' },
    ...overrides,
  };
}

function seedFact(repo: MemoryRepository, value: string): void {
  const entry = createMemoryEntry({
    kind: 'task_fact',
    memory_id: 'fact-seed',
    owner_id: U1,
    scope: { kind: 'task', task_id: TASK, template_id: null },
    source: { kind: 'user_statement', detail: '初值' },
    confirmation: 'unconfirmed',
    created_at: 1,
    updated_at: 1,
    version: 0,
    status: 'active',
    task_id: TASK,
    fact_key: 'paper_size',
    value_text: value,
  });
  expect(repo.remember(entry).ok).toBe(true);
}

describe('MEM-03 / R236：当前明确指令覆盖旧偏好并说明差异', () => {
  it('冲突的旧偏好被列出：结论 applied=current，给出旧值与新值', () => {
    const repo = createMemoryRepository();
    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: U1,
      at: AT,
      current_instructions: [{ preference_key: 'font_family', value: '黑体' }],
      preferences: [preference('font_family', '宋体')],
      fact_updates: [],
      newMemoryId: nextId,
    });

    expect(report.applied).toBe('current');
    expect(report.preference_resolution.conflicts).toHaveLength(1);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]?.from).toBe('宋体');
    expect(report.differences[0]?.to).toBe('黑体');
    expect(report.differences[0]?.note).toContain('按当前要求执行');
    expect(report.partial).toBe(false);
  });

  it('**反向对照**：与当前要求一致的旧偏好**不**算冲突，也不产生差异', () => {
    const repo = createMemoryRepository();
    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: U1,
      at: AT,
      current_instructions: [{ preference_key: 'font_family', value: '宋体' }],
      preferences: [preference('font_family', '宋体')],
      fact_updates: [],
      newMemoryId: nextId,
    });
    expect(report.preference_resolution.conflicts).toHaveLength(0);
    expect(report.preference_resolution.unopposed).toHaveLength(1);
    expect(report.differences).toHaveLength(0);
  });

  it('**反向对照**：冲突的旧偏好**不被删除**（仍在输入集 / 未被改写）', () => {
    const repo = createMemoryRepository();
    const old = preference('font_family', '宋体');
    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: U1,
      at: AT,
      current_instructions: [{ preference_key: 'font_family', value: '黑体' }],
      preferences: [old],
      fact_updates: [],
      newMemoryId: nextId,
    });
    expect(report.preference_resolution.conflicts[0]?.preferred_value).toBe('宋体');
    expect(old.value_text).toBe('宋体'); // 原对象未被改写
  });
});

describe('MEM-03 / R236：更新任务事实留来源与版本，旧值不丢', () => {
  it('更新 ⇒ 追加新版本（r1），留来源；旧版本仍可读且值不变', () => {
    const repo = createMemoryRepository();
    seedFact(repo, 'A4');

    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: U1,
      at: AT,
      current_instructions: [],
      preferences: [],
      fact_updates: [factUpdate({ value_text: 'A3' })],
      newMemoryId: nextId,
    });

    expect(report.partial).toBe(false);
    const history = readTaskFactHistory(repo, {
      owner_id: U1,
      task_id: TASK,
      fact_key: 'paper_size',
    });
    expect(history).toHaveLength(2);
    // 旧版本：值不变、转为失效（历史不删）
    expect(history[0]?.value_text).toBe('A4');
    expect(history[0]?.version).toBe(0);
    expect(history[0]?.status).toBe('disabled');
    // 新版本：值更新、有效、留来源与版本
    expect(history[1]?.value_text).toBe('A3');
    expect(history[1]?.version).toBe(1);
    expect(history[1]?.status).toBe('active');
    expect(history[1]?.source.detail).toBe('本轮明确要求');

    // 差异可读：from A4 → to A3，且说明含来源
    const diff = report.differences.find((d) => d.kind === 'task_fact');
    expect(diff?.from).toBe('A4');
    expect(diff?.to).toBe('A3');
    expect(diff?.note).toContain('本轮明确要求');

    // 版本追溯同时给出当前值与前一值
    const trace = traceFactVersions(repo, {
      owner_id: U1,
      task_id: TASK,
      fact_key: 'paper_size',
    });
    expect(trace.current_value).toBe('A3');
    expect(trace.previous_value).toBe('A4');
    expect(trace.versions).toHaveLength(2);
    expect(trace.versions[0]?.source.detail).toBe('初值');
  });

  it('**反向对照**：缺来源 ⇒ 失败，不写新版本、旧值仍是有效值、不产生差异', () => {
    const repo = createMemoryRepository();
    seedFact(repo, 'A4');

    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: U1,
      at: AT,
      current_instructions: [],
      preferences: [],
      fact_updates: [
        factUpdate({ value_text: 'A3', source: { kind: 'user_statement', detail: '' } }),
      ],
      newMemoryId: nextId,
    });

    expect(report.partial).toBe(true);
    expect(report.failures).toHaveLength(1);
    expect(report.differences).toHaveLength(0); // 不编造"已改成"的对照

    const history = readTaskFactHistory(repo, {
      owner_id: U1,
      task_id: TASK,
      fact_key: 'paper_size',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.value_text).toBe('A4');
    expect(history[0]?.status).toBe('active');
    expect(report.explanation).toContain('未能完成');
  });

  it('**反向对照**：值未变 ⇒ no_change，不新增版本（不制造假历史）', () => {
    const repo = createMemoryRepository();
    seedFact(repo, 'A4');

    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: U1,
      at: AT,
      current_instructions: [],
      preferences: [],
      fact_updates: [factUpdate({ value_text: 'A4' })],
      newMemoryId: nextId,
    });

    expect(report.partial).toBe(false);
    expect(report.differences).toHaveLength(0);
    expect(report.fact_outcomes[0]?.result.kind).toBe('no_change');
    expect(
      readTaskFactHistory(repo, { owner_id: U1, task_id: TASK, fact_key: 'paper_size' }),
    ).toHaveLength(1);
  });

  it('首次写入任务事实 ⇒ previous_value 为 null，差异 from 记为 (无)', () => {
    const repo = createMemoryRepository();
    const report = resolveCurrentInstructionAgainstMemory({
      repository: repo,
      owner_id: U1,
      at: AT,
      current_instructions: [],
      preferences: [],
      fact_updates: [factUpdate({ value_text: 'A4' })],
      newMemoryId: nextId,
    });
    const diff = report.differences.find((d) => d.kind === 'task_fact');
    expect(diff?.from).toBe('(无)');
    expect(diff?.to).toBe('A4');
  });
});
