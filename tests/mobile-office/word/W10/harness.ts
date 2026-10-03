/**
 * **W10 测试夹具**（非测试文件：文件名不以 `.test.ts` 结尾，vitest 不收集）。
 *
 * 三个"假"端口都在**真的做事**，只假在没有磁盘/没有网络：
 *
 * | 端口 | 真的做什么 | 假在哪 |
 * |---|---|---|
 * | `RecordingPublishPort` | 真对字节取 sha256、真存字节、回执里的回读摘要取自**它自己存的那份**、拒绝覆盖已有摘要（R145） | 没有文件系统 |
 * | `MemoryStore` | 把状态 **JSON 序列化**后按 session id 存文本（因此能证明状态真能跨进程） | 没有磁盘 |
 * | `ScriptedFactsPort` | 真按 task_id 返回一张只读快照（可换版、可删） | 没有 K08 的装配逻辑 |
 *
 * `MemoryStore` 刻意用 **JSON 文本**而不是 `structuredClone`：杀进程重开的判据里，
 * "状态能否被序列化"本身就是要证明的东西（`Uint8Array`、函数、`undefined` 都会在这里现形）。
 */

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../../src/artifacts/templates/docx.js';
import { digestBytes } from '../../../../src/documents/session/canonical.js';
import {
  decodeSessionState,
  encodeSessionState,
} from '../../../../src/documents/session/persistence.js';
import type {
  DocumentPublishPort,
  DocumentPublishRequest,
  DocumentPublishResult,
  SessionPersistence,
} from '../../../../src/documents/session/index.js';
import type {
  FactsPort,
  FactsSnapshotView,
} from '../../../../src/mobile-plugins/word/session/types.js';
import type { WordSessionPorts } from '../../../../src/mobile-plugins/word/session/types.js';
import { WordSessionPlugin } from '../../../../src/mobile-plugins/word/session/word-session-plugin.js';

// ---------------------------------------------------------------------------
// DOCX 夹具
// ---------------------------------------------------------------------------

/**
 * 一份真实可导入的 DOCX（走内核模板构建器，不是手搓 ZIP）。
 *
 * 段落文本用**中文数字**：模板构建器的 P6 护栏拒绝"正文里出现快照里没有的阿拉伯数字"，
 * 因此 `第1段内容` 这类夹具会连包装不出来（这正是那条护栏在工作，不该绕过它）。
 */
export function sampleDocx(
  paragraphs: readonly string[] = ['第一段内容', '第二段内容', '第三段内容'],
): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      // 标题/来源里**不得**出现阿拉伯数字：模板构建器的 P6 护栏会把"快照里没有的数字"
      // 当成凭空编造的数据拒掉（`W10` 里的 10 也会被抓，这不是 bug 是护栏在工作）。
      title: '手机会话工具测试',
      description: '',
      paragraphs: [...paragraphs],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '会话工具夹具' }],
  }).bytes;
}

// ---------------------------------------------------------------------------
// 发布端口
// ---------------------------------------------------------------------------

export class RecordingPublishPort implements DocumentPublishPort {
  /** artifact id → 端口自己"盘上"的字节（回读摘要必须取自这里）。 */
  readonly artifacts = new Map<string, Uint8Array>();
  readonly requests: DocumentPublishRequest[] = [];
  /** 下一次发布强制失败（模拟写盘/权限问题）；用完即清。 */
  failNext: { readonly kind: string; readonly detail: string } | null = null;
  /** 下一次发布的回执摘要与交出字节不符（模拟"盘上躺着的不是这一份"）；用完即清。 */
  corruptReadback = false;
  /**
   * "交付摘要 == 上一版摘要"的交付次数。
   *
   * 这是 `publishCurrent` 的语义标记（内容没变、但确实要再交出一份文件）；
   * 正常的内容变更提交永远不该增加它（会话层对逐字节相同的提交直接空转，不发布）。
   */
  identical_redeliveries = 0;
  /**
   * 发布闸门：命中的请求会**停在这里**直到 `wait` 解开。
   *
   * 用途只有一个：把"另存副本期间原件被并发改动"变成**确定性**用例——
   * 在副本的首次发布被挂住的时候，测试可以去动原件（否则这点竞态只能靠运气复现）。
   */
  gate: { readonly match: (request: DocumentPublishRequest) => boolean; readonly wait: Promise<void> } | null =
    null;
  #counter = 0;

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.requests.push(request);
    const gate = this.gate;
    if (gate !== null && gate.match(request)) {
      await gate.wait;
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
    // R145：端口**不得覆盖**旧文件。本端口给每次交付一个新的 artifact id（新路径），
    // 因此"覆盖"在这里不可能发生；但"交出与上一版逐字节相同的字节"是一件值得记下来的事
    // （它只会出现在 `publishCurrent` 这种"内容没变但要再交付一次"的调用上），
    // 记下来而不是判定为错误——判定为错误会让这条真正的语义无法被测试。
    if (request.previous_digest !== null && request.previous_digest === request.expected_digest) {
      this.identical_redeliveries += 1;
    }
    this.#counter += 1;
    const artifactId = `art-${request.session_id}-${String(this.#counter)}`;
    const stored = Uint8Array.from(request.bytes);
    this.artifacts.set(artifactId, stored);
    const corrupt = this.corruptReadback;
    this.corruptReadback = false;
    return {
      ok: true,
      receipt: {
        artifact_id: artifactId,
        task_revision: this.#counter,
        artifact_version: this.#counter,
        readback_digest: corrupt ? digestBytes(Uint8Array.from([0, 1, 2, 3])) : digestBytes(stored),
        byte_length: stored.byteLength,
        entry_count: 7,
        filename: request.filename,
        verifier: 'RecordingPublishPort/内存回读',
        final_path: `/mem/${artifactId}/${request.filename}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 持久化（JSON 文本：真能跨进程）
// ---------------------------------------------------------------------------

export class MemoryStore {
  readonly entries = new Map<string, string>();
  /** 每次 save 的调用次数（用于证明"确实写过盘"，而不是只有内存态）。 */
  saves = 0;

  persistenceFor(sessionId: string): SessionPersistence {
    return {
      save: (state) => {
        this.saves += 1;
        // **走真实的编解码器**（`persistence.ts`）：模型里有二进制部件
        // （`OpaquePart.bytes` / `MediaPart.bytes`），裸 `JSON.stringify` 会把它们
        // 写成 `{"0":31,...}` 这种"看起来完整、其实已毁"的形状。
        this.entries.set(sessionId, JSON.stringify(encodeSessionState(state)));
      },
      load: () => {
        const text = this.entries.get(sessionId);
        return text === undefined ? null : decodeSessionState(JSON.parse(text));
      },
    };
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** 原始状态文本（诊断/断言"状态确实被序列化过"）。 */
  text(sessionId: string): string | null {
    return this.entries.get(sessionId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// 事实端口
// ---------------------------------------------------------------------------

export class ScriptedFactsPort implements FactsPort {
  readonly #byTask = new Map<string, FactsSnapshotView>();

  /** 放入/替换某个任务当前的快照。 */
  put(snapshot: FactsSnapshotView): void {
    this.#byTask.set(snapshot.task_id, snapshot);
  }

  /** 删除某个任务的快照（模拟"快照消失"）。 */
  remove(taskId: string): void {
    this.#byTask.delete(taskId);
  }

  snapshot(taskId: string): FactsSnapshotView | null {
    return this.#byTask.get(taskId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// 插件装配
// ---------------------------------------------------------------------------

export interface W10Harness {
  readonly plugin: WordSessionPlugin;
  readonly publish: RecordingPublishPort;
  readonly store: MemoryStore;
  readonly facts: ScriptedFactsPort;
  /** 新建一个共享同样存储/端口的插件实例（模拟"杀进程后重开"）。 */
  reopen(): W10Harness;
}

/** 递增时钟（**注入**：内核层不许读墙钟；这里也只是为了让时间戳可复算）。 */
export function steppingClock(): () => Date {
  let tick = 0;
  return () => {
    const value = new Date(Date.UTC(2026, 9, 3, 0, 0, 0) + tick * 1000);
    tick += 1;
    return value;
  };
}

/**
 * 共用同一组端口的夹具：`reopen()` 造一个**新的插件实例**，但持久化载体与发布端口
 * 仍是同一份——这正是"杀进程后重开"要证明的事（内存态全丢，盘上状态还在）。
 */
function harnessWith(
  publish: RecordingPublishPort,
  store: MemoryStore,
  facts: ScriptedFactsPort,
): W10Harness {
  const ports: WordSessionPorts = {
    publish_port: publish,
    persistence_for: (sessionId: string) => store.persistenceFor(sessionId),
    now: steppingClock(),
    facts_port: facts,
  };
  return {
    plugin: new WordSessionPlugin(ports),
    publish,
    store,
    facts,
    reopen: () => harnessWith(publish, store, facts),
  };
}

export function makeHarness(): W10Harness {
  return harnessWith(new RecordingPublishPort(), new MemoryStore(), new ScriptedFactsPort());
}

// ---------------------------------------------------------------------------
// 事实夹具
// ---------------------------------------------------------------------------

export const FACT_SOURCE = Object.freeze({ kind: 'user_confirmation' as const, detail: '用户在前台确认' });

export function factSnapshot(
  taskId: string,
  options: {
    readonly snapshotId?: string;
    readonly revision?: number;
    readonly values?: FactsSnapshotView['values'];
    readonly sourceRefs?: readonly string[];
  } = {},
): FactsSnapshotView {
  return Object.freeze({
    snapshot_id: options.snapshotId ?? `${taskId}-snap-1`,
    task_id: taskId,
    task_revision: options.revision ?? 1,
    source_refs: Object.freeze([...(options.sourceRefs ?? ['doc:确认单#1'])]),
    values: Object.freeze([...(options.values ?? [])]),
  });
}
