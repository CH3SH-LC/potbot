/**
 * FA-Q —— 设备状态**当次**核查（外部监督 P2）
 *
 * 监督意见：此前"最新能定位到的 HDB 状态是 10-02 的，**不是当次的 no-device 结论**"。
 * 因此本文件登记 **2026-10-03 10:50–10:51 (+08)** 的只读核查结果，
 * **替代**任何 10-02 的旧结论。
 *
 * 纪律：只读——不安装、不启动、不改映射、不抢屏；**不做**真机验收动作。
 * 纯数据，不 import 产品实现。
 */

export type DeviceReachability = 'reachable' | 'unreachable' | 'host_unreachable' | 'unknown';

export interface DeviceProbeRecord {
  readonly command: string;
  readonly at: string;
  readonly read_only: boolean;
  readonly exit_code: number;
  readonly verdict: string;
  readonly raw_log: string;
  readonly facts: Readonly<Record<string, string>>;
}

export const DEVICE_CHECKED_AT = '2026-10-03T10:50:46+0800';

/** 当次核查的结论（**取代** 10-02 的旧 no-device 结论）。 */
export const DEVICE_REACHABILITY: DeviceReachability = 'reachable';

export const DEVICE_PROBES: readonly DeviceProbeRecord[] = [
  {
    command: 'scripts\\demo\\honor-connect.cmd status',
    at: '2026-10-03T10:50:46+0800',
    read_only: true,
    exit_code: 4,
    verdict: 'error',
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/device-status.txt',
    facts: {
      error_code: 'host_health_unreachable',
      reason:
        'status 在"本机 host 服务健康"这一步短路：8765 上的宿主服务未运行，故**未进入设备枚举**。它不构成"无设备"结论。',
      deviceEnumeration: 'false',
      normalVendorAuth: 'false',
      readOnlyShell: 'false',
      native: 'not_attempted',
    },
  },
  {
    command: 'scripts\\demo\\honor-connect.cmd doctor',
    at: '2026-10-03T10:50:52+0800',
    read_only: true,
    exit_code: 0,
    verdict: 'ready',
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/device-doctor.txt',
    facts: {
      native: 'succeeded',
      authentication: 'verified (vendor_normal_hdb)',
      probe: 'succeeded',
      model: 'PTP-AN00',
      deviceEnumeration: 'true',
      readOnlyShell: 'true',
      debugReady: 'true',
    },
  },
  {
    command: 'adb devices -l',
    at: '2026-10-03T10:51:00+0800',
    read_only: true,
    exit_code: 127,
    verdict: 'not_available',
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/device-adb.txt',
    facts: {
      reason: 'adb: command not found —— adb 不在本 shell 的 PATH 上。',
      implication:
        '因此早先"`adb devices -l` 为空"这一证据是**弱证据**：空可能来自"没有设备"，也可能来自"根本调不到 adb"。本轮的结论以 honor-connect doctor 为准。',
    },
  },
];

/** 尚未在当次核查中验证的设备能力（doctor 的 capabilities 字段）。 */
export const DEVICE_UNVERIFIED_CAPABILITIES: readonly string[] = [
  'install',
  'forwarding',
  'phoneToHost',
  'appLaunch',
  'appDebug',
  'appLogRead',
];
