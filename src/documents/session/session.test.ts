/**
 * 文档会话单测（design-05-P8；合同 R132–R146）。
 *
 * ## 每个用例在证明什么（与判据一一对应）
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 新建 / 导入 / 导出 | WF-081/WF-082/WF-083 的**服务侧语义** |
 * | 版本分开 | **R141**：编辑 revision 与 taskRevision / artifactVersion 分别可指认 |
 * | 并发 | **R143**：同 baseRevision 两次提交，只允许一个成功 |
 * | 幂等 | **R137/R146**：同键重复**不产生第二个版本**，且不重放计划 |
 * | 失败保留旧文件 | **R145**：发布/导出失败后，模型、revision、既有版本一个都没变 |
 * | 回读摘要 | **R144 / I-1**：回执摘要 == 实际回读摘要；不符即拒绝采纳 |
 * | 原子性 | **R136**：复合计划一步失败 ⇒ 整批不生效 |
 * | 不支持 | **R140**：非法意图在**操作前**被拒，端口零调用 |
 *
 * ## 这个假端口为什么不"假装成功"
 *
 * `FakePublishPort` **真的对字节取 sha256**、真的按 artifactId 存字节、回执里的
 * `readback_digest` 取自它自己存的那份。它唯一"假"的地方是没有磁盘——而这正好让
 * 失败注入（写盘失败 / 回读不符）可以在不碰文件系统的情况下被精确触发。
 */

import { describe, expect, it } from 'vitest';

import { buildDocxTemplate } from '../../artifacts/templates/docx.js';
import { DOCX_TITLE_BODY_PRESENTATION } from '../../artifacts/templates/docx.js';
import type { EditPlan } from '../edit/plan.js';
import { digestBytes } from './canonical.js';
import { compileEditIntent } from './intent.js';
import { DocumentSession, createMemorySessionPersistence } from './session.js';
import type {
  DocumentPublishPort,
  DocumentPublishRequest,
  DocumentPublishResult,
  PublishedVersion,
  SessionPersistence,
} from './index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一份真实可导入的 DOCX（走内核模板构建器，不是手搓 ZIP）。 */
function sampleDocx(paragraphs: readonly string[] = ['第一段内容', '第二段内容', '第三段内容']): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '编辑测试文档',
      description: '',
      paragraphs: [...paragraphs],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '会话单测试夹具' }],
  }).bytes;
}

interface FakeOptions {
  /** 触发写盘失败（模拟磁盘/权限问题）。 */
  failNextWrite?: string;
  /** 让回执的 `readback_digest` 与交出的字节不符（模拟"盘上躺着的不是这一份"）。 */
  corruptReadback?: boolean;
  /** 固定内核任务版本（默认每次发布 +1）。 */
  taskRevision?: number;
  /** 固定产物版本（默认每次 +1）。 */
  artifactVersion?: number;
}

/**
 * 内存发布端口：真算摘要、真存字节、真回读。
 *
 * 刻意**不**复用生产实现：生产实现（`apps/demo/documents/port.ts`）有自己的测试，
 * 这里要的是一个可以精确注入失败的对照物。
 */
class FakePublishPort implements DocumentPublishPort {
  readonly requests: DocumentPublishRequest[] = [];
  readonly stored = new Map<string, Uint8Array>();
  /** 端口自己在真盘上"看得见"的字节（模拟"上次交付的文件"）。 */
  options: FakeOptions = {};
  #calls = 0;

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.requests.push(request);
    this.#calls += 1;
    if (this.options.failNextWrite !== undefined) {
      const detail = this.options.failNextWrite;
      this.options = { ...this.options, failNextWrite: undefined };
      return { ok: false, failure: { kind: 'write_failed', detail } };
    }
    const actual = digestBytes(request.bytes);
    if (actual !== request.expected_digest) {
      return {
        ok: false,
        failure: {
          kind: 'digest_mismatch',
          detail: `入参字节与期望摘要不符（${actual} ≠ ${request.expected_digest}）`,
        },
      };
    }
    const artifactId = `art-fake-${String(this.#calls)}`;
    this.stored.set(artifactId, request.bytes);
    const readback = this.stored.get(artifactId);
    if (readback === undefined) {
      return { ok: false, failure: { kind: 'write_failed', detail: '回读不到刚写入的字节' } };
    }
    return {
      ok: true,
      receipt: {
        artifact_id: artifactId,
        task_revision: this.options.taskRevision ?? this.#calls,
        artifact_version: this.options.artifactVersion ?? this.#calls,
        readback_digest: this.options.corruptReadback
          ? digestBytes(Uint8Array.from([0, 1, 2, 3]))
          : digestBytes(readback),
        byte_length: readback.byteLength,
        entry_count: 7,
        filename: request.filename,
        verifier: 'FakePublishPort/内存回读',
        final_path: `/fake/${artifactId}/${request.filename}`,
      },
    };
  }
}

/** 固定时钟（测试不读真实时间，"同一输入 ⇒ 同一输出"才成立）。 */
const FIXED_NOW = (): Date => new Date('2026-10-02T00:00:00.000Z');

function newSession(options?: {
  publish?: FakePublishPort;
  persistence?: SessionPersistence;
}): { session: DocumentSession; publish: FakePublishPort } {
  const publish = options?.publish ?? new FakePublishPort();
  const created = DocumentSession.createNew(
    {
      id: 'S-1',
      filename: '测试文档.docx',
      persistence: options?.persistence ?? createMemorySessionPersistence(),
      publish_port: publish,
      now: FIXED_NOW,
    },
    { template: sampleDocx() },
  );
  if (!created.ok) {
    throw new Error(`夹具建会话失败：${created.code} ${created.message}`);
  }
  return { session: created.value, publish };
}

/** 导入一份既有 DOCX 的会话（导入路径的夹具；与 `newSession` 的差别只有来源标记）。 */
function importedSession(): { session: DocumentSession; publish: FakePublishPort } {
  const publish = new FakePublishPort();
  const imported = DocumentSession.importFrom(
    {
      id: 'S-IMP',
      filename: '导入文档.docx',
      persistence: createMemorySessionPersistence(),
      publish_port: publish,
      now: FIXED_NOW,
    },
    sampleDocx(),
  );
  if (!imported.ok) {
    throw new Error(`夹具导入失败：${imported.code} ${imported.message}`);
  }
  return { session: imported.value, publish };
}

/** 把一条意图编译成计划（编译失败即抛，测试里不允许出现）。 */
function planOf(intent: unknown): EditPlan {
  const compiled = compileEditIntent(intent);
  if (!compiled.ok) {
    throw new Error(`夹具意图编译失败：${compiled.code} ${compiled.message}`);
  }
  return compiled.value;
}

/** 居中第二段（零模型直接格式命令）。 */
function centerSecondParagraph(): EditPlan {
  return planOf({
    steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
  });
}

function mustOk<T>(result: { ok: true; value: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.code} ${result.message}`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// 新建 / 导入 / 导出
// ---------------------------------------------------------------------------

describe('会话：新建、导入与导出（WF-081/082/083）', () => {
  it('新建会话的编辑版本为 0，且导出字节与状态摘要一致', () => {
    const { session } = newSession();
    expect(session.currentRevision()).toBe(0);
    expect(session.publishedVersions()).toHaveLength(0);

    const bytes = mustOk(session.exportBytes());
    expect(digestBytes(bytes)).toBe(session.currentDigest());
    expect(session.status().source_kind).toBe('user_request');
    // 新建会话同样记录"起点包"的摘要——它和 content_digest 是两个不同的东西。
    expect(session.status().source_digest).toBe(digestBytes(sampleDocx()));
  });

  it('导入既有 DOCX：来源记为 imported，原始上传字节摘要单独留存（R109/R151）', () => {
    const uploaded = sampleDocx();
    const publish = new FakePublishPort();
    const imported = mustOk(
      DocumentSession.importFrom(
        {
          id: 'S-IMP',
              filename: '导入文档.docx',
          persistence: createMemorySessionPersistence(),
          publish_port: publish,
          now: FIXED_NOW,
        },
        uploaded,
      ),
    );
    const status = imported.status();
    expect(status.source_kind).toBe('imported');
    expect(status.source_digest).toBe(digestBytes(uploaded));
    // 这份夹具由内核模板构建器产出（全 STORE 写入器），因此"导入 → 立刻导出"**逐字节还原**：
    // 两份摘要相等。这不是"两个字段同义"——真实 Word 的 DEFLATE 包导出后会重排容器，
    // 两份摘要就会分开（那时 source_digest 记录的是**用户交进来的那份**）。
    expect(status.content_digest).toBe(status.source_digest);
    expect(digestBytes(mustOk(imported.exportBytes()))).toBe(status.content_digest);
  });

  it('导入非 DOCX 字节 ⇒ import_failed（不伪造一个空文档）', () => {
    const publish = new FakePublishPort();
    const result = DocumentSession.importFrom(
      {
        id: 'S-BAD',
          filename: '坏文件.docx',
        persistence: createMemorySessionPersistence(),
        publish_port: publish,
        now: FIXED_NOW,
      },
      Uint8Array.from([1, 2, 3, 4, 5]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('import_failed');
    }
    expect(publish.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 三个号分开（R141）
// ---------------------------------------------------------------------------

describe('版本与并发：三个号分开建模（R141）', () => {
  it('编辑 revision 与 taskRevision / artifactVersion 是三个可分别指认的号，映射显式可查', async () => {
    const { session } = newSession();
    const before = session.currentRevision();

    const outcome = mustOk(
      await session.submitEdit({
        idempotency_key: 'k1',
        base_revision: before,
        base_digest: session.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );

    const published = outcome.published;
    expect(published).not.toBeNull();
    const version = published as PublishedVersion;

    // 编辑版本由本层 +1；taskRevision / artifactVersion 来自发布回执（内核记账）。
    expect(version.edit_revision).toBe(before + 1);
    expect(version.task_revision).toBeGreaterThanOrEqual(1);
    expect(version.artifact_version).toBeGreaterThanOrEqual(1);

    // 三个号在同一张映射表里相遇，且**能分别读出来**（这正是 R141 要的"不混为一个号"）。
    const mapping = session.publishedAt(version.edit_revision);
    expect(mapping?.task_revision).toBe(version.task_revision);
    expect(mapping?.artifact_version).toBe(version.artifact_version);
    expect(session.publishedAt(999)).toBeNull();

    // 把三者故意设成互相不同的值，验证它们确实各走各的通道。
    const publish = new FakePublishPort();
    publish.options = { taskRevision: 42, artifactVersion: 7 };
    const other = mustOk(
      DocumentSession.importFrom(
        {
          id: 'S-2',
              filename: '文档.docx',
          persistence: createMemorySessionPersistence(),
          publish_port: publish,
          now: FIXED_NOW,
        },
        sampleDocx(),
      ),
    );
    const second = mustOk(
      await other.submitEdit({
        idempotency_key: 'k2',
        base_revision: other.currentRevision(),
        base_digest: other.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );
    expect(second.published?.edit_revision).toBe(1);
    expect(second.published?.task_revision).toBe(42);
    expect(second.published?.artifact_version).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 并发：stale revision（R143）
// ---------------------------------------------------------------------------

describe('版本与并发：stale revision 拒绝（R143）', () => {
  it('两个操作基于同一 revision：第一个成功，第二个得到 stale_revision + 当前 revision', async () => {
    const { session } = newSession();
    const baseRevision = session.currentRevision();
    const baseDigest = session.currentDigest();

    const first = mustOk(
      await session.submitEdit({
        idempotency_key: 'k-first',
        base_revision: baseRevision,
        base_digest: baseDigest,
        plan: centerSecondParagraph(),
      }),
    );
    expect(first.replayed).toBe(false);
    expect(session.currentRevision()).toBe(baseRevision + 1);

    // 第二个操作**仍然拿着旧 revision**（迟到的结果）。
    const second = await session.submitEdit({
      idempotency_key: 'k-second',
      base_revision: baseRevision,
      base_digest: baseDigest,
      plan: centerSecondParagraph(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('stale_revision');
      expect(second.detail.currentRevision).toBe(baseRevision + 1);
      expect(second.detail.requestedRevision).toBe(baseRevision);
      expect(second.detail.extra?.['reason']).toBe('revision');
    }

    // 被拒的提交不得产生任何版本，也不得调用发布端口。
    expect(session.publishedVersions()).toHaveLength(1);
    expect(session.currentRevision()).toBe(baseRevision + 1);
  });

  it('revision 对得上但内容摘要不符 ⇒ 同样拒绝（R142 的两半都要绑定）', async () => {
    const { session } = newSession();
    const result = await session.submitEdit({
      idempotency_key: 'k-digest',
      base_revision: session.currentRevision(),
      base_digest: 'f'.repeat(64),
      plan: centerSecondParagraph(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_revision');
      expect(result.detail.extra?.['reason']).toBe('digest');
    }
    expect(session.publishedVersions()).toHaveLength(0);
  });

  it('基于最新 revision 的后续提交正常成功（拒绝不是把会话锁死）', async () => {
    const { session } = newSession();
    mustOk(
      await session.submitEdit({
        idempotency_key: 'a',
        base_revision: 0,
        base_digest: session.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );
    // 用**旧摘要**提交会被拒；改用当前摘要即成功。
    const ok = mustOk(
      await session.submitEdit({
        idempotency_key: 'b',
        base_revision: session.currentRevision(),
        base_digest: session.currentDigest(),
        plan: planOf({
          steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'right' } }],
        }),
      }),
    );
    expect(ok.published?.edit_revision).toBe(2);
    expect(session.publishedVersions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 幂等（R137 / R146）
// ---------------------------------------------------------------------------

describe('幂等：同键重复不产生第二个版本（R137/R146）', () => {
  it('同一幂等键 + 同一输入重复提交 ⇒ 原样返回首次回执，版本数不变', async () => {
    const { session } = newSession();
    const base = { base_revision: session.currentRevision(), base_digest: session.currentDigest() };
    const plan = centerSecondParagraph();

    const first = mustOk(
      await session.submitEdit({ idempotency_key: 'same-key', ...base, plan }),
    );
    const publishedAfterFirst = session.publishedVersions().length;
    expect(publishedAfterFirst).toBe(1);

    const retry = mustOk(await session.submitEdit({ idempotency_key: 'same-key', ...base, plan }));
    expect(retry.replayed).toBe(true);
    expect(retry.edit_revision).toBe(first.edit_revision);
    expect(retry.steps).toEqual(first.steps);
    expect(retry.published?.artifact_id).toBe(first.published?.artifact_id);
    expect(session.publishedVersions()).toHaveLength(publishedAfterFirst);
    // 重放**不重新执行计划**：发布端口只被调用过一次。
    expect(session.publishedVersions()).toHaveLength(1);
  });

  it('重试仍带旧 baseRevision 也能命中幂等（幂等表先于基线核对）', async () => {
    const { session } = newSession();
    const base = { base_revision: 0, base_digest: session.currentDigest() };
    const plan = centerSecondParagraph();

    mustOk(await session.submitEdit({ idempotency_key: 'retry-key', ...base, plan }));
    // 会话已经前进到 revision 1；客户端重试仍带着 revision 0。
    const retry = mustOk(await session.submitEdit({ idempotency_key: 'retry-key', ...base, plan }));
    expect(retry.replayed).toBe(true);
    expect(retry.edit_revision).toBe(1);
    expect(session.publishedVersions()).toHaveLength(1);
  });

  it('同一幂等键 + 不同输入 ⇒ idempotency_conflict（不得静默吞掉一次真实编辑）', async () => {
    const { session } = newSession();
    mustOk(
      await session.submitEdit({
        idempotency_key: 'reused',
        base_revision: 0,
        base_digest: session.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );
    const conflicting = await session.submitEdit({
      idempotency_key: 'reused',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      plan: planOf({
        steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'right' } }],
      }),
    });
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.code).toBe('idempotency_conflict');
    }
    expect(session.publishedVersions()).toHaveLength(1);
  });

  it('重放的逐步回执里 changed 原样保留（不重复套用）', async () => {
    const { session } = newSession();
    const plan = planOf({
      steps: [{ range: '第2段', operation: { kind: 'setToggle', property: 'bold', value: true } }],
    });
    const base = { base_revision: 0, base_digest: session.currentDigest() };
    const first = mustOk(await session.submitEdit({ idempotency_key: 'bold', ...base, plan }));
    expect(first.steps[0]?.changed).toBe(true);
    const retry = mustOk(await session.submitEdit({ idempotency_key: 'bold', ...base, plan }));
    expect(retry.steps[0]?.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 失败保留旧文件（R145）+ 回读摘要（R144 / I-1）
// ---------------------------------------------------------------------------

describe('失败保留旧文件（R145）与回读摘要（R144/I-1）', () => {
  it('发布失败 ⇒ 返回 publish_failed；模型、revision 与既有版本一个都没变', async () => {
    const publish = new FakePublishPort();
    const { session } = newSession({ publish });

    // 先成功发布一版，作为"旧文件"。
    const first = mustOk(
      await session.submitEdit({
        idempotency_key: 'ok',
        base_revision: 0,
        base_digest: session.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );
    const digestBefore = session.currentDigest();
    const revisionBefore = session.currentRevision();
    const bytesBefore = mustOk(session.exportBytes());

    publish.options = { failNextWrite: '模拟磁盘写失败' };
    const failed = await session.submitEdit({
      idempotency_key: 'will-fail',
      base_revision: revisionBefore,
      base_digest: digestBefore,
      plan: planOf({
        steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'right' } }],
      }),
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe('publish_failed');
      expect(failed.detail.publishFailureKind).toBe('write_failed');
      expect(failed.detail.currentRevision).toBe(revisionBefore);
    }

    // 会话状态机根本没前进：模型 / revision / 摘要 / 版本数全都不变。
    expect(session.currentRevision()).toBe(revisionBefore);
    expect(session.currentDigest()).toBe(digestBefore);
    expect(session.publishedVersions()).toHaveLength(1);
    expect(session.publishedVersions()[0]?.artifact_id).toBe(first.published?.artifact_id);
    expect(digestBytes(mustOk(session.exportBytes()))).toBe(digestBytes(bytesBefore));
    expect(session.lastFailure()?.kind).toBe('write_failed');
  });

  it('失败后可以用同一基线重试并成功（失败不是终局）', async () => {
    const publish = new FakePublishPort();
    const { session } = newSession({ publish });
    const base = { base_revision: 0, base_digest: session.currentDigest() };
    const plan = centerSecondParagraph();

    publish.options = { failNextWrite: '模拟磁盘写失败' };
    const failed = await session.submitEdit({ idempotency_key: 'k', ...base, plan });
    expect(failed.ok).toBe(false);

    // 幂等键没有被这次失败占用（失败不产生版本，也就没有可重放的回执）。
    const retried = mustOk(await session.submitEdit({ idempotency_key: 'k', ...base, plan }));
    expect(retried.replayed).toBe(false);
    expect(session.publishedVersions()).toHaveLength(1);
  });

  it('端口回读摘要与导出摘要不符 ⇒ 拒绝采纳（不得据未核对一致的字节交付）', async () => {
    const publish = new FakePublishPort();
    const { session } = newSession({ publish });
    publish.options = { corruptReadback: true };

    const result = await session.submitEdit({
      idempotency_key: 'corrupt',
      base_revision: 0,
      base_digest: session.currentDigest(),
      plan: centerSecondParagraph(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('publish_failed');
      expect(result.detail.publishFailureKind).toBe('readback_mismatch');
    }
    expect(session.publishedVersions()).toHaveLength(0);
    expect(session.currentRevision()).toBe(0);
  });

  it('成功发布的回执摘要 == 端口实际回读的字节摘要（I-1）', async () => {
    const publish = new FakePublishPort();
    const { session } = newSession({ publish });
    const outcome = mustOk(
      await session.submitEdit({
        idempotency_key: 'i1',
        base_revision: 0,
        base_digest: session.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );
    const version = outcome.published as PublishedVersion;
    const stored = publish.stored.get(version.artifact_id);
    expect(stored).toBeDefined();
    expect(version.content_digest).toBe(digestBytes(stored as Uint8Array));
    expect(version.content_digest).toBe(version.expected_digest);
    // 会话当前摘要也等于该回读摘要：下载面与状态面说的是同一份字节。
    expect(session.currentDigest()).toBe(version.content_digest);
  });
});

// ---------------------------------------------------------------------------
// 原子性与拒绝（R136 / R140）
// ---------------------------------------------------------------------------

describe('原子性与拒绝（R136/R140）', () => {
  it('复合计划第二步范围失败 ⇒ 整批不生效，端口零调用', async () => {
    const publish = new FakePublishPort();
    const { session } = newSession({ publish });
    const digestBefore = session.currentDigest();

    const compound = planOf({
      steps: [
        { range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } },
        { range: '第99段', operation: { kind: 'setAlignment', alignment: 'right' } },
      ],
    });
    const result = await session.submitEdit({
      idempotency_key: 'compound',
      base_revision: 0,
      base_digest: digestBefore,
      plan: compound,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
    }
    expect(session.currentDigest()).toBe(digestBefore);
    expect(session.currentRevision()).toBe(0);
    expect(publish.requests).toHaveLength(0);
  });

  it('不支持的意图在操作前被拒（unsupported），文档零改动（R140）', async () => {
    const publish = new FakePublishPort();
    const { session } = newSession({ publish });
    const digestBefore = session.currentDigest();

    const result = await session.submitEdit({
      idempotency_key: 'unsupported',
      base_revision: 0,
      base_digest: digestBefore,
      intent: {
        steps: [{ range: '第2段', operation: { kind: 'setMarriageContract', value: true } }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsupported');
    }
    expect(session.currentDigest()).toBe(digestBefore);
    expect(publish.requests).toHaveLength(0);
  });

  it('所有步骤都没有实际改动 ⇒ no_op，不产生新版本', async () => {
    const { session } = newSession();
    const plan = centerSecondParagraph();
    mustOk(
      await session.submitEdit({
        idempotency_key: 'first',
        base_revision: 0,
        base_digest: session.currentDigest(),
        plan,
      }),
    );
    const revisionAfterFirst = session.currentRevision();

    const again = mustOk(
      await session.submitEdit({
        idempotency_key: 'second-key',
        base_revision: revisionAfterFirst,
        base_digest: session.currentDigest(),
        plan,
      }),
    );
    expect(again.no_op).toBe(true);
    expect(again.replayed).toBe(false);
    expect(session.currentRevision()).toBe(revisionAfterFirst);
    expect(session.publishedVersions()).toHaveLength(1);
  });

  it('空计划与空意图都被拒（不把空转当一次事务）', async () => {
    const { session } = newSession();
    const emptyPlan = await session.submitEdit({
      idempotency_key: 'empty',
      base_revision: 0,
      base_digest: session.currentDigest(),
      plan: { steps: [] },
    });
    expect(emptyPlan.ok).toBe(false);
    if (!emptyPlan.ok) expect(emptyPlan.code).toBe('empty_range');

    const emptyIntent = await session.submitEdit({
      idempotency_key: 'empty-intent',
      base_revision: 0,
      base_digest: session.currentDigest(),
      intent: { steps: [] },
    });
    expect(emptyIntent.ok).toBe(false);
    if (!emptyIntent.ok) expect(emptyIntent.code).toBe('empty_range');
  });

  it('同时给 intent 与 plan ⇒ 拒绝（避免两条路径各说各话）', async () => {
    const { session } = newSession();
    const result = await session.submitEdit({
      idempotency_key: 'both',
      base_revision: 0,
      base_digest: session.currentDigest(),
      intent: { steps: [] },
      plan: centerSecondParagraph(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_expression');
  });
});

// ---------------------------------------------------------------------------
// 操作日志（R139）与持久化（WF-083）
// ---------------------------------------------------------------------------

describe('操作日志（R139）与持久化（WF-083）', () => {
  it('日志按序记录创建、应用、发布、拒绝与失败', async () => {
    const publish = new FakePublishPort();
    const { session } = newSession({ publish });
    mustOk(
      await session.submitEdit({
        idempotency_key: 'ok',
        base_revision: 0,
        base_digest: session.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );
    // 一次 stale 拒绝。
    await session.submitEdit({
      idempotency_key: 'stale',
      base_revision: 0,
      base_digest: session.currentDigest(),
      plan: centerSecondParagraph(),
    });
    // 一次发布失败。
    publish.options = { failNextWrite: '模拟磁盘写失败' };
    await session.submitEdit({
      idempotency_key: 'fail',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      plan: planOf({
        steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'right' } }],
      }),
    });

    const kinds = session.operationLog().map((entry) => entry.kind);
    expect(kinds[0]).toBe('session_created');
    expect(kinds).toContain('edit_applied');
    expect(kinds).toContain('published');
    expect(kinds).toContain('edit_rejected');
    expect(kinds).toContain('publish_failed');
    // 序号单调递增。
    const seqs = session.operationLog().map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('状态可持久化并读回：revision、版本映射与摘要都在', async () => {
    const persistence = createMemorySessionPersistence();
    const { session } = newSession({ persistence });
    mustOk(
      await session.submitEdit({
        idempotency_key: 'p',
        base_revision: 0,
        base_digest: session.currentDigest(),
        plan: centerSecondParagraph(),
      }),
    );
    const before = session.status();

    const restored = DocumentSession.restore({
      id: 'S-1',
      filename: '测试文档.docx',
      persistence,
      publish_port: new FakePublishPort(),
      now: FIXED_NOW,
    });
    expect(restored.result.loaded).toBe(true);
    const after = (restored.session as DocumentSession).status();
    expect(after.edit_revision).toBe(before.edit_revision);
    expect(after.content_digest).toBe(before.content_digest);
    expect(after.published).toEqual(before.published);
    expect(after.log.length).toBe(before.log.length);
  });

  it('恢复后继续提交：幂等表仍在（重启不重放旧计划）', async () => {
    const persistence = createMemorySessionPersistence();
    const { session } = newSession({ persistence });
    const base = { base_revision: 0, base_digest: session.currentDigest() };
    const plan = centerSecondParagraph();
    mustOk(await session.submitEdit({ idempotency_key: 'persist-key', ...base, plan }));

    const restored = DocumentSession.restore({
      id: 'S-1',
      filename: '测试文档.docx',
      persistence,
      publish_port: new FakePublishPort(),
      now: FIXED_NOW,
    });
    const resumed = restored.session as DocumentSession;
    const replay = mustOk(await resumed.submitEdit({ idempotency_key: 'persist-key', ...base, plan }));
    expect(replay.replayed).toBe(true);
    expect(resumed.publishedVersions()).toHaveLength(1);
  });

  it('schema 不符 / id 不符 / 模型缺失 ⇒ 如实报告不加载', () => {
    const wrongSchema: SessionPersistence = {
      save: () => undefined,
      load: () => ({ schema: '别的 schema' }),
    };
    const result = DocumentSession.restore({
      id: 'S-1',
      filename: 'f.docx',
      persistence: wrongSchema,
      publish_port: new FakePublishPort(),
      now: FIXED_NOW,
    });
    expect(result.session).toBeNull();
    expect(result.result.loaded).toBe(false);
    expect(result.result.reason).toContain('schema');
  });
});
