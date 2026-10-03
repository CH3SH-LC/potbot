/**
 * K08 独立验证 ①：**读失败 / 损坏 ≠ 空库**（本包最核心的一条红线）。
 *
 * 判据独立于实现：用可注入故障的内存后端**直接制造**三种介质状态
 * （key 不存在 / 读失败 / 存在但损坏），断言 `openPhoneMemory()` 的**判别分支**。
 * 反例纪律：损坏必须落 `failed`，**不许**落 `empty`——若实现把损坏当空库，本组用例红。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import {
  DEFAULT_MEMORY_KEY,
  MemoryPersistenceBackend,
  isMemoryPersistenceError,
  openPhoneMemory,
  openPhoneMemoryOrThrow,
  type OpenMemoryResult,
} from '../../../apps/mobile-kernel/memory/index.js';

const OWNER = 'owner-1';
const KEY = DEFAULT_MEMORY_KEY;

function failedOf(result: OpenMemoryResult): Extract<OpenMemoryResult, { kind: 'failed' }> {
  if (result.kind !== 'failed') {
    throw new Error(`期望 failed，实际是 ${result.kind}（读失败/损坏被当成了空库或成功）`);
  }
  return result;
}

/** 独立捕获拒绝，返回错误码（非本线错误返回 'not-memory-error'，绝不静默通过）。 */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return isMemoryPersistenceError(error) ? error.code : 'not-memory-error';
  }
}

describe('K08 ① 读失败 ≠ 空库', () => {
  it('key 从未写过 ⇒ empty（这才是真正的空库）', async () => {
    const port = new MemoryPersistenceBackend();
    const result = await openPhoneMemory({ port, key: KEY });
    expect(result.kind).toBe('empty');
    expect('report' in result).toBe(false);
    expect(port.calls.read).toBe(1);
    // 空库也要能继续用（拿到 store），但不带任何条目
    if (result.kind === 'empty') {
      expect(result.store.allEntries()).toHaveLength(0);
    }
  });

  it('读失败 ⇒ failed(read_failed)，且不交出任何 store', async () => {
    const port = new MemoryPersistenceBackend();
    port.setFaults({ failRead: true });
    const result = await openPhoneMemory({ port, key: KEY });

    const failed = failedOf(result);
    expect(failed.reason).toBe('read_failed');
    // 关键：失败分支不得携带 store，调用方在类型上就拿不到空库
    expect('store' in (result as Record<string, unknown>)).toBe(false);
    expect(failed.detail.length).toBeGreaterThan(0);
  });

  it('读失败重标为特定原因时原样透传（read_failed 之外不误标）', async () => {
    const port = new MemoryPersistenceBackend();
    port.setFaults({ failRead: { reason: 'read_failed', detail: '介质不可达（注入）' } });
    const result = await openPhoneMemory({ port, key: KEY });
    const failed = failedOf(result);
    expect(failed.reason).toBe('read_failed');
    expect(failed.detail).toContain('介质不可达');
  });

  it('存在但 JSON 损坏 ⇒ failed(corrupt)，**不是** empty', async () => {
    const port = new MemoryPersistenceBackend();
    port.setFaults({ corruptBytes: '{ this is not valid json' });
    const result = await openPhoneMemory({ port, key: KEY });

    expect(result.kind).not.toBe('empty');
    const failed = failedOf(result);
    expect(failed.reason).toBe('corrupt');
  });

  it('存在但 schema 不符 ⇒ failed(bad_schema)，**不是** empty', async () => {
    const port = new MemoryPersistenceBackend();
    const wrongSchema = JSON.stringify({
      schema: 'potbot-memory-backup.v0',
      created_at: 0,
      owner_scope: [],
      snapshot: {
        session_messages: [],
        task_facts: [],
        preferences: [],
        template_experiences: [],
        tombstones: [],
        derived: [],
      },
    });
    port.setFaults({ corruptBytes: wrongSchema });
    const result = await openPhoneMemory({ port, key: KEY });

    expect(result.kind).not.toBe('empty');
    expect(failedOf(result).reason).toBe('bad_schema');
  });

  it('完整性未知 ⇒ failed(integrity_unknown)，**不得**当空库', async () => {
    const port = new MemoryPersistenceBackend();
    const result = await openPhoneMemory({
      port,
      key: KEY,
      verifyIntegrity: () => 'uncertain',
    });
    expect(result.kind).not.toBe('empty');
    expect(failedOf(result).reason).toBe('integrity_unknown');
    // 完整性未知时不应去读介质
    expect(port.calls.read).toBe(0);
  });

  it('openPhoneMemoryOrThrow：读失败抛 load_failed；损坏抛 store_unavailable', async () => {
    const failPort = new MemoryPersistenceBackend();
    failPort.setFaults({ failRead: true });
    expect(await rejectionCode(openPhoneMemoryOrThrow({ port: failPort, key: KEY }))).toBe('load_failed');

    const corruptPort = new MemoryPersistenceBackend();
    corruptPort.setFaults({ corruptBytes: 'not json' });
    expect(await rejectionCode(openPhoneMemoryOrThrow({ port: corruptPort, key: KEY }))).toBe(
      'store_unavailable',
    );
  });
});

describe('K08 ① 保存 → 重开：写入的记忆在"介质"上，重启读得回', () => {
  it('空库 → 写长期偏好 → save → 新开库读到同一条（含来源/版本）', async () => {
    const port = new MemoryPersistenceBackend();
    const first = await openPhoneMemory({ port, key: KEY });
    expect(first.kind).toBe('empty');
    if (first.kind !== 'empty') throw new Error('unreachable');

    const written = first.store.rememberPreference({
      owner_id: OWNER,
      preference_key: 'city',
      value_text: '上海',
      memory_id: 'pref-1',
    });
    expect(written.ok).toBe(true);

    const saved = await first.store.save(asLogicalTime(100));
    expect(saved.ok).toBe(true);
    expect(port.peek(KEY)).toBeTypeOf('string');

    // 模拟重开：同一个"介质"，新建库读取
    const reopened = await openPhoneMemory({ port, key: KEY });
    expect(reopened.kind).toBe('loaded');
    if (reopened.kind !== 'loaded') throw new Error('unreachable');

    const prefs = reopened.store.listByKind('preference');
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.memory_id).toBe('pref-1');
    if (prefs[0]?.kind === 'preference') {
      expect(prefs[0].value_text).toBe('上海');
      expect(prefs[0].source.kind).toBe('user_statement');
      expect(prefs[0].version).toBe(0);
    }
    expect(reopened.report.incoming_entries).toBe(1);
  });

  it('写失败 ⇒ save 返回 ok:false（不宣称已保存）', async () => {
    const port = new MemoryPersistenceBackend();
    const opened = await openPhoneMemory({ port, key: KEY });
    if (opened.kind !== 'empty') throw new Error('unreachable');
    opened.store.rememberPreference({ owner_id: OWNER, preference_key: 'k', value_text: 'v' });
    port.setFaults({ failWrite: true });

    const saved = await opened.store.save(asLogicalTime(1));
    expect(saved.ok).toBe(false);
    if (saved.ok === false) {
      expect(saved.reason).toBe('save_failed');
    }
    // 写失败后"介质"上仍没有备份
    expect(port.peek(KEY)).toBeUndefined();
  });
});
