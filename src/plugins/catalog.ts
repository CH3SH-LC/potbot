/**
 * **真实注册目录**：七个业务模板 + 三个基础角色（design-06 P6 / PLG-01；合同 R227 / R232）。
 *
 * ## 这份目录的诚实口径（务必连着读）
 *
 * 本文件【产品可达】：src/plugins/catalog.ts。它被 apps/demo/server/plugin-routes.ts 接进产品入口，
 * 把 `implementation` / `is_stub` / 未就绪原因直接呈现给用户，所以这里的每一句话都要对得起代码树。
 * 判据分**四层**，任何一层都**不得**被另一层顶替：
 *
 * 1. **模块存在**：仓库里到底有没有承载代码。
 * 2. **被 import 可达**：该模块是否落在产品入口（`apps/demo/server/main.ts`）的 import 闭包内，
 *    即用户真的够得到。**存在 ≠ 可达**。
 * 3. **被真调用**：闭包内**不等于**被真用——一个模块可能只靠桶（`export * from`）被拖进闭包，
 *    而非测试代码里**零按名引用**。**可达 ≠ 真用**：本目录凡标【产品可达】/【真调用】的条目，
 *    都必须在非测试代码里有**按名引用或真实调用**；只靠桶进闭包的，标【零按名引用】。
 * 4. **实测支持**：真实执行器 / 真机 / 真实外部服务跑通了吗。那是运行期判据
 *    `actually_supported`（见 `registry.ts` 的五态发现），本层**一律不下结论**。
 *
 * 第 2 / 3 层的逐条现状写在各条 `stub_reason` 里，用四个机器可核对的标记
 * 【产品可达】/【产品不可达】/【真调用】/【零按名引用】标注；`catalog.test.ts` 会拿代码树复算。
 *
 * 四类标记的**当下分布**：真实目录里【产品可达】/【真调用】两档都有实体条目；另两档（产品不可达、
 * 零按名引用）目前为空——上一批"只有包内测试引用"的模块已全部接线（美团 6 + 时钟 1 见
 * `apps/demo/server/adapters-extra-routes.ts`，两个会话适配器见 `apps/demo/server/session-adapters-wiring.ts`），
 * 故已无对象可标。若它们重新出现，表示"可达但不真用"或"产品不可达"复发，`catalog.test.ts` 会要求复核。
 *
 * `implementation` 按 **R233**（未就绪的模板 / 能力必须先给原因、开发期 stub 必须显式标识）
 * 取两个值：
 *
 * - `real`：本仓库存在承载模块，**且**它已落在产品可达闭包内。例如三个办公模板指向
 *   `src/artifacts/templates/docx.ts` 等三个文件（都存在、都产品可达）。它**不**等于第三、
 *   第四层已经成立，更不等于"真实执行器已验证"。
 * - `stub`：**未就绪**，按 R233 显式标识并给出原因。注意 stub 在这里**不再**等价于
 *   "指认不到承载代码"：本批的四个适配器型模板与三个基础角色**都有承载模块**
 *   （`src/adapters/meituan/**`、`src/adapters/clock/**`、`src/adapters/calendar/**`、
 *   `src/adapters/research/**` 与 `src/roles/main-agent.ts` 等），但各自因为真实外部侧未接通 /
 *   设备未核实而**未就绪**，故仍标 stub，且**不得**被当作"可用"。
 *   每条 stub 的承载路径、可达性与真实缺口，逐条写在该清单的 `stub_reason` 里。
 *
 * ## 七个业务模板与文件格式的关系（R232）
 *
 * | 模板 | 产出文件格式 | 说明 |
 * |---|---|---|
 * | `template.document` | `docx` | 文档 |
 * | `template.spreadsheet` | `xlsx` | 表格 |
 * | `template.presentation` | `pptx` | 演示文稿 |
 * | `template.meituan` | **无** | 美团：候选发现与交接，**不产出** OOXML |
 * | `template.clock` | **无** | 时钟：系统闹钟 / 计时器交接 |
 * | `template.calendar` | **无** | 日历：日程读写与交接 |
 * | `template.research` | **无** | 资料检索：读 PDF / Markdown 等，**不产出**它们 |
 *
 * 「检索模板读 PDF」是 `consumes_formats`（输入资料格式），与 `produces_file_formats`
 * 语义不同，两者**都不得**混入 `FILE_FORMAT_KINDS`（文件类型枚举只有 docx / xlsx / pptx）。
 *
 * ## 防复发判据
 *
 * 曾经这里写着"美团 / 时钟 / 日历 / 资料检索的适配器在 `src/adapters/**`，
 * **基线提交里尚不存在**"——而这四个目录当时已有 29 / 11 / 17 / 13 个非测试模块，
 * 产品可达的目录对用户说了假话。也曾把三个基础角色写成"src/roles/** 整包产品不可达"
 * ——那在 apps/demo/server/roles-wiring.ts 接线之后同样过期（现为整包产品可达）。
 *
 * 现在 `catalog.test.ts` 里有两组机器化判据：
 *
 * - **存在性**：本文件（含模块文档与每条 `stub_reason`）凡以"无 / 不存在 / 未见 / 尚无 /
 *   未找到"断言某条 `src/**` 路径，该路径就必须**真的不存在**；反之，"已存在 / 存在" 断言
 *   就必须为真；每条 stub 清单**必须点名**它的承载路径（否则无法核对存在性）。
 * - **可达性 / 真用**：标【产品不可达】的路径必须**真的不在**产品闭包；标【产品可达】/
 *   【真调用】的必须**真的在**闭包内且有非测试的按名引用或真实调用；标【零按名引用】的必须
 *   真的没有。两个方向各配反向对照（喂一份故意矛盾的描述必须报红）。
 *
 * 把已过期的"不存在 / 不可达"写回来会立刻报红（反向对照见该测试文件）。
 *
 * 纯数据 + 构造期校验，零 IO。
 */

import {
  createBusinessTemplateManifest,
  createBaseRoleManifest,
  type BaseRoleManifest,
  type BusinessTemplateManifest,
  type PluginManifest,
} from './manifest.js';

/**
 * 内核兼容区间的公共值：取清单自身冻结的 0.9.0 版本线，无上限。
 *
 * **不再**声称与 `package.json` 的 `version` 对齐——后者当前是 `0.13.0`，
 * 两者是各自独立的版本线（早期注释把它写成"与 package.json 对齐"已过期）。
 */
const KERNEL_0_9 = Object.freeze({ min_version: '0.9.0', max_version: null });

/** 内置来源（本批全部为内置清单；声明式包由 `validateDeclarativePackage` 另行把关）。 */
const BUILTIN_SOURCE = Object.freeze({ kind: 'builtin' as const, origin: 'builtin' });

// ---------------------------------------------------------------------------
// 七个业务模板
// ---------------------------------------------------------------------------

const DOCUMENT_TEMPLATE: BusinessTemplateManifest = createBusinessTemplateManifest({
  kind: 'business_template',
  plugin_id: 'template.document',
  display_name: '文档模板',
  version: '0.9.0',
  kernel_compatibility: KERNEL_0_9,
  capabilities: [
    { capability_id: 'cap.doc.create', label: '新建文档', description: '依据共享事实生成 DOCX 文档' },
    { capability_id: 'cap.doc.edit', label: '编辑文档', description: '对既有 DOCX 做结构化编辑' },
    { capability_id: 'cap.doc.import', label: '导入文档', description: '导入并保留既有 DOCX 的未知部件' },
  ],
  instructions: ['doc.create：按模板声明的输入事实键装配文档内容', 'doc.edit：改动前先解析既有结构，未知部件原样保留'],
  inputs: [
    { name: 'facts', kind: 'fact', description: '模板声明的输入事实键与快照', formats: [] },
    { name: 'source_file', kind: 'file', description: '可选：待编辑 / 导入的既有文档', formats: ['docx'] },
  ],
  outputs: [{ name: 'document', kind: 'file', description: '生成的 DOCX 文件', formats: ['docx'] }],
  adapter_dependencies: [
    { adapter_id: 'builtin.docx_builder', kind: 'builtin', required: true, description: '仓库内 DOCX 构建器' },
  ],
  permissions: [
    { permission_id: 'perm.file.write', description: '写出文件到受控运行目录', required: true },
  ],
  data_scope: { level: 'task', detail: '仅访问本任务的共享事实与用户指定的源文件' },
  experience_policy: { strategy: 'candidate_review', detail: '排版偏好可作为候选经验提交评审，不自动改写' },
  install_source: BUILTIN_SOURCE,
  implementation: 'real',
  stub_reason: null,
  produces_file_formats: ['docx'],
  consumes_formats: ['docx'],
});

const SPREADSHEET_TEMPLATE: BusinessTemplateManifest = createBusinessTemplateManifest({
  kind: 'business_template',
  plugin_id: 'template.spreadsheet',
  display_name: '表格模板',
  version: '0.9.0',
  kernel_compatibility: KERNEL_0_9,
  capabilities: [
    { capability_id: 'cap.sheet.create', label: '新建表格', description: '按事实键生成 XLSX 工作簿' },
    { capability_id: 'cap.sheet.formula', label: '公式读写', description: '保存为可编辑公式而非固化数值' },
    { capability_id: 'cap.sheet.import', label: '导入表格', description: '解析既有 XLSX 与 CSV' },
  ],
  instructions: ['sheet.create：数值只来自事实快照，缺失不得当零', 'sheet.formula：写公式而非计算结果'],
  inputs: [
    { name: 'facts', kind: 'fact', description: '模板声明的输入事实键与快照', formats: [] },
    { name: 'source_file', kind: 'file', description: '可选：待编辑 / 导入的既有表格', formats: ['xlsx', 'csv'] },
  ],
  outputs: [{ name: 'workbook', kind: 'file', description: '生成的 XLSX 工作簿', formats: ['xlsx'] }],
  adapter_dependencies: [
    { adapter_id: 'builtin.xlsx_builder', kind: 'builtin', required: true, description: '仓库内 XLSX 构建器' },
  ],
  permissions: [
    { permission_id: 'perm.file.write', description: '写出文件到受控运行目录', required: true },
  ],
  data_scope: { level: 'task', detail: '仅访问本任务的共享事实与用户指定的源文件' },
  experience_policy: { strategy: 'candidate_review', detail: '列结构惯例可作为候选经验提交评审' },
  install_source: BUILTIN_SOURCE,
  implementation: 'real',
  stub_reason: null,
  produces_file_formats: ['xlsx'],
  consumes_formats: ['xlsx', 'csv'],
});

const PRESENTATION_TEMPLATE: BusinessTemplateManifest = createBusinessTemplateManifest({
  kind: 'business_template',
  plugin_id: 'template.presentation',
  display_name: '演示文稿模板',
  version: '0.9.0',
  kernel_compatibility: KERNEL_0_9,
  capabilities: [
    { capability_id: 'cap.slide.create', label: '新建演示文稿', description: '页数由任务决定，不固定两页' },
    { capability_id: 'cap.slide.theme', label: '主题与母版', description: '沿用既有母版，不每次扁平化重造' },
    { capability_id: 'cap.slide.import', label: '导入演示文稿', description: '导入既有 PPTX 并保留可编辑对象' },
  ],
  instructions: ['slide.create：结构由任务事实决定，不得固定页数', 'slide.objects：保持可编辑对象，不整页截图'],
  inputs: [
    { name: 'facts', kind: 'fact', description: '模板声明的输入事实键与快照', formats: [] },
    { name: 'source_file', kind: 'file', description: '可选：待编辑 / 导入的既有演示文稿', formats: ['pptx'] },
  ],
  outputs: [{ name: 'presentation', kind: 'file', description: '生成的 PPTX 文件', formats: ['pptx'] }],
  adapter_dependencies: [
    { adapter_id: 'builtin.pptx_builder', kind: 'builtin', required: true, description: '仓库内 PPTX 构建器' },
  ],
  permissions: [
    { permission_id: 'perm.file.write', description: '写出文件到受控运行目录', required: true },
  ],
  data_scope: { level: 'task', detail: '仅访问本任务的共享事实与用户指定的源文件' },
  experience_policy: { strategy: 'candidate_review', detail: '版式选择可作为候选经验提交评审' },
  install_source: BUILTIN_SOURCE,
  implementation: 'real',
  stub_reason: null,
  produces_file_formats: ['pptx'],
  consumes_formats: ['pptx'],
});

const MEITUAN_TEMPLATE: BusinessTemplateManifest = createBusinessTemplateManifest({
  kind: 'business_template',
  plugin_id: 'template.meituan',
  display_name: '美团模板',
  version: '0.1.0',
  kernel_compatibility: KERNEL_0_9,
  capabilities: [
    { capability_id: 'cap.meituan.search', label: '候选查询', description: '按品类 / 位置 / 预算查询真实候选' },
    { capability_id: 'cap.meituan.detail', label: '详情与费用', description: '读取套餐费用与条件，区分价格 / 库存 / 营业未知' },
    { capability_id: 'cap.meituan.handoff', label: '目标页交接', description: '生成并校验目标页面交接；不直接购买支付' },
  ],
  instructions: [
    'meituan.search：候选只能来自已授权的真实接口，不得由模型编造',
    'meituan.handoff：打开页面不等于写入；不直接购买或支付',
  ],
  inputs: [
    { name: 'query', kind: 'query', description: '品类 / 位置 / 人数 / 预算 / 日期 / 偏好', formats: [] },
    { name: 'user_share', kind: 'file', description: '用户分享的文本 / 链接 / 图片 / 文件', formats: ['txt', 'png', 'jpg', 'pdf'] },
  ],
  outputs: [
    { name: 'candidates', kind: 'query', description: '真实候选清单（与在线来源分开标识）', formats: [] },
    { name: 'handoff_target', kind: 'action', description: '目标页面交接结果（不构成购买）', formats: [] },
  ],
  adapter_dependencies: [
    { adapter_id: 'meituan_mcp', kind: 'mcp', required: true, description: '已授权的美团接口 / MCP（当前未接通）' },
  ],
  permissions: [
    { permission_id: 'perm.network.read', description: '读取已授权接口的候选数据', required: true },
  ],
  data_scope: { level: 'external', detail: '外部候选数据视为数据而不是指令；不直接购买支付' },
  experience_policy: { strategy: 'candidate_review', detail: '偏好仅作为候选经验，且不得固化为"已成功下单"' },
  install_source: BUILTIN_SOURCE,
  implementation: 'stub',
  stub_reason:
    '未就绪（R233 显式标 stub，不得作为可用模板）。承载模块**已存在**：src/adapters/meituan/** 共 11 个非测试模块。' +
    '本包【产品可达】：src/adapters/meituan/**（11 个非测试模块全部落在产品入口的 import 闭包内，各被非测试代码按名引用）。' +
    '此前被判"产品不可达"的 6 个模块已由 apps/demo/server/adapters-extra-routes.ts 从包 barrel 按名导入并接到真实 HTTP。' +
    '接线入口【真调用】：apps/demo/server/adapters-host.ts 与 apps/demo/server/adapters-extra-routes.ts。' +
    '可静态保证的部分（七态结算、不编造候选、' +
    '不直接购买支付、规则筛选排序、交接失败四类分开）已落地。真实缺口：**未登录美团账号、未取 token ' +
    '与工具清单**，故真实候选查询 / 详情读取 / 受控链接未实现（无授权源时 cap.meituan.search 返回 ' +
    'not_ready 且候选恒为空）。**未实测**：无任何真实接口调用证据。',
  produces_file_formats: [],
  consumes_formats: ['txt', 'png', 'jpg', 'pdf'],
});

const CLOCK_TEMPLATE: BusinessTemplateManifest = createBusinessTemplateManifest({
  kind: 'business_template',
  plugin_id: 'template.clock',
  display_name: '时钟模板',
  version: '0.1.0',
  kernel_compatibility: KERNEL_0_9,
  capabilities: [
    { capability_id: 'cap.clock.alarm', label: '闹钟管理', description: '创建 / 修改 / 启停自管闹钟' },
    { capability_id: 'cap.clock.timer', label: '计时器', description: '计时器与秒表' },
    { capability_id: 'cap.clock.system_handoff', label: '系统时钟交接', description: '经已核验接口交接系统时钟动作' },
  ],
  instructions: [
    'clock.alarm：相对时间必须解析成具体时间供用户核对',
    'clock.system：没有系统读取接口不得伪造完整闹钟列表；dismiss 不等同删除',
  ],
  inputs: [{ name: 'request', kind: 'query', description: '时间 / 时区 / 标签 / 重复规则', formats: [] }],
  outputs: [{ name: 'clock_action', kind: 'action', description: '自管或系统侧的时钟动作', formats: [] }],
  adapter_dependencies: [
    { adapter_id: 'clock_system_api', kind: 'system_api', required: true, description: '系统时钟接口（权限未在设备核实）' },
  ],
  permissions: [
    { permission_id: 'perm.clock.schedule', description: '精确提醒 / 闹钟调度', required: true },
  ],
  data_scope: { level: 'user', detail: '仅访问本工具可管理的闹钟；不越权读取系统全部闹钟' },
  experience_policy: { strategy: 'none', detail: '时钟动作不产生通用经验' },
  install_source: BUILTIN_SOURCE,
  implementation: 'stub',
  stub_reason:
    '未就绪（R233 显式标 stub，不得作为可用模板）。承载模块**已存在**：src/adapters/clock/** 共 17 个非测试模块。' +
    '本包【产品可达】：src/adapters/clock/**（自管闹钟模型与生命周期 / 重复规则展开 / 相对时间解析 / ' +
    '计时器 / 秒表 / 世界时钟 / 动作台账 / 精确提醒还原，17 个非测试模块全部落在产品入口的 import 闭包内，各被非测试代码按名引用）。' +
    '此前被判"产品不可达"的 src/adapters/clock/reminder-restore.ts 已由 apps/demo/server/adapters-extra-routes.ts 按名导入并接到真实 HTTP。' +
    '接线入口【真调用】：apps/demo/server/adapters-host.ts 与 apps/demo/server/adapters-extra-routes.ts。' +
    '另有 src/session/adapters/cal-clock.ts 自身【真调用】：apps/demo/server/session-adapters-wiring.ts' +
    '（FA-FIX-TAUTOLOGY 之后它已被按名调用，不再是"只靠桶进闭包"那一类）。' +
    '真实缺口：**系统时钟侧阻塞**——公开 Android 平台没有枚举 / 删除' +
    '系统闹钟的合法通道（AlarmClock 只是 Intent 契约）；精确到点触发通道未接通；**真机未连接**，' +
    '精确提醒 / 通知权限与系统权限均未在设备上核实。**未实测**：无任何真机触发证据。',
  produces_file_formats: [],
  consumes_formats: [],
});

const CALENDAR_TEMPLATE: BusinessTemplateManifest = createBusinessTemplateManifest({
  kind: 'business_template',
  plugin_id: 'template.calendar',
  display_name: '日历模板',
  version: '0.1.0',
  kernel_compatibility: KERNEL_0_9,
  capabilities: [
    { capability_id: 'cap.calendar.read', label: '日程查询', description: '读取获准日历并按范围 / 关键词查询' },
    { capability_id: 'cap.calendar.write', label: '事件写入', description: '创建 / 修改 / 删除事件并读回' },
    { capability_id: 'cap.calendar.handoff', label: '系统编辑页交接', description: '授权直写与打开系统编辑页区分' },
  ],
  instructions: [
    'calendar.write：保存参与者不等于已发邀请；打开编辑页不得标创建完成',
    'calendar.recur：编辑本次 / 后续 / 整个系列分别处理',
  ],
  inputs: [{ name: 'request', kind: 'query', description: '日期范围 / 标题 / 起止 / 时区 / 地点', formats: [] }],
  outputs: [{ name: 'calendar_action', kind: 'action', description: '日程读写结果（绑真实 eventId）', formats: [] }],
  adapter_dependencies: [
    { adapter_id: 'calendar_system_api', kind: 'system_api', required: true, description: '系统日历接口（权限未在设备核实）' },
  ],
  permissions: [
    { permission_id: 'perm.calendar.read', description: '读取获准日历', required: true },
    { permission_id: 'perm.calendar.write', description: '写入 / 修改日程', required: true },
  ],
  data_scope: { level: 'user', detail: '仅访问用户获准的日历目录' },
  experience_policy: { strategy: 'none', detail: '日历动作不产生通用经验' },
  install_source: BUILTIN_SOURCE,
  implementation: 'stub',
  stub_reason:
    '未就绪（R233 显式标 stub，不得作为可用模板）。承载模块**已存在**：src/adapters/calendar/** 共 13 个非测试模块。' +
    '本包【产品可达】：src/adapters/calendar/**（事件模型 / 重复展开 / 三种编辑范围计划 / 忙闲冲突 / 两种写路径，' +
    '各被非测试代码按名引用）。' +
    '接线入口【真调用】：apps/demo/server/adapters-host.ts。' +
    '真实缺口：**设备侧 CalendarContract 授权与可写范围未在真机核实**（真机未连接）；' +
    '"打开系统编辑页"那条路径结构上最高只能报"已交接"，不得到"已创建"。' +
    '**未实测**：无任何真机读写证据。',
  produces_file_formats: [],
  consumes_formats: [],
});

const RESEARCH_TEMPLATE: BusinessTemplateManifest = createBusinessTemplateManifest({
  kind: 'business_template',
  plugin_id: 'template.research',
  display_name: '资料检索模板',
  version: '0.1.0',
  kernel_compatibility: KERNEL_0_9,
  capabilities: [
    { capability_id: 'cap.research.query', label: '资料查询', description: '真实查询端口 + 关键词 / 自然语言约束' },
    { capability_id: 'cap.research.extract', label: '正文抽取', description: '读取获准链接与正文并记录来源' },
    { capability_id: 'cap.research.publish', label: '事实发布', description: '向其他模板发布版本化事实' },
  ],
  instructions: [
    'research.query：不得把模型已有知识当作联网检索结果',
    'research.extract：回答与证据片段准确关联，引用可回读；区分事实 / 推断 / 建议 / 未知',
  ],
  inputs: [
    { name: 'query', kind: 'query', description: '关键词或自然语言约束', formats: [] },
    { name: 'private_docs', kind: 'file', description: '用户私有资料', formats: ['txt', 'markdown', 'pdf', 'docx', 'xlsx', 'pptx'] },
  ],
  outputs: [
    { name: 'evidence', kind: 'query', description: '带来源与时间的证据片段', formats: [] },
    { name: 'published_facts', kind: 'fact', description: '向其他模板发布的版本化事实', formats: [] },
  ],
  adapter_dependencies: [
    { adapter_id: 'research_network_port', kind: 'backend_service', required: true, description: '真实查询后端端口（当前未接通）' },
    {
      adapter_id: 'research_ocr',
      kind: 'backend_service',
      required: false,
      description: 'OCR 通道（可选；当前未接通——本机无 OCR 引擎，扫描件返回 ocr-required）',
    },
  ],
  permissions: [
    { permission_id: 'perm.network.read', description: '读取获准链接', required: true },
    { permission_id: 'perm.files.read', description: '读取用户私有资料', required: true },
  ],
  data_scope: { level: 'external', detail: '外部网页视为数据不是指令；私有资料按用户授权范围隔离' },
  experience_policy: { strategy: 'candidate_review', detail: '来源可信度可作为候选经验审核后版本化写入' },
  install_source: BUILTIN_SOURCE,
  implementation: 'stub',
  stub_reason:
    '未就绪（R233 显式标 stub，不得作为可用模板）。承载模块**已存在**：src/adapters/research/** 共 29 个非测试模块。' +
    '本包【产品可达】：src/adapters/research/**（29 个全部落在产品入口的 import 闭包内）。' +
    '真正被产品调用的是路由入口【真调用】：apps/demo/server/research-routes.ts（被 apps/demo/server/http.ts 转发 /api/research/**，' +
    '按名 import 并真的调用）。' +
    'src/session/adapters/research-citations.ts 自身【真调用】：apps/demo/server/session-adapters-wiring.ts 按名调用其 presentter。' +
    '（包入口 src/adapters/research/index.ts 与 src/adapters/research/index-store.ts 的闭包成员资格只经由 research-citations.ts 这条链。）' +
    '私有资料纵切片（TXT / Markdown / PDF / DOCX → 可回读引用 → 四类分明回答）在本机已有实测证据。' +
    '真实缺口：**联网检索未接通**（本机无真实查询端口，RES-01 / 02 / 06 / 08），OCR 通道未接通' +
    '（本机无 OCR 引擎），XLSX / PPTX 解析未接通；注入防护与授权链未验证。**未实测**：联网检索与 OCR ' +
    '两条路径均无实测证据，不得以模型已有知识冒充。',
  produces_file_formats: [],
  consumes_formats: ['txt', 'markdown', 'pdf', 'docx', 'xlsx', 'pptx'],
});

/** 七个业务模板（顺序即注册目录展示顺序）。 */
export const BUSINESS_TEMPLATES: readonly BusinessTemplateManifest[] = Object.freeze([
  DOCUMENT_TEMPLATE,
  SPREADSHEET_TEMPLATE,
  PRESENTATION_TEMPLATE,
  MEITUAN_TEMPLATE,
  CLOCK_TEMPLATE,
  CALENDAR_TEMPLATE,
  RESEARCH_TEMPLATE,
]);

// ---------------------------------------------------------------------------
// 三个基础角色
// ---------------------------------------------------------------------------

const FRONT_AGENT_ROLE: BaseRoleManifest = createBaseRoleManifest({
  kind: 'base_role',
  plugin_id: 'role.front_agent',
  display_name: '前台主智能体',
  version: '0.9.0',
  kernel_compatibility: KERNEL_0_9,
  runtime_identity: 'foreground_primary',
  capabilities: [
    { capability_id: 'cap.role.converse', label: '对话', description: '与用户多轮自然对话' },
    { capability_id: 'cap.role.discover', label: '能力发现', description: '读取可用操作清单，按需取用' },
    { capability_id: 'cap.role.task_control', label: '任务控制', description: '创建 / 续接 / 取消任务，业务执行交后台' },
    { capability_id: 'cap.role.present', label: '呈现', description: '呈现结果与决策气泡' },
  ],
  instructions: ['前台只做对话与任务控制，业务执行一律交后台执行器', '能力发现只读可用操作清单，不加载全部模板全文'],
  inputs: [{ name: 'user_turn', kind: 'text', description: '用户的一轮输入', formats: [] }],
  outputs: [{ name: 'agent_turn', kind: 'text', description: '回复或任务指令', formats: [] }],
  adapter_dependencies: [
    { adapter_id: 'model_port', kind: 'backend_service', required: true, description: '真实模型调用端口' },
  ],
  permissions: [{ permission_id: 'perm.model.invoke', description: '调用真实模型', required: true }],
  data_scope: { level: 'user', detail: '只访问当前用户会话与经授权的记忆' },
  experience_policy: { strategy: 'candidate_review', detail: '前台可提交经验候选，由经验维护角色审核' },
  install_source: BUILTIN_SOURCE,
  implementation: 'stub',
  stub_reason:
    '未就绪（R233 显式标 stub，不得据此认为角色可用）。承载模块**已存在**：src/roles/main-agent.ts ' +
    '（ROLE-01，动作白名单六件事 / 直接执行结构化拒绝 / 业务只经内核交后台）。' +
    '角色整包【产品可达】：src/roles/**（5 个模块全在产品入口 import 闭包内，各被非测试代码按名引用）。' +
    '接线入口【真调用】：apps/demo/server/roles-wiring.ts（路由根 /api/roles，被产品入口 import 并真的穿过角色实现）。' +
    '真实缺口：默认给的是结构化桩 createStructuralMainAgentPorts，**未接真实模型**。' +
    '**未实测**：无真实对话证据。',
});

const GROUP_FOLLOWER_ROLE: BaseRoleManifest = createBaseRoleManifest({
  kind: 'base_role',
  plugin_id: 'role.group_follower',
  display_name: '群内分身',
  version: '0.9.0',
  kernel_compatibility: KERNEL_0_9,
  runtime_identity: 'group_follower',
  capabilities: [
    { capability_id: 'cap.role.relay', label: '必要上下行', description: '必要的消息上下行，不做串行转发点' },
    { capability_id: 'cap.role.aggregate', label: '问题汇总', description: '汇总群内待决问题' },
    { capability_id: 'cap.role.recover', label: '有限停滞恢复', description: '在受限范围内做停滞恢复' },
  ],
  instructions: ['分身不得成为串行转发点', '停滞恢复动作有上限，超限上报而不自行扩权'],
  inputs: [{ name: 'member_messages', kind: 'text', description: '群内成员消息', formats: [] }],
  outputs: [{ name: 'aggregated_question', kind: 'text', description: '汇总后的问题或上行', formats: [] }],
  adapter_dependencies: [],
  permissions: [{ permission_id: 'perm.group.read', description: '读取本群消息', required: true }],
  data_scope: { level: 'task', detail: '仅本任务群组范围' },
  experience_policy: { strategy: 'none', detail: '分身不写经验' },
  install_source: BUILTIN_SOURCE,
  implementation: 'stub',
  stub_reason:
    '未就绪（R233 显式标 stub，不得据此认为角色可用）。承载模块**已存在**：src/roles/group-fork.ts ' +
    '（ROLE-02，上下行两通道 / 任务范围白名单 / 有界停滞恢复 / 拓扑判定），不再只是"融合在调度内核与假 Agent 中"。' +
    '角色整包【产品可达】：src/roles/**（5 个模块全在产品入口 import 闭包内，各被非测试代码按名引用）。' +
    '接线入口【真调用】：apps/demo/server/roles-wiring.ts。' +
    '真实缺口：消息实际投递与停滞诊断的实际执行仍由宿主经内核完成。**未实测**：未接真实执行器。',
});

const EXPERIENCE_MAINTAINER_ROLE: BaseRoleManifest = createBaseRoleManifest({
  kind: 'base_role',
  plugin_id: 'role.experience_maintainer',
  display_name: '经验维护智能体',
  version: '0.9.0',
  kernel_compatibility: KERNEL_0_9,
  runtime_identity: 'experience_maintainer',
  capabilities: [
    { capability_id: 'cap.role.experience_propose', label: '经验候选', description: '按已封存证据提出候选，可得出"不新增"' },
    { capability_id: 'cap.role.experience_review', label: '经验审核', description: '敏感 / 冲突 / 去重检查后版本化写入' },
  ],
  instructions: [
    '只能基于已封存证据提候选，可得出"不新增"',
    '不得修改权限或工具地址（经验维护角色不扩权）',
  ],
  inputs: [{ name: 'sealed_evidence', kind: 'fact', description: '已封存的执行证据', formats: [] }],
  outputs: [{ name: 'experience_candidate', kind: 'action', description: '经验候选（新增 / 不新增 / 拒绝）', formats: [] }],
  adapter_dependencies: [],
  permissions: [{ permission_id: 'perm.memory.write', description: '写入模板经验', required: true }],
  data_scope: { level: 'template', detail: '仅模板级通用经验；不得读其他用户私有记忆' },
  experience_policy: { strategy: 'auto_versioned', detail: '本角色自身产出即为版本化经验写入' },
  install_source: BUILTIN_SOURCE,
  implementation: 'stub',
  stub_reason:
    '未就绪（R233 显式标 stub，不得据此认为角色可用）。承载模块**已存在**：src/roles/experience-agent.ts ' +
    '（ROLE-03，只按已封存且读回验证的证据提候选 / 可得出"不新增" / 不扩权可断言）。' +
    '它只读复用 src/memory/experience.ts 的 evaluateExperienceCandidate（该文件自身【产品可达】，经 apps/demo/server/memory-routes.ts 接进产品入口）。' +
    '角色整包【产品可达】：src/roles/**（5 个模块全在产品入口 import 闭包内，各被非测试代码按名引用）。' +
    '接线入口【真调用】：apps/demo/server/roles-wiring.ts。' +
    '真实缺口：**未接真实模型 / 真实执行器**（候选→决定是纯计算，落库由宿主另行接线）。' +
    '**未实测**：运行时身份未核实。',
});

/** 三个基础角色（顺序即注册目录展示顺序）。 */
export const BASE_ROLES: readonly BaseRoleManifest[] = Object.freeze([
  FRONT_AGENT_ROLE,
  GROUP_FOLLOWER_ROLE,
  EXPERIENCE_MAINTAINER_ROLE,
]);

/**
 * 完整注册目录（七个业务模板 + 三个基础角色）。
 * 注意：这是**一个目录**，但模板与角色分属**两个不同的清单类型 / 枚举**（R200）。
 */
export const PLUGIN_CATALOG: readonly PluginManifest[] = Object.freeze([
  ...BUSINESS_TEMPLATES,
  ...BASE_ROLES,
]);

/** 按 id 取清单（查不到返回 `undefined`，**不编造**）。 */
export function findPluginManifest(pluginId: string): PluginManifest | undefined {
  return PLUGIN_CATALOG.find((manifest) => manifest.plugin_id === pluginId);
}

/** 目录中业务模板的数量（应为 7；供注册表与测试核对，不硬编码在别处）。 */
export const BUSINESS_TEMPLATE_COUNT = BUSINESS_TEMPLATES.length;
/** 目录中基础角色的数量（应为 3）。 */
export const BASE_ROLE_COUNT = BASE_ROLES.length;
