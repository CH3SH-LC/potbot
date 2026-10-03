/**
 * K03 独立验证 ③：备份排除 + 明文红线。
 *
 * 这是 K03 的两条**硬保证**：
 *  1. 备份未排除时**拒绝落盘**（宁可没有密钥，也不让密文进云备份）；
 *  2. 明文只在 `seal()` 出现一次，随后被填零；任何出口（结果 / 状态 / 清单 / 事件）
 *     都扫不到明文。
 *
 * 判据不靠"我记得别写"，而是：对出口做 `JSON.stringify(...).includes(明文)` 的直接检查，
 * 加上"唯一收到字节实参的方法是 seal"的端口侧检查。
 */

import { describe, expect, it } from 'vitest';

import { outputContainsPlaintext } from '../../../apps/mobile-kernel/security/index.js';

import {
  FIXTURE_MODEL_SECRET,
  bytesOf,
  createHarness,
  expectFailed,
} from './fixtures.js';

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

describe('K03 ③ 备份排除：未排除就拒绝落盘', () => {
  it('allowBackup=true ⇒ app_backup_enabled，且不调用 seal', () => {
    const h = createHarness({ allowBackup: true });
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));

    const result = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    expectFailed(result, 'app_backup_enabled');
    expect(h.port.calls.some((c) => c.method === 'seal')).toBe(false);
    expect(h.port.calls.some((c) => c.method === 'probe')).toBe(false);
    expect(h.manager.status('model').state).toBe('absent');
    expect(h.manifest.raw()).toBeNull();
  });

  it('目录未排除备份（excluded=false）⇒ backup_not_excluded，且不落盘', () => {
    const h = createHarness({ excluded: false });
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));

    const result = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    expectFailed(result, 'backup_not_excluded');
    expect(h.port.calls.some((c) => c.method === 'seal')).toBe(false);
    expect(h.manager.status('model').state).toBe('absent');
  });

  it('成功导入的记录 backupExcluded 恒为 true', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    const result = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    expect(result.record?.backupExcluded).toBe(true);
    expect(h.manager.status('model').backupExcluded).toBe(true);
  });
});

describe('K03 ③ 明文红线：只到 seal 一次，然后填零', () => {
  it('一次性通道的字节在导入后被填零', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    const array = h.channelArray('import-1');

    expect(allZero(array)).toBe(false);
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    expect(allZero(array)).toBe(true); // ★ finally 里 zeroize
  });

  it('失败路径同样填零（seal 失败时字节不该留在堆上）', () => {
    const h = createHarness({ sealFails: true });
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    const array = h.channelArray('import-1');

    expectFailed(h.manager.importKey({ kind: 'model', sourceRef: 'import-1' }), 'seal_failed');
    expect(allZero(array)).toBe(true);
  });

  it('端口侧：唯一收到字节实参的方法是 seal，且 seal 收到的是真明文', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    expect(h.port.byteArgsMethods()).toEqual(['seal']);
    expect(Array.from(h.port.lastSealedPlaintextCopy ?? new Uint8Array())).toEqual(Array.from(bytesOf(FIXTURE_MODEL_SECRET)));
  });

  it('出口扫描：结果 / 状态视图 / 清单 / 事件都扫不到明文', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    const result = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    const views = h.manager.exportableViews();

    expect(JSON.stringify(result).includes(FIXTURE_MODEL_SECRET)).toBe(false);
    expect(JSON.stringify(views).includes(FIXTURE_MODEL_SECRET)).toBe(false);
    expect(JSON.stringify(h.manifest.raw()).includes(FIXTURE_MODEL_SECRET)).toBe(false);
    expect(outputContainsPlaintext(result)).toBe(false);
    expect(outputContainsPlaintext(views)).toBe(false);
    expect(outputContainsPlaintext(h.manifest.raw())).toBe(false);
  });

  it('probe 与 status 都不返回明文（只给状态/长度/指纹）', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    const probe = h.port.probe('keyref:model.deepseek-flash', 1);
    expect(Object.keys(probe).sort()).toEqual(['byteLength', 'errorCode', 'state']);
    expect(JSON.stringify(probe).includes(FIXTURE_MODEL_SECRET)).toBe(false);

    const view = h.manager.status('model');
    expect(Object.keys(view).sort()).toEqual([
      'backupExcluded',
      'fingerprint',
      'keyRef',
      'kind',
      'pendingCleanupRevisions',
      'revision',
      'state',
      'verificationMode',
    ]);
    expect(JSON.stringify(view).includes(FIXTURE_MODEL_SECRET)).toBe(false);
  });

  it('事件（dispatch）里没有明文，且 succeeded 必带 resultRef（fail-closed）', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));

    const event = h.manager.dispatch({
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-1',
      operation: 'import',
      idempotencyKey: 'idem-1',
      payload: { operation: 'key.import', kind: 'model', sourceRef: 'import-1' },
    });

    expect(event.status).toBe('succeeded');
    if (event.status === 'succeeded') expect(typeof event.resultRef).toBe('string');
    expect(JSON.stringify(event).includes(FIXTURE_MODEL_SECRET)).toBe(false);
    expect(outputContainsPlaintext(event)).toBe(false);
  });
});
