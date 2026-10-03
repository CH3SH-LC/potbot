/**
 * MT-06：把**获准**事实交给预算 / 文档 / 演示等模板，**保留来源与时间**，
 * 不让下游另猜价格。
 *
 * ## 只有"带来源与时间"的条目才准发布
 *
 * 发布前逐条过 {@link screenPublishableFacts}：缺 `sourceRef` 或
 * `observedAtMs` 不是有限数的条目一律**拒绝发布**（`not-publishable`），
 * 而不是"补一个默认值"再发。下游模板因此**无从**自己去猜价格。
 *
 * ## 接口未接线 ⇒ 结构化标 `not-wired`，**不宣称**已发布
 *
 * 每个目标模板是一个 {@link FactPublicationPort} 通道。通道**不存在**时，
 * 结果里该模板的 `wireState` 就是 `'not-wired'`，`acknowledged === false`，
 * 原因写明"未接该模板"。**不**因"结构已经造好了"就宣称"已在预算/文档里生效"。
 *
 * ## 承认 = 只有通道给了回执才算
 *
 * `acknowledged` 只在通道 `publish` 返回 `ok: true` 且**带 `receiptRef`** 时为 true。
 * 这是本地模块能拿到的最强证据；即便如此，本模块也**不**声称下游"已展示"。
 */

import { formatIsoTimestampUtc } from '../../protocol/index.js';
import type { Candidate } from './candidates.js';
import { exportCandidateFacts, type ExportedCandidateFact } from './candidates.js';

/** 下游模板种类。 */
export type DownstreamTemplate = 'budget' | 'document' | 'presentation';

export const DOWNSTREAM_TEMPLATES: readonly DownstreamTemplate[] = Object.freeze([
  'budget',
  'document',
  'presentation',
]);

/** 一条事实能否发布。 */
export interface FactScreenVerdict {
  readonly publishable: readonly ExportedCandidateFact[];
  readonly notPublishable: readonly { readonly key: string; readonly reason: string }[];
}

/** 逐条核对来源与时间：任一缺失即不准发布。 */
export function screenPublishableFacts(
  facts: readonly ExportedCandidateFact[],
): FactScreenVerdict {
  const publishable: ExportedCandidateFact[] = [];
  const notPublishable: { key: string; reason: string }[] = [];
  for (const fact of facts) {
    if (fact.sourceRef.trim() === '') {
      notPublishable.push({ key: fact.key, reason: '事实缺来源（sourceRef 为空）：不得发布（MT-06）' });
      continue;
    }
    if (!Number.isFinite(fact.observedAtMs)) {
      notPublishable.push({ key: fact.key, reason: '事实缺观测时间（observedAtMs 不合法）：不得发布' });
      continue;
    }
    publishable.push(fact);
  }
  return { publishable, notPublishable };
}

/** 下游模板的发布通道。未装配的模板 ⇒ 结果标 `not-wired`。 */
export interface FactPublicationPort {
  readonly template: DownstreamTemplate;
  publish(facts: readonly ExportedCandidateFact[]): Promise<
    | { readonly ok: true; readonly receiptRef: string }
    | { readonly ok: false; readonly reason: string }
  >;
}

export type WireState = 'not-wired' | 'published' | 'failed';

/** 某模板的发布结果。 */
export interface PublicationResult {
  readonly template: DownstreamTemplate;
  readonly wireState: WireState;
  /** 只有通道给出带 `receiptRef` 的受理回执才为 true。 */
  readonly acknowledged: boolean;
  readonly factCount: number;
  readonly receiptRef: string | null;
  readonly reason: string | null;
  /**
   * **恒为 false**：本模块**不**宣称"已在其他模板生效/展示"。
   * 未接线时的 `not-wired`、接线后也只有通道受理回执，谈不上"已发布到用户可见处"。
   */
  readonly claimed_published: false;
}

const NOT_WIRED_REASON =
  '**未接该模板**：预算/文档/演示的接线由其他领域包与总协调持有，不在本包写权内。' +
  '未接下游前**不宣称**已在其他模板生效（MT-06）。';

/** 发布到所有已装配的模板；未装配的模板逐个如实标 `not-wired`。 */
export async function publishCandidateFacts(
  channels: readonly FactPublicationPort[],
  candidates: readonly Candidate[],
): Promise<readonly PublicationResult[]> {
  const facts = exportCandidateFacts(candidates);
  const { publishable, notPublishable } = screenPublishableFacts(facts);

  const results: PublicationResult[] = [];
  for (const template of DOWNSTREAM_TEMPLATES) {
    const channel = channels.find((item) => item.template === template);
    if (channel === undefined) {
      results.push({
        template,
        wireState: 'not-wired',
        acknowledged: false,
        factCount: 0,
        receiptRef: null,
        reason: NOT_WIRED_REASON,
        claimed_published: false,
      });
      continue;
    }
    if (notPublishable.length > 0) {
      results.push({
        template,
        wireState: 'failed',
        acknowledged: false,
        factCount: 0,
        receiptRef: null,
        reason:
          `有 ${String(notPublishable.length)} 条事实不完整（缺来源/时间）⇒ 拒绝发布整批：` +
          `${notPublishable.map((entry) => `${entry.key}：${entry.reason}`).join('；')}。`,
        claimed_published: false,
      });
      continue;
    }
    const response = await channel.publish(publishable);
    if (!response.ok) {
      results.push({
        template,
        wireState: 'failed',
        acknowledged: false,
        factCount: publishable.length,
        receiptRef: null,
        reason: `通道发布失败：${response.reason}`,
        claimed_published: false,
      });
      continue;
    }
    results.push({
      template,
      wireState: 'published',
      acknowledged: response.receiptRef.trim() !== '',
      factCount: publishable.length,
      receiptRef: response.receiptRef,
      reason: null,
      claimed_published: false,
    });
  }
  return results;
}

/** 事实的展示文本：**来源与时间必须同行显示**（不留给下游去猜）。 */
export function describeFact(fact: ExportedCandidateFact): string {
  const sourceLabel = fact.sourceKind === 'authorized_interface' ? '在线来源' : '用户分享';
  return `${fact.key} = ${fact.value}（来源：${sourceLabel}/${fact.sourceRef}，观测于 ${formatIsoTimestampUtc(fact.observedAtMs)}）`;
}

/** 未接线模板的清单（供展示层显式提示"尚未生效"）。 */
export function listUnwiredTemplates(results: readonly PublicationResult[]): readonly DownstreamTemplate[] {
  return results.filter((result) => result.wireState === 'not-wired').map((result) => result.template);
}
