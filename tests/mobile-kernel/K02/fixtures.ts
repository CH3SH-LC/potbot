/**
 * K02 独立验证 fixtures —— 只构造**确定性**输入，不发起任何网络访问、不读任何密钥。
 *
 * 所有请求的 `keyRef` 都是 `keyref:test.k02`（形状合法、内容无密钥特征），
 * 与被测实现无关：端口只把它当引用透传给 transport，且不得写进任何记录。
 */

import {
  buildModelRequest,
  ModelPortError,
  type ModelPortRequest,
  type ModelPortRequestInput,
} from '../../../apps/mobile-kernel/model/index.js';

/** 假 transport 用的固定 keyRef；**不是**密钥，只是引用。 */
export const TEST_KEY_REF = 'keyref:test.k02';

/** 默认单条 user 消息。 */
export function baseRequest(overrides: Partial<ModelPortRequestInput> = {}): ModelPortRequest {
  return buildModelRequest({
    messages: [{ role: 'user', content: '你好' }],
    keyRef: TEST_KEY_REF,
    budget: { timeoutMs: 30_000 },
    ...overrides,
  });
}

/**
 * 冲刷微任务与事件循环若干轮，让被测实现来得及**注册**手动定时器/取消订阅。
 *
 * 用 `setImmediate`（Node 内置）而不是被测注入的 `TimerPort`，所以不会和手动定时器混淆。
 */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 断言一个同步调用抛出**指定码**的 `ModelPortError`；返回该错误以便进一步断言。 */
export function expectPortError(code: string, run: () => unknown): ModelPortError {
  try {
    run();
  } catch (error) {
    if (error instanceof ModelPortError) {
      if (error.code !== code) {
        throw new Error(`期望拒因 ${code}，实际 ${error.code}：${error.message}`);
      }
      return error;
    }
    throw new Error(`期望 ModelPortError(${code})，实际抛出 ${String(error)}`);
  }
  throw new Error(`期望抛出 ModelPortError(${code})，但没有抛`);
}
