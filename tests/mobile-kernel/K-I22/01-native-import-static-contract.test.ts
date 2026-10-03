/**
 * K-I22 独立验证：**原生一次性密钥导入通道 + Keystore 端口的静态合同**。
 *
 * 本单元是 K03 findings 集成请求 #4 的落地："实现 K03 `ImportSourceProvider` 期望的
 * 一次性桌面→设备导入（原生 URI 授权 → Keystore → 撤销临时 URI → 删中间文件）"。
 *
 * 判据分两层：
 *
 *  A. **静态合同**（读 `apps/android/app/src/main/java/com/potbot/kernel/security/` 下的真实
 *     Java 源码）：
 *     1. 原生安全包里**没有返回明文的方法**——任何 `byte[]` 返回类型的方法必须是 `private`，
 *        且不得存在非私有的 `decrypt/open/reveal/...` 名；
 *     2. **读完即焚**语义在场：句柄带 `AtomicBoolean consumed`，`compareAndSet(false,true)` 守卫，
 *        第二次消费返回 `secret_source_exhausted`；
 *     3. **落零**语义在场：读出的明文字节在 `finally` 里 `Arrays.fill(..., (byte) 0)`；
 *     4. **撤销临时 URI** + **删中间文件**在场；且不打印（无 `Log.`/`System.out`/`printStackTrace`）。
 *     扫描器自带**正/反样例对照**——正则若写坏（静默零命中）会被反向样例咬住。
 *
 *  B. **动态行为**（导入 K03 真实模块）：`createOneShotImportSource` 第二次 `consume` 抛
 *     `secret_source_exhausted`；`createImportSourceProvider` 未登记 `sourceRef` 抛
 *     `secret_source_unknown` 且同 ref 复用同实例；`zeroize` 就地清零。
 *
 * 全程无网络、无真实密钥、无 sleep。用的是 K03 的**真实导出**，不是读源码文本猜口径。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SECURITY_ERROR_CODES,
  SecurityError,
  createImportSourceProvider,
  createOneShotImportSource,
  isSecurityError,
  zeroize,
} from '../../../apps/mobile-kernel/security/index.js';

// ---------------------------------------------------------------------------
// 源码定位与扫描器（含正/反样例对照，防"正则写坏 ⇒ 静默绿灯"）
// ---------------------------------------------------------------------------

const SECURITY_JAVA_DIR = '../../../apps/android/app/src/main/java/com/potbot/kernel/security/';
const KEYSTORE_SRC = readFileSync(new URL(`${SECURITY_JAVA_DIR}AndroidKeyStorePort.java`, import.meta.url), 'utf8');
const IMPORT_SRC = readFileSync(new URL(`${SECURITY_JAVA_DIR}OneShotKeyImportProvider.java`, import.meta.url), 'utf8');

/** 去掉块注释与行注释（先块后行，避免注释里的 `//` 混进代码视图）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export interface JavaMethodDecl {
  readonly modifiers: string;
  readonly returnType: string;
  readonly name: string;
}

/**
 * 从 Java 源码里抽出**方法声明**（有返回类型的那种；构造器无返回类型不匹配）。
 *
 * 做法：去注释 → 压平空白 → 按 `;{}` 切分候选片段 → 用"修饰符* 返回类型 名("匹配。
 * 跳过以 `return/new/throw/...` 开头的语句片段，减少调用表达式误判。
 */
export function methodDeclarations(rawSrc: string): JavaMethodDecl[] {
  const flat = stripComments(rawSrc).replace(/\s+/g, ' ');
  const segments = flat.split(/(?<=[;{}])/);
  const re =
    /^\s*((?:(?:public|protected|private|static|final|synchronized|abstract|native|strictfp|@[\w.]+(?:\([^)]*\))?)\s+)*)([A-Za-z_$][\w$]*(?:\s*<[^;{}()]*>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*\(/;
  const out: JavaMethodDecl[] = [];
  for (const seg of segments) {
    const t = seg.trim();
    if (/^(return|new|throw|else|if|while|for|switch|case|catch|try|finally|do|import|package)\b/.test(t)) continue;
    const m = re.exec(seg);
    if (m === null) continue;
    const [, modifiers, returnType, name] = m;
    if (modifiers === undefined || returnType === undefined || name === undefined) continue;
    out.push({ modifiers: modifiers.trim(), returnType: returnType.trim(), name });
  }
  return out;
}

const isPrivate = (d: JavaMethodDecl): boolean => /\bprivate\b/.test(d.modifiers);
const isByteArrayReturn = (d: JavaMethodDecl): boolean => d.returnType.replace(/\s+/g, '') === 'byte[]';

/** 契约里点名的"错误设计"方法名（明文出口 / 把原文交回 JS）。 */
const FORBIDDEN_SURFACE_NAMES = /^(decrypt|reveal|revealSecret|exportSecret|exportKey|getSecret|readSecret|plainText|plaintext|toPlaintext|openForRequest)$/i;

// ---------------------------------------------------------------------------
// A① 扫描器自证：正/反样例对照
// ---------------------------------------------------------------------------

describe('K-I22 A① 扫描器自证（防正则静默失效）', () => {
  const BAD = [
    'package x;',
    'public final class Bad {',
    '  public byte[] reveal() { return new byte[0]; }',
    '  byte[] packageVisible() { return null; }',
    '  private byte[] ok() { return null; }',
    '  private static byte[] readAll(java.io.File f) { return new byte[0]; }',
    '  public String decrypt(String cipher) { return cipher; }',
    '}',
  ].join('\n');

  it('正向：抓到非私有 byte[] 返回与禁名方法', () => {
    const decls = methodDeclarations(BAD);
    const bad = decls.filter((d) => isByteArrayReturn(d) && !isPrivate(d)).map((d) => d.name);
    expect(bad.sort()).toEqual(['packageVisible', 'reveal']);
    const forbidden = decls
      .filter((d) => !isPrivate(d) && FORBIDDEN_SURFACE_NAMES.test(d.name))
      .map((d) => d.name)
      .sort();
    expect(forbidden).toEqual(['decrypt', 'reveal']);
  });

  it('反向：私有 byte[] 内建（readAll）不算违规', () => {
    const decls = methodDeclarations(BAD);
    const readAll = decls.find((d) => d.name === 'readAll');
    expect(readAll).toBeDefined();
    expect(isByteArrayReturn(readAll as JavaMethodDecl)).toBe(true);
    expect(isPrivate(readAll as JavaMethodDecl)).toBe(true);
  });

  it('扫描器不是"永远匹配/永远不匹配"：干净样例零违规', () => {
    const clean = 'class C { public int add(int a, int b) { return a + b; } private byte[] helper() { return null; } }';
    const decls = methodDeclarations(clean);
    expect(decls.filter((d) => isByteArrayReturn(d) && !isPrivate(d))).toEqual([]);
    expect(decls.filter((d) => FORBIDDEN_SURFACE_NAMES.test(d.name))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A② 端口：没有返回明文的方法
// ---------------------------------------------------------------------------

describe('K-I22 A② 原生安全包：无明文出口', () => {
  it('任一 Java 文件里都没有**非私有**的 byte[] 返回方法', () => {
    const offenders = [
      ...methodDeclarations(KEYSTORE_SRC).map((d) => ({ file: 'AndroidKeyStorePort', d })),
      ...methodDeclarations(IMPORT_SRC).map((d) => ({ file: 'OneShotKeyImportProvider', d })),
    ]
      .filter(({ d }) => isByteArrayReturn(d) && !isPrivate(d))
      .map(({ file, d }) => `${file}.${d.name} (${d.modifiers})`);
    expect(offenders).toEqual([]);
  });

  it('没有非私有的禁名方法（decrypt/reveal/openForRequest/… 只能作内部私有助手）', () => {
    const offenders = [
      ...methodDeclarations(KEYSTORE_SRC),
      ...methodDeclarations(IMPORT_SRC),
    ]
      .filter((d) => !isPrivate(d) && FORBIDDEN_SURFACE_NAMES.test(d.name))
      .map((d) => `${d.modifiers} ${d.name}`);
    expect(offenders).toEqual([]);
  });

  it('导入结果类型只带元数据，不带字节字段（无 byte[] 域）', () => {
    const code = stripComments(IMPORT_SRC);
    // 出口类只暴露 String/int/boolean；不出现 byte[] 字段或数组字段。
    for (const field of ['sourceRef', 'keyRef', 'revision', 'byteLength', 'errorCode']) {
      expect(code).toContain(field);
    }
    // ImportResult 内不得出现 "byte[] " 字段声明（方法内的局部变量另有其名 secret/staged）。
    const resultClass = code.slice(code.indexOf('class ImportResult'));
    expect(/byte\s*\[\s*\]\s+\w+\s*;/.test(resultClass)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A③ 读完即焚 + 落零 + 撤销 + 删中间文件：语义在场
// ---------------------------------------------------------------------------

describe('K-I22 A③ 一次性导入通道的原生语义', () => {
  const code = stripComments(IMPORT_SRC);

  it('句柄带一次性标记，CAS 守卫在场，第二次消费返回 secret_source_exhausted', () => {
    expect(/AtomicBoolean\s+consumed/.test(code)).toBe(true);
    expect(/consumed\.compareAndSet\(\s*false\s*,\s*true\s*\)/.test(code)).toBe(true);
    expect(/ERROR_ALREADY_CONSUMED\s*=\s*"secret_source_exhausted"/.test(code)).toBe(true);
  });

  it('落零在场：明文字节在 finally 里被 Arrays.fill(..., (byte) 0)', () => {
    expect(/Arrays\.fill\(\s*secret\s*,\s*\(byte\)\s*0\s*\)/.test(code)).toBe(true);
    const finallyAt = code.indexOf('} finally {');
    const fillAt = code.indexOf('Arrays.fill');
    expect(finallyAt).toBeGreaterThan(-1);
    expect(fillAt).toBeGreaterThan(finallyAt); // fill 在 finally 块内
  });

  it('撤销临时 URI 授权在场（用 revokeUriPermission；不 takePersistable）', () => {
    expect(code.includes('revokeUriPermission(')).toBe(true);
    expect(code.includes('takePersistableUriPermission')).toBe(false);
  });

  it('删除中间文件在场（staged 的 .delete()，且与落零同在 finally）', () => {
    expect(/staged\.delete\(\)/.test(code)).toBe(true);
    const finallyAt = code.indexOf('} finally {');
    expect(code.indexOf('staged.delete()')).toBeGreaterThan(finallyAt);
  });

  it('不打印：无 Log./System.out/printStackTrace（注释里的提及已被去注释剔除）', () => {
    expect(/Log\./.test(code)).toBe(false);
    expect(/System\.out/.test(code)).toBe(false);
    expect(/printStackTrace/.test(code)).toBe(false);
  });

  it('失败路径也焚毁 + 清场：finally 是无条件执行块，不依赖 try 成功', () => {
    // finally 出现在 consumeAndSeal 内；里面同时含落零、删文件、撤销、移除句柄。
    const method = code.slice(code.indexOf('consumeAndSeal'), code.indexOf('private StageResult stageToPrivateFile'));
    expect(method.includes('} finally {')).toBe(true);
    for (const token of ['Arrays.fill', 'staged.delete()', 'revokeGrant(', 'channels.remove(']) {
      expect(method.includes(token)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// A④ 原生码与 K03 词表对齐（共享码逐字相同；原生独有码显式不重叠）
// ---------------------------------------------------------------------------

describe('K-I22 A④ 原生错误码 ↔ K03 SECURITY_ERROR_CODES', () => {
  const codes = new Map<string, string>();
  const re = /public static final String (\w+) = "([^"]+)";/g;
  let m: RegExpExecArray | null;
  const code = stripComments(IMPORT_SRC);
  while ((m = re.exec(code)) !== null) {
    const [, name, value] = m;
    if (name === undefined || value === undefined) continue;
    codes.set(name, value);
  }

  const SHARED = [
    'ERROR_SOURCE_UNKNOWN',
    'ERROR_ALREADY_CONSUMED',
    'ERROR_SOURCE_EMPTY',
    'ERROR_NOT_PROVISIONED',
    'ERROR_KEYSTORE_UNAVAILABLE',
    'ERROR_BACKUP_NOT_EXCLUDED',
    'ERROR_SEAL_FAILED',
  ];
  const NATIVE_ONLY = ['ERROR_READ_FAILED', 'ERROR_TOO_LARGE'];

  it('共享常量逐个等于 K03 词表里的码', () => {
    for (const name of SHARED) {
      const value = codes.get(name);
      expect(value, `${name} 未在 OneShotKeyImportProvider.java 中声明`).toBeDefined();
      expect(SECURITY_ERROR_CODES as readonly string[]).toContain(value as string);
    }
  });

  it('原生独有码不在 K03 词表里（须由桥接层显式映射，不得冒充已登记的域码）', () => {
    for (const name of NATIVE_ONLY) {
      const value = codes.get(name);
      expect(value, `${name} 未声明`).toBeDefined();
      expect(SECURITY_ERROR_CODES as readonly string[]).not.toContain(value as string);
    }
  });

  it('含明文风险的错误信息不回显：错误只是错误码，不拼 URI / 内容', () => {
    // ImportResult.failed 的调用点只传常量码，不传 uri.toString()/异常 message。
    for (const bad of ['uri.toString()', 'error.getMessage()', 'error.toString()']) {
      expect(stripComments(IMPORT_SRC).includes(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// B 动态行为：K03 真实模块的读完即焚 / 落零 / 未知通道
// ---------------------------------------------------------------------------

const EIGHT = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

function codeOf(thunk: () => unknown): string {
  try {
    thunk();
    return '';
  } catch (e) {
    return isSecurityError(e) ? e.code : `not-security-error:${String(e)}`;
  }
}

describe('K-I22 B K03 通道运行时语义（真实导出）', () => {
  it('createOneShotImportSource：第一次 consume 返回同一实例，第二次抛 secret_source_exhausted', () => {
    const src = createOneShotImportSource('import:test', () => EIGHT);
    expect(src.sourceRef).toBe('import:test');
    expect(src.consume()).toBe(EIGHT); // 同一实例 ⇒ zeroize 可被观察
    expect(codeOf(() => src.consume())).toBe('secret_source_exhausted');
  });

  it('通道出口只有 sourceRef + consume —— 没有别的明文出口', () => {
    const src = createOneShotImportSource('import:test', () => EIGHT);
    expect(Object.keys(src).sort()).toEqual(['consume', 'sourceRef']);
  });

  it('zeroize：就地清零且返回同一实例', () => {
    const z = Uint8Array.from([9, 9, 9]);
    expect(zeroize(z)).toBe(z);
    expect(Array.from(z)).toEqual([0, 0, 0]);
  });

  it('createImportSourceProvider：未登记 ref 抛 secret_source_unknown；同 ref 复用同实例并共享焚毁', () => {
    const provider = createImportSourceProvider({ 'import:known': () => EIGHT });
    expect(codeOf(() => provider('import:nope'))).toBe('secret_source_unknown');
    const a = provider('import:known');
    const b = provider('import:known');
    expect(a).toBe(b);
    a.consume();
    expect(codeOf(() => b.consume())).toBe('secret_source_exhausted');
  });

  it('SecurityError 带可机读 code（bridge 侧据此映射到原生码）', () => {
    const e = new SecurityError('secret_source_exhausted', 'done');
    expect(e.code).toBe('secret_source_exhausted');
    expect(isSecurityError(e)).toBe(true);
  });
});
