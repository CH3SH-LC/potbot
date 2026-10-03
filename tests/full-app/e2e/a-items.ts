/**
 * FA-A-E2E —— A01–A19 的**执行台账**（纯数据，镜像 `docs/other/full-app-capability-catalog-2026-10-03.md` §9）。
 *
 * 这张表回答一个问题：**每一项在这一批里到底是"真跑"还是"显式跳过"，以及为什么。**
 *
 * ## 为什么要有这张表
 * 旧的 `tests/full-app/six-layer-matrix.ts` 把 A 项写成"映射/状态说明"，**不执行**产品。
 * 本套件要求"每项要么真断言，要么显式跳过——不接受空断言"。因此这里为每一项登记：
 * - `mode`：`real`（本批有真跑的断言）/ `skip`（本批显式跳过）/ `partial`（一部分真跑、一部分跳过）；
 * - `covered_by`：真跑断言的落点（`.test.ts#describe`）；
 * - `skipped_part`：被显式 `it.skip` 的部分与**跳过原因**（真机 / 消费端 / 外部账号 / 未接入）；
 * - `honesty`：本项**未被本批证明**的边界（引用时不得越界）。
 *
 * `a-items.test.ts` 断言这张表本身没有空话：每项都有 mode、有落点或跳过原因、`real/partial`
 * 必有 `covered_by`、`skip` 必有 `skipped_part`；且 id 集合恰好是 A01–A19。
 *
 * 本文件**不 import 任何产品实现**。
 */

export const A_ITEM_MODES = ['real', 'partial', 'skip'] as const;
export type AItemMode = (typeof A_ITEM_MODES)[number];

export interface AItemLedgerEntry {
  readonly id: `A${string}`;
  /** 原任务书 §19 测试情形。 */
  readonly scenario: string;
  /** 原任务书 §19 通过条件。 */
  readonly pass_condition: string;
  readonly mode: AItemMode;
  /** 真跑断言的落点（`file#describe`）；mode==='skip' 时为空数组。 */
  readonly covered_by: readonly string[];
  /** 被显式跳过的部分与原因；mode==='real' 时为空数组。 */
  readonly skipped_part: readonly string[];
  /** 本项**未被本批证明**的边界。 */
  readonly honesty: string;
}

export const A_ITEM_LEDGER: readonly AItemLedgerEntry[] = [
  {
    id: 'A01',
    scenario: '正常文件任务',
    pass_condition: '实际生成可打开文件，关键字段符合要求',
    mode: 'partial',
    covered_by: [
      'a01-formats-same-version.test.ts#三格式同版：同一事实版本产真实字节并独立读回',
    ],
    skipped_part: [
      '手机/消费端实际打开文件 → 需真机 + 无授权 Office；本批只到"真实字节 + 独立读回"',
    ],
    honesty: '“可打开”只由本套件独立 STORE-ZIP 读回 + 产品第一层结构自检共同证明，不等于消费端渲染通过',
  },
  {
    id: 'A02',
    scenario: '多成员请求空闲实例',
    pass_condition: '不并发启动重复轮次，不丢请求',
    mode: 'skip',
    covered_by: [],
    skipped_part: ['真实调度执行器下并发到达 → 未接入真实执行器（同进程内核覆盖见 tests/acceptance/a02a03/**）'],
    honesty: '本批不复验调度；仅登记既有同进程内核证据的边界',
  },
  {
    id: 'A03',
    scenario: '运行中连续唤醒',
    pass_condition: '合并后续排队，但每项工作都有结局',
    mode: 'skip',
    covered_by: [],
    skipped_part: ['真实执行器下的合并唤醒 → 未接入真实执行器（同进程覆盖见 tests/acceptance/a02a03/**）'],
    honesty: '同上；合并唤醒的"每项都有结局"未在本批实测',
  },
  {
    id: 'A04',
    scenario: '重复消息送达',
    pass_condition: '相同消息不会重复创建业务工作',
    mode: 'skip',
    covered_by: [],
    skipped_part: ['跨重连/重启的持久化去重 → 需重连/重启链路（同进程去重见 tests/acceptance/a04/**）'],
    honesty: '本批不复验消息去重持久化',
  },
  {
    id: 'A05',
    scenario: '循环依赖',
    pass_condition: '有限诊断后暂停或报告，不无限互唤',
    mode: 'skip',
    covered_by: [],
    skipped_part: ['自动故障恢复与租约过期回收 → FREEZE-6 登记为遗留（诊断逻辑覆盖见 tests/acceptance/a05/**）'],
    honesty: '本批不复验循环诊断的真实暂停/报告路径',
  },
  {
    id: 'A06',
    scenario: '缺少能力或权限',
    pass_condition: '报告缺失，不编造能力或借成员越权',
    mode: 'real',
    covered_by: ['a17-a18-plugin-platform.test.ts#停用/撤权后：缺能力如实报告，不借成员越权'],
    skipped_part: [],
    honesty: '“不借成员越权”由经验维护角色边界（assertNoPrivilegeMutation）证明；真实适配器拒绝路径未接入',
  },
  {
    id: 'A07',
    scenario: '用户修改需求',
    pass_condition: '相关产物更新，旧气泡失效',
    mode: 'real',
    covered_by: [
      'a07-cascade.test.ts#人数 8→10：共享事实/预算/正文/演示都更新，无关产物不重写',
      'a07-cascade.test.ts#旧气泡不可执行',
    ],
    skipped_part: [],
    honesty: '三产物"新版本"是**逻辑版本号 + 真实重建字节**，不是"手机端另存后重开"（后者未验证）',
  },
  {
    id: 'A08',
    scenario: '旧轮次迟到',
    pass_condition: '旧结果不能覆盖当前任务',
    mode: 'real',
    covered_by: ['a07-cascade.test.ts#迟到轮次的发布被所有权/版本闸门拒绝'],
    skipped_part: [],
    honesty: '闸门是纯函数判定；并发真实迟到发布的端到端读回未接入',
  },
  {
    id: 'A09',
    scenario: '用户取消',
    pass_condition: '未提交旧动作不再执行，已发生副作用如实保留',
    mode: 'real',
    covered_by: ['a07-cascade.test.ts#取消：未提交动作不再执行，已发生副作用如实保留（reverted 恒 false）'],
    skipped_part: ['App 取消入口（真机 UI） → 需真机'],
    honesty: '副作用“如实保留”由 ActionSideEffect.reverted 字面量 false 证明；真实工具的副作用未接入',
  },
  {
    id: 'A10',
    scenario: '应用重启或实例释放',
    pass_condition: '从任务记录恢复，不依赖原上下文仍在内存中',
    mode: 'partial',
    covered_by: [
      'a10-memory-lifecycle.test.ts#快照/恢复：注册表与记忆从持久记录重建，内存清空后仍可得',
      'a01-formats-same-version.test.ts#事实记录重载后仍可读到同一版本',
    ],
    skipped_part: ['App 与后端进程分别重启 → 需真机 + 跨进程运行（单元内以 snapshot/restore 模拟"内存清空"）'],
    honesty: '“重启”是同一进程内丢弃内存对象后从序列化记录重建，非真实跨进程；租约/时钟高水位恢复未在本批覆盖',
  },
  {
    id: 'A11',
    scenario: '外部结果未知',
    pass_condition: '不宣称完成，不盲目重试造成重复写入',
    mode: 'real',
    covered_by: [
      'a11-fidelity.test.ts#结果未知：不判完成、不得盲目重试',
      'a11-fidelity.test.ts#美团返回/文件打开/日历编辑页关闭都不等于完成回执',
    ],
    skipped_part: ['真实适配器的未知结果故障注入 → 适配器外部账号未接入（纯模型层已真跑）'],
    honesty: '七态与任务完成口径是模型层；真实外部写入的"未重复"未在真实服务上验证',
  },
  {
    id: 'A12',
    scenario: '从美团返回',
    pass_condition: '不自动标记购买完成',
    mode: 'partial',
    covered_by: ['a11-fidelity.test.ts#美团交接封顶在"已交接"，购买类动作结构上被拒'],
    skipped_part: [
      '真机美团跳转并返回 → 美团账号未登录 + MeituanHandoffPort 未装配（归 A）；真机通路不可调试（2026-10-03 doctor: device_found_but_not_debuggable）',
    ],
    honesty: '只证明适配器模型层封顶与禁购动作；真机跳转后的状态保持未验证',
  },
  {
    id: 'A13',
    scenario: '条件冲突或费用缺失',
    pass_condition: '报告无解或未知，不暗改条件，不把未知当零',
    mode: 'real',
    covered_by: [
      'a01-formats-same-version.test.ts#未知/缺失事实不得当 0（表格留空 + 明细理由）',
      'a07-cascade.test.ts#同一事实键在同一版本出现两个当前值 → 显式冲突',
    ],
    skipped_part: [],
    honesty: '冲突/缺失在事实与表格模型层证明；真实检索侧的缺失路径未接入',
  },
  {
    id: 'A14',
    scenario: '注入伪指令或假批准',
    pass_condition: '不获得工具授权，不直接触发执行',
    mode: 'real',
    covered_by: ['a11-fidelity.test.ts#不可信回执不得置"已确认完成"；经验角色不得改权限/工具地址'],
    skipped_part: ['文档/网页注入的端到端防护 → 权限门与外部内容注入防护未实现（只证明动作/角色层判据）'],
    honesty: '本项证明的是"假批准结构上无效"，不是"注入路径已被拦住"',
  },
  {
    id: 'A15',
    scenario: '重复点击气泡',
    pass_condition: '内核不重复提交同一动作',
    mode: 'real',
    covered_by: ['a10-memory-lifecycle.test.ts#重复点击命中同一台账对象，零新增副作用'],
    skipped_part: ['手机重复点击的 UI 路径 → 需真机'],
    honesty: '幂等键去重在动作台账层证明；跨重启的台账持久化未覆盖',
  },
  {
    id: 'A16',
    scenario: '两群组写同一资源',
    pass_condition: '锁或版本检查阻止静默覆盖',
    mode: 'real',
    covered_by: [
      'a07-cascade.test.ts#非所有权/过期租约的发布被拒（不静默覆盖）',
      'a07-cascade.test.ts#A16 两群组写同一资源：版本检查阻止静默覆盖（期望版本不符则原记录原样保留）',
    ],
    skipped_part: ['两个真实工作进程写同一最终路径 → 跨进程文件锁未在本批真跑'],
    honesty: '所有权/版本检查在纯函数与日历乐观并发层证明；跨进程锁的真实争用未覆盖',
  },
  {
    id: 'A17',
    scenario: '经验污染与模板更新',
    pass_condition: '未核验成功不被固化，旧实例不热换规则',
    mode: 'real',
    covered_by: [
      'a10-memory-lifecycle.test.ts#未核验成功不得固化；修改/忘记后不再注入',
      'a17-a18-plugin-platform.test.ts#更新后旧实例版本固定，新实例才拿新版本',
    ],
    skipped_part: ['后续真实实例下规则生效 → 未接入真实模型/执行器'],
    honesty: '经验生命周期与实例版本固定在模型层证明；真实实例的行为改变未验证',
  },
  {
    id: 'A18',
    scenario: '插件停用或权限撤销',
    pass_condition: '不再新建被停用实例，后续调用受撤销影响',
    mode: 'real',
    covered_by: ['a17-a18-plugin-platform.test.ts#停用/撤权即时生效：不再新建实例、后续调用受限'],
    skipped_part: ['App 停用/撤权按钮（真机） → 需真机'],
    honesty: '注册表门禁在模型层证明；真机点击到即时生效的链路未验证',
  },
  {
    id: 'A19',
    scenario: '预算耗尽或断网',
    pass_condition: '明确交付部分结果、等待或失败状态',
    mode: 'real',
    covered_by: ['a11-fidelity.test.ts#预算耗尽：明确部分/失败状态，不以重启获得额外额度'],
    skipped_part: ['真实断网/重连 → 需网络条件；预算跨进程重启不清零未在本批真跑'],
    honesty: '预算账本与完成口径在模型层证明；真实断网恢复路径未验证',
  },
];

/** 台账 id 的期望全集（改这里必须同时改 `a-items.test.ts` 的断言口径）。 */
export const EXPECTED_A_IDS: readonly string[] = Array.from(
  { length: 19 },
  (_unused, index) => `A${String(index + 1).padStart(2, '0')}`,
);
