/**
 * K-I19 支持模块 —— 静态契约判别器（纯函数，可独立自证判别力）。
 *
 * ## 为什么是静态
 *
 * 本单元交付的原生类是 **Java，且本环境没有 Android SDK / Gradle wrapper**（见 KERNEL.md K02
 * 行与任务书），因此不可能在这里编译、更不能跑真机。能被结构化断言的是**源码轮廓**：
 * 类是否存在、TS 端口方法集是否有对应实现、TLS/SSE/取消/超时是否接线、明文密钥是否有机器判据、
 * 是否留了日志出口。它**不**声称任何运行期行为已通过；真机事实一律标「未验证」。
 *
 * ## 判别力自证
 *
 * `javaViolations()` 的每条规则都在测试里被**合成的坏实现**反向钉住：坏实现必须被抓、
 * 干净实现必须放行，否则扫描器就是空断言。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 仓库根（tests/mobile-kernel/K-I19 → 上溯三级）。 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** 被检的 Java 类（K-I19 独占写区）。 */
export const JAVA_REL = 'apps/android/app/src/main/java/com/potbot/kernel/model/ModelTransport.java';

/** TS 端口契约来源（只读）。 */
export const TS_TYPES_REL = 'apps/mobile-kernel/model/types.ts';

/** Java 身份串（与类常量 IDENTITY 同源）。 */
export const EXPECTED_IDENTITY = 'android.https.model.transport';

/** 预期明文密钥特征条数（与 K02 redact.ts 的 5 条同口径）。 */
export const EXPECTED_SECRET_SHAPE_COUNT = 5;

/** 读仓库相对路径的文本。 */
export function readRepoText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/**
 * 去掉 Java 注释（`//` 与块注释），用于"只看代码不看注释"的结构检查。
 *
 * 必要性：类的 Javadoc 会**描述**禁用词（如"本文件没有 System.out"），若按原文检查，
 * 文档反而把自己扫成违规；也要防止注释里的 `{@link #send(...)}` 让"方法存在"的空断言通过。
 * 本 Java 的字符串字面量里没有 `//` 或 `/*`，朴素剥离不会误伤。
 */
export function stripJavaComments(java: string): string {
  return java.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * TS 端口成员 → Java 侧应有的**实现痕迹**。
 *
 * `identity` 是只读属性，Java 侧用常量 + 取值器同时满足；`send` 是方法。
 * 未列出的成员会被判为「新增端口成员但没在 Java 侧落地」，测试报红而不是静默放过。
 */
export const PORT_MEMBER_SURFACES: Readonly<Record<string, readonly string[]>> = {
  identity: ['IDENTITY', 'identity()'],
  send: ['send('],
};

/** 抽取 `static final String NAME = "value";` 的字面量；缺失返回 null。 */
export function extractStringConstant(java: string, name: string): string | null {
  const re = new RegExp(`static\\s+final\\s+String\\s+${name}\\s*=\\s*"([^"]*)"\\s*;`);
  const m = re.exec(java);
  return m !== null && m[1] !== undefined ? m[1] : null;
}

/** 按声明顺序抽取全部 `SECRET_SHAPE_*` 字面量。 */
export function extractSecretShapes(java: string): readonly string[] {
  const out: string[] = [];
  const re = /static\s+final\s+String\s+SECRET_SHAPE_\d+\s*=\s*"([^"]*)"\s*;/g;
  for (const m of java.matchAll(re)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** 抽取 TS `export interface NAME { ... }` 的成员名（标识符后跟 `(` / `:` / `?`）。 */
export function extractInterfaceMembers(ts: string, name: string): readonly string[] {
  const re = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`);
  const m = re.exec(ts);
  if (m === null) return [];
  const open = m.index + m[0].length - 1; // 指向 '{'
  let depth = 0;
  let i = open;
  for (; i < ts.length; i += 1) {
    const c = ts[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = ts.slice(open + 1, i);
  const members = new Set<string>();
  const memberRe = /^[ \t]*(?:readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*[(:?]/gm;
  for (const mm of body.matchAll(memberRe)) {
    if (mm[1] !== undefined) members.add(mm[1]);
  }
  return [...members];
}

/**
 * 扫描 Java 源码，返回违规清单（空数组 = 通过）。
 *
 * 覆盖任务书的四件事 + 端口形状 + 明文密钥口径。纯函数，便于用合成坏实现自证判别力。
 */
export function javaViolations(java: string, portMembers: readonly string[]): readonly string[] {
  const violations: string[] = [];
  // 只在**去注释后的代码**上做结构检查：注释里的描述性文字不得满足（或触发）任何规则。
  const code = stripJavaComments(java);
  const need = (ok: boolean, msg: string): void => {
    if (!ok) violations.push(msg);
  };

  // 包与类形状
  need(/package\s+com\.potbot\.kernel\.model\s*;/.test(code), '缺少 package com.potbot.kernel.model;');
  need(
    /public\s+final\s+class\s+ModelTransport\b/.test(code),
    '缺少 public final class ModelTransport',
  );

  // TS 端口方法集
  for (const member of portMembers) {
    const surfaces = PORT_MEMBER_SURFACES[member];
    if (surfaces === undefined) {
      violations.push(`TS 端口新增成员 '${member}' 在 Java 侧没有落地映射（不许静默放过）`);
      continue;
    }
    for (const surface of surfaces) {
      need(code.includes(surface), `端口成员 '${member}'：缺少 Java 痕迹 '${surface}'`);
    }
  }

  // TLS
  need(code.includes('HttpsURLConnection'), '缺少 HttpsURLConnection（TLS）');
  need(
    code.includes('setInstanceFollowRedirects(false)'),
    '必须禁用重定向（否则凭据可能被转发到第三方主机）',
  );
  need(code.includes('setConnectTimeout('), '缺少 setConnectTimeout');
  need(code.includes('setReadTimeout('), '缺少 setReadTimeout');

  // 取消 + 超时
  need(/void\s+abort\s*\(/.test(code), '缺少 abort()');
  need(/isAborted\s*\(/.test(code), '缺少 isAborted()');
  need(code.includes('transport_aborted'), '缺少取消错误路径 transport_aborted');
  need(code.includes('transport_timeout'), '缺少超时错误路径 transport_timeout');

  // SSE 行解析
  need(/parseSseLine\s*\(/.test(code), '缺少 parseSseLine(');
  need(code.includes('"data:"'), '缺少 SSE data: 前缀');
  need(code.includes('"[DONE]"'), '缺少 SSE [DONE] 收束标记');

  // 明文密钥双重判据
  const shape = extractStringConstant(code, 'KEY_REF_PATTERN');
  need(shape !== null && shape.length > 0, '缺少 KEY_REF_PATTERN');
  const secretShapes = extractSecretShapes(code);
  need(
    secretShapes.length === EXPECTED_SECRET_SHAPE_COUNT,
    `SECRET_SHAPE_* 常量应为 ${EXPECTED_SECRET_SHAPE_COUNT} 条，实为 ${secretShapes.length}`,
  );
  need(/validateKeyRef\s*\(/.test(code), '缺少 validateKeyRef(');
  need(code.includes('invalid_key_ref'), '缺少 invalid_key_ref 拒因');
  need(code.includes('key_ref_contains_secret'), '缺少 key_ref_contains_secret 拒因');

  // 不接触明文密钥
  need(code.includes('auth.authorizationValue('), '凭据必须经 AuthHeaderProvider 解析');
  need(code.includes('setRequestProperty("Authorization"'), '缺少 Authorization 头接线');
  need(/authorization\s*=\s*null\s*;/.test(code), '凭据局部变量用毕必须置空');
  need(!/\bLog\.[a-z]/.test(code), '传输层不得有日志出口（Log.*）');
  need(!code.includes('System.out'), '传输层不得写标准输出');
  need(!code.includes('printStackTrace'), '传输层不得打印堆栈');

  return violations;
}

/** 用给定正则源码判定 keyRef 是否被接受（形状通过且内容不含明文密钥特征）。 */
export function keyRefAccepted(
  keyRef: string,
  keyRefShapeSrc: string,
  secretShapeSrcs: readonly string[],
): boolean {
  if (!new RegExp(keyRefShapeSrc).test(keyRef)) return false;
  return !secretShapeSrcs.some((src) => new RegExp(src).test(keyRef));
}

/** 用给定正则源码判定文本是否命中明文密钥特征。 */
export function isPlaintextSecret(text: string, secretShapeSrcs: readonly string[]): boolean {
  return secretShapeSrcs.some((src) => new RegExp(src).test(text));
}
