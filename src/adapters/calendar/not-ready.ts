/**
 * 日历域的**就绪度报告**（CAL-01–10，合同 R231 / R233）。
 *
 * 口径同 clock 的 `not-ready.ts`：`implemented` 只表示"**本批范围内、不依赖真机**的部分
 * 已完成且有本机证据"，**不表示**真机已通过。文本版见 `outputs/FA-M/readiness-matrix.md`。
 */

import {
  LOCAL_VERIFIED,
  NOT_INSTALLED,
  assertReadinessRecord,
  type CapabilityState,
  type SubitemReadiness,
} from '../clock/readiness.js';

const EVIDENCE = ['src/adapters/calendar/calendar.test.ts', 'src/adapters/calendar/action-contract.test.ts'];

const CALENDAR_LOGIC_CAPABILITY: CapabilityState = LOCAL_VERIFIED;

const CALENDAR_SUBITEM_LIST: readonly SubitemReadiness[] = [
  {
    id: 'CAL-01',
    requirement: '读取获准日历目录，选择目标日历与账号；不可写日历、无权限和授权撤回正确处理',
    verdict: 'not_ready',
    implementedScope:
      '权限与可写性**判定逻辑**已实现（checkCalendarAccess：无权限 / 日历不在授权目录 / 只读日历分别给出原因）。',
    reason:
      '**读取日历目录本身**需要 READ_CALENDAR（dangerous 权限、API 23 起为运行时权限）与真机；' +
      '授权撤回后的实际 provider 行为只能在设备上核实。',
    unblockedBy: '需要：A 负责人在 apps/android 装配权限请求与 provider 读取；真机核实授权撤回行为。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true },
    evidence: ['src/adapters/calendar/handoff.ts（checkCalendarAccess）'],
  },
  {
    id: 'CAL-02',
    requirement: '按日期/范围/关键词查询日程、忙闲与冲突；时间范围明确，不假读未授权账号',
    verdict: 'implemented',
    implementedScope:
      '对**给定事件集**做区间/关键词查询、忙闲合并、冲突检测；查询**必须**显式给区间，' +
      '且只返回 authorizedCalendarIds 白名单内的事件（越权条目被排除并计数）。真实读取平台日历未接通。',
    reason: null,
    unblockedBy: '',
    capability: CALENDAR_LOGIC_CAPABILITY,
    evidence: ['src/adapters/calendar/conflict.ts', ...EVIDENCE],
  },
  {
    id: 'CAL-03',
    requirement: '创建事件：标题、起止、时区、全天、地点、描述；全天和跨天/跨时区语义正确',
    verdict: 'implemented',
    implementedScope:
      '事件模型 + 校验 + 全天（端点为**排他**日期）与定时统一归一到绝对区间；时区未知一律报错不猜测。' +
      '**与平台的映射**（如 ALL_DAY 要求 UTC+午夜边界）需真机核对，见未就绪项。',
    reason: null,
    unblockedBy: '',
    capability: CALENDAR_LOGIC_CAPABILITY,
    evidence: ['src/adapters/calendar/event.ts', 'src/adapters/calendar/types.ts', ...EVIDENCE],
  },
  {
    id: 'CAL-04',
    requirement: '提醒设置、修改、删除及可用数量/方式校验；实际写入目标日历并读回',
    verdict: 'not_ready',
    implementedScope: '提醒数据的形状校验（提前量为非负整数分钟、方式受可用集合约束）。',
    reason: '「实际写入目标日历并**读回**」需要 provider 与真机；各日历可用的提醒方式集合亦未在设备上核实。',
    unblockedBy: '需要：真机装配 provider 写入 + 读回；核实各日历支持的提醒方式与数量上限。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true },
    evidence: ['src/adapters/calendar/handoff.ts（validateReminders）'],
  },
  {
    id: 'CAL-05',
    requirement: '重复日程规则、截止、例外；编辑/删除本次、后续或整个系列的语义分别验证，不误改整组',
    verdict: 'implemented',
    implementedScope:
      '重复展开（日/周/月/年 + interval/count/until/byWeekday/byMonthDay/EXDATE，count 按 RFC 口径含例外）；' +
      '三种编辑范围产出**形状互不相同**的计划（single_exception / split_series / whole_series），' +
      '结构上杜绝把"本次"当"整个系列"执行。**平台侧重放**（例外行/EXDATE/截断两步）未在真机执行。',
    reason: null,
    unblockedBy: '',
    capability: CALENDAR_LOGIC_CAPABILITY,
    evidence: ['src/adapters/calendar/recur.ts', ...EVIDENCE],
  },
  {
    id: 'CAL-06',
    requirement: '修改、改期、复制、取消/删除既有日程，绑定真实 eventId 与版本；失败保留原记录',
    verdict: 'implemented',
    implementedScope:
      '修改/删除**规划**强制 expectedRevision（版本冲突显式失败）；失败时 next=null ⇒ 原记录天然保留；' +
      '复制**必须**换新 id。真实落库需 provider（未接通）。',
    reason: null,
    unblockedBy: '',
    capability: CALENDAR_LOGIC_CAPABILITY,
    evidence: ['src/adapters/calendar/handoff.ts（planEventUpdate/Delete/Copy）', ...EVIDENCE],
  },
  {
    id: 'CAL-07',
    requirement: '参与者资料、状态、备注和可用的邀请交接；真正发邀请另按用户授权和工具能力执行，不把保存参与者当已发邀请',
    verdict: 'not_ready',
    implementedScope:
      '「保存参与者」的如实声明已实现并**固定** `invitationSent: false`（平台文档未声明插入 Attendee 会发邀请）。',
    reason: '「邀请交接」通道本身未接通：需要用户授权的邮件/消息工具能力与真机，当前都不可用。',
    unblockedBy: '需要：用户授权并接通发邀请的工具能力；真机核实参与者状态回读。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true },
    evidence: ['src/adapters/calendar/handoff.ts（declareAttendeeSave）'],
  },
  {
    id: 'CAL-08',
    requirement: '任务事实变化后更新相关日程，旧确认气泡失效；独立日程不被误合并',
    verdict: 'implemented',
    implementedScope:
      '关联**必须显式建立**（link）；事实版本推进后只标记**登记过关联**的日程为待更新，其确认气泡失效；' +
      '未关联日程进入 untouched 列表——从结构上杜绝按标题相似度误合并。',
    reason: null,
    unblockedBy: '',
    capability: CALENDAR_LOGIC_CAPABILITY,
    evidence: ['src/adapters/calendar/links.ts', ...EVIDENCE],
  },
  {
    id: 'CAL-09',
    requirement: '授权直写与打开系统编辑页面区分；前者读回目标值，后者没有证据不能自动标创建完成',
    verdict: 'implemented',
    implementedScope:
      '两条路径分别实现且**七态上限不同**：直写=读回一致才 confirmed（读不回 ⇒ unknown/submitted）；' +
      '打开编辑页=最高 handed_off，实现路径上**根本不构造** confirmed。',
    reason: null,
    unblockedBy: '',
    capability: CALENDAR_LOGIC_CAPABILITY,
    evidence: ['src/adapters/calendar/handoff.ts', ...EVIDENCE],
  },
  {
    id: 'CAL-10',
    requirement: '离线、同步延迟、外部修改、重启、重复请求、取消竞态和权限撤回实测；手机端查看与记录一致',
    verdict: 'not_ready',
    implementedScope: '其中"重复请求/取消竞态"的**台账层**已由共享动作台账覆盖（同 requestId 幂等、终态不可改写）。',
    reason:
      '离线/同步延迟/外部修改/重启/权限撤回这几类**只能**在真机与真实账号同步下观察；' +
      'provider 的同步模型（CALLER_IS_SYNCADAPTER、账户受限写入）需实机核实。',
    unblockedBy: '需要：真机 + 已登录日历账号，做断电/断网/外部改单/撤权等场景实测。',
    capability: NOT_INSTALLED,
    evidence: ['src/adapters/clock/action-contract.ts（动作台账）'],
  },
];

for (const record of CALENDAR_SUBITEM_LIST) assertReadinessRecord(record);

export const CALENDAR_SUBITEMS: readonly SubitemReadiness[] = Object.freeze(CALENDAR_SUBITEM_LIST);

export interface CalendarNotReadyCapability {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly state: CapabilityState;
  readonly verdict: 'not_ready' | 'blocked';
  readonly reason: string;
  readonly unblockedBy: string;
}

export const CALENDAR_NOT_READY: readonly CalendarNotReadyCapability[] = Object.freeze([
  {
    id: 'cap.calendar.provider_read',
    requirements: ['CAL-01', 'CAL-02'],
    state: NOT_INSTALLED,
    verdict: 'not_ready',
    reason:
      '读取平台日历需要 READ_CALENDAR（dangerous，API 23+ 运行时授权）与真机；本批未接通任何 provider 读取通道。',
    unblockedBy: 'A 负责人在 apps/android 装配权限请求与 CalendarContract 查询；真机核实。',
  },
  {
    id: 'cap.calendar.provider_write',
    requirements: ['CAL-04', 'CAL-06', 'CAL-09'],
    state: NOT_INSTALLED,
    verdict: 'not_ready',
    reason: '直写与读回需要 WRITE_CALENDAR 与真机；本批只实现状态机与语义，未调用 provider。',
    unblockedBy: 'A 负责人实现 CalendarWritePort（插入/读回/参与者）并在真机验证读回一致性。',
  },
  {
    id: 'cap.calendar.editor_handoff',
    requirements: ['CAL-09'],
    state: { ...NOT_INSTALLED, installed: true, enabled: true },
    verdict: 'not_ready',
    reason: '打开系统日历编辑页的 Intent 装配归 A 负责人；本批已实现"交接不得标完成"的状态路径。',
    unblockedBy: 'A 负责人实现 CalendarEditorPort。',
  },
  {
    id: 'cap.calendar.attendance_provider',
    requirements: ['CAL-07'],
    state: NOT_INSTALLED,
    verdict: 'not_ready',
    reason:
      '平台文档**未声明**插入 Attendee 行会发邀请（已核实）；因此"保存"与"发邀请"必须分两条链，' +
      '发邀请链本批未接通。',
    unblockedBy: '用户授权并接通发邀请工具能力；真机核实参与者状态回读。',
  },
  {
    id: 'cap.calendar.sync_semantics',
    requirements: ['CAL-10'],
    state: NOT_INSTALLED,
    verdict: 'not_ready',
    reason:
      '离线/同步延迟/外部修改/撤权等属同步模型行为；provider 对普通应用与 sync adapter 的写入范围不同，' +
      '必须实机 + 真实账号观察。',
    unblockedBy: '真机 + 已登录账号的多场景实测。',
  },
  {
    id: 'cap.calendar.allday_mapping',
    requirements: ['CAL-03', 'CAL-10'],
    state: { ...NOT_INSTALLED, installed: true, enabled: true, deps_ready: true },
    verdict: 'not_ready',
    reason:
      '本适配器用"日期 + 排他端点"建模全天；平台侧约束不同（如 ALL_DAY=1 要求 eventTimezone="UTC" 且落在午夜边界）。' +
      '映射的正确性必须在真机上逐条核对，未核对前不声称两端一致。',
    unblockedBy: '真机核对全天事件写入/读回的表示与边界。',
  },
]);

export function calendarReadinessReport(): {
  readonly subitems: readonly SubitemReadiness[];
  readonly capabilities: readonly CalendarNotReadyCapability[];
} {
  return { subitems: CALENDAR_SUBITEMS, capabilities: CALENDAR_NOT_READY };
}
