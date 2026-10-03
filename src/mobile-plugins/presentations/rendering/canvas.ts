/**
 * **软件光栅画布**：一块 RGB 像素缓冲 + 一小组绘制原语。
 *
 * 不做字形整形、不做抗锯齿以外的花活；只保证：
 * - 每一个写入都**真的落到像素**（可用 `getPixel` 复核）；
 * - 越界写入被**裁剪**（不越界踩坏别的行）；
 * - 后画的对象盖住先画的（数组顺序 = z 序的落点）。
 *
 * 缓冲是不透明 RGB（幻灯片有背景色），alpha 只在**合成时**参与（见 `color.blendOver`）。
 */

import { blendOver, parseColor, type Rgb } from './color.js';

/** 一个已解码的位图（用于 `blit`）：行优先，`channels` 为 3（RGB）或 4（RGBA）。 */
export interface SourceImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  /** 行优先字节，长度 = `width × height × channels`。 */
  readonly data: Uint8Array;
}

export class RasterCanvas {
  readonly width: number;
  readonly height: number;
  /** 行优先 RGB，长度 = `width × height × 3`。 */
  readonly pixels: Uint8Array;
  /**
   * 「曾被绘制写入」掩码（1 = 写过，0 = 未写）。构造时的底色填充**不**置位——
   * 这样旋转合成时能区分「这一像素真的被画过」与「只是底色」，从而把旋转后
   * 矩形四角的空白留给底下已画的内容（而不是整块底色盖上去）。
   */
  readonly writtenMask: Uint8Array;

  constructor(width: number, height: number, background: Rgb) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`画布尺寸非法：${String(width)}×${String(height)}`);
    }
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.writtenMask = new Uint8Array(width * height);
    // 底色只填像素、**不**标记为「写过」（见 writtenMask 说明）。
    this.fillBackground(background);
  }

  /** 整块填成一个颜色（标记为「写过」）。 */
  fillAll(color: Rgb): void {
    this.fillBackground(color);
    this.writtenMask.fill(1);
  }

  /** 只写像素、不改掩码（构造底色的内部路径）。 */
  private fillBackground(color: Rgb): void {
    for (let i = 0; i < this.width * this.height; i += 1) {
      const at = i * 3;
      this.pixels[at] = color.r;
      this.pixels[at + 1] = color.g;
      this.pixels[at + 2] = color.b;
    }
  }

  /** 该像素是否被某次绘制真正写过（构造底色不算）。 */
  wasWritten(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.writtenMask[y * this.width + x] === 1;
  }

  /** 读一个像素；越界返回 `null`（不抛、不猜）。 */
  getPixel(x: number, y: number): Rgb | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const at = (y * this.width + x) * 3;
    return { r: this.pixels[at] ?? 0, g: this.pixels[at + 1] ?? 0, b: this.pixels[at + 2] ?? 0 };
  }

  /** 写一个像素（与 `color` 按 `alpha` 合成）；越界忽略。 */
  setPixel(x: number, y: number, color: Rgb, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (alpha <= 0) return;
    const at = (y * this.width + x) * 3;
    const dst: Rgb = { r: this.pixels[at] ?? 0, g: this.pixels[at + 1] ?? 0, b: this.pixels[at + 2] ?? 0 };
    const out = blendOver(dst, color, alpha);
    this.pixels[at] = out.r;
    this.pixels[at + 1] = out.g;
    this.pixels[at + 2] = out.b;
    this.writtenMask[y * this.width + x] = 1;
  }

  /** 实心矩形（像素坐标，含边界裁剪）。 */
  fillRect(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.setPixel(px, py, color, alpha);
    }
  }

  /** 矩形描边（内缩 `thickness` 像素的边框）。 */
  strokeRect(x: number, y: number, w: number, h: number, color: Rgb, thickness = 1): void {
    const t = Math.max(1, Math.round(thickness));
    this.fillRect(x, y, w, t, color);
    this.fillRect(x, y + h - t, w, t, color);
    this.fillRect(x, y, t, h, color);
    this.fillRect(x + w - t, y, t, h, color);
  }

  /** 实心椭圆（外接矩形给定）。 */
  fillEllipse(cx: number, cy: number, rx: number, ry: number, color: Rgb): void {
    if (rx <= 0 || ry <= 0) return;
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(this.height, Math.ceil(cy + ry));
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(this.width, Math.ceil(cx + rx));
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    for (let py = y0; py < y1; py += 1) {
      const dy = py + 0.5 - cy;
      for (let px = x0; px < x1; px += 1) {
        const dx = px + 0.5 - cx;
        if ((dx * dx) / rx2 + (dy * dy) / ry2 <= 1) this.setPixel(px, py, color);
      }
    }
  }

  /** 一条有粗细的线段（Bresenham + 圆头）。 */
  drawLine(x0: number, y0: number, x1: number, y1: number, color: Rgb, thickness = 1): void {
    const radius = Math.max(0.5, thickness / 2);
    let x = Math.round(x0);
    let y = Math.round(y0);
    const ex = Math.round(x1);
    const ey = Math.round(y1);
    const dx = Math.abs(ex - x);
    const dy = Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      if (radius <= 1) {
        this.setPixel(x, y, color);
      } else {
        this.fillEllipse(x, y, radius, radius, color);
      }
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /**
   * 把一张已解码位图**最近邻**缩放着画到目标矩形。源带 alpha 时按 alpha 合成。
   * 目标矩形越界部分被裁剪。
   */
  blit(image: SourceImage, destX: number, destY: number, destW: number, destH: number): void {
    if (destW <= 0 || destH <= 0) return;
    const x0 = Math.max(0, Math.floor(destX));
    const y0 = Math.max(0, Math.floor(destY));
    const x1 = Math.min(this.width, Math.ceil(destX + destW));
    const y1 = Math.min(this.height, Math.ceil(destY + destH));
    const sx = image.width / destW;
    const sy = image.height / destH;
    for (let py = y0; py < y1; py += 1) {
      const srcY = Math.min(image.height - 1, Math.max(0, Math.floor((py + 0.5 - destY) * sy)));
      for (let px = x0; px < x1; px += 1) {
        const srcX = Math.min(image.width - 1, Math.max(0, Math.floor((px + 0.5 - destX) * sx)));
        const at = (srcY * image.width + srcX) * image.channels;
        const r = image.data[at] ?? 0;
        const g = image.data[at + 1] ?? 0;
        const b = image.data[at + 2] ?? 0;
        const a = image.channels === 4 ? (image.data[at + 3] ?? 255) / 255 : 1;
        this.setPixel(px, py, { r, g, b }, a);
      }
    }
  }

  /** 用透明度绘制覆盖度字形（`coverage` 0..255 近似 alpha）。 */
  drawCoverage(
    coverage: Uint8Array,
    gw: number,
    gh: number,
    destX: number,
    destY: number,
    color: Rgb,
  ): void {
    for (let row = 0; row < gh; row += 1) {
      for (let col = 0; col < gw; col += 1) {
        const cov = coverage[row * gw + col] ?? 0;
        if (cov === 0) continue;
        this.setPixel(destX + col, destY + row, color, cov / 255);
      }
    }
  }

  /** 与某个背景色不同的像素数（"真画了东西"的证据量化）。 */
  countNonBackground(background: Rgb): number {
    let count = 0;
    for (let i = 0; i < this.width * this.height; i += 1) {
      const at = i * 3;
      if (
        (this.pixels[at] ?? 0) !== background.r ||
        (this.pixels[at + 1] ?? 0) !== background.g ||
        (this.pixels[at + 2] ?? 0) !== background.b
      ) {
        count += 1;
      }
    }
    return count;
  }

  /** 导出为 RGB 位图视图（供 PNG 编码）。 */
  toRgbImage(): SourceImage {
    return { width: this.width, height: this.height, channels: 3, data: this.pixels };
  }
}

/** 便捷：从 `RRGGBB` 字符串造 RGB。 */
export function color(hex: string): Rgb {
  return parseColor(hex);
}
