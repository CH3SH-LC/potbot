/**
 * K09 独立验证 ②：存储端口正例与语义。
 *
 * 摘要断言用 `node:crypto` 独立算出的期望值，而不是拿实现自己的 `hash()` 去自证——
 * 否则"写入的摘要"和"校验的摘要"同错同对，判据退化。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MemoryStoragePort,
  isContentUri,
  type StoragePort,
} from '../../../apps/mobile-kernel/storage/index.js';

const URI_A = 'content://potbot/blobs/a.bin';
const URI_B = 'content://potbot/blobs/b.bin';
const FIXED_NOW = 1_700_000_000_000;

function oracleDigest(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'utf8')) : value;
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function newPort(): StoragePort {
  return new MemoryStoragePort({ now: () => FIXED_NOW });
}

describe('K09 正例：写入 → 摘要 → 读回凭据', () => {
  it('流式写入的分片拼接结果与摘要都对得上外部预言机', async () => {
    const port = newPort();
    const chunks = ['hello ', 'potbot', ' 中文'];
    const written = await port.writeStream({ uri: URI_A, chunks });

    const expectedBytes = new Uint8Array(Buffer.from(chunks.join(''), 'utf8'));
    expect(written.status).toBe('ok');
    expect(written.write.bytesWritten).toBe(expectedBytes.length);
    expect(written.write.digest).toBe(oracleDigest(expectedBytes));
    expect(written.write.atomic).toBe(false);
    expect(written.revision).toBe(1);

    const read = port.readBlob(URI_A);
    expect(read.status).toBe('ok');
    expect(read.bytes).toEqual(expectedBytes);
    expect(read.blob).toEqual({ uri: URI_A, digest: oracleDigest(expectedBytes), byteLength: expectedBytes.length });
    expect(read.revision).toBe(1);
  });

  it('接受异步分片（AsyncIterable）', async () => {
    const port = newPort();
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      await Promise.resolve();
      yield new Uint8Array([4, 5]);
    }
    const written = await port.writeStream({ uri: URI_A, chunks: source() });
    expect(written.write.bytesWritten).toBe(5);
    expect(port.readBlob(URI_A).bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('读回凭据在摘要一致时 verified=true 且带 URI/时间', async () => {
    const port = newPort();
    await port.writeStream({ uri: URI_A, chunks: ['payload'] });

    const result = port.readBack({ uri: URI_A });
    expect(result.status).toBe('ok');
    expect(result.readBack).toEqual({
      credential: 'cred-1',
      uri: URI_A,
      digest: oracleDigest('payload'),
      verified: true,
      readAt: new Date(FIXED_NOW).toISOString(),
    });
  });

  it('hash() 与写入摘要同源且形状合法', () => {
    const port = newPort();
    const result = port.hash(new Uint8Array(Buffer.from('abc', 'utf8')));
    expect(result.operation).toBe('hash');
    expect(result.status).toBe('ok');
    expect(result.byteLength).toBe(3);
    expect(result.digest).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('内容 URI 由相对路径构造，且落回自身校验', () => {
    const port = newPort();
    const result = port.getContentUri({ relativePath: 'artifacts/report.docx' });
    expect(result.uri).toBe('content://potbot/artifacts/report.docx');
    expect(isContentUri(result.uri)).toBe(true);
    expect(port.getContentUri({ relativePath: 'z.zip', scheme: 'blob' }).uri).toBe('blob://potbot/z.zip');
  });
});

describe('K09 正例：版本与 CAS', () => {
  it('expectedRevision=0 是"期望不存在"的创建语义', () => {
    const port = newPort();
    const created = port.compareAndSwap({ uri: URI_A, expectedRevision: 0, bytes: 'v1' });
    expect(created.status).toBe('ok');
    expect(created.cas).toEqual({ expectedRevision: 0, newRevision: 1, result: 'ok' });
    expect(created.blob?.byteLength).toBe(2);
  });

  it('版本随写入单调递增，读回摘要随内容变化', async () => {
    const port = newPort();
    await port.writeStream({ uri: URI_A, chunks: ['v1'] });
    const second = await port.writeStream({ uri: URI_A, chunks: ['v2'] });
    expect(second.revision).toBe(2);
    expect(port.readBlob(URI_A).revision).toBe(2);
    expect(port.readBlob(URI_A).blob?.digest).toBe(oracleDigest('v2'));
  });

  it('返回的字节是副本：改动它不影响存储内部状态', async () => {
    const port = newPort();
    await port.writeStream({ uri: URI_A, chunks: ['immutable'] });
    const first = port.readBlob(URI_A).bytes!;
    first[0] = 0x00;
    expect(port.readBlob(URI_A).bytes).toEqual(new Uint8Array(Buffer.from('immutable', 'utf8')));
  });
});

describe('K09 原子事务：提交前不可见 / 提交后整体生效', () => {
  it('事务内写入在提交前对外不可见，提交后一次性可见', async () => {
    const port = newPort();
    const txn = port.beginTransaction();
    expect(txn.operation).toBe('beginTransaction');
    expect(txn.status).toBe('ok');

    const staged = await port.writeStream({ uri: URI_A, chunks: ['staged'], transactionId: txn.transactionId });
    expect(staged.write.atomic).toBe(true);
    expect(staged.revision).toBeNull();
    expect(port.readBlob(URI_A).status).toBe('not-found');

    const committed = port.commit(txn.transactionId);
    expect(committed).toEqual({
      operation: 'commit',
      status: 'ok',
      transactionId: txn.transactionId,
      committed: true,
      revision: 1,
    });
    expect(port.readBlob(URI_A).bytes).toEqual(new Uint8Array(Buffer.from('staged', 'utf8')));
  });

  it('多目标事务整体提交，每个目标各得其版本', async () => {
    const port = newPort();
    await port.writeStream({ uri: URI_A, chunks: ['old'] });
    const txn = port.beginTransaction();
    await port.writeStream({ uri: URI_A, chunks: ['newA'], transactionId: txn.transactionId });
    await port.writeStream({ uri: URI_B, chunks: ['newB'], transactionId: txn.transactionId });
    port.commit(txn.transactionId);

    expect(port.readBlob(URI_A).revision).toBe(2);
    expect(port.readBlob(URI_B).revision).toBe(1);
    expect(port.readBack({ uri: URI_A }).readBack?.digest).toBe(oracleDigest('newA'));
    expect(port.readBack({ uri: URI_B }).readBack?.digest).toBe(oracleDigest('newB'));
  });

  it('rollback 丢弃全部暂存，不留痕迹', async () => {
    const port = newPort();
    const txn = port.beginTransaction();
    await port.writeStream({ uri: URI_A, chunks: ['discard'], transactionId: txn.transactionId });
    expect(port.rollback(txn.transactionId)).toEqual({
      operation: 'rollback',
      status: 'ok',
      transactionId: txn.transactionId,
      rolledBack: true,
    });
    expect(port.readBlob(URI_A).status).toBe('not-found');
  });
});
