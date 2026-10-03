/**
 * FA-WIRE-ROLES-REACH 的定向套件：`src/roles/**`（三种基础角色）**产品可达**的判据。
 *
 * 这一套要回答的不是"文件被 import 了"，而是"角色真的被用上了"。因此每一组都分两半：
 *
 * | 组 | 正向（真使用） | 反向对照（拿掉守门的那一项就会变红） |
 * |---|---|---|
 * | 可达性自证 | 5 个模块逐个 import + **真实调用**；常量与源码一致 | —— |
 * | ROLE-01 | 创建/续接/取消**真写内核 `Store`** | 直接产产物 ⇒ 422 且库无产物；越界动作面 ⇒ 抛 `RoleBoundaryError` |
 * | ROLE-02 | 本任务必要信息放行 | 个人历史 / 跨任务引用**必须被剔除且如实登记** |
 * | ROLE-03 | 终态任务 ⇒ 固化经验 | **在途任务提经验必须被拒**（422 且库 0 条）；权限改写 ⇒ `RoleBoundaryError` |
 * | 端口缺席 | —— | 缺 `Store` / `MemoryRepository` ⇒ 具名 503（不是 500、不是 404、不假装可用） |
 * | 能力发现（N-7-1） | 注入目录 ⇒ 真按 query 过滤 | 目录**未装配** ⇒ 503 `no_capability_directory`（**不是** `200 ok:true capabilities:[]`） |
 * | 只读视图（N-7-2） | `status` 谈就绪与依赖 | `reachability` 谈模块清单；两者**不得**逐字相同（别名关系即缺陷） |
 *
 * 取数只用**真实构造器**（`createMemoryStore` / `createTaskRecord` / `createWorkItem` /
 * `createRunRecord` / `createSharedFactRecord` / `createMemoryRepository`）。产物记录是
 * **结构桩**（只填终态派生真正读的字段），与 `experience-wiring.test.ts` 同一手法并在此注明。
 * 不接模型、不接真机、不起真实端口。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  asFactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  asTemplateId,
  createGroupMember,
  createInstanceState,
  createRunRecord,
  createSharedFactRecord,
  createTaskRecord,
  createWorkItem,
  nextRevision,
  type ArtifactRecord,
  type RunRecord,
  type Store,
  type TaskId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryRepository,
  type ExperienceContext,
  type MemoryRepository,
  type OwnerId,
} from '../../../src/memory/index.js';
import {
  EXPERIENCE_AGENT_SURFACE,
  FORK_CHANNELS,
  INFO_SCOPES,
  ROLE_IDS,
  ROLE_KINDS,
  RoleBoundaryError,
  acceptedEntries,
  aggregateQuestions,
  assertMainAgentSurface,
  assertNoPrivilegeMutation,
  buildForkContext,
  createStructuralMainAgentPorts,
  deliverWithoutFork,
  flowProceedsWithoutExperienceReview,
  forkIsMandatory,
  handleMainAgentRequest,
  isDirectExecutionAction,
  isFixedReviewerOf,
  makeForkSignal,
  proposeExperienceCandidates,
  recoverStagnation,
  requireForkRecoveryBudget,
  requireNonEmptyString,
  reviewExperienceCandidates,
  routeForkMessage,
  type ScopedInfoItem,
  type SealedEvidence,
  type TaskScope,
} from '../../../src/roles/index.js';

import {
  ROLES_MODULES_REACHABLE_BY_WIRING,
  ROLES_ROOT,
  RolesWiringError,
  declaredMainAgentSurface,
  handleRolesRequest,
  rolesReadinessOf,
  type RolesWiringOptions,
} from './roles-wiring.js';

// ---------------------------------------------------------------------------
// HTTP 夹具（自带 node:http 形状的假 req/res；不监听真实端口）
// ---------------------------------------------------------------------------

/** 解析后的 JSON 响应体（形状随用例而变，测试内按需投影）。 */
type Json = any;

interface Captured {
  status: number;
  body: Json;
}

function fakeReq(body: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return Readable.from([payload]) as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number): unknown {
      captured.status = status;
      return res;
    },
    end(text?: string): unknown {
      captured.body = text === undefined || text === '' ? undefined : JSON.parse(text);
      return res;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function call(
  options: RolesWiringOptions,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ readonly handled: boolean; readonly status: number; readonly body: Json }> {
  const { res, captured } = fakeRes();
  const handled = await handleRolesRequest(
    { method, pathname, url: new URL(`http://127.0.0.1${pathname}`), req: fakeReq(body), res },
    options,
  );
  return { handled, status: captured.status, body: captured.body };
}

// ---------------------------------------------------------------------------
// 内核存储夹具（真实构造器）
// ---------------------------------------------------------------------------

const GROUP = asGroupId('G-1');
const INSTANCE = asInstanceId('I-1');

function memoryStore(): Store {
  return createMemoryStore({ clock: () => asLogicalTime(0) });
}

/** 终态产物的**结构桩**：只填终态派生真正读的字段（形状最小，不是真实构造器）。 */
function deliveredArtifact(taskId: TaskId): ArtifactRecord {
  return {
    artifact_id: `A-${String(taskId)}`,
    task_id: taskId,
    status: 'published',
    task_revision: 1,
    receipt: { readback_digest: 'd', final_path: '/p' },
  } as unknown as ArtifactRecord;
}

interface SeedOptions {
  readonly taskId: TaskId;
  readonly requestId: string;
  readonly inFlight: boolean;
  readonly withFact?: boolean;
  readonly factId?: string;
  readonly factText?: string;
}

/** 种一个真任务：任务记录 + 实例 + 群成员 + 完成/在途工作项（+ 可选事实）。 */
function seedTask(store: Store, options: SeedOptions): void {
  const at = asLogicalTime(0);
  const requestId = options.requestId;
  const workItem: WorkItem = createWorkItem({
    request_id: asRequestId(requestId),
    task_id: options.taskId,
    owner_instance_id: INSTANCE,
    created_at: at,
    status: 'completed',
    blocker_reason: null,
    dependency_refs: [],
    failure_reason: null,
  });
  const run: RunRecord = createRunRecord({
    run_id: asRunId('RUN-LIVE'),
    task_id: options.taskId,
    group_id: GROUP,
    instance_id: INSTANCE,
    task_revision: asRevision(1),
    started_at: at,
    lease_deadline: asLogicalTime(120), // now = 0 ⇒ **未过期** ⇒ 在途
    status: 'running',
  });
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: options.taskId,
        title: `任务 ${String(options.taskId)}`,
        goal: '种子任务',
        current_group_id: GROUP,
        revision: asRevision(1),
        created_at: at,
        updated_at: at,
      }),
    );
    tx.putInstance(createInstanceState({ instance_id: INSTANCE, group_id: GROUP, updated_at: at }));
    tx.putGroupMember(createGroupMember({ group_id: GROUP, instance_id: INSTANCE, registered_at: at }));
    tx.putWorkItem(workItem);
    if (options.inFlight) {
      tx.putRun(run);
    } else {
      tx.putArtifact(deliveredArtifact(options.taskId));
    }
    if (options.withFact === true) {
      tx.putSharedFact(
        createSharedFactRecord({
          fact_id: asFactRef(options.factId ?? 'F-1'),
          task_id: options.taskId,
          task_revision: asRevision(1),
          fact_key: 'headcount',
          value: {
            kind: 'known',
            value: { type: 'text', text: options.factText ?? '本任务事实内容', source: '用户输入' },
          },
          source: { kind: 'external', detail: '测试种子' },
          confirmed_by: INSTANCE,
          confirmed_at: at,
        }),
      );
    }
  });
}

const OWNER: OwnerId = asOwnerId('owner-u1');
const TEMPLATE = asTemplateId('WF-001');

function evidence(lesson: string, sealed = true, readback = true): SealedEvidence {
  return {
    evidence_ref: `ev-${lesson}`,
    template_id: TEMPLATE,
    sealed,
    readback_verified: readback,
    outcome: 'success',
    lesson,
    applies_to_version: 'v1',
  };
}

const SOURCE_PATH = fileURLToPath(new URL('./roles-wiring.ts', import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 1. 可达性自证
// ---------------------------------------------------------------------------

describe('可达性自证：src/roles 的 5 个模块都被真实调用', () => {
  it('覆盖清单恰是 5 个模块，且与产品常量一致', () => {
    expect([...ROLES_MODULES_REACHABLE_BY_WIRING]).toEqual([
      'src/roles/index.ts',
      'src/roles/types.ts',
      'src/roles/main-agent.ts',
      'src/roles/group-fork.ts',
      'src/roles/experience-agent.ts',
    ]);
  });

  it('静态判据：源码对每个模块都有具名 import（不是靠桶转一手充数）', () => {
    for (const specifier of [
      "'../../../src/roles/index.js'",
      "'../../../src/roles/types.js'",
      "'../../../src/roles/main-agent.js'",
      "'../../../src/roles/group-fork.js'",
      "'../../../src/roles/experience-agent.js'",
    ]) {
      expect(SOURCE).toContain(specifier);
    }
  });

  it('静态判据：源码对每个模块都有真实调用点', () => {
    // 尺子有刻度：换成任意一个不存在的标识符，这里必须变红。
    for (const token of [
      'ROLE_IDS',
      'ROLE_KINDS',
      'handleMainAgentRequest(',
      'buildForkContext(',
      'assertNoPrivilegeMutation(',
    ]) {
      expect(SOURCE).toContain(token);
    }
    expect(SOURCE).not.toContain('handleMainAgentRequestX(');
  });

  it('运行期：index.ts 的公开出口真的可用（角色 id 与角色种数）', () => {
    expect(ROLE_KINDS).toHaveLength(3);
    expect(ROLE_IDS.main_agent).toBe('role.main-agent');
    expect(ROLE_IDS.group_fork).toBe('role.group-fork');
    expect(ROLE_IDS.experience_agent).toBe('role.experience-agent');
  });

  it('运行期：types.ts 的边界原语真的可用（非空校验 + 越界错误 + 信息范围）', () => {
    expect(requireNonEmptyString('x', 'f')).toBe('x');
    expect(() => requireNonEmptyString('', 'f')).toThrow(RoleBoundaryError);
    const error = new RoleBoundaryError('group_fork', '越界演示');
    expect(error.role).toBe('group_fork');
    expect(error.message).toContain('role.group-fork');
    expect([...INFO_SCOPES]).toEqual(['task', 'personal_history']);
  });

  it('运行期：main-agent.ts 真的拦下直接执行动作', () => {
    const ports = createStructuralMainAgentPorts(asTaskId('T-reach-1'));
    const outcome = handleMainAgentRequest(ports, {
      kind: 'direct_execution',
      action: 'produce_office_artifact',
      detail: '可达性自证',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('direct_execution_forbidden');
    expect(isDirectExecutionAction('produce_office_artifact')).toBe(true);
    expect(() => assertMainAgentSurface(['produce_office_artifact'])).toThrow(RoleBoundaryError);
  });

  it('运行期：group-fork.ts 真的裁剪上下文与汇总问题', () => {
    const items: ScopedInfoItem[] = [
      { ref: 'F-1', scope: 'task', text: '放行' },
      { ref: 'P-1', scope: 'personal_history', text: '不得放行' },
    ];
    const scope: TaskScope = { task_id: asTaskId('T-reach-1'), group_id: GROUP, visible_refs: ['F-1'] };
    const context = buildForkContext(items, scope);
    expect(context.items.map((item) => item.ref)).toEqual(['F-1']);
    expect(context.excluded_refs).toEqual(['P-1']);
    expect([...FORK_CHANNELS]).toEqual(['uplink', 'downlink']);
    const signal = makeForkSignal({
      channel: 'uplink',
      kind: 'question',
      from_instance_id: INSTANCE,
      task_id: asTaskId('T-reach-1'),
      at: asLogicalTime(1),
      text: '缺一份数据',
      question_key: 'need-data',
    });
    expect(aggregateQuestions([signal])[0]?.question_key).toBe('need-data');
    expect(routeForkMessage({ edges: [], fork_instance_id: INSTANCE }, INSTANCE, INSTANCE).route).toBe('direct');
    expect(forkIsMandatory({ edges: [], fork_instance_id: INSTANCE }, [])).toBe(false);
  });

  it('运行期：experience-agent.ts 真的能提候选 / 裁决 / 挡权限改写', () => {
    expect([...EXPERIENCE_AGENT_SURFACE.may_not_modify]).toEqual(['permission_grant', 'tool_address_change']);
    const proposal = proposeExperienceCandidates([evidence('可达性经验')]);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.rejections).toEqual([]);
    const repository = createMemoryRepository();
    const context: ExperienceContext = {
      owner_id: OWNER,
      existing: [],
      isSensitive: () => false,
      detectConflict: () => false,
      source: { kind: 'tool_result', detail: '可达性自证' },
      newMemoryId: () => asMemoryId('reach-1'),
    };
    const review = reviewExperienceCandidates(proposal.candidates, context, asLogicalTime(1));
    expect(review.decisions).toHaveLength(1);
    expect(acceptedEntries(review)).toHaveLength(1);
    expect(repository.listByKind('template_experience')).toHaveLength(0); // 裁决不动库（落库是宿主的事）
    expect(() =>
      assertNoPrivilegeMutation({ kind: 'permission_grant', target: 't', detail: 'x' }),
    ).toThrow(RoleBoundaryError);
    expect(flowProceedsWithoutExperienceReview({ flow_id: 'f', mandatory_roles: [] })).toBe(true);
    expect(isFixedReviewerOf({ flow_id: 'f', mandatory_roles: ['experience_agent'] })).toBe(true);
  });

  it('前缀外一律不接管（不是本模块的请求返回 false）', async () => {
    const result = await call({}, 'GET', '/api/conversations');
    expect(result.handled).toBe(false);
  });

  it('`/api/roles/reachability` 与本文件的覆盖清单一致（产品面自证）', async () => {
    const result = await call({}, 'GET', `${ROLES_ROOT}/reachability`);
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body.reachable_modules).toEqual([...ROLES_MODULES_REACHABLE_BY_WIRING]);
    expect(result.body.roles.map((role: { kind: string }) => role.kind)).toEqual([...ROLE_KINDS]);
    expect(result.body.surfaces.fork_channels).toEqual([...FORK_CHANNELS]);
  });
});

// ---------------------------------------------------------------------------
// 2. ROLE-01 前台主智能体
// ---------------------------------------------------------------------------

describe('ROLE-01：真走内核，且不直接产出办公文件', () => {
  it('create_task 真写内核 Store（任务/实例/群成员都在），派发产物计数恒 0', async () => {
    const store = memoryStore();
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'create_task',
      goal: '产出一份季度汇报',
      capability_id: 'cap.doc',
    });
    expect(result.status).toBe(200);
    expect(result.body.dispatch.via_kernel).toBe(true);
    expect(result.body.dispatch.execution_owner).toBe('background');
    expect(result.body.dispatch.artifacts_produced).toBe(0);
    expect(result.body.artifacts_produced).toBe(0);

    const snapshot = store.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.goal).toBe('产出一份季度汇报');
    expect(snapshot.instances).toHaveLength(1);
    expect(snapshot.group_members).toHaveLength(1);
    // 关键：**仓库里没有产出任何办公产物**——主智能体没有产生产物的能力。
    expect(snapshot.artifacts).toHaveLength(0);
  });

  it('resume_task 真推任务版本（不是返回桩数据）', async () => {
    const store = memoryStore();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const before = store.snapshot().tasks[0]?.revision;
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'resume_task',
      task_id: 'T-1',
    });
    expect(result.status).toBe(200);
    expect(result.body.dispatch.artifacts_produced).toBe(0);
    const after = store.snapshot().tasks[0]?.revision;
    expect(after).toBe(nextRevision(before as number as never));
    expect(store.snapshot().artifacts).toHaveLength(1); // 种子里的产物与主智能体无关
  });

  it('cancel_task 真写任务控制状态（cancelled=true、epoch 递增）', async () => {
    const store = memoryStore();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'cancel_task',
      task_id: 'T-1',
      reason: '用户改主意了',
    });
    expect(result.status).toBe(200);
    expect(result.body.ack.cancelled).toBe(true);
    const control = store.snapshot().task_control_states;
    expect(control).toHaveLength(1);
    expect(control[0]?.cancelled).toBe(true);
    expect(control[0]?.cancel_reason).toBe('用户改主意了');
    expect(control[0]?.control_epoch).toBe(1);
  });

  it('capability_discovery 走注入的能力目录（本层不发明目录）', async () => {
    const store = memoryStore();
    const result = await call(
      {
        store,
        capabilities: [
          { capability_id: 'cap.doc' as never, summary: '文档工作流', execution_owner: 'background' },
          { capability_id: 'cap.sheet' as never, summary: '表格工作流', execution_owner: 'background' },
        ],
      },
      'POST',
      `${ROLES_ROOT}/main-agent`,
      { kind: 'capability_discovery', query: 'doc' },
    );
    expect(result.status).toBe(200);
    expect(result.body.capabilities).toHaveLength(1);
    expect(result.body.capabilities[0].capability_id).toBe('cap.doc');
    expect(result.body.capabilities[0].execution_owner).toBe('background');
  });

  it('**反向对照（N-7-1）**：能力目录未装配 ⇒ capability_discovery 结构化 503，不是"成功的空结果"', async () => {
    const store = memoryStore();
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'capability_discovery',
      query: '',
    });
    // 修复前：200 { ok: true, capabilities: [] }（与"目录装配了但没匹配"不可区分）。
    // 现在：如实未就绪。把 `handleMainAgent` 里那道闸门拿掉 ⇒ 这条立刻变红。
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('roles_not_ready');
    expect(result.body.reason).toBe('no_capability_directory');
    expect(result.body.ready).toBe(false);
    expect(result.body.unlock.length).toBeGreaterThan(0);
    expect(result.body.endpoint).toBe(`${ROLES_ROOT}/main-agent`);
    // 关键：**没有**"成功的空结果"信号。
    expect(result.body.ok).toBeUndefined();
    expect(result.body.capabilities).toBeUndefined();
  });

  it('显式传空清单 ⇒ 200 空目录（"已装配且确实为空"与"未装配"可区分）', async () => {
    const store = memoryStore();
    const empty = await call({ store, capabilities: [] }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'capability_discovery',
      query: '',
    });
    expect(empty.status).toBe(200);
    expect(empty.body.ok).toBe(true);
    expect(empty.body.capabilities).toEqual([]);
  });

  it('能力目录缺席只挡 capability_discovery：同一装配下 dialogue 照常可用', async () => {
    const store = memoryStore();
    const dialogue = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'dialogue',
      text: '你好',
    });
    expect(dialogue.status).toBe(200);
    expect(dialogue.body.ok).toBe(true);
    expect(dialogue.body.kind).toBe('dialogue');
  });

  it('**反向对照**：直接产产物被结构化拒绝（422），库里一个产物都没多', async () => {
    const store = memoryStore();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const artifactsBefore = store.snapshot().artifacts.length;
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'direct_execution',
      action: 'produce_office_artifact',
      detail: '直接给用户一份 DOCX',
    });
    expect(result.status).toBe(422);
    expect(result.body.ok).toBe(false);
    expect(result.body.rejection.code).toBe('direct_execution_forbidden');
    expect(result.body.artifacts_produced).toBe(0);
    expect(store.snapshot().artifacts).toHaveLength(artifactsBefore);
  });

  it('**反向对照**：把越界动作混进声明面 ⇒ 尺子变红（RoleBoundaryError），合法面不抛', async () => {
    expect(declaredMainAgentSurface()).toEqual([
      'dialogue',
      'capability_discovery',
      'create_task',
      'resume_task',
      'cancel_task',
      'present',
    ]);
    expect(() => assertMainAgentSurface(['produce_office_artifact'])).toThrow(RoleBoundaryError);
    expect(() => assertMainAgentSurface(['invoke_system_tool'])).toThrow(RoleBoundaryError);
    expect(() => assertMainAgentSurface(['跑了别的'])).toThrow(RoleBoundaryError);
  });

  it('未知 kind ⇒ 422 invalid_request（不静默当成对话）', async () => {
    const store = memoryStore();
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, { kind: 'teleport' });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('invalid_request');
  });

  it('present 走内核摘要 + 呈现端口（返回的是决策气泡摘要，不是可交付文件）', async () => {
    const store = memoryStore();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/main-agent`, {
      kind: 'present',
      task_id: 'T-1',
    });
    expect(result.status).toBe(200);
    expect(result.body.view.kind).toBe('decision_bubble_summary');
    expect(result.body.view.lines[0]).toContain('T-1');
  });
});

// ---------------------------------------------------------------------------
// 3. ROLE-02 群内分身
// ---------------------------------------------------------------------------

describe('ROLE-02：只得本任务必要信息（越界一律被拦下）', () => {
  it('放行本任务事实；**个人历史与跨任务引用必须被剔除且如实登记**', async () => {
    const store = memoryStore();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false, withFact: true });
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/group-fork/context`, {
      task_id: 'T-1',
      items: [
        { ref: 'F-1', scope: 'task', text: '重复提交的本任务事实' },
        { ref: 'P-HISTORY', scope: 'personal_history', text: '这是跨任务的个人历史，分身不该看到' },
        { ref: 'F-OTHER-TASK', scope: 'task', text: '这是别的任务的事实' },
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body.visible_refs).toEqual(['F-1']);
    expect(result.body.all_items_task_scoped).toBe(true);
    expect(result.body.items.every((item: ScopedInfoItem) => item.scope === 'task')).toBe(true);
    // 剔除是**如实登记**的，不是静默丢弃。
    expect(result.body.withheld_personal_history).toEqual(['P-HISTORY']);
    expect(result.body.foreign_task_refs).toEqual(['F-OTHER-TASK']);
    expect(result.body.excluded_refs).toEqual(expect.arrayContaining(['P-HISTORY', 'F-OTHER-TASK']));
  });

  it('**反向对照**：越界内容的正文一个字都没进响应（拿掉白名单就会被带出来）', async () => {
    const store = memoryStore();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false, withFact: true });
    const secret = '这是跨任务的个人历史，分身不该看到';
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/group-fork/context`, {
      task_id: 'T-1',
      items: [{ ref: 'P-HISTORY', scope: 'personal_history', text: secret }],
    });
    expect(JSON.stringify(result.body)).not.toContain(secret);
    // 但"被拦下"这件事本身必须看得见（不是静默丢弃）。
    expect(result.body.withheld_personal_history).toContain('P-HISTORY');
  });

  it('别的任务的事实不会被当成"本任务必要信息"混进来', async () => {
    const store = memoryStore();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false, withFact: true, factId: 'F-T1' });
    seedTask(store, { taskId: asTaskId('T-2'), requestId: 'R-2', inFlight: false, withFact: true, factId: 'F-T2' });
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/group-fork/context`, { task_id: 'T-1' });
    expect(result.status).toBe(200);
    // 只取到本任务那一条；另一个任务的事实（F-T2）根本不在可见范围里。
    expect(result.body.visible_refs).toEqual(['F-T1']);
    expect(result.body.items).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('F-T2');
  });

  it('task_id 不存在 ⇒ 422 task_not_found（不返回空上下文冒充"没有可看的"）', async () => {
    const store = memoryStore();
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/group-fork/context`, { task_id: 'T-NOPE' });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('task_not_found');
  });

  it('signal：同一 question_key 归并成一条（merged_count = 提出者数 − 1）', async () => {
    const result = await call({}, 'POST', `${ROLES_ROOT}/group-fork/signals`, {
      signals: [
        {
          channel: 'uplink',
          kind: 'question',
          from_instance_id: 'I-1',
          task_id: 'T-1',
          at: 1,
          question_key: 'need-data',
          text: '缺一份数据',
        },
        {
          channel: 'uplink',
          kind: 'question',
          from_instance_id: 'I-2',
          task_id: 'T-1',
          at: 2,
          question_key: 'need-data',
          text: '缺一份数据（补充）',
        },
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body.aggregated).toHaveLength(1);
    expect(result.body.aggregated[0].merged_count).toBe(1);
    expect(result.body.aggregated[0].asked_by).toEqual(['I-1', 'I-2']);
    expect(result.body.aggregated[0].latest_text).toBe('缺一份数据（补充）');
  });

  it('**反向对照**：非法通道 / question 缺去重键 ⇒ 422（不静默收下）', async () => {
    const badChannel = await call({}, 'POST', `${ROLES_ROOT}/group-fork/signals`, {
      signals: [{ channel: 'sideways', kind: 'status', from_instance_id: 'I-1', task_id: 'T-1', at: 1, text: 'x' }],
    });
    expect(badChannel.status).toBe(422);
    expect(badChannel.body.code).toBe('invalid_request');

    const missingKey = await call({}, 'POST', `${ROLES_ROOT}/group-fork/signals`, {
      signals: [{ channel: 'uplink', kind: 'question', from_instance_id: 'I-1', task_id: 'T-1', at: 1, text: 'x' }],
    });
    expect(missingKey.status).toBe(422);
    expect(missingKey.body.code).toBe('invalid_signal');
  });

  it('有限停滞恢复：额度内 recovered、额度耗尽 gave_up + escalated', async () => {
    const recovered = await call({}, 'POST', `${ROLES_ROOT}/group-fork/signals`, {
      signals: [{ channel: 'downlink', kind: 'blocked', from_instance_id: 'I-1', task_id: 'T-1', at: 1, text: '卡住了' }],
      recovery: { max_attempts: 2, attempts_used: 0, stagnant: true, action: '重发缺失输入请求' },
    });
    expect(recovered.body.recovery.outcome).toBe('recovered');
    expect(recovered.body.recovery.attempts).toBe(1);
    expect(recovered.body.recovery.escalated).toBe(false);

    const gaveUp = await call({}, 'POST', `${ROLES_ROOT}/group-fork/signals`, {
      signals: [{ channel: 'downlink', kind: 'blocked', from_instance_id: 'I-1', task_id: 'T-1', at: 1, text: '卡住了' }],
      recovery: { max_attempts: 2, attempts_used: 2, stagnant: true, action: '再来一次' },
    });
    expect(gaveUp.body.recovery.outcome).toBe('gave_up');
    expect(gaveUp.body.recovery.escalated).toBe(true);

    // 无上限不是本层的选项。
    expect(() => requireForkRecoveryBudget({ max_attempts: 0 })).toThrow(RangeError);
    expect(recoverStagnation({ budget: { max_attempts: 1 }, attempts_used: 0, stagnant: false, action: 'x' }).outcome).toBe(
      'no_signal',
    );
  });

  it('拓扑：有直连边 ⇒ 优先直连且分身不被迫成转发点；星形 ⇒ 被迫（如实暴露）', async () => {
    const direct = await call({}, 'POST', `${ROLES_ROOT}/group-fork/route`, {
      topology: {
        fork_instance_id: 'I-FORK',
        edges: [
          { from: 'I-1', to: 'I-2', via: 'direct' },
          { from: 'I-1', to: 'I-2', via: 'fork' },
        ],
      },
      required: [{ from: 'I-1', to: 'I-2' }],
      from: 'I-1',
      to: 'I-2',
    });
    expect(direct.body.decision.route).toBe('direct');
    expect(direct.body.direct_reachable).toBe(true);
    expect(direct.body.fork_is_mandatory).toBe(false);

    const star = await call({}, 'POST', `${ROLES_ROOT}/group-fork/route`, {
      topology: {
        fork_instance_id: 'I-FORK',
        edges: [
          { from: 'I-1', to: 'I-FORK', via: 'fork' },
          { from: 'I-FORK', to: 'I-2', via: 'fork' },
        ],
      },
      required: [{ from: 'I-1', to: 'I-2' }],
      from: 'I-1',
      to: 'I-2',
    });
    expect(star.body.decision.route).toBe('via_fork');
    expect(star.body.decision.fork_required).toBe(true);
    expect(star.body.fork_is_mandatory).toBe(true);
    // 星形拓扑下不存在绕过分身的直连路径——这正是 forkIsMandatory 要暴露的设计缺陷。
    expect(
      deliverWithoutFork(
        {
          edges: [{ from: asInstanceId('I-1'), to: asInstanceId('I-FORK'), via: 'fork' }],
          fork_instance_id: asInstanceId('I-FORK'),
        },
        asInstanceId('I-1'),
        asInstanceId('I-2'),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. ROLE-03 经验维护智能体
// ---------------------------------------------------------------------------

describe('ROLE-03：终态才固化经验，在途必须被拒', () => {
  it('终态任务 ⇒ 固化成功（写库 1 条），触发门结论与 experienceTriggerOf 一致', async () => {
    const store = memoryStore();
    const repository: MemoryRepository = createMemoryRepository();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const result = await call({ store, repository, owner_id: OWNER }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-1',
      template_id: 'WF-001',
      evidence: [evidence('先冻结表头再导出')],
    });
    expect(result.status).toBe(200);
    expect(result.body.report.trigger.eligible).toBe(true);
    expect(result.body.report.trigger.reasons).toEqual([]);
    expect(result.body.report.accepted_lessons).toEqual(['先冻结表头再导出']);
    expect(result.body.report.written).toHaveLength(1);
    expect(repository.listByKind('template_experience')).toHaveLength(1);
  });

  it('**反向对照**：在途任务提经验必须被拒（422），一个字节都不写库', async () => {
    const store = memoryStore();
    const repository: MemoryRepository = createMemoryRepository();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: true });
    const result = await call({ store, repository, owner_id: OWNER }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-1',
      template_id: 'WF-001',
      evidence: [evidence('这条经验本不该被固化')],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('experience_trigger_rejected');
    expect(result.body.trigger.eligible).toBe(false);
    expect(result.body.trigger.state).toBe('in_flight');
    expect(result.body.written).toEqual([]);
    // 报告结构上也走不到裁决链。
    expect(result.body.report.proposal).toBeNull();
    expect(result.body.report.pipeline).toBeNull();
    expect(repository.listByKind('template_experience')).toHaveLength(0);
  });

  it('**不新增可达**：同文本第二次固化 ⇒ no_change，库不变', async () => {
    const store = memoryStore();
    const repository: MemoryRepository = createMemoryRepository();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const first = await call({ store, repository, owner_id: OWNER }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-1',
      template_id: 'WF-001',
      evidence: [evidence('导出前先冻结表头')],
    });
    expect(first.body.report.written).toHaveLength(1);
    const second = await call({ store, repository, owner_id: OWNER }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-1',
      template_id: 'WF-001',
      evidence: [evidence('导出前先冻结表头')],
    });
    expect(second.status).toBe(200);
    expect(second.body.report.accepted_lessons).toEqual([]);
    expect(second.body.report.no_change_lessons).toEqual(['导出前先冻结表头']);
    expect(second.body.report.written).toEqual([]);
    expect(repository.listByKind('template_experience')).toHaveLength(1);
  });

  it('证据门槛：未封存 / 未读回 ⇒ evidence_not_sealed，不写库（可得出"不新增"）', async () => {
    const store = memoryStore();
    const repository: MemoryRepository = createMemoryRepository();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const result = await call({ store, repository, owner_id: OWNER }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-1',
      template_id: 'WF-001',
      evidence: [evidence('没读回的教训', true, false)],
    });
    expect(result.status).toBe(200);
    expect(result.body.report.evidence_rejections.map((item: { code: string }) => item.code)).toEqual([
      'evidence_not_sealed',
    ]);
    expect(result.body.report.written).toEqual([]);
    expect(repository.listByKind('template_experience')).toHaveLength(0);
  });

  it('**反向对照**：改权限 / 改工具地址的写入尝试 ⇒ 422 role_boundary_violation', async () => {
    const store = memoryStore();
    const repository: MemoryRepository = createMemoryRepository();
    seedTask(store, { taskId: asTaskId('T-1'), requestId: 'R-1', inFlight: false });
    const result = await call({ store, repository, owner_id: OWNER }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-1',
      template_id: 'WF-001',
      evidence: [evidence('正常的经验')],
      privilege_mutations: [{ kind: 'permission_grant', target: 'tool.x', detail: '顺手放开一个权限' }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('role_boundary_violation');
    expect(result.body.role_id).toBe(ROLE_IDS.experience_agent);
    expect(repository.listByKind('template_experience')).toHaveLength(0);
  });

  it('task_id 不在内核 ⇒ 422 task_not_found（不凭空造完成视图）', async () => {
    const store = memoryStore();
    const repository: MemoryRepository = createMemoryRepository();
    const result = await call({ store, repository, owner_id: OWNER }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-NOPE',
      template_id: 'WF-001',
      evidence: [],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('task_not_found');
  });
});

// ---------------------------------------------------------------------------
// 5. 端口缺席 ⇒ 结构化未就绪（503，具名）
// ---------------------------------------------------------------------------

describe('端口缺席：结构化 503，不假装可用', () => {
  it('缺 Store ⇒ ROLE-01 / ROLE-02 前缀 503 roles_not_ready（no_kernel_store）', async () => {
    for (const path of ['/main-agent', '/group-fork/context']) {
      const result = await call({}, 'POST', `${ROLES_ROOT}${path}`, { kind: 'resume_task', task_id: 'T-1' });
      expect(result.handled).toBe(true);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('roles_not_ready');
      expect(result.body.reason).toBe('no_kernel_store');
      expect(result.body.ready).toBe(false);
      expect(result.body.unlock).toHaveLength(2);
    }
  });

  it('缺 MemoryRepository ⇒ ROLE-03 前缀 503（no_memory_repository），即使 Store 在', async () => {
    const store = memoryStore();
    const result = await call({ store }, 'POST', `${ROLES_ROOT}/experience/synthesize`, {
      task_id: 'T-1',
      template_id: 'WF-001',
      evidence: [],
    });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('roles_not_ready');
    expect(result.body.reason).toBe('no_memory_repository');
  });

  it('就绪探针如实报告端口与未就绪原因', async () => {
    const store = memoryStore();
    const repository = createMemoryRepository();
    const bare = await call({}, 'GET', `${ROLES_ROOT}/status`);
    expect(bare.body.ready).toBe(false);
    expect(bare.body.ports.kernel_store).toBe(false);
    expect(bare.body.not_ready_reasons).toHaveLength(2);

    const full = await call({ store, repository }, 'GET', `${ROLES_ROOT}/status`);
    expect(full.body.ready).toBe(true);
    expect(full.body.ports).toMatchObject({ kernel_store: true, memory_repository: true });
    expect(rolesReadinessOf({ store, repository }).reasons).toEqual([]);
  });

  it('非 GET 打状态接口 ⇒ 405；未知子路径 ⇒ 404（不吞成 200）', async () => {
    const wrongMethod = await call({}, 'POST', `${ROLES_ROOT}/status`);
    expect(wrongMethod.status).toBe(405);
    const unknown = await call({}, 'POST', `${ROLES_ROOT}/nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('unknown_roles_route');
  });
});

// ---------------------------------------------------------------------------
// 6. 只读视图分工：status（就绪与依赖）vs reachability（模块清单）—— N-7-2
// ---------------------------------------------------------------------------

describe('只读视图分工：status 给就绪与依赖，reachability 给模块清单', () => {
  it('**反向对照（N-7-2）**：两个视图不是同一份响应（修复前逐字相同）', async () => {
    const store = memoryStore();
    const repository = createMemoryRepository();
    const status = await call({ store, repository }, 'GET', `${ROLES_ROOT}/status`);
    const reach = await call({ store, repository }, 'GET', `${ROLES_ROOT}/reachability`);
    expect(status.status).toBe(200);
    expect(reach.status).toBe(200);
    // 逐字节不同 ⇒ 别名关系被打破。把 `/reachability` 接回 `statusBody()` ⇒ 立刻变红。
    expect(JSON.stringify(status.body)).not.toBe(JSON.stringify(reach.body));
    // 各守其职：就绪视图不谈模块清单，可达视图不谈端口就绪。
    expect(status.body.reachable_modules).toBeUndefined();
    expect(status.body.ready).toBe(true);
    expect(status.body.ports).toBeDefined();
    expect(reach.body.ports).toBeUndefined();
    expect(reach.body.not_ready_reasons).toBeUndefined();
    expect(reach.body.reachable_modules).toEqual([...ROLES_MODULES_REACHABLE_BY_WIRING]);

    // 根路径 `/api/roles` 是**显式登记**的子系统自述（= reachability 那份），不是第三个语义；
    // 它不是就绪视图（就绪只在 `/status`）。
    const root = await call({ store, repository }, 'GET', ROLES_ROOT);
    expect(JSON.stringify(root.body)).toBe(JSON.stringify(reach.body));
    expect(root.body.ready).toBeUndefined();
  });

  it('就绪视图逐操作给出缺失端口与解锁动作（依赖是真的被读，不是常量表）', async () => {
    const store = memoryStore();
    const bare = await call({ store }, 'GET', `${ROLES_ROOT}/status`);
    const ops = (bare.body.operations ?? []) as readonly {
      operation: string;
      ready: boolean;
      missing_ports: readonly string[];
      unlock: readonly string[];
    }[];
    const by = (name: string) => ops.find((option) => option.operation === name);
    expect(by('experience.synthesize')?.ready).toBe(false);
    expect(by('experience.synthesize')?.missing_ports).toEqual(['memory_repository']);
    expect((by('experience.synthesize')?.unlock.length ?? 0)).toBeGreaterThan(0);
    expect(by('capability_discovery')?.ready).toBe(false);
    expect(by('capability_discovery')?.missing_ports).toEqual(['capability_directory']);
    expect(by('create_task')?.ready).toBe(true);
    expect(by('create_task')?.missing_ports).toEqual([]);
    // 纯函数端点不读端口 ⇒ 恒就绪，且如实标注依赖为空。
    expect(by('group-fork.signals')?.ready).toBe(true);

    // 缺的端口在**顶层**也看得见（不必翻到 operations 才发现"能力发现不可用"）。
    const partial = (bare.body.partial_readiness ?? []) as readonly {
      port: string;
      kind: string;
      affects: readonly string[];
      unlock?: string;
    }[];
    const cap = partial.find((entry) => entry.port === 'capability_directory');
    expect(cap?.kind).toBe('not_ready');
    expect(cap?.affects).toEqual(['capability_discovery']);
    expect((cap?.unlock ?? '').length).toBeGreaterThan(0);
    // 结构桩是降级，不是"未就绪"：如实标注、与 not_ready 分开。
    expect(partial.find((entry) => entry.port === 'dialogue_port')?.kind).toBe('structural_stub');
    // 但"全角色未就绪的原因"仍只谈两个必需端口（缺能力目录不等于角色全挂）。
    expect(bare.body.not_ready_reasons).toEqual([
      'no_memory_repository：未注入 MemoryRepository，ROLE-03 的经验前缀不可用',
    ]);
    expect(
      (bare.body.not_ready_reasons as readonly string[]).every((reason) => !reason.includes('capability')),
    ).toBe(true);

    // 注入后如实翻绿：同上一次请求同一路径、同一判据，只是端口补上了。
    const repository = createMemoryRepository();
    const capabilities = [
      { capability_id: 'cap.doc' as never, summary: '文档工作流', execution_owner: 'background' as const },
    ];
    const full = await call({ store, repository, capabilities }, 'GET', `${ROLES_ROOT}/status`);
    const fullOps = (full.body.operations ?? []) as readonly { operation: string; ready: boolean }[];
    const fullBy = (name: string) => fullOps.find((option) => option.operation === name);
    expect(fullBy('experience.synthesize')?.ready).toBe(true);
    expect(fullBy('capability_discovery')?.ready).toBe(true);
  });

  it('可达视图仍如实暴露三角色的动作面与经验角色判定（不是被 status 吞掉的空壳）', async () => {
    const reach = await call({}, 'GET', `${ROLES_ROOT}/reachability`);
    expect(reach.body.surfaces.main_agent).toEqual([...declaredMainAgentSurface()]);
    expect(reach.body.surfaces.experience_agent).toBeDefined();
    expect(reach.body.roles).toHaveLength(3);
    expect(reach.body.experience_not_fixed_reviewer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. 模块纪律（静态判据）
// ---------------------------------------------------------------------------

describe('模块纪律', () => {
  it('不碰文件系统 / 不读墙钟 / 不取随机（与 `src/**` 同一条纪律）', () => {
    expect(SOURCE).not.toMatch(/from 'node:fs/);
    expect(SOURCE).not.toMatch(/Date\.now\(\)/);
    expect(SOURCE).not.toMatch(/Math\.random\(\)/);
  });

  it('不另造经验裁决：证据 → 经验这条链**复用** experience-wiring（不 import src/memory 的裁决函数）', () => {
    expect(SOURCE).toContain("from './experience-wiring.js'");
    expect(SOURCE).toContain('synthesizeTaskExperience(');
    // 写库调用只应出现在被复用的一方，而不是本层自己拼一条写入链。
    expect(SOURCE).not.toContain('synthesizeExperiences(');
  });

  it('端口缺席时的错误是具名的（RolesWiringError 带 status 与 code）', () => {
    const error = new RolesWiringError('task_not_found', 422, 'x');
    expect(error.status).toBe(422);
    expect(error.code).toBe('task_not_found');
    expect(error).toBeInstanceOf(Error);
  });
});
