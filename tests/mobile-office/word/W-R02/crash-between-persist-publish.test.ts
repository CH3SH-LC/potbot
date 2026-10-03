/**
 * **W-I24 / W-R02 —— 持久化与发布之间那一次崩溃（落在 K09 `StoragePort` 契约上）**。
 *
 * ## 本文件补的是哪一处
 *
 * `scale-cancel-recovery.test.ts` 的 §F 用"丢对象 + JSON 文本往返"表达崩溃：证明字节过
 * 一道字符串边界还能读回。它**证明不了**真实手机上的接缝——账本（会话状态）**已经落盘**、
 * 而"这一版已交付"的回执还没回到调用方，进程就被系统杀了。
 *
 * 本文件把那条接缝显式化：{@link runPersistCrashScenario} 让会话的持久化与发布端口都
 * **真的**跑在 K09 `StoragePort` 之上，并可在 K09 的**操作边界**注入崩溃。判据：
 *
 * | 组 | 崩溃相位 | 关键判据 |
 * |---|---|---|
 * | §A | 账本 CB 落盘**后**（after-persist） | 恢复出首次编辑；原幂等键判为 `replayed` 且**不产生第二版**；续编版本恰好 +1（不双进） |
 * | §B | 账本 CA 落盘**前**（before-persist，反向对照） | 恢复后**没有任何版本**；同一幂等键**未**被判为重放（证明 A 的重放不是凭空来的） |
 * | §C | —— | 账本真是 K09 的 `content://` blob：`sha256:` 摘要、`readBack` 通过、CAS revision 递增、无电脑绝对路径 |
 * | §D | 已落盘事务的**下一次发布**中途 | 恢复回到已落盘版本；重放不重复；续编 +1 |
 *
 * ## 缺口实况（如实）
 *
 * 本仓 `DocumentSession.submitEdit` 的顺序是**先发布 → 再持久化**。因此"崩溃在持久化之后、
 * 发布之前"的**单事务**形态在实现里不存在；它落地为两种可注入、可断言的接缝：
 * §A 的"持久化已落盘、回执未返回"（K09 `commit:after-apply` 语义），以及 §D 的
 * "上一事务已持久化、下一事务发布中途崩溃"。两者都断言同一组消费方判据。
 *
 * ## 边界
 *
 * - 端口/存储是**内存里的真实现**（K09 `MemoryStoragePort`），不是 mock，也没有真实磁盘；
 *   真正的手机介质属 on-device 层，**本文件不覆盖**。
 * - 不联网、不读密钥、不碰桌面文件系统；所有引用都是 `content://`。
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryStoragePort,
  isContentUri,
  isDesktopAbsolutePath,
} from '../../../../apps/mobile-kernel/storage/index.js';
import { importDocx } from '../../../../src/documents/docx/index.js';
import { digestBytes } from '../../../../src/documents/session/canonical.js';
import {
  DocumentSession,
  decodeSessionState,
  type SessionState,
} from '../../../../src/documents/session/index.js';
import { buildDocx } from './harness/docx-builder.js';
import {
  CrashStoragePort,
  InjectedCrashError,
  K09PublishPort,
  StoragePortPersistence,
  runPersistCrashScenario,
  FIXED_NOW_MS,
  type CrashTarget,
} from './harness/crash-storage.js';
import {
  FIXED_NOW,
  boldFirstParagraphIntent,
  centerParagraphIntent,
  countModel,
  mustOk,
  submitInput,
} from './harness/session-driver.js';
import type { DocumentProfile } from './harness/types.js';

const PROFILE: DocumentProfile = {
  paragraphs: 20,
  tables: 1,
  table_rows: 2,
  table_cols: 2,
  with_image: false,
  image_bytes: 0,
};

const FILENAME = 'w-r02-crash.docx';

function corpusBytes(): Uint8Array {
  return buildDocx(PROFILE).bytes;
}

/** 把一份账本原始字节解码成会话状态（供独立核算，不依赖会话内部量）。 */
function decodeLedger(raw: Uint8Array | null): SessionState {
  if (raw === null) throw new Error('账本应有原始字节');
  return decodeSessionState(JSON.parse(new TextDecoder().decode(raw)) as unknown) as SessionState;
}

// ---------------------------------------------------------------------------
// §A 崩溃在账本持久化落盘之后（after-persist）
// ---------------------------------------------------------------------------

describe('§A 账本已落盘后崩溃：重放不重复、版本不双进', () => {
  const TARGET: CrashTarget = {
    operation: 'compareAndSwap',
    occurrence: 2, // 1 = 导入落盘；2 = 首次编辑的持久化
    phase: 'after',
    label: '首次编辑的账本落盘后中断',
  };

  it('恢复出已落盘的那一版；原幂等键判为重放且版本 / 交付数都不动', async () => {
    const run = await runPersistCrashScenario({
      bytes: corpusBytes(),
      session_id: 'S-CRASH-PERSIST',
      filename: FILENAME,
      first_key: 'crash-persist-key-1',
      first_intent: centerParagraphIntent(5),
      resume_key: 'crash-persist-key-2',
      resume_intent: boldFirstParagraphIntent(),
      target: TARGET,
    });
    const o = run.outcome;

    // ① 崩溃真的注入了，相位是"落盘后"；账本多了那一版（导入 1 → 首次编辑 2）。
    expect(o.crash_observed).toBe(true);
    expect(o.crash_phase).toBe('after');
    expect(o.ledger_revision_at_crash).toBe(2);
    // 崩溃点确实在持久化**之后**：首次编辑的产物已经交付进 K09。
    expect(o.artifact_v1_present).toBe(true);

    // 盘上的账本（独立解码）确实含着首次编辑与它的幂等记录——这是"重放"的根据。
    const state = decodeLedger(run.ledger_bytes_after_crash);
    expect(state.edit_revision).toBe(1);
    expect(state.published).toHaveLength(1);
    expect(state.idempotency).toHaveLength(1);

    // ② 只从账本恢复：首次编辑完整可见。
    expect(o.restored).toBe(true);
    expect(o.revision_after_restore).toBe(1);
    expect(o.published_count_after_restore).toBe(1);

    // ③ 原幂等键重放 ⇒ 判为重放，版本与交付数一个都不动（无第二个版本，R137/R146）。
    expect(o.replay_is_replayed).toBe(true);
    expect(o.revision_after_replay).toBe(1);
    expect(o.published_count_after_replay).toBe(1);

    // ④ 续编一条新编辑 ⇒ 成功且版本 +1；整体只前进一步（没有双进）。
    expect(o.resumed_edit_ok).toBe(true);
    expect(o.revision_after_resume).toBe(2);
    expect(o.published_count_after_resume).toBe(2);
  });

  it('恢复后续编的会话可导出，且经独立再导入仍是同一结构（不是只读残骸）', async () => {
    const run = await runPersistCrashScenario({
      bytes: corpusBytes(),
      session_id: 'S-CRASH-PERSIST-2',
      filename: FILENAME,
      first_key: 'crash-persist-key-1',
      first_intent: centerParagraphIntent(5),
      resume_key: 'crash-persist-key-2',
      resume_intent: boldFirstParagraphIntent(),
      target: TARGET,
    });
    const resumed = run.resumed;
    if (resumed === null) throw new Error('应恢复出会话');
    const exported = mustOk(resumed.exportBytes());
    const reimported = importDocx(exported);
    // 结构仍在（表格 1 张）。
    expect(countModel(reimported).tables).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §B 反向对照：崩溃在账本落盘之前（before-persist）
// ---------------------------------------------------------------------------

describe('§B 账本落盘前崩溃：恢复后没有任何版本（反向对照）', () => {
  const TARGET: CrashTarget = {
    operation: 'compareAndSwap',
    occurrence: 2,
    phase: 'before',
    label: '首次编辑的账本落盘前中断',
  };

  it('账本停在导入那一版；同一幂等键未被登记（不是重放），恢复后版本为 0', async () => {
    const run = await runPersistCrashScenario({
      bytes: corpusBytes(),
      session_id: 'S-CRASH-NOPERSIST',
      filename: FILENAME,
      first_key: 'crash-nopersist-key-1',
      first_intent: centerParagraphIntent(5),
      resume_key: 'crash-nopersist-key-2',
      resume_intent: boldFirstParagraphIntent(),
      target: TARGET,
    });
    const o = run.outcome;

    expect(o.crash_observed).toBe(true);
    expect(o.crash_phase).toBe('before');
    // 账本只到导入那一版；首次编辑的持久化从未发生。
    expect(o.ledger_revision_at_crash).toBe(1);
    // 如实记录：产物在持久化**之前**就已写进 K09 —— 这是本次建模下的孤儿产物，
    // 会话账本里却没有对应版本（正是"发布成功、登记失败"的真实缺口形态）。
    expect(o.artifact_v1_present).toBe(true);

    const state = decodeLedger(run.ledger_bytes_after_crash);
    expect(state.edit_revision).toBe(0);
    expect(state.published).toHaveLength(0);
    expect(state.idempotency).toHaveLength(0);

    // 反向对照的核心：恢复后**没有版本**。
    expect(o.restored).toBe(true);
    expect(o.revision_after_restore).toBe(0);
    expect(o.published_count_after_restore).toBe(0);

    // 同一个幂等键**没有**被登记 ⇒ 不是重放，而是一次真正的新提交（恰好证明 A 的重放有据）。
    expect(o.replay_is_replayed).toBe(false);
    expect(o.replay_ok).toBe(true);
    expect(o.revision_after_replay).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §C 账本真的落在 K09 StoragePort 契约上
// ---------------------------------------------------------------------------

describe('§C 账本是 K09 StoragePort 里的一个 content:// blob', () => {
  it('content:// 引用、sha256 摘要、readBack 通过、CAS revision 递增、无电脑绝对路径', async () => {
    const disk = new MemoryStoragePort({ now: () => FIXED_NOW_MS });
    const persistence = new StoragePortPersistence({ storage: disk, relativePath: 'sessions/S-LEDGER.json' });
    const port = new K09PublishPort(disk);
    const session = mustOk(
      DocumentSession.importFrom(
        { id: 'S-LEDGER', filename: FILENAME, persistence, publish_port: port, now: FIXED_NOW },
        corpusBytes(),
      ),
    );
    mustOk(await session.submitEdit(submitInput(session, 'ledger-key-1', centerParagraphIntent(4))));

    const uri = persistence.uri;
    // 手机内容 URI，绝不是电脑绝对路径（K09 红线）。
    expect(isContentUri(uri)).toBe(true);
    expect(isDesktopAbsolutePath(uri)).toBe(false);

    const blob = disk.readBlob(uri);
    expect(blob.status).toBe('ok');
    // 导入落 1 版、一次编辑落第 2 版：CAS 递增，不是原地静默覆盖。
    expect(blob.revision).toBe(2);
    expect(blob.blob?.digest.startsWith('sha256:')).toBe(true);

    const raw = persistence.rawBytes();
    // K09 端的 sha256 与仓内 sha256 指向同一份账本字节。
    expect(blob.blob?.digest).toBe(`sha256:${digestBytes(raw ?? new Uint8Array())}`);

    // 读回凭据 verified：核对的是**实际读回**的内容。
    const readBack = disk.readBack({ uri });
    expect(readBack.status).toBe('ok');
    expect(readBack.readBack?.verified).toBe(true);

    // 账本解码回来就是这一版（edit_revision 1 / 已交付 1 条）。
    const state = decodeLedger(raw);
    expect(state.edit_revision).toBe(1);
    expect(state.published).toHaveLength(1);
  });

  it('账本写路径的 CAS 冲突被如实拒绝（期望版本不符 ⇒ conflict，值不被改写）', () => {
    const disk = new MemoryStoragePort({ now: () => FIXED_NOW_MS });
    const uri = disk.getContentUri({ relativePath: 'sessions/manual.json' }).uri;
    const encoder = new TextEncoder();

    const first = disk.compareAndSwap({ uri, expectedRevision: 0, bytes: encoder.encode('v1') });
    expect(first.status).toBe('ok');
    expect(first.cas.newRevision).toBe(1);

    const conflicting = disk.compareAndSwap({ uri, expectedRevision: 5, bytes: encoder.encode('v2') });
    expect(conflicting.status).toBe('conflict');
    expect(conflicting.cas.newRevision).toBe(1);

    const after = disk.readBlob(uri);
    expect(new TextDecoder().decode(after.bytes ?? new Uint8Array())).toBe('v1');
  });
});

// ---------------------------------------------------------------------------
// §D 已落盘事务之后、下一次发布中途崩溃
// ---------------------------------------------------------------------------

describe('§D 持久化已落盘，下一次发布中途崩溃：恢复回到已落盘版本', () => {
  it('发布崩溃使会话不前进；恢复后重放不重复、续编版本 +1', async () => {
    const disk = new MemoryStoragePort({ now: () => FIXED_NOW_MS });
    const crashing = new CrashStoragePort(disk, null);
    const persistence = new StoragePortPersistence({
      storage: crashing,
      relativePath: 'sessions/S-CRASH-BETWEEN.json',
    });
    const port = new K09PublishPort(crashing);
    const session = mustOk(
      DocumentSession.importFrom(
        { id: 'S-CRASH-BETWEEN', filename: FILENAME, persistence, publish_port: port, now: FIXED_NOW },
        corpusBytes(),
      ),
    );

    // 第一次编辑：完整成功并**落盘**（这一步就是"持久化已落盘"）。
    const first = submitInput(session, 'between-key-1', centerParagraphIntent(3));
    mustOk(await session.submitEdit(first));
    expect(session.currentRevision()).toBe(1);
    expect(session.publishedVersions()).toHaveLength(1);

    // 武装：编辑 2 的**发布写流**在落任何字节之前中断（writeStream 第 2 次 = 编辑 2 的产物）。
    crashing.arm({ operation: 'writeStream', occurrence: 2, phase: 'before', label: '编辑 2 发布写流前中断' });

    const second = submitInput(session, 'between-key-2', boldFirstParagraphIntent());
    // 端口异常既可被会话收口成结构化 `publish_failed`，也可向上抛——本用例只钉 R145
    // 要求的**消费方判据**（状态机不前进），不把「异常是否被吞」变成一条会随
    // `src/documents/session/session.ts` 演进而抖动的断言。
    let secondFailed = false;
    let secondCode: string | null = null;
    try {
      const secondResult = await session.submitEdit(second);
      secondFailed = !secondResult.ok;
      secondCode = secondResult.ok ? null : secondResult.code;
    } catch (error) {
      if (error instanceof InjectedCrashError) secondFailed = true;
      else throw error;
    }
    expect(secondFailed).toBe(true);
    expect(secondCode === null || secondCode === 'publish_failed').toBe(true);
    // R145：发布失败 ⇒ 状态机不前进。
    expect(session.currentRevision()).toBe(1);
    expect(session.publishedVersions()).toHaveLength(1);
    // 编辑 2 的产物（v2）从未落进 K09 —— 崩溃真的挡住了那次发布。
    expect(disk.readBlob(port.artifactUri(2, FILENAME)).status).toBe('not-found');
    expect(crashing.fired?.operation).toBe('writeStream');
    expect(crashing.fired?.phase).toBe('before');
    expect(crashing.fired?.occurrence).toBe(2);

    // "杀进程"：只留盘（K09 内存后端），新进程从账本恢复。
    const restored = DocumentSession.restore({
      id: 'S-CRASH-BETWEEN',
      filename: FILENAME,
      persistence: new StoragePortPersistence({
        storage: new CrashStoragePort(disk, null),
        relativePath: 'sessions/S-CRASH-BETWEEN.json',
      }),
      publish_port: new K09PublishPort(new CrashStoragePort(disk, null)),
      now: FIXED_NOW,
    });
    if (restored.session === null) throw new Error('应恢复出会话');
    const resumed = restored.session;
    expect(resumed.currentRevision()).toBe(1);
    expect(resumed.publishedVersions()).toHaveLength(1);

    // 重放第一次编辑的幂等键：判为重放、版本不动。
    const replay = await resumed.submitEdit(first);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('重放应成功');
    expect(replay.value.replayed).toBe(true);
    expect(resumed.currentRevision()).toBe(1);
    expect(resumed.publishedVersions()).toHaveLength(1);

    // 续编编辑 2（换新键）：成功、版本 +1。
    mustOk(await resumed.submitEdit(submitInput(resumed, 'between-key-2-retry', boldFirstParagraphIntent())));
    expect(resumed.currentRevision()).toBe(2);
    expect(resumed.publishedVersions()).toHaveLength(2);
  });
});
