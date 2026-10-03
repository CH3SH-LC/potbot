/**
 * K-I20 静态判别器 —— 原生 `FileSystemPort` 与 TS 端口的**契约对齐**检查。
 *
 * 为什么是静态：本包**不跑 Gradle、不装 APK、不连真机**（并发六线共享一台机器，禁构建）。
 * 安卓 `android.system.Os` / `ContentResolver` 在 Node 里都跑不了。能被结构化断言的，
 * 是**源码结构**：Java 端口方法集是否与 TS `FileSystemPort` 逐一对齐，实现类的
 * `rename` 是否真的走 POSIX `rename(2)`（原子替换），`writeFile` 是否走 tmp+rename。
 *
 * 它**不**声称任何运行期行为已通过；真机事实一律标「未验证（需真机）」。
 *
 * 判别力自证纪律（沿用本仓库既有做法）：扫描器是**纯函数**，测试拿**真实文件文本**
 * 做变异（删掉 `Os.rename`、删掉 tmp 后缀）后必须翻转结论；否则扫描器就是空断言。
 */

import { join } from 'node:path';

/** 仓库根（tests/mobile-kernel/K-I20 → 上溯三级）。 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** TS 端口契约（唯一事实源）。 */
export const PORT_SOURCE = 'apps/mobile-kernel/storage/fs-port.ts';
/** 原生端口接口（Java 对照）。 */
export const JAVA_INTERFACE = 'apps/android/app/src/main/java/com/potbot/kernel/storage/FileSystemPort.java';
/** 原生端口实现（应用私有目录）。 */
export const JAVA_IMPL = 'apps/android/app/src/main/java/com/potbot/kernel/storage/AndroidFileSystemPort.java';

/** TS `FileSystemPort` 的**钉死方法集**（8 个；改动须同步 Java 接口与实现）。 */
export const EXPECTED_PORT_METHODS: readonly string[] = [
  'ensureDir',
  'exists',
  'listDirs',
  'listFiles',
  'readFile',
  'removeFile',
  'rename',
  'writeFile',
];

/** 去掉 TS 注释（行注释与块注释两种）。 */
export function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 去掉 Java 注释（行注释与块注释两种）。 */
export function stripJavaComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * 从 `openIndex` 处的开括号起，取配对括号内的**内部文本**（跳过字符串与字符字面量、
 * 两种注释）。找不到配对返回 `null`。
 */
export function sliceBalanced(
  code: string,
  openIndex: number,
  open: string,
  close: string,
): string | null {
  let depth = 0;
  let i = openIndex;
  while (i < code.length) {
    const c = code.charAt(i);
    const next = code.charAt(i + 1);
    if (c === '/' && next === '/') {
      while (i < code.length && code.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code.charAt(i) === '*' && code.charAt(i + 1) === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < code.length && code.charAt(i) !== quote) {
        if (code.charAt(i) === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
    i += 1;
  }
  return null;
}

/** 取 `interface <name> { … }` 的**已去注释**内部文本；找不到返回 `null`。 */
export function extractInterfaceBody(source: string, name: string): string | null {
  const code = stripJavaComments(stripTsComments(source));
  const re = new RegExp(`interface\\s+${name}\\b[^{]*\\{`);
  const m = re.exec(code);
  if (m === null) return null;
  const braceIndex = m.index + m[0].length - 1;
  return sliceBalanced(code, braceIndex, '{', '}');
}

/**
 * 抽 TS/Java 接口的方法名（形如 `name(` 的成员），返回**去重前**的原始顺序列表。
 * 对 TS 与 Java 接口都适用（两者括号前都是裸标识符）。
 */
export function extractInterfaceMethodList(source: string, name: string): readonly string[] {
  const body = extractInterfaceBody(source, name);
  if (body === null) return [];
  const out: string[] = [];
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** 排序去重的接口方法集。 */
export function interfaceMethodSet(source: string, name: string): readonly string[] {
  return [...new Set(extractInterfaceMethodList(source, name))].sort();
}

/**
 * 抽实现类里 `@Override public … name(` 的方法名集合 —— 只取**重写端口**的方法，
 * 不把方法体里的普通调用误当成声明。
 */
export function overriddenMethodSet(javaSource: string): readonly string[] {
  const code = stripJavaComments(javaSource);
  const out = new Set<string>();
  for (const m of code.matchAll(/@Override\s+public\s+[^;{]*?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return [...out].sort();
}

/** `rename` 是否走 POSIX `rename(2)`（`Os.rename` 或 `ATOMIC_MOVE`）——原子替换的手段。 */
export function hasPosixAtomicRename(javaSource: string): boolean {
  const code = stripJavaComments(javaSource);
  return /Os\.rename\s*\(/.test(code) || /\bATOMIC_MOVE\b/.test(code);
}

/**
 * 是否具备 tmp+rename 原子落盘：既要用临时文件名标记（`TMP_SUFFIX` 或字面 `.tmp`），
 * 又要真的把该临时文件 rename 到目标。
 */
export function hasTmpRenameWrite(javaSource: string): boolean {
  const code = stripJavaComments(javaSource);
  const hasTmpMarker = /TMP_SUFFIX|\.tmp\b/.test(code);
  const renamesTmp = /\w*rename\s*\(\s*\w*[Tt]mp\w*\s*,/i.test(code);
  return hasTmpMarker && renamesTmp;
}

/** 写后是否有文件级 fsync（`getFD().sync()` 或 `FileChannel.force`）。 */
export function hasDurabilityFsync(javaSource: string): boolean {
  const code = stripJavaComments(javaSource);
  return /getFD\(\)\.sync\(\)/.test(code) || /\.force\s*\(/.test(code);
}

/** 是否有越界围栏（canonical 规整 + `path_outside_root` 拒绝）。 */
export function hasConfinementCheck(javaSource: string): boolean {
  const code = stripJavaComments(javaSource);
  return /getCanonical/.test(code) && /path_outside_root/.test(code);
}

/** 把空白压成单空格，便于对签名做子串断言。 */
export function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
