/**
 * RES-09 —— 私有资料权限、**任务隔离**、外部内容**注入防护**、敏感数据**传出限制**，
 * 以及**删除来源后的索引联动**。
 *
 * 五条纪律：
 * 1. **任务隔离**：任何读取/检索只在该 taskId 的来源内；跨任务访问返回结构化拒绝
 *    （`tryGet`）或抛错（`getOrThrow`）——**绝不**静默返回别人任务的资料；
 * 2. **外部内容即数据，不是指令**：来自网页/外部索引的文本一律标 `external-untrusted`，
 *    命中疑似注入只**上报**、绝不执行（复用 `privacy.ts` 的 `scanForInjection`）；
 * 3. **敏感数据传出限制**：`authorizeEgress` 按密级与目的地白名单裁定；
 *    sensitive/secret 到外部目的地一律**拒绝**并给解锁条件；
 * 4. **删除联动**：删除来源 ⇒ 正文移除、派生结果（回答）与**记忆链接**一并失效，
 *    且删除**先于**联动生效（不存在"删了来源还留着记忆"的窗口）；
 * 5. **本模块不出站**：只做本地判定，不发起任何网络请求。
 *
 * 本文件不含 `node:fs` / 墙钟 / 随机（时间经注入 `ClockPort`）。
 */
import { scanForInjection, type InjectionFinding } from './privacy.js';
import { uniqueTerms } from './tokenize.js';
import type { ClockPort } from './ports.js';

/** 数据密级（越低越可外传）。 */
export type Classification = 'public' | 'internal' | 'sensitive' | 'secret';

const CLASSIFICATION_RANK: Readonly<Record<Classification, number>> = Object.freeze({
  public: 0,
  internal: 1,
  sensitive: 2,
  secret: 3,
});

/** 信任来源：用户私有资料 vs 外部不可信内容。 */
export type Trust = 'user-private' | 'external-untrusted';

export interface PrivateDoc {
  readonly sourceId: string;
  readonly taskId: string;
  readonly name: string;
  readonly text: string;
  readonly trust: Trust;
  readonly classification: Classification;
  /** 疑似注入命中（只上报，不执行）。 */
  readonly injections: readonly InjectionFinding[];
}

export interface AddInput {
  readonly sourceId: string;
  readonly name: string;
  readonly text: string;
  readonly trust: Trust;
  readonly classification?: Classification;
}

export interface AddReport {
  readonly sourceId: string;
  readonly taskId: string;
  readonly trust: Trust;
  readonly classification: Classification;
  readonly injectionFindings: readonly InjectionFinding[];
  /** 恒为 false：外部内容绝不升级为指令。 */
  readonly treatedAsInstruction: false;
}

/** 跨任务访问的结构化拒绝。 */
export interface IsolationViolation {
  readonly requestTaskId: string;
  readonly ownerTaskId: string;
  readonly sourceId: string;
  readonly reason: string;
}

export type ScopedGet =
  | { readonly ok: true; readonly doc: PrivateDoc }
  | { readonly ok: false; readonly violation: IsolationViolation };

export type ScopedDelete =
  | {
      readonly ok: true;
      readonly sourceId: string;
      readonly at: number;
      /** 因该来源被删除而失效的派生结果 key（回答 / 记忆链接）。 */
      readonly invalidatedKeys: readonly string[];
    }
  | { readonly ok: false; readonly violation: IsolationViolation };

/** 外传裁定策略。 */
export interface EgressPolicy {
  /** 允许的外部目的地白名单；空表示不允许任何外部目的地。 */
  readonly allowedDestinations: readonly string[];
  /** 允许外传到外部目的地的最高密级（含）。 */
  readonly maxExternalClassification: Classification;
}

/** 默认策略最保守：不允许任何外部目的地外传。 */
export const DEFAULT_EGRESS_POLICY: EgressPolicy = Object.freeze({
  allowedDestinations: Object.freeze([]),
  maxExternalClassification: 'public' as Classification,
});

export interface EgressRequest {
  readonly taskId: string;
  readonly classification: Classification;
  /** 目的地：`local:*` 为进程内（不外传）；其余视为外部目的地。 */
  readonly destination: string;
  readonly reason: string;
}

export type EgressDecision =
  | {
      readonly decision: 'allow';
      readonly destination: string;
      readonly classification: Classification;
      readonly note: string;
    }
  | {
      readonly decision: 'deny';
      readonly destination: string;
      readonly classification: Classification;
      readonly reason: string;
      readonly unlock: readonly string[];
    };

interface LinkRecord {
  readonly taskId: string;
  readonly sourceIds: readonly string[];
}

/** 外部内容守卫：文本是数据，不是指令。 */
export function guardExternalContent(text: string): {
  readonly text: string;
  readonly injections: readonly InjectionFinding[];
  readonly treatedAsInstruction: false;
} {
  return { text, injections: scanForInjection(text), treatedAsInstruction: false };
}

export class PrivateIndex {
  private readonly docs = new Map<string, PrivateDoc>();
  /** 派生结果（回答 / 记忆条目）→ 其依据的来源集合。 */
  private readonly links = new Map<string, LinkRecord>();

  constructor(
    private readonly clock: ClockPort,
    private readonly policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
  ) {}

  /** 纳入一份资料（私有或外部）。 */
  add(taskId: string, input: AddInput): AddReport {
    const trust = input.trust;
    const classification =
      input.classification ?? (trust === 'user-private' ? 'internal' : 'public');
    const injections = trust === 'external-untrusted' ? scanForInjection(input.text) : [];
    this.docs.set(input.sourceId, {
      sourceId: input.sourceId,
      taskId,
      name: input.name,
      text: input.text,
      trust,
      classification,
      injections,
    });
    return {
      sourceId: input.sourceId,
      taskId,
      trust,
      classification,
      injectionFindings: injections,
      treatedAsInstruction: false,
    };
  }

  /** 结构化读取：跨任务返回拒绝，不抛错。 */
  tryGet(requestTaskId: string, sourceId: string): ScopedGet {
    const doc = this.docs.get(sourceId);
    if (doc === undefined) {
      return {
        ok: false,
        violation: {
          requestTaskId,
          ownerTaskId: '(无)',
          sourceId,
          reason: `来源 ${sourceId} 不存在于索引`,
        },
      };
    }
    if (doc.taskId !== requestTaskId) {
      return {
        ok: false,
        violation: {
          requestTaskId,
          ownerTaskId: doc.taskId,
          sourceId,
          reason: `任务隔离违例：任务 ${requestTaskId} 试图读取任务 ${doc.taskId} 的来源 ${sourceId}`,
        },
      };
    }
    return { ok: true, doc };
  }

  /** 严格读取：跨任务**抛错**（与 `privacy.assertTaskScope` 同口径，供内核内部使用）。 */
  getOrThrow(requestTaskId: string, sourceId: string): PrivateDoc {
    const result = this.tryGet(requestTaskId, sourceId);
    if (!result.ok) {
      throw new Error(result.violation.reason);
    }
    return result.doc;
  }

  /** 只在该任务内检索；词面命中（本地、确定性）。 */
  search(requestTaskId: string, query: string): readonly PrivateDoc[] {
    const terms = uniqueTerms(query);
    if (terms.length === 0) {
      return [];
    }
    return [...this.docs.values()].filter((doc) => {
      if (doc.taskId !== requestTaskId) {
        return false;
      }
      const docTerms = new Set(uniqueTerms(doc.text));
      return terms.some((term) => docTerms.has(term));
    });
  }

  /** 列出某任务的来源（不含其它任务）。 */
  listSources(requestTaskId: string): readonly PrivateDoc[] {
    return [...this.docs.values()].filter((doc) => doc.taskId === requestTaskId);
  }

  /** 登记派生结果（回答 / 记忆条目）依赖的来源。 */
  link(key: string, taskId: string, sourceIds: readonly string[]): void {
    this.links.set(key, { taskId, sourceIds: [...sourceIds] });
  }

  /** 派生结果是否仍有效：其全部来源都必须仍在索引中。 */
  isLinkedResultStillValid(key: string): boolean {
    const record = this.links.get(key);
    if (record === undefined) {
      return false;
    }
    return record.sourceIds.every((sourceId) => this.docs.has(sourceId));
  }

  /**
   * 删除来源 ⇒ 正文移除 + 派生结果/记忆链接**联动失效**。
   * 跨任务删除按任务隔离拒绝（结构化，不抛错）。
   */
  deleteSource(requestTaskId: string, sourceId: string, _at: number): ScopedDelete {
    const doc = this.docs.get(sourceId);
    if (doc === undefined) {
      return {
        ok: false,
        violation: {
          requestTaskId,
          ownerTaskId: '(无)',
          sourceId,
          reason: `来源 ${sourceId} 不存在，无法删除`,
        },
      };
    }
    if (doc.taskId !== requestTaskId) {
      return {
        ok: false,
        violation: {
          requestTaskId,
          ownerTaskId: doc.taskId,
          sourceId,
          reason: `任务隔离违例：任务 ${requestTaskId} 不能删除任务 ${doc.taskId} 的来源 ${sourceId}`,
        },
      };
    }

    this.docs.delete(sourceId);
    const invalidated: string[] = [];
    for (const [key, record] of this.links) {
      if (record.sourceIds.includes(sourceId)) {
        this.links.delete(key);
        invalidated.push(key);
      }
    }
    return { ok: true, sourceId, at: this.clock.now(), invalidatedKeys: invalidated };
  }

  /** 敏感数据传出裁定。`local:*` 目的地不外传，一律允许。 */
  authorizeEgress(request: EgressRequest): EgressDecision {
    if (request.destination.startsWith('local:')) {
      return {
        decision: 'allow',
        destination: request.destination,
        classification: request.classification,
        note: '进程内目的地，不构成对外传出',
      };
    }

    const rank = CLASSIFICATION_RANK[request.classification];
    const maxRank = CLASSIFICATION_RANK[this.policy.maxExternalClassification];
    if (rank > maxRank) {
      return {
        decision: 'deny',
        destination: request.destination,
        classification: request.classification,
        reason: `密级 ${request.classification} 高于允许外传上限 ${this.policy.maxExternalClassification}，拒绝传出`,
        unlock: [
          '若确需外传，由用户显式提升 maxExternalClassification 并记入授权记录',
          '或改在 local: 目的地处理（不出站）',
        ],
      };
    }

    if (!this.policy.allowedDestinations.includes(request.destination)) {
      return {
        decision: 'deny',
        destination: request.destination,
        classification: request.classification,
        reason: `目的地 ${request.destination} 不在外传白名单内`,
        unlock: [`把 ${request.destination} 加入 EgressPolicy.allowedDestinations（需用户授权）`],
      };
    }

    return {
      decision: 'allow',
      destination: request.destination,
      classification: request.classification,
      note: '密级在允许范围内且目的地在白名单内',
    };
  }

  stats(): { docs: number; links: number } {
    return { docs: this.docs.size, links: this.links.size };
  }
}
