/**
 * M05 地址与配送视图模型 —— 类型定义（零依赖、纯数据）。
 *
 * ## 本包边界（美团线工作书 MEITUAN.md / M05）
 *
 * 「地址/联系人、定位授权、配送时间」：
 * - 收货地址簿（增删改、设默认）；
 * - 地址版本：地址一旦被修改，绑定它的报价/确认必须**可判定失效**；
 * - 配送时间段选择；
 * - 定位授权状态机：未授权 / 已授权 / 被拒 / 撤销。
 *
 * 美团**真实平台能力尚未核实**（未登录、无 token、无工具清单）。本包
 * **不接任何真实接口、不下单、不支付、不发起真实定位**；定位与时段都来自
 * 注入端口（fixture 可独立驱动）。
 *
 * ## 三条结构性纪律（写在类型里，不靠约定）
 *
 * 1. **版本进入引用**：`AddressRecord.ref = "<addressId>#v<version>"`。任何一次
 *    实质修改都会让 `ref` 变，而 M04 的 `paramsDigest` 覆盖 `delivery.addressRef`
 *    ⇒ 旧报价/确认**必然**对不上（见 `./binding.ts` 与 `./bridge.ts`）。
 * 2. **权限被拒不换地址**：`DeliveryResolution` 在未授权/被拒/撤销时**只会**
 *    返回 `needs_explicit_selection`，绝不回退到默认地址或定位地址（见
 *    `./view-model.ts` 的解析优先级）。
 * 3. **敏感字段只走必要端口**：视图（`AddressView`）里没有手机号明文、没有
 *    联系人全名；完整字段只能通过 `DeliveryDetailPort` 在声明用途下取出。
 */

/** 地址来源：手工填写 / 定位产生。 */
export type AddressSource = 'manual' | 'located';

/** 定位授权状态（四态，工作书口径）。 */
export type LocationPermissionState = 'unauthorized' | 'authorized' | 'denied' | 'revoked';

/** 定位授权端口返回的结果。 */
export type LocationPermissionResult = 'granted' | 'denied';

/** 地址实体（完整字段，含敏感信息）。**只在地址簿与必要端口内部流转。** */
export interface AddressRecord {
  readonly addressId: string;
  /** 展示标签（如「家」「公司」）。 */
  readonly label: string;
  /** 联系人全名（敏感）。 */
  readonly contactName: string;
  /** 手机号（敏感）。 */
  readonly phone: string;
  /** 行政区划（如「上海市徐汇区」）。 */
  readonly region: string;
  /** 详细地址（街道/门牌）。 */
  readonly detail: string;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly source: AddressSource;
  /** 版本号，从 1 起，每次**实质**修改 +1。 */
  readonly version: number;
  /** 内容指纹（`av1-` 前缀的 FNV-1a 32 位十六进制）；与 `version` 同步变化。 */
  readonly contentDigest: string;
  /** 交给 M04 `setDeliveryAddress` 的引用，含版本：`<addressId>#v<version>`。 */
  readonly ref: string;
}

/** 新增地址的入参。 */
export interface AddressInput {
  readonly addressId: string;
  readonly label: string;
  readonly contactName: string;
  readonly phone: string;
  readonly region: string;
  readonly detail: string;
  readonly lat?: number | null;
  readonly lng?: number | null;
  /** 省略按 `manual` 计。 */
  readonly source?: AddressSource;
}

/** 修改地址的入参（不可改 `addressId` / `source`）。 */
export interface AddressPatch {
  readonly label?: string;
  readonly contactName?: string;
  readonly phone?: string;
  readonly region?: string;
  readonly detail?: string;
  readonly lat?: number | null;
  readonly lng?: number | null;
}

/**
 * 地址绑定：一份报价/确认在生成时钉住的地址状态。
 * 判定「地址版本不符」的唯一判据就是它。
 */
export interface AddressBinding {
  readonly addressRef: string;
  readonly addressId: string;
  readonly version: number;
  readonly contentDigest: string;
}

/** 地址绑定失效原因（顺序固定：address_removed → version_changed → content_changed）。 */
export type AddressStaleReason = 'address_removed' | 'version_changed' | 'content_changed';

/** 地址绑定可用性判定结果。**显式给出原因**，不静默沿用。 */
export interface AddressBindingCheck {
  readonly usable: boolean;
  readonly addressRef: string;
  readonly reasons: readonly AddressStaleReason[];
  readonly detail: string;
}

/** 配送时间段（由注入端口给出，本包不产生任何真实时段）。 */
export interface DeliverySlot {
  readonly slotId: string;
  readonly label: string;
  /** 时段开始（注入时钟域的逻辑时间）。 */
  readonly startAt: number;
  /** 时段结束（注入时钟域的逻辑时间）。 */
  readonly endAt: number;
  /** 是否可选（端口给出的可用性）。 */
  readonly available: boolean;
}

/** 时段失效原因（顺序固定）。 */
export type SlotStaleReason =
  | 'not_loaded'
  | 'address_changed'
  | 'no_selection'
  | 'slot_missing'
  | 'slot_unavailable'
  | 'slot_expired';

/** 时段选择判定结果。 */
export interface SlotSelectionCheck {
  readonly usable: boolean;
  readonly slotId: string | null;
  readonly reasons: readonly SlotStaleReason[];
  readonly detail: string;
}

/** 解析配送视图的入参。 */
export interface DeliveryResolutionInput {
  readonly book: AddressBookView;
  readonly permission: LocationPermissionState;
  /** 用户**显式**点选的地址 id（唯一能绕开权限的路径）。 */
  readonly explicitSelectionAddressId?: string | null;
  /** 授权定位后由定位端口给出的候选地址 id；**未授权时必须被忽略**。 */
  readonly locatedAddressId?: string | null;
}

/** 配送视图状态。 */
export type DeliveryStatus = 'ready' | 'needs_explicit_selection' | 'invalid_selection';

/** 选中来源。**没有 `default_*` 之外的隐式回退**：只有显式选择与授权定位两条自动路径。 */
export type DeliverySelectionSource =
  | 'explicit_user_selection'
  | 'locating_authorized'
  | 'default_authorized'
  | 'none';

/** 地址簿的只读视图（解析器只依赖这个接口，不依赖具体类）。 */
export interface AddressBookView {
  get(addressId: string): AddressRecord | undefined;
  readonly defaultAddressId: string | null;
  readonly defaultAddress: AddressRecord | null;
}

/** 配送视图解析结果。 */
export interface DeliveryResolution {
  readonly status: DeliveryStatus;
  readonly permission: LocationPermissionState;
  readonly selectedAddressId: string | null;
  readonly selectedAddressRef: string | null;
  readonly selectionSource: DeliverySelectionSource;
  /** 是否必须由用户显式选择（未授权/被拒/撤销且无显式选择时为 `true`）。 */
  readonly requiresExplicitSelection: boolean;
  readonly detail: string;
}

/** 脱敏后的地址视图：**不含手机号明文、不含联系人全名**。 */
export interface AddressView {
  readonly addressId: string;
  readonly label: string;
  /** 联系人脱敏名（如「张*」）。 */
  readonly contactMasked: string;
  /** 脱敏手机号（如「138****8000」）。 */
  readonly phoneMasked: string;
  readonly region: string;
  readonly detail: string;
  readonly source: AddressSource;
  readonly ref: string;
  readonly version: number;
  readonly isDefault: boolean;
}

/** 完整配送明细：**唯一**带手机号明文的出口，只允许在声明用途下取用。 */
export interface DeliveryDetail {
  readonly addressRef: string;
  readonly addressId: string;
  readonly version: number;
  readonly contactName: string;
  readonly phone: string;
  readonly region: string;
  readonly detail: string;
  readonly lat: number | null;
  readonly lng: number | null;
  /** 用途声明：仅用于「订单配送参数」这一必要场景。 */
  readonly purpose: 'order_delivery';
}

/** 定位授权端口。真实实现由后续包提供；本包只用 fixture。 */
export interface LocationPermissionPort {
  requestPermission(): Promise<LocationPermissionResult>;
}

/** 配送时段端口。真实实现由后续包提供；本包只用 fixture。 */
export interface DeliverySlotPort {
  listSlots(request: {
    readonly merchantId: string;
    readonly addressRef: string;
    readonly now: number;
  }): Promise<readonly DeliverySlot[]>;
}

/**
 * 定位端口读回的位置原始信息。
 *
 * 本包**不产生**任何真实坐标：`region` / `detail` / `lat` / `lng` 全部由注入端口给出。
 * `provider` 只用于展示与追踪，**不参与**内容指纹（换 provider 不会误伤地址版本）。
 */
export interface LocationFix {
  readonly region: string;
  readonly detail: string;
  readonly lat: number;
  readonly lng: number;
  /** 定位提供方标识（可选，仅展示/追踪，不入指纹）。 */
  readonly provider?: string;
}

/** 定位读取端口。**只有已授权时才应调用**；端口自身不做权限判定（由 `locate.ts` 编排）。 */
export interface LocationFixPort {
  locate(): Promise<LocationFix>;
}

/** 把一次定位固化成地址记录的入参。 */
export interface ApplyLocationFixInput {
  readonly fix: LocationFix;
  /** 联系人（敏感）：落进地址簿，但只在必要端口才以明文出现。 */
  readonly contactName: string;
  /** 手机号（敏感）：同上。 */
  readonly phone: string;
  /** 展示标签；缺省「当前位置」。 */
  readonly label?: string;
  /** 指定地址 id；缺省由内容指纹确定性导出（同内容同 id）。 */
  readonly addressId?: string;
}

/** 把定位落到地址簿的结果。`ref` 含版本，可直接喂给 M04 的配送参数。 */
export interface LocatedAddressOutcome {
  readonly addressId: string;
  readonly ref: string;
  readonly version: number;
  /** `true` = 命中了已有的同内容定位地址（未新增、未推进版本）。 */
  readonly reused: boolean;
  readonly record: AddressRecord;
}

/** 「定位并绑定」的最终状态。 */
export type LocateStatus = 'located' | 'permission_denied' | 'location_failed';

/**
 * 一次「（未授权时）请求权限 → 读取定位 → 落进地址簿」编排的结果。
 *
 * **未就绪时 `addressId` / `addressRef` 恒为 `null`**：被拒 / 失败**不产生任何地址**，
 * 也不回退到默认地址（`requiresExplicitSelection: true`）。
 */
export interface LocateAndBindResult {
  readonly status: LocateStatus;
  readonly permission: LocationPermissionState;
  readonly addressId: string | null;
  readonly addressRef: string | null;
  readonly requiresExplicitSelection: boolean;
  readonly reused: boolean;
  readonly detail: string;
}

/**
 * 配送方案（`DeliveryPlan`）：把「地址引用 + 选中时段 id + 时段过期点」拍成
 * **一个**绑定引用 `planRef`。
 *
 * ## 为什么需要它
 *
 * 此前地址绑定（`AddressBinding`）与时段选择（`SlotSelectionCheck`）是两个独立
 * 对象：改了配送时间**不会**让地址绑定失效，改了地址也**不会**让时段选择失效。
 * `DeliveryPlan` 把三者合成一份指纹——三者**任一**变化 ⇒ `planRef` 必变，旧方案
 * **必然**失效。这正是 M06 确认面要消费的单一引用。
 *
 * `planRef` 是**结构指纹**（`dp1-` 前缀的 FNV-1a 32 位），用于一致性判定，
 * **不是**密码学摘要。
 */
export interface DeliveryPlan {
  /** 三字段的规范指纹引用，`dp1-<fnv1a32>`；任一字段变则变。 */
  readonly planRef: string;
  /** 地址引用 `<addressId>#v<version>`（来自 `AddressRecord.ref`）。 */
  readonly addressRef: string;
  /** 选中时段的 id。 */
  readonly slotId: string;
  /** 选中时段的结束时刻（过期点，注入时钟域；来自 `DeliverySlot.endAt`）。 */
  readonly slotExpiresAt: number;
}

/** 构造配送方案的三要素（`planRef` 由它们导出，不由调用方给）。 */
export interface DeliveryPlanInput {
  readonly addressRef: string;
  readonly slotId: string;
  readonly slotExpiresAt: number;
}

/** 配送方案失效原因（顺序固定：先自洽，再地址，再时段，最后过期）。 */
export type DeliveryPlanStaleReason =
  | 'plan_ref_mismatch'
  | 'address_removed'
  | 'address_changed'
  | 'slot_changed'
  | 'slot_missing'
  | 'slot_unavailable'
  | 'slot_expiry_changed'
  | 'plan_expired';

/** 配送方案可用性判定结果。**显式给出全部原因**，不静默沿用。 */
export interface DeliveryPlanCheck {
  readonly usable: boolean;
  readonly planRef: string;
  readonly reasons: readonly DeliveryPlanStaleReason[];
  readonly detail: string;
}

/** 判定一份配送方案现在还能不能用的入参（当前地址状态 + 当前时段选择 + 注入时钟）。 */
export interface DeliveryPlanCheckInput {
  readonly book: AddressBookView;
  /** 注入时钟的当前时刻（只用于过期判定，不读系统时间）。 */
  readonly now: number;
  /** 当前选中的时段 id（`DeliverySlotSelector.selectedSlotId`）；`null` = 未选择。 */
  readonly currentSlotId: string | null;
  /** 当前可用时段表；未加载传空数组。 */
  readonly slots: readonly DeliverySlot[];
}

/** 「（定位）→ 地址 → 时段 → 单一方案」编排的结果状态。 */
export type DeliveryPlanBindStatus = 'bound' | 'no_slot' | 'permission_denied' | 'location_failed';

/**
 * 「（定位）→ 地址 → 时段 → 单一方案」编排的结果。
 *
 * **未绑定态（被拒 / 定位失败 / 未选时段）`plan` / `planRef` 恒为 `null`**：
 * 被拒或失败**不产生地址、也不替换默认地址**（`requiresExplicitSelection: true`），
 * 完整保留 `locateAndBind` 的语义。
 */
export interface DeliveryPlanBindResult {
  readonly status: DeliveryPlanBindStatus;
  readonly plan: DeliveryPlan | null;
  readonly planRef: string | null;
  /** 已绑定地址时的地址引用；被拒 / 失败时为 `null`。 */
  readonly addressRef: string | null;
  readonly permission: LocationPermissionState;
  /** 是否必须由用户显式选择**地址**（被拒 / 失败时为 `true`）。 */
  readonly requiresExplicitSelection: boolean;
  /** 已生成方案时的可用性判定；未生成时为 `null`。 */
  readonly check: DeliveryPlanCheck | null;
  readonly detail: string;
}
