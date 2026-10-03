/**
 * K-I07 ①：**内存后端 `MemoryBlobPort`** 的契约与三态读取。
 *
 * 核心判据（K10 集成请求）：读失败必须是**显式错误**，绝不返回 `null` / 空串被当成空账本。
 */

import { describe, expect, it } from 'vitest';

import {
  BLOB_PORT_ERROR_CODES,
  BlobPortError,
  LEDGER_SNAPSHOT_KEY,
  MemoryBlobPort,
  assertBlobKey,
  isBlobPortError,
  utf8Decode,
} from '../../../apps/mobile-kernel/storage/index.js';

describe('MemoryBlobPort：读写删往返', () => {
  it('write -> read 原样返回；exists 为 true；remove 后回到未写状态', () => {
    const port = new MemoryBlobPort();
    expect(port.read('ledger/a.json')).toBeNull();
    expect(port.exists('ledger/a.json')).toBe(false);

    port.write('ledger/a.json', '{"v":1}');
    expect(port.read('ledger/a.json')).toBe('{"v":1}');
    expect(port.exists('ledger/a.json')).toBe(true);

    port.remove('ledger/a.json');
    expect(port.read('ledger/a.json')).toBeNull();
    expect(port.exists('ledger/a.json')).toBe(false);
    // remove 幂等：再删一次不抛。
    expect(() => port.remove('ledger/a.json')).not.toThrow();
    expect(port.calls).toMatchObject({ read: 3, write: 1, remove: 2 });
  });

  it('can be seeded and keeps the约定 ledger key working', () => {
    const port = new MemoryBlobPort({ key: LEDGER_SNAPSHOT_KEY, value: 'SNAP' });
    expect(port.read(LEDGER_SNAPSHOT_KEY)).toBe('SNAP');
    expect(port.peek(LEDGER_SNAPSHOT_KEY)).toBe('SNAP');
  });

  it('非字符串 value 抛 invalid_blob_value，且不产生任何写入', () => {
    const port = new MemoryBlobPort();
    expect(() => port.write('k', 42 as unknown as string)).toThrow(BlobPortError);
    try {
      port.write('k', null as unknown as string);
    } catch (error) {
      expect(isBlobPortError(error)).toBe(true);
      expect((error as BlobPortError).code).toBe('invalid_blob_value');
    }
    expect(port.exists('k')).toBe(false);
    expect(port.calls.write).toBe(0);
  });
});

describe('MemoryBlobPort：读失败 ≠ 空库', () => {
  it('注入读失败时抛 blob_read_failed，而不是返回 null / 空串', () => {
    const port = new MemoryBlobPort({ key: 'ledger/x', value: 'OLD' });
    port.setFaults({ failRead: true });
    let thrown: unknown;
    try {
      port.read('ledger/x');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BlobPortError);
    expect((thrown as BlobPortError).code).toBe('blob_read_failed');
    // 关键反向对照：绝不能是 null（那是"没有快照"的语义）。
    expect(thrown).not.toBeNull();
    expect(isBlobPortError(thrown)).toBe(true);
  });

  it('注入写失败时抛 blob_write_failed，且旧值原样保留', () => {
    const port = new MemoryBlobPort();
    port.write('k', 'OLD');
    port.setFaults({ failWrite: { detail: '介质满' } });
    expect(() => port.write('k', 'NEW')).toThrowError(/介质满/);
    port.setFaults({});
    expect(port.read('k')).toBe('OLD');
  });

  it('corruptValue：存在但内容不可用——端口如实返回坏内容，由上层判定，不伪装成读失败', () => {
    const port = new MemoryBlobPort();
    port.write('k', 'GOOD');
    port.setFaults({ corruptValue: '{truncated' });
    expect(port.read('k')).toBe('{truncated');
    // 未写过的 key 仍然按"不存在"处理，不被 corruptValue 影响。
    expect(port.read('never')).toBeNull();
  });
});

describe('assertBlobKey：形状红线', () => {
  it('接受嵌套相对 key 并归一（去掉空段与 .）', () => {
    expect(assertBlobKey('ledger/task-ledger.v1.json')).toBe('ledger/task-ledger.v1.json');
    expect(assertBlobKey('a//b/./c')).toBe('a/b/c');
  });

  it('拒绝电脑绝对路径（盘符 / POSIX 根）', () => {
    for (const key of ['C:/Users/<user>/x.json', 'C:\\x', '/var/tmp/x', 'd:/y']) {
      expect(() => assertBlobKey(key)).toThrowError(/invalid_blob_key/);
    }
  });

  it('拒绝空、..、反斜杠、非法字符与非字符串', () => {
    for (const key of ['', '..', 'a/../b', 'a\\b', 'a b', 'a/b:c', 42, null]) {
      expect(() => assertBlobKey(key as unknown as string)).toThrowError(/invalid_blob_key/);
    }
  });

  it('非法 key 在触碰任何后端之前就被拒（写/读/删都要走同一校验）', () => {
    const port = new MemoryBlobPort();
    expect(() => port.write('C:/x', 'v')).toThrowError(/invalid_blob_key/);
    expect(() => port.read('../etc')).toThrowError(/invalid_blob_key/);
    expect(() => port.remove('/abs')).toThrowError(/invalid_blob_key/);
    expect(port.calls.write).toBe(0);
    expect(port.calls.read).toBe(0);
  });
});

describe('BlobPortError：可机读拒因', () => {
  it('错误码词表包含读失败，且实例带 code 与 subject', () => {
    expect(BLOB_PORT_ERROR_CODES).toContain('blob_read_failed');
    const error = new BlobPortError('blob_read_failed', '读取失败', 'ledger/x');
    expect(error.name).toBe('BlobPortError');
    expect(error.code).toBe('blob_read_failed');
    expect(error.subject).toBe('ledger/x');
    expect(error.message).toContain('[blob_read_failed]');
  });

  it('isBlobPortError：instanceof 与鸭子类型都能认出，未知 code / null 为 false', () => {
    expect(isBlobPortError(new BlobPortError('blob_write_failed', 'x'))).toBe(true);
    expect(isBlobPortError({ code: 'blob_read_failed' })).toBe(true);
    expect(isBlobPortError({ code: 'not_a_real_code' })).toBe(false);
    expect(isBlobPortError(null)).toBe(false);
    expect(isBlobPortError(new Error('x'))).toBe(false);
  });
});

describe('utf8Decode：严格解码（损坏必须抛，不静默变 U+FFFD）', () => {
  it('对合法 UTF-8 往返正确（含 BMP 外码点）', () => {
    const text = '快照 🚀 snapshot';
    const bytes = Uint8Array.from(Buffer.from(text, 'utf8'));
    expect(utf8Decode(bytes)).toBe(text);
  });

  it('拒绝截断 / 过长编码 / 代理区 / 越界首字节', () => {
    expect(() => utf8Decode(Uint8Array.from([0xe4, 0xb8]))).toThrow(/截断/);
    expect(() => utf8Decode(Uint8Array.from([0xc0, 0x80]))).toThrow(/非法 UTF-8 首字节/);
    expect(() => utf8Decode(Uint8Array.from([0xed, 0xa0, 0x80]))).toThrow(/代理区/);
    expect(() => utf8Decode(Uint8Array.from([0xff]))).toThrow(/非法 UTF-8 首字节/);
    expect(() => utf8Decode(Uint8Array.from([0x80]))).toThrow(/非法 UTF-8 首字节/);
  });
});
