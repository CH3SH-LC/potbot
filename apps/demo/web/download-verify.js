/*
 * potbot 手机 Word Demo —— 下载校验分类（download-verify.js）
 *
 * 由来（design-05-P10 缺口 3）：
 *   旧 app.js 在「当前环境不能计算摘要」（非安全上下文 ⇒ 没有 crypto.subtle）
 *   时，仍然会发送 `download_verified` 观察事件，并在文案里写成「核对长度与摘要」，
 *   于是把一次**没有核对摘要**的下载说成了「已核验」。这违反 R155（四类声明分开）
 *   与「未核验不得发布验证成功事件」。
 *
 * 本模块把判定与文案集中成**纯函数**，并强制把三件事分开：
 *   ① 摘要**未计算**（digest_unavailable）—— 不是失败，也绝不是验证成功；
 *   ② 摘要**计算不符**（digest_mismatch）—— 失败，放弃保存；
 *   ③ 长度不符（length_mismatch）—— 失败，放弃保存；
 *   ④ 摘要已计算且与登记一致（verified）—— **只有这一种**允许发布 download_verified。
 *
 * 观察事件映射（observationKindFor）：
 *   verified            → 'download_verified'
 *   digest_unavailable  → 'handoff_requested'（只记「已交接/已下载」这一观察）
 *   其余（fatal）        → null（放弃保存，不产生任何验证事件）
 * 说明：现有 contracts.ts 的 ObservationKind 只有 download_verified /
 *   handoff_requested / user_reported_opened 三种。为不擅自改动共享合同，
 *   「未核验的下载」复用 handoff_requested 并在 detail 里写清「未核对校验值」。
 *   （更精确的 download_observed 需要 contracts.ts 变更，归主协调者。）
 *
 * 载入方式与 bridge-ops.js 相同：浏览器挂全局 `PotbotDownloadVerify`，
 * 测试用 node:vm 直接加载本文件。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root && typeof root === 'object') root.PotbotDownloadVerify = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var STATUS = {
    verified: 'verified',
    digest_unavailable: 'digest_unavailable',
    digest_mismatch: 'digest_mismatch',
    digest_not_recorded: 'digest_not_recorded',
    length_mismatch: 'length_mismatch'
  };

  function normalizeHex(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
  }

  function formatLen(n, fallback) {
    return (typeof n === 'number' && isFinite(n)) ? String(n) : fallback;
  }

  /**
   * 判定一次浏览器下载是否已核验。输入：
   *   expectedByteLength  电脑端登记的长度（number，可缺省）
   *   actualByteLength    页面实际取回的长度（number）
   *   expectedSha256      电脑端登记的摘要（string，可缺省/为空）
   *   actualSha256        页面算出的摘要（string；**null 表示「未计算」**）
   * 返回：{ status, verified, fatal, note }
   *   fatal = true 表示必须放弃保存并报错；fatal = false 表示可以继续交接，
   *   但 **verified 才是允许声称「已核验」的唯一状态**。
   */
  function classifyDownload(input) {
    var got = input || {};
    var actualLen = got.actualByteLength;
    var expectedLen = got.expectedByteLength;

    if (typeof expectedLen === 'number' && isFinite(expectedLen) &&
        typeof actualLen === 'number' && actualLen !== expectedLen) {
      return {
        status: STATUS.length_mismatch,
        verified: false,
        fatal: true,
        note: '取回的文件长度与登记不一致（' + actualLen + ' / ' + expectedLen + '），已放弃保存。'
      };
    }

    var expected = normalizeHex(got.expectedSha256);
    if (expected === '') {
      return {
        status: STATUS.digest_not_recorded,
        verified: false,
        fatal: true,
        note: '电脑端没有登记这个文件的校验值，无法核对，已放弃保存（不把「未核对」说成已核验）。'
      };
    }

    if (got.actualSha256 === null || got.actualSha256 === undefined) {
      return {
        status: STATUS.digest_unavailable,
        verified: false,
        fatal: false,
        note: '长度一致；当前环境不能计算摘要（非安全上下文），本次**未核对校验值**。'
      };
    }

    var actual = normalizeHex(got.actualSha256);
    if (actual !== expected) {
      return {
        status: STATUS.digest_mismatch,
        verified: false,
        fatal: true,
        note: '取回的文件校验值与登记不符，已放弃保存。'
      };
    }

    return {
      status: STATUS.verified,
      verified: true,
      fatal: false,
      note: '长度与校验值都与电脑端登记一致。'
    };
  }

  /** 该判定允许发布的观察事件类型；null = 不发布任何事件（下载已放弃）。 */
  function observationKindFor(status) {
    if (status === STATUS.verified) return 'download_verified';
    if (status === STATUS.digest_unavailable) return 'handoff_requested';
    return null;
  }

  /** 观察事件详情文案。既写清做了什么，也写清**没有**做什么。 */
  function observationDetailFor(status, filename) {
    var name = typeof filename === 'string' ? filename : '';
    if (status === STATUS.verified) {
      return '页面取回字节并核对长度与摘要后触发浏览器保存：' + name;
    }
    if (status === STATUS.digest_unavailable) {
      return '页面取回字节并核对登记长度后触发浏览器保存；当前环境不能计算摘要，本次未核对校验值：' + name;
    }
    return '页面未完成核验：' + name;
  }

  /** 未加载本模块时的兜底：**永远不会**返回 verified（宁可说未核验，不假装核验过）。 */
  function fallbackClassify(input) {
    var got = input || {};
    if (typeof got.expectedByteLength === 'number' && isFinite(got.expectedByteLength) &&
        got.actualByteLength !== got.expectedByteLength) {
      return {
        status: STATUS.length_mismatch,
        verified: false,
        fatal: true,
        note: '取回的文件长度与登记不一致（' + formatLen(got.actualByteLength, '?') + ' / ' +
          got.expectedByteLength + '），已放弃保存。'
      };
    }
    return {
      status: STATUS.digest_unavailable,
      verified: false,
      fatal: false,
      note: '长度一致；校验模块未加载，本次**未核对校验值**。'
    };
  }

  return {
    STATUS: STATUS,
    classifyDownload: classifyDownload,
    observationKindFor: observationKindFor,
    observationDetailFor: observationDetailFor,
    fallbackClassify: fallbackClassify
  };
});
