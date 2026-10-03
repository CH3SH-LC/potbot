/**
 * K-I10 适配器 · **端口装配**：把投影产物接成 K05 的 `CapabilityDiscoveryPort`，
 * 并提供从 K06 生命周期**异步读回**就绪报告、再投影为快照的便捷路径。
 *
 * ## 同步端口 vs 异步读回
 *
 * K05 的 `CapabilityDiscoveryPort.discover()` 是**同步**的（`planDispatch` 是纯函数）。K06 的
 * `reportReadiness()` 是**异步**的（真机上要查包管理器 / 端口 / 权限）。因此本层把两步分开：
 *
 *   1. `resolveTemplateReadiness()`（异步）—— 用 K06 探针读回每个模板的四态报告。**只读**，
 *      不做判定、不改写任何一条 K06 结论；`list(id)` 为空 ⇒ `readiness: null`（不伪造报告）。
 *   2. `createCapabilityDiscoveryPort()`（同步）—— 把快照投影并冻结成同步端口，供
 *      `planDispatch` 反复读取（同一快照恒返回同一份数组）。
 *
 * 宿主在派发前 `await` 一次读回即可；派发链路本身保持纯同步、可确定性重放。
 *
 * 探针失败**大声抛错**（不吞成"未就绪"）：`reportReadiness` 拒绝即向上传播——读回失败是宿主
 * 缺陷，不该被美化成一个看起来正常的"未安装"。
 */

import type { CapabilityDiscoveryPort } from '../../dispatch/types.js';
import type { TemplateManifest } from '../../templates/types.js';
import { projectCapabilityDiscovery } from './project.js';
import type {
  CapabilityProjection,
  TemplateReadinessSnapshot,
  TemplateReadinessSource,
} from './types.js';

/**
 * 把一个**已投影**的产物接成 K05 端口。`discover()` 恒返回同一份（冻结的）数组。
 */
export function createProjectedDiscoveryPort(projection: CapabilityProjection): CapabilityDiscoveryPort {
  const capabilities = projection.capabilities;
  return Object.freeze({ discover: () => capabilities });
}

/**
 * 由快照直接装配 K05 端口（先投影、再冻结）。这是喂给 `planDispatch` 的主入口。
 */
export function createCapabilityDiscoveryPort(
  snapshots: readonly TemplateReadinessSnapshot[],
): CapabilityDiscoveryPort {
  return createProjectedDiscoveryPort(projectCapabilityDiscovery(snapshots));
}

/**
 * 异步读回：对每个 manifest，取其**在用版本**（无在用版本时退回任一未卸载版本；唯一的保留
 * 卸载版本也照读，让 K06 自己报 `installed: not-ready(uninstalled)`）的探针就绪报告。
 *
 * - `list(id)` 为空（加载器里根本没有该模板）⇒ `readiness: null`。
 * - 探针读回失败 ⇒ **向上抛出**（不吞）。
 *
 * @throws 探针 `reportReadiness` 的拒绝原样传播。
 */
export async function resolveTemplateReadiness(
  manifests: readonly TemplateManifest[],
  source: TemplateReadinessSource,
): Promise<readonly TemplateReadinessSnapshot[]> {
  const snapshots: TemplateReadinessSnapshot[] = [];
  for (const manifest of manifests) {
    const versions = source.list(manifest.id);
    if (versions.length === 0) {
      snapshots.push(Object.freeze({ manifest, readiness: null }));
      continue;
    }
    const active = versions.find((version) => version.active);
    const usable = versions.find((version) => !version.uninstalled);
    const target = active ?? usable ?? versions[0];
    if (target === undefined) {
      // 理论不可达（versions 非空）；兜底为缺席，不静默编造报告。
      snapshots.push(Object.freeze({ manifest, readiness: null }));
      continue;
    }
    const readiness = await source.reportReadiness(manifest.id, target.version);
    snapshots.push(Object.freeze({ manifest, readiness }));
  }
  return Object.freeze(snapshots);
}

/**
 * 一步到位：异步读回 7 模板（或给定清单）→ 投影 → 返回同步 K05 端口。
 * 宿主在派发前 `await` 一次即可；随后 `planDispatch` 用同一个端口确定性重放。
 */
export async function createCapabilityDiscoveryPortFromSource(
  manifests: readonly TemplateManifest[],
  source: TemplateReadinessSource,
): Promise<CapabilityDiscoveryPort> {
  const snapshots = await resolveTemplateReadiness(manifests, source);
  return createCapabilityDiscoveryPort(snapshots);
}
