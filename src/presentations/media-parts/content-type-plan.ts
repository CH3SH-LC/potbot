/**
 * P-I07 · **媒体内容类型的 Default-only 决策**（与 `render.ts` 口径一致）。
 *
 * ## 决策
 *
 * 媒体部件（`ppt/media/**`）的内容类型由**扩展名默认项**（`[Content_Types].xml` 的
 * `<Default Extension="png" ContentType="image/png"/>`）承担，**不再**为每个媒体部件单独写
 * `<Override>`。理由是同一扩展名的媒体部件内容类型恒等式，逐部件 Override 是冗余；`render.ts`
 * 已按扩展名为媒体登记 Default（见其媒体装配段）。本层把这**一条决策**做成可复用的计划与审计，
 * 供 P-I01 渲染/整装路径使用，并**抓出**任何违反它的媒体 Override。
 *
 * ## 与 `render.ts` 现状的关系（如实记录，不在本包修）
 *
 * 现存 `src/artifacts/ooxml/opc.ts` 会为**每个业务部件**自动写一条 `Override`（含媒体部件），
 * 于是当前产物里媒体同时有 Default 与 Override（P-R04 独立验证已记录此现象）。本层只**表达
 * 并检测**Default-only 决策（`forbidden_overrides` 对任何媒体 Override 报出），不改 `opc.ts`
 * ——那是渲染管线所有者的写区。
 *
 * ## 未验证 / 边界
 *
 * - Default-only 是**媒体**范围的决策；非媒体部件（slide / theme / 图表…）仍按其自身口径；
 * - 不做魔数嗅探：内容类型只由扩展名决定，与 `MEDIA_CONTENT_TYPES` 同表；
 * - 真机 PowerPoint / WPS 打开未验证。
 */

import { MEDIA_CONTENT_TYPES, mediaExtensionOf, type MediaRegistry } from './registry.js';
import { isMediaPackagePath } from './relationships.js';

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

/** 一条扩展名默认项。 */
export interface MediaContentTypeDefault {
  readonly extension: string;
  readonly content_type: string;
}

/**
 * 按登记顺序给出媒体部件所需的扩展名 Default 项（同一扩展名只一条）。
 *
 * 内容类型取自部件已登记的 `content_type`（登记时已由扩展名推出），故本函数与
 * `registry.ts` 的扩展名表**必然一致**（分叉由 `auditMediaContentTypes` 的 `mismatches` 抓）。
 */
export function mediaContentTypeDefaults(registry: MediaRegistry): readonly MediaContentTypeDefault[] {
  const seen = new Set<string>();
  const defaults: MediaContentTypeDefault[] = [];
  for (const part of registry.parts) {
    const extension = mediaExtensionOf(part.path);
    if (seen.has(extension)) continue;
    seen.add(extension);
    defaults.push({ extension, content_type: part.content_type });
  }
  return Object.freeze(defaults);
}

/** 每个需要 Default 的扩展名。 */
export function mediaDefaultExtensions(registry: MediaRegistry): readonly string[] {
  return Object.freeze(mediaContentTypeDefaults(registry).map((entry) => entry.extension));
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/** 登记表里"内容类型与扩展名默认项不符"的部件。 */
export interface MediaContentTypeMismatch {
  readonly path: string;
  readonly declared: string;
  readonly expected: string;
}

/** 内容类型一致性审计报告。 */
export interface MediaContentTypeAudit {
  /** 应写入的扩展名 Default 项。 */
  readonly defaults: readonly MediaContentTypeDefault[];
  /** 违反 Default-only 决策的媒体 Override（`PartName`，已去前导斜杠）——应为空。 */
  readonly forbidden_overrides: readonly string[];
  /** 部件声明的 `content_type` 与扩展名应得值不符 —— 应为空。 */
  readonly mismatches: readonly MediaContentTypeMismatch[];
  /** `true` ⇔ 无违规 Override 且无内容类型不符。 */
  readonly ok: boolean;
}

function normalizePartName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/**
 * 审计 Default-only 一致性。
 *
 * @param overridePartNames `[Content_Types].xml` 里**已写**的 `Override` 的 `PartName`
 *   集合（可带前导 `/`）；其中属 `ppt/media/**` 者被报为 `forbidden_overrides`。
 */
export function auditMediaContentTypes(
  registry: MediaRegistry,
  overridePartNames: readonly string[] = [],
): MediaContentTypeAudit {
  const defaults = mediaContentTypeDefaults(registry);

  const forbidden: string[] = [];
  for (const name of overridePartNames) {
    const normalized = normalizePartName(name);
    if (isMediaPackagePath(normalized)) forbidden.push(normalized);
  }

  const mismatches: MediaContentTypeMismatch[] = [];
  for (const part of registry.parts) {
    const expected = MEDIA_CONTENT_TYPES[mediaExtensionOf(part.path)];
    if (expected !== undefined && expected !== part.content_type) {
      mismatches.push({ path: part.path, declared: part.content_type, expected });
    }
  }

  return Object.freeze({
    defaults,
    forbidden_overrides: Object.freeze(forbidden),
    mismatches: Object.freeze(mismatches),
    ok: forbidden.length === 0 && mismatches.length === 0,
  });
}
