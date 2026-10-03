/**
 * design-05 **WF-090**（打印交接）——**只做交接，不代打印**。
 *
 * ## 七态（任务书 §12）
 *
 * 任务书把"动作已经走到哪一步"分成七态，**不许互相冒充**。
 * {@link EXTERNAL_ACTION_STATE_MEANINGS} 是原文口径的落点：
 *
 * | 状态 | 精确含义 |
 * |---|---|
 * | `prepared` | 参数或产物就绪，尚未执行 |
 * | `handed_off` | 已打开目标应用或页面，**不表示用户提交** |
 * | `submitted` | 有机制证明请求已送达对应处理方 |
 * | `confirmed_complete` | 有可信回执或读回证据证明目标动作完成 |
 * | `result_unknown` | 无足够证据确认结果，不能推断成功或失败 |
 * | `user_reported_complete` | 来源是用户陈述，区别于自动核验 |
 * | `invalidated` | 已失效／失败／取消，按具体原因说明，保留已发生副作用 |
 *
 * ## 本模块的硬约束
 *
 * 1. **返回类型上就没有"已打印"**：`printed` 的**字面量类型是 `false`**，
 *    任何代码路径都不可能把它写成 `true`。要宣称"纸张已打印"，
 *    必须**另外**拿到可信回执——而本批**没有**这种回执（真机打印未验证）。
 * 2. 最好只到 `handed_off`：把 PDF 交给系统默认处理器并**如实标注**。
 * 3. 目标文件不存在 ⇒ `prepared` + 结构化失败，**不假装交接过**。
 * 4. **Android 上没有这条通路**：`MainActivity` 全文无 `PrintManager` /
 *    `createPrintDocumentAdapter` / `window.print`，且 `setDownloadListener` 明确拒绝
 *    浏览器下载路径（WCF-D06 读码结论）。所以手机端交接一律 `prepared` + `handoff_unavailable`，
 *    **未验证**要写在显眼处。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 七态
// ---------------------------------------------------------------------------

export type ExternalActionState =
  | 'prepared'
  | 'handed_off'
  | 'submitted'
  | 'confirmed_complete'
  | 'result_unknown'
  | 'user_reported_complete'
  | 'invalidated';

export const EXTERNAL_ACTION_STATE_MEANINGS: Readonly<Record<ExternalActionState, string>> = {
  prepared: '参数或产物就绪，尚未执行',
  handed_off: '已打开目标应用或页面，不表示用户提交',
  submitted: '有机制证明请求已送达对应处理方',
  confirmed_complete: '有可信回执或读回证据证明目标动作完成',
  result_unknown: '无足够证据确认结果，不能推断成功或失败',
  user_reported_complete: '来源是用户陈述，区别于自动核验',
  invalidated: '已失效／失败／取消，按具体原因说明，保留已发生副作用',
};

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

export type PrintHandoffPlatform = 'windows-desktop' | 'android' | 'unsupported';

/** 一次"交给系统处理"的结果（**端口层**，不是结论层）。 */
export interface PrintHandoffOpenResult {
  readonly opened: boolean;
  /** 关联到的处理器（例如 PDF 关联程序命令行）；拿不到就 null，**不猜**。 */
  readonly handler: string | null;
  readonly detail: string;
  readonly raw: string;
}

/** 打印交接端口。真实实现见 {@link import('./print-handoff-windows.js').createWindowsShellPrintHandoff}。 */
export interface PrintHandoffPort {
  readonly platform: PrintHandoffPlatform;
  /** 把产物交给系统默认处理器打开。**失败不抛异常**，走 `opened:false`。 */
  open(targetPath: string): Promise<PrintHandoffOpenResult>;
}

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

export interface PrintHandoffRequest {
  readonly pdfPath: string;
  /** 若给出，交接前重新核对盘上字节的 sha256（防止交出去的已被换过）。 */
  readonly expectedSha256?: string;
}

/** 成功交接：**已交接**，明确 `printed:false`。 */
export interface PrintHandoffHandedOff {
  readonly state: 'handed_off';
  readonly stateMeaning: string;
  readonly printed: false;
  readonly claim: string;
  readonly platform: PrintHandoffPlatform;
  readonly target: string;
  readonly handler: string | null;
  readonly detail: string;
  readonly raw: string;
  /** 与结论一同带出的边界声明（**不得**省略）。 */
  readonly boundaries: readonly string[];
}

/** 未交接：停在**已准备**，带结构化失败。 */
export interface PrintHandoffNotHandedOff {
  readonly state: 'prepared' | 'invalidated';
  readonly stateMeaning: string;
  readonly printed: false;
  readonly claim: string;
  readonly platform: PrintHandoffPlatform;
  readonly target: string;
  readonly failure: {
    readonly kind: 'target_missing' | 'target_digest_mismatch' | 'handoff_unavailable' | 'open_failed';
    readonly message: string;
    readonly detail?: string;
  };
  readonly raw: string;
  readonly boundaries: readonly string[];
}

export type PrintHandoffOutcome = PrintHandoffHandedOff | PrintHandoffNotHandedOff;

/** 与任何打印结论一并带出的**边界**（手机端未验证必须显眼）。 */
export const PRINT_HANDOFF_BOUNDARIES: readonly string[] = [
  '本批只做到「已交接」；**没有**任何"纸张已打印"的证据，不得如此宣称。',
  '真实交接路径只在 **Windows 桌面**成立（本机实测：Microsoft Word 16.0.20430 产 PDF → 交系统处理器）。',
  '**手机端（Android 目标平台）的打印通路完全未实现、未验证**：MainActivity 无 PrintManager/printDocumentAdapter，下载路径被显式拒绝。',
  '「未授权但可用」是当前 Word 的实测状态，不是可依赖的授权保证。',
];

// ---------------------------------------------------------------------------
// 交接
// ---------------------------------------------------------------------------

/**
 * 把一个**已经过读回核对**的 PDF 交给系统打印通路。
 *
 * 传 {@link import('./pdf-export.js').PdfExportSuccess} 是**刻意的**：
 * 只允许交接"已经被独立读回验证过"的产物——没验证过的东西不该交出去。
 */
export async function handOffToPrint(
  port: PrintHandoffPort,
  verified: { readonly pdfPath: string; readonly sha256: string },
): Promise<PrintHandoffOutcome> {
  return handOffPath(port, { pdfPath: verified.pdfPath, expectedSha256: verified.sha256 });
}

/** 低层入口：按路径交接（仍会做存在性与可选摘要核对）。 */
export async function handOffPath(
  port: PrintHandoffPort,
  request: PrintHandoffRequest,
): Promise<PrintHandoffOutcome> {
  if (!existsSync(request.pdfPath)) {
    return notHandedOff(port, 'prepared', request.pdfPath,
      '未交接：目标 PDF 不存在，仅有"准备交接"的意图。',
      { kind: 'target_missing', message: `目标 PDF 不存在：${request.pdfPath}` }, '');
  }

  if (request.expectedSha256 !== undefined) {
    const actual = sha256Of(request.pdfPath);
    if (actual !== request.expectedSha256) {
      return notHandedOff(port, 'invalidated', request.pdfPath,
        '未交接：盘上字节与读回时的摘要不一致，交出去的不是验证过的那份。',
        {
          kind: 'target_digest_mismatch',
          message: `摘要不一致：期望 ${request.expectedSha256}，盘上 ${actual}`,
        }, '');
    }
  }

  if (port.platform !== 'windows-desktop') {
    return notHandedOff(port, 'prepared', request.pdfPath,
      `未交接：平台 ${port.platform} 上没有可用的打印交接通路（**未实现、未验证**）。`,
      {
        kind: 'handoff_unavailable',
        message: `平台 ${port.platform} 无打印交接通路`,
        detail: 'Android 侧 MainActivity 无 PrintManager/createPrintDocumentAdapter；'
          + 'WebView 的 window.print 亦未接线。',
      }, '');
  }

  const opened = await port.open(request.pdfPath);
  if (!opened.opened) {
    return notHandedOff(port, 'prepared', request.pdfPath,
      '未交接：系统处理器未能打开产物。',
      opened.raw.length > 0
        ? { kind: 'open_failed', message: opened.detail, detail: opened.raw }
        : { kind: 'open_failed', message: opened.detail },
      opened.raw);
  }

  return {
    state: 'handed_off',
    stateMeaning: EXTERNAL_ACTION_STATE_MEANINGS.handed_off,
    printed: false,
    claim: '已交接：已把 PDF 交给系统默认处理器。**这不代表已打印**，也不代表用户提交了打印。',
    platform: port.platform,
    target: request.pdfPath,
    handler: opened.handler,
    detail: opened.detail,
    raw: opened.raw,
    boundaries: PRINT_HANDOFF_BOUNDARIES,
  };
}

function notHandedOff(
  port: PrintHandoffPort,
  state: 'prepared' | 'invalidated',
  target: string,
  claim: string,
  failure: PrintHandoffNotHandedOff['failure'],
  raw: string,
): PrintHandoffNotHandedOff {
  return {
    state,
    stateMeaning: EXTERNAL_ACTION_STATE_MEANINGS[state],
    printed: false,
    claim,
    platform: port.platform,
    target,
    failure,
    raw,
    boundaries: PRINT_HANDOFF_BOUNDARIES,
  };
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
