/**
 * 单位换算常量——**全项目唯一来源**（合同 R127/R128）。
 *
 * ## 为什么集中在这里
 *
 * R128 要求"转换集中一处，禁止各模块各自换算"；R131 进一步钉死"**不存在一个数字到处复用**"：
 * 12pt 字号、12 磅段距、12 twips 缩进是三个不同的量。把常量与换算函数收在本包，其他模块只能
 * `import`，不得复写 `20` / `1440` / `240` 这类魔数。
 *
 * ## 常量口径（本项目的约定，测试钉死）
 *
 * - **twips**：OOXML 长度内部单位，1 pt = 20 twips（`TWIPS_PER_POINT`）。R127 明确 twips
 *   **只应出现在转换层**——即只在本包内出现，模型层只暴露 `Length`。
 * - **cm**：采用 Word 约定 **1 cm = 567 twips**。精确值 1440/2.54 = 566.929…；Word 取整到
 *   567，这样 2 cm = 1134 twips 与 Word 自身往返一致。`mm` 走有理数 567/10，避免浮点漂移。
 * - **半点值**：字号在 OOXML 里是**半点**（`w:sz`），12pt → 24（`HALF_POINTS_PER_POINT`）。
 * - **1/100 字**：字符缩进在 OOXML 里是 `w:firstLineChars`，单位 1/100 个字符，
 *   "首行缩进 2 字" → 200（`HUNDREDTHS_PER_CHAR`）。
 * - **240 基准**：自动倍数行距 `w:line` 以 240 表示"单倍"（`AUTO_LINE_UNIT`）——
 *   **这与 twips 是两套刻度**，1.5 倍是 360 而不是 360 twips 的意思。R128 特别强调
 *   "自动倍数与固定/最小行距单位不同，不许混"。
 */

/** OOXML 长度内部单位。1 pt = 20 twips。 */
export const TWIPS_PER_POINT = 20;

/** 1 inch = 1440 twips。 */
export const TWIPS_PER_INCH = 1440;

/** Word 约定：1 cm = 567 twips（1440 / 2.54 ≈ 566.93，取整保证往返稳定）。 */
export const TWIPS_PER_CM = 567;

/** 1 mm = 567 / 10 twips（有理数，按分子分母参与运算避免浮点漂移）。 */
export const TWIPS_PER_MM_NUMERATOR = 567;
export const TWIPS_PER_MM_DENOMINATOR = 10;

/** 字号：1 pt = 2 半点（`w:sz`）。 */
export const HALF_POINTS_PER_POINT = 2;

/** 字符缩进：1 个字符 = 100 个 OOXML 字符单位（`w:firstLineChars`）。 */
export const HUNDREDTHS_PER_CHAR = 100;

/** 自动倍数行距基准：`w:line=240` 表示单倍（`w:lineRule=auto`）。**不是 twips。** */
export const AUTO_LINE_UNIT = 240;

/** 段前/段后按"行"为单位时的基准：`w:beforeLines=100` 表示 1 行。 */
export const HUNDREDTHS_PER_LINE = 100;
