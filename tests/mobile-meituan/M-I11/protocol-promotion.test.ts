/**
 * M-I11：把 M-R01 可复用模块提升到生产源码树
 * `src/mobile-plugins/meituan/protocol/` 后的**回归与集成**断言。
 *
 * 本文件**只消费生产出口**（`.../protocol/index.js`），不 import 测试树中的 M-R01 副本
 * ——这正是本次集成要断开的那条依赖。四个必证项（任务书 M-I11）：
 *
 * 1. `synthetic-*` fixture **不得**自称 `capturedAt`；
 * 2. `real-captured-redacted` 缺少 / 非 ISO `capturedAt` **必须被拒**；
 * 3. PII 扫描器在多次调用之间**重置正则 `lastIndex`**（无跨调用状态）；
 * 4. HTTP 200 且业务码**未知 / 空 / 缺失**一律**绝不** `ok`。
 *
 * 每个"必须失败"的断言都配**反向对照**（合法输入必须通过），避免空证明。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_V1,
  ENVELOPE_V1_1,
  ENVELOPE_V2_BREAKING,
  PII_KINDS,
  PROTOCOL_PACKAGE_BOUNDARY,
  assertFixtureValid,
  assertRedacted,
  classifySchemaChange,
  classifyWireError,
  isSafeSensitiveValue,
  mayReportWireSuccess,
  redactedPlaceholder,
  redactProtocolPayload,
  scanForPii,
  validateFixture,
  type MeituanFixtureFile,
} from '../../../src/mobile-plugins/meituan/protocol/index.js';

// 合成测试数据（非真实 PII；仅用于负例向量）。
const RAW_PHONE = '13912345678';
const RAW_ID = '110101199003071234';

// ---------------------------------------------------------------------------
// 生产出口完整性 + 边界（"不伸手进测试树"这一目标的机器化证据）
// ---------------------------------------------------------------------------

const PACKAGE_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/protocol/', import.meta.url));

describe('M-I11 生产出口与边界', () => {
  it('生产源码零 I/O：不 import node:*、不 import tests/**', () => {
    const files = readdirSync(PACKAGE_DIR).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    const offenders: string[] = [];
    for (const name of files) {
      const text = readFileSync(`${PACKAGE_DIR}${name}`, 'utf8');
      for (const line of text.split('\n')) {
        const spec = /^\s*import\b/.test(line) ? line : '';
        if (spec !== '' && (spec.includes("'node:") || spec.includes('"node:'))) offenders.push(`${name}: node:* (${line.trim()})`);
        if (spec !== '' && (spec.includes('tests/') || spec.includes('mobile-meituan'))) offenders.push(`${name}: tests/** (${line.trim()})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('边界常量如实声明纯函数 / 未接真实平台', () => {
    expect(PROTOCOL_PACKAGE_BOUNDARY.readsNetwork).toBe(false);
    expect(PROTOCOL_PACKAGE_BOUNDARY.readsClock).toBe(false);
    expect(PROTOCOL_PACKAGE_BOUNDARY.readsEnv).toBe(false);
    expect(PROTOCOL_PACKAGE_BOUNDARY.readsFilesystem).toBe(false);
    expect(PROTOCOL_PACKAGE_BOUNDARY.hardcodesOfficialCodes).toBe(false);
    expect(PROTOCOL_PACKAGE_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(PROTOCOL_PACKAGE_BOUNDARY.verificationMode).toBe('fixture');
  });
});

// ---------------------------------------------------------------------------
// 必证项 1 & 2：fixture 诚实性门禁
// ---------------------------------------------------------------------------

function baseFixture(overrides: Partial<MeituanFixtureFile> = {}): MeituanFixtureFile {
  return {
    fixtureId: 'mi11-fixture',
    operation: 'search',
    protocolVersion: 'wmh5-envelope-v1',
    provenance: 'synthetic-unverified',
    verificationMode: 'fixture',
    capturedAt: null,
    note: 'M-I11 合成向量',
    value: { code: 0, msg: 'ok', data: {} },
    ...overrides,
  };
}

describe('M-I11 (必证 1) synthetic fixture 不得自称 capturedAt', () => {
  it('合成 fixture 带 ISO capturedAt ⇒ 被门禁拒绝且抛错', () => {
    const file = baseFixture({ provenance: 'synthetic-unverified', capturedAt: '2026-10-03T08:00:00Z' });
    const problems = validateFixture(file);
    expect(problems.some((p) => p.includes('capturedAt'))).toBe(true);
    expect(() => assertFixtureValid(file)).toThrow(/MR01_FIXTURE_INVALID/);
  });

  it('synthetic-doc-shaped 同样不得带 capturedAt', () => {
    const file = baseFixture({ provenance: 'synthetic-doc-shaped', capturedAt: '2026-10-03T08:00:00Z' });
    expect(validateFixture(file).some((p) => p.includes('capturedAt'))).toBe(true);
  });

  it('合成 fixture 不得声明 verificationMode=real', () => {
    const file = baseFixture({ provenance: 'synthetic-unverified', verificationMode: 'real' });
    expect(validateFixture(file).some((p) => p.includes('verificationMode=real'))).toBe(true);
  });

  it('反向对照：合成 fixture（capturedAt=null、fixture 模式）通过门禁', () => {
    expect(validateFixture(baseFixture())).toEqual([]);
    expect(() => assertFixtureValid(baseFixture())).not.toThrow();
  });
});

describe('M-I11 (必证 2) real-captured-redacted 缺少 ISO capturedAt 必须被拒', () => {
  it('capturedAt=null ⇒ 被拒', () => {
    const file = baseFixture({ provenance: 'real-captured-redacted', verificationMode: 'real', capturedAt: null });
    const problems = validateFixture(file);
    expect(problems.some((p) => p.includes('ISO-8601 capturedAt'))).toBe(true);
    expect(() => assertFixtureValid(file)).toThrow(/MR01_FIXTURE_INVALID/);
  });

  it('非 ISO 形状的 capturedAt ⇒ 被拒', () => {
    const file = baseFixture({
      provenance: 'real-captured-redacted',
      verificationMode: 'real',
      capturedAt: '2026/10/03 08:00',
    });
    expect(validateFixture(file).some((p) => p.includes('ISO-8601 capturedAt'))).toBe(true);
  });

  it('反向对照：带 ISO capturedAt（含毫秒）⇒ 通过门禁', () => {
    const file = baseFixture({
      provenance: 'real-captured-redacted',
      verificationMode: 'real',
      capturedAt: '2026-10-03T08:00:00.123Z',
    });
    expect(validateFixture(file)).toEqual([]);
  });
});

describe('M-I11 fixture 门禁：形状 / 协议版本 / 脱敏三关仍在', () => {
  it('未登记的 protocolVersion 被拒', () => {
    const file = baseFixture({ protocolVersion: 'not-registered-v9' });
    expect(validateFixture(file).some((p) => p.includes('未在 ENVELOPE_REGISTRY 登记'))).toBe(true);
  });

  it('信封缺必需字段被拒', () => {
    const file = baseFixture({ value: { code: 0 } }); // 缺 msg/data
    const problems = validateFixture(file);
    expect(problems.some((p) => p.includes('msg'))).toBe(true);
    expect(problems.some((p) => p.includes('data'))).toBe(true);
  });

  it('载荷含裸手机号被拒（脱敏关）', () => {
    const file = baseFixture({ value: { code: 0, msg: 'ok', data: { remark: `联系 ${RAW_PHONE}` } } });
    expect(validateFixture(file).some((p) => p.includes('PII 残留'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 必证项 3：PII 扫描器无跨调用状态（lastIndex 重置）
// ---------------------------------------------------------------------------

describe('M-I11 (必证 3) PII 扫描重置正则 lastIndex（无跨调用状态）', () => {
  // 自由文本路径走 findPatternKind → matches()，正是带 `g` 正则的状态风险点。
  // 若未重置 lastIndex，同一输入连续 `.test()` 会出现"命中→漏判→命中"的交替。
  it('同一手机号形状的输入，连续扫描 6 次都命中 phone', () => {
    const payload = { remark: `请联系 ${RAW_PHONE}` };
    for (let i = 0; i < 6; i += 1) {
      const kinds = scanForPii(payload).map((v) => v.kind);
      expect(kinds, `第 ${i + 1} 次扫描`).toContain('phone');
    }
  });

  it('命中后穿插一次干净载荷，再扫描仍命中（状态未泄漏）', () => {
    const dirty = { remark: `请联系 ${RAW_PHONE}` };
    const clean = { remark: '无个人信息的备注' };
    expect(scanForPii(dirty).map((v) => v.kind)).toContain('phone');
    expect(scanForPii(clean)).toEqual([]);
    expect(scanForPii(dirty).map((v) => v.kind)).toContain('phone');
  });

  it('身份证 / 邮箱形状同样无跨调用状态', () => {
    const idPayload = { remark: `证件号 ${RAW_ID}` };
    const emailPayload = { remark: 'mail: someone@example.com' };
    for (let i = 0; i < 4; i += 1) {
      expect(scanForPii(idPayload).map((v) => v.kind)).toContain('id_card');
      expect(scanForPii(emailPayload).map((v) => v.kind)).toContain('email');
    }
  });

  it('反向对照：干净载荷重复扫描恒为空', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(scanForPii({ remark: '普通备注', data: { value: 42 } })).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 必证项 4：HTTP 200 且业务码未知 / 空 / 缺失 ⇒ 绝不 ok
// ---------------------------------------------------------------------------

describe('M-I11 (必证 4) HTTP 200 + 未知/空/缺失业务码绝不 ok', () => {
  it('未登记码 ⇒ unknown，不得报成功，须查原单', () => {
    const c = classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: 'brand_new_code' });
    expect(c.category).toBe('unknown');
    expect(c.requiresOrderQuery).toBe(true);
    expect(mayReportWireSuccess(c)).toBe(false);
  });

  it('空串码 ⇒ unknown', () => {
    const c = classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: '' });
    expect(c.category).toBe('unknown');
    expect(mayReportWireSuccess(c)).toBe(false);
  });

  it('码**缺失**（undefined）⇒ unknown', () => {
    const c = classifyWireError({ transport: 'response', httpStatus: 200 });
    expect(c.category).toBe('unknown');
    expect(c.requiresOrderQuery).toBe(true);
    expect(mayReportWireSuccess(c)).toBe(false);
  });

  it('码为 null ⇒ unknown', () => {
    const c = classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: null });
    expect(c.category).toBe('unknown');
    expect(mayReportWireSuccess(c)).toBe(false);
  });

  it('穷举：200 下只有登记码 "0" 才 ok，其余（含空/哨兵/未知）一律非 ok', () => {
    const codes: Array<string | null | undefined> = [undefined, null, '', 'ok', '0', '1003', '9999', 'x'];
    for (const code of codes) {
      const c = classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: code });
      expect(mayReportWireSuccess(c), `code=${String(code)}`).toBe(code === '0');
    }
  });

  it('反向对照：HTTP 200 + 登记码 0 ⇒ ok', () => {
    const c = classifyWireError({ transport: 'response', httpStatus: 200, bodyCode: '0' });
    expect(c.category).toBe('ok');
    expect(mayReportWireSuccess(c)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 提升后的其余能力仍可用（schema 变化分类 + 脱敏管道）
// ---------------------------------------------------------------------------

describe('M-I11 schema 变化分类与脱敏管道在生产出口可用', () => {
  it('v1→v1.1 兼容；v1→v2(breaking) 破坏；v1→v1 相同', () => {
    expect(classifySchemaChange(ENVELOPE_V1, ENVELOPE_V1_1).kind).toBe('compatible');
    expect(classifySchemaChange(ENVELOPE_V1, ENVELOPE_V2_BREAKING).kind).toBe('breaking');
    expect(classifySchemaChange(ENVELOPE_V1, ENVELOPE_V1_1).requiresMigration).toBe(false);
    expect(classifySchemaChange(ENVELOPE_V1, ENVELOPE_V1).kind).toBe('identical');
  });

  it('深度脱敏：敏感字段与自由文本中的 PII 均被替换且结果不含明文', () => {
    const raw = { code: 0, msg: 'ok', data: { phone: RAW_PHONE, remark: `call ${RAW_PHONE}` } };
    const { value, applied } = redactProtocolPayload(raw);
    const data = (value as { data: Record<string, unknown> }).data;
    expect(data.phone).toBe(redactedPlaceholder('phone', 1));
    expect(JSON.stringify(value)).not.toContain(RAW_PHONE);
    expect(JSON.stringify(applied)).not.toContain(RAW_PHONE);
    expect(scanForPii(value)).toEqual([]);
    expect(() => assertRedacted(value)).not.toThrow();
  });

  it('脱敏幂等 + 确定性', () => {
    const raw = { data: { phone: RAW_PHONE } };
    const once = redactProtocolPayload(raw).value;
    const twice = redactProtocolPayload(once);
    expect(JSON.stringify(twice.value)).toBe(JSON.stringify(once));
    expect(twice.applied).toEqual([]);
    expect(JSON.stringify(redactProtocolPayload(raw).value)).toBe(JSON.stringify(once));
  });

  it('isSafeSensitiveValue / PII_KINDS 形状未变', () => {
    expect(isSafeSensitiveValue('keyref:ds-1')).toBe(true);
    expect(isSafeSensitiveValue(RAW_PHONE)).toBe(false);
    expect(PII_KINDS).toContain('phone');
    expect(PII_KINDS).toContain('geo');
  });
});
