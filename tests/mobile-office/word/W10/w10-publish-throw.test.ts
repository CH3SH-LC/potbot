/**
 * **W10 集成波 · 发布端口抛异常的收口**（W-R02 报出的健壮性缺口）。
 *
 * ## 缺陷（修复前）
 *
 * `DocumentPublishPort` 是**注入**的。`submitEdit` 只处理了端口"优雅返回失败"
 * （`{ ok:false, failure:{ kind, detail } }`）的那一半；若端口实现直接 `throw`
 * （磁盘故障、进程被杀、第三方库把错误抛出来），异常会穿过 `submitEdit` 到调用方，
 * 而这门"唯一的写入口"于是有了两种失败形态——调用方无法写一个确定的错误分支。
 * （W-R02 `scale-cancel-recovery.test.ts` 第 336 行原样记录了这个 bug。）
 *
 * ## 修复后的契约（本文件逐条断言）
 *
 * | 断言 | 判据 |
 * |---|---|
 * | 端口抛异常 ⇒ `submitEdit` **返回** `publish_failed`，不抛出 | 失败形态收敛为一种 |
 * | 失败种类 `port_threw`，消息含端口抛出的原文 | 结构化、可诊断 |
 * | `edit_revision` 不动、零交付、导出摘要不变 | R145：状态机不前进 |
 * | 撤销栈 / 既有版本 / 幂等表一个不动 | 抛异常那次提交不留下半截事务 |
 * | 同一编辑在**健康端口**上成功 | 反向对照：被拒的是"这次发布"，不是"这个编辑" |
 * | `{ kind:'cancelled' }` 的结构化失败路径原样保留 | 不因新增 catch 而改变既有语义 |
 *
 * ## 这个假端口为什么不"假装成功"
 *
 * `RecordingPublishPort` **真的**对交出的字节取 sha256、真的按 artifactId 存字节、
 * 回执里的 `readback_digest` 取自它自己存的那份。它唯一"假"的是没有磁盘——
 * 而这正好让 `throwNext` / `failNext` 两种故障可以在不碰文件系统的情况下被精确注入。
 */

import { describe, expect, it } from 'vitest';

import {
  DOCX_TITLE_BODY_PRESENTATION,
  buildDocxTemplate,
} from '../../../../src/artifacts/templates/docx.js';
import {
  DocumentSession,
  createMemorySessionPersistence,
  digestBytes,
  type DocumentPublishPort,
  type DocumentPublishRequest,
  type DocumentPublishResult,
  type SessionResult,
  type SubmitEditOutcome,
} from '../../../../src/documents/session/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 固定时钟（本文件不读真实时间，"同一输入 ⇒ 同一输出"才成立）。 */
const FIXED_NOW = (): Date => new Date('2026-10-03T00:00:00.000Z');

/**
 * 一份真实可导入的 DOCX（走内核模板构建器，不是手搓 ZIP）。
 *
 * 标题/正文用中文：模板构建器的 P6 护栏会拒绝"正文里出现快照里没有的阿拉伯数字"，
 * 这不是 bug 是护栏在工作，夹具不该绕过它。
 */
function sampleDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '发布端口抛错测试文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '会话发布抛错夹具' }],
  }).bytes;
}

/**
 * 内存发布端口：真算摘要、真存字节、真回读；可精确注入"抛异常"与"结构化失败"。
 *
 * `deliveries` 只统计**成功写成**的交付：端口抛异常时它必须不动——
 * 这正是"失败没有交付"的可观测证据。
 */
class RecordingPublishPort implements DocumentPublishPort {
  readonly requests: DocumentPublishRequest[] = [];
  readonly stored = new Map<string, Uint8Array>();
  /** 下一次发布**直接抛异常**（消息进异常对象；用完即清）。 */
  throwNext: string | null = null;
  /** 下一次发布结构化失败（用于证明 `{kind:'cancelled'}` 路径未被改动）；用完即清。 */
  failNext: { readonly kind: string; readonly detail: string } | null = null;
  /** 成功写成的交付次数。 */
  deliveries = 0;
  #calls = 0;

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.requests.push(request);
    this.#calls += 1;
    if (this.throwNext !== null) {
      const message = this.throwNext;
      this.throwNext = null;
      throw new Error(message);
    }
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return { ok: false, failure: { kind: failure.kind, detail: failure.detail } };
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
    const artifactId = `art-throw-${String(this.#calls)}`;
    const stored = Uint8Array.from(request.bytes);
    this.stored.set(artifactId, stored);
    this.deliveries += 1;
    return {
      ok: true,
      receipt: {
        artifact_id: artifactId,
        task_revision: this.#calls,
        artifact_version: this.#calls,
        readback_digest: digestBytes(stored),
        byte_length: stored.byteLength,
        entry_count: 0,
        filename: request.filename,
        verifier: 'w10-publish-throw/内存回读',
        final_path: `/mem/${artifactId}/${request.filename}`,
      },
    };
  }
}

function importedSession(port: RecordingPublishPort, id = 'W10-THROW'): DocumentSession {
  const created = DocumentSession.importFrom(
    {
      id,
      filename: '抛错.docx',
      persistence: createMemorySessionPersistence(),
      publish_port: port,
      now: FIXED_NOW,
    },
    sampleDocx(),
  );
  if (!created.ok) {
    throw new Error(`夹具导入失败：${created.code} ${created.message}`);
  }
  return created.value;
}

/** 把正文第 2 段居中的直接格式命令（零模型路径）。 */
function centerSecondParagraph(): unknown {
  return { steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }] };
}

/**
 * 把正文第 3 段居中的直接格式命令。
 *
 * D1 需要**两次真正改变字节**的编辑：对同一段再居中一次是逐字节空转
 * （段落属性 helper 是值语义，见 `session.ts` 的空转说明），那样的第二次提交
 * 根本走不到发布端口，测不到本文件的主题。
 */
function centerThirdParagraph(): unknown {
  return { steps: [{ range: '第3段', operation: { kind: 'setAlignment', alignment: 'center' } }] };
}

/** 从当前会话取基线构造一次提交入参（版本号不手抄）。 */
function submitInput(
  session: DocumentSession,
  key: string,
  intent: unknown = centerSecondParagraph(),
): { idempotency_key: string; base_revision: number; base_digest: string; intent: unknown } {
  return {
    idempotency_key: key,
    base_revision: session.currentRevision(),
    base_digest: session.currentDigest(),
    intent,
  };
}

function mustOk<T>(result: SessionResult<T>): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.code} ${result.message}`);
  }
  return result.value;
}

const THROWN_MESSAGE = '注入：发布端口在写盘中途抛出（未优雅返回失败）';

// ---------------------------------------------------------------------------
// §A 端口抛异常 ⇒ 结构化失败，状态机不前进
// ---------------------------------------------------------------------------

describe('§A 端口抛异常：submitEdit 收敛为结构化 publish_failed（不向上抛）', () => {
  it('A1. 抛异常 ⇒ 返回 ok:false / publish_failed / kind=port_threw，消息含端口抛出的原文', async () => {
    const port = new RecordingPublishPort();
    const session = importedSession(port);
    const digestBefore = session.currentDigest();
    const revisionBefore = session.currentRevision();

    port.throwNext = THROWN_MESSAGE;
    // 关键：这里**不**用 try/catch——修复后 submitEdit 必须先接住异常、再结构化返回。
    const result = await session.submitEdit(submitInput(session, 'k-throw'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('publish_failed');
    expect(result.detail.publishFailureKind).toBe('port_threw');
    expect(result.message).toContain(THROWN_MESSAGE);
    // 端口确实被调过一次（失败点发生在发布，不是编译期就拒）。
    expect(port.requests).toHaveLength(1);

    // R145：revision / 交付 / 导出摘要一个都没动。
    expect(session.currentRevision()).toBe(revisionBefore);
    expect(session.publishedVersions()).toHaveLength(0);
    expect(port.deliveries).toBe(0);
    const exported = mustOk(session.exportBytes());
    expect(digestBytes(exported)).toBe(digestBefore);
  });

  it('A2. lastFailure 与操作日志如实记下这一次 port_threw（失败也留痕）', async () => {
    const port = new RecordingPublishPort();
    const session = importedSession(port, 'W10-THROW-LOG');

    port.throwNext = THROWN_MESSAGE;
    const result = await session.submitEdit(submitInput(session, 'k-log'));
    expect(result.ok).toBe(false);

    const lastFailure = session.lastFailure();
    expect(lastFailure?.kind).toBe('port_threw');
    expect(lastFailure?.detail).toContain(THROWN_MESSAGE);
    expect(
      session
        .operationLog()
        .some((entry) => entry.kind === 'publish_failed' && entry.rejection?.code === 'port_threw'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §B 反向对照：同一编辑在健康端口上成功
// ---------------------------------------------------------------------------

describe('§B 反向对照：被拒的是"这次发布"，不是"这个编辑"', () => {
  it('B1. 抛异常后禁用故障、复用同一个幂等键重试 ⇒ 成功且版本 +1', async () => {
    const port = new RecordingPublishPort();
    const session = importedSession(port, 'W10-THROW-RETRY');

    port.throwNext = THROWN_MESSAGE;
    const first = await session.submitEdit(submitInput(session, 'k-retry'));
    expect(first.ok).toBe(false);

    // 抛异常的那次提交**没有**占用幂等键、也没有推进版本 —— 复用同一个键可以成功。
    port.throwNext = null;
    const retry = await session.submitEdit(submitInput(session, 'k-retry'));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect((retry.value as SubmitEditOutcome).replayed).toBe(false);
    expect(session.currentRevision()).toBe(1);
    expect(session.publishedVersions()).toHaveLength(1);
    expect(port.deliveries).toBe(1);
  });

  it('B2. 同一编辑在两份会话上：抛错端口失败、健康端口成功（端口是唯一变量）', async () => {
    const intent = centerSecondParagraph();

    const brokenPort = new RecordingPublishPort();
    const broken = importedSession(brokenPort, 'W10-BROKEN');
    brokenPort.throwNext = THROWN_MESSAGE;
    const brokenResult = await broken.submitEdit({
      idempotency_key: 'k-pair',
      base_revision: broken.currentRevision(),
      base_digest: broken.currentDigest(),
      intent,
    });
    expect(brokenResult.ok).toBe(false);

    const healthyPort = new RecordingPublishPort();
    const healthy = importedSession(healthyPort, 'W10-HEALTHY');
    const healthyResult = await healthy.submitEdit({
      idempotency_key: 'k-pair',
      base_revision: healthy.currentRevision(),
      base_digest: healthy.currentDigest(),
      intent,
    });
    expect(healthyResult.ok).toBe(true);
    expect(healthy.currentRevision()).toBe(1);
    expect(healthyPort.deliveries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §C {kind:'cancelled'} 的结构化失败路径原样保留
// ---------------------------------------------------------------------------

describe('§C 既有 cancelled 路径未被改动', () => {
  it('C1. 端口返回 {kind:cancelled} ⇒ publish_failed / kind=cancelled，状态不变', async () => {
    const port = new RecordingPublishPort();
    const session = importedSession(port, 'W10-THROW-CANCEL');
    const digestBefore = session.currentDigest();

    port.failNext = { kind: 'cancelled', detail: '用户取消：不再需要这一版' };
    const result = await session.submitEdit(submitInput(session, 'k-cancel'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('publish_failed');
    // 结构化失败种类**原样**透传（没有被新的 catch 分支改写）。
    expect(result.detail.publishFailureKind).toBe('cancelled');
    expect(session.currentRevision()).toBe(0);
    expect(session.publishedVersions()).toHaveLength(0);
    expect(port.deliveries).toBe(0);
    expect(digestBytes(mustOk(session.exportBytes()))).toBe(digestBefore);
  });
});

// ---------------------------------------------------------------------------
// §D 抛异常发生在"已有一版成功"之后：撤销栈 / 既有版本也不动
// ---------------------------------------------------------------------------

describe('§D 抛异常不产生半截事务（历史栈与既有版本均不动）', () => {
  it('D1. 成功一版后抛异常：revision / published / 撤销栈深度全部不变', async () => {
    const port = new RecordingPublishPort();
    const session = importedSession(port, 'W10-THROW-HISTORY');

    // 第一版：健康端口 ⇒ 成功，撤销栈深度变为 1。
    const ok1 = await session.submitEdit(submitInput(session, 'k-1', centerSecondParagraph()));
    expect(ok1.ok).toBe(true);
    expect(session.currentRevision()).toBe(1);
    expect(session.publishedVersions()).toHaveLength(1);
    expect(session.canUndo()).toBe(true);
    const undoDepthBefore = session.history().undo_depth;

    // 第二版：换一段居中（真正改变字节）⇒ 走到发布端口并抛异常 ⇒ 不采纳；
    // 撤销栈不得被暗中推进。
    port.throwNext = THROWN_MESSAGE;
    const thrown = await session.submitEdit(submitInput(session, 'k-2', centerThirdParagraph()));
    expect(thrown.ok).toBe(false);

    expect(session.currentRevision()).toBe(1);
    expect(session.publishedVersions()).toHaveLength(1);
    expect(port.deliveries).toBe(1);
    expect(session.canUndo()).toBe(true);
    expect(session.history().undo_depth).toBe(undoDepthBefore);

    // 反向对照：同一个"第三段居中"在健康端口上重交 ⇒ 正常推进到第 2 版。
    port.throwNext = null;
    const ok2 = await session.submitEdit(submitInput(session, 'k-3', centerThirdParagraph()));
    expect(ok2.ok).toBe(true);
    expect(session.currentRevision()).toBe(2);
    expect(session.publishedVersions()).toHaveLength(2);
  });
});
