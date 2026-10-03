/**
 * **字体解析**：把「请求的字体族」解析成「实际可用于度量的字体族」，并**显式记录替代**。
 *
 * 纪律（任务硬要求）：
 *
 * - 请求的字体在端口上**不可度量**时，**绝不静默换字体**：
 *   要么由 `substituteFont` 策略给出一个**端口确认存在**的替代（发 `font_substituted`），
 *   要么抛 `LayoutError('font_missing')` 整体失败。
 * - 诊断**按请求字体族去重**（同一缺失字体只报一次），避免长文里刷屏。
 */

import { LayoutError } from './errors.js';
import type { FontMetricsPort, LayoutDiagnostic } from './types.js';

export interface FontResolution {
  /** 实际使用的字体族（已替代则为替代名）。 */
  family: string;
  /** 是否发生了替代。 */
  substituted: boolean;
}

export class FontResolver {
  private readonly reported = new Set<string>();
  private readonly port: FontMetricsPort;
  private readonly substitute: ((requested: string) => string | null) | undefined;
  private readonly diagnostics: LayoutDiagnostic[];

  // 字段显式声明 + 构造函数内赋值：**不使用 TS 参数属性**
  // （`constructor(private readonly x)` 会让 `node --experimental-strip-types`
  // 抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；本仓 Node 侧 CLI 要能裸跑本模块）。
  constructor(
    port: FontMetricsPort,
    substitute: ((requested: string) => string | null) | undefined,
    diagnostics: LayoutDiagnostic[],
  ) {
    this.port = port;
    this.substitute = substitute;
    this.diagnostics = diagnostics;
  }

  resolve(requested: string): FontResolution {
    if (this.port.hasFont(requested)) {
      return { family: requested, substituted: false };
    }
    const candidate = this.substitute ? this.substitute(requested) : null;
    if (candidate !== null && candidate !== requested && this.port.hasFont(candidate)) {
      if (!this.reported.has(requested)) {
        this.reported.add(requested);
        this.diagnostics.push({
          code: 'font_substituted',
          severity: 'warning',
          message: `字体「${requested}」不可度量，显式替代为「${candidate}」`,
          requestedFont: requested,
          substitutedFont: candidate,
        });
      }
      return { family: candidate, substituted: true };
    }
    // 无可用替代 ⇒ 失败（不静默换字体）。
    throw new LayoutError('font_missing', { requestedFont: requested });
  }
}
