/**
 * F07 验收：编辑 / 停用 / 启用（I3 乐观并发 · I4 身份不可改 · I5 停用≠忘记）。
 *
 * 反向对照：
 *   1) 版本不符 / 缺 expectedVersion → 拒，绝不静默覆盖；
 *   2) 补丁含身份字段（kind/scope/source/ownerId）→ unsupported-patch；
 *   3) 停用只改状态、保留正文；已停用再停用 → already-disabled；启用仅对已停用有效；
 *   4) 已删除的记忆不可编辑。
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryViewModelError,
  applyMemoryEdit,
  disableMemory,
  enableMemory,
} from '../../../apps/mobile-ui/src/memory/index.js';

import { row } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryViewModelError ? error.code : `non-vm-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

describe('F07 / I3 编辑的乐观并发', () => {
  it('版本相符 → 版本 +1，身份字段原样保留', () => {
    const r = row({ version: 3, body: '旧正文' });
    const result = applyMemoryEdit(r, { body: '新正文' }, 3);
    expect(result.previousBody).toBe('旧正文');
    expect(result.body).toBe('新正文');
    expect(result.previousVersion).toBe(3);
    expect(result.version).toBe(4);
    expect(result.source).toEqual(r.source); // 来源保留
    expect(result.scope).toEqual(r.scope);
    expect(result.kind).toBe(r.kind);
  });

  it('版本不符 → stale-version（不覆盖）', () => {
    expect(codeOf(() => applyMemoryEdit(row({ version: 3 }), { body: 'x' }, 2))).toBe('stale-version');
  });

  it('缺 expectedVersion → missing-expected-version', () => {
    expect(codeOf(() => applyMemoryEdit(row(), { body: 'x' }, undefined as never))).toBe(
      'missing-expected-version',
    );
  });

  it('补丁与当前正文相同 → empty-patch', () => {
    const r = row({ body: '一样' });
    expect(codeOf(() => applyMemoryEdit(r, { body: '一样' }, r.version))).toBe('empty-patch');
  });

  it('空补丁 → empty-patch', () => {
    const r = row();
    expect(codeOf(() => applyMemoryEdit(r, {}, r.version))).toBe('empty-patch');
  });
});

describe('F07 / I4 身份字段不可通过编辑变更', () => {
  it.each(['kind', 'scope', 'source', 'ownerId', 'version', 'status', 'confirmation'])(
    '补丁含 %s → unsupported-patch',
    (key) => {
      const r = row();
      expect(codeOf(() => applyMemoryEdit(r, { [key]: 'x' }, r.version))).toBe('unsupported-patch');
    },
  );

  it('补丁含未知字段 → unsupported-patch', () => {
    const r = row();
    expect(codeOf(() => applyMemoryEdit(r, { extra: 1 }, r.version))).toBe('unsupported-patch');
  });

  it('已删除的记忆不可编辑', () => {
    const r = row({ status: 'deleted' });
    expect(codeOf(() => applyMemoryEdit(r, { body: 'x' }, r.version))).toBe('not-editable');
  });
});

describe('F07 / I5 停用 ≠ 忘记', () => {
  it('停用保留正文，只改状态，版本 +1', () => {
    const r = row({ version: 3, body: '保留的内容' });
    const result = disableMemory(r, 3);
    expect(result.previousStatus).toBe('active');
    expect(result.status).toBe('disabled');
    expect(result.body).toBe('保留的内容');
    expect(result.version).toBe(4);
  });

  it('已停用再停用 → already-disabled', () => {
    const r = row({ status: 'disabled' });
    expect(codeOf(() => disableMemory(r, r.version))).toBe('already-disabled');
  });

  it('启用：仅对已停用有效，内容不变', () => {
    const r = row({ status: 'disabled', body: '内容' });
    const result = enableMemory(r, r.version);
    expect(result.previousStatus).toBe('disabled');
    expect(result.status).toBe('active');
    expect(result.body).toBe('内容');
  });

  it('启用生效中的记忆 → not-editable', () => {
    const r = row({ status: 'active' });
    expect(codeOf(() => enableMemory(r, r.version))).toBe('not-editable');
  });

  it('停用同样受乐观并发约束', () => {
    const r = row({ version: 3 });
    expect(codeOf(() => disableMemory(r, 1))).toBe('stale-version');
  });

  it('已删除的记忆不可停用', () => {
    const r = row({ status: 'deleted' });
    expect(codeOf(() => disableMemory(r, r.version))).toBe('not-editable');
  });
});
