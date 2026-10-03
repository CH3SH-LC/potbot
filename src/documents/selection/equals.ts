/**
 * 结构相等（读回/变更判定用）。
 *
 * 为什么不用 `JSON.stringify` 比较：属性值里有 `Length` 之类的小对象，键顺序在构造路径不同时
 * 可能不同，而"两个属性集是否相同"是**语义**问题；另外 `undefined` 与缺失键在 JSON 里会被
 * 一起抹掉，正好会掩盖 `unspecified` 与"根本没有该字段"的差别——而 R118 要求这两者能分别产出。
 * 因此这里做逐字段递归比较。
 */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i += 1) {
    const key = leftKeys[i]!;
    if (key !== rightKeys[i]) return false;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}
