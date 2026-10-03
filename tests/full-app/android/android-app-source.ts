/**
 * FA-APP-LIFECYCLE —— Android App 侧的**静态判别器**（本包自用，不 import 别的包）。
 *
 * 为什么静态：本包**不跑 Gradle、不装 APK、不连真机**（并发 15+，禁 Gradle；设备窗口
 * 由总协调统一安排）。`PackageManager` / `JobScheduler` / `RegisterDefaultNetworkCallback`
 * 在 Node 里都跑不了。能被结构化断言的是**源码结构**：哪些状态存在、谁在谁之前、
 * 成功/失败只能从哪条路出去、有没有把"未知"写成"已知"。
 *
 * 它**不**声称任何运行期行为已通过；真机事实一律标「未验证（需真机）」。
 *
 * 判别力自证纪律（沿用本仓库既有做法）：合成的坏实现必须被抓、干净实现必须放行，
 * 否则扫描器就是空断言。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 仓库根（tests/full-app/android → 上溯三级）。 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

export const ANDROID_ROOT = 'apps/android';
export const VERSION_PROPERTIES = `${ANDROID_ROOT}/version.properties`;
export const APP_BUILD_GRADLE = `${ANDROID_ROOT}/app/build.gradle`;
export const ANDROID_MANIFEST = `${ANDROID_ROOT}/app/src/main/AndroidManifest.xml`;
export const STRINGS_XML = `${ANDROID_ROOT}/app/src/main/res/values/strings.xml`;
export const NETWORK_SECURITY_CONFIG =
  `${ANDROID_ROOT}/app/src/main/res/xml/network_security_config.xml`;
export const JAVA_DIR = `${ANDROID_ROOT}/app/src/main/java/com/potbot/demo`;
export const MAIN_ACTIVITY = `${JAVA_DIR}/MainActivity.java`;
export const PKG_JSON = 'package.json';
export const KERNEL_TASK_LIFECYCLE = 'src/scheduler/task-lifecycle.ts';

/** 本包新增/接线的 Android 源类。 */
export const APP_LIFECYCLE_CLASSES: readonly string[] = [
  `${JAVA_DIR}/PotbotAppVersion.java`,
  `${JAVA_DIR}/PotbotUpgrade.java`,
  `${JAVA_DIR}/PotbotTaskState.java`,
  `${JAVA_DIR}/PotbotEndpoints.java`,
  `${JAVA_DIR}/PotbotConnectivity.java`,
  `${JAVA_DIR}/PotbotTaskActions.java`,
  `${JAVA_DIR}/PotbotProgressJobService.java`,
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

/** 解析 `k=v` 形式的 properties 文件（跳过空行与 `#`/`!` 注释）。 */
export function readProperties(relPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readText(relPath).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/**
 * 抽出 Java 方法/构造器的**方法体**（按花括号配对，跳过字符串、字符与注释）。
 * 找不到返回 `null`（调用方按"方法缺失"报告）。
 */
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

/** 去掉 Java 注释（`//` 与 块注释），供只看代码不看注释的检查使用。 */
export function stripJavaComments(java: string): string {
  return java.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 解析 `enum <name>` 体的成员名（合并同名 enum；去注释后取全大写标识符）。 */
export function enumMembers(java: string, enumName: string): readonly string[] | null {
  const text = stripJavaComments(java);
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`, 'g');
  const out: string[] = [];
  let found = false;
  for (const m of text.matchAll(re)) {
    found = true;
    const body = m[1] ?? '';
    for (const id of body.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
      if (id[1] !== undefined) out.push(id[1]);
    }
  }
  return found ? out : null;
}

/** 解析 `static final String NAME = "value";` 形式的常量。 */
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

/** MainActivity 的 manifest 里声明的 uses-permission 名单（按出现顺序）。 */
export function declaredPermissions(manifest: string): readonly string[] {
  const out: string[] = [];
  for (const m of manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 权限白名单（FA-APP-NOTIFY-PERM）
// ---------------------------------------------------------------------------
//
// 原来的不变量把权限集合**锁死**为 `INTERNET + ACCESS_NETWORK_STATE`，本意是
// "**不申请与功能无关的敏感权限**"（相机 / 定位 / 通讯录 / 后台定位 / 外部存储……），
// 而不是"永远只能有两个权限"。这个理由在 `tests/demo/word-android/import-boundary.test.ts`
// 里写得很清楚：「不因此新增危险权限」「SAF 导入不需要存储权限」。
//
// 把锁死改成**具名白名单**后，原本要保的东西一条没丢，反而更明确：
//   - 白名单**外**的任何权限都报红（不是"任意权限都行"）；
//   - 每一条白名单成员都必须写明**功能理由**，且属于"功能必需 + 用户可见可撤销"；
//   - 存储/相机/定位这类敏感权限另有一条**硬性禁令**（见 STORAGE_HARD_BAN）。
//
// **判别力自证**：白名单不是恒真——把 CAMERA / ACCESS_FINE_LOCATION 塞进清单必须被
// `scanPermissionViolations` 抓到（测试里有反向对照臂）。

/** 允许出现在清单里的权限：**具名白名单**（每项都必须有功能理由，且用户可见可撤销）。 */
export const ALLOWED_PERMISSIONS: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: 'android.permission.INTERNET',
    why: '访问本机 127.0.0.1:8765 的 Node 服务（唯一数据通道）',
  },
  {
    name: 'android.permission.ACCESS_NETWORK_STATE',
    why: '连通性判定（在线 / 离线 / 未知三态），不读用户数据',
  },
  {
    name: 'android.permission.POST_NOTIFICATIONS',
    why: '后台任务进度通知（API 33+ 运行时权限）：功能必需、系统弹窗可见、可随时撤销，拒绝即降级',
  },
  {
    name: 'android.permission.FOREGROUND_SERVICE',
    why:
      'K-I21 长任务前台服务（ForegroundTaskService）必需：API 28+ 起任何 startForeground() ' +
      '的前置普通权限（安装时自动授予、无运行时弹窗、用户可在系统设置里查看/控制）',
  },
  {
    name: 'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    why:
      'K-I21 长任务前台服务必需：该服务声明 android:foregroundServiceType="dataSync"，' +
      '而本工程 targetSdk = 34，缺此类型专属权限则 startForeground 抛 SecurityException；' +
      '同为普通权限（无运行时弹窗）',
  },
];

/** 白名单外的权限一律报这条规则名。 */
export const PERMISSION_RULE = {
  not_allowlisted: 'permission_not_allowlisted',
  storage_hard_ban: 'permission_storage_hard_ban',
} as const;

/**
 * 这些权限**任何理由都不许出现**（存储/媒体直读类）：SAF 已覆盖文件读写，
 * 没有它们的位置。即使有人把它们加进白名单，这条硬禁令仍然报红。
 */
export const STORAGE_HARD_BAN: readonly RegExp[] = [
  /READ_EXTERNAL_STORAGE/,
  /WRITE_EXTERNAL_STORAGE/,
  /MANAGE_EXTERNAL_STORAGE/,
];

export interface PermissionViolation {
  readonly rule: string;
  readonly detail: string;
}

/**
 * 扫描一份清单文本，返回权限违规（空数组 = 干净）。**纯函数**，便于判别力自证。
 *
 * 与旧版"等于固定集合"的差别：现在只有**白名单**是硬边界；但白名单本身是**闭环**的——
 * 只要清单里出现白名单外的权限（哪怕它是"看起来无害"的新权限），就会报红。
 */
export function scanPermissionViolations(manifest: string): readonly PermissionViolation[] {
  const allowed = new Set(ALLOWED_PERMISSIONS.map((p) => p.name));
  const violations: PermissionViolation[] = [];
  for (const name of declaredPermissions(manifest)) {
    if (!allowed.has(name)) {
      violations.push({
        rule: PERMISSION_RULE.not_allowlisted,
        detail: `清单声明了白名单外的权限：${name}`,
      });
    }
    for (const ban of STORAGE_HARD_BAN) {
      if (ban.test(name)) {
        violations.push({
          rule: PERMISSION_RULE.storage_hard_ban,
          detail: `清单声明了硬禁权限：${name}`,
        });
      }
    }
  }
  return violations;
}

/** 白名单里的权限名（排序后），供"声明集合 == 白名单"的等价断言使用。 */
export function allowlistedPermissionNames(): readonly string[] {
  return ALLOWED_PERMISSIONS.map((p) => p.name).slice().sort();
}

/**
 * 版本号 → versionCode 的**固定推导方案**（与 `apps/android/version.properties` 的说明一致）：
 * `major*1000000 + minor*1000 + patch`。判别力自证用它。
 */
export function deriveVersionCode(versionName: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(versionName);
  if (!m) throw new Error(`不是三段式版本号：${versionName}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return major * 1_000_000 + minor * 1_000 + patch;
}

// ---------------------------------------------------------------------------
// 密钥形态扫描（APP-06「密钥不进 APK/网页/普通日志」的本地轻量版）
// ---------------------------------------------------------------------------

/** 能**唯一命中**的密钥形态；body 足够长以避免命中 `task-status` 这类标识串。 */
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

/** 扫描一批源码文本，返回违规清单（空数组 = 干净）。**纯函数**，便于自证判别力。 */
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

/** 取 Android 侧"进 APK 的源码/清单/资源"（按后缀筛选）。 */
export function androidAppSourceFiles(): ReadonlyArray<{ path: string; text: string }> {
  return listFiles(`${ANDROID_ROOT}/app/src/main`)
    .filter((p) => /\.(java|kt|xml|gradle|properties|ts|js|mjs|html|css)$/.test(p))
    .map((p) => ({ path: p, text: readText(p) }));
}
