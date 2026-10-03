/**
 * K-I23 —— 静态契约检查器：把 Android 桥/Service 的 Java 源码当**文本**解析，
 * 断言它暴露给 JS 的接口面与 K01 `createLocalUiBridge` 契约一致，且**不含**任意
 * 文件 / 密钥 / 代码执行钩子。
 *
 * 为什么静态检查（而不是编译）：本机无 Android SDK / gradle wrapper（见 K01 README），
 * Java 无法编译/安装。JS 面是 `@JavascriptInterface` 注解决定的**源码事实**，可以
 * 用文本解析稳定核验；解析器自带反向对照（见测试文件），避免"正则写错 ⇒ 零命中 ⇒ 假绿灯"。
 *
 * 本文件零第三方依赖，只读仓库源码，不改写任何产品文件。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNTIME_DIR = '../../../apps/android/app/src/main/java/com/potbot/kernel/runtime/';

export const JAVA_BRIDGE_PATH = fileURLToPath(new URL(RUNTIME_DIR + 'KernelLocalUiBridge.java', import.meta.url));
export const JAVA_SERVICE_PATH = fileURLToPath(new URL(RUNTIME_DIR + 'KernelRuntimeService.java', import.meta.url));
export const BOOTSTRAP_TYPES_PATH = fileURLToPath(new URL('../../../apps/mobile-kernel/bootstrap/types.ts', import.meta.url));
export const BUILD_INFO_PATH = fileURLToPath(new URL('../../../apps/mobile-kernel/bootstrap/dist/build-info.json', import.meta.url));

export function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

// ---------------------------------------------------------------------------
// Java 结构扫描（字符串 / 字符 / 注释感知）
// ---------------------------------------------------------------------------

function skipQuoted(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return src.length;
}

/** 找到 `openIndex`（必须是 `{`）对应的 `}` 位置；字符串/字符/注释内的花括号不算。 */
export function matchBrace(src: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** 去除 `//` 与 `/* *\/` 注释（保留字符串字面量内容），用于危险 API 扫描。 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export interface JavaMethod {
  readonly name: string;
  readonly returnType: string;
  readonly params: readonly string[];
  readonly body: string;
  readonly exposedToJs: boolean;
}

function splitParams(raw: string): string[] {
  const params: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '<' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '>' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (cur.trim().length > 0) params.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) params.push(cur.trim());
  return params;
}

/** 方法参数名（最后一个标识符）。 */
export function paramName(param: string): string {
  const parts = param.trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

function inferReturnType(header: string, name: string): string {
  const stripped = header.replace(/\b(public|private|protected|static|final|synchronized|native|abstract)\b/g, ' ');
  const idx = stripped.lastIndexOf(name);
  return stripped.slice(0, idx).trim();
}

/**
 * 解析所有带 `@JavascriptInterface` 的方法（= 暴露给 WebView 页面的 JS 面）。
 * 返回顺序与源码出现顺序一致。
 *
 * 先在**去注释**文本上扫描：Javadoc 里写的 `{@code @JavascriptInterface}` 是文档，
 * 不是注解，不能算作暴露面（否则会把构造函数误判成 JS 入口）。
 */
export function parseExposedMethods(src: string): JavaMethod[] {
  const clean = stripComments(src);
  const methods: JavaMethod[] = [];
  const annotationRe = /@JavascriptInterface\b(?:\(\s*\))?/g;
  let annotation: RegExpExecArray | null;
  while ((annotation = annotationRe.exec(clean)) !== null) {
    const from = annotation.index + annotation[0].length;
    const sigRe = /\b([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*(?:throws\s+[A-Za-z0-9_$.,\s]+?)?\{/g;
    sigRe.lastIndex = from;
    const sig = sigRe.exec(clean);
    if (sig === null) continue;
    const name = sig[1] ?? '';
    const openIndex = sig.index + sig[0].length - 1;
    const closeIndex = matchBrace(clean, openIndex);
    const header = clean.slice(from, openIndex);
    methods.push({
      name,
      returnType: inferReturnType(header, name),
      params: splitParams(sig[2] ?? ''),
      body: closeIndex < 0 ? '' : clean.slice(openIndex + 1, closeIndex),
      exposedToJs: true,
    });
  }
  return methods;
}

/** 用「方法头正则 + 花括号配对」抽出一段方法体（返回 null 表示没找到）。 */
export function extractMethodBody(src: string, headerRe: RegExp): string | null {
  const m = headerRe.exec(src);
  if (m === null) return null;
  const openIndex = src.indexOf('{', m.index + m[0].length);
  if (openIndex < 0) return null;
  const closeIndex = matchBrace(src, openIndex);
  if (closeIndex < 0) return null;
  return src.slice(openIndex + 1, closeIndex);
}

/** 提取 `String[] CONST = { "a", "b" };` 里的字符串字面量。 */
export function parseStringArrayConstant(src: string, constName: string): string[] | null {
  const declRe = new RegExp(`\\b${constName}\\b\\s*=\\s*\\{`);
  const m = declRe.exec(src);
  if (m === null) return null;
  const openIndex = src.indexOf('{', m.index);
  const closeIndex = matchBrace(src, openIndex);
  if (closeIndex < 0) return null;
  const body = src.slice(openIndex + 1, closeIndex);
  const out: string[] = [];
  const strRe = /"((?:[^"\\]|\\.)*)"/g;
  let s: RegExpExecArray | null;
  while ((s = strRe.exec(body)) !== null) out.push(s[1] ?? '');
  return out;
}

/** 提取 `String CONST = "value";` 里的字符串字面量。 */
export function parseStringConstant(src: string, constName: string): string | null {
  const re = new RegExp(`\\b${constName}\\b\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(src);
  return m === null ? null : (m[1] ?? null);
}

// ---------------------------------------------------------------------------
// 危险钩子口径
// ---------------------------------------------------------------------------

/** 暴露给 JS 的方法名**不得**命中：任意文件 / 目录 / 密钥 / 代码执行 / 进程 / 网络加载。 */
export const FORBIDDEN_EXPOSED_NAME = /(read|write|file|dir|folder|path|exec|eval|shell|cmd|process|secret|key|token|credential|password|code|script|url|load|inject|reflect|prefs|clipboard|sms|call|phone|contact|location|camera|microphone|record)/i;

/** 桥源码中**不得**出现的危险宿主调用（进程/文件/密钥/原生注入）。 */
export const FORBIDDEN_SINK_PATTERNS: ReadonlyArray<{ readonly id: string; readonly re: RegExp }> = [
  { id: 'runtime-exec', re: /Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec/ },
  { id: 'process-builder', re: /new\s+ProcessBuilder/ },
  { id: 'java-io-file', re: /new\s+java\.io\.File/ },
  { id: 'file-stream', re: /new\s+File(InputStream|OutputStream|Reader|Writer)\b/ },
  { id: 'file-object', re: /new\s+File\s*\(/ },
  { id: 'load-url', re: /\.loadUrl\s*\(/ },
  { id: 'evaluate-javascript', re: /\.evaluateJavascript\s*\(/ },
  { id: 'add-js-interface', re: /addJavascriptInterface\s*\(/ },
  { id: 'keystore', re: /KeyStore\s*\.\s*getInstance/ },
  { id: 'shared-prefs', re: /getSharedPreferences\s*\(/ },
  { id: 'reflection', re: /Class\s*\.\s*forName\s*\(|\.getDeclaredMethod\s*\(/ },
];

export function findForbiddenSinks(src: string): string[] {
  const clean = stripComments(src);
  return FORBIDDEN_SINK_PATTERNS.filter((p) => p.re.test(clean)).map((p) => p.id);
}

export function findForbiddenExposedNames(methods: readonly JavaMethod[]): string[] {
  return methods.filter((m) => FORBIDDEN_EXPOSED_NAME.test(m.name)).map((m) => m.name);
}

/** 宿主接线口（非 JS 面）必须存在的名字 —— 由测试断言它们**不**带 @JavascriptInterface。 */
export const HOST_ONLY_METHODS = [
  'setDispatcher',
  'setEventSink',
  'startRuntime',
  'stopRuntime',
  'isRunning',
  'emitEvent',
  'subscriptionCount',
] as const;

export const BUILD_INFO_PRESENT = existsSync(BUILD_INFO_PATH);
