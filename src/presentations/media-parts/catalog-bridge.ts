/**
 * P-I07 · **媒体来源收敛**：把"路径唯一"的媒体目录（`media.ts` 的 `MediaCatalog`）并入
 * "内容唯一"的字节去重登记表（本模块 `registry.ts` 的 `MediaRegistry`）。
 *
 * ## 为什么需要这一层
 *
 * 本仓里有**两条**登记媒体的路径，各自都自称"唯一来源"：
 * - `media.ts` 的 `MediaCatalog` —— 按**包内路径**去重（`ppt/media/imageN.png` 各一份），
 *   `render.ts` / `insertPicture` / `av-package.ts` 走这条；
 * - 本模块 `registry.ts` 的 `MediaRegistry` —— 按**内容（内容类型 + 字节）**去重，
 *   同字节的多个来源名归并到一个部件，`planSlideMediaRelationships` 走这条。
 *
 * 两者并存时，同一份字节可能被登记成两份部件（包体虚增），或同一路径被两条命名规则
 * 指向不同部件（引用对不上）。本层把 `MediaCatalog` 变成 `MediaRegistry` 的**输入**
 * （而不是另起一套），读取侧只做结构适配，不改 `media.ts`、不运行期 import 它。
 *
 * ## "消费任一来源"如何做到
 *
 * `MediaCatalogSource` 是**结构化**接口（`parts: { path, bytes }[]`），因此：
 * - `media.ts` 的 `MediaCatalog` 天然满足（`PresentationMediaPart` 有 `path` + `bytes`）；
 * - 本模块的 `MediaRegistry` 也天然满足（`MediaPartEntry` 有 `path` + `bytes`）。
 *
 * 于是同一条 `registerCatalogSource` 既能吃外部目录、也能吃本模块登记表；`MediaSource[]`
 * （`name` + `bytes`）则由既有的 `registerMediaSources` 覆盖。两条来源都收敛到**同一张**
 * 内容寻址登记表，去重口径唯一。
 *
 * ## 未验证 / 边界
 *
 * - 只做结构适配与逐份登记，不做字节解码 / 魔数嗅探（与 `registry.ts` 同口径）；
 * - `path_map` 是**目录路径 → 登记表部件路径**的单向映射；同内容多路径都指向同一部件；
 * - 真机 PowerPoint / WPS 打开未验证。
 */

import {
  EMPTY_MEDIA_REGISTRY,
  registerMedia,
  type MediaRegistration,
  type MediaRegistry,
  type MediaSource,
} from './registry.js';

// ---------------------------------------------------------------------------
// 结构化输入
// ---------------------------------------------------------------------------

/** 目录里的一份媒体：包内路径 + 字节（`media.ts` 的 `PresentationMediaPart` 结构）。 */
export interface MediaCatalogSourcePart {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * 媒体目录的**结构化**形态：任何以 `path` + `bytes` 列出部件的对象都满足——
 * `media.ts` 的 `MediaCatalog`、本模块的 `MediaRegistry`、或测试里的手造目录。
 */
export interface MediaCatalogSource {
  readonly parts: readonly MediaCatalogSourcePart[];
}

/** 目录并入登记表的结果。 */
export interface CatalogBridgeResult {
  /** 收敛后的内容寻址登记表。 */
  readonly registry: MediaRegistry;
  /**
   * 目录路径 → 登记表部件路径。同字节的多个目录路径都映射到**同一个**部件路径
   * （这正是"两张相同图片合成一份部件"的可见证据）。
   */
  readonly path_map: ReadonlyMap<string, string>;
  /** 逐份登记结果（`created=false` 表示命中了既有内容的去重）。 */
  readonly registrations: readonly MediaRegistration[];
}

// ---------------------------------------------------------------------------
// 目录 → 登记表
// ---------------------------------------------------------------------------

/**
 * 把已有登记表与一份媒体目录合并：逐份走 `registerMedia`（内容寻址去重），返回新表 + 路径映射。
 *
 * 同 `(内容类型, 字节)` 的目录条目**不新建部件**，只把目录路径并入部件的来源名；
 * 内容类型不同（同字节不同扩展名）或字节不同 ⇒ 新建（一个部件只能有一个扩展名默认项）。
 *
 * @throws {MediaPartsError} 目录条目无扩展名 / 名称为空 / 字节为空 / 字节类型错误（不登记半成品）。
 */
export function registerCatalogSource(
  registry: MediaRegistry,
  catalog: MediaCatalogSource,
): CatalogBridgeResult {
  let current = registry;
  const pathMap = new Map<string, string>();
  const registrations: MediaRegistration[] = [];
  for (const part of catalog.parts) {
    const registration = registerMedia(current, { name: part.path, bytes: part.bytes });
    current = registration.registry;
    registrations.push(registration);
    pathMap.set(part.path, registration.part.path);
  }
  return {
    registry: current,
    path_map: pathMap,
    registrations: Object.freeze(registrations),
  };
}

/** 从空表起步，把一份媒体目录收敛成内容寻址登记表。 */
export function mediaRegistryFromCatalog(catalog: MediaCatalogSource): CatalogBridgeResult {
  return registerCatalogSource(EMPTY_MEDIA_REGISTRY, catalog);
}

/**
 * 从 `MediaSource[]`（`name` + `bytes`）收敛：与 `registerMediaSources` 同族，但额外返回
 * **来源名 → 部件路径**映射与逐份登记结果，便于与目录来源做同一口径的收敛。
 */
export function registerSourceList(
  registry: MediaRegistry,
  sources: readonly MediaSource[],
): CatalogBridgeResult {
  let current = registry;
  const pathMap = new Map<string, string>();
  const registrations: MediaRegistration[] = [];
  for (const source of sources) {
    const registration = registerMedia(current, source);
    current = registration.registry;
    registrations.push(registration);
    pathMap.set(source.name, registration.part.path);
  }
  return {
    registry: current,
    path_map: pathMap,
    registrations: Object.freeze(registrations),
  };
}
