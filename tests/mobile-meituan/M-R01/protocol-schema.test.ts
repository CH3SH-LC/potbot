/**
 * M-R01 协议 schema 变化分类：逐条判定规则的真实断言。
 */

import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_V1,
  ENVELOPE_V1_1,
  ENVELOPE_V2_BREAKING,
  ENVELOPE_REGISTRY,
  classifySchemaChange,
  lookupEnvelopeSpec,
  validateSchemaSpec,
  type ProtocolSchemaSpec,
} from './protocol-schema.js';

function spec(version: string, fields: ProtocolSchemaSpec['fields']): ProtocolSchemaSpec {
  return Object.freeze({ version, fields: Object.freeze([...fields]) });
}

const BASE = spec('t-v1', [
  { name: 'code', type: 'integer', required: true },
  { name: 'msg', type: 'string', required: true },
]);

describe('M-R01 validateSchemaSpec', () => {
  it('重复字段名判为非法', () => {
    const bad = spec('t-v1', [
      { name: 'code', type: 'integer', required: true },
      { name: 'code', type: 'string', required: false },
    ]);
    expect(validateSchemaSpec(bad)).toContain('字段名重复：code');
  });

  it('空 version 判为非法', () => {
    expect(validateSchemaSpec(spec('  ', [])).length).toBeGreaterThan(0);
  });
});

describe('M-R01 classifySchemaChange：兼容 vs 破坏', () => {
  it('字段完全相同 ⇒ identical', () => {
    expect(classifySchemaChange(BASE, BASE).kind).toBe('identical');
    expect(classifySchemaChange(BASE, BASE).requiresMigration).toBe(false);
  });

  it('新增可选字段 ⇒ compatible', () => {
    const next = spec('t-v1.1', [...BASE.fields, { name: 'traceId', type: 'string', required: false }]);
    const verdict = classifySchemaChange(BASE, next);
    expect(verdict.kind).toBe('compatible');
    expect(verdict.requiresMigration).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('traceId'))).toBe(true);
  });

  it('必需放宽为可选（且版本号随之上升）⇒ compatible', () => {
    const next = spec('t-v1.1', [
      { name: 'code', type: 'integer', required: true },
      { name: 'msg', type: 'string', required: false },
    ]);
    expect(classifySchemaChange(BASE, next).kind).toBe('compatible');
  });

  it('同版本号下把必需放宽为可选 ⇒ 仍判 breaking（版本号未升）', () => {
    const next = spec('t-v1', [
      { name: 'code', type: 'integer', required: true },
      { name: 'msg', type: 'string', required: false },
    ]);
    const verdict = classifySchemaChange(BASE, next);
    expect(verdict.kind).toBe('breaking');
    expect(verdict.reasons.some((r) => r.includes('同版本'))).toBe(true);
  });

  it('新增必需字段 ⇒ breaking（旧消费者会缺字段）', () => {
    const next = spec('t-v2', [...BASE.fields, { name: 'requestId', type: 'string', required: true }]);
    const verdict = classifySchemaChange(BASE, next);
    expect(verdict.kind).toBe('breaking');
    expect(verdict.requiresMigration).toBe(true);
  });

  it('删除字段 ⇒ breaking', () => {
    const next = spec('t-v2', [{ name: 'code', type: 'integer', required: true }]);
    expect(classifySchemaChange(BASE, next).kind).toBe('breaking');
  });

  it('字段类型改变 ⇒ breaking', () => {
    const next = spec('t-v2', [
      { name: 'code', type: 'string', required: true },
      { name: 'msg', type: 'string', required: true },
    ]);
    const verdict = classifySchemaChange(BASE, next);
    expect(verdict.kind).toBe('breaking');
    expect(verdict.reasons.some((r) => r.includes('类型改变'))).toBe(true);
  });

  it('可选收紧为必需 ⇒ breaking', () => {
    const from = spec('t-v1', [{ name: 'code', type: 'integer', required: false }]);
    const to = spec('t-v2', [{ name: 'code', type: 'integer', required: true }]);
    expect(classifySchemaChange(from, to).kind).toBe('breaking');
  });

  it('枚举新增成员 ⇒ breaking（消费者可能未处理）', () => {
    const from = spec('t-v1', [{ name: 'state', type: 'string', required: true, enumValues: ['a', 'b'] }]);
    const to = spec('t-v2', [{ name: 'state', type: 'string', required: true, enumValues: ['a', 'b', 'c'] }]);
    const verdict = classifySchemaChange(from, to);
    expect(verdict.kind).toBe('breaking');
    expect(verdict.reasons.some((r) => r.includes('枚举值新增'))).toBe(true);
  });

  it('枚举删除成员 ⇒ breaking', () => {
    const from = spec('t-v1', [{ name: 'state', type: 'string', required: true, enumValues: ['a', 'b'] }]);
    const to = spec('t-v2', [{ name: 'state', type: 'string', required: true, enumValues: ['a'] }]);
    expect(classifySchemaChange(from, to).kind).toBe('breaking');
  });

  it('同版本号下字段漂移 ⇒ breaking（版本号没升最危险）', () => {
    const next = spec('t-v1', [...BASE.fields, { name: 'extra', type: 'string', required: false }]);
    const verdict = classifySchemaChange(BASE, next);
    expect(verdict.kind).toBe('breaking');
    expect(verdict.reasons.some((r) => r.includes('同版本'))).toBe(true);
  });

  it('规格非法 ⇒ unknown-version（拒绝比较）', () => {
    const bad = spec('t-v1', [
      { name: 'x', type: 'string', required: true },
      { name: 'x', type: 'string', required: false },
    ]);
    expect(classifySchemaChange(BASE, bad).kind).toBe('unknown-version');
  });
});

describe('M-R01 示例信封登记', () => {
  it('v1 → v1.1 兼容；v1 → v2 破坏；v1 → v1 相同', () => {
    expect(classifySchemaChange(ENVELOPE_V1, ENVELOPE_V1_1).kind).toBe('compatible');
    expect(classifySchemaChange(ENVELOPE_V1, ENVELOPE_V2_BREAKING).kind).toBe('breaking');
    expect(classifySchemaChange(ENVELOPE_V1, ENVELOPE_V1).kind).toBe('identical');
  });

  it('登记表可查；未登记版本返回 undefined', () => {
    expect(lookupEnvelopeSpec('wmh5-envelope-v1')).toBe(ENVELOPE_V1);
    expect(lookupEnvelopeSpec('does-not-exist')).toBeUndefined();
    expect(new Set(ENVELOPE_REGISTRY.map((s) => s.version)).size).toBe(ENVELOPE_REGISTRY.length);
  });
});
