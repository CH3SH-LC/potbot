/**
 * F-I05 host 包出口（barrel）。
 *
 * 消费方式：`import { mount, mountHeadless } from '<...>/host/index.js'`。
 *
 * 本包把 KernelClient（F-I01）、shell（F-I02）与 chat reducer（F02）组合成一个
 * **无头 App**：真实命令派发 → 内核事件回执 → 归约 → 渲染序列化。
 * 详见 `./session.ts` 顶部说明与同目录 `README.md`。
 */

export * from './session.js';
export * from './mount.js';
