/**
 * K-I10（能力发现端口适配器）对外出口：**K06 模板探针就绪 → K05 发现词表** 的单向投影。
 *
 * 用途：把 K05 集成请求（"feed CapabilityDiscoveryPort from the K06 template probe results"）
 * 落地——派发侧不再自己声明 installed/enabled/authorized/executable 词表，只读本适配器产出的
 * `CapabilityDiscoveryPort`，于是 `missing_capability` / `capability_not_authorized` /
 * `capability_not_executable` 三个阻塞原因来自**同一份**投影。
 *
 * 零依赖、不 import `src/**`、不 import `node:*`（类型仅取自 `dispatch/types` 与
 * `templates/types` 两个零依赖模块）。用法与验收命令见同目录 `README.md`；
 * 独立测试见 `tests/mobile-kernel/K-I10/`。
 */

export {
  createCapabilityDiscoveryPort,
  createCapabilityDiscoveryPortFromSource,
  createProjectedDiscoveryPort,
  resolveTemplateReadiness,
} from './port.js';

export {
  coalesceProviders,
  findCollisions,
  isAbsentTemplate,
  projectCapabilityDiscovery,
  projectCapabilityInventory,
  projectCapabilityProviders,
} from './project.js';

export {
  stateOf,
  type CapabilityCollision,
  type CapabilityProjection,
  type CapabilityProviderView,
  type ProjectedCapabilityDiscoveryPort,
  type TemplateReadinessSnapshot,
  type TemplateReadinessSource,
} from './types.js';

// 便于调用方只从本包取全所需类型（类型转发，编译期擦除，不引入运行期依赖）。
export type { CapabilityDiscoveryPort, DiscoveredCapability } from '../../dispatch/index.js';
export type { ReadinessReport, TemplateManifest } from '../../templates/index.js';
