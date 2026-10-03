/**
 * M05 「定位 → 地址绑定」编排（`locate.ts`）。
 *
 * 工作书 M05 验收要求「手填与定位都可用，绑定地址版本；拒绝权限不静默换地址」。
 * `./address-book.ts` 覆盖手填，`./view-model.ts` 覆盖解析与「不换地址」，但
 * **从一次定位产生一条带版本的地址并绑定**此前没有代码路径——本模块补上：
 *
 * - `applyLocationFix`：把注入端口给出的定位固化成 `source: 'located'` 的地址记录
 *   （版本从 v1 起、`ref` 含版本）；同一位置的重复定位**不新增、不推进版本**。
 * - `locateAndBind`：一次编排「（未授权时）请求权限 → 读取定位 → 落进地址簿」，
 *   返回绑定的 `addressRef`。**未授权 / 被拒 / 定位失败时不产生任何地址**，结果里
 *   `addressId` / `addressRef` 恒为 `null`、`requiresExplicitSelection` 为 `true`
 *   ——既不静默回退到默认地址，也**不在未授权时尝试定位**。
 *
 * 本模块不发起真实定位、不请求系统权限、不读时钟/随机/环境：位置来自注入端口。
 */

import { checkDeliveryPlan, createDeliveryPlanFromSlot } from './binding.js';
import { computeAddressContentDigest } from './digest.js';
import { AddressValidationError } from './errors.js';
import type { AddressBook } from './address-book.js';
import type { LocationPermissionMachine } from './location.js';
import type { DeliverySlotSelector } from './slots.js';
import type {
  AddressRecord,
  ApplyLocationFixInput,
  DeliveryPlanBindResult,
  DeliverySlotPort,
  LocatedAddressOutcome,
  LocationFix,
  LocationFixPort,
  LocationPermissionPort,
  LocationPermissionState,
  LocateAndBindResult,
  LocateStatus,
} from './types.js';

/** 定位地址的缺省展示标签。 */
export const LOCATED_ADDRESS_DEFAULT_LABEL = '当前位置';

/** 指纹前缀 `av1-` 的长度，用来从指纹里取确定性 id。 */
const DIGEST_PREFIX = 'av1-';

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AddressValidationError(`${label} 不能为空`);
  }
  return value;
}

function requireCoordinate(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AddressValidationError(`${label} 必须是 [${min}, ${max}] 内的有限数，收到 ${String(value)}`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把一次定位固化进地址簿。
 *
 * 规则：
 * - 内容指纹由「标签 + 联系人 + 手机号 + 区划 + 详址 + 坐标 + `located`」导出；`provider`
 *   不入指纹（换提供方不误伤版本）。
 * - 若地址簿里已有**同内容**的定位地址 ⇒ 复用（`reused: true`，不新增、不推进版本）。
 * - 否则新增一条 `source: 'located'` 的地址（v1），id 缺省为 `loc-<指纹>`；显式传入的
 *   `addressId` 与已有条目冲突（内容不同）⇒ 显式抛错，不覆盖。
 */
export function applyLocationFix(book: AddressBook, input: ApplyLocationFixInput): LocatedAddressOutcome {
  const fix = input.fix;
  const region = requireText(fix.region, 'fix.region');
  const detail = requireText(fix.detail, 'fix.detail');
  const lat = requireCoordinate(fix.lat, 'fix.lat', -90, 90);
  const lng = requireCoordinate(fix.lng, 'fix.lng', -180, 180);
  const contactName = requireText(input.contactName, 'contactName');
  const phone = requireText(input.phone, 'phone');
  const label = input.label === undefined ? LOCATED_ADDRESS_DEFAULT_LABEL : requireText(input.label, 'label');

  const digest = computeAddressContentDigest({
    label,
    contactName,
    phone,
    region,
    detail,
    lat,
    lng,
    source: 'located',
  });

  const existing = book.list().find((record) => record.contentDigest === digest);
  if (existing !== undefined) {
    return Object.freeze({
      addressId: existing.addressId,
      ref: existing.ref,
      version: existing.version,
      reused: true,
      record: existing,
    });
  }

  const addressId = input.addressId ?? `loc-${digest.slice(DIGEST_PREFIX.length)}`;
  if (book.get(addressId) !== undefined) {
    throw new AddressValidationError(
      `定位地址 id ${addressId} 已存在但内容不同（指纹冲突或重复 id）；拒绝覆盖`,
    );
  }

  const record: AddressRecord = book.add({
    addressId,
    label,
    contactName,
    phone,
    region,
    detail,
    lat,
    lng,
    source: 'located',
  });

  return Object.freeze({
    addressId: record.addressId,
    ref: record.ref,
    version: record.version,
    reused: false,
    record,
  });
}

/** 「定位并绑定」编排的入参。 */
export interface LocateAndBindInput {
  readonly book: AddressBook;
  readonly machine: LocationPermissionMachine;
  readonly permissionPort: LocationPermissionPort;
  readonly fixPort: LocationFixPort;
  readonly contactName: string;
  readonly phone: string;
  readonly label?: string;
  readonly addressId?: string;
}

function reject(status: LocateStatus, permission: LocationPermissionState, detail: string): LocateAndBindResult {
  return Object.freeze({
    status,
    permission,
    addressId: null,
    addressRef: null,
    requiresExplicitSelection: true,
    reused: false,
    detail,
  });
}

/**
 * 编排一次「请求权限（仅未授权时）→ 读取定位 → 落进地址簿」。
 *
 * - 已授权：**不再**调 `permissionPort`（状态机也不允许重复请求），直接定位。
 * - 未授权 / 被拒 / 撤销：先 `machine.request(permissionPort)`；仍非 `authorized`
 *   ⇒ `permission_denied`，**不调 `fixPort`、不产生地址**。
 * - 授权后 `fixPort.locate()` 抛错 ⇒ `location_failed`，同样不产生地址。
 * - 成功 ⇒ `located`，返回绑定版本的 `addressRef`（可直接喂给 M04 配送参数）。
 *
 * 三条失败分支的 `addressId` / `addressRef` 都是 `null`：**绝不静默替换地址**。
 */
export async function locateAndBind(input: LocateAndBindInput): Promise<LocateAndBindResult> {
  const { machine } = input;

  if (!machine.isAuthorized) {
    try {
      await machine.request(input.permissionPort);
    } catch (error) {
      return reject(
        'location_failed',
        machine.state,
        `请求定位授权失败：${messageOf(error)}；不自动替换地址，请显式选择`,
      );
    }
  }

  if (machine.state !== 'authorized') {
    return reject(
      'permission_denied',
      machine.state,
      '定位权限未授权（被拒/撤销）；不产生地址、不替换默认地址，请显式选择',
    );
  }

  let fix: LocationFix;
  try {
    fix = await input.fixPort.locate();
  } catch (error) {
    return reject(
      'location_failed',
      machine.state,
      `读取定位失败：${messageOf(error)}；不自动替换地址，请显式选择`,
    );
  }

  const outcome = applyLocationFix(input.book, {
    fix,
    contactName: input.contactName,
    phone: input.phone,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.addressId === undefined ? {} : { addressId: input.addressId }),
  });

  return Object.freeze({
    status: 'located',
    permission: machine.state,
    addressId: outcome.addressId,
    addressRef: outcome.ref,
    requiresExplicitSelection: false,
    reused: outcome.reused,
    detail: outcome.reused
      ? '定位命中地址簿中同内容的定位地址（未新增、未推进版本）'
      : '定位已产生新地址并绑定版本',
  });
}

/** 「（按需请求权限）→ 定位落簿 → 载时段 → 选时段 → 单一方案」的编排入参。 */
export interface LocateAndPlanInput {
  readonly book: AddressBook;
  readonly machine: LocationPermissionMachine;
  readonly permissionPort: LocationPermissionPort;
  readonly fixPort: LocationFixPort;
  readonly slotPort: DeliverySlotPort;
  readonly slotSelector: DeliverySlotSelector;
  readonly merchantId: string;
  /** 注入时钟的当前时刻（用于过期判定，不读系统时间）。 */
  readonly now: number;
  readonly contactName: string;
  readonly phone: string;
  readonly label?: string;
  readonly addressId?: string;
  /** 用户**显式**选择的时段 id；缺省 ⇒ `no_slot`（本编排**不自动挑**时段）。 */
  readonly slotId?: string | null;
}

function unboundPlan(
  status: DeliveryPlanBindResult['status'],
  permission: LocationPermissionState,
  addressRef: string | null,
  requiresExplicitSelection: boolean,
  detail: string,
): DeliveryPlanBindResult {
  return Object.freeze({
    status,
    plan: null,
    planRef: null,
    addressRef,
    permission,
    requiresExplicitSelection,
    check: null,
    detail,
  });
}

/**
 * 一次编排「地址 + 时段」成**单一**配送方案 `planRef`。
 *
 * - 先做 `locateAndBind`；被拒 / 定位失败 ⇒ 直接返回未绑定态（`plan` / `planRef` /
 *   `addressRef` 恒 `null`、`requiresExplicitSelection: true`），**不新增地址、不替换
 *   默认地址、不在未授权时定位**——完整保留 `locateAndBind` 语义。
 * - 定位成功但**未给** `slotId` ⇒ `no_slot`（地址已绑定，但本编排不自动挑时段）。
 * - 定位成功且给了 `slotId` ⇒ 载时段、显式选择（未知/不可用即抛错）、生成方案并校验。
 *
 * 本编排不接真实平台、不请求系统权限、不读系统时间：权限结果与位置来自注入端口。
 */
export async function locateAndPlan(input: LocateAndPlanInput): Promise<DeliveryPlanBindResult> {
  const located = await locateAndBind({
    book: input.book,
    machine: input.machine,
    permissionPort: input.permissionPort,
    fixPort: input.fixPort,
    contactName: input.contactName,
    phone: input.phone,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.addressId === undefined ? {} : { addressId: input.addressId }),
  });

  if (located.status !== 'located' || located.addressRef === null || located.addressId === null) {
    return unboundPlan(
      located.status === 'located' ? 'location_failed' : located.status,
      located.permission,
      null,
      true,
      `${located.detail}；未生成配送方案，不替换默认地址`,
    );
  }

  const addressRef = located.addressRef;
  const slotId = input.slotId ?? null;
  if (slotId === null) {
    return unboundPlan(
      'no_slot',
      located.permission,
      addressRef,
      false,
      '定位地址已绑定；尚未选择配送时段，需用户显式选择时段后再生成方案',
    );
  }

  await input.slotSelector.load(input.slotPort, {
    merchantId: input.merchantId,
    addressRef,
    now: input.now,
  });
  const slot = input.slotSelector.select(slotId);
  const plan = createDeliveryPlanFromSlot(input.book.require(located.addressId), slot);
  const check = checkDeliveryPlan(plan, {
    book: input.book,
    now: input.now,
    currentSlotId: input.slotSelector.selectedSlotId,
    slots: input.slotSelector.slots,
  });

  return Object.freeze({
    status: 'bound',
    plan,
    planRef: plan.planRef,
    addressRef,
    permission: located.permission,
    requiresExplicitSelection: false,
    check,
    detail: check.usable ? '配送方案已绑定地址、时段与过期点' : `方案已生成但校验未通过：${check.detail}`,
  });
}
