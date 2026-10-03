/**
 * FA-A-E2E 共享夹具（跨模板端到端验收 A01–A19）。
 *
 * 本文件**只做夹具**：把"同一个共享事实版本驱动三种产物"所需的真实模块输入
 * （`SharedFactRecord` / `ArtifactRecord` / 字节读回）集中在一处，供各用例复用。
 *
 * ## 纪律
 * - 这里的每个构造器都调用**真实产品模块**（`src/protocol/**`、`src/artifacts/**`），
 *   不复制产品的记录形状，也不自造常量。
 * - `readZipEntryText()` 是**独立读回器**：本套件自己的 STORE-ZIP 解析，不复用产品的
 *   `selfCheckArtifactBytes()`。这样"产物能被读回"就不依赖被验证的那个实现。
 *   它与产品写出的 STORE-ZIP 只在**已冻结的格式约定**上耦合（本地文件头 30 字节 + 名，
 *   压缩方法 0 = 不压缩），该约定由 `src/artifacts/ooxml/zip.ts` 与合同共同固定。
 * - **本文不写任何断言**；断言在各 `.test.ts` 里。
 */

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  createWorkItem,
  type ArtifactRecord,
  type FactRef,
  type LogicalTime,
  type Revision,
  type SharedFactRecord,
  type TaskId,
  type TemplateKind,
  type WorkItem,
} from '../../../src/protocol/index.js';
import type { KnownFactSnapshotEntry } from '../../../src/artifacts/ports.js';

// ---------------------------------------------------------------------------
// 稳定身份（同一贯穿演示里的任务与实例）
// ---------------------------------------------------------------------------

/** 贯穿演示的任务 id（八人活动 → 十人）。 */
export const DEMO_TASK: TaskId = asTaskId('task-demo-01');
/** 确认事实的实例身份（不是"某个人"）。 */
export const INSTANCE_A = asInstanceId('instance-front-01');
/** 逻辑时间：只用逻辑时间，不碰墙钟（产品纪律）。 */
export const T0: LogicalTime = asLogicalTime(0);
export const T1: LogicalTime = asLogicalTime(1);
export const T2: LogicalTime = asLogicalTime(2);
export const T3: LogicalTime = asLogicalTime(3);
export const T4: LogicalTime = asLogicalTime(4);

/** 首次版本（八人）/ 修改后版本（十人）。 */
export const REV_8: Revision = asRevision(1);
export const REV_10: Revision = asRevision(2);

// ---------------------------------------------------------------------------
// 共享事实
// ---------------------------------------------------------------------------

export interface KnownNumberInput {
  readonly fact_id: string;
  readonly fact_key: string;
  readonly amount: number;
  readonly unit: string;
  readonly currency?: string | null;
  readonly task_revision: Revision;
  readonly supersedes_fact_id?: FactRef | null;
  readonly at?: LogicalTime;
}

/** 一条 `known` 数值事实（人数 / 预算）。 */
export function numberFact(input: KnownNumberInput): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(input.fact_id),
    task_id: DEMO_TASK,
    task_revision: input.task_revision,
    fact_key: input.fact_key,
    value: {
      kind: 'known',
      value: {
        type: 'number',
        amount: input.amount,
        unit: input.unit,
        currency: input.currency ?? null,
      },
    },
    source: { kind: 'user_confirmation', detail: '用户在连续对话中确认' },
    confirmed_by: INSTANCE_A,
    confirmed_at: input.at ?? T0,
    supersedes_fact_id: input.supersedes_fact_id ?? null,
  });
}

export interface UnusableFactInput {
  readonly fact_id: string;
  readonly fact_key: string;
  readonly kind: 'unknown' | 'not_applicable';
  readonly reason: string;
  readonly task_revision: Revision;
  readonly at?: LogicalTime;
}

/** 一条 `unknown` / `not_applicable` 事实（费用缺失：不得当 0）。 */
export function unusableFact(input: UnusableFactInput): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(input.fact_id),
    task_id: DEMO_TASK,
    task_revision: input.task_revision,
    fact_key: input.fact_key,
    value: { kind: input.kind, reason: input.reason },
    source: { kind: 'document', detail: '候选资料未给出该金额' },
    confirmed_by: INSTANCE_A,
    confirmed_at: input.at ?? T0,
  });
}

/** 事实 id → 快照条目要用的稳定引用。 */
export const factRefOf = (factId: string): FactRef => asFactRef(factId);

/**
 * 事实记录的 **8 → 10 版本对**：
 * - `h8`（八人，R1）、`b8`（预算 480，R1）
 * - `h10`（十人，R2，取代 h8）、`b10`（预算 600，R2，取代 b8）
 *
 * 这正是贯穿演示里"把人数由八人改为十人"的最小事实版本。
 */
export interface FactVersions {
  readonly h8: SharedFactRecord;
  readonly b8: SharedFactRecord;
  readonly h10: SharedFactRecord;
  readonly b10: SharedFactRecord;
  readonly all: readonly SharedFactRecord[];
}

export function demoFactVersions(): FactVersions {
  const h8 = numberFact({ fact_id: 'fact-headcount-r1', fact_key: 'headcount', amount: 8, unit: '人', task_revision: REV_8 });
  const b8 = numberFact({ fact_id: 'fact-budget-r1', fact_key: 'budget.total', amount: 480, unit: '元', task_revision: REV_8, at: T1 });
  const h10 = numberFact({
    fact_id: 'fact-headcount-r2',
    fact_key: 'headcount',
    amount: 10,
    unit: '人',
    task_revision: REV_10,
    supersedes_fact_id: asFactRef('fact-headcount-r1'),
    at: T2,
  });
  const b10 = numberFact({
    fact_id: 'fact-budget-r2',
    fact_key: 'budget.total',
    amount: 600,
    unit: '元',
    task_revision: REV_10,
    supersedes_fact_id: asFactRef('fact-budget-r1'),
    at: T3,
  });
  return { h8, b8, h10, b10, all: Object.freeze([h8, b8, h10, b10]) };
}

/** 把真实事实记录转成模板构建器要的**已知快照条目**（三种模板共用同一形状）。 */
export function toSnapshotEntries(records: readonly SharedFactRecord[]): KnownFactSnapshotEntry[] {
  return records.map((record) => {
    if (record.value.kind !== 'known') {
      throw new Error(`toSnapshotEntries 只接受 known 事实，收到 ${record.value.kind}`);
    }
    return {
      fact_ref: record.fact_id,
      fact_key: record.fact_key,
      value: record.value.value,
      source: record.source,
    };
  });
}

// ---------------------------------------------------------------------------
// 产物记录
// ---------------------------------------------------------------------------

export interface PublishedArtifactInput {
  readonly artifact_id: string;
  readonly template_kind: TemplateKind;
  readonly task_revision: Revision;
  readonly artifact_version: number;
  readonly source_fact_refs: readonly string[];
  readonly dependency_artifact_refs?: readonly string[];
  readonly content_digest: string;
  readonly created_at?: LogicalTime;
}

/**
 * 一条**已发布**产物记录（`published` 状态在构造期强制携带回执 + 检查结果，
 * 见 `src/protocol/artifact.ts` 的构造期不变量）。
 */
export function publishedArtifact(input: PublishedArtifactInput): ArtifactRecord {
  const at = input.created_at ?? T0;
  return createArtifactRecord({
    artifact_id: asArtifactRef(input.artifact_id),
    task_id: DEMO_TASK,
    task_revision: input.task_revision,
    artifact_version: input.artifact_version,
    template_kind: input.template_kind,
    byte_length: 1024,
    content_digest: input.content_digest,
    source_fact_refs: input.source_fact_refs.map(asFactRef),
    dependency_artifact_refs: (input.dependency_artifact_refs ?? []).map(asArtifactRef),
    created_by_instance_id: INSTANCE_A,
    status: 'published',
    verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '本套件独立读回' }],
    receipt: {
      final_path: `/runtime/${input.artifact_id}`,
      readback_digest: input.content_digest,
      verifier: 'independent-readback',
      at,
      entry_count: 3,
    },
    created_at: at,
  });
}

// ---------------------------------------------------------------------------
// 独立 STORE-ZIP 读回（不复用产品自检器）
// ---------------------------------------------------------------------------

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;

/**
 * 用**本套件自己的** STORE-ZIP 解析器取出某个部件的 UTF-8 文本。
 *
 * 只支持产品实际写出的形态（压缩方法 0 = 不压缩、无附加字段、无数据描述符）——
 * 这正是 `src/artifacts/ooxml/zip.ts` 冻结的约定。找不到部件时抛错（不返回空串，
 * 避免"没读到"被当成"读到了空"）。
 */
export function readZipEntryText(bytes: Uint8Array, entryPath: string): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const needle = Buffer.from(entryPath, 'utf8');
  let offset = 0;
  while (offset + LOCAL_HEADER_SIZE <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== LOCAL_HEADER_SIGNATURE) {
      // 到达中央目录或尾部：本地头序列结束。
      break;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + LOCAL_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    const dataStart = nameEnd + extraLength;
    const name = buffer.subarray(nameStart, nameEnd);
    if (name.equals(needle)) {
      if (method !== 0) {
        throw new Error(`部件 ${entryPath} 的压缩方法不是 STORE(0)，本读回器不支持：method=${String(method)}`);
      }
      return buffer.subarray(dataStart, dataStart + size).toString('utf8');
    }
    offset = dataStart + size;
  }
  throw new Error(`ZIP 中找不到部件：${entryPath}`);
}

// ---------------------------------------------------------------------------
// 工作项（任务完成口径的输入）
// ---------------------------------------------------------------------------

export interface WorkItemFixtureInput {
  readonly request_id: string;
  readonly status: 'pending' | 'processing' | 'waiting_dependency' | 'completed' | 'failed' | 'cancelled';
  readonly task_revision?: Revision;
  readonly failure_reason?: string;
}

/** 一条真实工作项（构造期即强制形状，见 `createWorkItem`）。 */
export function workItem(input: WorkItemFixtureInput): WorkItem {
  return createWorkItem({
    request_id: asRequestId(input.request_id),
    task_id: DEMO_TASK,
    owner_instance_id: INSTANCE_A,
    created_at: T0,
    task_revision: input.task_revision ?? REV_10,
    status: input.status,
    ...(input.status === 'failed' ? { failure_reason: input.failure_reason ?? '外部服务失败' } : {}),
  });
}

/** 产物里出现的**全部十进制数字串**（用于"正文里每个数字都能追溯到事实"的负例断言）。 */
export function decimalNumbersIn(text: string): readonly string[] {
  return [...text.matchAll(/\d+/g)].map((match) => match[0]);
}

/**
 * 从 OOXML 部件里取出**内容节点**的文本：
 * - `<w:t>` / `<a:t>` —— 文字内容（docx / pptx）；
 * - `<v>` —— 单元格的值内容（xlsx 的数字/日期按值节点写）。
 *
 * 直接对整段 XML 跑数字正则会把属性（`w:val="1"`、`sz="21"`、关系 id …）也算进去，
 * 那是**结构**不是**内容**。内容里的数字才是"必须追溯得到事实"的对象。
 */
export function textRunsOf(xml: string): string {
  return [
    ...xml.matchAll(/<(?:[A-Za-z0-9]+:)?([tv])(?:\s[^>]*)?>([^<]*)<\/(?:[A-Za-z0-9]+:)?[tv]>/g),
  ]
    .map((match) => match[2] ?? '')
    .join('\n');
}
