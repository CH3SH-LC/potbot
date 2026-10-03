/**
 * Node ESM 解析钩子（W-R01 CLI 专用）。把 `.js` 说明符回退到同名 `.ts`。
 *
 * 原因：本仓 tsconfig 为 NodeNext，源码相对导入必须写 `.js` 后缀（TS 约定），而 Node 的
 * 类型擦除不做 `.js` → `.ts` 回退，`node --experimental-strip-types map-cli.ts` 会在链接期抛
 * ERR_MODULE_NOT_FOUND。该钩子只补这一条映射：先试 `.ts`，失败再走原样。
 * vitest 路径不加载它。
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // 回退：也许真的存在同名 .js。
    }
  }
  return nextResolve(specifier, context);
}
