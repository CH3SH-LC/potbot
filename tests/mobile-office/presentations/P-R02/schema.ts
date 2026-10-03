/**
 * P-R02 · 黄金栅格（golden raster）操作的**输入 / 输出 schema 与校验器**。
 *
 * ## 这一层是什么
 *
 * P-R02 的交付之一是"独立可跑的黄金截图 / 叠层 / 溢出差异"验收宿主。宿主读一份
 * `RasterRequest`（栅格分辨率、设备已装字体、事实快照、页尺寸），产出 `Raster`。
 * 本文件**只**定义接口形状 + **显式的 schema 校验**：非法输入**具名报错**，不静默取默认值
 * （例如分辨率 ≤ 0 不许被当成 1；缺页不许被当成空页）。
 *
 * ## 保真度如实登记（不把栅格说成真截图）
 *
 * 本栅格是**字符网格**（一个字符代表一块像素区域），**不是**位图 PNG，也不是经
 * PowerPoint / WPS 渲染的截图。它只用于**确定性地比较**"字体替代 / 叠层 / 溢出会不会
 * 改变可见结果"。真实像素截图需要消费端渲染器，本批**未实现、未验证**。
 */

import { ValidationError } from '../../../../src/protocol/index.js';

/** 栅格操作输入校验失败原因（具名）。 */
export type RasterSchemaErrorReason =
  | 'invalid_resolution'
  | 'invalid_slide_size'
  | 'invalid_body_size'
  | 'invalid_installed_fonts';

/** schema 校验错误。 */
export class RasterSchemaError extends ValidationError {
  readonly reason: RasterSchemaErrorReason;

  constructor(reason: RasterSchemaErrorReason, message: string) {
    super(message);
    this.name = 'RasterSchemaError';
    this.reason = reason;
  }
}

/** 栅格分辨率：把一页切成 `cols × rows` 个字符格。 */
export interface RasterResolution {
  readonly cols: number;
  readonly rows: number;
}

/** 栅格操作输入。 */
export interface RasterRequest {
  /** 分辨率。默认 `64 × 48`（4:3 页约 1.33 的纵横比）。 */
  readonly resolution?: RasterResolution;
  /** 设备**已装**字体清单（族名或别名）。必填、非空、元素非空串。 */
  readonly installed_fonts: readonly string[];
  /** 未在 run 上指定字号时的正文字号（pt）。默认 18（与 `layout-check.ts` 同）。 */
  readonly default_body_size_pt?: number;
  /** 每页尺寸（EMU）。默认取文稿 `size`。 */
  readonly slide_size?: { readonly cx_emu: number; readonly cy_emu: number };
}

/** 默认分辨率。 */
export const DEFAULT_RESOLUTION: RasterResolution = Object.freeze({ cols: 64, rows: 48 });

/** 默认正文字号（pt）——与 `layout-check.ts` 的 `DEFAULT_BODY_SIZE_PT` 同值。 */
export const DEFAULT_BODY_SIZE_PT = 18;

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 校验 `RasterRequest` 并**补全默认值**，返回规范化后的强类型输入。
 *
 * 非法输入一律抛 {@link RasterSchemaError}（带 `reason`）。
 */
export function validateRasterRequest(
  request: RasterRequest,
  fallbackSlideSize: { readonly cx_emu: number; readonly cy_emu: number },
): {
  readonly resolution: RasterResolution;
  readonly installed_fonts: readonly string[];
  readonly default_body_size_pt: number;
  readonly slide_size: { readonly cx_emu: number; readonly cy_emu: number };
} {
  const resolution = request.resolution ?? DEFAULT_RESOLUTION;
  if (!isPositiveInt(resolution.cols) || !isPositiveInt(resolution.rows)) {
    throw new RasterSchemaError(
      'invalid_resolution',
      `分辨率必须是正整数：收到 cols=${String(resolution.cols)}, rows=${String(resolution.rows)}`,
    );
  }

  const slideSize = request.slide_size ?? fallbackSlideSize;
  if (!isPositiveInt(slideSize.cx_emu) || !isPositiveInt(slideSize.cy_emu)) {
    throw new RasterSchemaError(
      'invalid_slide_size',
      `页尺寸必须是正整数 EMU：收到 cx=${String(slideSize.cx_emu)}, cy=${String(slideSize.cy_emu)}`,
    );
  }

  const bodySize = request.default_body_size_pt ?? DEFAULT_BODY_SIZE_PT;
  if (typeof bodySize !== 'number' || !Number.isFinite(bodySize) || bodySize <= 0) {
    throw new RasterSchemaError('invalid_body_size', `正文字号必须为正数：收到 ${String(bodySize)}`);
  }

  if (request.installed_fonts.length === 0) {
    throw new RasterSchemaError('invalid_installed_fonts', '已装字体清单不能为空');
  }
  if (request.installed_fonts.some((family) => typeof family !== 'string' || family.trim() === '')) {
    throw new RasterSchemaError('invalid_installed_fonts', '已装字体清单含有空串 / 非字符串元素');
  }

  return {
    resolution,
    installed_fonts: [...request.installed_fonts],
    default_body_size_pt: bodySize,
    slide_size: slideSize,
  };
}
