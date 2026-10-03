/**
 * PLG-03：**安装来源与声明式包内容校验**（design-06 P6；合同 R229）。
 *
 * ## 这一层要挡住什么
 *
 * 声明式安装（读一份清单、注册一个模板）**不是**任意代码执行的后门。R229 的底线：
 * 一个声明式包**不得暗中获得**
 *
 * 1. **任意代码执行**（`exec` / `run` / `shell` / `command` / `entrypoint` / 内联代码）；
 * 2. **自行安装依赖**（`install` 生命周期钩子 / `install_dependencies` 能力）；
 * 3. **启动未知 MCP 服务**（任何 MCP 端点 URL，或未登记的 MCP 适配器引用）。
 *
 * 任一条命中 ⇒ **一律拒绝**，并给出**具名报因**（报因里带着命中的那个关键词 / URL / 能力 ID，
 * 而不是一句含糊的"包不合法"）。
 *
 * ## 与 `manifest.ts` 的 `validateDeclarativePackage` 的关系
 *
 * `manifest.ts` 的校验只管**清单形状**那一半（能力 / 埋脚本 / 清单能否构造）。本文件是**更严的
 * 安装前门**：它在清单校验之外，还探查包声明里所有"执行面"（键名、生命周期钩子、MCP 端点），
 * 并把 `exec` / `run` / `shell` / `postinstall` 这类**词法级**信号一并拦下。两者不互相替代：
 * 分层调用时先过本文件，再过 `manifest.ts`（或反过来，都在装之前）。
 *
 * ## 安装来源
 *
 * `install_source.kind` 必须是 `declarative_package`，`origin` 必须是**受控来源**
 * （包 id / 受控目录路径）。任何带 scheme 的东西——`https://…`、`file://…`、`npm:…`、
 * `git+…`——都不是受控来源，一律拒。
 *
 * 纯函数、零 IO：不含墙钟、不含随机数、不读 `process.*`、不 import `node:*`。
 * 全部违规**一次收齐**（不 fail-fast），便于一次把包的毛病说清。
 */

import { ValidationError } from '../protocol/index.js';
import {
  PACKAGE_FORBIDDEN_CAPABILITIES,
  createPluginManifest,
  type PluginManifest,
} from './manifest.js';

// ---------------------------------------------------------------------------
// 拒因码（封闭枚举）
// ---------------------------------------------------------------------------

/** 声明式包校验的拒因码（封闭枚举；每条都对应一种被明确禁止的"权力获取"方式）。 */
export const PACKAGE_VALIDATION_CODES = [
  'invalid_package', // 包不是普通对象
  'missing_package_id', // 缺包 id
  'invalid_install_source', // 安装来源种类不对（非 declarative_package）
  'arbitrary_origin_url', // 来源 origin 是任意 URL / 带 scheme 的东西
  'forbidden_capability', // 申请了禁止的能力（code_execution / exec / run / shell / …）
  'forbidden_execution_surface', // 声明里出现 exec / run / shell / command / entrypoint / 代码字段
  'lifecycle_hook', // 声明了 postinstall / preinstall / prepare 之类生命周期钩子
  'embedded_script', // 夹带脚本载荷
  'arbitrary_mcp_endpoint', // 声明了任意 MCP 端点 URL 或未登记的 MCP 引用
  'invalid_manifest', // 内嵌清单构造失败
] as const;
export type PackageValidationCode = (typeof PACKAGE_VALIDATION_CODES)[number];

/** 一条具名拒因。`subject` 是**命中的那个符号**（关键词 / URL / 能力 ID），不是泛泛的说明。 */
export interface PackageValidationIssue {
  readonly code: PackageValidationCode;
  /** 命中的具名符号（如 `"exec"`、`"postinstall"`、`"https://evil.example/mcp"`）。 */
  readonly subject: string;
  /** 人类可读的具名报因（含 `subject`）。 */
  readonly detail: string;
}

/** 通过严格校验、可交给注册表安装的声明式包。 */
export interface StrictValidatedPackage {
  readonly package_id: string;
  readonly version: string;
  readonly manifest: PluginManifest;
  readonly install_source: { readonly kind: 'declarative_package'; readonly origin: string };
}

export type PackageValidationResult =
  | { readonly ok: true; readonly package: StrictValidatedPackage }
  | { readonly ok: false; readonly issues: readonly PackageValidationIssue[] };

export interface PackageValidationOptions {
  /**
   * 允许被引用的**已登记** MCP 适配器 id（默认空）。
   * 空表示"一个 MCP 引用都不许"——声明式包不得启动未知 MCP 服务（R229）。
   */
  readonly allowed_mcp_adapters?: readonly string[];
}

// ---------------------------------------------------------------------------
// 词法信号（具名报因的来源）
// ---------------------------------------------------------------------------

/**
 * **执行面键名**：这些键一出现，就说明包在申请"跑点什么"的权利。
 * 任务口径点名的 `exec` / `run` / `shell` 都在此列。
 */
export const EXECUTION_SURFACE_KEYS = [
  'exec',
  'exec_command',
  'executable',
  'run',
  'shell',
  'command',
  'commands',
  'entrypoint',
  'entry_points',
  'code',
  'source_code',
  'binary',
  'binaries',
  'native_addon',
  'native_addons',
] as const;

/**
 * **生命周期钩子键名**：任务口径点名的 `postinstall` 在此列。
 * 任何 `scripts` / `hooks` 对象里的**任意**键都按生命周期钩子处理（拒绝）。
 */
export const LIFECYCLE_HOOK_KEYS = [
  'postinstall',
  'preinstall',
  'prepare',
  'postuninstall',
  'install',
  'install_script',
] as const;

/** **MCP 声明键名**：出现在包顶层即按 MCP 端点声明处理。 */
export const MCP_DECLARATION_KEYS = ['mcp_servers', 'mcp_server', 'mcp_endpoints', 'remote_mcp'] as const;

/**
 * 被禁止申请的能力 token（`manifest.ts` 的四项 + 任务口径点名的四个词）。
 * 命中其一 ⇒ `forbidden_capability`，报因里带上这个 token。
 */
export const FORBIDDEN_CAPABILITY_TOKENS = [
  ...PACKAGE_FORBIDDEN_CAPABILITIES,
  'exec',
  'run',
  'shell',
  'postinstall',
] as const;
export type ForbiddenCapabilityToken = (typeof FORBIDDEN_CAPABILITY_TOKENS)[number];

// ---------------------------------------------------------------------------
// 判定辅助
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 是否是"带端点形状"的 URL（`https://…`、`ws://…`、`//host/…`、`unix://…`）。
 * 注意：**不**把 `D:\…` 这类 Windows 盘符路径当成 URL。
 */
export function looksLikeEndpointUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('//')) return true;
  // scheme 至少两个字符，避免把 Windows 盘符（`D:`）误判为 URL
  return /^[a-z][a-z0-9+.-]+:\/\//i.test(trimmed);
}

/**
 * 是否是受控来源 origin。
 *
 * 受控 = **不带任何 scheme**（`builtin`、包 id、相对 / 绝对目录路径）。
 * 只要出现 scheme（`https:` / `file:` / `npm:` / `git+ssh:` …）或 `//` 前缀，即**不受控**。
 */
export function isControlledOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (trimmed.length === 0) return false;
  if (looksLikeEndpointUrl(trimmed)) return false;
  // 任何形如 `scheme:` 的前缀（scheme ≥ 2 字符）都视为脱离受控来源
  if (/^[a-z][a-z0-9+.-]+:/i.test(trimmed)) return false;
  return true;
}

/** 看起来像适配器 / 包的稳定 id（无空格、无路径分隔符）。 */
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/i;

// ---------------------------------------------------------------------------
// 扫描：执行面 / 生命周期钩子 / MCP 端点
// ---------------------------------------------------------------------------

function pushIssue(
  issues: PackageValidationIssue[],
  code: PackageValidationCode,
  subject: string,
  detail: string,
): void {
  issues.push(Object.freeze({ code, subject, detail }));
}

function isListed(key: string, list: readonly string[]): boolean {
  return list.includes(key);
}

/** 递归收集一个值里的全部字符串（用于 MCP 端点探查）。 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) {
      collectStrings(nested, out);
    }
  }
}

function scanMcpDeclaration(
  key: string,
  value: unknown,
  allowed: readonly string[],
  issues: PackageValidationIssue[],
): void {
  const strings: string[] = [];
  collectStrings(value, strings);
  const allowedSet = new Set(allowed);
  for (const candidate of strings) {
    if (looksLikeEndpointUrl(candidate)) {
      pushIssue(
        issues,
        'arbitrary_mcp_endpoint',
        candidate,
        `声明式包在 ${key} 里声明了任意 MCP 端点 ${JSON.stringify(candidate)}：` +
          '不得启动未知 MCP 服务（R229）',
      );
      continue;
    }
    if (IDENTIFIER_PATTERN.test(candidate) && !allowedSet.has(candidate)) {
      pushIssue(
        issues,
        'arbitrary_mcp_endpoint',
        candidate,
        `声明式包在 ${key} 里引用了未登记的 MCP 适配器 ${JSON.stringify(candidate)}：` +
          '受控清单里没有它，不得启动未知 MCP 服务（R229）',
      );
    }
  }
}

/**
 * 扫描包声明里的全部"执行面"。**命中即收**（不 fail-fast），一次收齐所有具名拒因。
 */
export function scanPackageExecutionSurfaces(
  raw: Record<string, unknown>,
  options: PackageValidationOptions = {},
): readonly PackageValidationIssue[] {
  const issues: PackageValidationIssue[] = [];
  const allowedMcp = options.allowed_mcp_adapters ?? [];

  for (const [key, value] of Object.entries(raw)) {
    if (isListed(key, EXECUTION_SURFACE_KEYS)) {
      pushIssue(
        issues,
        'forbidden_execution_surface',
        key,
        `声明式包声明了执行面字段 ${JSON.stringify(key)}：不得暗中获得任意代码执行（R229）`,
      );
      continue;
    }
    if (isListed(key, LIFECYCLE_HOOK_KEYS)) {
      pushIssue(
        issues,
        'lifecycle_hook',
        key,
        `声明式包声明了生命周期钩子 ${JSON.stringify(key)}：不得暗中安装依赖 / 执行脚本（R229）`,
      );
      continue;
    }
    if (isListed(key, MCP_DECLARATION_KEYS)) {
      scanMcpDeclaration(key, value, allowedMcp, issues);
    }
  }

  // `scripts` / `hooks` / `lifecycle_scripts` 对象：其中**任意**键都按钩子处理
  for (const containerKey of ['scripts', 'hooks', 'lifecycle_scripts', 'lifecycle']) {
    const container = raw[containerKey];
    if (isPlainObject(container)) {
      for (const hookKey of Object.keys(container)) {
        const code: PackageValidationCode = isListed(hookKey, EXECUTION_SURFACE_KEYS)
          ? 'forbidden_execution_surface'
          : 'lifecycle_hook';
        pushIssue(
          issues,
          code,
          hookKey,
          `声明式包在 ${containerKey} 里声明了 ${JSON.stringify(hookKey)}：` +
            '钩子 / 脚本会在安装期执行，声明式安装不是任意代码执行的入口（R229）',
        );
      }
    } else if (Array.isArray(container) && container.length > 0) {
      pushIssue(
        issues,
        'embedded_script',
        containerKey,
        `声明式包的 ${containerKey} 非空：不得夹带脚本载荷（R229）`,
      );
    }
  }

  // 显式脚本载荷
  const embedded = raw.embedded_scripts;
  if (Array.isArray(embedded) && embedded.length > 0) {
    pushIssue(
      issues,
      'embedded_script',
      'embedded_scripts',
      '声明式包的 embedded_scripts 非空：不得夹带脚本载荷（R229）',
    );
  }

  return Object.freeze(issues);
}

// ---------------------------------------------------------------------------
// 主入口：安装前校验
// ---------------------------------------------------------------------------

/**
 * 校验一个**声明式包**能否被安装。
 *
 * 一律返回结构化结果（**不抛**），一次收齐所有问题；每一项都带**具名 `subject`**。
 */
export function validateDeclarativePackageForInstall(
  raw: unknown,
  options: PackageValidationOptions = {},
): PackageValidationResult {
  const issues: PackageValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    pushIssue(issues, 'invalid_package', describe(raw), `声明式包必须是普通对象，收到 ${describe(raw)}`);
    return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  }

  if (typeof raw.package_id !== 'string' || raw.package_id.length === 0) {
    pushIssue(issues, 'missing_package_id', 'package_id', '声明式包必须给出非空 package_id');
  }

  const source = raw.install_source;
  if (!isPlainObject(source) || source.kind !== 'declarative_package') {
    pushIssue(
      issues,
      'invalid_install_source',
      'install_source',
      '声明式包的 install_source.kind 必须是 declarative_package',
    );
  } else if (!isControlledOrigin(source.origin)) {
    pushIssue(
      issues,
      'arbitrary_origin_url',
      typeof source.origin === 'string' ? source.origin : describe(source.origin),
      `声明式包的安装来源 ${JSON.stringify(source.origin)} 不是受控来源：` +
        '只接受包 id / 受控目录路径，不接受任意 URL 或带 scheme 的地址（R229）',
    );
  }

  // 请求的能力：命中禁止 token ⇒ 具名拒绝
  const requested = raw.requested_capabilities;
  if (Array.isArray(requested)) {
    for (const capability of requested) {
      if (typeof capability === 'string' && isListed(capability, FORBIDDEN_CAPABILITY_TOKENS)) {
        pushIssue(
          issues,
          'forbidden_capability',
          capability,
          `声明式包申请了禁止的能力 ${JSON.stringify(capability)}：` +
            '声明式安装不得暗中获得任意代码执行、安装依赖或启动未知 MCP 服务（R229）',
        );
      }
    }
  }

  // 执行面 / 钩子 / MCP
  issues.push(...scanPackageExecutionSurfaces(raw, options));

  // 内嵌清单构造
  let manifest: PluginManifest | null = null;
  try {
    manifest = createPluginManifest(raw.manifest);
  } catch (error) {
    pushIssue(
      issues,
      'invalid_manifest',
      'manifest',
      `内嵌清单构造失败：${error instanceof Error ? error.message : describe(error)}`,
    );
  }

  // 清单里的 MCP 适配器引用同样不得是指向任意 URL 的端点
  if (manifest !== null) {
    for (const dependency of manifest.adapter_dependencies) {
      if (dependency.kind === 'mcp' && looksLikeEndpointUrl(dependency.adapter_id)) {
        pushIssue(
          issues,
          'arbitrary_mcp_endpoint',
          dependency.adapter_id,
          `内嵌清单把 MCP 适配器写成端点 URL ${JSON.stringify(dependency.adapter_id)}：` +
            '适配器只能用受控 id 引用，不得携带任意 URL（R229）',
        );
      }
    }
    if (!isControlledOrigin(manifest.install_source.origin)) {
      pushIssue(
        issues,
        'arbitrary_origin_url',
        manifest.install_source.origin,
        `内嵌清单的 install_source.origin ${JSON.stringify(manifest.install_source.origin)} 不是受控来源（R229）`,
      );
    }
  }

  if (issues.length > 0 || manifest === null || typeof raw.package_id !== 'string') {
    return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  }

  const version = typeof raw.version === 'string' && raw.version.length > 0 ? raw.version : manifest.version;
  return Object.freeze({
    ok: true,
    package: Object.freeze({
      package_id: raw.package_id,
      version,
      manifest,
      install_source: Object.freeze({ kind: 'declarative_package' as const, origin: raw.package_id }),
    }),
  });
}

/** 把一条拒因格式化成一句**具名报因**（调用方/日志直接可用）。 */
export function describePackageIssue(issue: PackageValidationIssue): string {
  return `[${issue.code}] ${issue.subject}：${issue.detail}`;
}

/**
 * 断言式入口：校验失败即抛 `ValidationError`，报因**逐条具名**。
 *
 * @throws {ValidationError} 包不合法，或申请了禁止的能力 / 执行面 / MCP 端点时。
 */
export function assertDeclarativePackageInstallable(
  raw: unknown,
  options: PackageValidationOptions = {},
): StrictValidatedPackage {
  const result = validateDeclarativePackageForInstall(raw, options);
  if (!result.ok) {
    const named = result.issues.map(describePackageIssue).join('；');
    throw new ValidationError(`声明式包被拒绝安装（R229）：${named}`);
  }
  return result.package;
}
