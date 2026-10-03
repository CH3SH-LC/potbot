/**
 * S6 验收用例 ⑧：**内核事件轨迹的独立核对 + 锚复算 + 灵敏度对照**。
 *
 * 对应验收表「内核」一行：*同 task/run/request 的消息、轮次、`artifact_staged`/`published` 与回执*。
 *
 * ## 纪律一：不采信交付方的自证函数
 *
 * S3 提供 `checkKernelTrace(trace, {expectPublished})`。**本文件一行都不 import 它。**
 * 这里所有判据都是我按验收表要求自己写的，只读轨迹 JSON 与**磁盘上真实字节**。
 *
 * ## 纪律二：不采信锚里的**预计算值**，一律当场复算
 *
 * 锚（`trace.anchor`）带来 `manifest` / `delivery_event_ids` / 各种 count 与布尔值。
 * S3 自己承认头两版"读了自报值"，变异体照样溜过去；改成复算才抓住。
 * 因此这里：**用 `manifest` 自己重新过滤一遍**、**自己解析 `pending_event_id` 的归属**、
 * **自己算序号上界与条目总数的关系**，并把**复算值与自报值不一致本身**判红。
 *
 * ## 纪律三：不会红的断言不是判据
 *
 * 每个判据都配变异体（项目经验 info-021）。
 *
 * ## 残余边界（**必须写进结论，不得抹平**）
 *
 * 锚**仍由导出方（宿主）产生**：宿主若同时裁剪切片与清单，锚自身也自洽。
 * 内核 store 是内存实现，**没有可外部读取的 append-only 日志或第二真相源**，
 * 所以"事件是否被丢弃"在本轮**没有完全独立的外部判据**。
 * 锚把「导出自洽 + 引用可解析 + id 空间闭合」变成**可复算**；它与我的 **T7**（从盘上亲自算
 * sha256/字节长度去对事件里的 `readback_digest`/`byte_length`）合起来是**当前能拿到的最强证据**，
 * 但**不构成"事件未被丢弃"的完全独立证明**（要那个需要内核提供可外部读取的持久事件日志——
 * 已裁定本轮不做）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, listFiles, repoRelative } from './support.js';

const RUN_ID = process.env['DEMO_RUN_ID'] ?? 'MWD-20261002-A';
const RUN_DIR = join(REPO_ROOT, '.runtime', 'mobile-word-demo', RUN_ID);
const TRACE_DIR = join(RUN_DIR, 'kernel-trace');
const INDEX_PATH = join(RUN_DIR, 'app-index.json');
const ARTIFACT_ROOT = join(RUN_DIR, 'artifacts');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'other', 'review', 'mobile-word-demo', 'verification', 'selftest');

const FAKE_MODEL = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-model-server.mjs');
const HOST_MAIN = join(REPO_ROOT, '.runtime', 'mobile-word-demo', 'build', 'apps', 'demo', 'server', 'main.js');

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

interface TraceEvent {
  event_id?: unknown;
  kind?: unknown;
  at?: unknown;
  task_id?: unknown;
  message_id?: unknown;
  run_id?: unknown;
  request_id?: unknown;
  data?: Record<string, unknown>;
}

interface TraceRun {
  run_id?: unknown;
  frozen_request_ids?: readonly unknown[];
  frozen_input_message_ids?: readonly unknown[];
  started_event_id?: unknown;
  finished_event_id?: unknown;
}

interface TraceArtifact {
  artifact_id?: unknown;
  request_ids?: readonly unknown[];
  staged_expected_digest?: unknown;
  staged_event_id?: unknown;
  published_event_id?: unknown;
  published_byte_length?: unknown;
  published_readback_digest?: unknown;
  record_receipt_readback_digest?: unknown;
}

interface TraceWorkItem {
  request_id?: unknown;
  task_id?: unknown;
  description?: unknown;
  result_refs?: readonly unknown[];
}

interface ManifestEntry {
  event_id?: unknown;
  task_id?: unknown;
  kind?: unknown;
}

interface EventReference {
  event_id?: unknown;
  from_event_id?: unknown;
  resolved_in?: unknown;
}

export interface TraceAnchor {
  global_kernel_event_count?: unknown;
  global_kernel_max_seq?: unknown;
  global_delivery_event_count?: unknown;
  global_delivery_max_seq?: unknown;
  delivery_event_ids?: readonly unknown[];
  task_event_count_expected?: unknown;
  task_event_count_exported?: unknown;
  manifest?: readonly ManifestEntry[];
  referenced_event_ids?: readonly EventReference[];
  unresolved_event_ids?: readonly unknown[];
  evt_seq_vs_counts_consistent?: unknown;
}

export interface Trace {
  schema?: unknown;
  task_id?: unknown;
  messages?: readonly { message_id?: unknown; request_id?: unknown; event_id?: unknown }[];
  runs?: readonly TraceRun[];
  artifacts?: readonly TraceArtifact[];
  failures?: readonly unknown[];
  events?: readonly TraceEvent[];
  anchor?: TraceAnchor | null;
  work_items?: readonly TraceWorkItem[];
  host_error?: unknown;
}

export interface Violation {
  readonly code: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sha256OfFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function normalizePath(raw: string): string {
  return raw.replace(/\//g, process.platform === 'win32' ? '\\' : '/');
}

function isInsideArtifactRoot(rawPath: string): boolean {
  return normalizePath(rawPath).toLowerCase().startsWith(ARTIFACT_ROOT.toLowerCase());
}

/** 从 `evt-12` / `seed/evt-12` 解析序号；解析不出返回 null。 */
function eventSeqOf(id: string): number | null {
  const match = /(?:^|\/)evt-(\d+)$/.exec(id);
  return match === null ? null : Number(match[1]);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// 判据一：切片自身（T1–T10）
// ---------------------------------------------------------------------------

export function verifyTraceIndependently(trace: Trace): readonly Violation[] {
  const violations: Violation[] = [];
  const events = trace.events ?? [];
  const byId = new Map<string, TraceEvent>();
  const eventIds = new Set<string>();

  if (trace.schema !== 'potbot-kernel-trace.v1') {
    violations.push({ code: 'T1_schema', detail: `schema=${String(trace.schema)}` });
  }

  for (const event of events) {
    if (event.task_id !== trace.task_id) {
      violations.push({
        code: 'T2_foreign_event',
        detail: `${String(event.event_id)} 的 task_id=${String(event.task_id)} ≠ ${String(trace.task_id)}`,
      });
    }
  }

  for (const event of events) {
    const id = str(event.event_id);
    if (id === null) {
      violations.push({ code: 'T3_event_id_missing', detail: JSON.stringify(event).slice(0, 80) });
      continue;
    }
    if (eventIds.has(id)) violations.push({ code: 'T3_duplicate_event_id', detail: id });
    eventIds.add(id);
    byId.set(id, event);
  }

  const indexOfEvent = (id: unknown): number => {
    if (typeof id !== 'string') return -1;
    return events.findIndex((event) => event.event_id === id);
  };

  for (const run of trace.runs ?? []) {
    for (const key of ['started_event_id', 'finished_event_id'] as const) {
      const id = str(run[key]);
      if (id !== null && !byId.has(id)) {
        violations.push({ code: 'T4_dangling_run_event', detail: `${key}=${id} 不在 events 中` });
      }
    }
  }
  for (const artifact of trace.artifacts ?? []) {
    for (const key of ['staged_event_id', 'published_event_id'] as const) {
      const id = str(artifact[key]);
      if (id !== null && !byId.has(id)) {
        violations.push({ code: 'T4_dangling_artifact_event', detail: `${key}=${id} 不在 events 中` });
      }
    }
  }
  for (const message of trace.messages ?? []) {
    const id = str(message.event_id);
    if (id !== null && !byId.has(id)) {
      violations.push({ code: 'T4_dangling_message_event', detail: `event_id=${id} 不在 events 中` });
    }
  }

  for (const artifact of trace.artifacts ?? []) {
    const staged = indexOfEvent(artifact.staged_event_id);
    const published = indexOfEvent(artifact.published_event_id);
    if (staged >= 0 && published >= 0 && staged > published) {
      violations.push({ code: 'T5_staged_after_published', detail: `staged@${staged} > published@${published}` });
    }
  }
  for (const run of trace.runs ?? []) {
    const started = indexOfEvent(run.started_event_id);
    const finished = indexOfEvent(run.finished_event_id);
    if (started >= 0 && finished >= 0 && started > finished) {
      violations.push({ code: 'T5_run_finished_before_started', detail: `started@${started} > finished@${finished}` });
    }
  }

  const workItemRefs = new Set<string>();
  for (const item of trace.work_items ?? []) {
    for (const ref of item.result_refs ?? []) {
      if (typeof ref === 'string') workItemRefs.add(ref);
    }
  }
  for (const artifact of trace.artifacts ?? []) {
    const id = str(artifact.artifact_id);
    if (id === null) {
      violations.push({ code: 'T6_artifact_id_missing', detail: JSON.stringify(artifact).slice(0, 80) });
      continue;
    }
    const staged = events.find((event) => event.event_id === artifact.staged_event_id);
    const published = events.find((event) => event.event_id === artifact.published_event_id);
    const stagedId = staged?.data?.['artifact_id'];
    const publishedId = published?.data?.['artifact_id'];
    if (stagedId !== undefined && stagedId !== id) {
      violations.push({ code: 'T6_staged_id_mismatch', detail: `${String(stagedId)} ≠ ${id}` });
    }
    if (publishedId !== undefined && publishedId !== id) {
      violations.push({ code: 'T6_published_id_mismatch', detail: `${String(publishedId)} ≠ ${id}` });
    }
    if (workItemRefs.size > 0 && !workItemRefs.has(id)) {
      violations.push({ code: 'T6_workitem_ref_missing', detail: `工作项 result_refs 不含 ${id}` });
    }
  }

  // T7：把事件与**磁盘真实字节**绑死（不依赖锚，也不依赖任何自报值）
  for (const event of events.filter((item) => item.kind === 'artifact_published')) {
    const data = event.data ?? {};
    const finalPath = data['final_path'];
    if (typeof finalPath !== 'string') {
      violations.push({ code: 'T7_final_path_missing', detail: JSON.stringify(data).slice(0, 120) });
      continue;
    }
    if (!isInsideArtifactRoot(finalPath)) {
      violations.push({ code: 'T7_path_escape', detail: `final_path 不在产物根内：${finalPath}` });
      continue;
    }
    const actual = sha256OfFile(normalizePath(finalPath));
    if (actual === null) {
      violations.push({ code: 'T7_file_unreadable', detail: finalPath });
      continue;
    }
    if (data['readback_digest'] !== actual) {
      violations.push({
        code: 'T7_readback_digest_mismatch',
        detail: `事件称 ${String(data['readback_digest'])}，盘上 ${actual}`,
      });
    }
    let size = -1;
    try {
      size = readFileSync(normalizePath(finalPath)).byteLength;
    } catch {
      size = -1;
    }
    if (data['byte_length'] !== size) {
      violations.push({ code: 'T7_byte_length_mismatch', detail: `事件 ${String(data['byte_length'])} vs 盘上 ${size}` });
    }
  }

  for (const artifact of trace.artifacts ?? []) {
    const values = [
      artifact.staged_expected_digest,
      artifact.published_readback_digest,
      artifact.record_receipt_readback_digest,
    ].filter((value): value is string => typeof value === 'string');
    if (new Set(values).size > 1) {
      violations.push({ code: 'T8_digest_disagreement', detail: values.join(' vs ') });
    }
  }

  const workItemRequests = new Set<string>();
  for (const item of trace.work_items ?? []) {
    if (typeof item.request_id === 'string') workItemRequests.add(item.request_id);
  }
  for (const run of trace.runs ?? []) {
    for (const requestId of run.frozen_request_ids ?? []) {
      if (typeof requestId === 'string' && workItemRequests.size > 0 && !workItemRequests.has(requestId)) {
        violations.push({ code: 'T9_frozen_request_orphan', detail: `${requestId} 不在任何工作项上` });
      }
    }
  }

  for (const item of trace.work_items ?? []) {
    if (typeof item.description !== 'string' || item.description.trim().length === 0) {
      violations.push({ code: 'T10_workitem_description_empty', detail: String(item.request_id) });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 判据二：锚 —— **全部当场复算，不读自报值**
// ---------------------------------------------------------------------------

/** 切片里引用的所有外部事件 id（我自己抽，不采用锚的 `referenced_event_ids`）。 */
function referencesFromSlice(trace: Trace): string[] {
  const refs = new Set<string>();
  const add = (value: unknown): void => {
    const id = str(value);
    if (id !== null && /(?:^|\/)evt-\d+$/.test(id)) refs.add(id);
  };
  for (const run of trace.runs ?? []) {
    add(run.started_event_id);
    add(run.finished_event_id);
  }
  for (const artifact of trace.artifacts ?? []) {
    add(artifact.staged_event_id);
    add(artifact.published_event_id);
  }
  for (const message of trace.messages ?? []) add(message.event_id);
  for (const event of trace.events ?? []) {
    for (const value of Object.values(event.data ?? {})) add(value);
  }
  return [...refs];
}

export function verifyAnchorIndependently(trace: Trace): readonly Violation[] {
  const violations: Violation[] = [];
  const anchor = trace.anchor;
  if (anchor === undefined || anchor === null) {
    return [{ code: 'A0_anchor_missing', detail: '轨迹没有 anchor 字段：N9 判据无从成立' }];
  }
  const events = trace.events ?? [];
  const manifest = anchor.manifest ?? [];

  // -- A1/A2：用 manifest **自己重新过滤一遍**，并与切片逐条比对 --
  const refiltered = manifest.filter((entry) => entry.task_id === trace.task_id);
  const refilteredIds = refiltered.map((entry) => String(entry.event_id));
  const sliceIds = events.map((event) => String(event.event_id));
  const manifestIdSet = new Set(manifest.map((entry) => String(entry.event_id)));

  for (const id of sliceIds) {
    if (!manifestIdSet.has(id)) {
      violations.push({ code: 'A2_slice_not_in_manifest', detail: `切片里的 ${id} 不在全量清单中` });
    }
  }
  if (refilteredIds.length !== sliceIds.length || refilteredIds.some((id, i) => id !== sliceIds[i])) {
    violations.push({
      code: 'A1_manifest_refilter_mismatch',
      detail: `自己过滤得 ${refilteredIds.length} 条 [${refilteredIds.slice(0, 6).join(',')}…]，切片有 ${sliceIds.length} 条 [${sliceIds.slice(0, 6).join(',')}…]`,
    });
  }
  // kind 也要对得上（只对 id 会把"同 id 换了事件种类"放过去）。
  const sliceKindById = new Map(events.map((event) => [String(event.event_id), String(event.kind)]));
  for (const entry of refiltered) {
    const id = String(entry.event_id);
    if (sliceKindById.has(id) && sliceKindById.get(id) !== String(entry.kind)) {
      violations.push({
        code: 'A1_kind_mismatch',
        detail: `${id}: 清单称 ${String(entry.kind)}，切片称 ${String(sliceKindById.get(id))}`,
      });
    }
  }

  // -- A5/A6：计数一律**现算**，再与自报值比 --
  const expected = refiltered.length;
  if (anchor.task_event_count_expected !== expected) {
    violations.push({
      code: 'A6_expected_count_selfreport_mismatch',
      detail: `自报 expected=${String(anchor.task_event_count_expected)}，我复算=${expected}`,
    });
  }
  if (anchor.task_event_count_exported !== events.length) {
    violations.push({
      code: 'A6_exported_count_selfreport_mismatch',
      detail: `自报 exported=${String(anchor.task_event_count_exported)}，切片实际=${events.length}`,
    });
  }
  if (expected !== events.length) {
    violations.push({ code: 'A5_export_truncated', detail: `应当 ${expected} 条，实际导出 ${events.length} 条` });
  }
  if (anchor.global_kernel_event_count !== manifest.length) {
    violations.push({
      code: 'A6_global_count_selfreport_mismatch',
      detail: `自报 global_kernel_event_count=${String(anchor.global_kernel_event_count)}，清单实际=${manifest.length}`,
    });
  }

  // -- A7：序号上界由**全量**算，并与自报值比 --
  const kernelSeqs = manifest
    .map((entry) => eventSeqOf(String(entry.event_id)))
    .filter((seq): seq is number => seq !== null);
  const recomputedKernelMax = kernelSeqs.length > 0 ? Math.max(...kernelSeqs) : null;
  if (anchor.global_kernel_max_seq !== recomputedKernelMax) {
    violations.push({
      code: 'A7_kernel_max_seq_selfreport_mismatch',
      detail: `自报 ${String(anchor.global_kernel_max_seq)}，我从清单复算=${String(recomputedKernelMax)}`,
    });
  }

  // -- A3：引用可解析性 —— **我自己解析归属**，不看 unresolved_event_ids 的结论 --
  const deliveryIds = (anchor.delivery_event_ids ?? []).map((id) => String(id));
  const deliveryIdSet = new Set(deliveryIds);
  if (anchor.global_delivery_event_count !== deliveryIds.length) {
    violations.push({
      code: 'A6_delivery_count_selfreport_mismatch',
      detail: `自报 ${String(anchor.global_delivery_event_count)}，id 全集实际 ${deliveryIds.length}`,
    });
  }
  const known = new Set<string>([...manifestIdSet, ...deliveryIdSet, ...sliceIds]);
  for (const ref of referencesFromSlice(trace)) {
    if (!known.has(ref)) {
      violations.push({ code: 'A3_unresolved_reference', detail: `引用 ${ref} 在清单与待投递 id 集里都找不到` });
    }
  }
  const reportedUnresolved = (anchor.unresolved_event_ids ?? []).map((id) => String(id));
  if (reportedUnresolved.length > 0) {
    violations.push({
      code: 'A3_reported_unresolved',
      detail: `锚自报存在解析不到的引用：${reportedUnresolved.join('、')}`,
    });
  }

  // -- A4：序号上界 vs 条目总数 —— **当场复算**，并与自报布尔值对照 --
  const allSeqs = [
    ...kernelSeqs,
    ...deliveryIds.map((id) => eventSeqOf(id)).filter((seq): seq is number => seq !== null),
  ];
  const maxSeq = allSeqs.length > 0 ? Math.max(...allSeqs) : null;
  const totalIds = manifest.length + deliveryIds.length;
  const recomputedConsistent = maxSeq === null ? true : maxSeq <= totalIds;
  if (anchor.evt_seq_vs_counts_consistent !== recomputedConsistent) {
    violations.push({
      code: 'A4_selfreport_disagrees_with_recompute',
      detail: `锚自报 evt_seq_vs_counts_consistent=${String(anchor.evt_seq_vs_counts_consistent)}，我复算=${String(recomputedConsistent)}（max_seq=${String(maxSeq)}，条目总数=${totalIds}）`,
    });
  }
  if (!recomputedConsistent) {
    violations.push({
      code: 'A4_seq_exceeds_counts',
      detail: `序号上界 ${String(maxSeq)} > 条目总数 ${totalIds}：有 id 被发出却没出现在本次导出里`,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 取样 1：真实运行里的**最新一条**轨迹（可能与锚无关）
// ---------------------------------------------------------------------------

const traceFiles = listFiles(TRACE_DIR).filter((path) => path.endsWith('.json'));
const realTracePath: string | null = traceFiles.length > 0 ? (traceFiles.sort().at(-1) ?? null) : null;
const realTrace: Trace | null =
  realTracePath === null ? null : (JSON.parse(readFileSync(realTracePath, 'utf8')) as Trace);

// ---------------------------------------------------------------------------
// 取样 2：带锚的轨迹
//   优先用**真实运行**产生的带锚轨迹（本轮已有多份）；一份都没有时才回落到
//   **夹具真实宿主**现场生成（零额度：模型端点是 tests/demo/fixtures/fake-model-server.mjs）。
//   两种来源在报告里**分开写**，不得混成一句。
// ---------------------------------------------------------------------------

interface AnchoredSample {
  readonly source: 'real_run' | 'fixture_run';
  readonly path: string;
  readonly trace: Trace;
  readonly sha256: string;
}

function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function killHard(child: ChildProcess): void {
  const pid = child.pid;
  child.kill();
  if (process.platform === 'win32' && typeof pid === 'number') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已退出即可 */
    }
  }
}

afterAll(() => {
  for (const child of children) killHard(child);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

function startChild(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  readyRegex: RegExp,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    children.push(child);
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`启动超时：${script}\n${buffer}`)), 25_000);
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = readyRegex.exec(buffer);
      const captured = match?.[1];
      if (captured !== undefined) {
        clearTimeout(timer);
        resolve(Number(captured));
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出 code=${String(code)}：${buffer}`));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** 用夹具真实宿主跑一次，拿到**带 anchor** 的轨迹（零真实请求）。 */
async function generateAnchoredTrace(): Promise<Trace> {
  const modelPort = await startChild(FAKE_MODEL, ['0', 'ok'], process.env, /listening on (\d+)/);
  const runDir = mkdtempSync(join(tmpdir(), 's6-trace-run-'));
  tempDirs.push(runDir);
  const hostPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(hostPort),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    POTBOT_RUNTIME_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    ANTHROPIC_AUTH_TOKEN: 's6-fixture-token-not-a-real-secret',
    ANTHROPIC_MODEL: 's6-fixture-model',
  };
  delete env['ANTHROPIC_API_KEY'];
  await startChild(HOST_MAIN, [], env, /绑定：127\.0\.0\.1:(\d+)/);

  const base = `http://127.0.0.1:${hostPort}`;
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok) break;
    } catch {
      /* 等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const created = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: `s6-anchor-${Date.now()}`,
      instruction: '为新生读书会写一封温暖的邀请函，不编造时间地点和报名联系方式。',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (created.status !== 202) throw new Error(`夹具提交失败：HTTP ${created.status}`);
  const { taskId } = (await created.json()) as { taskId: string };
  for (let i = 0; i < 60; i += 1) {
    const poll = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`, { signal: AbortSignal.timeout(5000) });
    const body = (await poll.json()) as { status?: string };
    if (['ready', 'failed', 'interrupted'].includes(String(body.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const tracePathForTask = join(runDir, 'kernel-trace', `${taskId}.json`);
  if (!existsSync(tracePathForTask)) {
    throw new Error(`夹具宿主没有落轨迹：${tracePathForTask}`);
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  copyFileSync(tracePathForTask, join(EVIDENCE_DIR, `anchored-trace-${taskId}.json`));
  return JSON.parse(readFileSync(tracePathForTask, 'utf8')) as Trace;
}

/** 全部**真实**带锚轨迹（按文件路径排序，保持确定性）。 */
const realAnchoredSamples: readonly AnchoredSample[] = traceFiles
  .slice()
  .sort()
  .map((path) => {
    const bytes = readFileSync(path);
    const candidate = JSON.parse(bytes.toString('utf8')) as Trace;
    return { path, trace: candidate, sha256: sha256OfBytes(bytes) };
  })
  .filter((item) => item.trace.anchor !== undefined && item.trace.anchor !== null)
  .map((item): AnchoredSample => ({ source: 'real_run', ...item }));

/** 夹具生成的带锚轨迹：只在**没有任何真实带锚轨迹**时才产生（零额度）。 */
let fixtureSample: AnchoredSample | null = null;
/** 参与变异对照的基底：优先真实，其次夹具。 */
let mutationBase: AnchoredSample | null = null;

beforeAll(async () => {
  if (realAnchoredSamples.length > 0) {
    mutationBase = realAnchoredSamples[0] ?? null;
    return;
  }
  const trace = await generateAnchoredTrace();
  const syntheticPath = join(EVIDENCE_DIR, 'anchored-trace-fixture-generated.json');
  fixtureSample = {
    source: 'fixture_run',
    path: syntheticPath,
    trace,
    sha256: sha256OfBytes(Buffer.from(JSON.stringify(trace), 'utf8')),
  };
  mutationBase = fixtureSample;
}, 180_000);

/** 全部参与复算核对的有锚样本（真实优先；没有真实时才用夹具）。 */
function anchoredSamples(): readonly AnchoredSample[] {
  if (realAnchoredSamples.length > 0) return realAnchoredSamples;
  return fixtureSample === null ? [] : [fixtureSample];
}

function label(sample: AnchoredSample): string {
  const name = sample.path.split(/[\\/]/).pop() ?? sample.path;
  return `${sample.source === 'real_run' ? '真实运行' : '夹具运行'} · ${name}`;
}

/**
 * 变异基底的**深拷贝**。
 *
 * 变异只在内存里做，**绝不写回盘上文件**——真实轨迹是运行证据，不能被测试改动。
 * 文件未被改动的对照臂见文件末尾的 `盘上轨迹文件未被测试改动`。
 */
function cloneBase(): Trace {
  const base = mutationBase?.trace;
  if (base === undefined || base === null) {
    throw new Error('没有可用的变异基底');
  }
  return JSON.parse(JSON.stringify(base)) as Trace;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('内核事件轨迹：切片自身的独立核对（不采信 checkKernelTrace）', () => {
  it('[前置] 存在至少一份真实轨迹', () => {
    expect(traceFiles.length, `[未满足] ${repoRelative(TRACE_DIR)} 下没有轨迹文件`).toBeGreaterThan(0);
    expect(realTrace?.schema).toBe('potbot-kernel-trace.v1');
  });

  it('真实轨迹：我的自有判据零违规', () => {
    expect(realTrace).not.toBeNull();
    const violations = verifyTraceIndependently(realTrace as Trace);
    expect(
      violations,
      `[未通过] 轨迹违反自有判据：\n${violations.map((v) => `${v.code}: ${v.detail}`).join('\n')}`,
    ).toEqual([]);
  });

  it('与**另一个来源**（应用索引）交叉一致：task_id / 产物 id / 轮次 id', () => {
    expect(existsSync(INDEX_PATH), '[未满足] 没有应用索引，无法交叉核对').toBe(true);
    const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as {
      tasks?: readonly { taskId?: string; kernelRuns?: readonly string[]; publishedArtifactId?: string | null }[];
    };
    const task = (index.tasks ?? []).find((item) => item.taskId === realTrace?.task_id);
    expect(task, `索引里找不到轨迹对应的任务 ${String(realTrace?.task_id)}`).toBeDefined();
    expect(realTrace?.artifacts?.[0]?.artifact_id).toBe(task?.publishedArtifactId);
    const runIds = (realTrace?.runs ?? [])
      .map((run) => run.run_id)
      .filter((id): id is string => typeof id === 'string');
    for (const runId of runIds) {
      expect(task?.kernelRuns ?? [], `轮次 ${runId} 必须出现在索引的 kernelRuns 里`).toContain(runId);
    }
  });

  it('T7 是**不可被锚掩盖**的那一条：发布事件必须与磁盘真实字节一致', () => {
    const published = (realTrace?.events ?? []).filter((event) => event.kind === 'artifact_published');
    expect(published.length, '至少要有一次 artifact_published').toBeGreaterThan(0);
    for (const event of published) {
      const finalPath = event.data?.['final_path'];
      expect(typeof finalPath).toBe('string');
      const normalized = normalizePath(String(finalPath));
      expect(existsSync(normalized), `final_path 不存在：${String(finalPath)}`).toBe(true);
      expect(event.data?.['readback_digest']).toBe(sha256OfFile(normalized));
      expect(event.data?.['byte_length']).toBe(readFileSync(normalized).byteLength);
    }
  });
});

describe('轨迹锚：当场复算（不接受自报值）', () => {
  it('[前置] 手里有带锚样本，且**优先是真实运行**产生的', () => {
    expect(anchoredSamples().length, '[未满足] 没有任何带锚样本').toBeGreaterThan(0);
    expect(
      realAnchoredSamples.length,
      '[未满足] 本轮应当有**真实运行**产生的带锚轨迹（夹具只在没有真实样本时才兜底）',
    ).toBeGreaterThan(0);
  });

  it('四份真实带锚轨迹的锚值可逐条读出（原始事实，供报告逐字引用）', () => {
    const lines = realAnchoredSamples.map((sample) => {
      const anchor = sample.trace.anchor ?? {};
      const name = sample.path.split(/[\\/]/).pop() ?? '';
      return (
        `${name}  kernel=${String(anchor.global_kernel_event_count)} max_seq=${String(anchor.global_kernel_max_seq)} ` +
        `delivery=${String(anchor.global_delivery_event_count)}[${(anchor.delivery_event_ids ?? []).map(String).join(',')}] ` +
        `expected/exported=${String(anchor.task_event_count_expected)}/${String(anchor.task_event_count_exported)} ` +
        `unresolved=[${(anchor.unresolved_event_ids ?? []).map(String).join(',')}] consistent=${String(anchor.evt_seq_vs_counts_consistent)}`
      );
    });
    expect(lines.length).toBeGreaterThan(0);
    // 不是判据，是把原始值打出来——报告里的数字直接取自这里。
    expect(lines.every((line) => line.includes('consistent=true'))).toBe(true);
  });

  for (const sample of anchoredSamples()) {
    describe(label(sample), () => {
      it('我的复算判据零违规（含"自报值 vs 复算值"逐项一致）', () => {
        const violations = verifyAnchorIndependently(sample.trace);
        expect(
          violations,
          `[未通过] 锚违反复算判据：\n${violations.map((v) => `${v.code}: ${v.detail}`).join('\n')}`,
        ).toEqual([]);
      });

      it('我自己按 task_id 重新过滤 manifest，结果与切片逐条相同（id **和** kind）', () => {
        const anchor = sample.trace.anchor;
        expect(anchor).toBeTruthy();
        const manifest = anchor?.manifest ?? [];
        const refiltered = manifest.filter((entry) => entry.task_id === sample.trace.task_id);
        const sliceIds = (sample.trace.events ?? []).map((event) => String(event.event_id));
        expect(refiltered.map((entry) => String(entry.event_id))).toEqual(sliceIds);
        // kind 也要对上：只比 id 会放过"同 id 换了事件种类"。
        const sliceKindById = new Map(
          (sample.trace.events ?? []).map((event) => [String(event.event_id), String(event.kind)]),
        );
        for (const entry of refiltered) {
          expect(sliceKindById.get(String(entry.event_id)), `${String(entry.event_id)} 的 kind 必须一致`).toBe(
            String(entry.kind),
          );
        }
      });

      it('我自己解析 `pending_event_id` 的归属：必须落在待投递 id 全集里（不是"被丢弃"）', () => {
        const anchor = sample.trace.anchor;
        const deliveryIds = new Set((anchor?.delivery_event_ids ?? []).map((id) => String(id)));
        const pending: string[] = [];
        for (const event of sample.trace.events ?? []) {
          const value = event.data?.['pending_event_id'];
          if (typeof value === 'string') pending.push(value);
        }
        expect(pending.length, '本样本应当至少有一个 pending_event_id（否则这条判据空过）').toBeGreaterThan(0);
        for (const id of pending) {
          expect(deliveryIds.has(id), `${id} 不在待投递 id 全集里：那才叫"引用了看不到的事件"`).toBe(true);
        }
      });

      it('我自己复算 `max_seq ≤ 两份集合条目总数`，并与自报布尔值一致', () => {
        const anchor = sample.trace.anchor;
        const manifest = anchor?.manifest ?? [];
        const deliveryIds = (anchor?.delivery_event_ids ?? []).map((id) => String(id));
        const seqs = [...manifest, ...deliveryIds.map((id) => ({ event_id: id }))]
          .map((entry) => eventSeqOf(String(entry.event_id)))
          .filter((seq): seq is number => seq !== null);
        const maxSeq = seqs.length > 0 ? Math.max(...seqs) : null;
        const total = manifest.length + deliveryIds.length;
        const recomputed = maxSeq === null ? true : maxSeq <= total;
        expect(recomputed, `复算不成立：max_seq=${String(maxSeq)} > 总条目 ${total}`).toBe(true);
        expect(anchor?.evt_seq_vs_counts_consistent, '自报值必须与复算值一致').toBe(recomputed);
      });
    });
  }

  it('真实锚与**磁盘上真实字节**对齐：发布事件的回读摘要 = 我从产物算出的 sha256', () => {
    let checked = 0;
    for (const sample of realAnchoredSamples) {
      for (const event of sample.trace.events ?? []) {
        if (event.kind !== 'artifact_published') continue;
        const finalPath = event.data?.['final_path'];
        if (typeof finalPath !== 'string') continue;
        const actual = sha256OfFile(normalizePath(finalPath));
        if (actual === null) continue;
        expect(event.data?.['readback_digest'], `${finalPath} 的回读摘要必须等于盘上 sha256`).toBe(actual);
        expect(event.data?.['byte_length']).toBe(readFileSync(normalizePath(finalPath)).byteLength);
        checked += 1;
      }
    }
    expect(checked, '应当至少核对到一份真实产物的发布事件').toBeGreaterThan(0);
  });

  // 「盘上文件逐字节未变」的对照臂放在**变异组之后**（见文件末尾），否则它跑在变异之前、证明不了什么。
});

describe('锚的灵敏度对照：改坏锚，我的复算判据必须变红', () => {
  interface AnchorCase {
    readonly name: string;
    readonly code: string;
    readonly mutate: (trace: Trace) => void;
  }

  const cases: readonly AnchorCase[] = [
    {
      name: 'MA1 切片少一条（锚不动）',
      code: 'A5_export_truncated',
      mutate: (trace) => {
        (trace as { events?: readonly TraceEvent[] }).events = (trace.events ?? []).slice(1);
      },
    },
    {
      name: 'MB2 切片与清单**一起**少一条',
      code: 'A4_seq_exceeds_counts',
      mutate: (trace) => {
        const anchor = trace.anchor;
        if (!anchor) return;
        const dropped = (anchor.manifest ?? [])[0];
        (anchor as { manifest?: readonly ManifestEntry[] }).manifest = (anchor.manifest ?? []).slice(1);
        (trace as { events?: readonly TraceEvent[] }).events = (trace.events ?? []).filter(
          (event) => event.event_id !== dropped?.event_id,
        );
        (anchor as { task_event_count_expected?: unknown }).task_event_count_expected =
          (anchor.manifest ?? []).filter((entry) => entry.task_id === trace.task_id).length;
        (anchor as { task_event_count_exported?: unknown }).task_event_count_exported = (trace.events ?? []).length;
      },
    },
    {
      name: 'MC3 切片塞进一条清单外事件',
      code: 'A2_slice_not_in_manifest',
      mutate: (trace) => {
        const list = [...(trace.events ?? [])];
        const first = list[0];
        if (first !== undefined) list.push({ ...first, event_id: 'evt-9999' });
        (trace as { events?: readonly TraceEvent[] }).events = list;
      },
    },
    {
      name: 'MD4 引用一个导出里找不到的 id',
      code: 'A3_unresolved_reference',
      mutate: (trace) => {
        const artifact = trace.artifacts?.[0];
        if (artifact !== undefined) {
          (artifact as { published_event_id?: unknown }).published_event_id = 'evt-77777';
        }
      },
    },
    {
      name: 'ME5 序号上界与条目总数打架（删掉一条待投递 id）',
      code: 'A4_selfreport_disagrees_with_recompute',
      mutate: (trace) => {
        const anchor = trace.anchor;
        if (!anchor) return;
        (anchor as { delivery_event_ids?: readonly unknown[] }).delivery_event_ids = (
          anchor.delivery_event_ids ?? []
        ).slice(0, Math.max(0, (anchor.delivery_event_ids ?? []).length - 1));
        (anchor as { global_delivery_event_count?: unknown }).global_delivery_event_count = (
          anchor.delivery_event_ids ?? []
        ).length;
      },
    },
    {
      name: 'MF6 锚自报"序号一致"但复算不成立',
      code: 'A4_seq_exceeds_counts',
      mutate: (trace) => {
        const anchor = trace.anchor;
        if (!anchor) return;
        // 把待投递 id 全集**清空**（id 的空间被抽掉一条），同时**保持自报布尔值为 true** ——
        // 这时复算 `max_seq(12) ≤ 11+0` 不成立，而锚仍自称一致：自报与现实打架。
        // （注意：本样本 delivery_event_ids 本来就只有 1 条，砍到 0 条才真的动了数据。）
        (anchor as { delivery_event_ids?: readonly unknown[] }).delivery_event_ids = [];
        (anchor as { global_delivery_event_count?: unknown }).global_delivery_event_count = 0;
        (anchor as { evt_seq_vs_counts_consistent?: unknown }).evt_seq_vs_counts_consistent = true;
      },
    },
    {
      name: 'MG7 清单里某条被改成别的任务（重新过滤就对不上）',
      code: 'A1_manifest_refilter_mismatch',
      mutate: (trace) => {
        const anchor = trace.anchor;
        if (!anchor) return;
        const manifest = [...(anchor.manifest ?? [])];
        const first = manifest[0];
        if (first !== undefined) manifest[0] = { ...first, task_id: 'T-someone-else' };
        (anchor as { manifest?: readonly ManifestEntry[] }).manifest = manifest;
      },
    },
    {
      name: 'MH8 自报的 expected 被伪造（与清单复算不符）',
      code: 'A6_expected_count_selfreport_mismatch',
      mutate: (trace) => {
        const anchor = trace.anchor;
        if (!anchor) return;
        (anchor as { task_event_count_expected?: unknown }).task_event_count_expected = 999;
      },
    },
  ];

  it('[前置] 有可变异的有锚轨迹（基底来源见下方说明）', () => {
    expect(mutationBase?.trace.anchor, '[未满足] 没有带锚轨迹可供变异').toBeTruthy();
  });

  for (const testCase of cases) {
    it(`${testCase.name} ⇒ 必须命中 ${testCase.code}`, () => {
      const mutant = cloneBase();
      testCase.mutate(mutant);
      const codes = verifyAnchorIndependently(mutant).map((violation) => violation.code);
      expect(
        codes,
        `变异体未被抓到（判据无判别力）：期望 ${testCase.code}，实得 [${codes.join(', ')}]`,
      ).toContain(testCase.code);
    });
  }

  it('对照臂：未变异时有锚轨迹零违规（防止判据恒真）', () => {
    expect(verifyAnchorIndependently(cloneBase())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 收尾对照臂：变异只在内存里做，**盘上的真实轨迹必须逐字节未变**
//   （放在变异组之后运行，否则证明不了什么）
// ---------------------------------------------------------------------------

describe('盘上轨迹文件未被测试改动（变异只在内存克隆上进行）', () => {
  it.each(realAnchoredSamples.map((sample) => [label(sample), sample.path, sample.sha256] as const))(
    '%s 的 sha256 与加载时一致',
    (_name, path, expected) => {
      expect(sha256OfBytes(readFileSync(path)), `${path} 被改动了`).toBe(expected);
    },
  );

  it('至少存在一份真实带锚轨迹可核（否则本对照臂空过）', () => {
    expect(realAnchoredSamples.length).toBeGreaterThan(0);
  });
});
