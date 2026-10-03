/**
 * M-R01 fixture 语料：脱敏 + 诚实性门禁（正例通过、负例必须报错）。
 *
 * 真正调用 `loadFixtures()` 读磁盘上的 JSON（不是内存自造），断言它们**全部**通过
 * `validateFixture`；再故意篡改四条不变量，证明门禁不是空壳。
 */

import { describe, expect, it } from 'vitest';

import {
  assertFixtureValid,
  fixtureCountsByOperation,
  listFixtureFiles,
  loadFixture,
  loadFixtures,
  validateFixture,
  type MeituanFixtureFile,
} from './fixtures.js';
import { classifyWireError } from './error-codes.js';

function tamper(base: MeituanFixtureFile, patch: Record<string, unknown>): MeituanFixtureFile {
  return { ...base, ...patch } as unknown as MeituanFixtureFile;
}

describe('M-R01 fixture 语料（磁盘真实读取）', () => {
  it('至少 6 个 fixture 文件', () => {
    expect(listFixtureFiles().length).toBeGreaterThanOrEqual(6);
  });

  it('每个 fixture 都通过形状/诚实性/版本/脱敏四道门禁', () => {
    for (const file of loadFixtures()) {
      const problems = validateFixture(file);
      expect(problems, `${file.fixtureId}: ${problems.join('; ')}`).toEqual([]);
      expect(() => assertFixtureValid(file)).not.toThrow();
    }
  });

  it('fixtureId 唯一', () => {
    const ids = loadFixtures().map((f) => f.fixtureId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('覆盖 search/menu/preview/submit/query 五个操作', () => {
    const counts = fixtureCountsByOperation();
    for (const op of ['search', 'menu', 'preview', 'submit', 'query']) {
      expect(counts[op], `缺少 ${op} 的 fixture`).toBeGreaterThanOrEqual(1);
    }
    expect(counts.submit).toBeGreaterThanOrEqual(2);
  });

  it('所有合成 fixture 都声明 verificationMode=fixture 且 capturedAt=null', () => {
    for (const file of loadFixtures()) {
      expect(file.provenance.startsWith('synthetic-')).toBe(true);
      expect(file.verificationMode).toBe('fixture');
      expect(file.capturedAt).toBeNull();
    }
  });

  it('fixture 载荷自身经 scanForPii 后为空（无 PII 残留）', () => {
    for (const file of loadFixtures()) {
      expect(validateFixture(file).filter((p) => p.includes('PII'))).toEqual([]);
    }
  });
});

describe('M-R01 fixture 门禁的负例（篡改必须报错）', () => {
  const base = loadFixture('submit.error.price-changed.json');

  it('合成 fixture 自称有 capturedAt ⇒ 违规', () => {
    const bad = tamper(base, { capturedAt: '2026-10-03T00:00:00Z' });
    expect(validateFixture(bad).some((p) => p.includes('capturedAt'))).toBe(true);
  });

  it('合成 fixture 声明 verificationMode=real ⇒ 违规', () => {
    const bad = tamper(base, { verificationMode: 'real' });
    expect(validateFixture(bad).some((p) => p.includes('verificationMode'))).toBe(true);
  });

  it('real-captured-redacted 缺 ISO capturedAt ⇒ 违规', () => {
    const bad = tamper(base, { provenance: 'real-captured-redacted', capturedAt: null, verificationMode: 'real' });
    expect(validateFixture(bad).some((p) => p.includes('capturedAt'))).toBe(true);
  });

  it('未登记的 protocolVersion ⇒ 违规', () => {
    const bad = tamper(base, { protocolVersion: 'wmh5-envelope-v99' });
    expect(validateFixture(bad).some((p) => p.includes('未在'))).toBe(true);
  });

  it('信封缺必需字段（删掉 data）⇒ 违规', () => {
    const bad = tamper(base, { value: { code: 1003, msg: 'x' } });
    expect(validateFixture(bad).some((p) => p.includes('必需字段'))).toBe(true);
  });

  it('values 里塞入裸手机号 ⇒ PII 违规', () => {
    const bad = tamper(base, { value: { code: 0, msg: 'ok', data: { phone: '13912345678' } } });
    expect(validateFixture(bad).some((p) => p.includes('PII'))).toBe(true);
  });

  it('未知 operation ⇒ 违规', () => {
    const bad = tamper(base, { operation: 'teleport' });
    expect(validateFixture(bad).some((p) => p.includes('operation'))).toBe(true);
  });
});

describe('M-R01 fixture × 错误码分类交叉核对', () => {
  it('提交类 fixture 的业务码经 classifyWireError 绝不判 ok', () => {
    for (const file of loadFixtures().filter((f) => f.operation === 'submit')) {
      const envelope = file.value as { code: number | string };
      const code = String(envelope.code);
      const classification = classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: code });
      expect(classification.category, `${file.fixtureId} 码 ${code}`).not.toBe('ok');
    }
  });

  it('price-changed fixture ⇒ business_reject；duplicate fixture ⇒ unknown+须查原单', () => {
    const priceChanged = loadFixture('submit.error.price-changed.json').value as { code: number };
    const duplicate = loadFixture('submit.unknown.duplicate.json').value as { code: number };
    expect(classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: String(priceChanged.code) }).category).toBe('business_reject');
    const dup = classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: String(duplicate.code) });
    expect(dup.category).toBe('unknown');
    expect(dup.requiresOrderQuery).toBe(true);
  });

  it('query fixture 为 fixture 模式 ⇒ observedState 不得为 confirmed（契约不变量）', () => {
    const query = loadFixture('query.readback.submitted.json').value as { data: { observedState: string } };
    expect(query.data.observedState).not.toBe('confirmed');
  });
});
