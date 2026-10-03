/**
 * **交付会话**（design-06 P8/P9 的产品入口；合同 R232 / R247 / R250 / R251）。
 *
 * ## 一次提交 = 一个事务 = 一次编辑版本 = 一次交付
 *
 * `publish()` 是唯一的写入口，它把"改源"和"交出文件"绑成**一次事务**：
 *
 * ```text
 * ① 幂等键查表（R146：命中同输入 ⇒ 原样返回既有回执，不重放、不产第二版）
 * ② 基线核对（base_revision + base_digest 任一不符 ⇒ 拒绝 + 当前版本）
 * ③ 编辑（若有）：适配器把意图应用到源（不可变）；失败 ⇒ 源零改动
 * ④ 导出新字节 + **独立重算**摘要，并与适配器自称的摘要比对
 *    ├─ 新摘要 == 某条已交付版本的摘要 ⇒ 空转（不重复交付同一份；R145）
 *    └─ 否则继续 ⑤
 * ⑤ 发布（由注入端口做"原子写盘 + 回读"，端口负责走内核的版本闸门）
 *    ├─ 成功 ⇒ 采纳新源、revision +1、写映射行、记幂等、记日志
 *    └─ 失败 ⇒ **丢弃新源**（旧文件与旧版本一个字节都不变，R145），只记失败
 * ```
 *
 * 全成功或全不修改。**不存在"改成了但没交付、上层以为成了"的中间态**。
 *
 * ## 这一层与 `src/documents/session/**` 的分工（架构选择，见交付说明）
 *
 * 字处理会话把**编辑语义**（段落 / 字符 / 节 / 列表）也放在会话里，因此它只能服务 Word。
 * 本层刻意**不含任何格式语义**：源是适配器的类型参数，格式相关的四件事
 * （导出 / 编辑 / 导入 / 描述）全部由 {@link DeliverableAdapter} 注入。
 * 三种办公格式因此走**同一条**生命周期代码，而不是三份互相抄的实现。
 *
 * **本轮未做**：把字处理会话迁移到本层（那要改一条已经「待验收」的链，风险不可接受）。
 * 两条会话链**并存**，收敛路径已登记为后续项，**不声称已去重**。
 *
 * ## 本文件不做的事
 *
 * - **不做文件 IO**：持久化走 {@link SessionPersistence}，写盘走 {@link DeliverablePublishPort}；
 * - **不拼 XML / 不写 ZIP**：那是各格式模块与 `src/artifacts/ooxml/**` 的事；
 * - **不解释源**：源对它是 `unknown`（只在适配器边界上被赋成 `S`）。
 */

import type { TemplateKind } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import type { AdapterEditResult, DeliverableAdapter } from './adapter.js';
import { digestBytes, fingerprint } from './canonical.js';
import {
  assertFilenameMatchesFormat,
  formatSpec,
  type FileFormat,
} from './formats.js';
import { decodeSessionState, encodeSessionState } from './persistence.js';
import {
  DELIVERABLE_SESSION_SCHEMA,
  type ContentDigest,
  type DeliverableFailureCode,
  type DeliverablePublishPort,
  type DeliverablePublishRequest,
  type DeliverablePublishResult,
  type DeliverableSessionState,
  type DeliverableSourceKind,
  type DeliverableStatusView,
  type EditRevision,
  type IdempotencyRecord,
  type OperationLogEntry,
  type OperationLogKind,
  type PublicationFailureRecord,
  type PublishOutcome,
  type PublishedVersion,
  type SessionId,
  type SessionPersistence,
  type SessionResult,
} from './types.js';

// ---------------------------------------------------------------------------
// 入参 / 出参
// ---------------------------------------------------------------------------

export interface DeliverableSessionOptions<S> {
  /** 会话 id（客户端生成、刷新保留）。 */
  readonly id: SessionId;
  /** 交付物 id（内核任务与来源事实的派生依据；**与会话 id 分开**，重开会话不重开交付物）。 */
  readonly deliverable_id: string;
  /** 期望文件名，**必须**以该适配器格式的扩展名结尾（否则构造即拒）。 */
  readonly filename: string;
  /** 格式适配器（本层唯一认识"格式"的地方）。 */
  readonly adapter: DeliverableAdapter<S>;
  readonly persistence: SessionPersistence;
  readonly publish_port: DeliverablePublishPort;
  /**
   * 墙钟（**只用于日志与元数据，不参与任何判定**）。
   *
   * **必填**，不给默认值：`src/**` 有一条机器化纪律禁止墙钟调用
   * （`tests/acceptance/office/w-disc-kernel-discipline.test.ts`），
   * 给"取当前时间"的默认值会把这条纪律从后门放走。
   */
  readonly now: () => Date;
  /** 操作日志上限；`null` = 不限制。超出时丢最旧的（日志是审计面，不是状态面）。 */
  readonly max_log_entries?: number | null;
}

/** 一次发布提交。 */
export interface PublishInput {
  /** 调用方生成的幂等键；客户端重试**必须复用同一个键**（R146）。 */
  readonly idempotency_key: string;
  /** 本操作所基于的编辑版本。 */
  readonly base_revision: EditRevision;
  /** 本操作所基于的内容摘要。 */
  readonly base_digest: ContentDigest;
  /**
   * 编辑意图（形状由**适配器**定义并校验）。
   *
   * 省略 = "把当前源发布出去"（首版交付）。产品面上它由受约束的意图构造器产出；
   * 本层**不解释**它，只把它交给适配器（R134：模型产意图，校验归编译器）。
   */
  readonly edit?: unknown;
}

/** 恢复结果（与字处理会话同口径）。 */
export interface RestoreResult {
  readonly loaded: boolean;
  readonly reason: string;
}

export interface OpenedDeliverable {
  readonly session_id: SessionId;
  readonly deliverable_id: string;
  readonly filename: string;
  readonly file_format: FileFormat;
  readonly template_kind: TemplateKind;
  readonly edit_revision: EditRevision;
  readonly content_digest: ContentDigest;
}

/** 提交结果（含发布面）。 */
export interface PublishSubmission extends PublishOutcome {
  /** 本次编辑的逐步回执（重放时原样返回首次的）。 */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export class DeliverableSession<S> {
  readonly #options: DeliverableSessionOptions<S>;
  readonly #adapter: DeliverableAdapter<S>;
  readonly #now: () => Date;
  readonly #maxLog: number | null;
  readonly #format: FileFormat;
  readonly #templateKind: TemplateKind;

  #source: S;
  #revision: EditRevision;
  #contentDigest: ContentDigest;
  #sourceKind: DeliverableSourceKind;
  #sourceDigest: ContentDigest | null;
  #createdAt: string;
  #published: PublishedVersion[];
  #lastFailure: PublicationFailureRecord | null;
  #log: OperationLogEntry[];
  #idempotency: IdempotencyRecord[];
  #seq: number;

  private constructor(
    options: DeliverableSessionOptions<S>,
    seed: {
      readonly source: S;
      readonly content_digest: ContentDigest;
      readonly source_kind: DeliverableSourceKind;
      readonly source_digest: ContentDigest | null;
      readonly created_at: string;
      readonly revision: EditRevision;
    },
  ) {
    this.#options = options;
    this.#adapter = options.adapter;
    this.#now = options.now;
    this.#maxLog = options.max_log_entries === undefined ? 2000 : options.max_log_entries;
    this.#format = options.adapter.format;
    this.#templateKind = options.adapter.template_kind;
    this.#source = seed.source;
    this.#contentDigest = seed.content_digest;
    this.#sourceKind = seed.source_kind;
    this.#sourceDigest = seed.source_digest;
    this.#createdAt = seed.created_at;
    this.#revision = seed.revision;
    this.#published = [];
    this.#lastFailure = null;
    this.#log = [];
    this.#idempotency = [];
    this.#seq = 0;
  }

  // --- 只读 ---------------------------------------------------------------

  get id(): SessionId {
    return this.#options.id;
  }

  get deliverableId(): string {
    return this.#options.deliverable_id;
  }

  get filename(): string {
    return this.#options.filename;
  }

  get fileFormat(): FileFormat {
    return this.#format;
  }

  get templateKind(): TemplateKind {
    return this.#templateKind;
  }

  currentRevision(): EditRevision {
    return this.#revision;
  }

  currentDigest(): ContentDigest {
    return this.#contentDigest;
  }

  /** 当前源（**只读旁证**：测试与调用方核对用；本层仍是它唯一的写入者）。 */
  source(): S {
    return this.#source;
  }

  publishedVersions(): readonly PublishedVersion[] {
    return Object.freeze([...this.#published]);
  }

  publishedAt(revision: EditRevision): PublishedVersion | null {
    return this.#published.find((version) => version.edit_revision === revision) ?? null;
  }

  /** 当前已交付版本（从未发布过时为 `null`）。 */
  currentPublished(): PublishedVersion | null {
    const last = this.#published[this.#published.length - 1];
    return last ?? null;
  }

  status(): DeliverableStatusView {
    return Object.freeze({
      session_id: this.#options.id,
      deliverable_id: this.#options.deliverable_id,
      filename: this.#options.filename,
      file_format: this.#format,
      template_kind: this.#templateKind,
      created_at: this.#createdAt,
      edit_revision: this.#revision,
      content_digest: this.#contentDigest,
      source_kind: this.#sourceKind,
      source_digest: this.#sourceDigest,
      published: this.publishedVersions(),
      current: this.currentPublished(),
      last_failure: this.#lastFailure,
      log: Object.freeze([...this.#log]),
    });
  }

  // --- 构造 ---------------------------------------------------------------

  /**
   * 新建会话（源由调用方给出；本层立刻导出一次以确定 `content_digest`）。
   *
   * 为什么构造期就要导出：会话状态里的摘要必须是**真实导出字节的摘要**，否则
   * "当前版本的摘要"就成了一个没人核对过的数字（而它正是下载面比对盘上字节的依据）。
   * 导出失败 ⇒ 会话**不被创建**（不产出一个"能打开但发不出去"的会话）。
   */
  static createNew<S>(
    options: DeliverableSessionOptions<S>,
    source: S,
  ): SessionResult<DeliverableSession<S>> {
    const validated = validateOptions(options);
    if (!validated.ok) return validated;
    const session = new DeliverableSession<S>(options, {
      source,
      content_digest: '0'.repeat(64),
      source_kind: 'user_request',
      source_digest: null,
      created_at: options.now().toISOString(),
      revision: 0,
    });
    const exported = session.#exportSource(source);
    if (!exported.ok) {
      return fail(exported.code, exported.message, exported.detail.extra);
    }
    session.#contentDigest = exported.value.digest;
    session.#logEntry('session_created', {
      base_revision: 0,
      result_revision: 0,
      idempotency_key: null,
      submission_digest: null,
      changed: true,
      rejection: null,
    });
    session.#persist();
    return { ok: true, value: session };
  }

  /**
   * 从既有字节导入（格式适配器必须支持导入）。
   *
   * 适配器不支持时**明确拒绝**（`unsupported`），而不是给一个"看起来支持、用起来报错"的入口。
   * 导入源的**原始字节摘要**单独记在 `source_digest` 上，与"我们交出去的字节"
   * （`content_digest`）分开——混用会让"导入后立刻导出是否保真"变成无法回答的问题。
   */
  static importBytes<S>(
    options: DeliverableSessionOptions<S>,
    bytes: Uint8Array,
  ): SessionResult<DeliverableSession<S>> {
    const validated = validateOptions(options);
    if (!validated.ok) return validated;
    const importBytes = options.adapter.importBytes;
    if (importBytes === undefined) {
      return fail(
        'unsupported',
        `格式 ${options.adapter.format} 的适配器没有提供导入能力：本入口不支持导入该格式`,
        { format: options.adapter.format },
      );
    }
    const imported = importBytes(bytes);
    if (!imported.ok) {
      return fail('import_failed', `导入失败：${imported.detail}`, { kind: imported.kind });
    }
    const opened = DeliverableSession.createNew(options, imported.source);
    if (!opened.ok) return opened;
    opened.value.#sourceKind = 'imported';
    opened.value.#sourceDigest = digestBytes(bytes);
    opened.value.#persist();
    return opened;
  }

  /**
   * 从持久化载体恢复。
   *
   * 三道核对，任一不过即**拒绝恢复**（返回 `session: null` + 具体原因）：
   * ① schema 标识；② 身份与格式（`session_id` / `deliverable_id` / `file_format` /
   * `template_kind` / `filename`）；③ **重新导出源并与落盘摘要比对**——
   * 状态里记的摘要与重算不一致，说明落盘状态与源已经分叉，此时"恢复成功"是假的。
   */
  static restore<S>(options: DeliverableSessionOptions<S>): {
    readonly session: DeliverableSession<S> | null;
    readonly result: RestoreResult;
  } {
    const validated = validateOptions(options);
    if (!validated.ok) {
      return { session: null, result: { loaded: false, reason: validated.message } };
    }
    let raw: unknown;
    try {
      raw = options.persistence.load();
    } catch (error) {
      return { session: null, result: { loaded: false, reason: `读取落盘状态失败：${describe(error)}` } };
    }
    if (raw === null || raw === undefined) {
      return { session: null, result: { loaded: false, reason: '没有落盘状态' } };
    }
    const decoded = decodeSessionState(raw);
    const state = readState(decoded, options);
    if (!state.ok) {
      return { session: null, result: { loaded: false, reason: state.reason } };
    }

    const session = new DeliverableSession<S>(options, {
      source: state.value.source as S,
      content_digest: state.value.content_digest,
      source_kind: state.value.source_kind,
      source_digest: state.value.source_digest,
      created_at: state.value.created_at,
      revision: state.value.edit_revision,
    });
    session.#published = [...state.value.published];
    session.#lastFailure = state.value.last_failure;
    session.#log = [...state.value.log];
    session.#idempotency = [...state.value.idempotency];
    session.#seq = session.#log.reduce((max, entry) => Math.max(max, entry.seq), 0);

    // ③ 源还能不能导出成落盘时那份字节？（对不上就不是"恢复成功"）
    const reexported = session.#exportSource(session.#source);
    if (!reexported.ok) {
      return {
        session: null,
        result: {
          loaded: false,
          reason: `落盘源无法重新导出（${reexported.message}）：拒绝把这样的状态当成恢复成功`,
        },
      };
    }
    if (reexported.value.digest !== state.value.content_digest) {
      return {
        session: null,
        result: {
          loaded: false,
          reason:
            `落盘状态与源已分叉：重算摘要 ${reexported.value.digest} ≠ 落盘摘要 ` +
            `${state.value.content_digest}（拒绝静默采纳）`,
        },
      };
    }
    return { session, result: { loaded: true, reason: '从落盘状态恢复并重新导出核对一致' } };
  }

  // --- 提交（唯一的写入口） ------------------------------------------------

  /**
   * 提交一次编辑并交付。详见文件头部的事务分解。
   *
   * **永不抛错**：所有失败都是结构化的 {@link SessionResult} 失败分支。
   */
  async publish(input: PublishInput): Promise<SessionResult<PublishSubmission>> {
    try {
      return await this.#submit(input);
    } finally {
      // 每条路径（含被拒 / 失败 / 重放）都落一次状态：日志与失败记录也是审计面，
      // 不能只持久化"成功"的那一条。持久化失败**向上抛**（不静默），与字处理会话同口径。
      this.#persist();
    }
  }

  #persist(): void {
    this.#options.persistence.save(this.state());
  }

  async #submit(input: PublishInput): Promise<SessionResult<PublishSubmission>> {
    // ① 幂等键查表（R146）
    const submissionFingerprint = fingerprint({
      edit: input.edit ?? null,
      base_revision: input.base_revision,
    });
    const recorded = this.#idempotency.find((record) => record.key === input.idempotency_key);
    if (recorded !== undefined) {
      if (recorded.fingerprint !== submissionFingerprint) {
        this.#logEntry('rejected', {
          base_revision: this.#revision,
          result_revision: this.#revision,
          idempotency_key: input.idempotency_key,
          submission_digest: submissionFingerprint,
          changed: false,
          rejection: { code: 'idempotency_conflict', detail: '同一幂等键配了不同的编辑内容' },
        });
        return fail(
          'idempotency_conflict',
          '这个幂等键已经用于另一次提交（编辑内容不同）：请换一个键，避免静默吞掉一次真实改动',
          { idempotency_key: input.idempotency_key },
        );
      }
      // 重放：**不重新执行**（重新执行就可能把编辑再套一次），原样返回首次的回执。
      // `replayed` / `changed` 必须**在返回点**改写：记录里的 `outcome` 是首次提交的
      // 事实（`replayed: false`），照抄会让调用方以为这是一次新的提交（那正是 R146 要防的）。
      return {
        ok: true,
        value: Object.freeze({
          ...recorded.outcome,
          replayed: true,
          changed: false,
          notes: Object.freeze([]),
        }),
      };
    }

    // ② 基线核对（R142/R143）
    if (input.base_revision !== this.#revision) {
      return this.#stale(input, submissionFingerprint, 'base_revision');
    }
    if (input.base_digest !== this.#contentDigest) {
      return this.#stale(input, submissionFingerprint, 'base_digest');
    }

    // ③ 编辑（若有）——适配器保证"失败 ⇒ 源不变"
    let nextSource: S = this.#source;
    let changed = true;
    /** 适配器给出的逐步回执（成功路径上原样交给调用方，见文件头部的"逐步回执"约定）。 */
    let appliedNotes: readonly string[] = Object.freeze([]);
    if (input.edit !== undefined) {
      let applied: AdapterEditResult<S>;
      try {
        applied = this.#adapter.applyEdit(this.#source, input.edit);
      } catch (error) {
        applied = { ok: false, kind: 'apply_threw', detail: describe(error) };
      }
      if (!applied.ok) {
        return this.#rejectEdit(input, submissionFingerprint, applied.kind, applied.detail);
      }
      if (!applied.changed) {
        // 幂等空转：源没动 ⇒ 不产生新版本（不重复交付同一份）。
        this.#logEntry('rejected', {
          base_revision: this.#revision,
          result_revision: this.#revision,
          idempotency_key: input.idempotency_key,
          submission_digest: submissionFingerprint,
          changed: false,
          rejection: { code: 'no_op', detail: '这次编辑没有改变源（空转）' },
        });
        return {
          ok: true,
          value: Object.freeze({
            replayed: false,
            changed: false,
            edit_revision: this.#revision,
            published: this.currentPublished(),
            notes: applied.notes,
          }),
        };
      }
      nextSource = applied.source;
      appliedNotes = applied.notes;
    }

    // ④ 导出 + 独立重算摘要
    const exported = this.#exportSource(nextSource);
    if (!exported.ok) {
      return this.#rejectEdit(input, submissionFingerprint, exported.code, exported.message);
    }
    const digest = exported.value.digest;

    // 同一份字节不重复交付第二版（R145 的"不覆盖旧文件"在会话侧的对应纪律）
    const already = this.#published.find((version) => version.content_digest === digest);
    if (already !== undefined) {
      const outcome: PublishOutcome = {
        replayed: false,
        changed: false,
        edit_revision: this.#revision,
        published: already,
      };
      this.#idempotency.push(
        freezeRecord({
          key: input.idempotency_key,
          fingerprint: submissionFingerprint,
          edit_revision: this.#revision,
          outcome,
          at: this.#timestamp(),
        }),
      );
      return { ok: true, value: Object.freeze({ ...outcome, notes: appliedNotes }) };
    }

    // ⑤ 发布（端口负责内核版本闸门 + 写盘 + 回读）
    const previous = this.currentPublished();
    const request: DeliverablePublishRequest = Object.freeze({
      session_id: this.#options.id,
      edit_revision: this.#revision + 1,
      deliverable_id: this.#options.deliverable_id,
      filename: this.#options.filename,
      file_format: this.#format,
      template_kind: this.#templateKind,
      bytes: exported.value.bytes,
      expected_digest: digest,
      previous_digest: previous === null ? null : previous.content_digest,
      idempotency_key: input.idempotency_key,
    });

    let result: DeliverablePublishResult;
    try {
      result = await this.#options.publish_port.publish(request);
    } catch (error) {
      result = {
        ok: false,
        failure: { kind: 'publish_port_threw', detail: `发布端口抛出异常：${describe(error)}` },
      };
    }

    if (!result.ok) {
      // **丢弃新源**：旧文件与旧版本一个字节都不变（R145）。
      const at = this.#timestamp();
      this.#lastFailure = Object.freeze({
        edit_revision: this.#revision + 1,
        kind: result.failure.kind,
        detail: result.failure.detail,
        at,
      });
      this.#logEntry('publish_failed', {
        base_revision: this.#revision,
        result_revision: this.#revision,
        idempotency_key: input.idempotency_key,
        submission_digest: submissionFingerprint,
        changed: false,
        rejection: { code: result.failure.kind, detail: result.failure.detail },
      });
      return fail('publish_failed', `发布失败：${result.failure.detail}`, {
        kind: result.failure.kind,
      });
    }

    const receipt = result.receipt;
    // 端口回执的格式字段必须与本会话声明的格式一致（交付侧互不冒充，R232）。
    if (receipt.filename !== this.#options.filename) {
      return this.#rejectReceipt(
        receipt.filename,
        `发布端口回执的文件名 ${JSON.stringify(receipt.filename)} 与本会话声明的 ` +
          `${JSON.stringify(this.#options.filename)} 不一致`,
      );
    }
    if (receipt.readback_digest !== digest) {
      return this.#rejectReceipt(
        receipt.readback_digest,
        `发布端口回读摘要 ${receipt.readback_digest} 与导出摘要 ${digest} 不一致：` +
          '拒绝把"盘上不是这份字节"的状态记为已交付',
      );
    }

    // 采纳
    const version: PublishedVersion = Object.freeze({
      edit_revision: request.edit_revision,
      task_revision: receipt.task_revision,
      artifact_version: receipt.artifact_version,
      artifact_id: receipt.artifact_id,
      content_digest: receipt.readback_digest,
      expected_digest: digest,
      byte_length: receipt.byte_length,
      entry_count: receipt.entry_count,
      filename: receipt.filename,
      file_format: this.#format,
      mime_type: formatSpec(this.#format).mime,
      template_kind: this.#templateKind,
      published_at: this.#timestamp(),
    });
    this.#source = nextSource;
    this.#revision = request.edit_revision;
    this.#contentDigest = digest;
    this.#published.push(version);
    this.#lastFailure = null;

    const outcome: PublishOutcome = Object.freeze({
      replayed: false,
      changed,
      edit_revision: this.#revision,
      published: version,
    });
    this.#idempotency.push(
      freezeRecord({
        key: input.idempotency_key,
        fingerprint: submissionFingerprint,
        edit_revision: this.#revision,
        outcome,
        at: this.#timestamp(),
      }),
    );
    this.#logEntry('published', {
      base_revision: request.edit_revision - 1,
      result_revision: this.#revision,
      idempotency_key: input.idempotency_key,
      submission_digest: submissionFingerprint,
      changed: true,
      rejection: null,
    });
    return { ok: true, value: Object.freeze({ ...outcome, notes: appliedNotes }) };
  }

  // --- 持久化 -------------------------------------------------------------

  /** 当前可序列化状态（调用方交给 {@link SessionPersistence} 落盘）。 */
  state(): DeliverableSessionState {
    return Object.freeze({
      schema: DELIVERABLE_SESSION_SCHEMA,
      session_id: this.#options.id,
      deliverable_id: this.#options.deliverable_id,
      filename: this.#options.filename,
      file_format: this.#format,
      template_kind: this.#templateKind,
      created_at: this.#createdAt,
      edit_revision: this.#revision,
      source: this.#adapterExportSource(),
      content_digest: this.#contentDigest,
      source_digest: this.#sourceDigest,
      source_kind: this.#sourceKind,
      published: Object.freeze([...this.#published]),
      last_failure: this.#lastFailure,
      log: Object.freeze([...this.#log]),
      idempotency: Object.freeze([...this.#idempotency]),
    });
  }

  /**
   * 把状态写成**纯 JSON 值**（二进制与 Map 走显式标记），供落盘。
   *
   * 说明：`SessionPersistence.save` 收到的是**原始状态**（可能含 `Uint8Array` / `Map`），
   * 编码由持久化实现负责——与字处理会话的分工一致；本方法只是给"想自己编码"的调用方
   * （以及测试）一个现成出口，避免各处各写一遍 `encodeSessionState(state)`。
   */
  serializableState(): unknown {
    return encodeSessionState(this.state());
  }

  // --- 内部 ---------------------------------------------------------------

  /** 源经适配器导出，并**独立重算**摘要（不信任适配器自称的摘要）。 */
  #exportSource(source: S): SessionResult<{ bytes: Uint8Array; digest: ContentDigest; entryCount: number }> {
    let exported;
    try {
      exported = this.#adapter.exportBytes(source);
    } catch (error) {
      return fail('export_failed', `导出抛出异常：${describe(error)}`, {});
    }
    if (!exported.ok) {
      return fail('export_failed', `导出失败：${exported.detail}`, { kind: exported.kind });
    }
    if (exported.bytes.byteLength === 0) {
      return fail('export_failed', '导出得到 0 字节：空文件不得作为交付物', {});
    }
    const digest = digestBytes(exported.bytes);
    if (digest !== exported.digest) {
      return fail(
        'export_failed',
        `导出字节的实算摘要 ${digest} 与构建器自称的 ${exported.digest} 不一致：` +
          '拒绝交付一份"构建器自己说不清算没算对"的字节',
        {},
      );
    }
    return { ok: true, value: { bytes: exported.bytes, digest, entryCount: exported.entry_count } };
  }

  #adapterExportSource(): unknown {
    // 源本身就是要落盘的东西；本层不解释它的字段，只保证它是 JSON 可往返的纯数据。
    return this.#source;
  }

  #stale(
    input: PublishInput,
    submissionFingerprint: string,
    field: string,
  ): SessionResult<PublishSubmission> {
    this.#logEntry('rejected', {
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: input.idempotency_key,
      submission_digest: submissionFingerprint,
      changed: false,
      rejection: { code: 'stale_revision', detail: `${field} 与当前版本不符` },
    });
    return fail('stale_revision', `${field} 与当前版本不符：源零改动，请基于当前版本重试`, {
      field,
      current_revision: this.#revision,
      current_digest: this.#contentDigest,
    });
  }

  #rejectEdit(
    input: PublishInput,
    submissionFingerprint: string,
    kind: string,
    detail: string,
  ): SessionResult<PublishSubmission> {
    this.#logEntry('rejected', {
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: input.idempotency_key,
      submission_digest: submissionFingerprint,
      changed: false,
      rejection: { code: kind, detail },
    });
    return fail('unsupported', `编辑不被接受（源零改动）：${detail}`, { kind });
  }

  #rejectReceipt(actual: string, detail: string): SessionResult<PublishSubmission> {
    this.#lastFailure = Object.freeze({
      edit_revision: this.#revision + 1,
      kind: 'receipt_inconsistent',
      detail,
      at: this.#timestamp(),
    });
    this.#logEntry('publish_failed', {
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: null,
      submission_digest: null,
      changed: false,
      rejection: { code: 'receipt_inconsistent', detail },
    });
    return fail('publish_failed', detail, { actual });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #logEntry(
    kind: OperationLogKind,
    fields: {
      readonly base_revision: EditRevision;
      readonly result_revision: EditRevision;
      readonly idempotency_key: string | null;
      readonly submission_digest: string | null;
      readonly changed: boolean;
      readonly rejection: { readonly code: string; readonly detail: string } | null;
    },
  ): void {
    this.#seq += 1;
    this.#log.push(
      Object.freeze({
        seq: this.#seq,
        kind,
        base_revision: fields.base_revision,
        result_revision: fields.result_revision,
        at: this.#timestamp(),
        idempotency_key: fields.idempotency_key,
        submission_digest: fields.submission_digest,
        changed: fields.changed,
        rejection: fields.rejection,
      }),
    );
    if (this.#maxLog !== null && this.#log.length > this.#maxLog) {
      this.#log.splice(0, this.#log.length - this.#maxLog);
    }
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function validateOptions<S>(
  options: DeliverableSessionOptions<S>,
): SessionResult<DeliverableSessionOptions<S>> {
  if (typeof options.id !== 'string' || options.id.length === 0) {
    return fail('state_unreadable', 'id 必须是非空字符串', {});
  }
  if (typeof options.deliverable_id !== 'string' || options.deliverable_id.length === 0) {
    return fail('state_unreadable', 'deliverable_id 必须是非空字符串', {});
  }
  if (typeof options.filename !== 'string' || options.filename.length === 0) {
    return fail('state_unreadable', 'filename 必须是非空字符串', {});
  }
  // **格式互不冒充**：文件名扩展名必须与适配器声明的格式一致（R232 的交付侧守卫）。
  // 这是**请求侧**错误 ⇒ 用 `invalid_filename`（HTTP 400，不可重试），不要并进上游失败类。
  try {
    assertFilenameMatchesFormat(options.adapter.format, options.filename);
  } catch (error) {
    return fail(
      'invalid_filename',
      error instanceof ValidationError ? error.message : describe(error),
      { format: options.adapter.format },
    );
  }
  if (options.adapter.template_kind !== templateKindOfFormatChecked(options.adapter.format)) {
    return fail(
      'state_unreadable',
      `适配器声明的模板种类 ${options.adapter.template_kind} 与文件格式 ` +
        `${options.adapter.format} 不匹配（R232：两个轴必须自洽）`,
      {},
    );
  }
  return { ok: true, value: options };
}

/** 避免与 `formats.ts` 形成循环 import 的就地取用（表只有三项，代价可忽略）。 */
function templateKindOfFormatChecked(format: FileFormat): TemplateKind {
  return formatSpec(format).template_kind;
}

function freezeRecord(record: IdempotencyRecord): IdempotencyRecord {
  return Object.freeze({ ...record });
}

/** 读回状态时的形状核对（**不猜**：形状不对就拒绝恢复，并说明哪一项不对）。 */
function readState<S>(
  value: unknown,
  options: DeliverableSessionOptions<S>,
): { readonly ok: true; readonly value: DeliverableSessionState } | { readonly ok: false; readonly reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: '落盘状态不是对象' };
  }
  const record = value as Record<string, unknown>;
  if (record['schema'] !== DELIVERABLE_SESSION_SCHEMA) {
    return {
      ok: false,
      reason: `落盘状态的 schema 标识不是 ${DELIVERABLE_SESSION_SCHEMA}（收到 ${String(record['schema'])}）`,
    };
  }
  if (record['session_id'] !== options.id) {
    return { ok: false, reason: `落盘状态的 session_id 与本会话不符（${String(record['session_id'])}）` };
  }
  if (record['deliverable_id'] !== options.deliverable_id) {
    return { ok: false, reason: '落盘状态的 deliverable_id 与本会话不符' };
  }
  if (record['file_format'] !== options.adapter.format) {
    return {
      ok: false,
      reason: `落盘状态的文件格式 ${String(record['file_format'])} 与本适配器 ${options.adapter.format} 不符`,
    };
  }
  if (record['template_kind'] !== options.adapter.template_kind) {
    return { ok: false, reason: '落盘状态的模板种类与本适配器不符（R232：两个轴都必须自洽）' };
  }
  if (record['source'] === undefined || record['source'] === null) {
    return { ok: false, reason: '落盘状态没有源（source）' };
  }
  if (typeof record['content_digest'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['content_digest'])) {
    return { ok: false, reason: '落盘状态的 content_digest 不是 64 位小写十六进制' };
  }
  const revision = record['edit_revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    return { ok: false, reason: '落盘状态的 edit_revision 不是非负整数' };
  }
  if (typeof record['filename'] !== 'string' || record['filename'].length === 0) {
    return { ok: false, reason: '落盘状态没有可用的 filename' };
  }
  if (record['filename'] !== options.filename) {
    return {
      ok: false,
      reason: `落盘状态的 filename ${JSON.stringify(String(record['filename']))} 与本会话声明的 ` +
        `${JSON.stringify(options.filename)} 不符`,
    };
  }
  const published = record['published'];
  if (!Array.isArray(published)) {
    return { ok: false, reason: '落盘状态的 published 不是数组' };
  }
  const log = record['log'];
  if (!Array.isArray(log)) {
    return { ok: false, reason: '落盘状态的 log 不是数组' };
  }
  const idempotency = record['idempotency'];
  if (!Array.isArray(idempotency)) {
    return { ok: false, reason: '落盘状态的 idempotency 不是数组' };
  }
  const sourceKind = record['source_kind'];
  if (
    sourceKind !== 'user_request' &&
    sourceKind !== 'imported' &&
    sourceKind !== 'model_generated' &&
    sourceKind !== 'system'
  ) {
    return { ok: false, reason: `落盘状态的 source_kind 非法（${String(sourceKind)}）` };
  }
  return { ok: true, value: record as unknown as DeliverableSessionState };
}

function fail(
  code: DeliverableFailureCode,
  message: string,
  extra: Readonly<Record<string, unknown>>,
): { readonly ok: false; readonly code: DeliverableFailureCode; readonly message: string; readonly detail: { readonly extra: Readonly<Record<string, unknown>> } } {
  return Object.freeze({
    ok: false as const,
    code,
    message,
    detail: Object.freeze({ extra: Object.freeze({ ...extra }) }),
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
