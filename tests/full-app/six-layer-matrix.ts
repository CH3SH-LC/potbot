/**
 * FA-Q 独立验证 —— 六层验证矩阵骨架（判据先行，不等实现）
 *
 * 来源：`docs/other/ds-full-app-10h-worktree-2026-10-03.md` §10「交付与验收组织」的
 * 六层表 + A01–A19 跨层映射表；范围 `docs/other/full-app-capability-catalog-2026-10-03.md` §9。
 *
 * 本文件是**纯数据**，不 import 任何产品实现。它把「每层必须证明什么 / 当前有什么证据 /
 * 缺什么」固定下来，供 `verify-matrix.test.ts` 机器化核对自洽性，并防止后续把
 * 「跳过」写成「通过」。
 *
 * 纪律：
 *  - 六层是 §10 第一张表给出的**规范层**（kernel/executor/templates/independent/app/cross）。
 *  - §10 的 A01–A19 映射表另点名「手机/消费端实际打开」——那**不是**六层之一，
 *    因此单列为跨切门 `device`（真机/消费端），**不得**把它塞进六层冒充已覆盖。
 *  - `status` 三态：'verified'（有独立证据）/ 'unverified'（未验）/ 'impossible'（当前前置下不可能）。
 *    **'skipped' 不在此枚举内**——跳过不是一种状态，跳过必须体现在用例名里（见 criteria/）。
 */

export const LAYER_IDS = ['kernel', 'executor', 'templates', 'independent', 'app', 'cross'] as const;
export type LayerId = (typeof LAYER_IDS)[number];

/** 本矩阵的修订时刻。首次建立 2026-10-03 05:16；**第二次修订 2026-10-03 10:52**（外部监督 P3）。 */
export const MATRIX_REVISED_AT = '2026-10-03T10:52+0800';

/**
 * 「保存 → 关闭 → 重开 → 再编辑」的**当次证据**：截至修订时刻为 **none**。
 * 外部监督 2026-10-03 10:26 复核同结论。这是**不得**被当作已验的一环。
 */
export const REOPEN_EDIT_EVIDENCE = 'none_as_of_2026-10-03T10:52+0800';

/** 跨切门：§10 映射表点名「手机/消费端」，但它不在六层之列，也不代表已实现。 */
export const EXTRA_GATES = ['device'] as const;
export type ExtraGate = (typeof EXTRA_GATES)[number];

export type AcceptanceStatus = 'verified' | 'unverified' | 'impossible';

export interface LayerSpec {
  readonly id: LayerId;
  /** §10 原文的「必须证明」 */
  readonly must_prove: string;
  /** 按 §10 与合同，本层在当前基线下**已经**有什么证据（若没有，写「无」） */
  readonly evidence_now: string;
  /** 按 §10 与合同，本层当前**缺**什么 */
  readonly missing: string;
  /** 本层的验证入口（测试文件/命令/工具），未建立时写「未建立」 */
  readonly entry: string;
  readonly status: AcceptanceStatus;
}

export const LAYER_SPECS: readonly LayerSpec[] = [
  {
    id: 'kernel',
    must_prove:
      'A01–A19 中适用的逻辑子项，含真并发/租约/取消/版本/重启/预算；假 Agent 只作可控测试，不能关闭真实文件/设备要求',
    evidence_now:
      '同进程内 A02/A03/A04/A05 与版本闸门（`tests/acceptance/{a02a03,a04,a05,p4,p7p8,reliability}/**`、FREEZE-6）。**新增（2026-10-03 10:5x 复核）**：`src/storage/file-store.ts` 落地，`apps/demo/server/main.ts:416/674` 把**落盘 store（含跨进程锁；读不回即拒绝启动）**注入 `KernelHost`；R261–R263 完成口径与 **R264 空集/版本绑定补强**已落地（`apps/demo/server/task-completion.ts:176`，测试 `task-completion.false-success.test.ts`）。',
    missing:
      '**ID 连续性未解**（F1：`src/protocol/ids.ts` 计数器每进程重置）；**可信身份重建未解**（F3：无 `SenderBinding` 重建入口）——故即便 store 已落盘，"重启后恢复"仍不完整；租约过期回收未验；A16 两群组写同一**最终文件路径**仍无用例（文件锁随 file-store 落地，但 A16 判据未接）。',
    entry: 'tests/acceptance/**（既有）；tests/full-app/structural-prereqs.ts（F1/F2/F3）',
    status: 'unverified',
  },
  {
    id: 'executor',
    must_prove: '实际模型调用、受控工具循环、按需多成员协作、必要记忆注入；不能由预先写死业务脚本冒充',
    evidence_now:
      '`src/fake/**` 假执行器与其断言。**新增 H2 闭环（2026-10-03 07:33）**：FA-N `live-h2-output-多轮.txt` —— 真实编译宿主 + 真实 HTTP + 真实模型（本地路由 `deepseek-flash[1m]`）跑**两轮同一会话连续对话** → 真实 DOCX，**独立 Python 读回 13/13**（每轮各一）。首轮失败样例亦如实留档（`live-h2-output-run1-未产出.txt`）。',
    missing:
      '**多成员协作（群内分身）与记忆注入**未在真实模型下证明——H2 是"单 Agent 多轮"，不是群组协作；`FA-T/FA-U` 的 XLSX/PPTX 产品入口跑时 **modelConfigured=false**，故不构成模型驱动的表格/演示证明；模型是**本地路由**非公网云、**非设备**。',
    entry: 'FA-N `live-h2-run.mjs`（`.task-manifest/outputs/FA-N/`）',
    status: 'unverified',
  },
  {
    id: 'templates',
    must_prove: '每个目录子项从产品入口到文件/工具结果，更新/删除/失败/未知及重开后再操作',
    evidence_now:
      'DOCX 有真实读写与 ooxml 容器核心（FREEZE-6）。**新增产品入口（2026-10-03 09:22/10:26）**：XLSX/PPTX 经内核链交付——FA-T `evidence/e2e-transcript.txt`（真实宿主 `/api/deliverables`→`/edits`→下载；XLSX 4171B、PPTX 14945B/3 页）与 FA-U `evidence/delivered/delivered-{xlsx,pptx}.bin + readback.json`。',
    missing:
      '六个非办公模板（美团/时钟/日历/检索）无**产品闭环**（三工具只有 HTTP 入口，见 A14/A18；且网页/模型侧**无 `/api/adapters` 消费者**）。**表格/演示模板本体仍是固定形状**（F8：pptx 恒 2 页、xlsx 恒单表且无公式、无 XLSX/PPTX 导入）——"产品入口可达" ≠ "模板具备完整操作"。XLS-01..18 / PPT-01..16 / MT/CLK/CAL/RES 全量仍缺。',
    entry: 'FA-T/FA-U evidence；tests/full-app/structural-prereqs.ts（F8）',
    status: 'unverified',
  },
  {
    id: 'independent',
    must_prove: '独立解析与语义/数值核对、目标软件真实打开；工具动作看可信回执或读回，打开页面不等于写入',
    evidence_now:
      'DOCX 有独立读回（unzip/OOXML 解析）与 §8b「能加载并读回」的**降级**证据（FREEZE-6）。**新增**：XLSX/PPTX **下载字节**的独立 Python 读回（FA-T `verify-office-format.py`；FA-U 改用**另一份**独立 verifier `verify-office-bytes.py`，刻意不继承同一错误）。',
    missing:
      '仍缺**目标软件真实打开**（安卓 WPS/Word）与"打开后仍可编辑"的读回——**第三层未验证**（本机 Office 无授权、非目标平台）；缺数值/公式级语义核对（模板本体无公式，F8）。',
    entry: 'tests/acceptance/office/**（既有一部）；FA-T/FA-U evidence；本套件提供「打开≠写入」判据',
    status: 'unverified',
  },
  {
    id: 'app',
    must_prove: '冷启动、连续对话、会话隔离、退后台/断网/重启、任务恢复和忘记，文件/任务/模板管理全页面可达',
    evidence_now:
      '电脑侧 Demo 宿主+网页层；APK 存在（`app-debug.apk`）。**设备当次可达（2026-10-03 10:50:52）**：`honor-connect doctor` → verdict **ready**、vendor auth **verified**、readOnlyShell true、model **PTP-AN00**（见 `tests/full-app/device-status.ts`）。**注**：同刻 `honor-connect status` 因 `host_health_unreachable`（本机 8765 宿主服务未运行）在枚举前短路；`adb` 不在 PATH，故旧"adb 为空"是弱证据。',
    missing:
      '设备可达 **≠** 验收已做：无任何真机验收动作（按纪律未做）；后台机制整层缺席（F10）；**"保存 → 关闭 → 重开 → 再编辑"无当次证据**（不在设备、不在新进程、不在产品入口——只有同进程单测重开与 store/会话级重启）。',
    entry: 'tests/full-app/device-status.ts；真机验收需协调者的唯一窗口',
    status: 'unverified' /* 由 impossible 改判：设备当次可达，前置已具备，只是未做 */,
  },
  {
    id: 'cross',
    must_prove: '人数变更使预算/文档/PPT/相关动作同版更新；旧气泡失效、不动无关事实；真实失败分支仍可交付部分结果',
    evidence_now:
      '仅单模板版本闸门证据（FREEZE-6 `office-products-j9-version-gate.json`）。FA-U 的 R261–R264 完成口径是**任务级**谓词，不是跨模板同版更新；FA-T/FA-U 的 XLSX/PPTX 是**独立交付**，未展示"一个事实驱动三件同版更新"。',
    missing: '八人→十人的跨模板同版更新（表格公式/正文/PPT图/日程提醒）、旧气泡过期、无关事实不动——均未实现/未验（F7/F5）。',
    entry: '未建立（需实现 + 跨模板夹具）',
    status: 'unverified',
  },
];

// ---------------------------------------------------------------------------
// A01–A19 逐项跨层映射
// ---------------------------------------------------------------------------

export interface AcceptanceItem {
  readonly id: `A${string}`;
  /** 原任务书 §19「测试情形」 */
  readonly scenario: string;
  /** 原任务书 §19「通过条件」 */
  readonly pass_condition: string;
  /** §10 映射表原文「必需层与关键结果」 */
  readonly guide_required_text: string;
  /** 归一化后的必需层（§10 文本 → 六层 + 跨切门） */
  readonly required_layers: readonly LayerId[];
  readonly required_extra_gates: readonly ExtraGate[];
  readonly status: AcceptanceStatus;
  /** 验证入口：已存在的测试/证据，或「未建立」 */
  readonly entry: string;
  /** status 为 unverified/impossible 时，缺什么的短述 */
  readonly gap: string;
}

export const ACCEPTANCE_ITEMS: readonly AcceptanceItem[] = [
  {
    id: 'A01',
    scenario: '正常文件任务',
    pass_condition: '实际生成可打开文件，关键字段符合要求',
    guide_required_text: '真实执行器、产物独立读回、手机/消费端实际打开文件',
    required_layers: ['executor', 'independent'],
    required_extra_gates: ['device'],
    status: 'unverified',
    entry: 'tests/acceptance/office/**（DOCX 部分）；FA-T/FA-U 证据；本套件 criteria/ 提供「可打开」正反判据',
    gap:
      '**已收窄**：XLSX/PPTX 现有真实产物（FA-T 4171B / FA-U）并经独立读回。仍缺：**手机/消费端实际打开**（设备当次可达但未做验收；无授权 Office）。',
  },
  {
    id: 'A02',
    scenario: '多成员请求空闲实例',
    pass_condition: '不并发启动重复轮次，不丢请求',
    guide_required_text: '确定性同时到达 + 真实调度执行，不并发启动同一实例、不丢请求',
    required_layers: ['kernel', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: 'tests/acceptance/a02a03/**（确定性内核部分，已有）',
    gap: '真实调度执行器下未复验；仅假 Agent 结论。',
  },
  {
    id: 'A03',
    scenario: '运行中连续唤醒',
    pass_condition: '合并后续排队，但每项工作都有结局',
    guide_required_text: '运行中合并唤醒 + 真实执行器，各独立请求均有结局',
    required_layers: ['kernel', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: 'tests/acceptance/a02a03/**（既有）',
    gap: '真实执行器下未复验。',
  },
  {
    id: 'A04',
    scenario: '重复消息送达',
    pass_condition: '相同消息不会重复创建业务工作',
    guide_required_text: '消息去重持久化 + 重连/重启，不重复业务工作',
    required_layers: ['kernel', 'app'],
    required_extra_gates: [],
    status: 'unverified',
    entry: 'tests/acceptance/a04/**（同进程去重，既有）',
    gap: '跨重连/重启的持久化去重未验证。',
  },
  {
    id: 'A05',
    scenario: '循环依赖',
    pass_condition: '有限诊断后暂停或报告，不无限互唤',
    guide_required_text: '循环依赖/停滞诊断预算 + 真实暂停和用户报告，不空转',
    required_layers: ['kernel'],
    required_extra_gates: [],
    status: 'unverified',
    entry: 'tests/acceptance/a05/**（诊断逻辑，既有）',
    gap: '自动故障恢复（A05-10）与租约过期回收未验证（FREEZE-6 遗留）。',
  },
  {
    id: 'A06',
    scenario: '缺少能力或权限',
    pass_condition: '报告缺失，不编造能力或借成员越权',
    guide_required_text: '注册/权限逻辑 + 真实适配器拒绝，不能借其他成员越权',
    required_layers: ['kernel', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: 'FA-X `selfcheck-boot-smoke.txt`（真实 HTTP 启动烟测）；apps/demo/server/adapters-host.test.ts',
    gap:
      '**已收窄**：三工具（时钟/日历/美团）现有 HTTP 入口，且 not_ready/blocked 有结构化状态码（clock `system-alarms` 501 blocked、meituan `search` 503 not_ready）。仍缺：**网页/模型侧无 `/api/adapters` 消费者** ⇒ 无自然语言闭环；权限门仍不存在（F6）。',
  },
  {
    id: 'A07',
    scenario: '用户修改需求',
    pass_condition: '相关产物更新，旧气泡失效',
    guide_required_text: 'App 修改要求 + 共享事实/依赖 + 三文件新版本及旧气泡失效',
    required_layers: ['app', 'kernel', 'templates', 'independent'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '未建立（FREEZE-6 V7 登记：A07 未覆盖）',
    gap: '三文件新版本联动与旧气泡失效均未实现。',
  },
  {
    id: 'A08',
    scenario: '旧轮次迟到',
    pass_condition: '旧结果不能覆盖当前任务',
    guide_required_text: '迟到结果并发负例 + 产物发布读回，旧结果不覆盖当前版本',
    required_layers: ['kernel', 'independent'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '本套件 criteria/ 提供「迟到结果不得覆盖新版本」判据；产品侧需版本闸门',
    gap: '并发迟到负例的产品侧读回未建立。',
  },
  {
    id: 'A09',
    scenario: '用户取消',
    pass_condition: '未提交旧动作不再执行，已发生副作用如实保留',
    guide_required_text: 'App 取消 + 内核/真实工具，未提交动作停止，已发生副作用如实保留',
    required_layers: ['app', 'kernel', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '未建立（需真机 App + 真实工具）',
    gap: 'App 取消入口与真实工具副作用保留未验证。',
  },
  {
    id: 'A10',
    scenario: '应用重启或实例释放',
    pass_condition: '从任务记录恢复，不依赖原上下文仍在内存中',
    guide_required_text: 'App 与后端分别重启 + 队列/会话/记忆/身份恢复，释放实例后可续接',
    required_layers: ['app', 'kernel'],
    required_extra_gates: [],
    status: 'unverified',
    entry: 'apps/demo/server/main.ts:416/674（落盘 store 已接线）；tests/full-app/structural-prereqs.ts（F1/F3）',
    gap:
      '**已收窄**：落盘 store（含跨进程锁、读不回即拒绝启动）已注入生产路径。仍缺：**ID 连续性（F1）**与**可信身份重建（F3）**——有持久 store 也**不等于**重启后能恢复任务/消息/身份；且**"保存→重开→再编辑"无当次证据**。',
  },
  {
    id: 'A11',
    scenario: '外部结果未知',
    pass_condition: '不宣称完成，不盲目重试造成重复写入',
    guide_required_text: '工具未知结果故障注入 + 真实适配器恢复，不盲目重复外部写入',
    required_layers: ['kernel', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '未建立（FREEZE-6 V7：A11 未覆盖）',
    gap: '未知结果故障注入与真实适配器都不存在。',
  },
  {
    id: 'A12',
    scenario: '从美团返回',
    pass_condition: '不自动标记购买完成',
    guide_required_text: '真机美团跳转并返回，保持交接/未知，不能自动判购买完成',
    required_layers: ['executor'],
    required_extra_gates: ['device'],
    status: 'impossible',
    entry: '未建立（FA-X boot smoke：`meituan search` 503 not_ready、purchase 403）',
    gap:
      '美团真实接口未登录（`search` 503 not_ready、无授权源 ⇒ 候选恒空）；**设备虽当次可达，但未接美团、未做跳转/返回验收**。',
  },
  {
    id: 'A13',
    scenario: '条件冲突或费用缺失',
    pass_condition: '报告无解或未知，不暗改条件，不把未知当零',
    guide_required_text: '冲突/缺失事实 + 办公计算/真实检索，无解/未知不被补造',
    required_layers: ['kernel', 'templates', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '部分：`src/protocol/facts.ts` 的 unknown/not_applicable 载荷（FREEZE-6 已验）；本套件加「缺失不当零」判据',
    gap: '办公计算与真实检索侧的无解/未知路径未建立。',
  },
  {
    id: 'A14',
    scenario: '注入伪指令或假批准',
    pass_condition: '不获得工具授权，不直接触发执行',
    guide_required_text: '文档/网页/工具假指令和假批准 + 权限门，不能触发未授权动作',
    required_layers: ['kernel', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '本套件 criteria/ 提供「假批准不授权」判据；产品权限门需实现',
    gap: '权限门与外部内容注入防护未实现。',
  },
  {
    id: 'A15',
    scenario: '重复点击气泡',
    pass_condition: '内核不重复提交同一动作',
    guide_required_text: '手机重复点击 + 动作持久幂等与真实适配器，不重复提交',
    required_layers: ['app', 'kernel', 'executor'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '本套件 criteria/ 提供「幂等键防重复提交」判据；动作层需实现',
    gap: '动作幂等键与气泡持久化未实现。',
  },
  {
    id: 'A16',
    scenario: '两群组写同一资源',
    pass_condition: '锁或版本检查阻止静默覆盖',
    guide_required_text: '两群组/两个工作进程写同一资源 + 最终文件/动作读回，无静默覆盖',
    required_layers: ['kernel', 'independent'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '未建立（FREEZE-6 V7：`src/**` 内无锁/期望版本检查）',
    gap: '并发写同一最终路径无用例阻止静默覆盖。',
  },
  {
    id: 'A17',
    scenario: '经验污染与模板更新',
    pass_condition: '未核验成功不被固化，旧实例不热换规则',
    guide_required_text: '经验候选/污染/模板更新 + 后续真实实例，旧实例不热换规则',
    required_layers: ['kernel', 'executor', 'templates'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '未建立（MEM-06/07 未实现）',
    gap: '经验生命周期与实例固定版本未实现。',
  },
  {
    id: 'A18',
    scenario: '插件停用或权限撤销',
    pass_condition: '不再新建被停用实例，后续调用受撤销影响',
    guide_required_text: 'App 停用模板/撤权 + 已运行实例下一次工具调用，限制即时生效',
    required_layers: ['app', 'kernel'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '未建立（模板平台 PLG-02/04 未实现）',
    gap: '停用/撤权即时生效未实现。',
  },
  {
    id: 'A19',
    scenario: '预算耗尽或断网',
    pass_condition: '明确交付部分结果、等待或失败状态',
    guide_required_text: '持久预算/断网/重连 + App 部分结果，不靠重启获得额外额度',
    required_layers: ['kernel', 'app'],
    required_extra_gates: [],
    status: 'unverified',
    entry: '未建立（预算持久化与断网恢复属 KRN-12/KRN-10）',
    gap: '预算跨重启不清零未实现；部分结果交付未验证。',
  },
];
