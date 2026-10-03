/**
 * KRN-05 收口：**能力注册表**——能力清单投影 / 按需选择 / 结构化阻塞 / 可补入。
 *
 * ## 这个文件要钉死的判据（每条含至少一条反向对照）
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | A1 | 空注册表 ⇒ 清单为空；全部候选进 `blocked` 且**五态分开** | 正例 |
 * | A2 | 就绪模板 ⇒ 可用能力被投影，条目带五态向量且五态键与 capability-discovery 同词表 | 正例 |
 * | A3 | `limit` 超限 ⇒ **显式截断** + `omitted_count`（不静默丢弃） | **反例**（超限必须截断） |
 * | A4 | 清单只含标签，**不泄出指令全文**（`findInstructionLeaks` 为空） | **反例**（不塞全文） |
 * | A5 | 非法 `limit`（0）⇒ 抛错（"无上限"不是合法配置） | **反例** |
 * | B1 | 只做表格的任务 ⇒ 只选表格模板，PPT / 美团不进上下文，渲染文本无其指令 | **反例**（无关模板必须缺席） |
 * | B2 | 同一批候选，需求改成"要 PPT" ⇒ PPT 被选（筛选由需求驱动，非黑名单） | 正向对照 |
 * | B3 | 需求为空 ⇒ 一个模板都不选 | 反向对照 |
 * | B4 | **无关模板入选必须被抓**：喂一份混入 PPT 的组装结果 ⇒ 自检函数抓出它 | **反例** |
 * | C1 | 缺能力 ⇒ `missing_capability` + 解锁动作 `install` | 正例 |
 * | C2 | 缺权限 ⇒ `permission_not_granted` + 解锁动作 `grant_permission`（带权限 id） | 正例 |
 * | C3 | 依赖未就绪 ⇒ `dependency_not_ready` + 解锁动作 `ready_dependencies` | 正例 |
 * | C4 | 未启用 ⇒ `template_not_enabled` + `enable`；未授权 ⇒ `template_not_authorized` + `authorize` | 正例 |
 * | C5 | 未实测 ⇒ `support_unverified` + `verify_support`（不宣称可用） | 正例 |
 * | C6 | stub ⇒ `stub_no_remedy` + `none`（R233，无可授权实现） | **反例** |
 * | C7 | 预算放不下 ⇒ `budget_exceeded` + `raise_budget`（不静默截断） | **反例** |
 * | D1 | 已安装但未授权（其余四态俱真）⇒ 出现在**可即时补入**名单 | 正例 |
 * | D2 | 经 `authorize_installed` ⇒ **即时补入**；不授权则阻塞 `template_not_authorized` | 正例 + 对照 |
 * | D3 | **未安装**模板**不得**因授权可用：仍不入选，阻塞 `template_not_installed` + `install` | **反例**（对照） |
 *
 * ## 诚实边界
 *
 * 本层只做**投影 / 选择 / 阻塞**（选谁、缺什么给什么解锁条件），**不调用真实模型、不执行工具**。
 * 探针（依赖 / 实测支持）由测试注入，"真实执行器在真机上的结论"不在本文件范围。
 */

import { describe, expect, it } from 'vitest';

import { asCapabilityId, asLogicalTime } from '../protocol/index.js';
import {
  BUSINESS_TEMPLATES,
  PLUGIN_CATALOG,
  conservativeProbes,
  createPluginRegistry,
  findInstructionLeaks,
  type DiscoveryProbes,
  type PluginRegistry,
} from '../plugins/index.js';
import { renderContextText } from './context-assembly.js';
import {
  CAPABILITY_STATE_KEYS,
  describeCapabilityBlock,
  findIrrelevantSelections,
  listImmediatelySupplementable,
  projectCapabilityInventory,
  selectCapabilities,
} from './capability-registry.js';

/** 探针：适配器全就绪、能力全实测支持（只影响五态判定，不改选择逻辑）。 */
const FULL_PROBES: DiscoveryProbes = Object.freeze({
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
});

/** 装 / 启 / 授权一批模板（内置来源安装即授权，仍显式授权以表明意图）。 */
function makeReady(registry: PluginRegistry, pluginIds: readonly string[]): void {
  const at = asLogicalTime(0);
  for (const pluginId of pluginIds) {
    registry.install(pluginId, { at });
    registry.enable(pluginId, at);
    registry.authorize(pluginId, at);
  }
}

// ---------------------------------------------------------------------------
// A. 能力清单（投影 + 五态分开 + 按需读取 + 截断）
// ---------------------------------------------------------------------------

describe('A. 能力清单：投影出可用能力，按需读取、长度受限、五态分开', () => {
  it('A1 空注册表：清单为空，全部候选进 blocked 且先给未就绪态', () => {
    const inventory = projectCapabilityInventory(createPluginRegistry(), FULL_PROBES);

    expect(inventory.entries).toHaveLength(0);
    expect(inventory.total_available).toBe(0);
    expect(inventory.truncated).toBe(false);
    expect(inventory.omitted_count).toBe(0);
    expect(inventory.ready_plugin_ids).toEqual([]);
    // 目录里的 10 个插件（7 模板 + 3 角色）一个都没就绪 ⇒ 全进 blocked，一个都不假装可用。
    expect(inventory.blocked).toHaveLength(PLUGIN_CATALOG.length);

    const sheet = inventory.blocked.find((entry) => entry.plugin_id === 'template.spreadsheet');
    expect(sheet?.false_states).toContain('installed');
    expect(sheet?.false_states).toContain('enabled');
    expect(sheet?.false_states).toContain('authorized');
  });

  it('A2 就绪模板：可用能力被投影，条目带五态向量（词表来自 capability-discovery）', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet', 'template.presentation']);

    const inventory = projectCapabilityInventory(registry, FULL_PROBES);

    // 表格 3 条 + 演示文稿 3 条 = 6 条可用能力（文档 / 美团等未装，不入清单）。
    expect(inventory.total_available).toBe(6);
    expect(inventory.entries.map((entry) => entry.plugin_id)).toEqual([
      'template.spreadsheet',
      'template.spreadsheet',
      'template.spreadsheet',
      'template.presentation',
      'template.presentation',
      'template.presentation',
    ]);
    expect(inventory.ready_plugin_ids).toEqual(['template.presentation', 'template.spreadsheet']);

    const first = inventory.entries[0]!;
    // 五态**分开**：逐个具名布尔，可机械判别。
    expect(Object.keys(first.states.states)).toEqual([...CAPABILITY_STATE_KEYS]);
    expect(first.states.states).toEqual({
      installed: true,
      enabled: true,
      authorized: true,
      dependencies_ready: true,
      actually_supported: true,
    });
    expect(first.states.ready).toBe(true);
    expect(first.false_states).toEqual([]);

    // 未就绪的模板留在 blocked，不混进可用清单。
    const blockedIds = inventory.blocked.map((entry) => entry.plugin_id);
    expect(blockedIds).not.toContain('template.spreadsheet');
    expect(blockedIds).toContain('template.document');
    expect(blockedIds).toContain('template.meituan');
  });

  it('A3 反向对照：清单长度受 limit 约束，超限**显式截断**而非静默丢弃', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet', 'template.presentation']);

    const full = projectCapabilityInventory(registry, FULL_PROBES);
    expect(full.entries).toHaveLength(6);
    expect(full.truncated).toBe(false);
    expect(full.omitted_count).toBe(0);

    const bounded = projectCapabilityInventory(registry, FULL_PROBES, { limit: 2 });
    expect(bounded.entries).toHaveLength(2);
    expect(bounded.total_available).toBe(6);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omitted_count).toBe(4);
    // 不变量：省略数 = 截断前总数 − 实际条数（不是静默丢弃）。
    expect(bounded.omitted_count).toBe(bounded.total_available - bounded.entries.length);
    // 截断只砍尾部，不改判定：留下的仍是就绪能力。
    expect(bounded.entries.every((entry) => entry.states.ready)).toBe(true);
  });

  it('A4 反向对照：清单只含标签，不泄出指令全文', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet', 'template.presentation']);

    const inventory = projectCapabilityInventory(registry, FULL_PROBES);
    const readyManifests = PLUGIN_CATALOG.filter((manifest) =>
      inventory.ready_plugin_ids.includes(manifest.plugin_id),
    );
    // 清单里的 label 若恰好等于任一指令全文，说明"能力发现"被换成了"塞全文"。
    expect(findInstructionLeaks(inventory.entries, readyManifests)).toEqual([]);
    // 反向对照：指令全文本身**不在**任何清单条目里。
    const slideInstruction = BUSINESS_TEMPLATES.find((manifest) => manifest.plugin_id === 'template.presentation')
      ?.instructions[0] as string;
    expect(inventory.entries.some((entry) => entry.label === slideInstruction)).toBe(false);
  });

  it('A5 反向对照：非法 limit（0）⇒ 抛错——"无上限"不是合法配置', () => {
    const registry = createPluginRegistry();
    expect(() => projectCapabilityInventory(registry, FULL_PROBES, { limit: 0 })).toThrow(/上限/);
  });
});

// ---------------------------------------------------------------------------
// B. 按需选择（必要才选，无关模板不入选）
// ---------------------------------------------------------------------------

describe('B. 按需选择：无关模板不加入任务', () => {
  function readyRegistry(): PluginRegistry {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet', 'template.presentation']);
    return registry;
  }

  it('B1 只做表格：只选表格模板，PPT / 美团不进上下文且在渲染文本里缺席', () => {
    const selection = selectCapabilities({
      registry: readyRegistry(),
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    });

    expect(selection.context.selected_templates.map((template) => template.plugin_id)).toEqual([
      'template.spreadsheet',
    ]);
    expect(selection.context.excluded_template_ids).toContain('template.presentation');
    expect(selection.context.excluded_template_ids).toContain('template.meituan');
    expect(selection.context.selected_tools.map((tool) => tool.tool_id)).toEqual([
      'template.spreadsheet:cap.sheet.create',
    ]);
    expect(selection.irrelevant_selected).toEqual([]);

    const text = renderContextText(selection.context);
    expect(text).toContain('sheet.create');
    expect(text).not.toContain('slide.create');
    expect(text).not.toContain('meituan.search');
  });

  it('B2 正向对照：需求换成"要 PPT" ⇒ PPT 被选（筛选由需求驱动，不是黑名单）', () => {
    const selection = selectCapabilities({
      registry: readyRegistry(),
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.slide.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    });

    expect(selection.context.selected_templates.map((template) => template.plugin_id)).toEqual([
      'template.presentation',
    ]);
    expect(selection.context.excluded_template_ids).toContain('template.spreadsheet');
  });

  it('B3 反向对照：需求为空 ⇒ 一个模板都不选', () => {
    const selection = selectCapabilities({
      registry: readyRegistry(),
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [],
      granted_permissions: ['perm.file.write'],
    });

    expect(selection.context.selected_templates).toHaveLength(0);
    expect(selection.context.selected_tools).toHaveLength(0);
    expect(selection.irrelevant_selected).toEqual([]);
  });

  it('B4 反向对照：无关模板入选**必须被抓**（喂一份混入 PPT 的组装结果）', () => {
    // 健康路径：自检为空。
    const healthy = selectCapabilities({
      registry: readyRegistry(),
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    });
    expect(findIrrelevantSelections(healthy.context.selected_templates, [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }])).toEqual([]);

    // 故意混入：一份"只做表格"的任务里混进了 PPT 模板 ⇒ 自检必须抓出它。
    const polluted = [
      { plugin_id: 'template.spreadsheet', satisfies: [asCapabilityId('cap.sheet.create')] },
      { plugin_id: 'template.presentation', satisfies: [asCapabilityId('cap.slide.create')] },
    ];
    expect(
      findIrrelevantSelections(polluted, [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }]),
    ).toEqual(['template.presentation']);
  });
});

// ---------------------------------------------------------------------------
// C. 结构化阻塞（缺能力 / 缺权限 / 依赖未就绪 … 分别给，且带可执行解锁条件）
// ---------------------------------------------------------------------------

describe('C. 结构化阻塞：逐类具名 + 可执行的解锁条件', () => {
  it('C1 缺能力（目录里没有承载实现）⇒ missing_capability + install', () => {
    const selection = selectCapabilities({
      registry: createPluginRegistry(),
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.unknown.thing'), required: true }],
    });

    expect(selection.blocks[0]?.reason).toBe('missing_capability');
    expect(selection.blocks[0]?.plugin_id).toBeNull();
    expect(selection.blocks[0]?.unlock.action).toBe('install');
  });

  it('C2 缺权限（模板就绪但权限未授予）⇒ permission_not_granted + grant_permission', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet']);

    const selection = selectCapabilities({
      registry,
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: [], // 未授予 perm.file.write
    });

    expect(selection.context.selected_templates).toHaveLength(0);
    expect(selection.blocks[0]?.reason).toBe('permission_not_granted');
    expect(selection.blocks[0]?.unlock.action).toBe('grant_permission');
    expect(selection.blocks[0]?.unlock.target).toBe('perm.file.write');
  });

  it('C3 依赖未就绪 ⇒ dependency_not_ready + ready_dependencies', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet']);

    // 适配器未就绪（但已装 / 已启 / 已授权、实测支持为真）⇒ 唯一假位是 dependencies_ready。
    const depsNotReady: DiscoveryProbes = {
      dependencies: { isAdapterReady: () => false },
      support: { isActuallySupported: () => true },
    };

    const selection = selectCapabilities({
      registry,
      probes: depsNotReady,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    });

    expect(selection.blocks[0]?.reason).toBe('dependency_not_ready');
    expect(selection.blocks[0]?.unlock.action).toBe('ready_dependencies');
    expect(selection.blocks[0]?.plugin_id).toBe('template.spreadsheet');
  });

  it('C4 未启用 / 未授权 ⇒ 分别给 enable / authorize（不合并成一个"不可用"）', () => {
    const at = asLogicalTime(0);

    const notEnabled = createPluginRegistry();
    notEnabled.install('template.spreadsheet', { at }); // 装而未启（内置来源安装即授权）

    const disabled = selectCapabilities({
      registry: notEnabled,
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    });
    expect(disabled.blocks[0]?.reason).toBe('template_not_enabled');
    expect(disabled.blocks[0]?.unlock.action).toBe('enable');

    const unauthorized = createPluginRegistry();
    unauthorized.install('template.spreadsheet', { at });
    unauthorized.enable('template.spreadsheet', at);
    unauthorized.revokeAuthorization('template.spreadsheet', at); // 装 / 启但撤了授权

    const revoked = selectCapabilities({
      registry: unauthorized,
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    });
    expect(revoked.blocks[0]?.reason).toBe('template_not_authorized');
    expect(revoked.blocks[0]?.unlock.action).toBe('authorize');
  });

  it('C5 未实测支持 ⇒ support_unverified + verify_support（不宣称可用）', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet']);

    // 依赖就绪但"实测支持"探针恒 false ⇒ 未实测，不得当作可用模板。
    const selection = selectCapabilities({
      registry,
      probes: conservativeProbes({ readyAdapters: ['builtin.xlsx_builder'] }),
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    });

    expect(selection.blocks[0]?.reason).toBe('support_unverified');
    expect(selection.blocks[0]?.unlock.action).toBe('verify_support');
  });

  it('C6 反向对照：stub 模板 ⇒ stub_no_remedy + none（R233，无可授权的实现）', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.meituan']); // 装 / 启 / 授权全真、探针全真

    const selection = selectCapabilities({
      registry,
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.meituan.search'), required: true }],
      granted_permissions: ['perm.network.read'],
    });

    expect(selection.context.selected_templates).toHaveLength(0);
    expect(selection.blocks[0]?.reason).toBe('stub_no_remedy');
    expect(selection.blocks[0]?.unlock.action).toBe('none');
    expect(selection.blocks[0]?.detail).toContain('stub');
  });

  it('C7 反向对照：预算放不下必需模板 ⇒ budget_exceeded + raise_budget（不静默截断）', () => {
    const registry = createPluginRegistry();
    makeReady(registry, ['template.spreadsheet', 'template.presentation']);

    const selection = selectCapabilities({
      registry,
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [
        { capability_id: asCapabilityId('cap.sheet.create'), required: true },
        { capability_id: asCapabilityId('cap.slide.create'), required: true },
      ],
      granted_permissions: ['perm.file.write'],
      budget: { max_templates: 1, max_tools: 9, max_instruction_chars: 1000 },
    });

    expect(selection.context.selected_templates).toHaveLength(1);
    const budgetBlock = selection.blocks.find((block) => block.reason === 'budget_exceeded');
    expect(budgetBlock).toBeDefined();
    expect(budgetBlock?.unlock.action).toBe('raise_budget');
  });

  it('C0 describeCapabilityBlock 是纯投影：可直接喂一个 blocker 得到具名原因', () => {
    const block = describeCapabilityBlock({
      code: 'template_not_ready',
      capability_id: asCapabilityId('cap.doc.create'),
      plugin_id: 'template.document',
      detail: '演示用',
      remedy: { kind: 'install_template', plugin_id: 'template.document', permission_id: null, detail: '需先安装' },
    });
    expect(block.reason).toBe('template_not_installed');
    expect(block.unlock.action).toBe('install');
  });
});

// ---------------------------------------------------------------------------
// D. 可补入（已安装但未授权 ⇒ 授权后即时补入；未安装的不得因授权可用）
// ---------------------------------------------------------------------------

describe('D. 可补入：已安装但未授权的模板授权后即时补入', () => {
  /** 装 / 启但撤权的表格模板：除授权外其余四态俱真。 */
  function installedUnauthorized(): PluginRegistry {
    const registry = createPluginRegistry();
    const at = asLogicalTime(0);
    registry.install('template.spreadsheet', { at });
    registry.enable('template.spreadsheet', at);
    registry.revokeAuthorization('template.spreadsheet', at);
    return registry;
  }

  it('D1 已安装但未授权（其余四态俱真）⇒ 出现在可即时补入名单', () => {
    const registry = installedUnauthorized();
    // 混入一个 stub（装了但不可补入）与一批未安装模板，验证它们**不在**名单里。
    makeReady(registry, ['template.meituan']);

    const list = listImmediatelySupplementable(registry, FULL_PROBES);
    expect(list.map((entry) => entry.plugin_id)).toEqual(['template.spreadsheet']);
    expect(list[0]?.unlock.action).toBe('authorize');
    expect(list.map((entry) => entry.plugin_id)).not.toContain('template.meituan'); // stub 不可补入
    expect(list.map((entry) => entry.plugin_id)).not.toContain('template.document'); // 未安装不可补入

    // 空注册表：没有任何"已安装待授权"的模板 ⇒ 名单为空（未安装的一律不算）。
    expect(listImmediatelySupplementable(createPluginRegistry(), FULL_PROBES)).toEqual([]);
  });

  it('D2 经 authorize_installed ⇒ 即时补入；不授权则阻塞 template_not_authorized', () => {
    const registry = installedUnauthorized();
    const base = {
      registry,
      probes: FULL_PROBES,
      task_id: 'T1' as const,
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.sheet.create'), required: true }],
      granted_permissions: ['perm.file.write'],
    };

    const blocked = selectCapabilities(base);
    expect(blocked.context.selected_templates).toHaveLength(0);
    expect(blocked.blocks[0]?.reason).toBe('template_not_authorized');
    expect(blocked.blocks[0]?.unlock.action).toBe('authorize');

    const supplemented = selectCapabilities({ ...base, authorize_installed: ['template.spreadsheet'] });
    expect(supplemented.context.selected_templates.map((template) => template.plugin_id)).toEqual([
      'template.spreadsheet',
    ]);
    expect(supplemented.blocks).toHaveLength(0);
    expect(supplemented.irrelevant_selected).toEqual([]);
  });

  it('D3 反向对照：**未安装**模板不得因授权可用，阻塞 template_not_installed + install', () => {
    // 空注册表 ⇒ template.document 未安装。
    const selection = selectCapabilities({
      registry: createPluginRegistry(),
      probes: FULL_PROBES,
      task_id: 'T1',
      task_revision: 1,
      requirements: [{ capability_id: asCapabilityId('cap.doc.create'), required: true }],
      granted_permissions: ['perm.file.write'],
      authorize_installed: ['template.document'], // 明确"授权"它，但它根本没装
    });

    // 关键对照：授权一个未安装的模板**无效**——它仍然不被选入。
    expect(selection.context.selected_templates).toHaveLength(0);
    expect(selection.blocks[0]?.reason).toBe('template_not_installed');
    expect(selection.blocks[0]?.unlock.action).toBe('install');
  });
});
