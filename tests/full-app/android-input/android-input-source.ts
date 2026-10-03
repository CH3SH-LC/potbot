/**
 * FA-APP-INPUT —— 本工作包**自用**的 Android 侧静态判别器（不 import 别的包）。
 *
 * 为什么不跑真机/不跑 Gradle：本包（并发 >10）**不跑 Gradle、不装 APK、不连设备**
 * （设备窗口由总协调统一安排）。`PackageManager` / `ContentResolver` /
 * `getPersistedUriPermissions()` 在 Node 里都跑不了。能被结构化断言的是**源码结构**：
 * 判定表在哪、谁先谁后、错误从哪条路出去、有没有把"不知道"写成"知道"。
 *
 * 它**不**声称任何运行期行为已通过；真机事实一律标「未验证（需真机）」。
 *
 * 判别力自证纪律（沿用本仓库既有做法，见 tests/full-app/android/android-app-source.ts）：
 * 每条判据都要能用**合成的坏源码**证明它会变红，否则就是空断言。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 仓库根（tests/full-app/android-input → 上溯三级）。 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

export const ANDROID_ROOT = 'apps/android';
export const JAVA_DIR = `${ANDROID_ROOT}/app/src/main/java/com/potbot/demo`;
export const ANDROID_MANIFEST = `${ANDROID_ROOT}/app/src/main/AndroidManifest.xml`;
export const STRINGS_XML = `${ANDROID_ROOT}/app/src/main/res/values/strings.xml`;
export const MAIN_ACTIVITY = `${JAVA_DIR}/MainActivity.java`;

/** 本工作包新增的四个 Android 源类。 */
export const INPUT_GATEWAY = `${JAVA_DIR}/PotbotInputGateway.java`;
export const FILE_OPS = `${JAVA_DIR}/PotbotFileOperations.java`;
export const ACCOUNT_OPS = `${JAVA_DIR}/PotbotAccountOps.java`;
export const ACCESSIBILITY = `${JAVA_DIR}/PotbotAccessibility.java`;

export const NEW_CLASSES: readonly string[] = [
  INPUT_GATEWAY, FILE_OPS, ACCOUNT_OPS, ACCESSIBILITY,
];

/** 读仓库相对路径的文本。 */
export function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/** 文件是否存在（仓库相对路径）。 */
export function exists(relPath: string): boolean {
  return existsSync(join(REPO_ROOT, relPath));
}

/** 目录下的全部文件（仓库相对路径；目录不存在 ⇒ 空）。 */
export function listFiles(relDir: string): string[] {
  const root = join(REPO_ROOT, relDir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Java 文本工具
// ---------------------------------------------------------------------------

/**
 * 去掉 Java 注释（`//` 与块注释），**保留字符串/字符字面量与换行**。
 *
 * 为什么不能只用正则：源码里出现字面量通配类型（三个字符：星号、斜杠、星号）时，
 * 正则会把那个 `*` `/` 当成注释结束符，从而**吞掉中间一大段代码**——判据会因此变瞎。
 * 这里按 Java 的词法单遍扫描（注释、字面量在同一遍里区分），并且**保留换行**，
 * 好让"逐行看日志"这类判据仍然对得上行。
 */
export function stripJavaComments(java: string): string {
  let out = '';
  let i = 0;
  while (i < java.length) {
    const c = java.charAt(i);
    const next = java.charAt(i + 1);
    if (c === '/' && next === '/') {
      while (i < java.length && java.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < java.length && !(java.charAt(i) === '*' && java.charAt(i + 1) === '/')) {
        if (java.charAt(i) === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i += 1;
      while (i < java.length && java.charAt(i) !== quote) {
        if (java.charAt(i) === '\\' && i + 1 < java.length) {
          out += java.charAt(i) + java.charAt(i + 1);
          i += 2;
          continue;
        }
        if (java.charAt(i) === '\n') {
          // 未闭合字面量（源码有错）：如实保留并跳出，别把整份文件吞掉。
          out += '\n';
          i += 1;
          break;
        }
        out += java.charAt(i);
        i += 1;
      }
      if (i < java.length && java.charAt(i) === quote) {
        out += quote;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 抽出 Java 的**字符串字面量**（已去注释；跳过字符字面量的干扰）。
 * 只返回内容，不含引号。
 */
export function javaStringLiterals(java: string): readonly string[] {
  const code = stripJavaComments(java);
  const out: string[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code.charAt(i);
    if (c === "'") {
      // 字符字面量：跳到配对的单引号（处理转义）
      i += 1;
      while (i < code.length && code.charAt(i) !== "'") {
        if (code.charAt(i) === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let value = '';
      while (i < code.length && code.charAt(i) !== '"') {
        if (code.charAt(i) === '\\') {
          value += code.charAt(i + 1) === undefined ? '' : code.charAt(i + 1);
          i += 2;
          continue;
        }
        value += code.charAt(i);
        i += 1;
      }
      i += 1;
      out.push(value);
      continue;
    }
    i += 1;
  }
  return out;
}

/** 抽出方法体（按花括号配对，跳过字符串与注释）。找不到返回 null。 */
export function extractMethodBody(text: string, signature: string): string | null {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const braceStart = text.indexOf('{', start + signature.length);
  if (braceStart < 0) return null;

  let depth = 0;
  let i = braceStart;
  while (i < text.length) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (c === '/' && next === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < text.length && text.charAt(i) !== '"') {
        if (text.charAt(i) === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "'") {
      i += 1;
      while (i < text.length && text.charAt(i) !== "'") {
        if (text.charAt(i) === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceStart + 1, i);
    }
    i += 1;
  }
  return null;
}

/** 源码里被引用的字符串资源名（`R.string.xxx`）。 */
export function referencedStringResources(java: string): readonly string[] {
  const out = new Set<string>();
  for (const m of stripJavaComments(java).matchAll(/R\.string\.([A-Za-z0-9_]+)/g)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return [...out].sort();
}

/** `static final String NAME = "value";` 形式的常量。 */
export function parseStringConstants(java: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const re = /static\s+final\s+String\s+([A-Z0-9_]+)\s*=\s*"([^"]*)"/g;
  for (const m of java.matchAll(re)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) out.set(name, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// strings.xml 工具
// ---------------------------------------------------------------------------

/** 资源名 → 文案正文（已还原 XML 实体；只取 `<string>` 的正文，不取名字）。 */
export function resourceTexts(stringsXml: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const re = /<string\s+name="([A-Za-z0-9_]+)"\s*>([\s\S]*?)<\/string>/g;
  for (const m of stringsXml.matchAll(re)) {
    const name = m[1];
    const body = m[2];
    if (name === undefined || body === undefined) continue;
    out.set(name, unescapeXml(body));
  }
  return out;
}

/** 还原 XML 实体（够用即可）。 */
export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 清单里声明的 uses-permission 名单。 */
export function declaredPermissions(manifest: string): readonly string[] {
  const out: string[] = [];
  for (const m of manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 秘钥形态扫描（APP-07「密钥不进 APK/网页/普通日志」的本地轻量版）
// ---------------------------------------------------------------------------

export const SECRET_SHAPES: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: '厂商密钥前缀', re: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { label: '云安全访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: '浏览器密钥', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: '代码平台令牌', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { label: '授权头令牌', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/ },
  { label: 'PEM 私钥块', re: /-----BEGIN[A-Z ]*PRIVATE KEY/ },
  { label: '赋值字面密钥', re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/i },
  { label: '环境变量泄漏', re: /process\.env\b/ },
  { label: 'provider 术语', re: /\bANTHROPIC\b|\bAUTH_TOKEN\b/ },
];

/** 扫描一批源码文本，返回违规清单（空数组 = 干净）。纯函数，便于自证。 */
export function scanForSecrets(
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): readonly string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const shape of SECRET_SHAPES) {
      const hit = shape.re.exec(file.text);
      if (hit) violations.push(`${file.path} [${shape.label}] "${hit[0].slice(0, 32)}"`);
    }
  }
  return violations;
}

/**
 * 日志里是否打印了凭据/令牌（APP-07 的日志分支判据）。
 * 判据是"日志调用与凭据词在同一行"——空断言风险用合成样本自证。
 */
export function logLinesTouchingCredentials(java: string): readonly string[] {
  const out: string[] = [];
  const credentialWords = /(credential|token|secret|password|authorization|authToken)/i;
  for (const raw of stripJavaComments(java).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('Log.')) continue;
    if (credentialWords.test(line)) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 面向用户术语守卫（APP-08：核心流程不要求理解工程术语）
// ---------------------------------------------------------------------------

/**
 * **内部术语白名单**：面向用户的文案里出现任何一个都算违规。
 * 只收"用户不该看到"的词——`PDF` / `Word` 这类格式名不算。
 */
export const INTERNAL_TERMINOLOGY: readonly { readonly term: string; readonly re: RegExp }[] = [
  { term: 'agent(EN)', re: /\bagents?\b/i },
  { term: '智能体', re: /智能体/ },
  { term: '群聊', re: /群聊/ },
  { term: 'orchestrator', re: /\borchestrator\b/i },
  { term: 'kernel/内核', re: /\bkernel\b|内核/i },
  { term: 'embedding', re: /\bembeddings?\b/i },
  { term: '向量', re: /向量/ },
  { term: 'LLM', re: /\bllms?\b/i },
  { term: 'prompt', re: /\bprompts?\b/i },
  { term: 'MCP', re: /\bmcp\b/i },
  { term: 'tool call', re: /\btool[\s_-]?calls?\b/i },
  { term: 'workflow', re: /\bworkflows?\b/i },
  { term: 'JSON', re: /\bjson\b/i },
  { term: 'API', re: /\bapis?\b/i },
  { term: 'token', re: /\btokens?\b/i },
];

/** 一段用户可见文本里命中的内部术语（空数组 = 干净）。纯函数，便于自证。 */
export function findInternalTerminology(text: string): readonly string[] {
  const out: string[] = [];
  for (const entry of INTERNAL_TERMINOLOGY) {
    const hit = entry.re.exec(text);
    if (hit) out.push(`${entry.term}: "${hit[0]}"`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 中文串（证明"面向用户的文案不在 Java 里硬编码"）
// ---------------------------------------------------------------------------

/** 文本是否含中日韩统一表意文字。 */
export function hasCjk(text: string): boolean {
  return /[一-鿿]/.test(text);
}

/** 一个 Java 文件里"带中文的字符串字面量"。 */
export function cjkStringLiterals(java: string): readonly string[] {
  return javaStringLiterals(java).filter((s) => hasCjk(s));
}

/**
 * 注释是否**提前闭合**（javadoc 正文漏进"代码"）。
 *
 * 为什么需要：javadoc 里写一个星号紧跟斜杠（例如把通配类型原样写进去）会让注释
 * **就地结束**——这既是编译错误，也会把后面的注释正文当成代码。
 * 用合成样本自证（见 tests 里的 `commentLeakMarkers` 用例）。
 */
export function commentLeakMarkers(java: string): readonly string[] {
  const code = stripJavaComments(java);
  const out: string[] = [];
  if (code.includes('{@')) out.push('去注释后仍残留 {@ 标记：javadoc 提前闭合');
  if (code.includes('**')) out.push('去注释后仍残留 ** 标记：javadoc 提前闭合');
  if (hasCjk(code)) out.push('去注释后仍有中文：注释正文漏进了代码');
  return out;
}

// ---------------------------------------------------------------------------
// 进 APK 的源码（供密钥扫描）
// ---------------------------------------------------------------------------

/** Android 侧"进 APK 的源码/清单/资源"（按后缀筛选）。 */
export function androidAppSourceFiles(): ReadonlyArray<{ path: string; text: string }> {
  return listFiles(`${ANDROID_ROOT}/app/src/main`)
    .filter((p) => /\.(java|kt|xml|gradle|properties|ts|js|mjs|html|css)$/.test(p))
    .map((p) => ({ path: p, text: readText(p) }));
}
