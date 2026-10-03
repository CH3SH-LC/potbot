/**
 * FA-M 共享的**就绪度**模型（合同 R231「能力发现区分五态」/ R233「未就绪先给原因」）。
 *
 * ## 三态判定与"五态"的关系
 *
 * R231 的**五态**描述的是"某项能力装没装、开没开、授没授权、依赖齐没齐、有没有实测支持"，
 * 是一个**能力维度**的刻画。本文件在此之上再加一个**结论维度** {@link ReadinessVerdict}，
 * 直接回答用户会问的问题："这个子项到底能不能做？"
 *
 * - `implemented`：**本批范围内**（不含真机）已做完，且有本机可复现证据；
 * - `not_ready`：部分已做，还缺外部条件（设备 / 权限 / 授权接口 / 数据），**条件具备即可推进**；
 * - `blocked`：**平台不提供合法通道**，或**合同禁止**，导致该子项**无法**按原描述完成。
 *   记 `blocked` 的目的是**阻止**把它悄悄留成"以后再做的 TODO"——那是把不可能说成未排期。
 *
 * ## 关于 `CapabilityState` 的另一份定义（**如实登记**）
 *
 * `src/adapters/research/not-ready.ts` 也有一份同形的 `CapabilityState`（FA-G2 所留）。
 * 本文件**没有**去 import 它——那是**另一个领域包**的源码，跨包引用会把两条领域流焊死。
 * 两份同形接口是**已知的重复**，已在 `outputs/FA-M/interface-declaration.md` 建议
 * 总协调把 `CapabilityState` / `NotReadyItem` 提升为 `src/protocol/**` 的公共类型；
 * 提升前各包各自持有同形定义，**语义逐字一致**。
 */

/** R231 的五态（与 FA-G2 的同形定义语义一致）。 */
export interface CapabilityState {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly deps_ready: boolean;
  /** 是否**实测**支持过（有真实入口跑通的证据）。 */
  readonly verified_supported: boolean;
}

export const NOT_INSTALLED: CapabilityState = Object.freeze({
  installed: false,
  enabled: false,
  authorized: false,
  deps_ready: false,
  verified_supported: false,
});

/** 已实现且有本机证据。 */
export const LOCAL_VERIFIED: CapabilityState = Object.freeze({
  installed: true,
  enabled: true,
  authorized: true,
  deps_ready: true,
  verified_supported: true,
});

/** **结论维度**：该子项能否完成。 */
export type ReadinessVerdict = 'implemented' | 'not_ready' | 'blocked';

export const VERDICT_LABELS: Readonly<Record<ReadinessVerdict, string>> = Object.freeze({
  implemented: '已实现',
  not_ready: '未就绪',
  blocked: '阻塞',
});

export interface SubitemReadiness {
  /** 需求编号（MT-01 / CLK-01 / CAL-01 …）。 */
  readonly id: string;
  /** 需求一句话。 */
  readonly requirement: string;
  readonly verdict: ReadinessVerdict;
  /** 本次**实际做到哪**（精确到范围，不含含糊的"部分完成"）。 */
  readonly implementedScope: string;
  /** `not_ready` / `blocked` **必填**原因；`implemented` 时为 null。 */
  readonly reason: string | null;
  /** 需要**什么**才能推进（`implemented` 时为空串）。 */
  readonly unblockedBy: string;
  readonly capability: CapabilityState;
  /** 证据指向（测试文件 / 源文件），可复核。 */
  readonly evidence: readonly string[];
}

/** 校验一条就绪记录是否自洽（`implemented` 必须有证据；其余必须有原因与解锁条件）。 */
export function assertReadinessRecord(record: SubitemReadiness): void {
  if (record.verdict === 'implemented') {
    if (record.reason !== null) {
      throw new Error(`${record.id} 标为已实现却带了未就绪原因`);
    }
    if (record.evidence.length === 0) {
      throw new Error(`${record.id} 标为已实现却**没有**任何可复核证据`);
    }
    return;
  }
  if (record.reason === null || record.reason.trim() === '') {
    throw new Error(`${record.id} 标为「${VERDICT_LABELS[record.verdict]}」但**没有给出原因**（R233）`);
  }
  if (record.unblockedBy.trim() === '') {
    throw new Error(`${record.id} 标为「${VERDICT_LABELS[record.verdict]}」但没写"需要什么才能推进"`);
  }
}

/** 汇总计数（供交付说明与自检脚本复算）。 */
export function countVerdicts(records: readonly SubitemReadiness[]): Record<ReadinessVerdict, number> {
  const counts: Record<ReadinessVerdict, number> = { implemented: 0, not_ready: 0, blocked: 0 };
  for (const record of records) counts[record.verdict] += 1;
  return counts;
}
