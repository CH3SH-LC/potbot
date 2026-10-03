/**
 * **交付链路的工作记录与完成口径**（合同 **R264 第 3 条**；外部监督 S-1026-01 的善后）。
 *
 * ## 这一组要证明什么
 *
 * R264 补强后，`allWorkItemsTerminal([])` 返回 `false`——空工作集不再"真空满足"判据①。
 * 但那只堵住了**假成功**；它还留下一个**假失败**：交付会话从不登记任何工作项，
 * 于是每个交付任务都会永远停在"尚未完成"，**哪怕文件已经交付**。
 *
 * 所以 R264 第 3 条要求交付链路**真的产生工作记录**：每一次交付/编辑尝试（**成功与被拒都要**）
 * 都要落成可被完成视图读取的记录。本文件钉住四条：
 *
 * 1. **被拒的编辑必须可见**：`set MissingSheet!A1` 被拒之后，完成视图**不得**报
 *    `completed_and_successful`，且那条被拒的记录带得出失败原因（不是靠视图补文案）。
 * 2. **在途不得成功**：交付进行中（物化端口还没回话）时查询完成视图 ⇒ 不得判完成。
 * 3. **取消后迟到结果不得变成功**：先取消、后到达的成功结局**不得**把工作项改写成功。
 * 4. **工作记录在既有内核存储里**，不是第二份账本：与任务同 `task_id`、同 `Store`。
 *
 * ## 诚实边界
 *
 * 这三条是**电脑侧**的；真机未验证。`cancelPendingWork()` **没有 HTTP 入口**（见
 * `interface-declaration.md` 的 J-6）——它是这条不变量的可测落点，不是已交付的产品功能。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDocumentPort, type DocumentPort, type MaterializeReceipt } from '../documents/port.js';
import { DeliverableHost } from './deliverable-host.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-deliverable-completion-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function newHost(documents: DocumentPort): DeliverableHost {
  return new DeliverableHost({
    documents,
    artifact_root_dir: workDir.split('\\').join('/'),
    run_id: 'FA-U-R264-RUN',
    now: () => new Date('2026-10-03T00:00:00.000Z'),
  });
}

/**
 * 把真实物化端口包一层**闸门**：`materialize` 先报到、再等放行。
 *
 * 用途是把"交付在途"这个瞬间**变成可观测的**——不是模拟一个假的慢端口，
 * 而是让真实的写盘发生在测试说了算的时刻。
 */
function gatedPort(): {
  readonly port: DocumentPort;
  readonly arrived: Promise<void>;
  release(): void;
} {
  const real = createDocumentPort(workDir);
  let releaseGate: () => void = () => {};
  let signalArrived: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    signalArrived = resolve;
  });
  return {
    port: {
      materialize: async (request): Promise<MaterializeReceipt> => {
        signalArrived();
        await gate;
        return real.materialize(request);
      },
      readBack: (artifactId, format) => real.readBack(artifactId, format),
    },
    arrived,
    release: () => releaseGate(),
  };
}

/** 开一个空白 XLSX 交付会话。 */
function openSheet(host: DeliverableHost, sessionId = 'sheet'): void {
  const opened = host.open({
    session_id: sessionId,
    deliverable_id: `${sessionId}-1`,
    filename: '台账.xlsx',
    format: 'xlsx',
    title: '台账',
  });
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
}

/** 取当前基线（完成视图里不带，得从会话状态取）。 */
function baseline(host: DeliverableHost, sessionId: string): { revision: number; digest: string } {
  const status = host.status(sessionId);
  expect(status).toBeDefined();
  return { revision: status?.edit_revision ?? 0, digest: status?.content_digest ?? '' };
}

// ---------------------------------------------------------------------------
// 1. 被拒的编辑必须可见（R264 第 3 条的最小复现）
// ---------------------------------------------------------------------------

describe('R264 第 3 条：失败与被拒编辑必须参与完成口径', () => {
  it('监督的最小复现：成功一步 → 被拒一步 ⇒ **不得**报"已完成且成功"', async () => {
    const host = newHost(createDocumentPort(workDir));
    openSheet(host, 'repro');

    // ① 第一步：写进真实存在的 Sheet1 —— 成功。
    const first = baseline(host, 'repro');
    const ok = await host.publish('repro', {
      idempotency_key: 'repro-step-1',
      base_revision: first.revision,
      base_digest: first.digest,
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '季度' } },
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);

    // ② 第二步：写进**不存在**的表 —— 被拒（用返回的 revision/digest 与新幂等键）。
    const second = baseline(host, 'repro');
    const rejected = await host.publish('repro', {
      idempotency_key: 'repro-step-2',
      base_revision: second.revision,
      base_digest: second.digest,
      edit: { op: 'set_cell', sheet: 'MissingSheet', address: 'A1', value: { kind: 'text', value: 'x' } },
    });
    expect(rejected.ok, '不存在的工作表必须被拒').toBe(false);

    // ③ 完成视图：被拒的那一步**参与**判据。
    const view = host.completionOf('repro');
    expect(view).toBeDefined();
    expect(view?.label, '被拒之后不得报"已完成且成功"').not.toBe('completed_and_successful');
    expect(view?.label).toBe('completed_with_unfinished_business');
    expect(view?.flags.any_work_item_failed).toBe(true);

    // 失败**可见**：记录里带得出原因，而且是真的落进了内核存储（不是视图补的文案）。
    const items = host.workItemsOf('repro');
    expect(items.length, '两次交付尝试 ⇒ 两条工作记录').toBe(2);
    const failed = items.filter((item) => item.status === 'failed');
    expect(failed.length).toBe(1);
    expect(String(failed[0]?.failure_reason ?? '').length, '失败必须带原因').toBeGreaterThan(0);
    expect(items.some((item) => item.status === 'completed')).toBe(true);
  });

  it('只开会话、一次编辑都没有 ⇒ **不得**判完成（空工作集不适用该口径，R264 第 1 条）', () => {
    const host = newHost(createDocumentPort(workDir));
    openSheet(host, 'no-work');
    const view = host.completionOf('no-work');
    expect(view).toBeDefined();
    expect(view?.completed, '没有工作记录 ⇒ 不许说"都做完了"').toBe(false);
    expect(view?.label).toBe('not_completed');
    expect(view?.predicates.all_work_items_terminal).toBe(false);
    expect(host.workItemsOf('no-work').length).toBe(0);
  });

  it('全部成功且产物是当前版本 ⇒ 已完成且成功（对照：不是只会说"没完成"）', async () => {
    const host = newHost(createDocumentPort(workDir));
    openSheet(host, 'happy');
    const base = baseline(host, 'happy');
    const done = await host.publish('happy', {
      idempotency_key: 'happy-1',
      base_revision: base.revision,
      base_digest: base.digest,
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '季度' } },
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);

    const view = host.completionOf('happy');
    expect(view?.completed).toBe(true);
    expect(view?.label).toBe('completed_and_successful');
    expect(view?.delivered_artifact_ids.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 在途不得成功
// ---------------------------------------------------------------------------

describe('R264：在途不得判成功', () => {
  it('物化端口还没回话时查询完成视图 ⇒ 不判完成，且工作项如实停在 processing', async () => {
    const gate = gatedPort();
    const host = newHost(gate.port);
    openSheet(host, 'inflight');
    const base = baseline(host, 'inflight');

    const pending = host.publish('inflight', {
      idempotency_key: 'inflight-1',
      base_revision: base.revision,
      base_digest: base.digest,
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '在途' } },
    });

    // 等到"确实在物化中"（不是靠 sleep 猜），此刻查完成视图。
    await gate.arrived;
    const during = host.completionOf('inflight');
    expect(during?.completed, '在途不得判完成').toBe(false);
    expect(during?.label).toBe('not_completed');
    expect(during?.predicates.all_work_items_terminal).toBe(false);
    expect(host.workItemsOf('inflight').map((item) => item.status)).toEqual(['processing']);

    gate.release();
    const finished = await pending;
    expect(finished.ok, JSON.stringify(finished)).toBe(true);

    // 落地之后才是完成态——同一份存储，前后两个结论。
    const after = host.completionOf('inflight');
    expect(after?.completed).toBe(true);
    expect(after?.label).toBe('completed_and_successful');
  });
});

// ---------------------------------------------------------------------------
// 3. 取消后迟到结果不得变成功
// ---------------------------------------------------------------------------

describe('R264 / R205：取消后迟到结果不得变成功', () => {
  it('先取消、后被放行的成功结局 ⇒ 工作项保持 cancelled，标签是"已完成且被取消"', async () => {
    const gate = gatedPort();
    const host = newHost(gate.port);
    openSheet(host, 'cancel');
    const base = baseline(host, 'cancel');

    const pending = host.publish('cancel', {
      idempotency_key: 'cancel-1',
      base_revision: base.revision,
      base_digest: base.digest,
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '将被取消' } },
    });

    await gate.arrived;
    const cancelled = host.cancelPendingWork('cancel', '用户在交付完成前取消');
    expect(cancelled.length, '应有一条在途工作项被取消').toBe(1);

    gate.release();
    const finished = await pending;
    // 交付**本身**确实发生了（文件真的写盘了）——不假称它没发生。
    expect(finished.ok, JSON.stringify(finished)).toBe(true);

    // 但工作项**不得**被迟到的成功改写（终态吸收，走真实工作项状态机）。
    expect(host.workItemsOf('cancel').map((item) => item.status)).toEqual(['cancelled']);

    const view = host.completionOf('cancel');
    expect(view?.label, '取消不得因为迟到成功而变成"成功"').not.toBe('completed_and_successful');
    expect(view?.label).toBe('completed_and_cancelled');
    expect(view?.flags.any_work_item_cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. 工作记录在既有内核存储里（不是第二份账本）
// ---------------------------------------------------------------------------

describe('R264：工作记录写在既有内核存储里', () => {
  it('工作项与任务同 task_id、同 Store；没有另造账本', async () => {
    const host = newHost(createDocumentPort(workDir));
    openSheet(host, 'same-store');
    const base = baseline(host, 'same-store');
    await host.publish('same-store', {
      idempotency_key: 'same-store-1',
      base_revision: base.revision,
      base_digest: base.digest,
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: 'x' } },
    });

    const task = host.kernelTask('same-store');
    expect(task).toBeDefined();
    const items = host.workItemsOf('same-store');
    expect(items.length).toBe(1);
    // 与 `open()` 登记的那条内核任务**同一个 task_id**——这就是"同一份账本"的结构性判据。
    expect(items[0]?.task_id).toBe(task?.task_id);
    expect(String(items[0]?.task_id)).toBe(String(DeliverableHost.taskIdOf('same-store')));
  });

  it('同一 (会话, 幂等键) 重放不产生第二条工作记录，也不复活已终态的项', async () => {
    const host = newHost(createDocumentPort(workDir));
    openSheet(host, 'replay');
    const base = baseline(host, 'replay');
    const input = {
      idempotency_key: 'replay-1',
      base_revision: base.revision,
      base_digest: base.digest,
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: 'x' } },
    } as const;
    const first = await host.publish('replay', input);
    expect(first.ok).toBe(true);
    const second = await host.publish('replay', input);
    expect(second.ok).toBe(true);

    const items = host.workItemsOf('replay');
    expect(items.length, '重放不是新工作').toBe(1);
    expect(items[0]?.status).toBe('completed');
  });
});
