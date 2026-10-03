/**
 * K03 独立验证 ②：导入 / 轮换 / 删除状态机。
 *
 * 指纹断言用 `node:crypto` 独立算出的期望值，而不是拿实现自己的摘要去自证——
 * 否则"写入的指纹"和"校验的指纹"同错同对，判据退化。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createHarness, expectConflict, expectFailed, FIXTURE_MODEL_SECRET, FIXTURE_MODEL_SECRET_V2, bytesOf } from './fixtures.js';

function oracleFingerprint(text: string): string {
  return `sha256:${createHash('sha256').update(new Uint8Array(Buffer.from(text, 'utf8'))).digest('hex')}`;
}

describe('K03 ② import：首建', () => {
  it('absent → active，revision=1，指纹与外部预言机一致，密文≠明文', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));

    expect(h.manager.status('model').state).toBe('absent');
    const before = h.port.calls.length;

    const result = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    expect(result.status).toBe('succeeded');
    expect(result.revision).toBe(1);
    expect(result.keyRef).toBe('keyref:model.deepseek-flash');
    expect(result.record?.state).toBe('active');
    expect(result.record?.fingerprint).toBe(oracleFingerprint(FIXTURE_MODEL_SECRET));
    expect(result.error).toBeNull();

    // 落盘、可探针读回；密文与明文不同，且长度一致。
    expect(h.port.probe(result.keyRef!, 1).state).toBe('readable');
    const cipher = h.port.ciphertextOf(result.keyRef!, 1)!;
    expect(cipher.length).toBe(bytesOf(FIXTURE_MODEL_SECRET).length);
    expect(Array.from(cipher)).not.toEqual(Array.from(bytesOf(FIXTURE_MODEL_SECRET)));

    // 清单已持久化；导入过程确实调用了 provision（此前未就绪）。
    expect(h.manifest.raw()?.[0]?.state).toBe('active');
    const methods = h.port.calls.slice(before).map((c) => c.method);
    expect(methods).toContain('provision');
  });

  it('active 上再次 import ⇒ conflict key_already_present（换密钥必须显式 rotate）', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.registerChannel('import-2', bytesOf(FIXTURE_MODEL_SECRET_V2));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    const second = h.manager.importKey({ kind: 'model', sourceRef: 'import-2' });
    expect(second.status).toBe('failed');
    expect(second.error?.code).toBe('key_already_present');
    // 第二次导入不该碰端口：没有新的 seal。
    expect(h.port.calls.filter((c) => c.method === 'seal').length).toBe(1);
  });

  it('导入通道一次性：同一通道第二次使用 ⇒ secret_source_exhausted', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    h.manager.deleteKey({ kind: 'model', expectedRevision: 1 });

    const again = h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    expectFailed(again, 'secret_source_exhausted');
  });

  it('未知通道 / 空字节 / 过短字节 各有专属拒因', () => {
    const h = createHarness();
    h.registerChannel('empty', new Uint8Array(0));
    h.registerChannel('tiny', bytesOf('abc'));

    expectFailed(h.manager.importKey({ kind: 'model', sourceRef: 'nope' }), 'secret_source_unknown');
    expectFailed(h.manager.importKey({ kind: 'model', sourceRef: 'empty' }), 'secret_source_empty');
    expectFailed(h.manager.importKey({ kind: 'model', sourceRef: 'tiny' }), 'secret_too_short');
    // 三次失败都没有留下记录 / 密文。
    expect(h.manifest.raw()).toBeNull();
    expect(h.manager.status('model').state).toBe('absent');
  });

  it('keyRef 与 kind 不一致 ⇒ invalid_key_kind', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    const result = h.manager.importKey({ kind: 'meituan', sourceRef: 'import-1', keyRef: 'keyref:model.deepseek-flash' });
    expectFailed(result, 'invalid_key_kind');
  });
});

describe('K03 ② rotate：换新密钥（同 keyRef）', () => {
  it('rev+1、指纹更新、旧代密文被销毁、rotatedAtMs 记录', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.registerChannel('rot-1', bytesOf(FIXTURE_MODEL_SECRET_V2));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });
    h.clock.advance(60_000);

    const rotated = h.manager.rotateKey({ kind: 'model', sourceRef: 'rot-1', expectedRevision: 1 });

    expect(rotated.status).toBe('succeeded');
    expect(rotated.revision).toBe(2);
    expect(rotated.record?.fingerprint).toBe(oracleFingerprint(FIXTURE_MODEL_SECRET_V2));
    expect(rotated.record?.rotatedAtMs).toBe(h.clock.now());
    expect(rotated.record?.pendingCleanupRevisions).toEqual([]);
    // 旧代密文已销毁，新代可读。
    expect(h.port.hasCiphertext('keyref:model.deepseek-flash', 1)).toBe(false);
    expect(h.port.probe('keyref:model.deepseek-flash', 2).state).toBe('readable');
  });

  it('旧代销毁失败不算失败：新密钥可用，但记录 pendingCleanupRevisions', () => {
    const h = createHarness({ destroyFails: true });
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.registerChannel('rot-1', bytesOf(FIXTURE_MODEL_SECRET_V2));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    const rotated = h.manager.rotateKey({ kind: 'model', sourceRef: 'rot-1', expectedRevision: 1 });

    expect(rotated.status).toBe('succeeded');
    expect(rotated.revision).toBe(2);
    expect(rotated.record?.pendingCleanupRevisions).toEqual([1]);
  });

  it('expectedRevision 不符 ⇒ conflict；缺失 ⇒ expected_revision_required', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.registerChannel('rot-1', bytesOf(FIXTURE_MODEL_SECRET_V2));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    expectConflict(h.manager.rotateKey({ kind: 'model', sourceRef: 'rot-1', expectedRevision: 7 }), 'revision_conflict');
    expectFailed(h.manager.rotateKey({ kind: 'model', sourceRef: 'rot-1' }), 'expected_revision_required');
    // 冲突不该动密钥：仍是 rev1、仍是旧指纹。
    expect(h.manager.status('model').revision).toBe(1);
    expect(h.manager.status('model').fingerprint).toBe(oracleFingerprint(FIXTURE_MODEL_SECRET));
  });

  it('absent 上 rotate ⇒ nothing_to_rotate', () => {
    const h = createHarness();
    h.registerChannel('rot-1', bytesOf(FIXTURE_MODEL_SECRET_V2));
    expectFailed(h.manager.rotateKey({ kind: 'meituan', sourceRef: 'rot-1', expectedRevision: 0 }), 'nothing_to_rotate');
  });
});

describe('K03 ② delete：销毁密文', () => {
  it('删除成功 ⇒ absent、指纹清空、密文销毁', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    const deleted = h.manager.deleteKey({ kind: 'model', expectedRevision: 1 });

    expect(deleted.status).toBe('succeeded');
    expect(deleted.record?.state).toBe('absent');
    expect(deleted.record?.fingerprint).toBeNull();
    expect(deleted.record?.revokedAtMs).toBe(h.clock.now());
    expect(h.port.hasCiphertext('keyref:model.deepseek-flash', 1)).toBe(false);
    expect(h.manager.status('model').state).toBe('absent');
  });

  it('销毁失败 ⇒ failed destroy_failed，且**不谎报**已删（记录保持 active）', () => {
    const h = createHarness({ destroyFails: true });
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    const deleted = h.manager.deleteKey({ kind: 'model', expectedRevision: 1 });
    expectFailed(deleted, 'destroy_failed');
    expect(h.manager.status('model').state).toBe('active');
    expect(h.port.probe('keyref:model.deepseek-flash', 1).state).toBe('readable');
  });

  it('expectedRevision 不符 ⇒ conflict；无对象 ⇒ key_not_found', () => {
    const h = createHarness();
    h.registerChannel('import-1', bytesOf(FIXTURE_MODEL_SECRET));
    h.manager.importKey({ kind: 'model', sourceRef: 'import-1' });

    expectConflict(h.manager.deleteKey({ kind: 'model', expectedRevision: 9 }), 'revision_conflict');
    expectFailed(h.manager.deleteKey({ kind: 'meituan', expectedRevision: 0 }), 'key_not_found');
  });
});
