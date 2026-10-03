/**
 * X-I28（池位 28）集成切片：**内存参考实现的端口语义**。
 *
 * 验证安卓宿主必须实现的形状在内存后端上是**行为确定**的：
 * 三值读取可区分（ok / not_found / failed）、写入回执是逻辑版本、日志与快照两类记录按
 * (会话, 种类, 版本) 存取、逻辑 key 红线（电脑绝对路径拒）在入口就挡。
 *
 * 反向对照：注入读失败必须是 `failed` 而**不是** `not_found`；注入字节损坏后 `ok` 的字节
 * **不等于**写入的字节（这样上层严格解码才有意义）。
 */

import { describe, expect, it } from 'vitest';

import {
  assertLogicalKey,
  artifactBlobKey,
  createInMemoryHostStorage,
  isDesktopAbsolutePath,
  recordKey,
  SpreadsheetBridgeError,
  type DurableRecordRef,
} from '../../../../src/mobile-plugins/spreadsheets/bridge/index.js';

const bytesOf = (text: string): Uint8Array => Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));

describe('X-I28 · 逻辑 key 红线', () => {
  it('空 / 纯空白 / 电脑绝对路径被拒，合法相对 key 通过', () => {
    expect(() => assertLogicalKey('')).toThrow(SpreadsheetBridgeError);
    expect(() => assertLogicalKey('   ')).toThrow(SpreadsheetBridgeError);
    expect(() => assertLogicalKey('C:/Users/x/a.xlsx')).toThrow(/绝对路径/);
    expect(() => assertLogicalKey('/home/x/a.xlsx')).toThrow(/绝对路径/);
    expect(assertLogicalKey('report/a.xlsx')).toBe('report/a.xlsx');
  });

  it('isDesktopAbsolutePath 与 artifactBlobKey 形状', () => {
    expect(isDesktopAbsolutePath('C:\\x')).toBe(true);
    expect(isDesktopAbsolutePath('D:/x')).toBe(true);
    expect(isDesktopAbsolutePath('/x')).toBe(true);
    expect(isDesktopAbsolutePath('rel/x')).toBe(false);
    expect(artifactBlobKey('report/a.xlsx')).toBe('potbot/spreadsheets/blobs/report/a.xlsx');
  });

  it('recordKey 版本左补零 ⇒ 字典序等于数值序', () => {
    const keyOf = (revision: number): string =>
      recordKey({ session_id: 's', kind: 'snapshot', revision });
    expect(keyOf(9) < keyOf(10)).toBe(true);
    expect(keyOf(100) < keyOf(99)).toBe(false);
    expect(keyOf(0)).toBe('potbot/spreadsheets/sessions/s/snapshot/000000000000');
  });
});

describe('X-I28 · 字节 blob 面', () => {
  it('写 → 读回等值字节；未写过的 key 是 not_found（不是 failed）', async () => {
    const port = createInMemoryHostStorage();
    const receipt = await port.writeBlob('report/a.bin', Uint8Array.from([1, 2, 3]));
    expect(receipt.byteLength).toBe(3);
    expect(receipt.revision).toBe(1);
    // 第二次写入同 key ⇒ 逻辑版本递增。
    expect((await port.writeBlob('report/a.bin', Uint8Array.from([9]))).revision).toBe(2);

    const read = await port.readBlob('report/a.bin');
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect([...read.bytes]).toEqual([9]);

    const missing = await port.readBlob('report/absent.bin');
    expect(missing.kind).toBe('not_found');
  });

  it('返回的是副本：改动读回的字节不影响存储', async () => {
    const port = createInMemoryHostStorage();
    await port.writeBlob('k', Uint8Array.from([1, 2, 3]));
    const first = await port.readBlob('k');
    if (first.kind !== 'ok') throw new Error('夹具应命中');
    first.bytes[0] = 99;
    const second = await port.readBlob('k');
    if (second.kind !== 'ok') throw new Error('夹具应命中');
    expect(second.bytes[0]).toBe(1);
  });

  it('注入读失败 ⇒ failed（有 detail），绝不折成 not_found', async () => {
    const port = createInMemoryHostStorage({ failRead: { detail: '介质不可达' } });
    const read = await port.readBlob('anything');
    expect(read.kind).toBe('failed');
    if (read.kind === 'failed') expect(read.detail).toBe('介质不可达');
  });

  it('注入写失败 ⇒ 抛 write_failed；删除后读回 not_found', async () => {
    const port = createInMemoryHostStorage();
    await port.writeBlob('k', Uint8Array.from([1]));
    await port.removeBlob('k');
    expect((await port.readBlob('k')).kind).toBe('not_found');

    port.setFaults({ failWrite: true });
    await expect(port.writeBlob('k', Uint8Array.from([2]))).rejects.toMatchObject({ code: 'write_failed' });
  });

  it('注入字节损坏：读取成功但内容与写入不同（成功 ≠ 完好）', async () => {
    const port = createInMemoryHostStorage({ corrupt: (_key, bytes) => bytes.slice().fill(0) });
    await port.writeBlob('k', Uint8Array.from([1, 2, 3]));
    const read = await port.readBlob('k');
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect([...read.bytes]).toEqual([0, 0, 0]);
  });
});

describe('X-I28 · 日志 / 快照记录面', () => {
  it('按版本存取：写入 rev 3 / 5 ⇒ 列表升序 [3,5]，缺版本 not_found', async () => {
    const port = createInMemoryHostStorage();
    const ref = (revision: number): DurableRecordRef => ({ session_id: 's1', kind: 'snapshot', revision });
    await port.writeRecord(ref(5), bytesOf('five'));
    await port.writeRecord(ref(3), bytesOf('three'));

    expect(await port.listRecordRevisions({ session_id: 's1', kind: 'snapshot' })).toEqual([3, 5]);
    expect((await port.readRecord(ref(4))).kind).toBe('not_found');
    const three = await port.readRecord(ref(3));
    expect(three.kind).toBe('ok');
    if (three.kind === 'ok') expect(String.fromCharCode(...three.bytes)).toBe('three');
  });

  it('日志与快照是独立的两类：同版本互不覆盖', async () => {
    const port = createInMemoryHostStorage();
    await port.writeRecord({ session_id: 's1', kind: 'snapshot', revision: 2 }, bytesOf('snap'));
    await port.writeRecord({ session_id: 's1', kind: 'journal', revision: 2 }, bytesOf('jour'));

    expect(await port.listRecordRevisions({ session_id: 's1', kind: 'snapshot' })).toEqual([2]);
    expect(await port.listRecordRevisions({ session_id: 's1', kind: 'journal' })).toEqual([2]);
    expect(port.sessionIds()).toEqual(['s1']);
  });

  it('非法记录引用（版本非整数 / 种类错）即抛 invalid_record_ref', async () => {
    const port = createInMemoryHostStorage();
    await expect(
      port.writeRecord({ session_id: 's1', kind: 'snapshot', revision: -1 }, bytesOf('x')),
    ).rejects.toMatchObject({ code: 'invalid_record_ref' });
    await expect(
      port.writeRecord({ session_id: '', kind: 'snapshot', revision: 1 }, bytesOf('x')),
    ).rejects.toMatchObject({ code: 'invalid_record_ref' });
  });
});
