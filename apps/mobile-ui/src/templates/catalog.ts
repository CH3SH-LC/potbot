/**
 * F08 templates —— 七个业务模板的**静态定义**（离线可得，不含任何运行时状态）。
 *
 * 来源对齐：`src/plugins/catalog.ts`（产品可达的真实注册目录，PLG-01 / R227 / R232）。
 * **本文件不复制** `src/plugins/**` 的实现，只承载前端目录/详情要展示的静态元数据，
 * 且 id 与产出/消费格式逐字对齐，避免前端把「模板」与「文件格式」混为一谈（R232）：
 *
 *   | 模板 id                  | 产出格式 | 说明 |
 *   |---|---|---|
 *   | template.document        | docx     | 文档 |
 *   | template.spreadsheet     | xlsx     | 表格 |
 *   | template.presentation    | pptx     | 演示文稿 |
 *   | template.meituan         | 无       | 候选发现与交接，不产出 OOXML |
 *   | template.clock           | 无       | 系统闹钟 / 计时器交接 |
 *   | template.calendar        | 无       | 日程读写与交接 |
 *   | template.research        | 无       | 读 PDF / Markdown 等，不产出它们 |
 *
 * 诚实口径：本文件描述的只是「目录里有哪些模板、叫什么、要什么权限」，
 * **不声称**任何一个模板已就绪。就绪由运行时探针（`TemplateLifecycle`）分别报告。
 */

import type {
  CapabilityDescriptor,
  TemplateDefinition,
  TemplateId,
  TemplatePermission,
} from './types.js';
import { TemplateError, TEMPLATE_IDS } from './types.js';

/** 权限的规范顺序：输出数组按此排序，保证 deep-equal 断言可复现。 */
export const PERMISSION_ORDER: readonly TemplatePermission[] = [
  'network',
  'storage',
  'model',
  'device',
  'external-order',
  'file-write',
];

const RUNTIME_ANDROID_ARM64 = {
  os: 'android' as const,
  minimumOs: 26,
  runtimes: ['quickjs' as const],
  abis: ['arm64-v8a' as const],
};

function cap(
  id: string,
  label: string,
  description: string,
  requiresPermission?: TemplatePermission,
): CapabilityDescriptor {
  return requiresPermission === undefined
    ? { id, label, description }
    : { id, label, description, requiresPermission };
}

const DEFINITIONS: readonly TemplateDefinition[] = [
  {
    id: 'template.document',
    displayName: '文档',
    summary: '新建 / 编辑 / 导入 DOCX，保留未知部件，可导出与预览。',
    version: '1.0.0',
    capabilities: [
      cap('cap.doc.create', '新建文档', '依据共享事实生成 DOCX 文档', 'model'),
      cap('cap.doc.edit', '编辑文档', '对既有 DOCX 做结构化编辑', 'file-write'),
      cap('cap.doc.import', '导入文档', '导入并保留既有 DOCX 的未知部件', 'storage'),
      cap('cap.doc.export', '导出文档', '导出可编辑 DOCX 并读回校验', 'file-write'),
    ],
    permissions: ['storage', 'file-write', 'model'],
    runtimeCompatibility: RUNTIME_ANDROID_ARM64,
    migration: { from: '0.9.0', to: '1.0.0', strategy: 'additive', reversible: true },
    producesFileFormats: ['docx'],
    consumesFormats: ['docx'],
    externalDependency: '内置 DOCX 构建器',
  },
  {
    id: 'template.spreadsheet',
    displayName: '表格',
    summary: '新建 / 编辑 XLSX，公式按可编辑公式保存，可导入 CSV。',
    version: '1.0.0',
    capabilities: [
      cap('cap.sheet.create', '新建表格', '按事实键生成 XLSX 工作簿', 'model'),
      cap('cap.sheet.formula', '公式读写', '保存为可编辑公式而非固化数值', 'file-write'),
      cap('cap.sheet.import', '导入表格', '解析既有 XLSX 与 CSV', 'storage'),
      cap('cap.sheet.export', '导出表格', '导出 XLSX 并读回校验', 'file-write'),
    ],
    permissions: ['storage', 'file-write', 'model'],
    runtimeCompatibility: RUNTIME_ANDROID_ARM64,
    migration: { from: '0.9.0', to: '1.0.0', strategy: 'additive', reversible: true },
    producesFileFormats: ['xlsx'],
    consumesFormats: ['xlsx', 'csv'],
    externalDependency: '内置 XLSX 构建器',
  },
  {
    id: 'template.presentation',
    displayName: '演示',
    summary: '新建 / 编辑 PPTX，沿用母版，保留可编辑对象。',
    version: '1.0.0',
    capabilities: [
      cap('cap.slide.create', '新建演示文稿', '页数由任务决定，不固定两页', 'model'),
      cap('cap.slide.theme', '主题与母版', '沿用既有母版，不每次扁平化重造', 'file-write'),
      cap('cap.slide.import', '导入演示文稿', '导入既有 PPTX 并保留可编辑对象', 'storage'),
      cap('cap.slide.export', '导出演示文稿', '导出 PPTX 并读回校验', 'file-write'),
    ],
    permissions: ['storage', 'file-write', 'model'],
    runtimeCompatibility: RUNTIME_ANDROID_ARM64,
    migration: { from: '0.9.0', to: '1.0.0', strategy: 'additive', reversible: true },
    producesFileFormats: ['pptx'],
    consumesFormats: ['pptx'],
    externalDependency: '内置 PPTX 构建器',
  },
  {
    id: 'template.meituan',
    displayName: '美团外卖',
    summary: '按品类 / 位置 / 预算查真实候选，核对费用后交接目标页；不直接购买支付。',
    version: '1.0.0',
    capabilities: [
      cap('cap.meituan.search', '候选查询', '按品类 / 位置 / 预算查询真实候选', 'network'),
      cap('cap.meituan.detail', '详情与费用', '读取套餐费用与条件，区分价格 / 库存 / 营业未知', 'network'),
      cap('cap.meituan.handoff', '目标页交接', '生成并校验目标页面交接；不直接购买支付', 'external-order'),
    ],
    permissions: ['network', 'model', 'external-order'],
    runtimeCompatibility: RUNTIME_ANDROID_ARM64,
    migration: { from: '0.13.0', to: '1.0.0', strategy: 'transform', reversible: false },
    producesFileFormats: [],
    consumesFormats: ['txt', 'png', 'jpg', 'pdf'],
    externalDependency: '已授权的美团接口 / MCP',
  },
  {
    id: 'template.clock',
    displayName: '时钟',
    summary: '创建 / 修改 / 启停自管闹钟与计时器，经已核验接口交接系统时钟动作。',
    version: '1.0.0',
    capabilities: [
      cap('cap.clock.alarm', '闹钟管理', '创建 / 修改 / 启停自管闹钟', 'device'),
      cap('cap.clock.timer', '计时器', '计时器与秒表', 'device'),
      cap('cap.clock.system_handoff', '系统时钟交接', '经已核验接口交接系统时钟动作', 'device'),
    ],
    permissions: ['device'],
    runtimeCompatibility: RUNTIME_ANDROID_ARM64,
    migration: { from: '0.13.0', to: '1.0.0', strategy: 'transform', reversible: false },
    producesFileFormats: [],
    consumesFormats: [],
    externalDependency: '系统时钟接口（权限未在设备核实）',
  },
  {
    id: 'template.calendar',
    displayName: '日历',
    summary: '日程读写、参与者与邀请状态，离线改动的同步与撤权。',
    version: '1.0.0',
    capabilities: [
      cap('cap.calendar.read', '日程读取', '读取日程与参与者状态', 'device'),
      cap('cap.calendar.write', '日程写入', '创建 / 更新日程并区分邀请是否已发', 'device'),
      cap('cap.calendar.sync', '离线同步', '离线改动合并与撤权处理', 'network'),
    ],
    permissions: ['device', 'network'],
    runtimeCompatibility: RUNTIME_ANDROID_ARM64,
    migration: { from: '0.13.0', to: '1.0.0', strategy: 'transform', reversible: false },
    producesFileFormats: [],
    consumesFormats: [],
    externalDependency: '系统日历提供者',
  },
  {
    id: 'template.research',
    displayName: '资料检索',
    summary: '检索私有资料与在线来源，版本化事实，来源可追溯、可删除联动。',
    version: '1.0.0',
    capabilities: [
      cap('cap.research.search', '资料检索', '检索私有资料与在线来源，区分二者', 'network'),
      cap('cap.research.read', '文档读取', '读取 PDF / Markdown 等资料，不产出这些格式', 'storage'),
      cap('cap.research.facts', '事实发布', '发布版本化事实并留痕消费回执', 'model'),
    ],
    permissions: ['network', 'storage', 'model'],
    runtimeCompatibility: RUNTIME_ANDROID_ARM64,
    migration: { from: '0.13.0', to: '1.0.0', strategy: 'transform', reversible: false },
    producesFileFormats: [],
    consumesFormats: ['pdf', 'md', 'txt'],
    externalDependency: '在线检索端口 / 私有语料',
  },
];

const BY_ID: Readonly<Record<TemplateId, TemplateDefinition>> = Object.freeze(
  DEFINITIONS.reduce<Record<string, TemplateDefinition>>((acc, def) => {
    acc[def.id] = def;
    return acc;
  }, {}),
) as Readonly<Record<TemplateId, TemplateDefinition>>;

/** 七个模板定义，按规范展示顺序。 */
export const TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = DEFINITIONS;

/**
 * 取模板定义。未知 id 抛 `unknown-template`——不返回 `undefined` 让调用方悄悄降级。
 */
export function getTemplateDefinition(id: string): TemplateDefinition {
  const def = BY_ID[id as TemplateId];
  if (def === undefined) {
    throw new TemplateError('unknown-template', `未知模板 id：${id}`, { id });
  }
  return def;
}

/** 是否为规范模板 id。 */
export function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id);
}

/** 按规范权限顺序排序并去重。 */
export function normalizePermissions(permissions: readonly TemplatePermission[]): readonly TemplatePermission[] {
  const set = new Set(permissions);
  return PERMISSION_ORDER.filter((permission) => set.has(permission));
}
