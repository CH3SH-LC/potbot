/**
 * **交付会话状态的 JSON 编解码**（design-06 P8/P9；R216「保存并重新打开」的通用侧）。
 *
 * ## 为什么不能直接 `JSON.stringify(state)`
 *
 * 会话状态里装的源是**各格式自己的模型**，而其中至少一类（表格的 `WorkbookState`）
 * 用 `ReadonlyMap` 存单元格、用 `Uint8Array` 存 R249 要原样保留的未知部件字节。
 * 两者直接 `JSON.stringify` 都**不报错**：
 * - `Map` → `{}`（**整张表悄悄变成空的**）；
 * - `Uint8Array` → `{"0":31,"1":139,…}` 数字键对象（看起来完整、其实已毁）。
 *
 * 失败因此发生在很久以后的某次导出上，而不是保存的那一刻。这一条在字处理会话的
 * 第一次实现里就被抓到过（见 `src/documents/session/persistence.ts` 的头部），
 * 本层用**同一套标记**（`$bytes`）并**多加一个 `$map`**，把这个坑在本层一次封死。
 *
 * ## 编码格式
 *
 * | JS 值 | JSON 表示 |
 * |---|---|
 * | `Uint8Array` | `{ "$bytes": "<base64>" }` |
 * | `Map` / `ReadonlyMap` | `{ "$map": [[key, value], …] }` |
 * | 数组 / 普通对象 | 递归 |
 *
 * `$` 前缀的**单键**对象是被保留的形状；普通对象里恰好出现一个 `$bytes` 键的概率极低，
 * 且真出现时也只会被还原成 `Uint8Array`，不会静默丢数据。
 *
 * ## 边界（如实登记）
 *
 * - `$map` 的键只支持 **JSON 标量**（字符串 / 数字）——本仓三格式的源都只用字符串键；
 *   其它键类型**不猜**，编码时结构化为普通对象会丢语义，因此这里**显式抛错**而不是静默。
 * - 解码对**不认识**的形状原样返回（不抛错）；形状核对归 `DeliverableSession.restore`。
 * - 深度上限 64：状态是有限结构，超深只可能是坏输入。
 * - 与字处理会话的编解码器**暂未合并**：两者标记相同、语义相同，但各自服务不同的状态树。
 *   合并需要同时改已经"待验收"的字处理链，本轮**不做**（见交付说明的已知缺口）。
 */

/** 二进制的标记键。 */
export const BYTES_MARKER = '$bytes';

/** 映射的标记键（`Map` / `ReadonlyMap`）。 */
export const MAP_MARKER = '$map';

/** 递归深度上限（坏输入保护）。 */
const MAX_DEPTH = 64;

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** `ReadonlyMap` 是类型不是类，运行时判据只有 `Map` 一个（本仓的源都构造自 `Map`）。 */
function isMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return value instanceof Map;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isBytes(value) &&
    !isMap(value)
  );
}

/** 编码：`Uint8Array` → `{$bytes}`、`Map` → `{$map}`，其余递归。纯函数。 */
export function encodeSessionState(value: unknown): unknown {
  return encode(value, 0);
}

function encode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (isBytes(value)) {
    return { [BYTES_MARKER]: Buffer.from(value).toString('base64') };
  }
  if (isMap(value)) {
    const entries: [string, unknown][] = [];
    for (const [key, item] of value.entries()) {
      if (typeof key !== 'string' && typeof key !== 'number') {
        // 不静默：`String(key)` 会把 `{a:1}` 与 `[object Object]` 变成同一个键，那是丢数据。
        throw new TypeError(
          `会话状态里的 Map 出现了非标量键（${typeof key}）：本层不猜键的序列化方式，拒绝在保存时静默丢语义`,
        );
      }
      entries.push([String(key), encode(item, depth + 1)]);
    }
    return { [MAP_MARKER]: entries };
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

/** 解码：`{$bytes}` → `Uint8Array`、`{$map}` → `Map`，其余递归。**不抛错**（坏形状原样返回）。 */
export function decodeSessionState(value: unknown): unknown {
  return decode(value, 0);
}

function decode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => decode(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const markedBytes = value[BYTES_MARKER];
      if (typeof markedBytes === 'string') {
        // **必须回环核对，不能只靠 `Buffer.from(..., 'base64')`**：Node 对非法 base64
        // 是**宽容**的——它会悄悄丢掉不认识的字符并照常返回一段字节，于是"状态被改坏了"
        // 会变成"读回一段看起来合法、其实不同的字节"。这里用与 HTTP 层 `decodeBase64`
        // 相同的两道判据（字符集 + 回环相等），不满足就原样返回、**不猜**。
        if (/^[A-Za-z0-9+/]*={0,2}$/.test(markedBytes) && markedBytes.length % 4 === 0) {
          const buffer = Buffer.from(markedBytes, 'base64');
          if (buffer.toString('base64') === markedBytes) {
            return new Uint8Array(buffer);
          }
        }
        return value;
      }
      const markedMap = value[MAP_MARKER];
      if (Array.isArray(markedMap)) {
        const map = new Map<string, unknown>();
        for (const entry of markedMap) {
          if (!Array.isArray(entry) || entry.length !== 2) return value; // 形状不认识 ⇒ 原样返回
          const [key, item] = entry as [unknown, unknown];
          if (typeof key !== 'string') return value;
          map.set(key, decode(item, depth + 1));
        }
        return map;
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
