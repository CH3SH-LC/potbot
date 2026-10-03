/**
 * K-I09 独立验证：**模型端口的 keyRef 改为从 K03 安全包派生**（不是本包写死的字符串）。
 *
 * 集成请求原文（K03 findings）："K02 should source keyRef via
 * apps/mobile-kernel/security DEFAULT_KEY_REFS / KeyManager.status(kind).keyRef instead of
 * hardcoding keyref:..."。
 *
 * 本文件机器化验证四点：
 * 1. 默认来源 = K03 `DEFAULT_KEY_REFS`（本包不再写死引用字符串）；
 * 2. `KeyManager.status(kind).keyRef` 派生出来的引用能通过端口校验并透传给 transport；
 * 3. 任意字符串 / 明文 / `keyref:sk-...` 伪装，无论来自显式入参还是 provider，都被拒；
 * 4. 明文不进 JS 出口（请求结构、wire body、transport 收到的请求都不含密钥特征）。
 *
 * 全部确定性：无网络、无真实密钥、无 sleep。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_REF_PROVIDER,
  buildModelRequest,
  buildWireBody,
  createModelPort,
  createScriptedTransport,
  findPlaintextSecret,
  type KeyRefProvider,
  type ModelPortBuildInput,
} from '../../../apps/mobile-kernel/model/index.js';
import { DEFAULT_KEY_REFS, type KeyKind } from '../../../apps/mobile-kernel/security/index.js';
import { baseInput, createTestKeyManager, expectPortError, fakeSecretBytes } from './fixtures.js';

/** 用 `KeyManager.status(kind).keyRef` 作为 provider 的绑定。 */
function managerProvider(manager: ReturnType<typeof createTestKeyManager>): KeyRefProvider {
  return (kind: KeyKind): string => manager.status(kind).keyRef;
}

describe('K-I09 ① 默认来源 = K03 DEFAULT_KEY_REFS（本包不写死引用）', () => {
  it('显式常量就是 K03 的导出', () => {
    expect(DEFAULT_KEY_REF_PROVIDER('model')).toBe(DEFAULT_KEY_REFS.model);
    expect(DEFAULT_KEY_REF_PROVIDER('meituan')).toBe(DEFAULT_KEY_REFS.meituan);
  });

  it('不给 keyRef、不注入 provider → keyRef 取自 K03 DEFAULT_KEY_REFS.model', () => {
    const request = buildModelRequest(baseInput());
    expect(request.keyRef).toBe(DEFAULT_KEY_REFS.model);
    expect(request.keyRef).toBe('keyref:model.deepseek-flash');
  });

  it('keyKind=meituan → 取自 K03 DEFAULT_KEY_REFS.meituan', () => {
    const request = buildModelRequest(baseInput({ keyKind: 'meituan' }));
    expect(request.keyRef).toBe(DEFAULT_KEY_REFS.meituan);
  });

  it('非法 keyKind → invalid_key_ref（不静默回退到 model）', () => {
    expectPortError('invalid_key_ref', () =>
      buildModelRequest(baseInput({ keyKind: 'nope' as never })),
    );
  });
});

describe('K-I09 ② KeyManager 派生引用通过校验（真实跨包接线）', () => {
  it('absent 状态下 manager.status(kind).keyRef 可作 keyRef 使用', () => {
    const manager = createTestKeyManager();
    const request = buildModelRequest(baseInput(), { keyRefProvider: managerProvider(manager) });
    expect(request.keyRef).toBe(manager.status('model').keyRef);
    expect(request.keyRef).toBe(DEFAULT_KEY_REFS.model);
    expect(findPlaintextSecret(request)).toBeNull();
  });

  it('import 之后（active）派生引用不变，仍能通过端口', () => {
    const manager = createTestKeyManager({ channels: { 'k1': () => fakeSecretBytes() } });
    const imported = manager.importKey({ kind: 'model', sourceRef: 'k1' });
    expect(imported.status).toBe('succeeded');
    expect(manager.status('model').state).toBe('active');

    const request = buildModelRequest(baseInput(), { keyRefProvider: managerProvider(manager) });
    expect(request.keyRef).toBe(manager.status('model').keyRef);
    expect(request.keyRef).toBe(DEFAULT_KEY_REFS.model);
  });

  it('meituan 类的 manager 引用也能被端口接受（同一 provider，按 kind 分流）', () => {
    const manager = createTestKeyManager();
    const request = buildModelRequest(baseInput({ keyKind: 'meituan' }), {
      keyRefProvider: managerProvider(manager),
    });
    expect(request.keyRef).toBe(manager.status('meituan').keyRef);
    expect(request.keyRef).toBe(DEFAULT_KEY_REFS.meituan);
  });
});

describe('K-I09 ③ provider 输出一律再过双重判据，不得成为明文旁路', () => {
  it('provider 给出任意字符串 → invalid_key_ref', () => {
    expectPortError('invalid_key_ref', () =>
      buildModelRequest(baseInput(), { keyRefProvider: () => 'not-a-reference' }),
    );
  });

  it('provider 给出明文密钥 → invalid_key_ref', () => {
    expectPortError('invalid_key_ref', () =>
      buildModelRequest(baseInput(), { keyRefProvider: () => 'sk-abcdefghijklmnop' }),
    );
  });

  it('provider 给出 keyref:sk-... 伪装 → key_ref_contains_secret', () => {
    expectPortError('key_ref_contains_secret', () =>
      buildModelRequest(baseInput(), { keyRefProvider: () => 'keyref:sk-abcdefghijklmnopqrst' }),
    );
  });

  it('provider 抛错（如清单不可读）→ invalid_key_ref，绝不用兜底引用顶上', () => {
    expectPortError('invalid_key_ref', () =>
      buildModelRequest(baseInput(), {
        keyRefProvider: () => {
          throw new Error('manifest unreadable');
        },
      }),
    );
  });

  it('显式 keyRef 优先于 provider（旧用法不变）', () => {
    const request = buildModelRequest(baseInput({ keyRef: 'keyref:test.explicit' }), {
      keyRefProvider: () => DEFAULT_KEY_REFS.model,
    });
    expect(request.keyRef).toBe('keyref:test.explicit');
  });

  it('显式明文 keyRef 仍被拒（旧判据未退化）', () => {
    expectPortError('invalid_key_ref', () =>
      buildModelRequest(baseInput({ keyRef: 'sk-abcdefghijklmnop' })),
    );
  });
});

describe('K-I09 ④ createModelPort 绑定 provider：构造 → 运行 → 透传', () => {
  it('port.buildRequest 用注入来源，run 把该引用透传给 transport，且出口无明文', async () => {
    const manager = createTestKeyManager();
    const transport = createScriptedTransport([
      { events: [{ kind: 'usage', promptTokens: 1, completionTokens: 1 }, { kind: 'done' }] },
    ]);
    const port = createModelPort({ transport, keyRefProvider: managerProvider(manager) });

    const request = port.buildRequest(baseInput());
    expect(request.keyRef).toBe(manager.status('model').keyRef);

    const outcome = await port.run(request);
    expect(outcome.status).toBe('succeeded');

    // wire 请求确实带上了那个引用……
    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    expect(sent?.keyRef).toBe(request.keyRef);
    // ……但线的请求体里**没有**密钥字段，整个请求里也没有明文特征。
    const wire = buildWireBody(request);
    expect(Object.keys(wire)).not.toContain('apiKey');
    expect(Object.keys(wire)).not.toContain('key');
    expect(findPlaintextSecret(sent)).toBeNull();
    expect(findPlaintextSecret(outcome.record)).toBeNull();
  });

  it('未注入 provider 的端口仍能构造请求（默认 K03 引用）', () => {
    const transport = createScriptedTransport([{ events: [{ kind: 'done' }] }]);
    const port = createModelPort({ transport });
    expect(port.buildRequest(baseInput()).keyRef).toBe(DEFAULT_KEY_REFS.model);
  });
});

describe('K-I09 ⑤ 兼容性：旧签名（显式 keyRef）不受影响', () => {
  it('显式 keyRef 的输入类型仍是 buildModelRequest 的合法入参', () => {
    const legacy: ModelPortBuildInput = {
      messages: [{ role: 'user', content: '你好' }],
      keyRef: 'keyref:test.k02',
      budget: { timeoutMs: 30_000 },
    };
    expect(buildModelRequest(legacy).keyRef).toBe('keyref:test.k02');
  });
});
