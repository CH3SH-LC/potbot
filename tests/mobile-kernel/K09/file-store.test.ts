/**
 * K09 独立验证 ④：**可落盘后端 `FileStoragePort`** —— 跑在**真实临时目录**上的字节。
 *
 * 与前三个测试的区别：这里不是内存 `Map` 模拟崩溃，而是在真磁盘上做
 * "写临时文件 + 原子 rename"，然后**构造新实例**触发恢复，看旧产物到底在不在。
 *
 * 独立判据（不拿实现自证）：
 *   - 摘要一律与 `node:crypto` 的外部预言机对拍；
 *   - "新实例能否读到"由**真实文件**决定，不是同一实例的内存缓存；
 *   - 崩溃恢复后的断言看的是**重开实例**读出的字节与版本。
 *
 * 说明：`node:fs` 适配器**只定义在本测试里**（产品树不得依赖 node 内建）。
 * 安卓原生实现走 `com/potbot/kernel/storage/`，属后续集成。
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileStoragePort,
  isDesktopAbsolutePath,
  isStorageError,
  type FileSystemPort,
  type StoragePort,
} from '../../../apps/mobile-kernel/storage/index.js';

// ---------------------------------------------------------------------------
// 测试内的 `node:fs` 适配器：把平台动作接到真磁盘
// ---------------------------------------------------------------------------

class NodeFileSystem implements FileSystemPort {
  ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
  }
  exists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
  readFile(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path));
  }
  writeFile(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  rename(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  removeFile(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  listFiles(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
  listDirs(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const URI_A = 'content://potbot/blobs/a.bin';
const URI_B = 'content://potbot/blobs/b.bin';
const FIXED_NOW = 1_700_000_000_000;

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'k09-filestore-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function oracle(text: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}

interface PortExtras {
  readonly interrupt?: (event: { point: string; transactionId: string; detail: string | null }) => void;
  readonly corrupt?: (uri: string, b: Uint8Array) => Uint8Array;
}

function newPort(root: string, extras: PortExtras = {}): FileStoragePort {
  return new FileStoragePort({
    root,
    fs: new NodeFileSystem(),
    now: () => FIXED_NOW,
    interrupt: extras.interrupt as never,
    corrupt: extras.corrupt,
  });
}

/** 直接按文档布局拼数据文件路径（白盒；布局在 README 与源码头注释里写死）。 */
function dataPathOf(root: string, rel: string): string {
  return join(root, 'data', ...rel.split('/'));
}

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

/** 收集结果里所有字符串字段（跳过字节），用于"绝不返回电脑绝对路径"的机器化扫描。 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value instanceof Uint8Array) void 0;
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

// ---------------------------------------------------------------------------
// 正例：落盘往返 / 持久化 / CAS / 事务
// ---------------------------------------------------------------------------

describe('K09 文件后端 正例：真磁盘往返与持久化', () => {
  it('流式写入经原子 rename 落盘，摘要与外部预言机一致', async () => {
    const root = newRoot();
    const port = newPort(root);
    const written = await port.writeStream({ uri: URI_A, chunks: ['hello ', 'potbot', ' 中文'] });

    expect(written.status).toBe('ok');
    expect(written.write.atomic).toBe(false);
    expect(written.write.bytesWritten).toBe(bytes('hello potbot 中文').length);
    expect(written.write.digest).toBe(oracle('hello potbot 中文'));
    expect(written.revision).toBe(1);

    // 真磁盘上确实存在字节文件，且内容与写入一致。
    const onDisk = new Uint8Array(readFileSync(dataPathOf(root, 'blobs/a.bin')));
    expect(onDisk).toEqual(bytes('hello potbot 中文'));

    const read = port.readBlob(URI_A);
    expect(read.status).toBe('ok');
    expect(read.bytes).toEqual(bytes('hello potbot 中文'));
    expect(read.blob).toEqual({ uri: URI_A, digest: oracle('hello potbot 中文'), byteLength: 19 });
    expect(read.revision).toBe(1);
  });

  it('**进程重开**后仍读得到（新实例不看内存缓存）', async () => {
    const root = newRoot();
    const first = newPort(root);
    await first.writeStream({ uri: URI_A, chunks: ['persisted'] });

    const reopened = newPort(root); // 全新实例，只能靠磁盘
    const read = reopened.readBlob(URI_A);
    expect(read.status).toBe('ok');
    expect(read.bytes).toEqual(bytes('persisted'));
    expect(read.revision).toBe(1);
    expect(reopened.readBack({ uri: URI_A }).readBack?.verified).toBe(true);
    expect(reopened.recoveryReport()).toEqual({ journalsSeen: 0, rolledBack: 0, finalized: 0, orphansRemoved: 0 });
  });

  it('版本跨重开单调递增，CAS 冲突只读不写', async () => {
    const root = newRoot();
    const a = newPort(root);
    await a.writeStream({ uri: URI_A, chunks: ['v1'] });
    await a.writeStream({ uri: URI_A, chunks: ['v2'] });

    const b = newPort(root);
    expect(b.readBlob(URI_A).revision).toBe(2);

    // 拿过期版本 1 去 CAS ⇒ conflict，磁盘值停在 v2。
    const conflicted = b.compareAndSwap({ uri: URI_A, expectedRevision: 1, bytes: 'stale' });
    expect(conflicted.status).toBe('conflict');
    expect(conflicted.cas).toEqual({ expectedRevision: 1, newRevision: 2, result: 'conflict' });
    expect(conflicted.blob?.digest).toBe(oracle('v2'));
    expect(newPort(root).readBlob(URI_A).bytes).toEqual(bytes('v2'));

    // 正确版本 ⇒ ok，且新版本跨重开可见。
    const ok = b.compareAndSwap({ uri: URI_A, expectedRevision: 2, bytes: 'v3' });
    expect(ok.status).toBe('ok');
    expect(ok.cas.newRevision).toBe(3);
    expect(newPort(root).readBlob(URI_A).bytes).toEqual(bytes('v3'));
  });

  it('expectedRevision=0 是"期望不存在"的创建语义，跨重开成立', () => {
    const root = newRoot();
    const created = newPort(root).compareAndSwap({ uri: URI_A, expectedRevision: 0, bytes: 'created' });
    expect(created.status).toBe('ok');
    expect(created.cas.newRevision).toBe(1);
    expect(newPort(root).readBlob(URI_A).bytes).toEqual(bytes('created'));
  });
});

describe('K09 文件后端 事务：提交前不可见 / 提交后整体生效', () => {
  it('暂存写入在提交前对本实例与其它实例都不可见', async () => {
    const root = newRoot();
    const a = newPort(root);
    const txn = a.beginTransaction();
    const staged = await a.writeStream({ uri: URI_A, chunks: ['staged'], transactionId: txn.transactionId });
    expect(staged.write.atomic).toBe(true);
    expect(staged.revision).toBeNull();
    expect(a.readBlob(URI_A).status).toBe('not-found');

    // 另一个实例也看不到（因为还没落盘）。
    const b = newPort(root);
    expect(b.readBlob(URI_A).status).toBe('not-found');

    const committed = a.commit(txn.transactionId);
    expect(committed).toEqual({
      operation: 'commit',
      status: 'ok',
      transactionId: txn.transactionId,
      committed: true,
      revision: 1,
    });
    // 提交后新实例可见。
    expect(newPort(root).readBlob(URI_A).bytes).toEqual(bytes('staged'));
  });

  it('多目标事务整体提交，各得其版本', async () => {
    const root = newRoot();
    const a = newPort(root);
    await a.writeStream({ uri: URI_A, chunks: ['oldA'] });
    const txn = a.beginTransaction();
    await a.writeStream({ uri: URI_A, chunks: ['newA'], transactionId: txn.transactionId });
    await a.writeStream({ uri: URI_B, chunks: ['newB'], transactionId: txn.transactionId });
    expect(a.commit(txn.transactionId).committed).toBe(true);

    const b = newPort(root);
    expect(b.readBlob(URI_A).revision).toBe(2);
    expect(b.readBlob(URI_B).revision).toBe(1);
    expect(b.readBlob(URI_A).bytes).toEqual(bytes('newA'));
    expect(b.readBlob(URI_B).bytes).toEqual(bytes('newB'));
  });

  it('rollback 丢弃暂存，磁盘不留任何目标', async () => {
    const root = newRoot();
    const a = newPort(root);
    const txn = a.beginTransaction();
    await a.writeStream({ uri: URI_A, chunks: ['discard'], transactionId: txn.transactionId });
    expect(a.rollback(txn.transactionId)).toEqual({
      operation: 'rollback',
      status: 'ok',
      transactionId: txn.transactionId,
      rolledBack: true,
    });
    expect(newPort(root).readBlob(URI_A).status).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// 负例：真磁盘崩溃恢复（构造新实例触发）
// ---------------------------------------------------------------------------

describe('K09 文件后端 负例：崩溃后旧产物可读', () => {
  it('提交前崩溃 ⇒ 磁盘无产物，旧版本原样可读', async () => {
    const root = newRoot();
    const crashing = newPort(root, {
      interrupt: (event) => {
        if (event.point === 'commit:before-apply') throw new Error('crash@before-apply');
      },
    });
    await crashing.writeStream({ uri: URI_A, chunks: ['old-A'] });

    const txn = crashing.beginTransaction();
    await crashing.writeStream({ uri: URI_A, chunks: ['new-A'], transactionId: txn.transactionId });
    await crashing.writeStream({ uri: URI_B, chunks: ['new-B'], transactionId: txn.transactionId });
    expect(() => crashing.commit(txn.transactionId)).toThrow('crash@before-apply');

    const reopened = newPort(root);
    // 崩在写 tmp 之前：日志都还没落，恢复无事可做。
    expect(reopened.recoveryReport().journalsSeen).toBe(0);
    expect(reopened.readBlob(URI_A).bytes).toEqual(bytes('old-A'));
    expect(reopened.readBlob(URI_A).revision).toBe(1);
    expect(reopened.readBlob(URI_B).status).toBe('not-found');
  });

  it('提交中途崩溃（关键）⇒ 已落的写入整体回滚，旧版本仍可读', async () => {
    const root = newRoot();
    const crashing = newPort(root, {
      interrupt: (event) => {
        if (event.point === 'commit:applying' && event.detail === URI_B) throw new Error('crash@applying-B');
      },
    });
    await crashing.writeStream({ uri: URI_A, chunks: ['old-A'] });
    await crashing.writeStream({ uri: URI_B, chunks: ['old-B'] });

    const txn = crashing.beginTransaction();
    await crashing.writeStream({ uri: URI_A, chunks: ['new-A'], transactionId: txn.transactionId });
    await crashing.writeStream({ uri: URI_B, chunks: ['new-B'], transactionId: txn.transactionId });

    // URI_A 先落、URI_B 触发硬死：若无整体回滚，URI_A 会停在 "new-A"（半成品）。
    expect(() => crashing.commit(txn.transactionId)).toThrow('crash@applying-B');
    // 磁盘上此刻确实是半成品（证明测试确实制造了中间态）。
    expect(new Uint8Array(readFileSync(dataPathOf(root, 'blobs/a.bin')))).toEqual(bytes('new-A'));

    const reopened = newPort(root);
    expect(reopened.recoveryReport()).toMatchObject({ journalsSeen: 1, rolledBack: 1, finalized: 0 });
    expect(reopened.readBlob(URI_A).bytes).toEqual(bytes('old-A'));
    expect(reopened.readBlob(URI_A).revision).toBe(1);
    expect(reopened.readBlob(URI_B).bytes).toEqual(bytes('old-B'));
    expect(reopened.readBlob(URI_B).revision).toBe(1);
  });

  it('提交后崩溃 ⇒ 产物已完整可读（终结核），且不得二次提交', async () => {
    const root = newRoot();
    const crashing = newPort(root, {
      interrupt: (event) => {
        if (event.point === 'commit:after-apply') throw new Error('crash@after-apply');
      },
    });
    const txn = crashing.beginTransaction();
    await crashing.writeStream({ uri: URI_A, chunks: ['committed'], transactionId: txn.transactionId });
    expect(() => crashing.commit(txn.transactionId)).toThrow('crash@after-apply');

    // 同一实例不得二次提交（避免重复版本）。
    expectStorageError(() => crashing.commit(txn.transactionId), 'transaction_already_settled');

    const reopened = newPort(root);
    expect(reopened.recoveryReport()).toMatchObject({ journalsSeen: 1, rolledBack: 0, finalized: 1 });
    expect(reopened.readBlob(URI_A).bytes).toEqual(bytes('committed'));
    expect(reopened.readBlob(URI_A).revision).toBe(1);
    expect(reopened.readBack({ uri: URI_A }).readBack?.verified).toBe(true);
  });

  it('对照组：不注入中断时同场景两个目标都整体生效', async () => {
    const root = newRoot();
    const a = newPort(root);
    await a.writeStream({ uri: URI_A, chunks: ['old-A'] });
    await a.writeStream({ uri: URI_B, chunks: ['old-B'] });
    const txn = a.beginTransaction();
    await a.writeStream({ uri: URI_A, chunks: ['new-A'], transactionId: txn.transactionId });
    await a.writeStream({ uri: URI_B, chunks: ['new-B'], transactionId: txn.transactionId });
    expect(a.commit(txn.transactionId).committed).toBe(true);

    const b = newPort(root);
    expect(b.readBlob(URI_A).bytes).toEqual(bytes('new-A'));
    expect(b.readBlob(URI_B).bytes).toEqual(bytes('new-B'));
    // 干净提交后不留日志/备份/tmp。
    expect(b.recoveryReport()).toEqual({ journalsSeen: 0, rolledBack: 0, finalized: 0, orphansRemoved: 0 });
  });
});

// ---------------------------------------------------------------------------
// 负例：读回凭据从介质校验
// ---------------------------------------------------------------------------

describe('K09 文件后端 负例：读回以介质为准', () => {
  it('介质被直接篡改 ⇒ 读回 failed 且 verified=false（证明真的重读磁盘）', async () => {
    const root = newRoot();
    const port = newPort(root);
    await port.writeStream({ uri: URI_A, chunks: ['integrity'] });
    expect(port.readBack({ uri: URI_A }).status).toBe('ok');

    // 越过端口直接改磁盘字节（模拟介质损坏 / 外部进程改写）。
    writeFileSync(dataPathOf(root, 'blobs/a.bin'), Buffer.from('tampered!', 'utf8'));

    const after = port.readBack({ uri: URI_A });
    expect(after.status).toBe('failed');
    expect(after.readBack?.verified).toBe(false);
    expect(after.readBack?.digest).toBe(oracle('tampered!'));
    expect(after.readBack?.digest).not.toBe(oracle('integrity'));
  });

  it('期望摘要不符 ⇒ failed；给对 ⇒ ok（对照组）', async () => {
    const root = newRoot();
    const port = newPort(root);
    await port.writeStream({ uri: URI_A, chunks: ['payload'] });

    expect(port.readBack({ uri: URI_A, expectedDigest: oracle('other') }).status).toBe('failed');
    expect(port.readBack({ uri: URI_A, expectedDigest: oracle('payload') }).status).toBe('ok');
    expectStorageError(() => port.readBack({ uri: URI_A, expectedDigest: 'sha256:zz' }), 'invalid_digest');
  });

  it('目标不存在 ⇒ not-found（不伪造凭据）', () => {
    const root = newRoot();
    const port = newPort(root);
    expect(port.readBack({ uri: URI_A })).toEqual({ operation: 'readBack', status: 'not-found', readBack: null });
  });
});

// ---------------------------------------------------------------------------
// 负例：电脑绝对路径红线（全入口 + 结果扫描）
// ---------------------------------------------------------------------------

describe('K09 文件后端 负例：绝不出现电脑绝对路径', () => {
  const desktopPaths = [
    'C:\\Users\\<user>\\Desktop\\报告.docx',
    'C:/Users/<user>/Desktop/report.docx',
    'd:\\work\\a.bin',
    '/etc/passwd',
    '/sdcard/Download/x.docx',
  ];

  it('readBlob / writeStream / compareAndSwap / readBack 全入口拒绝盘符路径', async () => {
    const root = newRoot();
    const port = newPort(root);
    for (const path of desktopPaths) {
      expectStorageError(() => port.readBlob(path), 'desktop_path_rejected');
      await expect(port.writeStream({ uri: path, chunks: ['x'] })).rejects.toMatchObject({
        code: 'desktop_path_rejected',
      });
      expectStorageError(() => port.compareAndSwap({ uri: path, expectedRevision: 0, bytes: 'x' }), 'desktop_path_rejected');
      expectStorageError(() => port.readBack({ uri: path }), 'desktop_path_rejected');
    }
  });

  it('所有返回结果的字符串字段都不含电脑绝对路径，也不含平台 root', async () => {
    const root = newRoot();
    const port = newPort(root);
    await port.writeStream({ uri: URI_A, chunks: ['x'] });

    const results: unknown[] = [
      port.beginTransaction(),
      port.readBlob(URI_A),
      await port.writeStream({ uri: URI_A, chunks: ['y'] }),
      port.compareAndSwap({ uri: URI_A, expectedRevision: 1, bytes: 'z' }),
      port.compareAndSwap({ uri: URI_A, expectedRevision: 99, bytes: 'z' }),
      port.getContentUri({ relativePath: 'artifacts/report.docx' }),
      port.readBack({ uri: URI_A }),
      port.hash('abc'),
    ];
    for (const result of results) {
      for (const text of collectStrings(result)) {
        expect(isDesktopAbsolutePath(text), text).toBe(false);
        expect(text.includes(root), text).toBe(false);
      }
    }
  });

  it('getContentUri 构造与逆解析往返一致；非 potbot authority 被拒', async () => {
    const root = newRoot();
    const port = newPort(root);
    const uri = port.getContentUri({ relativePath: 'artifacts/report.docx' }).uri;
    expect(uri).toBe('content://potbot/artifacts/report.docx');

    // 写到该 URI 再按同一 URI 读回。
    await port.writeStream({ uri, chunks: ['doc'] });
    expect(port.readBlob(uri).bytes).toEqual(bytes('doc'));

    // authority 不是 potbot 的内容 URI 无法映射到沙箱 ⇒ 明确拒绝，绝不猜路径。
    expectStorageError(() => port.readBlob('content://other/x.bin'), 'invalid_content_uri');
    expectStorageError(() => port.readBlob('content://potbot/a/../escape'), 'invalid_relative_path');
  });
});
