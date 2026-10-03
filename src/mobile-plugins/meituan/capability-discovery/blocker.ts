/**
 * M01 —— **阻塞在用户授权**的精确报告。
 *
 * M01 的真实产出不是"发现了一批能力"，而是"证明**在拿到用户授权前无法判定任何能力**"，
 * 并把这件事说清楚：卡在什么、需要用户做什么、影响哪些包、哪些包**不受**影响。
 *
 * 工作书第 13 行：无该权限时「M01 单独登记具体能力阻塞、证据和所需平台授权，
 * 其他九包及其他五线继续开发」。本报告即那条登记。
 */

import { unverifiedTargets } from './matrix.js';
import type { CapabilityMatrix, DiscoveryTarget } from './types.js';

/** 阻塞报告。 */
export interface BlockedOnAuthorizationReport {
  /** 是否仍有未核实的发现目标（本批恒为 `true`）。 */
  readonly blocked: boolean;
  readonly reason: string;
  /** 需要用户/平台账号持有者提供的具体东西（逐条可执行）。 */
  readonly needFromUser: readonly string[];
  readonly owner: string;
  /** 被这一切阻塞的范围（只到 M01 结论层与 M02 真实 transport）。 */
  readonly impact: string;
  /** **不**被阻塞的范围（其他包/其他线继续）。 */
  readonly notBlocking: string;
  /** 仍未核实的目标。 */
  readonly unverifiedTargets: readonly DiscoveryTarget[];
  /** 支撑本结论的探针 ID 与 URL（脱敏，仅官方页面）。 */
  readonly evidenceProbeIds: readonly string[];
  readonly evidenceUrls: readonly string[];
}

const REASON =
  '指定 Token 平台的接入指南 / Token 页 / 外卖文档在未登录状态下只返回站点标题，' +
  '无 endpoint、无 scope、无工具 schema、无协议说明；因此八个能力、协议类型与' +
  '"是否允许手机直连"均无法判定，全部记 unverified。';

/** 构造阻塞报告。`blocked` 由"是否仍有 unverified 目标"推出，不写死。 */
export function buildBlockedOnAuthorizationReport(matrix: CapabilityMatrix): BlockedOnAuthorizationReport {
  const remaining = unverifiedTargets(matrix);
  return Object.freeze({
    blocked: remaining.length > 0,
    reason: REASON,
    needFromUser: Object.freeze([
      '在已登录浏览器中打开 https://developer.meituan.com/zh/v2/dev/token 与 /zh/v2/dev/doc，' +
        '确认该 Token 的接口/协议（MCP 或 REST/SDK）、可用 scope、有效期与是否含外卖下单权限；' +
        '可只提供**脱敏**的能力清单截图或文字，勿贴出密钥值本身。',
      '明确该 Token 是否允许**手机端直连**（个人凭据在手机上持有）；' +
        '若平台要求应用密钥/用户凭据在服务端保密签名，请直接说明，M01 将据此登记"手机直连不可行"。',
      '确认凭证类型（消费者个人 token / ISV 应用凭证 / 商家凭证），以便判定"直接订外卖"是否在授权范围内。',
    ]),
    owner: '用户 / 平台账号持有者',
    impact:
      '仅阻塞 M01 的能力矩阵定论与 M02 的真实 transport 选型（MCP initialize/tools.list 或 REST/SDK）。' +
      '不清除、不修改任何已有代码。',
    notBlocking:
      'M03–M10 与其余五线按 v1 契约继续本地实现与 fixture 驱动验证；在无授权事实前，' +
      '任何包都不得签发真实订单/支付回执，也不得把 fixture 记为真实能力。',
    unverifiedTargets: remaining,
    evidenceProbeIds: Object.freeze(matrix.probes.map((probe) => probe.probeId)),
    evidenceUrls: Object.freeze(matrix.probes.map((probe) => probe.url)),
  });
}
