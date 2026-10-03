/**
 * M01 —— **实际执行过的只读探针**记录（真实证据，非模板）。
 *
 * 这些是开发本包时用**未认证、只读**的方式抓取官方页面得到的**逐字**结果。
 * 每个页面都只返回一句站点标题「美团技术服务合作中心」，**没有** endpoint、
 * **没有** scope、**没有**工具 schema、**没有**协议说明。
 *
 * 由此得到的诚实结论：八个能力、协议类型、手机直连许可**全部 unverified**。
 * 这不是"没查"，而是"查了，官方页面在未登录/未渲染状态下不返回正文"——
 * 两种情况都不能支撑任何能力声明，见 `capability-probe` 同源记录与 `blocker.ts`。
 *
 * 本文件**不含**任何密钥、手机号、地址或凭据；凭证只以存在性布尔记录。
 */

import { isOfficialMeituanHost } from './official.js';
import type { CredentialRef, EvidenceProbe } from './types.js';

/** 未登录抓取时，五个官方页面**唯一**可见的文本。 */
export const OBSERVED_EMPTY_SHELL_TEXT = '美团技术服务合作中心';

/** 空壳页的统一结论。 */
export const EMPTY_SHELL_CONCLUSION =
  '仅见站点标题，无正文/导航/接口/协议/scope；无法据此判定任何能力，也无法据此判定是否登录墙。';

/** 构造一条"官方页面返回空壳"的探针记录。 */
function shellProbe(probeId: string, url: string, title: string, conclusion: string): EvidenceProbe {
  return Object.freeze({
    probeId,
    url,
    officialHost: isOfficialMeituanHost(url),
    method: 'unauthenticated-readonly-fetch' as const,
    reachable: true,
    readableContent: false,
    observedTitle: title,
    observedText: title,
    conclusion,
  });
}

/**
 * 本批**真实抓取**过的官方页面（工作书第 7 行点名的三个入口 + 两个外卖文档页）。
 * 全部返回同一空壳标题，`readableContent` 均为 `false`。
 */
export const RECORDED_PROBES: readonly EvidenceProbe[] = Object.freeze([
  shellProbe(
    'P1-token',
    'https://developer.meituan.com/zh/v2/dev/token',
    OBSERVED_EMPTY_SHELL_TEXT,
    '指定 Token 页面（工作书点名的开发者 Token 页）：只读到站点标题，无 token 说明、无 endpoint、无 scope。',
  ),
  shellProbe(
    'P2-doc',
    'https://developer.meituan.com/zh/v2/dev/doc',
    OBSERVED_EMPTY_SHELL_TEXT,
    '接入指南（工作书点名的 /zh/v2/dev/doc）：只读到站点标题，无法读取任何接入约定或协议。',
  ),
  shellProbe(
    'P3-waimai-isv',
    'https://developer.meituan.com/isv/waimai',
    OBSERVED_EMPTY_SHELL_TEXT,
    '外卖通用解决方案页：公开页面只读到站点标题，未见 SDK/OpenH5/OpenAPI 的能力清单。',
  ),
  shellProbe(
    'P4-waimai-oauth',
    'https://developer.meituan.com/docs/biz/biz_wmh5api_da85b8ae-b59b-4c72-815a-af7048706db0',
    OBSERVED_EMPTY_SHELL_TEXT,
    '工作书引用的 OAuth 授权码文档：只读到站点标题，未能核实"服务端授权码 / 应用云端持密钥"这一说法。',
  ),
  shellProbe(
    'P5-waimai-order-submit',
    'https://developer.meituan.com/docs/biz/biz_wmh5api_33922ecb-0ed8-4ab9-8894-6e46dd244e5d',
    OBSERVED_EMPTY_SHELL_TEXT,
    '工作书引用的订单提交文档：只读到站点标题，页面未证明本用户 Token 具有下单权限。',
  ),
]);

/**
 * 一次**非官方**检索的如实记录：搜索命中的都是 CSDN / kancloud / 百度云 / 第三方博客，
 * **不是**官方页面。其中出现的 endpoint 与字段（如 oauth 路径、businessId）**不作为证据**，
 * 也**不得**据此把任何能力标 `verified`——它们无法核验归属，且与密钥/账号权限无关。
 */
export const NON_OFTICIAL_SEARCH_NOTE =
  '另做一次公开检索：命中均为第三方转述（CSDN/kancloud/百度云等），非官方来源；' +
  '其中的 endpoint 与字段不作为证据，不改变任何 unverified 结论。';

/**
 * 凭证引用：只记"来源存在"，**不记**大小、前缀、指纹或内容。
 * 工作书明确：不得凭 key 长度或文件特征推断权限。
 */
export const CREDENTIAL_REF: CredentialRef = Object.freeze({
  present: true,
  contentRead: false,
  note:
    '用户指定的演示 key 来源已知存在；本包从未读取其内容，也不记录大小/前缀/指纹。' +
    '凭证外形（长度/包名/文件名）**不构成**任何能力的证据。',
});

/** 本批的默认探针集合（供 `buildCapabilityMatrix` 直接使用）。 */
export function recordedProbes(): readonly EvidenceProbe[] {
  return RECORDED_PROBES;
}
