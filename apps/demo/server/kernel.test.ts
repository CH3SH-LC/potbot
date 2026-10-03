/**
 * S3 宿主与调度 —— 单测（**注入 fake 端口**，不碰真实网络、不碰真实磁盘）。
 *
 * 覆盖方案 V3 要求的最小面：
 * 1. 去重（同 ID 同输入回既有、不重复扣额度；同 ID 不同输入 409）；
 * 2. 状态流转（accepted → running → ready；失败路径 不返回旧成果）；
 * 3. 下载摘要核对（被改动 / 缺失一律拒绝）；
 * 4. 重启后诚实中断（在途 interrupted、已完成重新校验、不自动重放）；
 * 5. HTTP 层：合同路由、状态码、错误形状、静态资源防穿越。
 *
 * 纪律：本文件**不复制实现**，断言只经公开面（`KernelHost` / `JobIndex` / HTTP）。
 * fake 端口只代替"外部世界"（模型网络、文件系统），内核与发布链仍是真实的那一套。
 */

import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentPort, MaterializeReceipt, MaterializeRequest } from '../documents/port.js';
import { DocumentPortError, createDocumentPort } from '../documents/port.js';
import type { DraftInput, ModelPort } from '../model/port.js';
import { buildDocxTemplate, digestBytes } from '../../../src/artifacts/index.js';
import { createDemoRequestHandler } from './http.js';
import { JobIndex, createMemoryPersistence, deriveTaskId } from './jobs.js';
import {
  KernelHost,
  SOURCE_FACT_KEY,
  checkKernelTrace,
  validateDraft,
  type KernelTrace,
  type KernelTracePersistence,
} from './kernel.js';

// ---------------------------------------------------------------------------
// fake 端口（只代替外部世界；不代替内核）
// ---------------------------------------------------------------------------

interface FakeDocumentPort extends DocumentPort {
  readonly store: Map<string, Uint8Array>;
  readonly calls: number;
  remove(artifactId: string): void;
  tamper(artifactId: string): void;
}

/** 内存文档端口：真实做"写盘 + 回读摘要核对"的语义，只是载体换成了 Map。 */
function createFakeDocumentPort(rootDir = 'C:/fake-artifacts'): FakeDocumentPort {
  const store = new Map<string, Uint8Array>();
  let calls = 0;
  return {
    store,
    get calls(): number {
      return calls;
    },
    async materialize(req: MaterializeRequest): Promise<MaterializeReceipt> {
      calls += 1;
      const digest = digestBytes(req.bytes);
      if (digest !== req.expectedSha256) {
        throw new DocumentPortError(
          'digest_mismatch',
          '调用方给的字节与 expectedSha256 不符（写盘之前就拒绝）',
        );
      }
      const copy = Uint8Array.from(req.bytes);
      store.set(req.artifactId, copy);
      const path = `${rootDir}/${req.filename}`;
      // 回读核对：与预期摘要不符即结构化失败（不静默交付）。
      const back = store.get(req.artifactId);
      if (back === undefined || digestBytes(back) !== req.expectedSha256) {
        throw new DocumentPortError('readback_digest_mismatch', '回读核对不符');
      }
      return { artifactId: req.artifactId, path, byteLength: copy.byteLength, sha256: digest };
    },
    async readBack(artifactId: string): Promise<Uint8Array | undefined> {
      return store.get(artifactId);
    },
    remove(artifactId: string): void {
      store.delete(artifactId);
    },
    tamper(artifactId: string): void {
      const bytes = store.get(artifactId);
      if (bytes !== undefined) {
        store.set(artifactId, new Uint8Array([...bytes, 0x41]));
      }
    },
  };
}

interface FakeModelPort extends ModelPort {
  readonly calls: number;
}

/** 顺序应答的模型端口：每次调用返回下一个脚本项（抛错也照脚本走）。 */
function createFakeModelPort(script: readonly (DraftInput | Error)[]): FakeModelPort {
  let index = 0;
  let calls = 0;
  return {
    provider: 'fake-provider',
    model: 'fake-model',
    get calls(): number {
      return calls;
    },
    async generateDraft(): Promise<DraftInput> {
      const entry = script[Math.min(index, script.length - 1)];
      index += 1;
      calls += 1;
      if (entry === undefined) {
        throw new Error('fake 模型脚本为空');
      }
      if (entry instanceof Error) {
        throw entry;
      }
      return entry;
    },
  };
}

/** 永不返回的模型端口：用来构造"在途"状态（测重启中断）。 */
function createHangingModelPort(): ModelPort {
  return {
    provider: 'fake-hanging',
    model: 'fake-hanging',
    generateDraft(): Promise<DraftInput> {
      return new Promise<DraftInput>(() => {
        // 故意永不 resolve：进程退出时不留下定时器。
      });
    },
  };
}

/** 合同形状：`paragraphs: [{id, text}]`（**不是**字符串数组）。 */
const GOOD_DRAFT: DraftInput = {
  title: '读书会邀请函',
  paragraphs: [
    { id: 'p1', text: '亲爱的新同学，欢迎你加入我们的读书会。' },
    { id: 'p2', text: '这里没有标准答案，只有愿意一起把一本书读透的人。' },
    { id: 'p3', text: '带上你正在读的那本书，来和大家聊一聊。' },
  ],
};

const INSTRUCTION = '为新生读书会写一封温暖的邀请函，不要编造时间地点和报名方式';

// ---------------------------------------------------------------------------
// 器具
// ---------------------------------------------------------------------------

/** 内存轨迹收集器（单测用；生产实现见 main.ts 的 createFileTracePersistence）。 */
function createMemoryTraceSink(): KernelTracePersistence & {
  readonly traces: Map<string, KernelTrace>;
} {
  const traces = new Map<string, KernelTrace>();
  return {
    traces,
    save(taskId: string, trace: KernelTrace): void {
      traces.set(taskId, trace);
    },
  };
}

interface Harness {
  readonly jobs: JobIndex;
  readonly host: KernelHost;
  readonly documents: FakeDocumentPort;
  readonly model: ModelPort;
  readonly traces: Map<string, KernelTrace>;
}

function makeHarness(options: {
  readonly script?: readonly (DraftInput | Error)[];
  readonly model?: ModelPort;
  readonly persistence?: ReturnType<typeof createMemoryPersistence>;
  readonly modelIsLive?: boolean;
}): Harness {
  const jobs = new JobIndex({
    persistence: options.persistence ?? createMemoryPersistence(),
    runId: 'MWD-TEST',
  });
  const documents = createFakeDocumentPort();
  const model =
    options.model ?? createFakeModelPort(options.script ?? [GOOD_DRAFT, GOOD_DRAFT, GOOD_DRAFT]);
  const sink = createMemoryTraceSink();
  const host = new KernelHost({
    jobs,
    runDir: 'C:/fake-run',
    artifactRootDir: 'C:/fake-run/artifacts',
    model,
    modelIsLive: options.modelIsLive ?? false,
    documents,
    traces: sink,
    buildId: 'build-test',
  });
  return { jobs, host, documents, model, traces: sink.traces };
}

async function waitFor<T>(
  probe: () => T | undefined,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForStatus(host: KernelHost, taskId: string, wanted: string): Promise<void> {
  await waitFor(
    () => (host.taskResponse(taskId)?.status === wanted ? true : undefined),
    `任务 ${taskId} 进入 ${wanted}`,
  );
}

/** 读真实输出的 STORE ZIP 部件；不调用模板的渲染函数来推导期望内容。 */
function docxPart(bytes: Uint8Array, path: string): string {
  const buffer = Buffer.from(bytes);
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (method !== 0 || dataStart + size > buffer.length) throw new Error('输出不是有效 STORE ZIP');
    if (name === path) return buffer.toString('utf8', dataStart, dataStart + size);
    offset = dataStart + size;
  }
  throw new Error(`DOCX 缺部件 ${path}`);
}

function docxParagraphs(bytes: Uint8Array): string[] {
  return [...docxPart(bytes, 'word/document.xml').matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => (match[1] ?? '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
}

// ---------------------------------------------------------------------------
// 1. 去重
// ---------------------------------------------------------------------------

describe('POST /api/documents 的去重语义', () => {
  it('相同 requestId + 相同输入返回既有任务，且不新增任务、不重复扣额度', () => {
    const h = makeHarness({});
    const first = h.jobs.submit('req-dup-1', INSTRUCTION);
    expect(first.kind).toBe('created');
    const again = h.jobs.submit('req-dup-1', INSTRUCTION);
    expect(again.kind).toBe('existing');
    expect(again.kind === 'existing' && again.task.taskId).toBe(
      first.kind === 'created' ? first.task.taskId : '',
    );
    expect(h.jobs.list()).toHaveLength(1);
    // 去重路径不触发任何模型请求：额度笔数为 0。
    expect(h.jobs.budgetUsed()).toBe(0);
  });

  it('相同 requestId + 不同输入返回 conflict（HTTP 409）', () => {
    const h = makeHarness({});
    h.jobs.submit('req-dup-2', INSTRUCTION);
    const conflict = h.jobs.submit('req-dup-2', '换一个完全不同的要求');
    expect(conflict.kind).toBe('conflict');
  });

  it('instruction 为空或超长时结构化拒绝', () => {
    const h = makeHarness({});
    expect(h.jobs.submit('req-bad-1', '   ').kind).toBe('invalid');
    const tooLong = h.jobs.submit('req-bad-2', 'a'.repeat(4001));
    expect(tooLong.kind).toBe('invalid');
    expect(tooLong.kind === 'invalid' && tooLong.error.code).toBe('instruction_too_long');
  });


  it('输入编码体检：U+FFFD 与裸控制字符被结构化拒绝，且零额度消耗', () => {
    const h = makeHarness({});
    // ① 解码失败的产物（替换字符 U+FFFD）：这是"编码在某一层被搞坏"的确定信号。
    //    实测教训：终端按 GBK 把中文交给 curl.exe，服务端收到乱码，模型据此写出跑题内容，
    //    表面像是"模型不守题"。当场拒绝比事后误诊便宜得多。
    const mojibake = h.jobs.submit('req-broken-enc', '\uFFFD\uFFFD\uFFFD');
    expect(mojibake.kind).toBe('invalid');
    expect(mojibake.kind === 'invalid' && mojibake.error.code).toBe('instruction_encoding_broken');
    expect(mojibake.kind === 'invalid' && mojibake.error.retryable).toBe(false);
    expect(mojibake.kind === 'invalid' && mojibake.error.message.length).toBeGreaterThan(0);

    // ② 不该出现的裸控制字符：BEL / ESC / DEL / NEL（C1）。
    const badControls = [0x0007, 0x001b, 0x007f, 0x0085].map((cp) => String.fromCodePoint(cp));
    for (const bad of badControls) {
      const codePoint = bad.codePointAt(0) ?? 0;
      const rejected = h.jobs.submit(`req-ctrl-${codePoint}`, `写一封邀请函${bad}谢谢`);
      expect(rejected.kind, `含 U+${codePoint.toString(16)} 的输入应被拒绝`).toBe('invalid');
      expect(rejected.kind === 'invalid' && rejected.error.code).toBe(
        'instruction_control_characters',
      );
    }

    // ③ **反向对照（必须有）**：正常中文 / 日文 / emoji / 制表与换行**一律放行**——
    //    没有这一条，上面两条就可能只是"把正常请求也打死了"。
    const ok = h.jobs.submit(
      'req-normal-i18n',
      '为新生读书会写邀请函 🎉\n\t温暖一点，别编造时间地点。日本語もOK',
    );
    expect(ok.kind).toBe('created');
    const record = ok.kind === 'created' ? ok.task : undefined;
    expect(record?.instruction).toContain('🎉');
    expect(record?.instruction).toContain('读书会');
    expect(record?.instruction).toContain('日本語');

    // ④ 被拒的输入不建任务、不扣额度（体检发生在落库、去重与扣额度之前）。
    expect(h.jobs.list()).toHaveLength(1);
    expect(h.jobs.budgetUsed()).toBe(0);
  });

  it('requestId 非法形态被拒绝（不产生任务、不产生路径段）', () => {
    const h = makeHarness({});
    expect(h.jobs.submit('../etc/passwd', '写点什么').kind).toBe('invalid');
    expect(h.jobs.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 状态流转与真实链路
// ---------------------------------------------------------------------------

describe('真实内核链路（fake 外部世界）', () => {
  it('受理 → 运行 → ready，且内核事件里同时有 artifact_staged 与 artifact_published', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-happy-1', INSTRUCTION);
    expect(submitted.kind).toBe('created');
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');

    const response = h.host.taskResponse(taskId);
    expect(response?.draft?.provenance).toBe('model_generated');
    expect(response?.draft?.paragraphs).toHaveLength(3);
    expect(response?.artifact?.sha256).toHaveLength(64);
    expect(response?.artifact?.artifactId).toMatch(/^art-/);
    expect(response?.artifact?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    const kinds = h.host.scheduler.kernelEvents().map((event) => event.kind);
    expect(kinds).toContain('run_started');
    expect(kinds).toContain('artifact_staged');
    expect(kinds).toContain('artifact_published');

    // 下载：字节与登记的摘要逐字节一致。
    const download = await h.host.downloadArtifact(response?.artifact?.artifactId ?? '');
    expect(download.kind).toBe('ok');
    if (download.kind === 'ok') {
      expect(digestBytes(download.bytes)).toBe(response?.artifact?.sha256);
      expect(download.kernelRecordPresent).toBe(true);
    }
  });

  it('模型失败：任务 failed、不产出产物、不沿用任何旧成果；宿主**不叠加**自己的重试', async () => {
    const model = createFakeModelPort([new Error('网络断了：模型不可用'), new Error('还是不通')]);
    const h = makeHarness({ model });
    const submitted = h.host.submit('req-fail-1', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'failed');

    const response = h.host.taskResponse(taskId);
    expect(response?.artifact).toBeUndefined();
    expect(response?.error?.code).toBe('model_failed');
    // 重试权只有一处归属（S4 的端口）。宿主每任务只调一次 generateDraft —— 两层不相乘。
    expect(model.calls).toBe(1);
    expect(h.jobs.budgetUsed()).toBe(1);
    const record = h.jobs.findByTaskId(taskId);
    expect(record?.attempts).toBe(1);
    expect(record?.kernelRuns).toHaveLength(1);
  });

  it('每任务至多 2 次真实请求（模型层的重试是**唯一**一处重试，不与宿主相乘）', async () => {
    // 模拟 S4 端口的真实行为：**一次 `generateDraft` 调用内部**至多打 2 次真实请求
    // （`MODEL_MAX_ATTEMPTS = 2`），第 2 次成功就正常返回，不把错误抛给宿主。
    let generateDraftCalls = 0;
    let realRequests = 0;
    const retryingPort: ModelPort = {
      provider: 'fake-retrying',
      model: 'fake-retrying',
      async generateDraft(): Promise<DraftInput> {
        generateDraftCalls += 1;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          realRequests += 1;
          if (attempt === 2) {
            return GOOD_DRAFT;
          }
        }
        throw new Error('unreachable');
      },
    };
    const h = makeHarness({ model: retryingPort });
    const submitted = h.host.submit('req-single-retry', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');

    // 宿主只发 1 次调用；端口内部重试 1 次。合计 2 次 = 合同「每任务总尝试至多 2 次」。
    expect(generateDraftCalls).toBe(1);
    expect(realRequests).toBe(2);
    expect(realRequests).toBeLessThanOrEqual(2);
    // 宿主层只登记 1 笔（额度是 app 级尝试的记账，真实额度以 S4 的账本为准）。
    expect(h.jobs.budgetUsed()).toBe(1);
    expect(h.host.taskResponse(taskId)?.status).toBe('ready');
  });

  it('失败时也不超过 2 次真实请求（宿主不叠加第二次尝试）', async () => {
    let realRequests = 0;
    const failingPort: ModelPort = {
      provider: 'fake-failing',
      model: 'fake-failing',
      async generateDraft(): Promise<DraftInput> {
        // 端口内部把 2 次机会都打光后，抛给宿主（模拟 S4 端口的 "N 次尝试后仍未成功"）。
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          realRequests += 1;
        }
        throw Object.assign(new Error('两次都不通'), {
          code: 'model_network_error',
          retryable: true,
        });
      },
    };
    const h = makeHarness({ model: failingPort });
    const submitted = h.host.submit('req-single-retry-fail', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'failed');
    // 宿主**没有**在端口失败后再补一次：合计仍是 2 次。
    expect(realRequests).toBe(2);
    expect(h.host.taskResponse(taskId)?.status).toBe('failed');
  });

  it('模型失败的用户文案是中文说明，原始技术文本只留在宿主备注里', async () => {
    const model = createFakeModelPort([
      Object.assign(new Error('bad port'), { code: 'model_network_error', retryable: false }),
    ]);
    const h = makeHarness({ model });
    const submitted = h.host.submit('req-msg-1', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'failed');
    const response = h.host.taskResponse(taskId);
    expect(response?.error?.message).toBe(
      '无法连接模型服务（连接被拒绝或网络不可达），请检查网络后重试',
    );
    // 原始 errno 文案不上屏。
    expect(response?.error?.message).not.toContain('bad port');
    expect(h.jobs.findByTaskId(taskId)?.note).toContain('bad port');
  });

  it('前一个任务成功、后一个任务失败时，失败任务**绝不**沿用上一次的产物', async () => {
    const notRetryable = Object.assign(new Error('连接被断开：模型后端不可用'), {
      code: 'model_network_error',
      retryable: false,
    });
    const model = createFakeModelPort([GOOD_DRAFT, notRetryable]);
    const h = makeHarness({ model });

    const first = h.host.submit('req-chain-ok', INSTRUCTION);
    const firstTaskId = first.kind === 'created' ? first.task.taskId : '';
    await waitForStatus(h.host, firstTaskId, 'ready');
    const firstArtifact = h.host.taskResponse(firstTaskId)?.artifact;
    expect(firstArtifact).toBeDefined();

    const second = h.host.submit('req-chain-fail', '换一个主题，写一封读书会通知');
    const secondTaskId = second.kind === 'created' ? second.task.taskId : '';
    await waitForStatus(h.host, secondTaskId, 'failed');

    const failed = h.host.taskResponse(secondTaskId);
    // ① 响应体里**没有** artifact 字段（不是空对象、不是上一次的引用）。
    expect(failed?.artifact).toBeUndefined();
    expect('artifact' in (failed ?? {})).toBe(false);
    // ② 失败原因结构完整：稳定 code + 中文说明 + retryable。
    expect(failed?.error?.code).toBe('model_network_error');
    expect(failed?.error?.retryable).toBe(false);
    expect((failed?.error?.message ?? '').length).toBeGreaterThan(0);
    // ③ 第一个任务的产物仍在，但只属于它的 artifactId；两次 artifactId 不同。
    const secondRecord = h.jobs.findByTaskId(secondTaskId);
    expect(secondRecord?.artifact).toBeNull();
    expect(firstArtifact?.artifactId).not.toBe(secondRecord?.publishedArtifactId);
  });

  it('草稿不合规（段数/空白段）被结构化拒绝，且不把失败说成成功', async () => {
    const bad: DraftInput = { title: '只有一段', paragraphs: [{ id: 'x', text: '孤零零一段' }] };
    const model = createFakeModelPort([bad, bad]);
    const h = makeHarness({ model });
    const submitted = h.host.submit('req-bad-draft', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'failed');
    const response = h.host.taskResponse(taskId);
    expect(response?.error?.code).toBe('draft_too_few_paragraphs');
    expect(response?.artifact).toBeUndefined();
  });

  it('额度用尽后不再发出请求（闸门在请求之前）', async () => {
    const jobs = new JobIndex({ persistence: createMemoryPersistence(), runId: 'R', budgetLimit: 1 });
    const documents = createFakeDocumentPort();
    const model = createFakeModelPort([new Error('第一次就失败'), GOOD_DRAFT]);
    const host = new KernelHost({
      jobs,
      runDir: 'C:/fake-run',
      artifactRootDir: 'C:/fake-run/artifacts',
      model,
      modelIsLive: false,
      documents,
      buildId: 'b',
    });
    const submitted = host.submit('req-budget', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(host, taskId, 'failed');
    // 宿主层每任务只发一次请求，因此第一笔就用掉了唯一额度；第二次受理会被宿主闸门拦住。
    expect(jobs.budgetUsed()).toBe(1);
    expect(host.taskResponse(taskId)?.error?.code).toBe('model_failed');

    const second = host.submit('req-budget-2', '再写一篇');
    const secondTaskId = second.kind === 'created' ? second.task.taskId : '';
    await waitForStatus(host, secondTaskId, 'failed');
    expect(host.taskResponse(secondTaskId)?.error?.code).toBe('budget_exhausted');
    expect(jobs.budgetUsed()).toBe(1);
  });

  it('额度上限 24 且台账已有 18 笔时**仍放行**（宿主闸门不再硬编码 12 拦住显式配置）', async () => {
    const persistence = createMemoryPersistence();
    // 第一段：把台账预置到 18 笔（模拟账本里已有 18 条 reservation 的现场状态）。
    const seed = new JobIndex({ persistence, runId: 'R', budgetLimit: 24 });
    for (let index = 0; index < 18; index += 1) {
      expect(seed.reserveBudget('T-预置', index + 1, '预置').granted).toBe(true);
    }
    expect(seed.budgetUsed()).toBe(18);

    // 第二段：新台账（同持久化）按 24 启动 → 读回 18 笔 → 提交必须放行。
    const jobs = new JobIndex({ persistence, runId: 'R', budgetLimit: 24 });
    expect(jobs.hydrate().loaded).toBe(true);
    expect(jobs.budgetUsed()).toBe(18);
    expect(jobs.budgetLimit).toBe(24);

    const model = createFakeModelPort([GOOD_DRAFT]);
    const host = new KernelHost({
      jobs,
      runDir: 'C:/fake-run',
      artifactRootDir: 'C:/fake-run/artifacts',
      model,
      modelIsLive: false,
      documents: createFakeDocumentPort(),
      buildId: 'b',
    });
    const submitted = host.submit('req-budget-24', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(host, taskId, 'ready');
    expect(host.taskResponse(taskId)?.error).toBeUndefined();
    expect(model.calls).toBe(1);
    expect(jobs.budgetUsed()).toBe(19);
  });

  it('对照：同样 18 笔预置、上限仍是默认 12 时**必须被拦**（证明上一条不是空断言）', async () => {
    const persistence = createMemoryPersistence();
    const seed = new JobIndex({ persistence, runId: 'R', budgetLimit: 24 });
    for (let index = 0; index < 18; index += 1) {
      seed.reserveBudget('T-预置', index + 1, '预置');
    }

    // 唯一差别：上限取默认（12）。若把上一条里 `budgetLimit: 24` 去掉，上一条也会走到这里。
    const jobs = new JobIndex({ persistence, runId: 'R' });
    // 读回那 18 笔（生产路径里由 `boot()` 完成；这里显式调用以免写成空台账的空断言）。
    expect(jobs.hydrate().loaded).toBe(true);
    expect(jobs.budgetUsed()).toBe(18);
    expect(jobs.budgetLimit).toBe(12);
    const model = createFakeModelPort([GOOD_DRAFT]);
    const host = new KernelHost({
      jobs,
      runDir: 'C:/fake-run',
      artifactRootDir: 'C:/fake-run/artifacts',
      model,
      modelIsLive: false,
      documents: createFakeDocumentPort(),
      buildId: 'b',
    });
    const submitted = host.submit('req-budget-12', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(host, taskId, 'failed');
    expect(host.taskResponse(taskId)?.error?.code).toBe('budget_exhausted');
    expect(host.taskResponse(taskId)?.error?.message).toContain('12');
    // 被拦在**请求之前**：模型一次都没被调到。
    expect(model.calls).toBe(0);
  });

  it('模型端口缺失时如实失败（model_not_configured），不伪造生成', async () => {
    const jobs = new JobIndex({ persistence: createMemoryPersistence(), runId: 'R' });
    const host = new KernelHost({
      jobs,
      runDir: 'C:/fake-run',
      artifactRootDir: 'C:/fake-run/artifacts',
      model: null,
      modelIsLive: false,
      documents: createFakeDocumentPort(),
      buildId: 'b',
    });
    const submitted = host.submit('req-nomodel', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(host, taskId, 'failed');
    expect(host.taskResponse(taskId)?.error?.code).toBe('model_not_configured');
    expect(host.health().modelConfigured).toBe(false);
  });

  it('modelVerified 只在 live 端口真实跑通一次后为真', async () => {
    const offline = makeHarness({ modelIsLive: false });
    const off = offline.host.submit('req-verify-off', INSTRUCTION);
    await waitForStatus(offline.host, off.kind === 'created' ? off.task.taskId : '', 'ready');
    expect(offline.host.health().modelVerified).toBe(false);

    const live = makeHarness({ modelIsLive: true });
    const on = live.host.submit('req-verify-on', INSTRUCTION);
    await waitForStatus(live.host, on.kind === 'created' ? on.task.taskId : '', 'ready');
    expect(live.host.health().modelVerified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 下载核对
// ---------------------------------------------------------------------------

describe('下载：每次重新回读核对摘要', () => {
  it('文件被改动 ⇒ 409，拒绝下载', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-tamper', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');
    const artifactId = h.host.taskResponse(taskId)?.artifact?.artifactId ?? '';
    h.documents.tamper(artifactId);
    const outcome = await h.host.downloadArtifact(artifactId);
    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' && outcome.error.code).toBe('artifact_digest_mismatch');
    expect(outcome.kind === 'error' && outcome.httpStatus).toBe(409);
  });

  it('文件缺失 ⇒ 410，不用其它内容顶替', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-missing', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');
    const artifactId = h.host.taskResponse(taskId)?.artifact?.artifactId ?? '';
    h.documents.remove(artifactId);
    const outcome = await h.host.downloadArtifact(artifactId);
    expect(outcome.kind === 'error' && outcome.error.code).toBe('artifact_file_missing');
    expect(outcome.kind === 'error' && outcome.httpStatus).toBe(410);
  });

  it('未知产物 ⇒ 404（不接收任意磁盘路径）', async () => {
    const h = makeHarness({});
    const outcome = await h.host.downloadArtifact('art-不存在的产物');
    expect(outcome.kind === 'error' && outcome.httpStatus).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4. 重启后的诚实中断
// ---------------------------------------------------------------------------

describe('宿主重启：诚实中断与重新校验', () => {
  it('在途任务标 interrupted，且不自动重放模型调用', async () => {
    const persistence = createMemoryPersistence();
    const running = makeHarness({ model: createHangingModelPort(), persistence });
    const submitted = running.host.submit('req-inflight', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(running.host, taskId, 'running');

    // 模拟宿主重启：同一份持久化载体，全新的宿主与全新的内核 store。
    const restarted = makeHarness({ persistence });
    const report = await restarted.host.boot();
    expect(report.interrupted).toContain(taskId);
    const response = restarted.host.taskResponse(taskId);
    expect(response?.status).toBe('interrupted');
    expect(response?.error?.code).toBe('host_restart_interrupted');
    expect(response?.artifact).toBeUndefined();
    // 没有自动重放：重启后的宿主里没有新的轮次。
    expect(restarted.host.scheduler.kernelEvents()).toHaveLength(0);
  });

  it('长时非终态：服务端持续如实返回真实 status/stage，不自作超时改成 failed/unknown（裁定二）', async () => {
    const h = makeHarness({ model: createHangingModelPort() });
    const submitted = h.host.submit('req-longrun', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'running');

    // 连续多次轮询（模拟页面长时间等待）：状态保持 running，且**没有**被服务端改写。
    for (let round = 0; round < 5; round += 1) {
      const response = h.host.taskResponse(taskId);
      expect(response?.status).toBe('running');
      expect(response?.stage).toBe('model_pending');
      expect(response?.error).toBeUndefined();
      expect(response?.artifact).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // 服务端不设人为超时：任何"跑得慢就当失败"的改写都不存在。
    expect(h.jobs.findByTaskId(taskId)?.error).toBeNull();
  });

  it('已完成文件在重启后重新校验通过即可继续下载（内核 store 为空是事实，另行标注）', async () => {
    const persistence = createMemoryPersistence();
    const first = makeHarness({ persistence });
    const submitted = first.host.submit('req-restart-ok', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(first.host, taskId, 'ready');
    const artifactId = first.host.taskResponse(taskId)?.artifact?.artifactId ?? '';
    const bytes = first.documents.store.get(artifactId);
    expect(bytes).toBeDefined();

    // 重启后的文档端口读的仍是同一份"盘上字节"（用同一 Map 模拟同一块盘）。
    const restarted = new KernelHost({
      jobs: new JobIndex({ persistence, runId: 'MWD-TEST' }),
      runDir: 'C:/fake-run',
      artifactRootDir: 'C:/fake-run/artifacts',
      model: createFakeModelPort([GOOD_DRAFT]),
      modelIsLive: false,
      documents: first.documents,
      buildId: 'b2',
    });
    const report = await restarted.boot();
    expect(report.revalidated_ready).toContain(taskId);

    const after = restarted.taskResponse(taskId);
    expect(after?.status).toBe('ready');
    const download = await restarted.downloadArtifact(artifactId);
    expect(download.kind).toBe('ok');
    if (download.kind === 'ok') {
      // 内核 store 已空：放行依据是应用索引里发布时登记的摘要，必须如实标出。
      expect(download.kernelRecordPresent).toBe(false);
      expect(download.sha256).toBe(after?.artifact?.sha256);
    }
  });

  it('重启后文件已被改动 ⇒ 降级为 unknown，不冒充可下载', async () => {
    const persistence = createMemoryPersistence();
    const first = makeHarness({ persistence });
    const submitted = first.host.submit('req-restart-bad', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(first.host, taskId, 'ready');
    const artifactId = first.host.taskResponse(taskId)?.artifact?.artifactId ?? '';
    first.documents.tamper(artifactId);

    const restarted = new KernelHost({
      jobs: new JobIndex({ persistence, runId: 'MWD-TEST' }),
      runDir: 'C:/fake-run',
      artifactRootDir: 'C:/fake-run/artifacts',
      model: createFakeModelPort([GOOD_DRAFT]),
      modelIsLive: false,
      documents: first.documents,
      buildId: 'b3',
    });
    await restarted.boot();
    expect(restarted.taskResponse(taskId)?.status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 5. 观察记录
// ---------------------------------------------------------------------------

describe('观察记录：只记录，不改写内核 published', () => {
  it('download_verified / user_reported_opened 只进应用台账', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-obs', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');
    const artifactId = h.host.taskResponse(taskId)?.artifact?.artifactId ?? '';

    const before = h.host.scheduler
      .snapshot()
      .artifacts?.find((record) => String(record.artifact_id) === artifactId);
    expect(before?.status).toBe('published');

    const outcome = h.host.recordObservation(artifactId, {
      observationId: 'obs-1',
      kind: 'user_reported_opened',
      detail: '用户说他在手机办公软件里打开了',
    });
    expect(outcome.httpStatus).toBe(200);

    const after = h.host.scheduler
      .snapshot()
      .artifacts?.find((record) => String(record.artifact_id) === artifactId);
    // 内核记录一字未改：用户自述没有被升格成机器验证。
    expect(after).toEqual(before);
    expect(h.jobs.observations()).toHaveLength(1);
    expect(h.jobs.observations()[0]?.kind).toBe('user_reported_opened');
  });

  it('观察写入失败 ⇒ 200 + recorded:false，**绝不** 5xx（裁定一）', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-obs-persist-fail', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');
    const artifactId = h.host.taskResponse(taskId)?.artifact?.artifactId ?? '';

    // 让持久化在**写观察**这一步抛错（模拟磁盘满 / 权限问题）。
    const original = h.jobs.recordObservation.bind(h.jobs);
    Object.defineProperty(h.jobs, 'recordObservation', {
      configurable: true,
      value: () => {
        throw new Error('磁盘写入失败（模拟）');
      },
    });
    const outcome = h.host.recordObservation(artifactId, {
      observationId: 'obs-fail',
      kind: 'download_verified',
      detail: '页面取回字节后核对',
    });
    void original;
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toEqual({ observationId: 'obs-fail', recorded: false });
    // 任务本身**没有**被这次失败波及：仍是 ready，产物仍在。
    const after = h.host.taskResponse(taskId);
    expect(after?.status).toBe('ready');
    expect(after?.artifact).toBeDefined();
  });

  it('非法 kind 被结构化拒绝（400）；未知产物是 404，不与参数错误混为一谈', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-obs-bad', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');
    const artifactId = h.host.taskResponse(taskId)?.artifact?.artifactId ?? '';

    const badKind = h.host.recordObservation(artifactId, {
      observationId: 'o',
      kind: 'not_a_kind' as never,
      detail: '',
    });
    expect(badKind.httpStatus).toBe(400);
    expect((badKind.body as { readonly code?: string }).code).toBe('invalid_observation_kind');

    const unknown = h.host.recordObservation('art-不存在', {
      observationId: 'o2',
      kind: 'download_verified',
      detail: '',
    });
    expect(unknown.httpStatus).toBe(404);

    // 两种情况都不该往台账里写任何东西。
    expect(h.jobs.observations()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 草稿校验（纯函数）
// ---------------------------------------------------------------------------

describe('validateDraft', () => {
  const cases: readonly [string, unknown][] = [
    ['非对象', 42],
    ['标题为空', { title: '  ', paragraphs: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] }],
    ['段落非数组', { title: 'T', paragraphs: 'nope' }],
    ['段落过少', { title: 'T', paragraphs: [{ id: 'a', text: 'x' }] }],
    [
      '段落过多',
      {
        title: 'T',
        paragraphs: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), text: `第${String(n)}段` })),
      },
    ],
    [
      '空白段',
      { title: 'T', paragraphs: [{ id: 'a', text: 'x' }, { id: 'b', text: '   ' }] },
    ],
    [
      '超长正文',
      {
        title: 'T',
        paragraphs: [{ id: 'a', text: 'x'.repeat(1500) }, { id: 'b', text: 'y'.repeat(600) }],
      },
    ],
  ];

  for (const [label, input] of cases) {
    it(`拒绝：${label}`, () => {
      expect(validateDraft(input).ok).toBe(false);
    });
  }

  it('通过：段落 id 由宿主规范化为 p1…pn（不采信模型给的 id）', () => {
    const result = validateDraft({
      title: '  标题  ',
      paragraphs: [
        { id: '模型自造-1', text: '  第一段  ' },
        { id: '<script>', text: '第二段\n换行折叠' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.title).toBe('标题');
      expect(result.draft.paragraphs.map((p) => p.id)).toEqual(['p1', 'p2']);
      expect(result.draft.paragraphs[1]?.text).toBe('第二段 换行折叠');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. HTTP 层
// ---------------------------------------------------------------------------

describe('HTTP 层（真实 node:http 服务）', () => {
  let server: Server | null = null;
  let webRoot: string | null = null;

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (webRoot !== null) {
      rmSync(webRoot, { recursive: true, force: true });
      webRoot = null;
    }
  });

  async function listen(host: KernelHost, webDir: string): Promise<string> {
    server = createServer(createDemoRequestHandler({ host, webDir }));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('未能取得监听端口');
    }
    return `http://127.0.0.1:${String(address.port)}`;
  }

  it('GET /health、POST /api/documents（202 + 去重 409）、GET /api/tasks、download、observations', async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'potbot-demo-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>t</title>', 'utf8');
    mkdirSync(join(webRoot, 'sub'), { recursive: true });
    writeFileSync(join(webRoot, 'sub', 'a.js'), 'console.log(1)', 'utf8');
    writeFileSync(join(webRoot, '..', 'outside-secret.txt'), 'secret', 'utf8');

    const h = makeHarness({});
    const base = await listen(h.host, webRoot);

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody['ready']).toBe(true);
    expect(healthBody['modelConfigured']).toBe(true);
    expect(healthBody['modelVerified']).toBe(false);
    expect(typeof healthBody['buildId']).toBe('string');
    expect(typeof healthBody['bootId']).toBe('string');

    const created = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'http-req-1', instruction: INSTRUCTION }),
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody['status']).toBe('accepted');
    const taskId = String(createdBody['taskId']);
    expect(taskId).toBe(deriveTaskId('http-req-1'));

    // 同 ID 同输入 ⇒ 仍是 202（既有任务），不 409。
    const duplicate = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'http-req-1', instruction: INSTRUCTION }),
    });
    expect(duplicate.status).toBe(202);

    // 同 ID 不同输入 ⇒ 409。
    const conflict = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'http-req-1', instruction: '换一个要求' }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as Record<string, unknown>;
    expect(conflictBody['code']).toBe('duplicate_request_conflict');
    expect(typeof conflictBody['message']).toBe('string');
    expect(typeof conflictBody['retryable']).toBe('boolean');

    // 非法 JSON ⇒ 400 且是 DemoError 形状。
    const badJson = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);

    // 编码体检在 HTTP 层同样生效：乱码输入当场拒绝，不进模型、不建任务。
    const mojibake = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'http-broken-enc',
        instruction: '\uFFFD\uFFFD\uFFFD',
      }),
    });
    expect(mojibake.status).toBe(400);
    const mojibakeBody = (await mojibake.json()) as Record<string, unknown>;
    expect(mojibakeBody['code']).toBe('instruction_encoding_broken');
    expect(mojibakeBody['retryable']).toBe(false);

    const controlChar = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'http-ctrl', instruction: '\u0007\u0007' }),
    });
    expect(controlChar.status).toBe(400);
    expect(((await controlChar.json()) as Record<string, unknown>)['code']).toBe(
      'instruction_control_characters',
    );
    expect(h.jobs.list()).toHaveLength(1);

    await waitForStatus(h.host, taskId, 'ready');

    const task = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`);
    expect(task.status).toBe(200);
    const taskBody = (await task.json()) as Record<string, unknown>;
    expect(taskBody['status']).toBe('ready');
    const artifact = taskBody['artifact'] as Record<string, unknown>;
    const artifactId = String(artifact['artifactId']);

    const download = await fetch(`${base}/api/artifacts/${encodeURIComponent(artifactId)}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('x-content-sha256')).toBe(String(artifact['sha256']));
    const downloaded = new Uint8Array(await download.arrayBuffer());
    expect(digestBytes(downloaded)).toBe(artifact['sha256']);

    const observed = await fetch(
      `${base}/api/artifacts/${encodeURIComponent(artifactId)}/observations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          observationId: 'http-obs-1',
          kind: 'user_reported_opened',
          detail: '用户自述已打开',
        }),
      },
    );
    expect(observed.status).toBe(200);
    expect(((await observed.json()) as Record<string, unknown>)['recorded']).toBe(true);

    // 未知任务 / 未知接口 ⇒ 404。
    expect((await fetch(`${base}/api/tasks/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
  });

  it('静态服务：同源取页，且拒绝路径穿越', async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'potbot-demo-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>demo</title>', 'utf8');
    writeFileSync(join(webRoot, '..', 'outside-secret.txt'), 'secret', 'utf8');
    const h = makeHarness({});
    const base = await listen(h.host, webRoot);

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('demo');

    // 编码过的穿越尝试：必须被拒绝，且不返回目录外的文件。
    const traversal = await fetch(`${base}/%2e%2e/outside-secret.txt`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('secret');
    const traversalPlain = await fetch(`${base}/../outside-secret.txt`);
    expect(traversalPlain.status).toBe(404);

    expect((await fetch(`${base}/missing.html`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'DELETE' })).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// 8. 端口形状兼容（S4/S5 的真实实现若能构造，行为应与 fake 同）
// ---------------------------------------------------------------------------

describe('真实文档端口（S5）端到端：真写盘 + 真回读', () => {
  it('宿主经 S5 端口写出真实 DOCX，内核记录 published，下载再回读仍一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'potbot-artifacts-'));
    try {
      const documents = createDocumentPort(root);
      // 先保存历史模式文件；新策略只能创建新产物，不能原地清理旧文件。
      const legacy = buildDocxTemplate({
        requirement: {
          title: GOOD_DRAFT.title,
          description: '历史文档',
          paragraphs: GOOD_DRAFT.paragraphs.map((paragraph) => paragraph.text),
        },
        fact_snapshot: [],
        references: [{ label: '历史来源', detail: '保持原始文件供追溯' }],
      });
      await documents.materialize({
        artifactId: 'legacy-preserved', filename: '读书会邀请函.docx',
        bytes: legacy.bytes, expectedSha256: legacy.content_digest,
      });
      const jobs = new JobIndex({ persistence: createMemoryPersistence(), runId: 'MWD-REAL' });
      const host = new KernelHost({
        jobs,
        runDir: join(root, 'run'),
        artifactRootDir: root.split('\\').join('/'),
        model: createFakeModelPort([GOOD_DRAFT]),
        modelIsLive: false,
        documents,
        buildId: 'build-real',
      });
      const finish = vi.spyOn(host.scheduler, 'finishRun');

      const submitted = host.submit('req-real-port', INSTRUCTION);
      const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
      await waitForStatus(host, taskId, 'ready');

      const artifact = host.taskResponse(taskId)?.artifact;
      expect(artifact).toBeDefined();
      const artifactId = artifact?.artifactId ?? '';

      // ① 盘上确实有这份文件，且是一个可解析的 ZIP（DOCX 容器）。
      const onDisk = await documents.readBack(artifactId);
      expect(onDisk).toBeDefined();
      const bytes = onDisk ?? new Uint8Array();
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(digestBytes(bytes)).toBe(artifact?.sha256);
      expect(bytes[0]).toBe(0x50); // 'P'
      expect(bytes[1]).toBe(0x4b); // 'K' —— ZIP 本地文件头
      expect(docxParagraphs(bytes)).toEqual([
        GOOD_DRAFT.title, ...GOOD_DRAFT.paragraphs.map((paragraph) => paragraph.text),
      ]);
      expect(docxPart(bytes, 'docProps/custom.xml')).toContain('name="PotbotDocumentPresentation"');
      expect(docxPart(bytes, 'docProps/custom.xml')).toContain('<vt:lpwstr>title-body-v1</vt:lpwstr>');

      // ② 文件名经过 S5 的白名单规范化（单段、.docx 后缀）。
      expect(artifact?.filename.endsWith('.docx')).toBe(true);
      expect(artifact?.filename).not.toContain('/');
      expect(artifact?.filename).not.toContain('\\');

      // ③ 内核记录是 published（不是 staged），且带真实回读摘要。
      const record = host.scheduler
        .snapshot()
        .artifacts?.find((candidate) => String(candidate.artifact_id) === artifactId);
      expect(record?.status).toBe('published');
      expect(record?.receipt?.readback_digest).toBe(artifact?.sha256);
      expect(record?.receipt?.entry_count).toBeGreaterThan(0);
      const source = host.scheduler.snapshot().shared_facts.find((fact) => fact.fact_key === SOURCE_FACT_KEY);
      expect(source?.value).toMatchObject({ kind: 'known', value: { type: 'text', text: INSTRUCTION } });
      expect(source?.source.kind).toBe('external');
      expect(record?.source_fact_refs).toEqual([source?.fact_id]);
      // 观察真实 finishRun 返回值，确认快照并未为了隐藏栏目而清空。
      const staged = finish.mock.results[0]?.value?.artifact_facts[0];
      expect(staged?.request.fact_snapshot).toHaveLength(1);
      expect(staged?.request.fact_snapshot[0]).toMatchObject({
        fact_key: SOURCE_FACT_KEY, fact_ref: source?.fact_id,
        value: { type: 'text', text: INSTRUCTION },
      });
      expect(await documents.readBack('legacy-preserved')).toEqual(legacy.bytes);
      expect(artifactId).not.toBe('legacy-preserved');

      // ④ 下载走的是"重新回读"，摘要与登记一致。
      const download = await host.downloadArtifact(artifactId);
      expect(download.kind).toBe('ok');
      if (download.kind === 'ok') {
        expect(digestBytes(download.bytes)).toBe(artifact?.sha256);
        expect(download.kernelRecordPresent).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('经过 Demo 内核的用户正文可包含来源栏目同名词句和真实引用，逐段原样交付', async () => {
    const draft: DraftInput = {
      title: '资料引用与已确认事实',
      paragraphs: [
        { id: 'p1', text: '这里讨论已确认事实、资料引用和模型声明，并保留 source.user_request 示例。' },
        { id: 'p2', text: '资料引用：作者原文中的“雨 & 风”与 <窗前> 意象。' },
      ],
    };
    const h = makeHarness({ script: [draft] });
    const submitted = h.host.submit('req-user-references', '写一段说明，保留正文中出现的引用与栏目词句');
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');
    const artifactId = h.host.taskResponse(taskId)?.artifact?.artifactId ?? '';
    const download = await h.host.downloadArtifact(artifactId);
    expect(download.kind).toBe('ok');
    if (download.kind !== 'ok') return;
    expect(docxParagraphs(download.bytes)).toEqual([
      draft.title, ...draft.paragraphs.map((paragraph) => paragraph.text),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 9. 内核事件轨迹（S6 独立验收的取证面）
// ---------------------------------------------------------------------------

/** 造一个"改坏了的"轨迹（控制实验用；只改被测的那一处，其余原样）。 */
function mutateTrace(trace: KernelTrace, patch: Partial<KernelTrace>): KernelTrace {
  return { ...trace, ...patch } as KernelTrace;
}

describe('内核事件轨迹：可交叉核对，不是事后拼的', () => {
  it('正常路径：消息 / 轮次 / staged / published 与回执齐全，且三 id 对得上', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-trace-ok', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');

    const trace = h.traces.get(taskId);
    expect(trace).toBeDefined();
    if (trace === undefined) return;
    expect(trace.schema).toBe('potbot-kernel-trace.v1');
    expect(trace.task_id).toBe(taskId);
    expect(trace.host_error).toBeNull();

    // ① 完整性判据（与独立复核共用同一个纯函数）。
    const verdict = checkKernelTrace(trace, { expectPublished: true });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);

    // ② 消息：内核入口受理的那一条，request id 就是本轮的工作请求。
    const kernelRequestId = `req-${taskId.replace(/^T-/, '')}-a1`;
    expect(trace.messages).toHaveLength(1);
    expect(trace.messages[0]?.request_id).toBe(kernelRequestId);
    expect(trace.messages[0]?.message_id).toBe(`msg-${taskId.replace(/^T-/, '')}-a1`);

    // ③ 轮次：run id 属于本任务，冻结的正是那条请求，且 started/finished 都有事件。
    expect(trace.runs).toHaveLength(1);
    const run = trace.runs[0];
    expect(run?.run_id).toBe(h.jobs.findByTaskId(taskId)?.kernelRuns[0]);
    expect(run?.frozen_request_ids).toContain(kernelRequestId);
    expect(run?.started_event_id).not.toBeNull();
    expect(run?.finished_event_id).not.toBeNull();
    expect(run?.finished_at).not.toBeNull();

    // ④ 产物：staged 与 published 事件同 artifact_id，回执与落库记录一致。
    expect(trace.artifacts).toHaveLength(1);
    const artifact = trace.artifacts[0];
    const apiArtifact = h.host.taskResponse(taskId)?.artifact;
    expect(artifact?.artifact_id).toBe(apiArtifact?.artifactId);
    expect(artifact?.request_ids).toContain(kernelRequestId);
    expect(artifact?.staged_event_id).not.toBeNull();
    expect(artifact?.staged_expected_digest).toBe(apiArtifact?.sha256);
    expect(artifact?.published_event_id).not.toBeNull();
    expect(artifact?.published_byte_length).toBe(apiArtifact?.byteLength);
    expect(artifact?.published_readback_digest).toBe(apiArtifact?.sha256);
    expect(artifact?.record_receipt_readback_digest).toBe(apiArtifact?.sha256);
    expect(artifact?.published_entry_count).toBeGreaterThan(0);
    expect(artifact?.task_revision).toBe(apiArtifact?.taskRevision);
    expect(artifact?.artifact_version).toBe(apiArtifact?.artifactVersion);

    // ⑤ 交叉核对链：轮次冻结请求 → 工作项 → result_refs → 产物 id → 事件里的 artifact_id。
    const workItem = trace.work_items.find((item) => String(item.request_id) === kernelRequestId);
    expect(workItem?.status).toBe('completed');
    expect(workItem?.result_refs.map(String)).toContain(artifact?.artifact_id);
    const stagedEvent = trace.events.find((event) => event.kind === 'artifact_staged');
    const publishedEvent = trace.events.find((event) => event.kind === 'artifact_published');
    expect(stagedEvent?.data['artifact_id']).toBe(artifact?.artifact_id);
    expect(publishedEvent?.data['artifact_id']).toBe(artifact?.artifact_id);
    // 事件里的 run_id 与轮次记录的 run_id 是同一个（不是两套编号）。
    expect(stagedEvent?.task_id).toBe(taskId);
    expect(trace.events.every((event) => event.task_id === taskId)).toBe(true);
  });

  it('切片之外的锚：全局规模 / 清单 / 引用归属都在，且序列号关系自洽（S6 的 N9）', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-anchor', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');

    const trace = h.traces.get(taskId);
    expect(trace).toBeDefined();
    if (trace === undefined) return;
    const anchor = trace.anchor;

    // ① 锚必须是**未过滤**集合的规模，且与切片取自同一次快照。
    const allEvents = h.host.scheduler.kernelEvents();
    expect(anchor.global_kernel_event_count).toBe(allEvents.length);
    expect(anchor.manifest).toHaveLength(allEvents.length);
    // 全局序号上界必须等于从**全量**算出来的，不能用切片内最大值冒充。
    const globalIds = allEvents.map((event) => String(event.event_id));
    const trueMax = Math.max(...globalIds.map((id) => Number(/(?:^|\/)evt-(\d+)$/.exec(id)?.[1] ?? 0)));
    expect(anchor.global_kernel_max_seq).toBe(trueMax);
    expect(anchor.global_kernel_max_seq).toBeGreaterThan(0);

    // ② 本任务条数：全量现算 == 切片实际（相等才说明没被裁剪）。
    expect(anchor.task_event_count_expected).toBe(trace.events.length);
    expect(anchor.task_event_count_exported).toBe(trace.events.length);
    // 用清单**独立复算**一遍过滤结果，与切片逐条对上。
    const recomputed = anchor.manifest.filter((entry) => entry.task_id === taskId);
    expect(recomputed.map((entry) => entry.event_id)).toEqual(
      trace.events.map((event) => String(event.event_id)),
    );

    // ③ 引用归属：`pending_event_id` 这类外部引用必须能在本次快照的集合里定位到。
    //    复核方要能**自己**判断，因此锚必须交出待投递事件的 id 全集，而不只是条数。
    expect(anchor.unresolved_event_ids).toEqual([]);
    expect(anchor.delivery_event_ids.length).toBe(anchor.global_delivery_event_count);
    const pendingRefs = anchor.referenced_event_ids.filter((ref) => ref.field === 'pending_event_id');
    expect(pendingRefs.length).toBeGreaterThan(0);
    for (const ref of pendingRefs) {
      expect(ref.resolved_in === 'kernel_events' || ref.resolved_in === 'delivery_events').toBe(true);
    }
    // S6 举的那个例子：`pending_event_id` 指向的是**待投递集合**里的 id（不在内核事件切片里），
    // 但它在本次导出里**确实存在**——因此"引用不到"才算缺口，"不在切片里"本身不是。
    expect(pendingRefs.every((ref) => anchor.delivery_event_ids.includes(ref.event_id))).toBe(true);
    expect(anchor.manifest.some((entry) => entry.event_id === pendingRefs[0]?.event_id)).toBe(false);

    // ④ 序号与条目总数的一致性关系（两份集合共用同一个 evt 计数器）。
    expect(anchor.evt_seq_vs_counts_consistent).toBe(true);
    expect(anchor.global_kernel_max_seq).toBeLessThanOrEqual(
      anchor.manifest.length + anchor.global_delivery_event_count,
    );

    expect(checkKernelTrace(trace, { expectPublished: true }).ok).toBe(true);
  });

  it('失败路径同样落轨迹：轮次有始有终、无产物、失败原因标明来源', async () => {
    const model = createFakeModelPort([
      Object.assign(new Error('bad port'), { code: 'model_network_error', retryable: false }),
    ]);
    const h = makeHarness({ model });
    const submitted = h.host.submit('req-trace-fail', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'failed');

    const trace = h.traces.get(taskId);
    expect(trace).toBeDefined();
    if (trace === undefined) return;

    expect(trace.messages).toHaveLength(1);
    expect(trace.runs).toHaveLength(1);
    expect(trace.runs[0]?.finished_event_id).not.toBeNull();
    expect(trace.artifacts).toHaveLength(0);

    // 失败原因：`failed` 完成发布的原因**只落在工作项记录上**（内核没有对应事件），
    // 轨迹如实标 `kernel_record`，不冒充内核事件。
    const recordFailure = trace.failures.find((failure) => failure.kind === 'work_item_failed');
    expect(recordFailure?.source).toBe('kernel_record');
    expect((recordFailure?.detail ?? '').length).toBeGreaterThan(0);
    // 宿主侧原因单独存放，标为宿主来源。
    expect(trace.host_error?.code).toBe('model_network_error');

    const verdict = checkKernelTrace(trace, { expectPublished: false });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('发布被内核拒绝时，轨迹里带上内核的 publication_rejected 原因事件', async () => {
    // 让模型写出无法追溯到事实的数字 ⇒ 内核在暂存阶段结构化拒绝该条发布。
    const withDigits: DraftInput = {
      title: '邀请函',
      paragraphs: [
        { id: 'p1', text: '请于 2099 年 3 月 15 日参加读书会。' },
        { id: 'p2', text: '地点在图书馆 5 楼。' },
      ],
    };
    const h = makeHarness({ model: createFakeModelPort([withDigits]) });
    const submitted = h.host.submit('req-trace-rejected', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'failed');

    const trace = h.traces.get(taskId);
    expect(trace).toBeDefined();
    if (trace === undefined) return;
    expect(trace.host_error?.code).toBe('artifact_not_staged');
    const rejected = trace.failures.find((failure) => failure.kind === 'publication_rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.source).toBe('kernel_event');
    expect(rejected?.event_id).not.toBeNull();
    expect(rejected?.request_id).not.toBeNull();
    expect((rejected?.detail ?? '').length).toBeGreaterThan(0);
    expect(trace.artifacts).toHaveLength(0);
  });

  it('对照：故意漏一条事件 / 混入别的任务的事件时，判据必须变红（避免空断言）', async () => {
    const h = makeHarness({});
    const submitted = h.host.submit('req-trace-control', INSTRUCTION);
    const taskId = submitted.kind === 'created' ? submitted.task.taskId : '';
    await waitForStatus(h.host, taskId, 'ready');
    const good = h.traces.get(taskId);
    expect(good).toBeDefined();
    if (good === undefined) return;

    // 基线必须绿——否则下面的变红证明不了任何东西。
    expect(checkKernelTrace(good, { expectPublished: true }).ok).toBe(true);

    const cases: readonly [string, KernelTrace][] = [
      [
        '漏掉 artifact_published 事件',
        mutateTrace(good, {
          events: good.events.filter((event) => event.kind !== 'artifact_published'),
        }),
      ],
      [
        '漏掉 message_accepted 事件',
        mutateTrace(good, {
          events: good.events.filter((event) => event.kind !== 'message_accepted'),
        }),
      ],
      [
        '漏掉轮次的 run_finished 事件（轮次有始无终）',
        mutateTrace(good, {
          events: good.events.filter((event) => event.kind !== 'run_finished'),
        }),
      ],
      [
        '混入别的任务的事件',
        mutateTrace(good, {
          events: Object.freeze([
            ...good.events,
            { ...good.events[0], task_id: 'T-别的任务' } as (typeof good.events)[number],
          ]),
        }),
      ],
      [
        '产物没有任何工作项的 result_refs 指向它',
        mutateTrace(good, {
          artifacts: good.artifacts.map((artifact) =>
            Object.assign({}, artifact, { request_ids: Object.freeze([]) }),
          ),
        }),
      ],
      [
        '发布事件回读摘要与落库回执不一致',
        mutateTrace(good, {
          artifacts: good.artifacts.map((artifact) =>
            Object.assign({}, artifact, { published_readback_digest: 'deadbeef' }),
          ),
        }),
      ],
      ['期望产出 published 但一份都没有', mutateTrace(good, { artifacts: Object.freeze([]) })],
      // —— 以下是 S6 的 N9（切片被裁剪）的对照臂 ——
      [
        '只导出一部分事件（切片少一条，锚不动）',
        mutateTrace(good, { events: Object.freeze(good.events.slice(1)) }),
      ],
      [
        '切片与清单一起少一条（锚声明的总数没跟着改）',
        mutateTrace(good, {
          events: Object.freeze(good.events.slice(1)),
          anchor: {
            ...good.anchor,
            task_event_count_exported: good.anchor.task_event_count_exported - 1,
            manifest: Object.freeze(good.anchor.manifest.slice(1)),
          },
        }),
      ],
      [
        '切片里塞进一条清单里没有的事件',
        mutateTrace(good, {
          events: Object.freeze([
            ...good.events,
            { ...good.events[0], event_id: 'evt-999' } as (typeof good.events)[number],
          ]),
        }),
      ],
      [
        '引用了一个本次导出里找不到的事件 id',
        mutateTrace(good, {
          events: Object.freeze(
            good.events.map((event) =>
              Object.assign({}, event, {
                data: { ...event.data, pending_event_id: 'evt-424242' },
              }),
            ),
          ),
        }),
      ],
      [
        '序号上界与导出条目总数打架（有 id 被发出却没导出）',
        mutateTrace(good, {
          anchor: {
            ...good.anchor,
            global_delivery_event_count: 0,
            delivery_event_ids: Object.freeze([]),
          },
        }),
      ],
      [
        '锚自报"序号一致"但当场复算不成立',
        mutateTrace(good, {
          anchor: { ...good.anchor, global_kernel_max_seq: 99999 },
        }),
      ],
    ];

    for (const [label, mutant] of cases) {
      const verdict = checkKernelTrace(mutant, { expectPublished: true });
      expect(verdict.ok, `「${label}」应当被判据拒绝`).toBe(false);
      expect(verdict.problems.length, `「${label}」应当给出至少一条问题`).toBeGreaterThan(0);
    }

    // 反向对照：expectPublished=false 时，"没有产物"本身不算问题（失败路径是合法的）。
    expect(checkKernelTrace(mutateTrace(good, { artifacts: Object.freeze([]) }), {
      expectPublished: false,
    }).problems).not.toContain('本次任务期望产出已发布文件，但轨迹里一份 published 产物都没有');
  });
});

describe('端口形状', () => {
  it('fake 模型端口满足 S4 的 ModelPort 形状', () => {
    const port: ModelPort = createFakeModelPort([GOOD_DRAFT]);
    expect(typeof port.generateDraft).toBe('function');
    expect(typeof port.provider).toBe('string');
    expect(typeof port.model).toBe('string');
  });
});
