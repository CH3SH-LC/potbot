/**
 * M05 配送时间段选择。
 *
 * 时段由注入的 `DeliverySlotPort` 给出（本包**不产生**任何真实时段，也不读时钟）。
 * 纪律：
 * - 只允许选中**已加载且可用**的时段；未知/不可用一律显式抛错；
 * - 换地址或重新加载 ⇒ 旧选择**作废**（不静默保留一个属于旧地址的时段）；
 * - 时段过期（`endAt <= now`）判失效，且 `now` 由调用方注入。
 */

import { DeliverySlotError, SlotStaleError } from './errors.js';
import type {
  DeliverySlot,
  DeliverySlotPort,
  SlotSelectionCheck,
  SlotStaleReason,
} from './types.js';

/** 失效原因固定顺序。 */
export const SLOT_STALE_REASON_ORDER: readonly SlotStaleReason[] = Object.freeze([
  'not_loaded',
  'address_changed',
  'no_selection',
  'slot_missing',
  'slot_unavailable',
  'slot_expired',
]);

function validateSlots(slots: readonly DeliverySlot[]): readonly DeliverySlot[] {
  const seen = new Set<string>();
  const result: DeliverySlot[] = [];
  for (const slot of slots) {
    if (typeof slot.slotId !== 'string' || slot.slotId.length === 0) {
      throw new DeliverySlotError('时段 slotId 不能为空');
    }
    if (seen.has(slot.slotId)) {
      throw new DeliverySlotError(`时段 ${slot.slotId} 重复出现`);
    }
    seen.add(slot.slotId);
    if (!Number.isFinite(slot.startAt) || !Number.isFinite(slot.endAt) || slot.startAt >= slot.endAt) {
      throw new DeliverySlotError(`时段 ${slot.slotId} 的时间区间非法（startAt 必须早于 endAt）`);
    }
    result.push(Object.freeze({ ...slot }));
  }
  return Object.freeze(result);
}

export class DeliverySlotSelector {
  #slots: readonly DeliverySlot[] = Object.freeze([]);
  #addressRef: string | null = null;
  #fetchedAt: number | null = null;
  #selectedSlotId: string | null = null;

  get slots(): readonly DeliverySlot[] {
    return this.#slots;
  }

  get addressRef(): string | null {
    return this.#addressRef;
  }

  get fetchedAt(): number | null {
    return this.#fetchedAt;
  }

  get selectedSlotId(): string | null {
    return this.#selectedSlotId;
  }

  /** 是否已经加载过时段（针对当前地址）。 */
  get loaded(): boolean {
    return this.#addressRef !== null;
  }

  /**
   * 从注入端口加载时段。
   *
   * 加载总是**清空**旧选择：换了地址或重新加载后，旧选择不再成立。
   */
  async load(
    port: DeliverySlotPort,
    request: { readonly merchantId: string; readonly addressRef: string; readonly now: number },
  ): Promise<readonly DeliverySlot[]> {
    if (typeof request.addressRef !== 'string' || request.addressRef.length === 0) {
      throw new DeliverySlotError('加载时段必须给出非空 addressRef');
    }
    if (!Number.isFinite(request.now)) {
      throw new DeliverySlotError(`now 必须是有限数，收到 ${String(request.now)}`);
    }
    const slots = await port.listSlots(request);
    this.#slots = validateSlots(slots);
    this.#addressRef = request.addressRef;
    this.#fetchedAt = request.now;
    this.#selectedSlotId = null;
    return this.#slots;
  }

  /** 选中一个时段：必须已加载、存在且 `available`。 */
  select(slotId: string): DeliverySlot {
    if (this.#addressRef === null) {
      throw new DeliverySlotError('尚未加载配送时段，无法选择');
    }
    const slot = this.#slots.find((candidate) => candidate.slotId === slotId);
    if (slot === undefined) {
      throw new DeliverySlotError(`未知的配送时段 ${slotId}`);
    }
    if (!slot.available) {
      throw new DeliverySlotError(`配送时段 ${slotId} 当前不可用`);
    }
    this.#selectedSlotId = slotId;
    return slot;
  }

  /** 当前选中的时段对象；未选或已不存在则为 `null`。 */
  selectedSlot(): DeliverySlot | null {
    if (this.#selectedSlotId === null) return null;
    return this.#slots.find((slot) => slot.slotId === this.#selectedSlotId) ?? null;
  }

  /**
   * 判定当前选择是否仍可用。
   *
   * @param input.now 注入时钟的当前时刻。
   * @param input.addressRef 当前配送地址引用（与加载时不一致 ⇒ `address_changed`）。
   */
  checkSelection(input: { readonly now: number; readonly addressRef: string }): SlotSelectionCheck {
    const reasons: SlotStaleReason[] = [];
    if (this.#addressRef === null || this.#fetchedAt === null) {
      reasons.push('not_loaded');
    } else if (this.#addressRef !== input.addressRef) {
      reasons.push('address_changed');
    }
    if (this.#selectedSlotId === null) {
      reasons.push('no_selection');
    } else {
      const slot = this.#slots.find((candidate) => candidate.slotId === this.#selectedSlotId);
      if (slot === undefined) {
        reasons.push('slot_missing');
      } else {
        if (!slot.available) reasons.push('slot_unavailable');
        if (Number.isFinite(input.now) && input.now >= slot.endAt) reasons.push('slot_expired');
      }
    }
    const ordered = SLOT_STALE_REASON_ORDER.filter((reason) => reasons.includes(reason));
    return Object.freeze({
      usable: ordered.length === 0,
      slotId: this.#selectedSlotId,
      reasons: Object.freeze(ordered),
      detail: ordered.length === 0 ? '所选时段可用' : `时段选择不可用：${ordered.join(' / ')}`,
    });
  }

  /** 要求当前选择可用：不可用则抛 `SlotStaleError`。 */
  requireUsableSelection(input: { readonly now: number; readonly addressRef: string }): DeliverySlot {
    const check = this.checkSelection(input);
    if (!check.usable) {
      throw new SlotStaleError(this.#selectedSlotId ?? '(none)', check.reasons, check.detail);
    }
    const slot = this.selectedSlot();
    if (slot === null) {
      throw new SlotStaleError(this.#selectedSlotId ?? '(none)', check.reasons, check.detail);
    }
    return slot;
  }
}
