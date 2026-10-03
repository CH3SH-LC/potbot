/**
 * K09 独立验证 ③：**反向对照**（把实现改坏 / 输入越界都应当变红）。
 *
 * 每条负例都配**对照组**——否则"恒拒"或"恒冲突"也能骗过负例。
 * 每条断言都指向可复现的外部行为（值有没有被改、字节还在不在），不是"照抄实现"。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MemoryStoragePort,
  isContentUri,
  isDesktopAbsolutePath,
  isStorageError,
  type InterruptPoint,
  type StoragePort,
} from '../../../apps/mobile-kernel/storage/index.js';

const URI_A = 'content://potbot/blobs/a.bin';
const URI_B = 'content://potbot/blobs/b.bin';

function oracleDigest(value: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
}

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** 制造"进程在中断点死亡"的端口。 */
function crashingPort(point: InterruptPoint, detail?: string): StoragePort {
  return new MemoryStoragePort({
    now: () => 1_700_000_000_000,
    interrupt: (event) => {
      if (event.point === point && (detail === undefined || event.detail === detail)) {
        throw new Error(`simulated crash at ${event.point}`);
      }
    },
  });
}

/** 断言某个调用抛出指定拒因；**没抛也照样失败**（不给"静默放行"留缝）。 */
function expectStorageError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    if (!isStorageError(error)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 [${code}]，但调用正常返回了`);
}

// ---------------------------------------------------------------------------
// 负例 ①：CAS 版本不符必须冲突，且绝不静默覆盖
// ---------------------------------------------------------------------------

describe('负例 ①：版本 CAS —— 期望版本不符 ⇒ conflict 且值不被改', () => {
  it('写入 v1（revision=1）后拿 expectedRevision=0 去写 ⇒ conflict，内容仍是 v1', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await port.writeStream({ uri: URI_A, chunks: ['v1'] });

    const conflicted = port.compareAndSwap({ uri: URI_A, expectedRevision: 0, bytes: 'attacker' });
    expect(conflicted.status).toBe('conflict');
    expect(conflicted.cas).toEqual({ expectedRevision: 0, newRevision: 1, result: 'conflict' });
    // 关键：值没被改。
    expect(conflicted.blob?.digest).toBe(oracleDigest('v1'));
    expect(port.readBlob(URI_A).bytes).toEqual(bytesOf('v1'));
    expect(port.readBlob(URI_A).revision).toBe(1);
  });

  it('过期版本号（拿 1 去写已是 2 的）⇒ conflict，值停在 v2', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await port.writeStream({ uri: URI_A, chunks: ['v1'] });
    await port.writeStream({ uri: URI_A, chunks: ['v2'] });

    const conflicted = port.compareAndSwap({ uri: URI_A, expectedRevision: 1, bytes: 'v3-stale' });
    expect(conflicted.status).toBe('conflict');
    expect(port.readBlob(URI_A).bytes).toEqual(bytesOf('v2'));
  });

  it('对照组：版本号正确的 CAS 必须成功（证明"恒冲突"骗不过）', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await port.writeStream({ uri: URI_A, chunks: ['v1'] });

    const ok = port.compareAndSwap({ uri: URI_A, expectedRevision: 1, bytes: 'v2' });
    expect(ok.status).toBe('ok');
    expect(ok.cas.newRevision).toBe(2);
    expect(port.readBlob(URI_A).bytes).toEqual(bytesOf('v2'));
  });

  it('对照组：conflict 之后版本不变，重试正确版本仍可成功', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await port.writeStream({ uri: URI_A, chunks: ['v1'] });
    expect(port.compareAndSwap({ uri: URI_A, expectedRevision: 9, bytes: 'x' }).status).toBe('conflict');
    expect(port.readBlob(URI_A).revision).toBe(1);
    expect(port.compareAndSwap({ uri: URI_A, expectedRevision: 1, bytes: 'v2' }).status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 负例 ②：路径形状必须被拒（不得返回 / 接受电脑绝对路径）
// ---------------------------------------------------------------------------

describe('负例 ②：电脑绝对路径一律拒绝', () => {
  const desktopPaths = [
    'C:\\Users\\<user>\\Desktop\\报告.docx',
    'C:/Users/<user>/Desktop/report.docx',
    'd:\\work\\a.bin',
    '/etc/passwd',
    '/sdcard/Download/x.docx',
  ];

  it('readBlob 收到盘符 / POSIX 绝对路径 ⇒ desktop_path_rejected', () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    for (const path of desktopPaths) {
      expect(isDesktopAbsolutePath(path), path).toBe(true);
      // 直接钉住形状判据本身：`isContentUri` 必须**自己**拒绝绝对路径，
      // 不能只靠调用方先跑一遍 isDesktopAbsolutePath 兜底（那是空壳）。
      expect(isContentUri(path), path).toBe(false);
      expectStorageError(() => port.readBlob(path), 'desktop_path_rejected');
    }
  });

  it('writeStream / compareAndSwap / readBack 同样拒绝', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    for (const path of desktopPaths) {
      await expect(port.writeStream({ uri: path, chunks: ['x'] })).rejects.toMatchObject({
        code: 'desktop_path_rejected',
      });
      expectStorageError(() => port.compareAndSwap({ uri: path, expectedRevision: 0, bytes: 'x' }), 'desktop_path_rejected');
      expectStorageError(() => port.readBack({ uri: path }), 'desktop_path_rejected');
    }
  });

  it('getContentUri 不得把绝对路径"好心"拼成看似合法的 URI', () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    expectStorageError(() => port.getContentUri({ relativePath: 'C:\\Users\\<user>\\a.docx' }), 'desktop_path_rejected');
    expectStorageError(() => port.getContentUri({ relativePath: '/sdcard/a.docx' }), 'desktop_path_rejected');
    expectStorageError(() => port.getContentUri({ relativePath: 'a/../../escape' }), 'invalid_relative_path');
    expectStorageError(() => port.getContentUri({ relativePath: 'a\\b' }), 'invalid_relative_path');
  });

  it('非内容 URI 的其它 scheme（file: / http: / 空串）⇒ invalid_content_uri', () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    for (const bad of ['file:///x', 'http://example.com/a', '', 'blobs/a.bin']) {
      expectStorageError(() => port.readBlob(bad), 'invalid_content_uri');
      expect(isContentUri(bad)).toBe(false);
    }
  });

  it('对照组：合法内容 URI 不被误拒（证明判据不是"恒拒"）', () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    for (const good of ['content://potbot/a', 'blob://potbot/x/y', 'app://potbot/z']) {
      expect(isContentUri(good), good).toBe(true);
      expect(port.getContentUri({ relativePath: 'x' }).status).toBe('ok');
    }
    expect(() => port.readBlob(URI_A)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 负例 ③：摘要不符的读回必须失败
// ---------------------------------------------------------------------------

describe('负例 ③：读回摘要不符 ⇒ status failed 且 verified=false', () => {
  it('介质被篡改（读回破坏注入）⇒ 读回失败，凭据摘要与写入摘要不同', async () => {
    const port = new MemoryStoragePort({
      now: () => 1_700_000_000_000,
      corrupt: (_uri, bytes) => {
        const copy = bytes.slice();
        copy[0] = copy[0]! ^ 0x01;
        return copy;
      },
    });
    await port.writeStream({ uri: URI_A, chunks: ['integrity'] });

    const result = port.readBack({ uri: URI_A });
    expect(result.status).toBe('failed');
    expect(result.readBack?.verified).toBe(false);
    expect(result.readBack?.digest).not.toBe(oracleDigest('integrity'));
  });

  it('期望摘要给错 ⇒ 失败；给对 ⇒ 成功（对照组）', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await port.writeStream({ uri: URI_A, chunks: ['payload'] });

    const wrong = port.readBack({ uri: URI_A, expectedDigest: oracleDigest('other') });
    expect(wrong.status).toBe('failed');
    expect(wrong.readBack?.verified).toBe(false);

    const right = port.readBack({ uri: URI_A, expectedDigest: oracleDigest('payload') });
    expect(right.status).toBe('ok');
    expect(right.readBack?.verified).toBe(true);
  });

  it('目标不存在 ⇒ not-found（不是 failed，也不伪造凭据）', () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    const result = port.readBack({ uri: URI_A });
    expect(result.status).toBe('not-found');
    expect(result.readBack).toBeNull();
  });

  it('期望摘要形状非法 ⇒ invalid_digest', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await port.writeStream({ uri: URI_A, chunks: ['payload'] });
    expectStorageError(() => port.readBack({ uri: URI_A, expectedDigest: 'sha256:zz' }), 'invalid_digest');
  });
});

// ---------------------------------------------------------------------------
// 负例 ④：崩溃语义 —— 提交前无产物、提交中途整体回滚、提交后完整可读
// ---------------------------------------------------------------------------

describe('负例 ④：崩溃注入', () => {
  it('提交前崩溃 ⇒ 无产物，旧版本原样可读', async () => {
    const port = crashingPort('commit:before-apply');
    await port.writeStream({ uri: URI_A, chunks: ['old-a'] });

    const txn = port.beginTransaction();
    await port.writeStream({ uri: URI_A, chunks: ['new-a'], transactionId: txn.transactionId });
    await port.writeStream({ uri: URI_B, chunks: ['new-b'], transactionId: txn.transactionId });

    expect(() => port.commit(txn.transactionId)).toThrow('simulated crash at commit:before-apply');

    expect(port.readBlob(URI_A).bytes).toEqual(bytesOf('old-a'));
    expect(port.readBlob(URI_A).revision).toBe(1);
    expect(port.readBlob(URI_B).status).toBe('not-found');
  });

  it('提交中途崩溃 ⇒ 已落的写入整体回滚，旧版本仍可读（关键用例）', async () => {
    const port = crashingPort('commit:applying', URI_B);
    await port.writeStream({ uri: URI_A, chunks: ['old-a'] });
    await port.writeStream({ uri: URI_B, chunks: ['old-b'] });

    const txn = port.beginTransaction();
    await port.writeStream({ uri: URI_A, chunks: ['new-a'], transactionId: txn.transactionId });
    await port.writeStream({ uri: URI_B, chunks: ['new-b'], transactionId: txn.transactionId });

    // URI_A 先落、URI_B 触发崩溃：若无整体回滚，URI_A 会停在 "new-a"（半成品）。
    expect(() => port.commit(txn.transactionId)).toThrow('simulated crash at commit:applying');

    expect(port.readBlob(URI_A).bytes).toEqual(bytesOf('old-a'));
    expect(port.readBlob(URI_A).revision).toBe(1);
    expect(port.readBlob(URI_B).bytes).toEqual(bytesOf('old-b'));
    expect(port.readBlob(URI_B).revision).toBe(1);
  });

  it('对照组：同一场景不注入中断 ⇒ 两个目标都整体生效', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await port.writeStream({ uri: URI_A, chunks: ['old-a'] });
    await port.writeStream({ uri: URI_B, chunks: ['old-b'] });

    const txn = port.beginTransaction();
    await port.writeStream({ uri: URI_A, chunks: ['new-a'], transactionId: txn.transactionId });
    await port.writeStream({ uri: URI_B, chunks: ['new-b'], transactionId: txn.transactionId });
    expect(port.commit(txn.transactionId).committed).toBe(true);

    expect(port.readBlob(URI_A).bytes).toEqual(bytesOf('new-a'));
    expect(port.readBlob(URI_B).bytes).toEqual(bytesOf('new-b'));
    expect(port.readBack({ uri: URI_A }).readBack?.verified).toBe(true);
    expect(port.readBack({ uri: URI_B }).readBack?.verified).toBe(true);
  });

  it('提交后崩溃 ⇒ 产物已完整可读（只是调用方没拿到回执）', async () => {
    const port = crashingPort('commit:after-apply');
    const txn = port.beginTransaction();
    await port.writeStream({ uri: URI_A, chunks: ['committed'], transactionId: txn.transactionId });

    expect(() => port.commit(txn.transactionId)).toThrow('simulated crash at commit:after-apply');

    const read = port.readBlob(URI_A);
    expect(read.status).toBe('ok');
    expect(read.bytes).toEqual(bytesOf('committed'));
    expect(read.revision).toBe(1);
    expect(port.readBack({ uri: URI_A }).readBack?.verified).toBe(true);

    // 崩溃前已结算：不得二次提交（避免"再提交一次"造成重复版本）。
    expectStorageError(() => port.commit(txn.transactionId), 'transaction_already_settled');
  });
});

// ---------------------------------------------------------------------------
// 负例 ⑤：事务用法错误不得静默
// ---------------------------------------------------------------------------

describe('负例 ⑤：事务与写入的用法错误一律显式抛错', () => {
  it('提交不存在的事务 ⇒ transaction_not_found', () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    expectStorageError(() => port.commit('txn-999'), 'transaction_not_found');
    expectStorageError(() => port.rollback('txn-999'), 'transaction_not_found');
  });

  it('二次提交 / 提交后再回滚 ⇒ transaction_already_settled', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    const txn = port.beginTransaction();
    await port.writeStream({ uri: URI_A, chunks: ['x'], transactionId: txn.transactionId });
    port.commit(txn.transactionId);
    expectStorageError(() => port.commit(txn.transactionId), 'transaction_already_settled');
    expectStorageError(() => port.rollback(txn.transactionId), 'transaction_already_settled');
  });

  it('往未结算事务之外写（缺 transactionId 时立即生效），且原子标记不可被伪造', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    const direct = await port.writeStream({ uri: URI_A, chunks: ['direct'] });
    expect(direct.write.atomic).toBe(false);
    expect(port.readBlob(URI_A).revision).toBe(1);
  });

  it('分片类型非法 ⇒ invalid_stream_chunk', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    await expect(
      port.writeStream({ uri: URI_A, chunks: [123 as unknown as Uint8Array] }),
    ).rejects.toMatchObject({ code: 'invalid_stream_chunk' });
  });

  it('已存在的内容 URI 不得再当相对路径构造', () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    expectStorageError(() => port.getContentUri({ relativePath: URI_A }), 'invalid_relative_path');
  });
});
