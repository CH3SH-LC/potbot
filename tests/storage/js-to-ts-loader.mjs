/**
 * 测试夹具用的 ESM 解析钩子：把相对 `.js` 说明符映射到同目录的 `.ts` 源码。
 *
 * 为什么需要它：本仓库的 TS 源码按 NodeNext 规范写 `./x.js`（编译后才存在），
 * 而 `file-store.cross-process.test.ts` 要**真的起两个操作系统进程**去并发写同一个
 * 状态文件（合同 R220 明确要求"两个工作进程 + 重启的交叉负例"）。Node 自带的类型
 * 擦除（`--experimental-transform-types`）**不会**做 `.js` → `.ts` 的改名解析，
 * 所以子进程直接 import 会 ERR_MODULE_NOT_FOUND。
 *
 * 本文件**只服务测试**：不参与产品构建（tsconfig 只收 `.ts`），也不改变运行期语义。
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (
    typeof specifier === 'string' &&
    specifier.endsWith('.js') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    typeof context.parentURL === 'string'
  ) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (candidate.protocol === 'file:' && existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
