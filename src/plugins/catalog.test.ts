/**
 * 注册目录与清单校验单测（design-06 P6；合同 R227 / R228 / R229 / R232 / R233）。
 *
 * 重点写死两件在合同里被反复强调、又最容易写错的事：
 *
 * 1. **R232 文件格式 ≠ 模板**：文件类型枚举只有 docx/xlsx/pptx，且**从 protocol 派生**；
 *    美团 / 时钟 / 日历 / 资料检索**不在**里面，也**不产出**任何 OOXML；把业务模板名塞进
 *    产出格式会被**构造期拒掉**。
 * 2. **R233 stub 必须显式标识**：stub 清单必带原因，real 清单不得带原因；stub **永不**判就绪。
 * 3. **目录不得对用户说假话**（文件末尾两组判据）：`catalog.ts` 是产品可达的，所以它每条
 *    「某条 `src/**` 路径存在 / 不存在」的断言都必须与代码树一致——第三轮独立验证抓到过它
 *    声称 `src/adapters/research/**` 不存在而那 29 个模块早已存在。该组判据两个方向都查，
 *    并强制每条 stub 点名自己的承载路径。第二组（可达 / 真用）见文件末尾：`FA-VERIFY-REACH-FINAL3`
 *    与 `FA-VERIFY-WAVE-5` 各自经源码复算抓到"`src/roles/**` 整包产品不可达"过期、
 *    以及"可达被写成像可用"（`research-citations` 只靠桶进闭包、零按名引用）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ADAPTER_DEPENDENCY_KINDS,
  BASE_ROLE_COUNT,
  BASE_ROLE_IDS,
  BASE_ROLES,
  BUSINESS_TEMPLATE_COUNT,
  BUSINESS_TEMPLATE_IDS,
  BUSINESS_TEMPLATES,
  DATA_SCOPE_LEVELS,
  EXPERIENCE_STRATEGIES,
  FILE_FORMAT_KINDS,
  IMPLEMENTATIONS,
  PLUGIN_CATALOG,
  PACKAGE_FORBIDDEN_CAPABILITIES,
  createBaseRoleManifest,
  createBusinessTemplateManifest,
  createPluginManifest,
  findPluginManifest,
  isFileFormat,
  validateDeclarativePackage,
  type PluginManifest,
} from './index.js';
import { TEMPLATE_KINDS, TEMPLATE_KIND_EXTENSIONS } from '../protocol/index.js';

/** 取一个必定存在的清单（查不到直接抛，避免 `undefined` 悄悄污染断言）。 */
function mustFind(pluginId: string): PluginManifest {
  const manifest = findPluginManifest(pluginId);
  if (manifest === undefined) {
    throw new Error(`注册目录里缺 ${pluginId}`);
  }
  return manifest;
}

/** 不产出任何 OOXML 的四个业务模板（R232 的负例对象）。 */
const NON_OFFICE_TEMPLATE_IDS = [
  'template.meituan',
  'template.clock',
  'template.calendar',
  'template.research',
] as const;

describe('R232：文件格式与模板分开建模', () => {
  it('文件类型枚举只有 docx / xlsx / pptx，且从 protocol 派生（单一来源）', () => {
    expect(FILE_FORMAT_KINDS).toEqual(['docx', 'xlsx', 'pptx']);
    expect(FILE_FORMAT_KINDS).toEqual(TEMPLATE_KINDS.map((kind) => TEMPLATE_KIND_EXTENSIONS[kind]));
    expect(FILE_FORMAT_KINDS).toHaveLength(3);
  });

  it('美团 / 时钟 / 日历 / 资料检索不在文件类型枚举里', () => {
    for (const id of NON_OFFICE_TEMPLATE_IDS) {
      const name = id.replace('template.', '');
      expect(FILE_FORMAT_KINDS).not.toContain(name);
      expect(FILE_FORMAT_KINDS).not.toContain(id);
      expect(isFileFormat(name)).toBe(false);
    }
  });

  it('四个非办公模板不产出任何文件格式，产出集与文件类型枚举无交集', () => {
    for (const id of NON_OFFICE_TEMPLATE_IDS) {
      const manifest = mustFind(id);
      expect(manifest.kind).toBe('business_template');
      if (manifest.kind !== 'business_template') continue;
      expect(manifest.produces_file_formats).toEqual([]);
      for (const format of manifest.produces_file_formats) {
        expect(FILE_FORMAT_KINDS).not.toContain(format);
      }
    }
  });

  it('资料检索的输入资料格式（consumes）含 pdf 等，但 pdf 不是文件格式、也不产出', () => {
    const research = mustFind('template.research');
    if (research.kind !== 'business_template') throw new Error('research 必须是业务模板');
    expect(research.consumes_formats).toContain('pdf');
    expect(research.produces_file_formats).toEqual([]);
    expect(FILE_FORMAT_KINDS).not.toContain('pdf');
    expect(isFileFormat('pdf')).toBe(false);
  });

  it('把业务模板名塞进 produces_file_formats 会被构造期拒掉', () => {
    expect(() =>
      createBusinessTemplateManifest({
        kind: 'business_template',
        plugin_id: 'template.meituan',
        display_name: '美团',
        version: '0.1.0',
        kernel_compatibility: { min_version: '0.9.0', max_version: null },
        capabilities: [{ capability_id: 'cap.x', label: 'x', description: 'x' }],
        instructions: ['i'],
        inputs: [{ name: 'q', kind: 'query', description: 'q', formats: [] }],
        outputs: [{ name: 'r', kind: 'query', description: 'r', formats: [] }],
        adapter_dependencies: [],
        permissions: [],
        data_scope: { level: 'external', detail: 'x' },
        experience_policy: { strategy: 'none', detail: 'x' },
        install_source: { kind: 'builtin', origin: 'builtin' },
        implementation: 'stub',
        stub_reason: 'stub',
        produces_file_formats: ['meituan'], // ← 违规
        consumes_formats: [],
      }),
    ).toThrow(/不是合法文件格式/);
  });
});

describe('注册目录（PLG-01 / R227 / R200）', () => {
  it('恰好七个业务模板与三个基础角色，且 id 与封闭枚举一致', () => {
    expect(BUSINESS_TEMPLATE_COUNT).toBe(7);
    expect(BASE_ROLE_COUNT).toBe(3);
    expect(BUSINESS_TEMPLATES.map((m) => m.plugin_id)).toEqual([...BUSINESS_TEMPLATE_IDS]);
    expect(BASE_ROLES.map((m) => m.plugin_id)).toEqual([...BASE_ROLE_IDS]);
    expect(PLUGIN_CATALOG).toHaveLength(10);
  });

  it('模板与角色分属两个不同枚举 / 类型（R200），id 集不重叠', () => {
    const templateIds = new Set<string>(BUSINESS_TEMPLATE_IDS);
    const roleIds = new Set<string>(BASE_ROLE_IDS);
    for (const id of roleIds) {
      expect(templateIds.has(id)).toBe(false);
    }
    // 两种清单形状由 kind 区分；角色没有文件格式字段。
    for (const role of BASE_ROLES) {
      expect(role.kind).toBe('base_role');
      expect('produces_file_formats' in role).toBe(false);
      expect(role.runtime_identity.length).toBeGreaterThan(0);
    }
  });

  it('三个办公模板各自产出恰好一种文件格式', () => {
    const expectations: readonly [string, string][] = [
      ['template.document', 'docx'],
      ['template.spreadsheet', 'xlsx'],
      ['template.presentation', 'pptx'],
    ];
    for (const [id, format] of expectations) {
      const manifest = mustFind(id);
      if (manifest.kind !== 'business_template') throw new Error(`${id} 必须是业务模板`);
      expect(manifest.produces_file_formats).toEqual([format]);
      expect(FILE_FORMAT_KINDS).toContain(format);
    }
  });

  it('每条清单都齐备 R227 要求的字段（版本 / 内核兼容 / 能力 / 指令 / 输入输出 / 依赖 / 权限 / 数据范围 / 经验策略）', () => {
    for (const manifest of PLUGIN_CATALOG) {
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(manifest.kernel_compatibility.min_version).toMatch(/^\d+\.\d+\.\d+/);
      expect(manifest.capabilities.length).toBeGreaterThan(0);
      expect(manifest.instructions.length).toBeGreaterThan(0);
      expect(manifest.inputs.length + manifest.outputs.length).toBeGreaterThan(0);
      expect(DATA_SCOPE_LEVELS).toContain(manifest.data_scope.level);
      expect(EXPERIENCE_STRATEGIES).toContain(manifest.experience_policy.strategy);
      expect(IMPLEMENTATIONS).toContain(manifest.implementation);
      for (const dependency of manifest.adapter_dependencies) {
        expect(ADAPTER_DEPENDENCY_KINDS).toContain(dependency.kind);
      }
    }
  });

  it('能力 ID 在整个目录里唯一（能力发现不得有歧义）', () => {
    const seen = new Set<string>();
    for (const manifest of PLUGIN_CATALOG) {
      for (const capability of manifest.capabilities) {
        expect(seen.has(capability.capability_id)).toBe(false);
        seen.add(capability.capability_id);
      }
    }
  });

  it('R233：stub 清单必带原因，real 清单不得带原因；四个适配器模板是 stub', () => {
    for (const manifest of PLUGIN_CATALOG) {
      if (manifest.implementation === 'stub') {
        expect(typeof manifest.stub_reason).toBe('string');
        expect((manifest.stub_reason ?? '').length).toBeGreaterThan(0);
      } else {
        expect(manifest.stub_reason).toBeNull();
      }
    }
    for (const id of NON_OFFICE_TEMPLATE_IDS) {
      expect(mustFind(id).implementation).toBe('stub');
    }
    for (const id of ['template.document', 'template.spreadsheet', 'template.presentation']) {
      expect(mustFind(id).implementation).toBe('real');
    }
  });
});

describe('清单结构校验（R228 只有名字不算可用 / R233 stub 标识）', () => {
  const base = {
    kind: 'business_template',
    plugin_id: 'template.document',
    display_name: '文档',
    version: '1.0.0',
    kernel_compatibility: { min_version: '0.9.0', max_version: null },
    capabilities: [{ capability_id: 'cap.a', label: 'A', description: 'a' }],
    instructions: ['做点什么'],
    inputs: [{ name: 'facts', kind: 'fact', description: 'f', formats: [] }],
    outputs: [{ name: 'file', kind: 'file', description: 'o', formats: ['docx'] }],
    adapter_dependencies: [],
    permissions: [],
    data_scope: { level: 'task', detail: 'x' },
    experience_policy: { strategy: 'candidate_review', detail: 'x' },
    install_source: { kind: 'builtin', origin: 'builtin' },
    implementation: 'real',
    stub_reason: null,
    produces_file_formats: ['docx'],
    consumes_formats: [],
  } as const;

  it('只有名字 / 没有能力声明 ⇒ 拒（R228）', () => {
    expect(() => createBusinessTemplateManifest({ ...base, capabilities: [] })).toThrow(/R228|capabilities 不能为空/);
  });

  it('没有输入输出端口 ⇒ 拒', () => {
    expect(() => createBusinessTemplateManifest({ ...base, inputs: [], outputs: [] })).toThrow(/输入或输出端口/);
  });

  it('stub 不带原因 ⇒ 拒（R233）', () => {
    expect(() =>
      createBusinessTemplateManifest({ ...base, implementation: 'stub', stub_reason: null }),
    ).toThrow(/stub_reason/);
  });

  it('real 带原因 ⇒ 拒（含糊标注不可接受）', () => {
    expect(() =>
      createBusinessTemplateManifest({ ...base, implementation: 'real', stub_reason: '其实是 stub' }),
    ).toThrow(/不得携带 stub_reason/);
  });

  it('内核兼容区间倒置 ⇒ 拒', () => {
    expect(() =>
      createBusinessTemplateManifest({
        ...base,
        kernel_compatibility: { min_version: '1.0.0', max_version: '0.5.0' },
      }),
    ).toThrow(/空区间无意义/);
  });

  it('版本号形状非法 ⇒ 拒', () => {
    expect(() => createBusinessTemplateManifest({ ...base, version: 'v1' })).toThrow(/major\.minor\.patch/);
  });

  it('角色清单必须有 runtime_identity，且不接受文件格式字段', () => {
    expect(() =>
      createBaseRoleManifest({
        kind: 'base_role',
        plugin_id: 'role.front_agent',
        display_name: '前台',
        version: '1.0.0',
        kernel_compatibility: { min_version: '0.9.0', max_version: null },
        capabilities: [{ capability_id: 'cap.r', label: 'r', description: 'r' }],
        instructions: ['i'],
        inputs: [{ name: 't', kind: 'text', description: 't', formats: [] }],
        outputs: [{ name: 'o', kind: 'text', description: 'o', formats: [] }],
        adapter_dependencies: [],
        permissions: [],
        data_scope: { level: 'user', detail: 'x' },
        experience_policy: { strategy: 'none', detail: 'x' },
        install_source: { kind: 'builtin', origin: 'builtin' },
        implementation: 'stub',
        stub_reason: '未实现',
        // runtime_identity 缺失
      }),
    ).toThrow(/runtime_identity/);
  });

  it('createPluginManifest 按 kind 分派，未知 kind ⇒ 拒', () => {
    expect(() => createPluginManifest({ kind: 'nope' })).toThrow(/kind/);
  });
});

describe('R229：声明式包内容校验', () => {
  const cleanManifest = mustFind('template.document');

  function packageWith(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      package_id: 'pkg.demo',
      version: '1.0.0',
      install_source: { kind: 'declarative_package', origin: 'controlled-dir/pkg.demo' },
      requested_capabilities: [] as readonly string[],
      manifest: cleanManifest,
      ...overrides,
    };
  }

  it('干净声明式包通过，并带出规范化清单', () => {
    const result = validateDeclarativePackage(packageWith({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.package.package_id).toBe('pkg.demo');
      expect(result.package.manifest.plugin_id).toBe('template.document');
    }
  });

  it('申请禁止能力（任意代码执行 / 装依赖 / 起 MCP / 任意拉取）一律拒', () => {
    for (const capability of PACKAGE_FORBIDDEN_CAPABILITIES) {
      const result = validateDeclarativePackage(packageWith({ requested_capabilities: [capability] }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejections.map((r) => r.code)).toContain('forbidden_capability');
      }
    }
  });

  it('夹带脚本 ⇒ 拒', () => {
    const result = validateDeclarativePackage(packageWith({ embedded_scripts: ['evil.js'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections.map((r) => r.code)).toContain('embedded_script');
    }
  });

  it('来源不是受控声明式包 ⇒ 拒（按内置来源伪装安装不接受）', () => {
    const result = validateDeclarativePackage(
      packageWith({ install_source: { kind: 'builtin', origin: 'builtin' } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections.map((r) => r.code)).toContain('invalid_source');
    }
  });

  it('内嵌清单非法 ⇒ 拒，且不抛错（结构化拒绝）', () => {
    const result = validateDeclarativePackage(packageWith({ manifest: { kind: 'business_template' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections.map((r) => r.code)).toContain('invalid_manifest');
    }
  });

  it('非对象 ⇒ 结构化拒绝，不抛错', () => {
    const result = validateDeclarativePackage(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections[0]?.code).toBe('invalid_package');
    }
  });
});

// ---------------------------------------------------------------------------
// 防复发判据：注册目录的「路径声明」必须与代码树一致
// ---------------------------------------------------------------------------
//
// 背景（第三轮独立验证 `independent-report-3.md`）：`catalog.ts` 是**产品可达**的
// （`apps/demo/server/plugin-routes.ts` 把 `implementation` / `is_stub` / 未就绪原因呈现给用户），
// 而它曾以 `stub_reason` 对用户称"基线提交无 src/adapters/research/**"——那个目录当时已有 29 个
// 模块。**目录对用户说假话**比缺功能更糟：它让用户以为能力不存在。
//
// 本组判据把"目录说过的话"和"代码树"钉在一起，两个方向都查：
//   ① 描述以「无 / 不存在 / 未见 / 尚无 / 未找到 / 没有」断言某条 `src/**` 路径不存在
//      ⇒ 该路径必须**真的不存在**（否则报红）；
//   ② 描述以「已存在 / 已有 / 存在 / 落地在 / 位于 / 已实现 / 已落地」断言某条路径存在
//      ⇒ 该路径必须**真的存在**（否则报红）。
// 另有一条结构性要求：每条 **stub 清单必须在 `stub_reason` 里点名承载路径**——只有点名了，
// "承载代码到底在不在"才是可核对的（否则"未见专用模块"这类话无法被机器证伪）。

/** `catalog.test.ts` → `src/plugins/catalog.ts` → 仓库根。 */
const CATALOG_SOURCE = fileURLToPath(new URL('./catalog.ts', import.meta.url));
const REPO_ROOT = resolve(dirname(CATALOG_SOURCE), '..', '..');

/** 断言"不存在"的措辞。注意：必须先于 PRESENT 匹配（`不存在` 含 `存在`）。 */
const ABSENT_MARKERS = ['无', '不存在', '未见', '尚无', '未找到', '没有'] as const;
/** 断言"存在"的措辞。 */
const PRESENT_MARKERS = ['已存在', '已有', '存在', '落地在', '位于', '已实现', '已落地'] as const;
/** 措辞与路径之间允许出现的分隔符 / 修饰符（含 markdown 的 `*` 与反引号）。 */
const SEPARATORS = /[\s（()）【】\[\]、,，:：;；—\-*`"'”“‘’·]/;

type ClaimKind = 'absent' | 'present';

interface PathClaim {
  readonly id: string;
  readonly path: string;
  readonly kind: ClaimKind;
  readonly excerpt: string;
}

interface ClaimViolation {
  readonly id: string;
  readonly path: string;
  readonly detail: string;
}

/**
 * 从一段描述里抽出所有「对某条 `src/**` 路径的存在性断言」。
 *
 * **只是解析**（纯函数、零 IO）：判定真假由 {@link auditPathClaims} 用注入的
 * `pathExists` 完成，这样反向对照可以喂假目录树。
 */
function extractPathClaims(id: string, text: string): readonly PathClaim[] {
  const claims: PathClaim[] = [];
  for (const match of text.matchAll(/src\/[A-Za-z0-9_\-./*]+/g)) {
    const raw = match[0];
    const index = match.index ?? 0;
    let prefix = text.slice(Math.max(0, index - 24), index);
    while (prefix.length > 0 && SEPARATORS.test(prefix.charAt(prefix.length - 1))) {
      prefix = prefix.slice(0, -1);
    }
    let kind: ClaimKind | null = null;
    for (const marker of ABSENT_MARKERS) {
      if (prefix.endsWith(marker)) {
        kind = 'absent';
        break;
      }
    }
    if (kind === null) {
      for (const marker of PRESENT_MARKERS) {
        if (prefix.endsWith(marker)) {
          kind = 'present';
          break;
        }
      }
    }
    if (kind === null) continue;
    const path = raw.replace(/[*.\s]+$/, '').replace(/\/+$/, '');
    if (path.length === 0) continue;
    claims.push(Object.freeze({ id, path, kind, excerpt: text.slice(Math.max(0, index - 24), index + raw.length) }));
  }
  return Object.freeze(claims);
}

/** 逐条核对断言与目录树；返回矛盾（空数组 = 一致）。 */
function auditPathClaims(
  claims: readonly PathClaim[],
  pathExists: (path: string) => boolean,
): readonly ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const claim of claims) {
    const exists = pathExists(claim.path);
    if (claim.kind === 'absent' && exists) {
      violations.push({
        id: claim.id,
        path: claim.path,
        detail: `描述称"${claim.path}"不存在，但代码树里它存在（原文：${claim.excerpt}）`,
      });
    }
    if (claim.kind === 'present' && !exists) {
      violations.push({
        id: claim.id,
        path: claim.path,
        detail: `描述称"${claim.path}"存在，但代码树里没有它（原文：${claim.excerpt}）`,
      });
    }
  }
  return Object.freeze(violations);
}

/** 每条 stub 必须**点名**的承载路径声明（R233 的可核对化）。 */
interface StubAudit {
  readonly id: string;
  readonly missing_carrier_pointer: boolean;
  readonly violations: readonly ClaimViolation[];
}

function auditStubCarrierPointers(manifests: readonly PluginManifest[], pathExists: (p: string) => boolean): readonly StubAudit[] {
  const audits: StubAudit[] = [];
  for (const manifest of manifests) {
    if (manifest.implementation !== 'stub') continue;
    const claims = extractPathClaims(manifest.plugin_id, manifest.stub_reason ?? '');
    audits.push({
      id: manifest.plugin_id,
      // "点名承载路径"= 至少有**一条**存在性断言，且其中至少一条是"存在"。
      missing_carrier_pointer:
        claims.length === 0 || !claims.some((claim) => claim.kind === 'present'),
      violations: auditPathClaims(claims, pathExists),
    });
  }
  return Object.freeze(audits);
}

describe('防复发：注册目录的路径声明必须与代码树一致', () => {
  const pathExists = (path: string): boolean => existsSync(join(REPO_ROOT, path));

  /** 七条未就绪清单（四条适配器型模板 + 三个基础角色）。 */
  const STUB_MANIFEST_IDS = [
    'template.meituan',
    'template.clock',
    'template.calendar',
    'template.research',
    'role.front_agent',
    'role.group_follower',
    'role.experience_maintainer',
  ] as const;

  it('每条 stub_reason 对 src/** 的存在性断言都与代码树一致', () => {
    const claims = PLUGIN_CATALOG.flatMap((manifest) =>
      extractPathClaims(manifest.plugin_id, manifest.stub_reason ?? ''),
    );
    expect(auditPathClaims(claims, pathExists)).toEqual([]);
  });

  it('`catalog.ts` 模块文档里的存在性断言同样与代码树一致（防"文档里又说一遍假话"）', () => {
    const source = readFileSync(CATALOG_SOURCE, 'utf8');
    expect(auditPathClaims(extractPathClaims('catalog.ts', source), pathExists)).toEqual([]);
  });

  it('七条未就绪清单都点名了真实存在的承载路径（判据非空跑）', () => {
    const audits = auditStubCarrierPointers(PLUGIN_CATALOG, pathExists);
    expect(audits.map((audit) => audit.id)).toEqual([...STUB_MANIFEST_IDS]);
    for (const audit of audits) {
      expect(audit.missing_carrier_pointer, `${audit.id} 未在 stub_reason 里点名承载路径`).toBe(false);
      expect(audit.violations).toEqual([]);
    }
  });

  it('stub 清单必须点名承载路径：路径没了 / 缺"存在"断言都要报红', () => {
    // 旧文本（第三轮验证抓到的真事故）：声称适配器不存在，且不点名任何承载模块。
    const staleStubReason = '本增量未见检索适配器实现（基线提交无 src/adapters/research/**）；按 R233 标 stub。';
    const claims = extractPathClaims('template.research', staleStubReason);
    // 它有路径断言，但方向是"不存在"⇒ 缺"存在"断言 ⇒ 被判缺承载指认，且同时构成假话。
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((claim) => claim.kind === 'present')).toBe(false);
    expect(auditPathClaims(claims, pathExists)).toHaveLength(1);

    // 完全没有路径的旧角色措辞：连核对都无从谈起 ⇒ 也判缺承载指认。
    const pathlessStubReason = '本增量未见可指认的群内分身专用运行时模块；未单独核实。';
    expect(extractPathClaims('role.group_follower', pathlessStubReason)).toHaveLength(0);
  });

  it('反向对照①：把已过期的"无 src/adapters/research/**"写回来 ⇒ 判据报红', () => {
    const stale = '本增量未见检索适配器实现（基线提交无 src/adapters/research/**）；按 R233 标 stub。';
    const violations = auditPathClaims(extractPathClaims('template.research', stale), pathExists);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('src/adapters/research');
    expect(violations[0]?.detail).toContain('不存在');
  });

  it('反向对照②：谎称某条不存在的路径存在 ⇒ 判据同样报红', () => {
    const lie = '承载模块已存在：src/adapters/nonexistent/**。';
    const violations = auditPathClaims(extractPathClaims('template.demo', lie), pathExists);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('src/adapters/nonexistent');
  });

  it('反向对照③：换一条真实存在的路径来"错过期话" ⇒ 不报红（判据不误伤真话）', () => {
    const truth = '承载模块已存在：src/adapters/meituan/**。';
    expect(auditPathClaims(extractPathClaims('template.meituan', truth), pathExists)).toEqual([]);
  });

  it('反向对照④：注入假目录树（路径其实不存在）⇒ "存在"断言报红、"不存在"断言反而成立', () => {
    const missing = (): boolean => false;
    const presentClaim = '承载模块已存在：src/roles/main-agent.ts。';
    expect(auditPathClaims(extractPathClaims('role.front_agent', presentClaim), missing)).toHaveLength(1);
    const absentClaim = '本增量未见 src/roles/main-agent.ts。';
    expect(auditPathClaims(extractPathClaims('role.front_agent', absentClaim), missing)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 防复发判据（第二组）：注册目录的「可达 / 真用」声明必须与产品闭包一致
// ---------------------------------------------------------------------------
//
// 背景（`FA-VERIFY-REACH-FINAL3` / `FA-VERIFY-WAVE-5` 各自经源码复算报出的两处不实陈述）：
//
//   ① `catalog.ts` 曾对用户称 `src/roles/**` 整包「产品不可达」——`apps/demo/server/roles-wiring.ts`
//      真接线后已过期（5 个模块全部进入产品闭包，`/api/roles/reachability` 是真入口）；
//   ② 同文件称 `src/adapters/research/**` 29 个模块"全部产品可达（经 research-citations 接进产品入口）"
//      ——按 import 闭包**字面为真**，但 `src/session/adapters/research-citations.ts` 的导出在非测试
//      代码里**零按名引用**：它只被 `src/session/index.ts` 的 `export *` 桶拖进闭包。
//      "可达"读起来像"可用"，但它其实**没被真用**——**可达 ≠ 真用**。
//
// 所以把口径拆成三件事分别钉住，用四个**机器可核对**的标记（写法见 `catalog.ts` 头部）：
//
//   【产品不可达】  ⇒ 该路径（或 `pkg/**` 下每个非测试模块）**不在**产品闭包；
//   【产品可达】    ⇒ 在闭包内**且**有**非测试的按名引用**（桶 `export *` 不算）；
//   【真调用】      ⇒ 同【产品可达】的判据（"被真用"的那一档；本层不假装能静态判定运行时调用）；
//   【零按名引用】  ⇒ 真的**没有**非测试按名引用（可达但不真用的那一类要显式写出来）。
//
// 定义：「非测试」= 不是 `*.test.ts` / `*.spec.ts` / `__tests__/**`；「按名引用」= 对某条
// `import { X } from '<path>'`（含经桶转一手的按名引用）或 side-effect `import '<path>'`，
// 且 `X` 是该路径**导出**的某个名字。产品闭包 = 从 `apps/demo/server/main.ts` 出发的静态 import 图。

/** 产品入口（与 `catalog.ts` 头部所写的口径一致）。 */
const PRODUCT_ENTRY = 'apps/demo/server/main.ts';

const NAMED_IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const SIDE_IMPORT_RE = /(?:^|[^\w.])import\s+['"]([^'"]+)['"]/g;
const STAR_REEXPORT_RE = /(?:^|[^\w.])export\s*\*\s*from\s*['"]([^'"]+)['"]/g;

type ReachKind = 'unreachable' | 'reachable' | 'called' | 'no-named-ref';

/** 四个标记 → 判据档位（顺序即解析顺序；标记带 `【】` 括号，不会与正文撞车）。 */
const REACH_MARKERS: readonly (readonly [string, ReachKind])[] = [
  ['【产品不可达】', 'unreachable'],
  ['【产品可达】', 'reachable'],
  ['【真调用】', 'called'],
  ['【零按名引用】', 'no-named-ref'],
];

interface ReachClaim {
  readonly id: string;
  readonly path: string;
  /** `pkg/**` 形态（对该包下每个非测试模块生效）。 */
  readonly isPackage: boolean;
  readonly kind: ReachKind;
  readonly excerpt: string;
}

/** 某个路径（或包）的**可达性事实**——注入式，便于反向对照喂假世界。 */
interface ReachReality {
  readonly inProductClosure: (path: string) => boolean;
  readonly hasNamedReference: (path: string) => boolean;
  readonly modulesUnder: (pkgDir: string) => readonly string[];
}

function isTestRelative(rel: string): boolean {
  return /\.(test|spec)\.ts$/.test(rel) || rel.includes('/__tests__/');
}

function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split('\\').join('/');
}

/** 仓库里 `src/**` 与 `apps/**` 下的全部 `.ts`（相对 posix 路径）。 */
function sourceFilesOf(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (absoluteDir: string): void => {
    if (!existsSync(absoluteDir)) return;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.runtime') continue;
      const child = join(absoluteDir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts')) found.push(toRelative(root, child));
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'apps'));
  return found;
}

/**
 * 从**真实世界**推导"在产品闭包内、但非测试代码零按名引用"的活样本（可达 ≠ 真用的对象）。
 *
 * **不硬编码文件名**：本判据原先举 `src/presentations/shapes.ts`，它被 `ppt-media` 接线取得按名引用后，
 * 若继续钉住它，这条"咬得动真实事实"的断言就会腐烂成过期断言（本包修复的正是这次腐烂）。
 * 现改为每次现推样本：优先取 `src/**`，无样本时返回 `null`，由调用方**显式报红**——
 * 本判据失去真实对象就得重新设计，不得静默通过。
 */
function liveNoNamedRefSample(world: ReachReality, root: string): string | null {
  const hits = sourceFilesOf(root)
    .filter((rel) => !isTestRelative(rel) && world.inProductClosure(rel) && !world.hasNamedReference(rel))
    .sort();
  return hits.find((rel) => rel.startsWith('src/')) ?? hits[0] ?? null;
}

/** 把相对说明符解析到仓库内的 `.ts` 文件（`.js` → `.ts`，目录 → `index.ts`）。 */
function resolveSpecifier(root: string, fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(join(root, fromRel)), spec.replace(/\.(js|mjs|cjs)$/, ''));
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return toRelative(root, candidate);
  }
  return null;
}

/** 一条已解析的 import / re-export 边。 */
interface ParsedEdge {
  readonly spec: string;
  /** 解析到的仓库内 `.ts`（非相对说明符 / 解析失败为 `null`）。 */
  readonly target: string | null;
  /** `import { A, B }` 里的按名绑定（已剥 `type` 前缀）。 */
  readonly named: readonly string[];
  readonly sideEffect: boolean;
  readonly starReexport: boolean;
}

/** 解析单个文件的全部相对边（每文件只扫一次，供闭包与按名引用共用）。 */
function parseEdgesOf(root: string, rel: string, source: string): readonly ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const named = (match[1] ?? '')
      .split(',')
      .map((piece) => piece.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    const spec = match[2] ?? '';
    edges.push({ spec, target: resolveSpecifier(root, rel, spec), named, sideEffect: false, starReexport: false });
  }
  for (const match of source.matchAll(STAR_REEXPORT_RE)) {
    const spec = match[1] ?? '';
    edges.push({ spec, target: resolveSpecifier(root, rel, spec), named: [], sideEffect: false, starReexport: true });
  }
  for (const match of source.matchAll(SIDE_IMPORT_RE)) {
    const spec = match[1] ?? '';
    edges.push({ spec, target: resolveSpecifier(root, rel, spec), named: [], sideEffect: true, starReexport: false });
  }
  return edges;
}

interface ReachWorld extends ReachReality {
  readonly closure: ReadonlySet<string>;
}

/** 建立判据世界：产品闭包 + 按名引用事实（全部由真实源码树算出）。 */
function loadReachWorld(root: string): ReachWorld {
  const files = sourceFilesOf(root);
  const edges = new Map<string, readonly ParsedEdge[]>();
  for (const rel of files) {
    let source: string;
    try {
      source = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue; // 读不到就当它没有边（不假装有）。
    }
    edges.set(rel, parseEdgesOf(root, rel, source));
  }
  const edgesOf = (rel: string): readonly ParsedEdge[] => edges.get(rel) ?? [];

  // ① 产品闭包（BFS）。
  const closure = new Set<string>([PRODUCT_ENTRY]);
  const queue: string[] = [PRODUCT_ENTRY];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of edgesOf(current)) {
      if (edge.target !== null && !closure.has(edge.target)) {
        closure.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  // ② 导出名（含经 `export * from` 转手的名字；带 memo 防环）。
  const nameCache = new Map<string, ReadonlySet<string>>();
  const exportedNamesOf = (rel: string, stack: ReadonlySet<string> = new Set()): ReadonlySet<string> => {
    const cached = nameCache.get(rel);
    if (cached !== undefined) return cached;
    const names = new Set<string>();
    if (!stack.has(rel)) {
      const nextStack = new Set(stack);
      nextStack.add(rel);
      let source: string;
      try {
        source = readFileSync(join(root, rel), 'utf8');
      } catch {
        source = '';
      }
      for (const match of source.matchAll(
        /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
      )) {
        names.add(match[1] as string);
      }
      for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of (match[1] ?? '').split(',')) {
          const name = part.split(/\s+as\s+/).pop()?.trim() ?? '';
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      }
      for (const edge of edgesOf(rel)) {
        if (edge.starReexport && edge.target !== null) {
          for (const name of exportedNamesOf(edge.target, nextStack)) names.add(name);
        }
      }
    }
    const frozen: ReadonlySet<string> = new Set(names);
    nameCache.set(rel, frozen);
    return frozen;
  };

  // 某路径的**非测试按名引用**：直连 or 经"桶"（`export * from` 它的文件）转一手的按名引用。
  const referenceCache = new Map<string, readonly string[]>();
  const namedReferenceFiles = (rel: string): readonly string[] => {
    const cached = referenceCache.get(rel);
    if (cached !== undefined) return cached;
    const names = exportedNamesOf(rel);
    const barrels = new Set<string>([rel]);
    for (const file of files) {
      if (file === rel) continue;
      if (edgesOf(file).some((edge) => edge.starReexport && edge.target === rel)) barrels.add(file);
    }
    const hits: string[] = [];
    for (const file of files) {
      if (file === rel || isTestRelative(file) || !closure.has(file)) continue;
      for (const edge of edgesOf(file)) {
        if (edge.target === null) continue;
        if (edge.sideEffect && edge.target === rel) hits.push(`${file} side-effect import`);
        if (!barrels.has(edge.target)) continue;
        const used = edge.named.filter((name) => names.has(name));
        if (used.length > 0) hits.push(`${file} 按名引用 ${used.join('、')}`);
      }
    }
    const frozen = Object.freeze(hits);
    referenceCache.set(rel, frozen);
    return frozen;
  };

  const modulesUnder = (pkgDir: string): readonly string[] =>
    files.filter((rel) => rel.startsWith(`${pkgDir}/`) && !isTestRelative(rel)).sort();

  return {
    closure,
    inProductClosure: (path) => closure.has(path),
    hasNamedReference: (path) => namedReferenceFiles(path).length > 0,
    modulesUnder,
  };
}

/** 把 `stub_reason` / 文档注释里的换行与行首 `*` 抹平，好按子句解析。 */
function flattenComment(text: string): string {
  // 只剥**注释边界**（开头的 `/**`、结尾的 `*/`）与每行行首的 `*`——
  // 绝不能全局替换 `/**`，否则会把 `src/roles/**` 这种**包路径通配**也吃掉。
  return text
    .replace(/^\s*\/\*\*/, '')
    .replace(/\*\/\s*$/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ');
}

/**
 * 从一段文字里抽出全部「可达性 / 真用」断言。
 *
 * 解析口径（纯函数、零 IO）：按 `。；` 切子句；子句里出现标记时，把该子句里的每条
 * `src/**` / `apps/**` 路径**绑到最近的标记**上。因此写目录时**一个子句只放一个标记**。
 */
function extractReachClaims(id: string, text: string): readonly ReachClaim[] {
  const claims: ReachClaim[] = [];
  for (const clause of flattenComment(text).split(/[。；]/)) {
    const markers: { index: number; kind: ReachKind; token: string }[] = [];
    for (const [token, kind] of REACH_MARKERS) {
      let from = 0;
      for (;;) {
        const index = clause.indexOf(token, from);
        if (index < 0) break;
        markers.push({ index, kind, token });
        from = index + token.length;
      }
    }
    if (markers.length === 0) continue;
    for (const match of clause.matchAll(/(?:src|apps)\/[A-Za-z0-9_\-./*]+/g)) {
      const raw = match[0];
      const index = match.index ?? 0;
      let nearest = markers[0] as { index: number; kind: ReachKind; token: string };
      for (const marker of markers) {
        const distance = Math.abs(marker.index - index);
        if (distance < Math.abs(nearest.index - index)) nearest = marker;
      }
      const isPackage = raw.includes('*');
      const path = raw.replace(/\/\*+$/, '').replace(/\/+$/, '');
      if (path.length === 0) continue;
      claims.push(
        Object.freeze({
          id,
          path,
          isPackage,
          kind: nearest.kind,
          excerpt: clause.slice(Math.max(0, index - 16), index + raw.length + 16),
        }),
      );
    }
  }
  return Object.freeze(claims);
}

/** 逐条核对断言与判据世界；返回矛盾（空数组 = 一致）。 */
function auditReachClaims(claims: readonly ReachClaim[], reality: ReachReality): readonly string[] {
  const violations: string[] = [];
  // 被显式判为"不可达"的模块：包级【产品可达】/【真调用】断言应把它们排除（否则同一份描述自相矛盾）。
  const declaredUnreachable = new Set(
    claims.filter((claim) => claim.kind === 'unreachable').map((claim) => claim.path),
  );
  for (const claim of claims) {
    const members = claim.isPackage ? reality.modulesUnder(claim.path) : [claim.path];
    if (claim.isPackage && members.length === 0) {
      violations.push(
        `[${claim.id}] 包断言"${claim.path}/**"下方没有任何可核对的非测试模块（空跑，无法证伪）：${claim.excerpt}`,
      );
      continue;
    }
    for (const member of members) {
      const inClosure = reality.inProductClosure(member);
      const named = reality.hasNamedReference(member);
      if (claim.kind === 'unreachable') {
        if (inClosure) {
          violations.push(
            `[${claim.id}] 描述称"${member}"【产品不可达】，但它其实在产品闭包内：${claim.excerpt}`,
          );
        }
        continue;
      }
      if (claim.kind === 'no-named-ref') {
        if (named) {
          violations.push(
            `[${claim.id}] 描述称"${member}"【零按名引用】，但它其实被非测试代码按名引用：${claim.excerpt}`,
          );
        }
        continue;
      }
      // reachable / called
      if (declaredUnreachable.has(member)) continue;
      if (!inClosure) {
        violations.push(
          `[${claim.id}] 描述称"${member}"【${claim.kind === 'called' ? '真调用' : '产品可达'}】，但它不在产品闭包内：${claim.excerpt}`,
        );
        continue;
      }
      if (!named) {
        violations.push(
          `[${claim.id}] 描述称"${member}"【${claim.kind === 'called' ? '真调用' : '产品可达'}】，` +
            `但它在非测试代码里**没有按名引用**（只靠桶进闭包 ≠ 真用）：${claim.excerpt}`,
        );
      }
    }
  }
  return Object.freeze(violations);
}

/** `catalog.ts` 头部说明 + 每条 `stub_reason` 里的全部可达性断言。 */
function catalogReachClaims(): readonly ReachClaim[] {
  const source = readFileSync(CATALOG_SOURCE, 'utf8');
  const headerEnd = source.indexOf('*/');
  const header = headerEnd >= 0 ? source.slice(0, headerEnd + 2) : '';
  const claims: ReachClaim[] = [...extractReachClaims('catalog.ts 头部', header)];
  for (const manifest of PLUGIN_CATALOG) {
    claims.push(...extractReachClaims(manifest.plugin_id, manifest.stub_reason ?? ''));
  }
  return Object.freeze(claims);
}

describe('防复发②：注册目录的「可达 / 真用」声明必须与产品闭包一致', () => {
  const world = loadReachWorld(REPO_ROOT);

  it('catalog.ts 头部与全部 stub_reason 的可达性标记都与代码树一致（不可达真不可达、可达真有按名引用）', () => {
    expect(auditReachClaims(catalogReachClaims(), world)).toEqual([]);
  });

  it('判据非空跑：catalog 至少覆盖「真调用」与「产品可达」两档，且两档都有真实条目', () => {
    const claims = catalogReachClaims();
    const kinds = new Set(claims.map((claim) => claim.kind));
    // 这两档是当前真实目录里**确实存在**的两档，断言它们非空 —— 空集合上"覆盖"没有意义。
    expect(kinds.has('called')).toBe(true);
    expect(kinds.has('reachable')).toBe(true);
    expect(claims.filter((claim) => claim.kind === 'called').length).toBeGreaterThan(0);
    expect(claims.filter((claim) => claim.kind === 'reachable').length).toBeGreaterThan(0);

    // 【产品不可达】/【零按名引用】两档**当前为空**——这不是放宽，而是如实记录修复后的代码树：
    //   · 原标【产品不可达】的 7 个适配器模块（美团 6 + 时钟 reminder-restore）已由
    //     `apps/demo/server/adapters-extra-routes.ts` 从两个 barrel 按名 import 并接到真实 HTTP；
    //   · 原标【零按名引用】的两个会话适配器（cal-clock / research-citations）已由
    //     `apps/demo/server/session-adapters-wiring.ts` 按名调用。
    // 于是"产品不可达 / 零按名引用"在真实目录里再无对象可标（详见下方"咬得动真实事实"一条）。
    // 若某天这两类**重新出现**：含义是"可达但不真用"或"产品不可达"复发（某个模块又退回只有包内测试
    // 或被挤出闭包）——本断言会立刻变红，强制复核者确认新标记属实、而不是顺手写上去凑数。
    // （这两档确实仍有辨别力：代码树里现在**依然**存在真实例子，见下方"咬得动真实事实"。）
    expect(kinds.has('unreachable')).toBe(false);
    expect(kinds.has('no-named-ref')).toBe(false);
  });

  it('判据绑定正确（防"改成走空"）：真调用 / 产品可达锚点齐全，不可达与零按名引用两类当前为空', () => {
    const claims = catalogReachClaims();
    // 【真调用】锚点：五条产品接线入口都必须被点名（少一条说明描述漂了或被改空）。
    const called = new Set(claims.filter((claim) => claim.kind === 'called').map((claim) => claim.path));
    for (const anchor of [
      'apps/demo/server/roles-wiring.ts',
      'apps/demo/server/research-routes.ts',
      'apps/demo/server/adapters-host.ts',
      'apps/demo/server/adapters-extra-routes.ts',
      'apps/demo/server/session-adapters-wiring.ts',
    ]) {
      expect(called.has(anchor), `【真调用】锚点缺失：${anchor}`).toBe(true);
    }
    // 【产品可达】包级锚点：美团 / 时钟 / 日历 / 检索四个适配器包 + 角色包都必须在。
    const reachablePackages = new Set(
      claims.filter((claim) => claim.kind === 'reachable' && claim.isPackage).map((claim) => claim.path),
    );
    for (const pkg of [
      'src/adapters/meituan',
      'src/adapters/clock',
      'src/adapters/calendar',
      'src/adapters/research',
      'src/roles',
    ]) {
      expect(reachablePackages.has(pkg), `【产品可达】包锚点缺失：${pkg}`).toBe(true);
    }
    // 两类当前为空（原因见上一条断言上方注释）。
    expect(claims.filter((claim) => claim.kind === 'unreachable')).toEqual([]);
    expect(claims.filter((claim) => claim.kind === 'no-named-ref')).toEqual([]);
  });

  it('判据咬得动真实事实：原"产品不可达"的 7 个适配器模块已进闭包并按名引用；两档判据仍各有真实例子', () => {
    // ① roles 整包已经接线（旧描述"整包产品不可达"是过期话）。
    const roles = world.modulesUnder('src/roles');
    expect(roles).toHaveLength(5);
    for (const module of roles) expect(world.inProductClosure(module)).toBe(true);

    // ② 上一轮被判"产品不可达"的 7 个模块现在**既在闭包内、又有非测试按名引用**
    //    （`apps/demo/server/adapters-extra-routes.ts` 从两个 barrel 按名 import 并接到真实 HTTP）：
    //    它们已经从"只有包内测试引用"落进【真调用】那一档。
    for (const module of [
      'src/adapters/meituan/candidate-detail.ts',
      'src/adapters/meituan/candidate-model.ts',
      'src/adapters/meituan/compare.ts',
      'src/adapters/meituan/fact-publication.ts',
      'src/adapters/meituan/handoff-verify.ts',
      'src/adapters/meituan/share-intake.ts',
      'src/adapters/clock/reminder-restore.ts',
    ]) {
      expect(world.inProductClosure(module), `${module} 应已在产品闭包内`).toBe(true);
      expect(world.hasNamedReference(module), `${module} 应有非测试按名引用`).toBe(true);
    }

    // ③ 两个会话适配器同样已被按名调用（`session-adapters-wiring.ts`），不再"只靠桶进闭包"。
    for (const module of ['src/session/adapters/cal-clock.ts', 'src/session/adapters/research-citations.ts']) {
      expect(world.inProductClosure(module)).toBe(true);
      expect(world.hasNamedReference(module)).toBe(true);
    }

    // ④ 判据不是恒假：真被调用的接线模块确实有按名引用。
    expect(world.hasNamedReference('apps/demo/server/roles-wiring.ts')).toBe(true);

    // ⑤ 判据不是恒真，且"不可达 / 零按名引用"两档都没有变成空概念——树里各有真实例子：
    //    · 产品不可达：确有非测试模块不在产品闭包（如内核包入口 src/index.ts，demo 产品侧不 import 它）；
    //    · 零按名引用：闭包内仍存在非测试零按名引用的模块——这正是"可达 ≠ 真用"的活样本。
    //      样本**由世界现推**（`liveNoNamedRefSample`），不再钉死某个文件名。
    //    （这两档只是**当前 catalog 里**没有对象可标，不是判据失效。）
    const outsideClosure = sourceFilesOf(REPO_ROOT).filter(
      (rel) => !isTestRelative(rel) && !world.inProductClosure(rel),
    );
    expect(outsideClosure.length).toBeGreaterThan(0);

    // 样本迁移的事实记录：曾长期充当活样本的 shapes.ts 已被 `ppt-media` 接线取得按名引用，
    // 故它不再是"可达 ≠ 真用"的例子——这既是本次断言过期的根因，也是接线确实发生的正向事实。
    expect(world.inProductClosure('src/presentations/shapes.ts')).toBe(true);
    expect(world.hasNamedReference('src/presentations/shapes.ts')).toBe(true);

    // 现推的活样本必须真的满足"在闭包内 ∧ 零按名引用"，否则本判据失去真实对象。
    const noNamedRefSample = liveNoNamedRefSample(world, REPO_ROOT);
    expect(
      noNamedRefSample,
      '闭包内已无"零按名引用"的活样本：本判据失去真实对象，须重新设计而不是静默通过',
    ).not.toBeNull();
    expect(world.inProductClosure(noNamedRefSample as string)).toBe(true);
    expect(world.hasNamedReference(noNamedRefSample as string)).toBe(false);
  });

  it('反向对照①：把过期的"roles 整包【产品不可达】"写回来 ⇒ 逐模块报红', () => {
    const stale = '真实缺口：src/roles/** 整包【产品不可达】（5 个模块全在产品入口闭包之外）。';
    const violations = auditReachClaims(extractReachClaims('role.front_agent', stale), world);
    expect(violations).toHaveLength(5);
    expect(violations[0]).toContain('产品闭包内');
  });

  it('反向对照②：把"在闭包内但零按名引用"的模块谎称【真调用】⇒ 报红（可达 ≠ 真用）', () => {
    // 样本现推（原先钉死 shapes.ts，其被接线后本对照失去真实对象）。
    const sample = liveNoNamedRefSample(world, REPO_ROOT);
    expect(sample, '无"零按名引用"活样本：本反向对照失去真实对象').not.toBeNull();
    const lie = `接线入口【真调用】：${sample as string}。`;
    const violations = auditReachClaims(extractReachClaims('template.demo', lie), world);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('没有按名引用');
  });

  it('反向对照③：把真被调用的 roles-wiring 谎称【产品不可达】⇒ 报红', () => {
    const lie = '本模块【产品不可达】：apps/demo/server/roles-wiring.ts。';
    const violations = auditReachClaims(extractReachClaims('role.front_agent', lie), world);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('产品闭包内');
  });

  it('反向对照④：对真有按名引用的模块谎称【零按名引用】⇒ 报红', () => {
    const lie = 'src/session/adapters/xlsx.ts 自身【零按名引用】。';
    const violations = auditReachClaims(extractReachClaims('x', lie), world);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('零按名引用');
  });

  it('反向对照⑤：注入假闭包（全员不可达）⇒ "可达"断言报红、"不可达"断言反而成立', () => {
    const fake: ReachReality = {
      inProductClosure: () => false,
      hasNamedReference: () => false,
      modulesUnder: () => [],
    };
    expect(
      auditReachClaims(extractReachClaims('x', '接线入口【真调用】：apps/demo/server/roles-wiring.ts。'), fake),
    ).toHaveLength(1);
    expect(
      auditReachClaims(extractReachClaims('x', '【产品不可达】：apps/demo/server/roles-wiring.ts。'), fake),
    ).toEqual([]);
  });

  it('反向对照⑥：包断言指向不存在的目录 ⇒ 报"空跑"而不是静默通过', () => {
    const vacuous = '本包【产品不可达】：src/adapters/nonexistent-package/**。';
    const violations = auditReachClaims(extractReachClaims('x', vacuous), world);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('空跑');
  });
});
