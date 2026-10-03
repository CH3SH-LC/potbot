/**
 * K-I03 · 给 K02 脱敏扫描器的 `sk-` 模式加左边界（修 `task-registered` 误报）。
 * =====================================================================
 * 缺陷（K10 在自己的脱敏副本里率先发现并修复，本单元把同款修复落到 model 模块）：
 * `apps/mobile-kernel/model/redact.ts` 的 `PLAINTEXT_SECRET_PATTERNS` 用无界 `/sk-/`，
 * 会命中普通单词 `task-registered` 内部的 `sk-registered`，把正常事件判成明文密钥。
 *
 * 修复口径：
 *   1. 加左边界 `(?<![A-Za-z0-9_])`（与 K10 一致）——只挡「前一个字符是词字符」；
 *   2. **不改导出数组形状**（仍是 `readonly RegExp[]`，5 条）；
 *   3. **不放松**对伪装引用的判据：`keyref:sk-live-...`（形状是引用、内容是明文）仍必须命中。
 *
 * 本测试只**读** K02 的真实导出，不修改任何产品源码；断言全部是正向样例 + 反向对照，
 * 防止「正则写错 ⇒ 静默零命中 ⇒ 假绿灯」。K-R04 侧的口径对齐另在其包内守护。
 */

import { describe, expect, it } from 'vitest';

import {
  PLAINTEXT_SECRET_PATTERNS,
  assertNoPlaintextSecret,
  findPlaintextSecret,
} from '../../../apps/mobile-kernel/model/redact.js';

/** 朴素（无界）正则：仅用于反证「这些样例确实会被旧写法误报」。 */
const NAIVE_SK = /sk-[A-Za-z0-9_-]{10,}/;

/** 把数组里的 pattern 连成一段文本，便于做「同一组显著 token」的核对。 */
const patternsText = PLAINTEXT_SECRET_PATTERNS.map((p) => p.source).join(' | ');

describe('K-I03 · 导出形状不变', () => {
  it('仍是 5 条 readonly RegExp，且 sk- 一条在首位', () => {
    expect(Array.isArray(PLAINTEXT_SECRET_PATTERNS)).toBe(true);
    expect(PLAINTEXT_SECRET_PATTERNS.length).toBe(5);
    for (const p of PLAINTEXT_SECRET_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
    // 显著 token 逐类仍在（防口径漂移时被静默改名）。
    for (const token of ['sk-', 'Bearer', 'AIza', 'PRIVATE KEY', 'api[_-]?key']) {
      expect(patternsText).toContain(token);
    }
    expect(PLAINTEXT_SECRET_PATTERNS[0]?.source).toContain('sk-');
  });

  it('分条 token 与 id 顺序稳定：sk / Bearer / AIza / api-key / PEM', () => {
    expect(PLAINTEXT_SECRET_PATTERNS[0]?.source).toContain('sk-');
    expect(PLAINTEXT_SECRET_PATTERNS[1]?.source).toContain('Bearer');
    expect(PLAINTEXT_SECRET_PATTERNS[2]?.source).toContain('AIza');
    expect(PLAINTEXT_SECRET_PATTERNS[3]?.source).toContain('api[_-]?key');
    expect(PLAINTEXT_SECRET_PATTERNS[4]?.source).toContain('PRIVATE KEY');
  });
});

describe('K-I03 · 普通单词内部 sk- 不再误报（缺陷本体）', () => {
  // 这些词都含 `sk-registered`（`sk-` 前一个字符是字母），朴素正则都会误报。
  const ORDINARY_WORDS = [
    'task-registered',
    'risk-registered',
    'flask-registered',
    'musk-registered',
  ];

  it('findPlaintextSecret 对这些词一律返回 null', () => {
    for (const w of ORDINARY_WORDS) {
      // 反证：旧的无界写法确实会命中（否则本用例是空转）。
      expect(NAIVE_SK.test(w)).toBe(true);
      expect(findPlaintextSecret(w)).toBeNull();
    }
  });

  it('嵌套对象 / JSON 串里的普通词同样不误报', () => {
    expect(findPlaintextSecret({ status: 'task-registered' })).toBeNull();
    expect(findPlaintextSecret(['task-registered', 'risk-registered'])).toBeNull();
    expect(findPlaintextSecret('{"status":"task-registered"}')).toBeNull();
  });

  it('assertNoPlaintextSecret 对普通词不抛', () => {
    expect(() => assertNoPlaintextSecret('task-registered', 'event.status')).not.toThrow();
    expect(() => assertNoPlaintextSecret({ note: 'flask-registered' }, 'payload')).not.toThrow();
  });
});

describe('K-I03 · 伪装引用与真密钥仍必须命中（不放松判据）', () => {
  it('`keyref:sk-live-...`（形状是引用、内容是明文）仍命中且命中体以 `sk-` 起', () => {
    const masq = 'keyref:sk-live-abcdefghijklmnop';
    const hit = findPlaintextSecret(masq);
    expect(hit).not.toBeNull();
    expect(hit?.startsWith('sk-')).toBe(true);
    // 这正是修复要保住的场景：`:` 不是 [A-Za-z0-9_]，边界不该把它切掉。
    expect(hit).toBe('sk-live-abcdefghijklmnop');
  });

  it('嵌套对象里的伪装引用也命中', () => {
    expect(findPlaintextSecret({ keyRef: 'keyref:sk-live-abcdefghijklmnop' })).not.toBeNull();
    expect(findPlaintextSecret('{"keyRef":"keyref:sk-live-abcdefghijklmnop"}')).not.toBeNull();
  });

  it('行首 / 空白后的真密钥仍命中', () => {
    expect(findPlaintextSecret('sk-abcdefghijklmnop')).not.toBeNull();
    expect(findPlaintextSecret('  sk-abcdefghijklmnop')).not.toBeNull();
    expect(findPlaintextSecret('token=sk-abcdefghijklmnop')).not.toBeNull();
    expect(findPlaintextSecret('{"k":"sk-live-0123456789abcdef"}')).not.toBeNull();
    // 常见定界符（引号 / 括号 / 等号 / 冒号）都不是词字符，边界不得伤到它们。
    for (const delim of ['"', "'", '(', '=', ':', '/', '[']) {
      expect(findPlaintextSecret(`${delim}sk-abcdefghijklmnop`)).not.toBeNull();
    }
  });
});

describe('K-I03 · 左边界的精确类：仅 [A-Za-z0-9_] 被挡', () => {
  it('紧邻词字符（字母 / 数字 / 下划线）时不命中', () => {
    expect(findPlaintextSecret('_sk-abcdefghijklmnop')).toBeNull();
    expect(findPlaintextSecret('Ask-abcdefghijklmnop')).toBeNull();
    expect(findPlaintextSecret('9sk-abcdefghijklmnop')).toBeNull();
    expect(findPlaintextSecret('zsk-abcdefghijklmnop')).toBeNull();
  });

  it('紧邻非词字符（- / . / @ / 空白）时命中', () => {
    expect(findPlaintextSecret('-sk-abcdefghijklmnop')).not.toBeNull();
    expect(findPlaintextSecret('.sk-abcdefghijklmnop')).not.toBeNull();
    expect(findPlaintextSecret('@sk-abcdefghijklmnop')).not.toBeNull();
    expect(findPlaintextSecret('\tsk-abcdefghijklmnop')).not.toBeNull();
  });
});

describe('K-I03 · 既有安全样例不回归', () => {
  it('sha256 摘要 / 取消令牌 / content:// URI 都不误报', () => {
    expect(findPlaintextSecret('sha256:' + 'a'.repeat(64))).toBeNull();
    expect(findPlaintextSecret('cancel-42')).toBeNull();
    expect(findPlaintextSecret('content://com.potbot.kernel/artifacts/1')).toBeNull();
    expect(findPlaintextSecret('keyref:model.deepseek-flash')).toBeNull();
  });

  it('assertNoPlaintextSecret：真密钥抛，且错误信息不回显原文', () => {
    const secret = 'sk-abcdefghijklmnop';
    let thrown: unknown;
    try {
      assertNoPlaintextSecret(secret, 'keyRef');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).message).not.toContain('abcdefghijklmnop');
  });
});
