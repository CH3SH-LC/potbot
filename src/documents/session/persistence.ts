/**
 * **会话状态的 JSON 编解码**（WF-083：保存并重新打开）。
 *
 * ## 为什么不能直接 `JSON.stringify(state)`
 *
 * `SessionState.model` 里**有二进制**：`OpaquePart.bytes` 与 `MediaPart.bytes` 是
 * 未改动部件的原始字节（R105/R151 要求逐字节保留）。`JSON.stringify(Uint8Array)`
 * **不报错**——它把字节数组写成 `{"0":31,"1":139,...}` 这种数字键对象。
 * 于是"保存 → 读回"会得到一个**看起来完整、其实已毁**的模型，
 * 而失败发生在很久以后的某次导出上（本实现第 3 次迭代才被 restore 用例抓住）。
 *
 * 因此二进制必须走一条**显式**的编码：`{"$bytes": "<base64>"}`。
 * 标记用 `$` 前缀且只认这一个键的形状——普通对象里出现 `$bytes` 字段的概率极低，
 * 且真出现时也只会在**解码**时被还原成 `Uint8Array`，不会静默丢数据。
 *
 * ## 边界
 *
 * - 编码输出是**纯 JSON 值**（可再经 `JSON.stringify` 落盘）；
 * - 解码对**不认识**的形状原样返回（不抛错）——形状核对归 `DocumentSession.restore`
 *   （它会检查 schema / id / 模型），编解码层只负责字节，不承担语义校验；
 * - 深度上限 64：状态是有限结构，超深只可能是坏输入，返回原值而不是无限递归。
 */

/** 二进制在 JSON 里的标记键。 */
const BYTES_MARKER = '$bytes';

/** 递归深度上限（坏输入保护）。 */
const MAX_DEPTH = 64;

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isBytes(value);
}

/** 编码：`Uint8Array` → `{ $bytes: base64 }`；其余递归。纯函数。 */
export function encodeSessionState(value: unknown): unknown {
  return encode(value, 0);
}

function encode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (isBytes(value)) {
    return { [BYTES_MARKER]: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map((item) => encode(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = encode(item, depth + 1);
    }
    return output;
  }
  return value;
}

/** 解码：`{ $bytes }` → `Uint8Array`；其余递归。**不抛错**（坏形状原样返回）。 */
export function decodeSessionState(value: unknown): unknown {
  return decode(value, 0);
}

function decode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => decode(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const marked = value[BYTES_MARKER];
    if (typeof marked === 'string' && Object.keys(value).length === 1) {
      try {
        return new Uint8Array(Buffer.from(marked, 'base64'));
      } catch {
        // 不是合法 base64 ⇒ 原样返回；语义校验不归本层，但**不静默丢数据**。
        return value;
      }
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = decode(item, depth + 1);
    }
    return output;
  }
  return value;
}
