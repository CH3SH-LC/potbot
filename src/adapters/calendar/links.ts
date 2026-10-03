/**
 * 日程与**任务事实**的关联，以及事实变化时的联动（CAL-08）。
 *
 * CAL-08 原文：「任务事实变化后更新相关日程，**旧确认气泡失效**；**独立日程不被误合并**」。
 *
 * 本模块的立场：**关联必须显式建立**（`link`），因此：
 * - 只有**登记过**关联的日程会随事实变化被标记为"需更新"——**独立日程不受影响**，
 *   从结构上杜绝"按标题相似度误合并"；
 * - 事实版本推进后，旧版本上的确认气泡被标为**已失效**（保留历史，不冒充当前结果，R213/R251）。
 *
 * 纯逻辑，不读写任何存储。
 */

export interface EventFactLink {
  readonly eventId: string;
  /** 事实引用（如"人数=10"这条事实的稳定键）。 */
  readonly factRef: string;
  /** 链接建立时所依据的事实版本。 */
  readonly factRevision: number;
  /** 该链接上确认气泡的 id（用于失效判定）。 */
  readonly bubbleId: string | null;
}

export interface EventReference {
  readonly eventId: string;
  readonly revision: number;
}

export interface FactChangeOutcome {
  /** 需要更新的日程（按 eventId 去重、稳定排序）。 */
  readonly affectedEventIds: readonly string[];
  /** 失效的确认气泡 id。 */
  readonly expiredBubbleIds: readonly string[];
  /** 与该事实**无关**的日程（CAL-08：不被误合并）。 */
  readonly untouchedEventIds: readonly string[];
}

export interface EventLinkIndex {
  /** 建立关联。同一 `(eventId, factRef)` 重复建立幂等（不产生重复链接）。 */
  link(link: EventFactLink): void;
  /** 解除某日程的全部关联。 */
  unlinkEvent(eventId: string): void;
  /** 某日程关联的事实引用。 */
  linksOf(eventId: string): readonly EventFactLink[];
  /** 事实变化 ⇒ 计算需要更新的日程与要失效的气泡。 */
  onFactChanged(factRef: string, newRevision: number, allEvents: readonly EventReference[]): FactChangeOutcome;
}

export function createEventLinkIndex(): EventLinkIndex {
  // eventId → (factRef → link)
  const byEvent = new Map<string, Map<string, EventFactLink>>();

  const allLinks = (): EventFactLink[] => {
    const out: EventFactLink[] = [];
    for (const perFact of byEvent.values()) out.push(...perFact.values());
    return out;
  };

  return {
    link(entry) {
      let perFact = byEvent.get(entry.eventId);
      if (perFact === undefined) {
        perFact = new Map();
        byEvent.set(entry.eventId, perFact);
      }
      perFact.set(entry.factRef, entry);
    },

    unlinkEvent(eventId) {
      byEvent.delete(eventId);
    },

    linksOf(eventId) {
      const perFact = byEvent.get(eventId);
      return perFact === undefined ? [] : [...perFact.values()];
    },

    onFactChanged(factRef, newRevision, allEvents) {
      const affected = new Set<string>();
      const expiredBubbles = new Set<string>();

      for (const entry of allLinks()) {
        if (entry.factRef !== factRef) continue;
        if (entry.factRevision === newRevision) continue;
        affected.add(entry.eventId);
        if (entry.bubbleId !== null) expiredBubbles.add(entry.bubbleId);
      }

      const untouched = allEvents
        .map((event) => event.eventId)
        .filter((eventId) => !affected.has(eventId))
        .sort();

      return {
        affectedEventIds: [...affected].sort(),
        expiredBubbleIds: [...expiredBubbles].sort(),
        untouchedEventIds: untouched,
      };
    },
  };
}
