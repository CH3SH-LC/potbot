/**
 * K10 脱敏扫描器 —— **诊断与通知文本的唯一出口判据**（零依赖、纯函数）。
 *
 * ## 为什么诊断链路需要自己的判据
 *
 * 后台任务会把"任务标题 / 失败原因 / 网络状态"写进通知与诊断日志。这些字段的**来源不可信**
 * （模型生成的标题、上游错误的 message、用户输入的任务名），而后台日志恰恰是最容易被
 * `adb logcat`、崩溃报告或分享按钮整体带走的东西。因此本模块的纪律是：
 *
 * - **结构上只有白名单字段**（见 `diagnostics.ts` 的 `DIAGNOSTIC_FIELDS`），没有"原样透传对象"的口子；
 * - **内容上再过一次明文密钥扫描**，命中即拒——不是"脱敏后写入"，而是**根本不写入**。
 *
 * ## 与 K02 `apps/mobile-kernel/model/redact.ts` 的关系（刻意重复，待裁决）
 *
 * K02 的模型调用记录扫描器有同一组模式。本包**不 import 它**，原因是两条写权分属不同包，
 * 跨包 import 会让本包证据的成败取决于另一个正在并行改写的文件。因此此处**自持**一份模式表
 * （内容与 K02 一致），并在集成请求里登记"上提到共享脱敏模块"的合并项。见同目录 README。
 *
 * ## 精度取舍
 *
 * 模式刻意**高精度、低召回**：只认各家密钥的显著字面特征。泛化规则（"凡长字符串皆密钥"）
 * 会在本仓库大量误报（`sha256:<64 hex>` 摘要、`content://` URI、base64 文档片段），
 * 一旦误报频繁就会被绕过，最终等于没有判据。
 */

/** 明文密钥的显著特征（与 K02 同名同内容，见文件头关于刻意重复的说明）。 */
export const PLAINTEXT_SECRET_PATTERNS: readonly RegExp[] = [
  // **必须带左边界**：(?<![A-Za-z0-9_])。否则 `sk-` 会命中普通单词内部——
  // 本仓库的诊断码字面量 `task-registered`（含 `sk-registered`）就是被这条误伤的例子。
  // 误报会把"命中即拒"退化成"频繁拒绝正常事件"，判据最终被绕过。
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * 返回值里**第一处**命中的明文密钥特征（没有则为 `null`）。
 *
 * 先 `JSON.stringify` 再扫，因此嵌套对象/数组/字符串都被覆盖。循环引用会让
 * `JSON.stringify` 抛 `TypeError`——那是调用方的输入问题，本模块**不吞掉**。
 */
export function findPlaintextSecret(value: unknown): string | null {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  for (const pattern of PLAINTEXT_SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return match[0];
    }
  }
  return null;
}

/** 布尔视图（供守卫与测试使用）。 */
export function containsPlaintextSecret(value: unknown): boolean {
  return findPlaintextSecret(value) !== null;
}

/**
 * 命中即抛。**错误信息里不回显命中的原文**——否则日志本身成了新的泄漏点。
 *
 * `Error` 而非本包自定义错误：`redact.ts` 是零依赖的最底层，不引入错误词表依赖；
 * 上层（`diagnostics.ts` / `lifecycle/foreground-service.ts`）捕获后转成自己的错误码。
 */
export function assertNoPlaintextSecret(value: unknown, what: string): void {
  if (findPlaintextSecret(value) !== null) {
    throw new Error(`${what} 命中明文密钥特征（原文已隐去，不落盘）`);
  }
}
