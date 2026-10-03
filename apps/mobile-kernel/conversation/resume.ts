/**
 * K04 连续对话 —— **跨进程续聊的当前文档恢复**（P0 的修复面）。
 *
 * ## 缺陷是什么（README §2 的 P0）
 *
 * 桌面宿主里「本会话当前是哪份文档」一度只活在**进程内的 Map** 里。进程一重启，
 * 续聊时答案变 `undefined`，或者更糟——调用方退回到某个"全局当前"，把**别的会话 / 别的
 * 运行目录**里的产物当成本会话的数据。那是把"读不回来"伪装成"就是它"。
 *
 * ## 手机侧的修复口径（本文件）
 *
 * 三层，**没有一层可以省**：
 *
 * 1. **进程内的 `#cache` 只是缓存，不是真相源**。真相在**持久事实**里
 *    （{@link CurrentDocumentFact}：只记"哪一份 + 哪条任务 + 标题"）——
 *    重启后缓存为空，`resolve()` 会从事实重建。
 * 2. **版本字段一律取自产物登记处**（{@link ResumableArtifact}），**不写进事实、也不信缓存里的旧值**。
 *    写第二份版本就是第二个真相源，漂移时无法判断谁对；"新进程读到陈旧版本"正是这么来的。
 * 3. **核不上就不认**：事实指向的产物必须真的在登记处、必须**已交付**（`delivered` 且有回执）、
 *    任务必须对得上。任一条不成立 ⇒ 结构化失败，**不回落**到任何默认文档。
 *
 * 新进程的正确用法：`new ConversationResumeLedger({ facts, artifacts })` —— 构造即读事实，
 * **不需要先 GET 会话**；直接 `resolve(conversationId)` 就拿到**当前**版本。
 */

import {
  continuityFail,
  continuityOk,
  describeContinuityError,
  type ContinuityResult,
} from './errors.js';

import {
  CURRENT_DOCUMENT_FACT_SCHEMA,
  type ArtifactRegistryPort,
  type CurrentDocumentFact,
  type CurrentDocumentFactPort,
  type ResolvedCurrentDocument,
  type ResumeOutcome,
} from './types.js';

export interface ConversationResumeLedgerOptions {
  /** 持久事实端口（K09 存储端口承接落盘）。不注入 ⇒ 恢复不可能，`resolve` 如实失败。 */
  readonly facts?: CurrentDocumentFactPort | null;
  /** 产物登记处（可恢复产物的真相源；版本 / 摘要 / 字节数从这里读）。 */
  readonly artifacts?: ArtifactRegistryPort | null;
}

export interface RememberCurrentDocumentInput {
  readonly conversationId: string;
  readonly taskId: string;
  readonly artifactId: string;
  readonly title: string;
  readonly at?: string;
}

export class ConversationResumeLedger {
  readonly #facts: CurrentDocumentFactPort | null;
  readonly #artifacts: ArtifactRegistryPort | null;
  /**
   * 进程内缓存。**它是缓存，不是真相源**：只存"已解析出来的文档引用"，
   * 进程重启即空。版本字段即使缓存命中也是当初解析出来的——因此对外提供
   * `resolve(id, { preferCache: false })` 强制重解析。
   */
  readonly #cache = new Map<string, ResolvedCurrentDocument>();
  #unreadable: string | null = null;

  constructor(options: ConversationResumeLedgerOptions = {}) {
    this.#facts = options.facts ?? null;
    this.#artifacts = options.artifacts ?? null;
  }

  /** 持久事实读不回来的原因（`null` = 干净）。 */
  unreadableReason(): string | null {
    return this.#unreadable;
  }

  cacheSize(): number {
    return this.#cache.size;
  }

  /**
   * 记下「本会话当前文档」。
   *
   * **只记哪一份 + 哪条任务 + 标题**：版本 / 摘要 / 字节数 / 文件名**不写**（它们以产物
   * 登记处为准）。写事实不改变已交付产物本身（发布早已完成）。
   */
  remember(input: RememberCurrentDocumentInput): ContinuityResult<CurrentDocumentFact> {
    const facts = this.#facts;
    if (facts === null) {
      return continuityFail('state_unreadable', '未注入事实端口：无法落盘"当前文档"（刷新后会读不回来）');
    }
    for (const field of ['conversationId', 'taskId', 'artifactId', 'title'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        return continuityFail('invalid_input', `remember 的 ${field} 不能为空`);
      }
    }
    const fact: CurrentDocumentFact = Object.freeze({
      schema: CURRENT_DOCUMENT_FACT_SCHEMA,
      conversationId: input.conversationId,
      taskId: input.taskId,
      artifactId: input.artifactId,
      title: input.title,
      at: input.at ?? '',
    });
    try {
      facts.save(fact);
    } catch (error) {
      return continuityFail('state_unreadable', `事实落盘失败：${describeContinuityError(error)}`);
    }
    // 记下新当前文档 ⇒ 让本进程缓存失效，下一次 resolve 从事实 + 登记处重建（不读旧值）。
    this.#cache.delete(input.conversationId);
    return continuityOk(fact);
  }

  /**
   * 解析「本会话当前文档」。
   *
   * 顺序：缓存 → 持久事实 → 产物登记处 → 三条核验。**任一条核不上就不认**。
   * 版本字段（`revision` / `artifactVersion` / `digest` / `byteLength`）**一律来自登记处**。
   */
  resolve(
    conversationId: string,
    options: { readonly preferCache?: boolean } = {},
  ): ContinuityResult<ResumeOutcome> {
    if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
      return continuityFail('invalid_input', 'conversationId 不能为空');
    }
    const preferCache = options.preferCache ?? true;
    if (preferCache) {
      const cached = this.#cache.get(conversationId);
      if (cached !== undefined) {
        return continuityOk(Object.freeze({ document: cached, source: 'memory' as const }));
      }
    }

    const facts = this.#facts;
    if (facts === null) {
      return continuityFail('state_unreadable', '未注入事实端口：无法恢复"当前文档"');
    }
    let raw: unknown;
    try {
      raw = facts.loadAll();
    } catch (error) {
      return continuityFail('state_unreadable', `事实读取抛错：${describeContinuityError(error)}`);
    }
    const decoded = decodeCurrentDocumentFacts(raw);
    if (!decoded.ok) {
      this.#unreadable = `${decoded.error.code}: ${decoded.error.message}`;
      return decoded as ContinuityResult<ResumeOutcome>;
    }
    const fact = decoded.value.find((row) => row.conversationId === conversationId);
    if (fact === undefined) {
      return continuityFail(
        'fact_missing',
        `会话 ${conversationId} 没有"当前文档"持久事实（可能从未发布过文档，或读到了别的运行目录）`,
      );
    }

    const artifacts = this.#artifacts;
    if (artifacts === null) {
      return continuityFail('state_unreadable', '未注入产物登记处：无法核验产物身份');
    }
    const artifact = artifacts.find(fact.artifactId);
    if (artifact === undefined) {
      return continuityFail(
        'artifact_not_found',
        `事实指向的产物 ${fact.artifactId} 不在产物登记处（换运行目录会命中这条，不回落）`,
      );
    }
    if (!artifact.delivered || artifact.receiptId === null) {
      return continuityFail(
        'artifact_not_delivered',
        `产物 ${fact.artifactId} 尚未交付（delivered=${String(artifact.delivered)}、receipt=${String(
          artifact.receiptId,
        )}）：不认`,
      );
    }
    if (artifact.taskId !== fact.taskId) {
      return continuityFail(
        'artifact_task_mismatch',
        `产物 ${fact.artifactId} 归属任务 ${artifact.taskId}，事实锚定任务 ${fact.taskId}：对不上，不认`,
      );
    }

    const document: ResolvedCurrentDocument = Object.freeze({
      conversationId,
      artifactId: artifact.artifactId,
      taskId: artifact.taskId,
      title: fact.title,
      fileName: artifact.fileName,
      // **版本字段以登记处为准**（不是事实、不是缓存里的旧值）。
      revision: artifact.revision,
      artifactVersion: artifact.artifactVersion,
      digest: artifact.digest,
      byteLength: artifact.byteLength,
    });
    this.#cache.set(conversationId, document);
    return continuityOk(Object.freeze({ document, source: 'persisted' as const }));
  }

  /** 清缓存（`undefined` = 全清）。产品路径不需要它；它是测试"模拟新进程"的显式接缝。 */
  clearCache(conversationId?: string): void {
    if (conversationId === undefined) {
      this.#cache.clear();
      return;
    }
    this.#cache.delete(conversationId);
  }
}

// ---------------------------------------------------------------------------
// 事实形状核对
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 核对事实列表。任一字段不符 ⇒ 整份拒绝。 */
export function decodeCurrentDocumentFacts(raw: unknown): ContinuityResult<readonly CurrentDocumentFact[]> {
  if (raw === null || raw === undefined) {
    return continuityOk(Object.freeze([]));
  }
  if (!Array.isArray(raw)) {
    return continuityFail('state_unreadable', '当前文档事实快照不是数组');
  }
  const facts: CurrentDocumentFact[] = [];
  for (const entry of raw) {
    const decoded = decodeCurrentDocumentFact(entry);
    if (!decoded.ok) {
      return decoded as ContinuityResult<readonly CurrentDocumentFact[]>;
    }
    facts.push(decoded.value);
  }
  return continuityOk(Object.freeze(facts));
}

function decodeCurrentDocumentFact(raw: unknown): ContinuityResult<CurrentDocumentFact> {
  if (!isPlainObject(raw)) {
    return continuityFail('state_unreadable', '当前文档事实不是对象');
  }
  if (raw['schema'] !== CURRENT_DOCUMENT_FACT_SCHEMA) {
    return continuityFail(
      'state_unreadable',
      `当前文档事实 schema 不符（期望 ${CURRENT_DOCUMENT_FACT_SCHEMA}，收到 ${JSON.stringify(raw['schema'])}）`,
    );
  }
  for (const field of ['conversationId', 'artifactId', 'taskId', 'title', 'at'] as const) {
    if (typeof raw[field] !== 'string') {
      return continuityFail('state_unreadable', `当前文档事实的 ${field} 不是字符串`);
    }
  }
  return continuityOk(
    Object.freeze({
      schema: CURRENT_DOCUMENT_FACT_SCHEMA,
      conversationId: raw['conversationId'] as string,
      artifactId: raw['artifactId'] as string,
      taskId: raw['taskId'] as string,
      title: raw['title'] as string,
      at: raw['at'] as string,
    }),
  );
}
