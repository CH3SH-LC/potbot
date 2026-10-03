/**
 * KRN-04 上半 + KRN-05：**受约束的上下文组装**与**按能力目录动态选择必要模板 / 工具**。
 *
 * ## 这个文件要钉死的判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 只做表格的任务 ⇒ 只选 `template.spreadsheet`，PPT / 美团**不进上下文**，且渲染文本无其指令 | **反例**（无关模板必须缺席） |
 * | 2 | 同一批候选，需求改成"要 PPT" ⇒ PPT 被选入 | **正向对照**（证明筛选由需求驱动，不是黑名单） |
 * | 3 | 需求为空 ⇒ 一个模板都不选 | **反向对照**（证明"没选"来自需求匹配，不是碰巧） |
 * | 4 | stub 模板（美团）即使安装 / 启用 / 授权 / 探针全真 ⇒ 仍不可用，阻塞 `no_remedy` | **反例**（R233） |
 * | 5 | 已安装但未授权 ⇒ 阻塞 `template_not_ready` + 补救 `authorize_template`；经 `authorize_installed` 后**补入** | 正例 + **对照**（KRN-05 按授权补入） |
 * | 5b | 补救判定顺序**先 `installed`**：未安装 ⇒ `install_template`（不得误给 `authorize_template`，措辞不得说"已安装"）；未启用 ⇒ `enable_template`；依赖未就绪 ⇒ `ready_dependencies` | **反例 + 三向对照**（修复"未安装误判成未授权"） |
 * | 6 | 模板就绪但权限未授予 ⇒ 阻塞 `permission_not_granted`；授予后可选入 | 正例 |
 * | 7 | 模板数预算放不下必需模板 ⇒ **结构化阻塞**，不静默截断 | **反例** |
 * | 8 | 指令字符预算不足 ⇒ 阻塞；可选需求被放弃时进 `dropped_optional`（如实登记） | 正例 + 对照 |
 * | 9 | 渲染文本只含**被选中**模板的指令全文（无关模板的指令子串缺席） | **反例** |
 * | 10 | 组装确定性：输入顺序不同 ⇒ 同一 digest | 正例 |
 * | 11 | 预算参数不合法（0 / 非整数）⇒ 抛错（"没有上限"不是合法配置） | **反例** |
 * | 12 | 真实 `PluginRegistry` 投影：注册目录 → 候选 → 只选表格模板 | 集成正例 |
 *
 * ## 诚实边界
 *
 * 本层只做**组装**（选谁、放多少、缺什么给什么阻塞），**不调用真实模型、不执行工具**。
 * "模型在真实工具循环里按此上下文行事"属真实执行器证据，**不在本文件范围**。
 */

import { describe, expect, it } from 'vitest';

import { asCapabilityId, asLogicalTime } from '../protocol/index.js';
import { createPluginRegistry, conservativeProbes, type DependencyProbe, type SupportProbe } from '../plugins/index.js';
import {
  DEFAULT_CONTEXT_BUDGET,
  assembleContext,
  candidatesFromRegistry,
  renderContextText,
  validateBudget,
  type ContextTemplateCandidate,
} from './context-assembly.js';

const READY = Object.freeze({
  installed: true,
  enabled: true,
  authorized: true,
  dependencies_ready: true,
  actually_supported: true,
});

function candidate(
  plugin_id: string,
  capabilities: readonly string[],
  overrides: Partial<ContextTemplateCandidate> = {},
): ContextTemplateCandidate {
  return {
    plugin_id,
    kind: 'business_template',
    version: '1.0.0',
    states: READY,
    stub: false,
    stub_reason: null,
    capabilities: capabilities.map((id) => ({ capability_id: asCapabilityId(id), label: `${plugin_id}:${id}` })),
    instructions: [`${plugin_id} 的指令全文`],
    required_permissions: [],
    produces_file_formats: [],
    ...overrides,
  };
}

const SHEET = candidate('template.spreadsheet', ['cap.sheet.create', 'cap.sheet.formula']);
const SLIDES = candidate('template.presentation', ['cap.slide.create', 'cap.slide.theme']);
const MEITUAN = candidate('template.meituan', ['cap.meituan.search'], {
  stub: true,
  stub_reason: '本增量未见美团适配器实现',
});

describe('KRN-05：按能力目录动态选择必要模板（无关模板不进上下文）', () => {
  it('只做表格的任务：只选表格模板，PPT / 美团缺席且不在渲染文本里', () => {
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      candidates: [MEITUAN, SLIDES, SHEET],
      granted_permissions: [],
    });

    expect(context.selected_templates.map((template) => template.plugin_id)).toEqual(['template.spreadsheet']);
    expect(context.excluded_template_ids).toEqual(['template.meituan', 'template.presentation']);
    expect(context.selected_tools.map((tool) => tool.tool_id)).toEqual(['template.spreadsheet:cap.sheet.create']);

    // "无关模板不加入任务"在**渲染文本**上同样成立：PPT / 美团指令全文不得出现。
    const text = renderContextText(context);
    expect(text).toContain('template.spreadsheet 的指令全文');
    expect(text).not.toContain('template.presentation 的指令全文');
    expect(text).not.toContain('template.meituan 的指令全文');
  });

  it('正向对照：把需求换成"要 PPT" ⇒ PPT 被选入（筛选由需求驱动，不是黑名单）', () => {
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.slide.create'), required: true }],
      candidates: [MEITUAN, SLIDES, SHEET],
      granted_permissions: [],
    });

    expect(context.selected_templates.map((template) => template.plugin_id)).toEqual(['template.presentation']);
    expect(context.excluded_template_ids).toContain('template.spreadsheet');
  });

  it('反向对照：需求为空 ⇒ 一个模板都不选（"没选"来自需求匹配，不是碰巧）', () => {
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [],
      candidates: [MEITUAN, SLIDES, SHEET],
      granted_permissions: [],
    });

    expect(context.selected_templates).toHaveLength(0);
    expect(context.selected_tools).toHaveLength(0);
    expect(context.excluded_template_ids).toEqual([
      'template.meituan',
      'template.presentation',
      'template.spreadsheet',
    ]);
  });

  it('stub 模板永不选中：美团即使安装 / 启用 / 授权全真也阻塞且无可补救（R233）', () => {
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.meituan.search'), required: true }],
      candidates: [MEITUAN, SHEET],
      granted_permissions: [],
      authorize_installed: ['template.meituan'],
    });

    expect(context.selected_templates).toHaveLength(0);
    const blocker = context.blockers.find((entry) => entry.capability_id === asCapabilityId('cap.meituan.search'));
    expect(blocker?.code).toBe('capability_unavailable');
    expect(blocker?.remedy.kind).toBe('no_remedy');
    expect(blocker?.detail).toContain('stub');
  });

  it('缺能力（目录里没有承载实现）⇒ 结构化阻塞且不猜模板 id', () => {
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.unknown.thing'), required: true }],
      candidates: [SHEET],
      granted_permissions: [],
    });

    const blocker = context.blockers[0];
    expect(blocker?.code).toBe('capability_unavailable');
    expect(blocker?.plugin_id).toBeNull();
    expect(blocker?.remedy.kind).toBe('install_template');
  });
});

describe('KRN-05：缺权限 / 未授权 ⇒ 结构化阻塞，可按授权补入已安装模板', () => {
  it('已安装但未授权 ⇒ 阻塞 + 补救 authorize_template；补入后可选', () => {
    const uninstalledUnauthorized = candidate('template.document', ['cap.doc.create'], {
      states: { ...READY, authorized: false },
    });

    const blocked = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      candidates: [uninstalledUnauthorized],
      granted_permissions: [],
    });
    expect(blocked.selected_templates).toHaveLength(0);
    expect(blocked.blockers[0]?.code).toBe('template_not_ready');
    expect(blocked.blockers[0]?.remedy.kind).toBe('authorize_template');
    expect(blocked.blockers[0]?.detail).toContain('authorized=false');

    const supplemented = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      candidates: [uninstalledUnauthorized],
      granted_permissions: [],
      authorize_installed: ['template.document'],
    });
    expect(supplemented.selected_templates.map((template) => template.plugin_id)).toEqual(['template.document']);
    expect(supplemented.blockers).toHaveLength(0);
  });

  it('对照：授权补入**只对已安装模板**生效（未安装的模板不会因授权而可用）', () => {
    const notInstalled = candidate('template.document', ['cap.doc.create'], {
      states: { ...READY, installed: false, enabled: false, authorized: false },
    });
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      candidates: [notInstalled],
      granted_permissions: [],
      authorize_installed: ['template.document'],
    });
    expect(context.selected_templates).toHaveLength(0);
    expect(context.blockers[0]?.code).toBe('template_not_ready');
  });

  it('未安装的模板 ⇒ 补救是 install_template（**不得**误给 authorize_template，措辞不得说"已安装"）', () => {
    // 缺陷复现：未安装的模板 `authorized` **本来就是 false**。若 diagnoseUnavailable()
    // 先查 `false_states.includes('authorized')`，就会把"未安装"误判成"未授权"，
    // 给出 authorize_template —— 而"授权"对未安装的模板毫无意义，措辞还谎称"该模板已安装"。
    // 正解：**先判 installed**，未安装 ⇒ install_template。
    const notInstalled = candidate('template.document', ['cap.doc.create'], {
      states: { ...READY, installed: false, enabled: false, authorized: false },
    });
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      candidates: [notInstalled],
      granted_permissions: [],
      authorize_installed: ['template.document'],
    });
    expect(context.selected_templates).toHaveLength(0);
    expect(context.blockers[0]?.code).toBe('template_not_ready');
    expect(context.blockers[0]?.remedy.kind).toBe('install_template');
    expect(context.blockers[0]?.detail).toContain('installed=false');
    // 措辞不得对未安装的模板宣称"已安装"。
    expect(context.blockers[0]?.detail).not.toContain('已安装');
    expect(context.blockers[0]?.remedy.detail).not.toContain('已安装');
  });

  it('反向对照：已安装、已启用、未授权 ⇒ 仍是 authorize_template（修法不得把这条改坏）', () => {
    const authorized = candidate('template.document', ['cap.doc.create'], {
      states: { ...READY, authorized: false },
    });
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      candidates: [authorized],
      granted_permissions: [],
    });
    expect(context.blockers[0]?.remedy.kind).toBe('authorize_template');
    expect(context.blockers[0]?.detail).toContain('authorized=false');
    expect(context.blockers[0]?.remedy.detail).toContain('已安装');
  });

  it('反向对照：已安装但未启用 ⇒ enable_template', () => {
    const disabled = candidate('template.document', ['cap.doc.create'], {
      states: { ...READY, enabled: false },
    });
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      candidates: [disabled],
      granted_permissions: [],
    });
    expect(context.blockers[0]?.code).toBe('template_not_ready');
    expect(context.blockers[0]?.remedy.kind).toBe('enable_template');
    expect(context.blockers[0]?.detail).toContain('enabled=false');
  });

  it('反向对照：依赖未就绪 ⇒ ready_dependencies', () => {
    const missingDeps = candidate('template.document', ['cap.doc.create'], {
      states: { ...READY, dependencies_ready: false },
    });
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      candidates: [missingDeps],
      granted_permissions: [],
    });
    expect(context.blockers[0]?.code).toBe('template_not_ready');
    expect(context.blockers[0]?.remedy.kind).toBe('ready_dependencies');
    expect(context.blockers[0]?.detail).toContain('dependencies_ready=false');
  });

  it('模板就绪但权限未授予 ⇒ 阻塞 permission_not_granted；授予后可选入', () => {
    const needsWrite = candidate('template.spreadsheet', ['cap.sheet.create'], {
      required_permissions: ['perm.file.write'],
    });

    const blocked = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      candidates: [needsWrite],
      granted_permissions: [],
    });
    expect(blocked.blockers[0]?.code).toBe('permission_not_granted');
    expect(blocked.blockers[0]?.remedy.kind).toBe('grant_permission');

    const granted = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      candidates: [needsWrite],
      granted_permissions: ['perm.file.write'],
    });
    expect(granted.selected_templates).toHaveLength(1);
    expect(granted.blockers).toHaveLength(0);
  });
});

describe('KRN-04 上半：受约束的上下文预算（不把全部模板全文塞进去）', () => {
  it('必需模板放不下模板数预算 ⇒ 结构化阻塞，不静默截断', () => {
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [
        { capability_id: asCapabilityId('cap.sheet.create'), required: true },
        { capability_id: asCapabilityId('cap.slide.create'), required: true },
      ],
      candidates: [SHEET, SLIDES],
      granted_permissions: [],
      budget: { max_templates: 1, max_tools: 9, max_instruction_chars: 1000 },
    });

    expect(context.selected_templates).toHaveLength(1);
    const blocker = context.blockers.find((entry) => entry.code === 'budget_exceeded');
    expect(blocker).toBeDefined();
    expect(blocker?.remedy.kind).toBe('raise_budget');
    expect(blocker?.detail).toContain('max_templates=1');
  });

  it('指令字符预算不足 ⇒ 阻塞（不截断指令全文）', () => {
    const longInstructions = candidate('template.spreadsheet', ['cap.sheet.create'], {
      instructions: ['x'.repeat(50)],
    });
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      candidates: [longInstructions],
      granted_permissions: [],
      budget: { max_templates: 3, max_tools: 9, max_instruction_chars: 10 },
    });
    expect(context.selected_templates).toHaveLength(0);
    expect(context.blockers[0]?.code).toBe('budget_exceeded');
    expect(context.blockers[0]?.detail).toContain('max_instruction_chars=10');
  });

  it('可选需求放不下 ⇒ 进 dropped_optional 如实登记（不是静默丢弃）', () => {
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [
        { capability_id: asCapabilityId('cap.sheet.create'), required: true },
        { capability_id: asCapabilityId('cap.slide.create'), required: false },
      ],
      candidates: [SHEET, SLIDES],
      granted_permissions: [],
      budget: { max_templates: 1, max_tools: 9, max_instruction_chars: 1000 },
    });

    expect(context.selected_templates.map((template) => template.plugin_id)).toEqual(['template.spreadsheet']);
    expect(context.dropped_optional).toHaveLength(1);
    expect(context.dropped_optional[0]?.requirement.capability_id).toBe(asCapabilityId('cap.slide.create'));
    expect(context.dropped_optional[0]?.reason).toBe('template_budget');
  });

  it('组装确定性：需求顺序不同 ⇒ 同一 digest', () => {
    const base = {
      task_id: 'T1',
      task_revision: 1,
      candidates: [SHEET, SLIDES],
      granted_permissions: [] as readonly string[],
    };
    const a = assembleContext({
      ...base,
      requirements: [
        { capability_id: asCapabilityId('cap.sheet.create'), required: true },
        { capability_id: asCapabilityId('cap.slide.create'), required: true },
      ],
    });
    const b = assembleContext({
      ...base,
      requirements: [
        { capability_id: asCapabilityId('cap.slide.create'), required: true },
        { capability_id: asCapabilityId('cap.sheet.create'), required: true },
      ],
    });
    expect(a.digest).toBe(b.digest);
  });

  it('反向对照：非法预算（0 / 非整数）⇒ 抛错——"没有上限"不是合法配置', () => {
    expect(() => validateBudget({ max_templates: 0, max_tools: 1, max_instruction_chars: 1 })).toThrow(
      /max_templates/,
    );
    expect(() => validateBudget({ max_templates: 1.5, max_tools: 1, max_instruction_chars: 1 })).toThrow(
      /整数/,
    );
    expect(DEFAULT_CONTEXT_BUDGET.max_templates).toBeGreaterThan(0);
  });
});

describe('KRN-05：与真实能力注册目录的接缝', () => {
  it('注册目录投影：只做表格 ⇒ 只选表格模板，PPT / 美团缺席', () => {
    const registry = createPluginRegistry();
    // 探针：适配器全就绪、能力全实测支持。**这只影响五态判定，不改选择逻辑**。
    const dependencies: DependencyProbe = { isAdapterReady: () => true };
    const support: SupportProbe = { isActuallySupported: () => true };
    const probes = { dependencies, support };
    for (const pluginId of ['template.spreadsheet', 'template.presentation', 'template.meituan']) {
      const at = asLogicalTime(0);
      registry.install(pluginId, { at });
      registry.enable(pluginId, at);
      registry.authorize(pluginId, at);
    }

    const candidates = candidatesFromRegistry(registry, probes);
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      candidates,
      granted_permissions: ['perm.file.write'],
    });

    expect(context.selected_templates.map((template) => template.plugin_id)).toEqual(['template.spreadsheet']);
    expect(context.excluded_template_ids).toContain('template.presentation');
    expect(context.excluded_template_ids).toContain('template.meituan');
    expect(context.blockers).toHaveLength(0);
  });

  it('依赖就绪但未实测支持 ⇒ 阻塞给出 verify_support（不宣称可用）', () => {
    const registry = createPluginRegistry();
    const at = asLogicalTime(0);
    registry.install('template.spreadsheet', { at });
    registry.enable('template.spreadsheet', at);
    registry.authorize('template.spreadsheet', at);

    // 适配器就绪，但"实测支持"探针恒 false ⇒ 未实测，不得当作可用模板。
    const context = assembleContext({
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      candidates: candidatesFromRegistry(registry, conservativeProbes({ readyAdapters: ['builtin.xlsx_builder'] })),
      granted_permissions: ['perm.file.write'],
    });

    expect(context.selected_templates).toHaveLength(0);
    expect(context.blockers[0]?.code).toBe('template_not_ready');
    expect(context.blockers[0]?.remedy.kind).toBe('verify_support');
  });
});
