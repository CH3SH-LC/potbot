/**
 * K03 独立验证 ④：重启 / 重装 / 设备迁移对账 + 公共命令幂等与冲突。
 *
 * 三种"上一次运行的状态"必须分清：
 *  - **进程重启**（数据都在）：recover 后仍 active，能解密使用；
 *  - **重装**（App 私有目录 + Keystore 一起没）：清单也没了 ⇒ 全部 absent，需重新导入；
 *  - **设备迁移 / Keystore 丢失**（密文与清单被恢复、设备绑定密钥没有）：
 *    recover 必须把有料记录转 **blocked**，**不**静默当 absent 重新可用。
 */

import { describe, expect, it } from 'vitest';

import {
  SecurityError,
  assertKeyRef,
  isSecurityError,
} from '../../../apps/mobile-kernel/security/index.js';

import {
  FIXTURE_MODEL_SECRET,
  FIXTURE_MODEL_SECRET_V2,
  bytesOf,
  createHarness,
  expectFailed,
  expectSecurityError,
} from './fixtures.js';

describe('K03 ④ 进程重启：清单与 Keystore 都在 ⇒ 仍可解密使用', () => {
  it('重启后 status 仍 active、修订不变、探针可读', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    const imported = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    const fingerprint = imported.record!.fingerprint;

    // 进程重启：新 manager，复用同一端口与清单。
    const restarted = h.restart();
    const view = restarted.status('model');

    expect(view.state).toBe('active');
    expect(view.revision).toBe(1);
    expect(view.fingerprint).toBe(fingerprint);
    // 包装密钥未丢，密文可解密（探针 readable）——这就是"重启仍能使用"。
    expect(h.port.isProvisioned()).toBe(true);
    expect(h.port.probe(view.keyRef, 1).state).toBe('readable');

    // 重启后 recover 不改动 active 记录。
    const report = restarted.recover();
    expect(report.status).toBe('succeeded');
    const model = report.entries.find((e) => e.kind === 'model')!;
    expect(model.before).toBe('active');
    expect(model.after).toBe('active');
    expect(model.changed).toBe(false);
    expect(restarted.status('model').revision).toBe(1);
  });
});

describe('K03 ④ 重装：App 私有目录 + Keystore 一起没', () => {
  it('重装后清单为空 ⇒ 全部 absent，同一默认 keyRef 可重新导入', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    // 卸载重装：私有目录被清（清单存 null）+ Keystore 条目消失。
    h.manifest.wipe();
    h.port.simulateReinstall();

    const restarted = h.restart();
    expect(restarted.status('model').state).toBe('absent');
    expect(restarted.status('model').revision).toBe(0);
    expect(h.port.hasCiphertext('keyref:model.deepseek-flash', 1)).toBe(false);

    // 重新导入（新通道）⇒ 回到 active，keyRef 不变。
    h.registerChannel('import-2', bytesOf(FIXTURE_MODEL_SECRET_V2));
    const reimported = restarted.importKey({ kind: 'model', sourceRef: 'import-2' });
    expect(reimported.status).toBe('succeeded');
    expect(reimported.keyRef).toBe('keyref:model.deepseek-flash');
    expect(reimported.record?.state).toBe('active');
  });
});

describe('K03 ④ 设备迁移 / Keystore 丢失：密文在、钥匙没了 ⇒ blocked', () => {
  it('recover 把有料记录转 blocked，指纹清空', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    h.port.loseKeystoreKey(); // 密文还在，设备绑定密钥没有
    const restarted = h.restart();

    // 重启后不主动 recover 时，内存清单仍写 active（因为还没对账）——
    const report = restarted.recover();
    const model = report.entries.find((e) => e.kind === 'model')!;
    expect(model.before).toBe('active');
    expect(model.after).toBe('blocked');
    expect(model.reason).toBe('keystore-missing');

    const view = restarted.status('model');
    expect(view.state).toBe('blocked');
    expect(view.fingerprint).toBeNull(); // 读不出，就不再声称指纹对得上
    expect(restarted.status('meituan').state).toBe('absent');
    expect(restarted.status('meituan').revision).toBe(0);
  });

  it('blocked 上不能 rotate（key_not_readable），但可以重新导入', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.registerChannel('rot-1', bytesOf(FIXTURE_MODEL_SECRET_V2));
    h.registerChannel('import-2', bytesOf(FIXTURE_MODEL_SECRET_V2));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    h.port.loseKeystoreKey();
    const restarted = h.restart();
    restarted.recover();
    expect(restarted.status('model').state).toBe('blocked');

    expectFailed(restarted.rotateKey({ kind: 'model', sourceRef: 'rot-1', expectedRevision: 2 }), 'key_not_readable');

    // 重新导入（原生侧会先 provision 新包装密钥）⇒ 回到 active。
    const reimported = restarted.importKey({ kind: 'model', sourceRef: 'import-2' });
    expect(reimported.status).toBe('succeeded');
    expect(reimported.record?.state).toBe('active');
    expect(restarted.status('model').state).toBe('active');
  });

  it('Keystore 在但密文被破坏 ⇒ recover 报 material-unreadable → blocked', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    h.port.markUnreadable('keyref:model.deepseek-flash', 1);

    const report = h.restart().recover();
    const model = report.entries.find((e) => e.kind === 'model')!;
    expect(model.after).toBe('blocked');
    expect(model.reason).toBe('material-unreadable');
  });
});

describe('K03 ④ 清单读失败 ≠ 空库', () => {
  it('清单读取抛错时：status 抛 manifest_unreadable，import 失败，不谎报 absent 可用', () => {
    const h = createHarness();
    h.manifest.failNextLoads();
    const broken = h.restart();

    expectSecurityError(() => broken.status('model'), 'manifest_unreadable');
    expectSecurityError(() => broken.exportableViews(), 'manifest_unreadable');

    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    expectFailed(broken.importKey({ kind: 'model', sourceRef: 'import-1' }), 'manifest_unreadable');

    const report = broken.recover();
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('manifest_unreadable');
    expect(report.entries).toEqual([]);

    // 没有因为"读失败"就写一条新记录。
    expect(h.manifest.raw()).toBeNull();
    expect(isSecurityError(new SecurityError('manifest_unreadable', 'x'))).toBe(true);
  });
});

describe('K03 ④ 公共命令：幂等与冲突', () => {
  function importCommand(idempotencyKey: string, sourceRef = 'import-1'): {
    schemaVersion: 'mobile-v1';
    commandId: string;
    operation: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  } {
    return {
      schemaVersion: 'mobile-v1',
      commandId: `cmd-${idempotencyKey}`,
      operation: 'import',
      idempotencyKey,
      payload: { operation: 'key.import', kind: 'model', sourceRef },
    };
  }

  it('同一 idempotencyKey 重复 dispatch ⇒ 返回原结果（idempotentReplay），不重复执行', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));

    const first = h.manager.dispatch(importCommand('idem-a'));
    const sealsAfterFirst = h.port.calls.filter((c) => c.method === 'seal').length;
    const second = h.manager.dispatch(importCommand('idem-a'));

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(second.idempotentReplay).toBe(true);
    expect(second.resultRef).toBe(first.resultRef);
    expect(h.port.calls.filter((c) => c.method === 'seal').length).toBe(sealsAfterFirst); // 没有第二次 seal
  });

  it('expectedRevision 不符 ⇒ 事件 status=conflict（不是 succeeded）', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.dispatch(importCommand('idem-1'));

    const rotate = h.manager.dispatch({
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-rot',
      operation: 'mutate',
      idempotencyKey: 'idem-rot',
      payload: { operation: 'key.rotate', kind: 'model', expectedRevision: 99, sourceRef: 'rot-1' },
    });
    h.registerChannel('rot-1', bytesOf(FIXTURE_MODEL_SECRET_V2));

    expect(rotate.status).toBe('conflict');
    expect(rotate.error?.code).toBe('revision_conflict');
    expect('resultRef' in rotate ? rotate.resultRef : undefined).toBeUndefined();
  });

  it('非法命令 ⇒ 事件 failed，且带错误码', () => {
    const h = createHarness();
    const event = h.manager.dispatch({
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-bad',
      operation: 'mutate', // 与 key.import 映射不符
      idempotencyKey: 'idem-bad',
      payload: { operation: 'key.import', kind: 'model', sourceRef: 'import-1' },
    });
    expect(event.status).toBe('failed');
    expect(event.error?.code).toBe('operation_mismatch');
  });

  it('key.recover 经 dispatch 返回 succeeded 并带 resultRef', () => {
    const h = createHarness();
    const event = h.manager.dispatch({
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-rec',
      operation: 'inspect',
      idempotencyKey: 'idem-rec',
      payload: { operation: 'key.recover' },
    });
    expect(event.status).toBe('succeeded');
    expect(event.resultRef).toBe('keyrecover:2'); // 两类密钥各一条 entry
  });
});

describe('K03 ④ 出口红线：keyRef 在一切结果里都合法', () => {
  it('返回的 keyRef 全部通过双重判据', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    const result = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    expect(assertKeyRef(result.keyRef)).toBe(result.keyRef);
    for (const view of h.manager.exportableViews()) {
      expect(assertKeyRef(view.keyRef)).toBe(view.keyRef);
    }
  });
});
