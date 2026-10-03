/**
 * M01 —— 官方 host 判定（独立小模块，避免 `evidence` 与 `matrix` 互相 import 成环）。
 *
 * 「正式路径不得访问非官方 endpoint」是美团线纪律的一部分（工作书：不擅自加电脑代理/
 * 自建服务）。发现阶段同样只认官方域名：非官方页面上的 endpoint 连**证据资格**都没有。
 */

/** 官方根域名。 */
export const OFFICIAL_ROOT_DOMAIN = 'meituan.com';

/**
 * 该 URL 是否指向官方美团域名。
 *
 * 规则：hostname 恰为 `meituan.com` 或以 `.meituan.com` 结尾。
 * 非法 URL 一律 `false`（失败关闭）。
 */
export function isOfficialMeituanHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === OFFICIAL_ROOT_DOMAIN || hostname.endsWith(`.${OFFICIAL_ROOT_DOMAIN}`);
}
