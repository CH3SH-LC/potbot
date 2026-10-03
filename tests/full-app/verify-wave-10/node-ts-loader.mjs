/**
 * FA-VERIFY-WAVE-10 · 极小的 ESM 解析钩子：让**朴素的 `node`** 能直接跑本仓的 TS 源码。
 *
 * 本仓源码用 NodeNext 写法（`import ... from './x.js'`，而盘上是 `x.ts`）。Node 24 原生会剥离类型，
 * 但**不会**把 `.js` 说明符改写成 `.ts`。本钩子只做这一件事：当 `./x.js` 不存在、而 `./x.ts` 存在时
 * 指向后者。**不改写任何内容、不做打包**，因此子进程跑的就是仓库里的源文件本身。
 *
 * 为什么要它：跨界验证要求"两个**真 `node` 进程**"（不是同进程内的两个实例）。有了这个钩子，
 * 子进程可以 `node --experimental-strip-types --experimental-loader ./node-ts-loader.mjs probe.mjs`
 * 直接跑 TS 源，既不需要先 `tsc` 构建、也不需要 `tsx`。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (!existsSync(candidate) && existsSync(`${candidate.slice(0, -3)}.ts`)) {
      return { url: pathToFileURL(`${candidate.slice(0, -3)}.ts`).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
