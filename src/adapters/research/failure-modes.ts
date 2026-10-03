/**
 * RES-10 —— 检索的**六态失败模式**判定 + **重开继续任务** + 「有来源但不支持结论仍判失败」。
 *
 * ## 六态（各自可判，判定顺序固定且有据）
 *
 * | 次序 | 模式 | 判据 |
 * |---|---|---|
 * | 1 | `unreadable-file` | 存在不可读来源（无字节 / 解析失败 / OCR 未接通）|
 * | 2 | `stale-cache` | 只能提供**已过期**的缓存内容 |
 * | 3 | `offline` | 真实检索通道不可达（断网 / 端口未接通）|
 * | 4 | `conflict` | 检索成功但存在**来源冲突**（同标签不同来源数值不一致）|
 * | 5 | `empty` | 检索成功但**零命中** |
 * | 6 | `success` | 检索成功、有命中、无冲突 |
 *
 * 顺序的理由：先"读不到输入"、再"只有旧内容"、再"连不上"、再"结果有问题"、最后才是空/成功。
 * 一次观测**恰好**落入一个模式（判定是确定的：同样的观测永远给同样的模式）。
 *
 * ## 有来源但不支持结论 ⇒ 仍判失败
 *
 * `classifyAnswerSupport` **直接调用** `citation-support.ts` 的 `verifyAnswerSupport`
 * （关联性 + 支持性 + 原始字节回读），**不另造一套口径**。裁定失败的条数进 `unsupportedClaims`，
 * 而 `classifyRun` 只要该数 > 0，即使检索本身成功，整轮也 `ok=false` ——
 * 「有来源」绝不等于「来源支持结论」。
 *
 * ## 重开继续任务
 *
 * `RunCheckpoint` 是**纯数据**（可 JSON 序列化）：`serializeCheckpoint` / `restoreCheckpoint`
 * 模拟"关掉 App、重开、从落盘状态继续"。`restoreCheckpoint` 对残缺/畸形/未知模式一律返回
 * `null`（不抛错、不猜），`resumeAdvice` 给出恢复后**下一步该做什么**。
 *
 * ## 未就绪（不伪造）
 *
 * 本文件的六态判定是**纯逻辑**：真实联网端口（`research_network_port`）与 OCR 端口在本机
 * **均未接通**（见 `not-ready.ts`），因此"断网/过期缓存/不可读文件"在**产品运行链上未实测**，
 * 仅由注入的观测结构驱动。未接真实入口前一律标"未验证"，绝不以模拟结果冒充实测。
 *
 * 本文件不含 `node:fs` / 墙钟 / 随机。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import {
  verifyAnswerSupport,
  type ClaimVerifyOptions,
  type EvidenceSpan,
} from './citation-support.js';
import type { Answer } from './types.js';

/** 六态失败模式。 */
export type FailureMode =
  | 'success'
  | 'empty'
  | 'conflict'
  | 'offline'
  | 'stale-cache'
  | 'unreadable-file';

/** 六态的固定顺序（即判定优先级，从高到低）。 */
export const FAILURE_MODES: readonly FailureMode[] = Object.freeze([
  'unreadable-file',
  'stale-cache',
  'offline',
  'conflict',
  'empty',
  'success',
]);

export const FAILURE_MODE_LABELS: Readonly<Record<FailureMode, string>> = Object.freeze({
  'unreadable-file': '不可读文件',
  'stale-cache': '过期缓存',
  offline: '断网',
  conflict: '来源冲突',
  empty: '空结果',
  success: '真实检索成功',
});

/** 运行期类型守卫：用于校验外部（落盘/宿主）传入的模式字符串。 */
export function isFailureMode(value: unknown): value is FailureMode {
  return typeof value === 'string' && (FAILURE_MODES as readonly string[]).includes(value);
}

/** 一个读不出内容的来源。 */
export interface UnreadableSource {
  readonly sourceId: string;
  /** 不可读原因（无字节 / 解析失败 / ocr-required / unsupported）。 */
  readonly reason: string;
}

/**
 * 一轮检索的观测（由调用方从真实端口/索引收集）。
 * 本模块**不自行联网/读文件**，只对观测做判定。
 */
export interface RunObservation {
  /** 真实检索通道是否可达（断网 / 端口未接通 ⇒ false）。 */
  readonly reachable: boolean;
  /** 本次是否只能提供**已过期**的缓存内容。 */
  readonly servingStaleCache: boolean;
  /** 不可读的输入来源；缺省视为无。 */
  readonly unreadableSources?: readonly UnreadableSource[];
  /** 检索到的命中数（`reachable=false` 时应为 0）。 */
  readonly hits: number;
  /** 来源冲突数（同标签不同来源数值不一致）。 */
  readonly conflicts: number;
  /** 有来源但来源**不支持**结论的陈述条数（由 `classifyAnswerSupport` 产出）。 */
  readonly unsupportedClaims?: number;
}

/** 一轮检索的裁定。 */
export interface RunClassification {
  readonly mode: FailureMode;
  /** 模式的用户可读名。 */
  readonly label: string;
  /**
   * 是否可作为**可信结果**呈给用户：
   * `mode === 'success'` **且** 无"有来源但不支持结论"的陈述。
   */
  readonly ok: boolean;
  readonly reason: string;
  /** 是否有可用的**部分**结果（旧缓存 / 除不可读文件外的其余来源）。 */
  readonly partial: boolean;
  /** 恢复后应执行的下一步（人/机可读）。 */
  readonly nextStep: string;
  /** 有来源但不支持结论的陈述条数（口径来自 `citation-support`）。 */
  readonly unsupportedClaims: number;
}

/**
 * 判定一轮检索落在六态中的哪一态（判定顺序见文件头表格）。
 */
export function classifyRun(observation: RunObservation): RunClassification {
  const unreadable = observation.unreadableSources ?? [];
  const unsupported = observation.unsupportedClaims ?? 0;

  if (unreadable.length > 0) {
    return {
      mode: 'unreadable-file',
      label: FAILURE_MODE_LABELS['unreadable-file'],
      ok: false,
      reason: `${unreadable.length} 个来源不可读：${unreadable.map((u) => u.sourceId).join('、')}`,
      partial: true,
      nextStep: '修复或更换不可读来源后重试；已读来源的结果可先给部分结果',
      unsupportedClaims: unsupported,
    };
  }

  if (observation.servingStaleCache) {
    return {
      mode: 'stale-cache',
      label: FAILURE_MODE_LABELS['stale-cache'],
      ok: false,
      reason: '只取得已过失效时刻的缓存内容，不得当作最新结果',
      partial: true,
      nextStep: '联网后刷新缓存再作答（当前仅有过期缓存）',
      unsupportedClaims: unsupported,
    };
  }

  if (!observation.reachable) {
    return {
      mode: 'offline',
      label: FAILURE_MODE_LABELS.offline,
      ok: false,
      reason: '真实检索通道不可达（断网或端口未接通）',
      partial: false,
      nextStep: '网络恢复后重新检索',
      unsupportedClaims: unsupported,
    };
  }

  if (observation.conflicts > 0) {
    return {
      mode: 'conflict',
      label: FAILURE_MODE_LABELS.conflict,
      ok: false,
      reason: `检索成功但存在 ${observation.conflicts} 处来源冲突（同一标签不同来源数值不一致）`,
      partial: true,
      nextStep: '请用户裁决以哪个来源为准（本适配器不替用户裁决）',
      unsupportedClaims: unsupported,
    };
  }

  if (observation.hits === 0) {
    return {
      mode: 'empty',
      label: FAILURE_MODE_LABELS.empty,
      ok: false,
      reason: '检索成功但零命中',
      partial: false,
      nextStep: '换用更宽的关键词或放宽范围后补查',
      unsupportedClaims: unsupported,
    };
  }

  // success —— 但"有来源但不支持结论"仍判失败。
  if (unsupported > 0) {
    return {
      mode: 'success',
      label: FAILURE_MODE_LABELS.success,
      ok: false,
      reason: `检索成功，但有 ${unsupported} 条结论虽有来源却**不被来源支持**，故整轮判失败`,
      partial: true,
      nextStep: '撤下未被支持的结论，补查可支持它们的来源后再作答',
      unsupportedClaims: unsupported,
    };
  }

  return {
    mode: 'success',
    label: FAILURE_MODE_LABELS.success,
    ok: true,
    reason: `检索成功：${observation.hits} 条命中、无冲突、结论均被来源支持`,
    partial: false,
    nextStep: '无需继续',
    unsupportedClaims: 0,
  };
}

/** 回答的支持性汇总（口径 = `citation-support.ts`）。 */
export interface AnswerSupportSummary {
  readonly ok: boolean;
  /** 裁定失败的陈述条数（任一失败口径都计入）。 */
  readonly unsupportedClaims: number;
  readonly failures: readonly string[];
}

/**
 * 用**既有** `citation-support` 判据核对整份回答。
 * 本函数**不新造口径**：直接调用 `verifyAnswerSupport`，只做形状汇总。
 */
export function classifyAnswerSupport(
  answer: Answer,
  evidenceByChunkId: ReadonlyMap<string, EvidenceSpan>,
  options: ClaimVerifyOptions = {},
): AnswerSupportSummary {
  const report = verifyAnswerSupport(answer, evidenceByChunkId, options);
  return {
    ok: report.ok,
    unsupportedClaims: report.failures.length,
    failures: report.failures,
  };
}

// ===========================================================================
// 重开继续任务
// ===========================================================================

/** 一轮任务的**纯数据**检查点（可 JSON 序列化；不含函数/类实例）。 */
export interface RunCheckpoint {
  readonly runId: string;
  readonly query: string;
  /** 已完成的步骤（有序）。 */
  readonly completedSteps: readonly string[];
  /** 已取得的证据块 id（重开后据此不重复取）。 */
  readonly evidenceChunkIds: readonly string[];
  /** 上次裁定；从未裁定为 null。 */
  readonly lastMode: FailureMode | null;
}

/** 新建检查点。 */
export function startCheckpoint(runId: string, query: string): RunCheckpoint {
  return { runId, query, completedSteps: [], evidenceChunkIds: [], lastMode: null };
}

/**
 * 推进检查点（**纯函数**，不改原对象）：追加一步 + 记录本次裁定 + 合并证据块。
 * 同样的输入永远得到同样的输出（可复现）。
 */
export function advanceCheckpoint(
  checkpoint: RunCheckpoint,
  step: string,
  mode: FailureMode,
  evidenceChunkIds: readonly string[] = [],
): RunCheckpoint {
  const steps = checkpoint.completedSteps.includes(step)
    ? checkpoint.completedSteps
    : [...checkpoint.completedSteps, step];
  const evidence = [...new Set([...checkpoint.evidenceChunkIds, ...evidenceChunkIds])];
  return {
    runId: checkpoint.runId,
    query: checkpoint.query,
    completedSteps: steps,
    evidenceChunkIds: evidence,
    lastMode: mode,
  };
}

/** 序列化检查点（跨"关 App / 重开"边界）。 */
export function serializeCheckpoint(checkpoint: RunCheckpoint): string {
  return JSON.stringify(checkpoint);
}

/**
 * 从落盘字符串还原检查点。
 * 残缺 / 畸形 / 未知模式一律返回 `null`（不抛错、不猜）——重开不得凭空发明状态。
 */
export function restoreCheckpoint(json: string): RunCheckpoint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  const runId = record['runId'];
  if (typeof runId !== 'string' || runId.length === 0) {
    return null;
  }
  const query = record['query'];
  if (typeof query !== 'string') {
    return null;
  }
  const completedSteps = record['completedSteps'];
  if (!Array.isArray(completedSteps) || !completedSteps.every((s) => typeof s === 'string')) {
    return null;
  }
  const evidenceChunkIds = record['evidenceChunkIds'];
  if (!Array.isArray(evidenceChunkIds) || !evidenceChunkIds.every((s) => typeof s === 'string')) {
    return null;
  }
  const rawMode = record['lastMode'];
  let lastMode: FailureMode | null;
  if (rawMode === null) {
    lastMode = null;
  } else if (isFailureMode(rawMode)) {
    lastMode = rawMode;
  } else {
    return null;
  }

  return {
    runId,
    query,
    completedSteps: completedSteps as string[],
    evidenceChunkIds: evidenceChunkIds as string[],
    lastMode,
  };
}

/** 重开后的恢复建议。 */
export interface ResumeAdvice {
  /** 是否仍有可执行的下一步（`success` 视为已完成 ⇒ false）。 */
  readonly resumable: boolean;
  readonly nextStep: string;
  readonly reason: string;
}

/**
 * 依上次裁定给出**重开后**的下一步；未裁定过则回到首次检索。
 * 与 `classifyRun(...).nextStep` 同口径（同一张表），保证"重开"与"首次"路径一致。
 */
export function resumeAdvice(checkpoint: RunCheckpoint): ResumeAdvice {
  const mode = checkpoint.lastMode;
  if (mode === null) {
    return {
      resumable: true,
      nextStep: '发起首次检索',
      reason: `任务 ${checkpoint.runId} 从未裁定过，按首次检索继续`,
    };
  }
  if (mode === 'success') {
    return {
      resumable: false,
      nextStep: '无需继续',
      reason: '上次已成功且结论被来源支持，任务已完成',
    };
  }
  const decision = classifyRun({
    reachable: mode !== 'offline',
    servingStaleCache: mode === 'stale-cache',
    unreadableSources: mode === 'unreadable-file' ? [{ sourceId: '(resumed)', reason: '上次不可读' }] : [],
    hits: mode === 'conflict' || mode === 'empty' ? 0 : 1,
    conflicts: mode === 'conflict' ? 1 : 0,
  });
  return {
    resumable: true,
    nextStep: decision.nextStep,
    reason: `上次裁定为「${decision.label}」，据此继续`,
  };
}
