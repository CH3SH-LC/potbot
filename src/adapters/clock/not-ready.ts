/**
 * 时钟域的**就绪度报告**（CLK-01–10，合同 R231 / R233）。
 *
 * 口径说明（重要）：
 * - `implemented` 只表示"**本批范围内、不依赖真机**的部分已完成且有本机证据"；
 *   **不表示**该子项在真机上已通过（那需要设备，见 `docs/STATE.md` 的真机空白）。
 * - 凡需求本身**必须**在真机上验证（触发、权限、通知、交接回执）的，一律
 *   `not_ready`（缺设备）或 `blocked`（平台不提供合法通道）。
 * - 文本版（含实测命令）见 `outputs/FA-M/readiness-matrix.md`。
 */

import {
  LOCAL_VERIFIED,
  NOT_INSTALLED,
  assertReadinessRecord,
  type CapabilityState,
  type SubitemReadiness,
} from './readiness.js';

/** 已接通、且**不依赖真机**的自管时钟能力。 */
export const CLOCK_SELF_MANAGED_CAPABILITY: CapabilityState = LOCAL_VERIFIED;

const EVIDENCE = ['src/adapters/clock/clock.test.ts', 'src/adapters/clock/action-contract.test.ts'];

const CLOCK_SUBITEM_LIST: readonly SubitemReadiness[] = [
  {
      id: 'CLK-01',
      requirement: '区分 potbot 自管提醒、系统时钟交接与可读回厂商能力；每个对象记录真实归属与 ID',
      verdict: 'implemented',
      implementedScope:
        '归属做成类型（AlarmOwnership），自管对象只能是 AlarmRecord（ownership=self_managed）并带稳定 id；' +
        '系统侧只经 handoff.ts 产出交接结果，**不**生成可写回的本地记录。',
      reason: null,
      unblockedBy: '',
      capability: CLOCK_SELF_MANAGED_CAPABILITY,
      evidence: ['src/adapters/clock/types.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-02',
      requirement: '创建单次/重复闹钟（时间/时区/标签/工作日/指定日期/启用状态）；相对时间解析为具体时间供核对',
      verdict: 'implemented',
      implementedScope:
        '模型 + 校验 + 重复规则展开（单次/每天/每周/工作日/每月/指定日期）；相对时间（N 个时间单位后）' +
        '解析成**具体时刻**且 requiresConfirmation=true；歧义时间（无上下午的"7 点"）返回多候选让用户选。' +
        '**不含**到点响铃（见 CLK-05/CLK-07）。',
      reason: null,
      unblockedBy: '',
      capability: CLOCK_SELF_MANAGED_CAPABILITY,
      evidence: ['src/adapters/clock/repeat.ts', 'src/adapters/clock/time-parse.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-03',
      requirement: '查询/筛选本工具可管理的闹钟（下次触发+重复规则）；无系统读取接口不得伪造全部闹钟列表',
      verdict: 'implemented',
      implementedScope:
        'AlarmStore 只返回**自管**记录，并给出下次触发时刻与重复规则文本；系统闹钟列表走 listSystemAlarms()，' +
        '无端口时返回 not_ready 且**绝不**用自管记录顶替。自管侧已实现；系统侧如实未就绪。',
      reason: null,
      unblockedBy: '',
      capability: CLOCK_SELF_MANAGED_CAPABILITY,
      evidence: ['src/adapters/clock/alarm-store.ts', 'src/adapters/clock/handoff.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-04',
      requirement: '修改时间/标签/重复、启用/禁用、删除、取消一次发生；查询结果与目标一致，重试不重复创建',
      verdict: 'implemented',
      implementedScope:
        'update / setEnabled / remove / cancelOccurrence（按闹钟时区的本地日期跳过该次）；' +
        'create 带幂等键，同键重放返回既有记录（duplicate=true）不重复创建；全部变更要求 expectedRevision。',
      reason: null,
      unblockedBy: '',
      capability: CLOCK_SELF_MANAGED_CAPABILITY,
      evidence: ['src/adapters/clock/alarm-store.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-05',
      requirement: '计时器创建/查看/暂停/继续/取消/结束；不把普通任务轮询当精确计时',
      verdict: 'implemented',
      implementedScope:
        '计时器记账状态机（绝对时刻 + 累计量），剩余量纯计算；**明确不声称**能准点响铃，' +
        '到点触发通道单列为未就绪（cap.clock.precise_firing）。',
      reason: null,
      unblockedBy: '',
      capability: CLOCK_SELF_MANAGED_CAPABILITY,
      evidence: ['src/adapters/clock/timer.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-06',
      requirement: '秒表开始/暂停/继续/计次/复位，前后台切换后计时正确；世界时钟查询与时区换算准确',
      verdict: 'implemented',
      implementedScope:
        '秒表（绝对起点 + 累计量，前后台/重建后读数正确）+ 世界时钟（ZonePort 注入，未知时区如实列为 unknownZones）。' +
        '时区数据来自宿主 ICU，DST 边界另需真机核对（见未就绪项 cap.clock.tz_dst_boundary）。',
      reason: null,
      unblockedBy: '',
      capability: CLOCK_SELF_MANAGED_CAPABILITY,
      evidence: ['src/adapters/clock/stopwatch.ts', 'src/adapters/clock/zone.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-07',
      requirement: '自管闹钟重启恢复、时区/系统时间变化、精确提醒权限与通知状态；真实触发/取消验证，不能用工作队列轮询保证准点',
      verdict: 'not_ready',
      implementedScope:
        '自管状态**快照/恢复**（toSnapshot/restoreAlarmStore）已实现；精确触发通道、通知权限与通知状态**未接通**。',
      reason:
        '精确到点触发必须由系统调度（Android AlarmManager / 通知）保证，本批**未接通**该通道；' +
        '且"真实触发/取消"必须在真机上观察，当前无设备。',
      unblockedBy: '需要：① A 负责人在 apps/android 装配精确调度通道；② 荣耀 Magic7 真机可用于观察触发与通知状态。',
      capability: { ...NOT_INSTALLED, installed: true, enabled: true },
      evidence: ['src/adapters/clock/alarm-store.ts（快照/恢复）'],
    },
    {
      id: 'CLK-08',
      requirement: '系统时钟动作使用已验证接口，处理多候选/缺目标/权限/处理应用；无法读回只报交接，不能把 dismiss 一概当删除',
      verdict: 'not_ready',
      implementedScope:
        '动作**语义表**与**七态报告路径**已实现：dismiss 明确不删除闹钟；不可回读的动作最高只到"已交接"；' +
        '多候选返回 ambiguous 交用户选、缺处理应用判 failed。**实际 Intent 调用未实现**（归 A 装配）。',
      reason:
        '真实交接需要设备与 apps/android 装配（本包写权内**不得**改 MainActivity/Manifest），当前无设备；' +
        '且系统闹钟是否可读回需实机核实。',
      unblockedBy: '需要：A 负责人在 apps/android 实现 ClockIntentPort 并装配；真机核实各厂商处理应用与可读回性。',
      capability: { ...NOT_INSTALLED, installed: true, enabled: true, deps_ready: false },
      evidence: ['src/adapters/clock/handoff.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-09',
      requirement: '动作参数版本绑定、需要时确认、重复点击、取消与触发竞态；保留已发生事实',
      verdict: 'implemented',
      implementedScope:
        '动作台账（createActionLedger）：同 requestId 重复点击返回既有条目不重复执行；终态不可改写（竞态显冲突）；' +
        '自管变更要求 expectedRevision；七态转换由 assertTransition 硬校验，已发生事实不被改写成"当初就失败"。',
      reason: null,
      unblockedBy: '',
      capability: CLOCK_SELF_MANAGED_CAPABILITY,
      evidence: ['src/adapters/clock/action-contract.ts', ...EVIDENCE],
    },
    {
      id: 'CLK-10',
      requirement: '自管全生命周期与承诺的系统时钟能力分别实机验收；厂商操作无合法接口则记阻塞，不能用自管记录冒充系统闹钟',
      verdict: 'blocked',
      implementedScope:
        '已在类型与 API 上把两者**分开**（AlarmStore 只含自管；系统侧只能经 handoff 报告交接）。',
      reason:
        '该子项要求**分别实机验收**，而真机层是本项目当前最大空白（荣耀 Magic7 全程未连接、APK 从未安装）；' +
        '更实质的是：**读取系统全部闹钟**与**删除/修改任意厂商闹钟**在公开 Android 平台上**没有合法通用接口**，' +
        '故这两项不是"以后做"，而是**阻塞**——不得用自管记录冒充系统闹钟已改。',
      unblockedBy:
        '实机验收需要设备；"系统闹钟读取/删除"两项**无合法通道**，只能改为"交接 + 用户自行操作"或换用厂商私有 SDK（需另行授权评估）。',
      capability: NOT_INSTALLED,
      evidence: ['src/adapters/clock/handoff.ts（listSystemAlarms 的 not_ready 路径）'],
    },
];

// 模块加载即校验：`implemented` 必须带证据，其余必须带原因与解锁条件（R233 的机器化落点）。
for (const record of CLOCK_SUBITEM_LIST) assertReadinessRecord(record);

export const CLOCK_SUBITEMS: readonly SubitemReadiness[] = Object.freeze(CLOCK_SUBITEM_LIST);

/** 能力级未就绪项（R231 五态）。 */
export interface ClockNotReadyCapability {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly state: CapabilityState;
  readonly verdict: 'not_ready' | 'blocked';
  readonly reason: string;
  readonly unblockedBy: string;
}

export const CLOCK_NOT_READY: readonly ClockNotReadyCapability[] = Object.freeze([
  {
    id: 'cap.clock.system_alarm_read',
    requirements: ['CLK-03', 'CLK-08', 'CLK-10'],
    state: NOT_INSTALLED,
    verdict: 'blocked',
    reason:
      '公开 Android 平台**没有**枚举用户系统闹钟的通用接口：AlarmClock 是"驱动时钟 App 的 Intent 契约"，' +
      '不是可查询的数据库（详见 readiness-matrix 的平台核实结论）。无合法通道 ⇒ 记**阻塞**，不是"以后做"。',
    unblockedBy: '无合法通道；只能改为"交接给时钟 App + 用户自行查看"，或评估厂商私有 SDK（需另行授权）。',
  },
  {
    id: 'cap.clock.system_alarm_delete',
    requirements: ['CLK-04', 'CLK-08', 'CLK-10'],
    state: NOT_INSTALLED,
    verdict: 'blocked',
    reason:
      '同源：没有公开接口可删除/修改任意厂商闹钟条目。dismiss 只关本次响铃，**不是**删除（CLK-08）。',
    unblockedBy: '无合法通道；改为"打开时钟 App 交用户操作"并由用户报告结果（user_reported）。',
  },
  {
    id: 'cap.clock.precise_firing',
    requirements: ['CLK-05', 'CLK-07'],
    state: { ...NOT_INSTALLED, installed: true, enabled: true },
    verdict: 'not_ready',
    reason:
      '到点精确触发需要系统调度通道（AlarmManager / 通知 / 前台服务），本批未接通；' +
      '合同 CLK-05 明文禁止"用普通任务轮询保证准点"，故不以轮询冒充。',
    unblockedBy: 'A 负责人在 apps/android 装配调度通道并在真机验证精确提醒权限与通知状态。',
  },
  {
    id: 'cap.clock.system_handoff_dispatch',
    requirements: ['CLK-08'],
    state: { ...NOT_INSTALLED, installed: true, enabled: true },
    verdict: 'not_ready',
    reason: 'ClockIntentPort 的 Android 实现未做（本包写权不含 apps/android）；语义与报告路径已就绪，接口调用待装配。',
    unblockedBy: 'A 负责人实现并装配 ClockIntentPort。',
  },
  {
    id: 'cap.clock.tz_dst_boundary',
    requirements: ['CLK-06'],
    state: { ...NOT_INSTALLED, installed: true, enabled: true, deps_ready: true },
    verdict: 'not_ready',
    reason:
      '时区偏移来自宿主 ICU/tzdata（含 DST）；DST 跳变处的"不存在/重复当地时刻"解析方向依赖宿主，' +
      '本机未在真机上逐条核对，故只保证"宿主 tzdata 一致"，不声称跨平台逐位一致。',
    unblockedBy: '在目标真机上核对若干 DST 边界样例（如 America/New_York 春季跳变）。',
  },
]);

export function clockReadinessReport(): {
  readonly subitems: readonly SubitemReadiness[];
  readonly capabilities: readonly ClockNotReadyCapability[];
} {
  return { subitems: CLOCK_SUBITEMS, capabilities: CLOCK_NOT_READY };
}
