/**
 * **打印交接的裁决层（纯 TS）**——W09 对 WF-090 的核心纪律：**打印交接不是打印**。
 *
 * 与 Android 端 `PotbotPrintHandoff.java` 同一条口径，但可**无设备**机器化测试：
 *
 * - 状态词表**只有** `prepared` / `handed_off` 两态；**没有**"已打印"；
 * - `printed` 在类型上被钉成字面量 `false`——没有任何返回路径能给出 `true`；
 * - 交接前必须**重新核对**盘上字节摘要（`actualSha256` 与读回时的 `expectedSha256` 一致），
 *   被换过的文件不许交出去；
 * - {@link canClaimPrinted} 对任何输入都返回 `false`：本批**没有**可信打印机回执，
 *   拿不到就不要说"打印成功"。
 *
 * ## 边界（必须随任何结论一起带出）
 *
 * 系统打印框架的 `PrintDocumentAdapter` 回调只证明**系统打印服务取走了内容**，
 * 不等于用户提交了打印作业，更不等于纸张已打印。真机打印在本波**未验证**。
 */

/** 状态词表（封闭，仅两态）。**没有** `printed` / `confirmed_complete`。 */
export const PRINT_HANDOFF_STATES = ['prepared', 'handed_off'] as const;
export type PrintHandoffState = (typeof PRINT_HANDOFF_STATES)[number];

/** 交接失败分类（封闭枚举）。 */
export type PrintHandoffFailureKind =
  | 'target_missing'
  | 'target_digest_mismatch'
  | 'handoff_unavailable'
  | 'page_count_untrusted'
  | 'digest_missing';

/** 交接请求事实（由调用方从真实盘上与真实服务探到）。 */
export interface PrintHandoffFacts {
  /** 待打印 PDF 是否存在且非空。 */
  readonly targetExists: boolean;
  /** 读回器报出的真实页数（>0 才可信）。 */
  readonly pageCount: number;
  /** 读回核对通过时那份字节的 sha256；null 表示没有核对过。 */
  readonly expectedSha256: string | null;
  /** 交接前**重新**计算得到的盘上字节 sha256；null 表示未能重新读取。 */
  readonly actualSha256: string | null;
  /** 设备上是否有系统打印服务（PrintManager 可用）。 */
  readonly handoffServiceAvailable: boolean;
}

export interface PrintHandoffVerdict {
  readonly state: PrintHandoffState;
  /** **恒为 `false`**：类型即证据，本批不可表达"已打印"。 */
  readonly printed: false;
  readonly claim: string;
  /** 未交接时的结构化原因；已交接时为 undefined。 */
  readonly failureKind?: PrintHandoffFailureKind;
  readonly failureDetail?: string;
  /** 必须与结论一并带出的边界说明。 */
  readonly boundaries: readonly string[];
}

export const PRINT_BOUNDARIES: readonly string[] = [
  '本层只做到「已交接」；没有任何"纸张已打印"的证据，不得如此宣称。',
  'PrintDocumentAdapter 回调只证明系统打印服务取走了内容，不代表用户提交了打印作业。',
  '真机打印在本波未验证：没有设备窗口、APK 未安装、未实际出纸。',
];

function prepared(failureKind: PrintHandoffFailureKind, detail: string): PrintHandoffVerdict {
  return {
    state: 'prepared',
    printed: false,
    claim: `未交接：打印请求没有交出去（原因 ${failureKind}）。不表示已打印。`,
    failureKind,
    failureDetail: detail,
    boundaries: PRINT_BOUNDARIES,
  };
}

/**
 * 裁决一次打印交接。**只输出 `prepared` 或 `handed_off`；`printed` 恒为 `false`。**
 *
 * 判据顺序固定（先"在不在"，再"对不对"，再"服务有没有"），保证失败分类确定、可测。
 */
export function evaluatePrintHandoff(facts: PrintHandoffFacts): PrintHandoffVerdict {
  if (!facts.targetExists) {
    return prepared('target_missing', '待打印的 PDF 不存在或为空——只有"准备交接"的意图。');
  }
  if (!(facts.pageCount > 0)) {
    return prepared('page_count_untrusted', `页数 ${facts.pageCount} 不可信，拒绝交接。`);
  }
  if (facts.expectedSha256 === null || facts.expectedSha256 === '') {
    return prepared('digest_missing', '没有读回核对时的摘要，无法证明交出去的是核对过的那份。');
  }
  if (facts.actualSha256 === null) {
    return prepared('target_missing', '交接前无法重新读取产物（读回失败）。');
  }
  if (facts.actualSha256.toLowerCase() !== facts.expectedSha256.toLowerCase()) {
    return prepared(
      'target_digest_mismatch',
      `盘上字节与读回核对时的摘要不一致（盘上 ${facts.actualSha256}，期望 ${facts.expectedSha256}）。`,
    );
  }
  if (!facts.handoffServiceAvailable) {
    return prepared('handoff_unavailable', '本设备没有系统打印服务（PrintManager 不可用）。');
  }
  return {
    state: 'handed_off',
    printed: false,
    claim:
      '已交接：已把已核对过的 PDF 交给系统打印服务。这不代表用户提交了打印，更不代表纸张已打印。',
    boundaries: PRINT_BOUNDARIES,
  };
}

/** 一条"外部打印回执"的结构（如有的话）。 */
export interface ExternalPrintReceipt {
  readonly provider: string;
  readonly externalId: string;
  readonly observedState: string;
  readonly observedAt: string;
}

/**
 * 能不能据此宣称"已打印"？
 *
 * 本波**没有任何可信打印机回执通路**（Android 打印框架不返回"出纸"事件），
 * 因此对任何输入都返回 `false`。这是刻意的：**拿不到回执就不要说打印成功**。
 * 将来若接入真实回执，必须在此处引入显式来源校验并同步改本注释与测试。
 */
export function canClaimPrinted(_receipt: ExternalPrintReceipt | null): boolean {
  void _receipt;
  return false;
}
