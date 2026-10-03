/**
 * M-I07 —— **可序列化存储**：让「重启不重复下单」在单进程内可证。
 *
 * M07 的内存 store 只保证单进程幂等；"重启后仍读到同一份记录"依赖注入真存储。
 * 本切片补上一对纯数据 API（`serializeOrderSubmissionStore` /
 * `restoreOrderSubmissionStore`），使"进程 A 提交 → 导出快照 → 进程 B 由快照恢复 →
 * 同键再次提交不再调执行器"可以在**一个测试进程里**被真实验证，不依赖手机 DB。
 *
 * 这是真机 K09/StoragePort 的**可测试替身**，不是真机持久化。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderSubmitError,
  ORDER_STORE_SNAPSHOT_VERSION,
  createInMemoryOrderStore,
  exportOrderSubmissionStore,
  parseOrderSubmissionStoreSnapshot,
  rateLimitedResponse,
  restoreOrderSubmissionStore,
  serializeOrderSubmissionStore,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { createScenario } from './support.js';

describe('M-I07 快照往返', () => {
  it('序列化 → 反序列化：记录、状态、哈希键逐项保真', () => {
    const scenario = createScenario();
    return scenario.submitter
      .submit({ authorization: scenario.ref, idempotencyKey: scenario.key })
      .then(() => {
        const json = serializeOrderSubmissionStore(scenario.store);
        const restored = restoreOrderSubmissionStore(json);
        const before = scenario.store.all();
        const after = restored.all();

        expect(after.length).toBe(before.length);
        expect(after.length).toBe(1);
        expect(after[0]?.idempotencyKey).toBe(scenario.key);
        expect(after[0]?.state).toBe('submitted');
        expect(after[0]?.httpStatus).toBe(200);
        expect(after[0]?.businessCode).toBe('ok');
        expect(after[0]?.outcomeKind).toBe('success');
        expect(after[0]?.sendIntentAt).not.toBeNull();
        expect(after[0]).toEqual(before[0]);
      });
  });

  it('export 快照带版本号，且与 store 后续变更解耦（深拷贝）', async () => {
    const scenario = createScenario();
    const snapshot = exportOrderSubmissionStore(scenario.store);
    expect(snapshot.version).toBe(ORDER_STORE_SNAPSHOT_VERSION);
    expect(snapshot.records.length).toBe(0);

    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    // 导出发生在提交之前 ⇒ 快照不应看到后来的记录。
    expect(snapshot.records.length).toBe(0);
    expect(exportOrderSubmissionStore(scenario.store).records.length).toBe(1);
  });
});

describe('M-I07 重启不重复下单（由可序列化快照证明）', () => {
  it('进程 A 提交 ⇒ 导出 ⇒ 进程 B 恢复同键重提：去重、执行器零调用', async () => {
    // —— 进程 A ——
    const a = createScenario();
    const first = await a.submitter.submit({ authorization: a.ref, idempotencyKey: a.key });
    expect(first.executorCalled).toBe(true);
    expect(a.executor?.calls.length).toBe(1);

    const persisted = serializeOrderSubmissionStore(a.store);

    // —— 模拟重启：新进程、新执行器、新查询端口，但同一份持久化账本 ——
    const b = createScenario({ store: restoreOrderSubmissionStore(persisted) });
    const second = await b.submitter.submit({ authorization: b.ref, idempotencyKey: b.key });

    expect(second.deduplicated).toBe(true);
    expect(second.executorCalled).toBe(false);
    expect(b.executor?.calls.length).toBe(0); // **从未再次调用执行器**
    expect(second.record.state).toBe('submitted');
    expect(b.submitter.counts().records).toBe(1);
  });

  it('进程 A 得到 429（rate_limited/unknown）后重启：状态保真、仍不重下', async () => {
    const a = createScenario({ respond: () => rateLimitedResponse('30') });
    const first = await a.submitter.submit({ authorization: a.ref, idempotencyKey: a.key });
    expect(first.record.state).toBe('unknown');
    expect(first.record.outcomeKind).toBe('rate_limited');

    const persisted = serializeOrderSubmissionStore(a.store);
    const b = createScenario({ store: restoreOrderSubmissionStore(persisted) });
    const restored = b.submitter.getRecord(b.key);

    expect(restored?.state).toBe('unknown');
    expect(restored?.outcomeKind).toBe('rate_limited');
  });

  it('not-sent 记录跨重启仍为 not-sent（sendIntentAt 保真为 null）', async () => {
    const a = createScenario({ respond: () => ({ transport: 'offline', detail: 'offline' }) });
    await a.submitter.submit({ authorization: a.ref, idempotencyKey: a.key });
    expect(a.submitter.getRecord(a.key)?.sendIntentAt).toBeNull();

    const b = createScenario({ store: restoreOrderSubmissionStore(serializeOrderSubmissionStore(a.store)) });
    const verdict = b.submitter.recover(b.key);
    expect(verdict.kind).toBe('not_sent');
    expect(verdict.allowedAction).toBe('resume_same_submission');
    expect(b.submitter.getRecord(b.key)?.sendIntentAt).toBeNull();
  });
});

describe('M-I07 快照校验：非法一律拒，不猜、不静默降级', () => {
  it('版本不符 ⇒ invalid_submission_snapshot', () => {
    expect(() =>
      parseOrderSubmissionStoreSnapshot({ version: 99, records: [] }),
    ).toThrowError(OrderSubmitError);
    try {
      parseOrderSubmissionStoreSnapshot({ version: 99, records: [] });
    } catch (error) {
      expect((error as OrderSubmitError).code).toBe('invalid_submission_snapshot');
    }
  });

  it('非 JSON 字符串 / 非对象 ⇒ 拒', () => {
    expect(() => parseOrderSubmissionStoreSnapshot('{not json')).toThrowError(OrderSubmitError);
    expect(() => parseOrderSubmissionStoreSnapshot(42)).toThrowError(OrderSubmitError);
  });

  it('记录缺字段 / 状态不在词表 ⇒ 拒', async () => {
    const scenario = createScenario();
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    const snapshot = JSON.parse(serializeOrderSubmissionStore(scenario.store)) as {
      version: number;
      records: Record<string, unknown>[];
    };

    const missing = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    delete missing.records[0]!.idempotencyKey;
    expect(() => parseOrderSubmissionStoreSnapshot(missing)).toThrowError(OrderSubmitError);

    const badState = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    badState.records[0]!.state = 'placed';
    expect(() => parseOrderSubmissionStoreSnapshot(badState)).toThrowError(OrderSubmitError);
  });

  it('重复幂等键 ⇒ 拒', async () => {
    const scenario = createScenario();
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    const snapshot = JSON.parse(serializeOrderSubmissionStore(scenario.store)) as {
      version: number;
      records: unknown[];
    };
    snapshot.records = [snapshot.records[0], snapshot.records[0]];
    expect(() => parseOrderSubmissionStoreSnapshot(snapshot)).toThrowError(OrderSubmitError);
  });

  it('空账本往返仍成立', () => {
    const restored = restoreOrderSubmissionStore(serializeOrderSubmissionStore(createInMemoryOrderStore()));
    expect(restored.all().length).toBe(0);
  });
});
