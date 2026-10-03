/**
 * M-R01 脱敏管道与 PII 扫描器：真实断言（非自证）。
 *
 * 用例分三层：
 * 1. 遮罩函数；
 * 2. `redactProtocolPayload` 的**确定性**与"不落明文"；
 * 3. `scanForPii` / `assertRedacted` 的门禁行为——尤其是负例必须报错。
 */

import { describe, expect, it } from 'vitest';

import {
  assertRedacted,
  isSafeSensitiveValue,
  maskAddress,
  maskContactName,
  maskEmail,
  maskIdCard,
  maskPhone,
  redactedPlaceholder,
  redactProtocolPayload,
  scanForPii,
} from './redaction.js';

const RAW_PHONE = '13912345678';
const RAW_ID = '110101199003071234';
const RAW_EMAIL = 'someone@example.com';

describe('M-R01 遮罩函数', () => {
  it('maskPhone 保留前 3 后 4；短号只留末 2；空串返回空串', () => {
    expect(maskPhone(RAW_PHONE)).toBe('139****5678');
    expect(maskPhone('12345')).toBe('***45');
    expect(maskPhone('1234')).toBe('****');
    expect(maskPhone('')).toBe('');
  });

  it('maskContactName / maskEmail / maskIdCard / maskAddress 保留最少可读位', () => {
    expect(maskContactName('张三')).toBe('张*');
    expect(maskContactName('甲')).toBe('*');
    expect(maskEmail(RAW_EMAIL)).toBe('s******@example.com');
    expect(maskEmail('a@b.com')).toBe('a@b.com');
    expect(maskIdCard(RAW_ID)).toBe(`110${'*'.repeat(14)}4`);
    expect(maskAddress('上海市浦东新区')).toBe('上海*****');
    expect(maskAddress('')).toBe('');
  });
});

describe('M-R01 isSafeSensitiveValue：占位符/引用/合成 ID 通过，其余不通过', () => {
  it('占位符、keyref、acct、合成 ref 通过', () => {
    expect(isSafeSensitiveValue(redactedPlaceholder('phone', 1))).toBe(true);
    expect(isSafeSensitiveValue('keyref:ds-1')).toBe(true);
    expect(isSafeSensitiveValue('acct:meituan:7788')).toBe(true);
    expect(isSafeSensitiveValue('poi-cbd-001')).toBe(true);
    expect(isSafeSensitiveValue('')).toBe(true);
  });

  it('裸手机号 / 裸身份证 / 含长数字的裸字符串不通过', () => {
    expect(isSafeSensitiveValue(RAW_PHONE)).toBe(false);
    expect(isSafeSensitiveValue(RAW_ID)).toBe(false);
    expect(isSafeSensitiveValue('poi-123456789')).toBe(false);
  });
});

describe('M-R01 redactProtocolPayload：深度脱敏且确定性', () => {
  const rawPayload = {
    code: 0,
    msg: 'ok',
    data: {
      phone: RAW_PHONE,
      contactName: '李四',
      address: '上海市浦东新区某路 1 号',
      latitude: 31.2304,
      remark: `联系我 ${RAW_PHONE}，或发 ${RAW_EMAIL}`,
    },
  };

  it('敏感字段与自由文本中的 PII 都被替换成占位符', () => {
    const { value, applied } = redactProtocolPayload(rawPayload);
    const data = (value as { data: Record<string, unknown> }).data;
    expect(data.phone).toBe(redactedPlaceholder('phone', 1));
    expect(data.contactName).toBe(redactedPlaceholder('contact_name', 1));
    expect(data.address).toBe(redactedPlaceholder('address', 1));
    expect(data.latitude).toBe(redactedPlaceholder('geo', 1));
    expect(String(data.remark)).not.toContain(RAW_PHONE);
    expect(String(data.remark)).not.toContain(RAW_EMAIL);
    // 自由文本中 phone 已被字段名规则占用 #1，故此处为 #2。
    expect(String(data.remark)).toContain(redactedPlaceholder('phone', 2));
    expect(applied.length).toBeGreaterThanOrEqual(5);
  });

  it('脱敏结果里不含任何明文 PII；applied 记录也不含原值', () => {
    const { value, applied } = redactProtocolPayload(rawPayload);
    expect(JSON.stringify(value)).not.toContain(RAW_PHONE);
    expect(JSON.stringify(value)).not.toContain(RAW_EMAIL);
    // applied 只含 path/kind —— 绝不把明文写进结果/证据。
    expect(JSON.stringify(applied)).not.toContain(RAW_PHONE);
    expect(Object.keys(applied[0] ?? {}).sort()).toEqual(['kind', 'path']);
  });

  it('确定性：同输入两次脱敏结果逐字节相同', () => {
    const a = redactProtocolPayload(rawPayload);
    const b = redactProtocolPayload(rawPayload);
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
    expect(JSON.stringify(a.applied)).toBe(JSON.stringify(b.applied));
  });

  it('已是占位符的字段不再被改动（幂等）', () => {
    const once = redactProtocolPayload(rawPayload).value;
    const twice = redactProtocolPayload(once);
    expect(JSON.stringify(twice.value)).toBe(JSON.stringify(once));
    expect(twice.applied).toEqual([]);
  });

  it('patternOnly 关闭字段名规则：有形状的 PII 仍被替换，无形状的（姓名/地址）会漏过', () => {
    const { value } = redactProtocolPayload(rawPayload, { patternOnly: true });
    const data = (value as { data: Record<string, unknown> }).data;
    // 手机号有可识别形状 ⇒ 仍被字符串模式替换。
    expect(String(data.phone)).not.toContain(RAW_PHONE);
    expect(String(data.remark)).not.toContain(RAW_PHONE);
    // 姓名/地址无固定形状，字段名规则关闭后**漏过**——这正是必须保留字段名规则的理由。
    expect(data.contactName).toBe('李四');
    expect(data.address).toBe('上海市浦东新区某路 1 号');
  });
});

describe('M-R01 scanForPii / assertRedacted 门禁', () => {
  it('干净载荷扫描为空', () => {
    const clean = redactProtocolPayload({ data: { phone: RAW_PHONE, remark: RAW_EMAIL } }).value;
    expect(scanForPii(clean)).toEqual([]);
  });

  it('裸手机号在敏感字段 ⇒ 违规；藏在自由文本里也 ⇒ 违规', () => {
    const byField = scanForPii({ data: { phone: RAW_PHONE } });
    expect(byField.map((v) => v.kind)).toContain('phone');
    const byPattern = scanForPii({ data: { remark: `联系 ${RAW_PHONE}` } });
    expect(byPattern.map((v) => v.kind)).toContain('phone');
  });

  it('身份证 / 邮箱 / 裸坐标都被识别', () => {
    expect(scanForPii({ idCard: RAW_ID }).map((v) => v.kind)).toContain('id_card');
    expect(scanForPii({ email: RAW_EMAIL }).map((v) => v.kind)).toContain('email');
    expect(scanForPii({ latitude: 31.2304 }).map((v) => v.kind)).toContain('geo');
  });

  it('assertRedacted 抛错且错误信息不含明文', () => {
    let thrown: unknown = null;
    try {
      assertRedacted({ data: { phone: RAW_PHONE } }, 'unit-payload');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('MR01_PII_LEAK');
    expect(message).toContain('unit-payload');
    expect(message).not.toContain(RAW_PHONE);
  });

  it('assertRedacted 对干净载荷不抛错', () => {
    const clean = redactProtocolPayload({ data: { phone: RAW_PHONE } }).value;
    expect(() => assertRedacted(clean)).not.toThrow();
  });
});
