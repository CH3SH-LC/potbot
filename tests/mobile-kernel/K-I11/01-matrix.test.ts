/**
 * K-I11 独立验证 ①：**表驱动的允许 / 拒绝矩阵**。
 *
 * 每一行给出：一次模板指派 + 一份 K06 来源快照 + 期望的（allowed, reason, 解析版本…）。
 * 五条拒因各自被至少一行命中；允许行给出"四态俱齐"的参照。
 *
 * 负例纪律：期望 `allowed:false` 的行若被判允许，`reason` 断言会红——避免"该拒的没拒"。
 */

import { describe, expect, it } from 'vitest';

import {
  DENY_REASON_TO_BLOCK_REASON,
  TEMPLATE_POLICY_DENY_REASONS,
  createTemplatePolicy,
  evaluateTemplateAssignment,
  type TemplateAssignment,
  type TemplatePolicyDenyReason,
  type TemplatePolicySource,
} from '../../../apps/mobile-kernel/adapters/template-policy/index.js';
import { EXCEL, WORD, WORD_V1, healthySource, installed, source } from './fixtures.js';

interface MatrixRow {
  readonly name: string;
  readonly assignment: TemplateAssignment;
  readonly source: TemplatePolicySource;
  readonly expect: {
    readonly allowed: boolean;
    readonly reason: TemplatePolicyDenyReason | null;
    readonly resolvedVersion?: string | null;
    readonly missingPermissions?: readonly string[];
    readonly pinVersion?: string | null;
  };
}

/** 任务 task-1 把 word 钉在 1.0.0；在用版本已升到 2.0.0，旧版本转冻结保留。 */
const PINNED_SOURCE: TemplatePolicySource = source(
  [WORD, WORD_V1, EXCEL],
  [installed(WORD), installed(WORD_V1, { active: false, frozen: true }), installed(EXCEL)],
  [{ task_id: 'task-1', template_id: 'word', version: '1.0.0' }],
);

const MATRIX: readonly MatrixRow[] = [
  {
    name: '四态俱齐 ⇒ 允许（解析到在用版本）',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word' },
    source: healthySource(),
    expect: { allowed: true, reason: null, resolvedVersion: '2.0.0', missingPermissions: [] },
  },
  {
    name: '显式指定在用版本 ⇒ 允许',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word', requested_version: '2.0.0' },
    source: healthySource(),
    expect: { allowed: true, reason: null, resolvedVersion: '2.0.0' },
  },
  {
    name: '未知模板 id（不在 K06 manifest 目录）⇒ template_unknown',
    assignment: { subtask_id: 'a', capability_id: 'ghost.run', template_id: 'ghost' },
    source: healthySource(),
    expect: { allowed: false, reason: 'template_unknown', resolvedVersion: null },
  },
  {
    name: 'id 已知但从未安装 ⇒ template_not_installed',
    assignment: { subtask_id: 'a', capability_id: 'sheet.edit', template_id: 'excel' },
    source: source([EXCEL], [installed(WORD)]),
    expect: { allowed: false, reason: 'template_not_installed', resolvedVersion: null },
  },
  {
    name: '已装但已卸载 ⇒ template_not_installed',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word' },
    source: source([WORD], [installed(WORD, { uninstalled: true, active: false, enabled: false })]),
    expect: { allowed: false, reason: 'template_not_installed', resolvedVersion: null },
  },
  {
    name: '已装已授权但被停用 ⇒ template_disabled',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word' },
    source: source([WORD], [installed(WORD, { enabled: false })]),
    expect: { allowed: false, reason: 'template_disabled', resolvedVersion: '2.0.0' },
  },
  {
    name: '启用但权限未授予 ⇒ template_not_authorized（缺 file-write）',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word' },
    source: source([WORD], [installed(WORD, { grantedPermissions: [] })]),
    expect: {
      allowed: false,
      reason: 'template_not_authorized',
      resolvedVersion: '2.0.0',
      missingPermissions: ['file-write'],
    },
  },
  {
    name: '仅部分授权 ⇒ template_not_authorized',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word' },
    source: source([WORD], [installed(WORD, { grantedPermissions: ['storage'] })]),
    expect: { allowed: false, reason: 'template_not_authorized', missingPermissions: ['file-write'] },
  },
  {
    name: '指定的版本未安装 ⇒ template_version_mismatch',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word', requested_version: '9.9.9' },
    source: healthySource(),
    expect: { allowed: false, reason: 'template_version_mismatch', resolvedVersion: null },
  },
  {
    name: '指定版本与任务钉住的版本不符 ⇒ template_version_mismatch（pinned-version mismatch）',
    assignment: {
      subtask_id: 'a',
      capability_id: 'word.edit',
      template_id: 'word',
      task_id: 'task-1',
      requested_version: '2.0.0',
    },
    source: PINNED_SOURCE,
    expect: { allowed: false, reason: 'template_version_mismatch', pinVersion: '1.0.0' },
  },
  {
    name: '钉住冻结旧版本、未指定版本 ⇒ 允许并解析到钉住版本（不静默替换）',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word', task_id: 'task-1' },
    source: PINNED_SOURCE,
    expect: { allowed: true, reason: null, resolvedVersion: '1.0.0', pinVersion: '1.0.0' },
  },
  {
    name: '任务钉的是别的模板 ⇒ 对本模板不生效，按在用版本放行',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word', task_id: 'task-1' },
    source: source(
      [WORD, EXCEL],
      [installed(WORD), installed(EXCEL)],
      [{ task_id: 'task-1', template_id: 'excel', version: '1.0.0' }],
    ),
    expect: { allowed: true, reason: null, resolvedVersion: '2.0.0', pinVersion: null },
  },
  {
    name: '非在用、未钉的其它版本仍可用（多版本目录里显式指定已装版本）',
    assignment: { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word', requested_version: '1.0.0' },
    source: source([WORD, WORD_V1], [installed(WORD), installed(WORD_V1, { active: false })]),
    expect: { allowed: true, reason: null, resolvedVersion: '1.0.0' },
  },
];

describe('K-I11 模板授权策略 · 表驱动允许/拒绝矩阵', () => {
  for (const row of MATRIX) {
    it(row.name, () => {
      const decision = evaluateTemplateAssignment(row.assignment, row.source);
      expect(decision.allowed).toBe(row.expect.allowed);
      expect(decision.reason).toBe(row.expect.reason);
      // 判定结论与 reason 的一致性：allowed ⇔ reason === null。
      expect(decision.reason === null).toBe(decision.allowed);
      if (row.expect.resolvedVersion !== undefined) {
        expect(decision.resolved_version).toBe(row.expect.resolvedVersion);
      }
      if (row.expect.missingPermissions !== undefined) {
        expect([...decision.missing_permissions]).toEqual([...row.expect.missingPermissions]);
      }
      if (row.expect.pinVersion !== undefined) {
        expect(decision.pin_version).toBe(row.expect.pinVersion);
      }
    });
  }
});

describe('K-I11 矩阵 · 五条拒因各自独立、且投影到 K05 阻塞原因是满射', () => {
  it('被拒行覆盖全部五条拒因（缺一条即失败）', () => {
    const observed = new Set<TemplatePolicyDenyReason>();
    for (const row of MATRIX) {
      if (!row.expect.allowed) {
        const decision = evaluateTemplateAssignment(row.assignment, row.source);
        expect(decision.allowed).toBe(false);
        if (decision.reason !== null) {
          observed.add(decision.reason);
        }
      }
    }
    expect([...observed].sort()).toEqual([...TEMPLATE_POLICY_DENY_REASONS].sort());
  });

  it('五条拒因两两不同（同一行不会同时命中两条）', () => {
    const reasons = new Set(TEMPLATE_POLICY_DENY_REASONS);
    expect(reasons.size).toBe(5);
  });

  it('toBlockReason 对五条拒因都有映射（满射到 K05 阻塞原因）', () => {
    const policy = createTemplatePolicy(healthySource());
    for (const reason of TEMPLATE_POLICY_DENY_REASONS) {
      const blockReason = policy.toBlockReason(reason);
      expect(blockReason).toBe(DENY_REASON_TO_BLOCK_REASON[reason]);
      expect(typeof blockReason).toBe('string');
    }
    // "不能调未授权模板"必须落到 K05 原生的 capability_not_authorized。
    expect(policy.toBlockReason('template_not_authorized')).toBe('capability_not_authorized');
  });

  it('evaluateAll 与逐条 evaluate 结论一致（顺序保持）', () => {
    const policy = createTemplatePolicy(healthySource());
    const assignments: readonly TemplateAssignment[] = [
      { subtask_id: 'a', capability_id: 'word.edit', template_id: 'word' },
      { subtask_id: 'b', capability_id: 'ghost.run', template_id: 'ghost' },
    ];
    const all = policy.evaluateAll(assignments);
    expect(all.map((d) => d.allowed)).toEqual([true, false]);
    expect(all.map((d) => d.reason)).toEqual([null, 'template_unknown']);
    expect(all.map((d) => d.subtask_id)).toEqual(['a', 'b']);
  });
});
