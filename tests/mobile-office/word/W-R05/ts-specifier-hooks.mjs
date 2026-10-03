/**
 * **Node ESM 解析钩子**（W-R05 CLI 专用，`.mjs`）——把 `.js` 说明符回退到同名 `.ts`。
 *
 * 为什么需要它：本仓 `tsconfig` 是 `module: NodeNext`，源码里的相对导入**必须**写 `.js`
 * 后缀（TS 的解析约定）；而 Node 的类型擦除**不**做 `.js` → `.ts` 回退，于是
 * `node verify-cli.ts` 会在链接期对每个内部相对导入抛 `ERR_MODULE_NOT_FOUND`。
 * 该钩子只补这一个映射：**先试 `.ts`，失败再走原样**——因此 `.mjs` / 真实 `.js` 依赖不受影响。
 *
 * 只在 CLI（`verify-cli.ts`）里通过 `module.register()` 启用；vitest 路径**不**加载它。
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // 回退：也许确实存在同名 .js（本包内没有，但保持通用）。
    }
  }
  return nextResolve(specifier, context);
}
