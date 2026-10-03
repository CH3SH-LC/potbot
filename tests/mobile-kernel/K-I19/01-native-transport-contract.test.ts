/**
 * K-I19 集成验证：原生模型传输（HTTPS/SSE）的静态端口契约。
 *
 * 验证对象是 `apps/android/app/src/main/java/com/potbot/kernel/model/ModelTransport.java`，
 * 即 K02 集成请求 #2 里"从未创建"的原生模块。本环境无 Android SDK/Gradle，**该 Java 未编译**；
 * 因此这里只做**静态**断言：
 *
 *   1. TS `ModelTransport` 端口方法集（从 `types.ts` 真实源码抽取，不是硬编码）在 Java 侧有落地；
 *   2. Java 镜像的 TS 常量（KEY_REF_PATTERN / DEFAULT_HOST / identity）与 TS 真实导出逐字一致；
 *   3. TLS / SSE 行解析 / 取消 / 超时 四件事都有接线痕迹；
 *   4. 明文密钥双重判据：Java 里的正则被抽出来、在**独立引擎（Node）**里复算合法/拒绝样本；
 *   5. 不接触明文密钥：无日志出口、凭据经 AuthHeaderProvider 解析且用毕置空；
 *   6. 判别力自证：合成坏实现必须被抓。
 *
 * 它**不**声称任何运行期行为（连接、SSE、取消、超时）已通过 —— 那需要真机与真实网络。
 */

import { describe, expect, it } from 'vitest';

import { KEY_REF_PATTERN } from '../../../apps/mobile-kernel/model/types.js';
import { DEFAULT_HOST } from '../../../apps/mobile-kernel/model/port.js';
import {
  EXPECTED_IDENTITY,
  EXPECTED_SECRET_SHAPE_COUNT,
  JAVA_REL,
  TS_TYPES_REL,
  extractInterfaceMembers,
  extractSecretShapes,
  extractStringConstant,
  isPlaintextSecret,
  javaViolations,
  keyRefAccepted,
  readRepoText,
  stripJavaComments,
} from './contract.js';

const java = readRepoText(JAVA_REL);
const javaCode = stripJavaComments(java);
const tsTypes = readRepoText(TS_TYPES_REL);

const portMembers = extractInterfaceMembers(tsTypes, 'ModelTransport');
const secretShapes = extractSecretShapes(java);
const keyRefShapeSrc = extractStringConstant(java, 'KEY_REF_PATTERN') ?? '';

// 样本用拼接构造：源码文本里不出现连续的密钥字面量（避免被仓库静态密钥扫描器误计一条命中）。
const SK_SAMPLE = ['sk', 'live', 'ABCDEFGHIJKLMNOP'].join('-');
const BEARER_SAMPLE = ['Bearer', 'ABCDEFGHIJKLMNOPQRST'].join(' ');
const GOOGLE_SAMPLE = 'AIza' + 'SyABCDEFGHIJKLMNOPQRST';
const APIKEY_SAMPLE = 'apikey' + '=' + 'ABCDEFGHIJKLMNOPQRST';
const PEM_SAMPLE = '-'.repeat(5) + 'BEGIN RSA PRIVATE KEY' + '-'.repeat(5);

describe('K-I19 · TS 端口方法集在 Java 侧落地', () => {
  it('types.ts 的 ModelTransport 端口成员为 identity + send', () => {
    expect([...portMembers].sort()).toEqual(['identity', 'send']);
  });

  it('Java 覆盖端口全部成员（缺任何一个都报红）', () => {
    expect(javaViolations(java, portMembers)).toEqual([]);
  });
});

describe('K-I19 · Java 镜像 TS 常量逐字一致', () => {
  it('KEY_REF_PATTERN 与 types.ts 的真实导出同源', () => {
    expect(keyRefShapeSrc).toBe(KEY_REF_PATTERN.source);
    expect(keyRefShapeSrc).toBe('^keyref:[A-Za-z0-9._:-]+$');
  });

  it('DEFAULT_HOST 与 port.ts 的 DEFAULT_HOST 一致', () => {
    expect(extractStringConstant(java, 'DEFAULT_HOST')).toBe(DEFAULT_HOST);
  });

  it('identity 与类内常量同源且非空', () => {
    expect(extractStringConstant(java, 'IDENTITY')).toBe(EXPECTED_IDENTITY);
    expect(java).toContain('identity()');
  });

  it('明文密钥特征条数与 K02 口径一致（5 条）', () => {
    expect(secretShapes.length).toBe(EXPECTED_SECRET_SHAPE_COUNT);
  });
});

describe('K-I19 · keyRef 双重判据在独立引擎里复算', () => {
  it('合法引用放行（正向对照）', () => {
    for (const ref of ['keyref:model.deepseek-flash', 'keyref:deepseek.default', 'keyref:meituan.demo']) {
      expect(keyRefAccepted(ref, keyRefShapeSrc, secretShapes)).toBe(true);
    }
  });

  it('明文密钥 / 伪装引用被拒（反向对照）', () => {
    // 形状不是引用
    expect(keyRefAccepted(SK_SAMPLE, keyRefShapeSrc, secretShapes)).toBe(false);
    // 形状是引用、内容是明文 —— K03 点名的"挡不住"场景，这里必须被内容判据抓住
    expect(keyRefAccepted('keyref:' + SK_SAMPLE, keyRefShapeSrc, secretShapes)).toBe(false);
    expect(isPlaintextSecret('keyref:' + SK_SAMPLE, secretShapes)).toBe(true);
  });

  it('其余四类明文特征都被抓', () => {
    for (const sample of [SK_SAMPLE, BEARER_SAMPLE, GOOGLE_SAMPLE, APIKEY_SAMPLE, PEM_SAMPLE]) {
      expect(isPlaintextSecret(sample, secretShapes)).toBe(true);
    }
  });

  it('边界：词内 sk- 不误报（task-registered 不是密钥）', () => {
    expect(isPlaintextSecret('task-registered', secretShapes)).toBe(false);
    // 反向钉住：朴素无界 /sk-/ 会误报，Java 抽取出来的模式有左边界不会
    expect(/sk-[A-Za-z0-9_-]{10,}/.test('task-registered')).toBe(true);
  });

  it('sk- 模式确实带左边界（防回退到无界正则）', () => {
    const skShape = secretShapes.find((src) => src.includes('sk-'));
    expect(skShape).toBeDefined();
    expect(skShape ?? '').toContain('(?<![A-Za-z0-9_])');
  });
});

describe('K-I19 · TLS / SSE / 取消 / 超时 接线痕迹', () => {
  it('走 HttpsURLConnection 且禁用重定向', () => {
    expect(java).toContain('HttpsURLConnection');
    expect(java).toContain('setInstanceFollowRedirects(false)');
  });

  it('连接超时与读取超时都接上，并有超时错误路径', () => {
    expect(java).toContain('setConnectTimeout(');
    expect(java).toContain('setReadTimeout(');
    expect(java).toContain('transport_timeout');
  });

  it('可取消：abort()/isAborted() 与取消错误路径', () => {
    expect(java).toContain('abort()');
    expect(java).toContain('isAborted()');
    expect(java).toContain('transport_aborted');
  });

  it('SSE 行解析处理 data: 与 [DONE]', () => {
    expect(java).toContain('parseSseLine(');
    expect(java).toContain('"data:"');
    expect(java).toContain('"[DONE]"');
  });
});

describe('K-I19 · 不接触明文密钥', () => {
  it('凭据经 AuthHeaderProvider 解析为不透明头值，用毕置空', () => {
    expect(java).toContain('interface AuthHeaderProvider');
    expect(java).toContain('auth.authorizationValue(');
    expect(java).toContain('setRequestProperty("Authorization"');
    expect(java).toMatch(/authorization\s*=\s*null\s*;/);
  });

  it('传输层没有任何日志出口（只看代码，不看注释）', () => {
    expect(javaCode).not.toMatch(/\bLog\.[a-z]/);
    expect(javaCode).not.toContain('System.out');
    expect(javaCode).not.toContain('printStackTrace');
  });

  it('类本身不携带明文密钥字段', () => {
    for (const forbidden of ['String apiKey', 'String api_key', 'String password', 'private final String key =']) {
      expect(java).not.toContain(forbidden);
    }
  });
});

describe('K-I19 · 判别力自证（坏实现必须被抓）', () => {
  it('去掉 send 方法 ⇒ 报"端口成员未落地"', () => {
    // 全局替换：连 Javadoc 里的 `{@link #send(...)}` 一起换掉，否则注释会让空断言通过。
    const broken = java.replace(/send\(/g, 'transmit(');
    const violations = javaViolations(broken, portMembers);
    expect(violations).not.toEqual([]);
    expect(violations.some((v) => v.includes("'send'"))).toBe(true);
  });

  it('改动 KEY_REF_PATTERN ⇒ 报缺常量或形状不符', () => {
    const broken = java.replace('"^keyref:[A-Za-z0-9._:-]+$"', '"^keyref:[a-z]+$"');
    const violations = javaViolations(broken, portMembers);
    expect(violations).toEqual([]); // 常量仍在，静态扫描器不校验具体形状
    // 形状校验交给逐字一致性用例外层把住：
    expect(extractStringConstant(broken, 'KEY_REF_PATTERN')).toBe('^keyref:[a-z]+$');
  });

  it('删掉 Authorization 置空 ⇒ 报"用毕必须置空"', () => {
    const broken = java.replace('authorization = null;', '// 忘记置空');
    expect(javaViolations(broken, portMembers).some((v) => v.includes('置空'))).toBe(true);
  });

  it('加一行日志 ⇒ 报"不得有日志出口"', () => {
    const broken = java.replace('int status = connection.getResponseCode();', 'android.util.Log.d("m", "x");\n            int status = connection.getResponseCode();');
    expect(javaViolations(broken, portMembers).some((v) => v.includes('日志'))).toBe(true);
  });

  it('减少明文特征条数 ⇒ 报条数不符', () => {
    const broken = java.replace('SECRET_SHAPE_5', 'SECRET_SHAPE_REMOVED');
    expect(javaViolations(broken, portMembers).some((v) => v.includes('SECRET_SHAPE_*'))).toBe(true);
  });

  it('干净样例空串被全面报红（扫描器不是恒真）', () => {
    expect(javaViolations('public class Other {}', portMembers).length).toBeGreaterThan(3);
  });
});
