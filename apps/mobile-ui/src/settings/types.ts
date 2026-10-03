/**
 * F09 settings —— 「我的 / 设置」域的类型、错误与共享词表（零依赖、纯 TS、框架无关）。
 *
 * 覆盖 design-07 的 M01（我的）/ M07（权限与连接）/ M08（额度与存储）/
 * M09（通知与后台说明）/ M10（应用信息与脱敏诊断导出），以及 §7 的三条硬约束：
 *   - 「权限在使用前按需申请；拒绝后提供当前可完成部分和准确恢复入口」
 *   - 「额度展示用户可理解的费用/次数/时长及来源」
 *   - 「诊断导出默认脱敏；凭证不进入普通页面、APK、分享文案或日志；
 *      连接失败文案不显示密钥或原始认证头」
 *
 * 本包只产出**可断言的视图状态与纯函数**：不渲染、不引框架、不发网络请求、不读文件、
 * 不触碰时钟（所有「现在」由调用方以 ISO 字符串显式传入，或由导出调用方注入）、
 * 不用随机数（id 确定性推导）。因此同一输入必得同一结果，测试可逐字节比较。
 *
 * 只读消费（不修改）`contracts/mobile-v1/types.ts` 的 `TemplatePermission` /
 * `VerificationMode` / `Budget`，不另发明同名形状。密钥相关**只有引用与状态**，
 * 本包任何类型都**没有**密钥明文字段——这是结构性保证，不是靠自觉。
 *
 * 核心不变量（由 `tests/mobile-ui/F09/` 机器化断言）：
 *   I1 密钥状态只有引用与状态，绝无明文：`keyRef` 形如 `keyref:...`；本包不存、不返、
 *      不打印密钥明文。导入请求里出现 `plaintext`/`apiKey`/`secret` 字段或
 *      `sk-...` 形状的值，一律抛 `plaintext-not-accepted`（fail-closed）。
 *   I2 密钥导入只能走原生导入路径：唯一的导入函数 `importKeyFromNative(importer, intent)`
 *      必须拿到实现了 `NativeKeyImporter.importFromNative` 的**原生端口**；没有端口抛
 *      `native-importer-required`。UI 侧只提交「原生来源描述 + 一次性令牌」，不接触明文。
 *   I3 撤权实时反映：删除/撤销权限或密钥后，依赖它的能力**立即**变为不可用
 *      （`isCapabilityAllowed` 为 false、连接态推导为 `unauthorized`），不做延迟或缓存命中。
 *   I4 预算/存储不虚报：`fixture` 模式不得声称花费/已用为真实；未测量的存储必须报
 *      `measured:false`（展示「未知」），**不得**用 0 冒充「空」。用尽后如实报部分。
 *   I5 诊断导出默认脱敏：密钥、手机号、地址、邮箱、桌面绝对路径、认证头、令牌一律替换为
 *      `[redacted:<kind>]`；导出对象序列化后不得含任一敏感原值；干净输入必须原样保留
 *      （证明脱敏不是「整段抹除」的空壳）。
 *   I6 连接失败文案不含密钥与原始认证头：`sanitizeFailure` 必须对失败消息跑脱敏，
 *      并报告被替换的条数。
 */

import type { TemplatePermission, VerificationMode } from '../../../../contracts/mobile-v1/types.js';

export type { TemplatePermission, VerificationMode };

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type SettingsErrorCode =
  | 'plaintext-not-accepted'
  | 'native-importer-required'
  | 'invalid-key-ref'
  | 'invalid-timestamp'
  | 'invalid-source'
  | 'invalid-token'
  | 'duplicate-provider'
  | 'unknown-key-ref'
  | 'unknown-permission'
  | 'invalid-permission-status'
  | 'invalid-budget'
  | 'invalid-storage'
  | 'invalid-connection-state'
  | 'invalid-notification'
  | 'redaction-failed';

/**
 * 视图模型的结构化错误：只带 code + 可读 message + 脱敏 details，
 * 不含密钥 / 请求体 / 本地绝对路径 / 认证头。测试按 `code` 断言，避免只匹配文案。
 */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: SettingsErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 共享词表
// ---------------------------------------------------------------------------

/** 密钥状态的展示词表（M07）。 */
export type KeyStatus = 'absent' | 'present' | 'rotated' | 'revoked';

export const KEY_STATUSES: readonly KeyStatus[] = ['absent', 'present', 'rotated', 'revoked'];

export const KEY_STATUS_LABELS: Readonly<Record<KeyStatus, string>> = {
  absent: '未导入',
  present: '已导入',
  rotated: '已轮换',
  revoked: '已撤销',
};

/** 连接状态（M07「测试连接」「连接失败」）。 */
export type ConnectionState =
  | 'unknown'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'unauthorized';

export const CONNECTION_STATES: readonly ConnectionState[] = [
  'unknown',
  'connecting',
  'connected',
  'degraded',
  'disconnected',
  'unauthorized',
];

export const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  unknown: '未知（尚未测试）',
  connecting: '连接中',
  connected: '已连接',
  degraded: '受限连接',
  disconnected: '未连接',
  unauthorized: '未授权（权限已撤销或缺失）',
};

/** 权限状态（M07「系统权限、服务账号、授权范围、测试连接、撤销」）。 */
export type PermissionStatus = 'granted' | 'denied' | 'not-requested' | 'revoked';

export const PERMISSION_STATUSES: readonly PermissionStatus[] = [
  'granted',
  'denied',
  'not-requested',
  'revoked',
];

/** 设置页可见的系统权限集合（与契约 `TemplatePermission` 逐字一致）。 */
export const SETTINGS_PERMISSIONS: readonly TemplatePermission[] = [
  'network',
  'storage',
  'model',
  'device',
  'external-order',
  'file-write',
];

export const PERMISSION_LABELS: Readonly<Record<TemplatePermission, string>> = {
  network: '网络访问',
  storage: '本地存储',
  model: '模型调用',
  device: '设备信息',
  'external-order': '外部下单',
  'file-write': '写入文件',
};

/** 需要哪些权限，某项能力才算可用（由各能力自行声明，避免页面各写一份）。 */
export type CapabilityId =
  | 'chat'
  | 'model-call'
  | 'file-write'
  | 'external-order'
  | 'device-info'
  | 'local-storage';

export const CAPABILITY_REQUIREMENTS: Readonly<Record<CapabilityId, readonly TemplatePermission[]>> = {
  chat: ['network'],
  'model-call': ['network', 'model'],
  'file-write': ['storage', 'file-write'],
  'external-order': ['network', 'external-order'],
  'device-info': ['device'],
  'local-storage': ['storage'],
};

/** 是否为合法 UTC ISO 时间戳。 */
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value);
}

/** 是否为合法 keyRef 引用（绝不接受明文）。 */
export function isKeyRef(value: unknown): value is `keyref:${string}` {
  return typeof value === 'string' && /^keyref:[A-Za-z0-9._-]{1,120}$/.test(value);
}
