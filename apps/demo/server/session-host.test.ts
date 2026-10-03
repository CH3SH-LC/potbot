/**
 * 文档会话宿主测试（design-05-P8；合同 §G）。
 *
 * ## 这一组用例要证明的核心命题
 *
 * 1. **产物确实经内核任务发布**，不是宿主自造回执：
 *    store 里那条 `ArtifactRecord` 的 `status === 'published'`、带 `receipt`，
 *    且它的 `task_revision` 等于内核任务记录上的版本（版本闸门真的跑过）。
 * 2. **回执摘要 == 盘上实际回读的摘要**（I-1）：直接读磁盘上的文件重算 sha256 比对。
 * 3. **三个号分开**（R141）：编辑版本 / 内核任务版本 / 产物版本分别可读。
 * 4. **stale、幂等、失败保留旧文件**在**真实链路**上成立（不是靠假端口宽松通过）。
 * 5. **没有"直接写文件就宣称成功"的路径**：对实现源码做文本扫描（无 `writeFile`）。
 *
 * ## 为什么用真实磁盘
 *
 * 用 `node:os.tmpdir()` 下的临时目录 + **生产物化端口** `createDocumentPort`。
 * 内存端口只能证明"逻辑对"，证明不了"盘上真的有那份字节"——而后者正是本批要的。
 * 临时目录用完即删，**不碰 `.runtime/`**。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';
import { decodeSessionState, digestBytes, encodeSessionState } from '../../../src/documents/session/index.js';
import type { DocumentPort } from '../documents/port.js';
import { createDocumentPort } from '../documents/port.js';
import { DocumentSessionHost } from './session-host.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 真实可导入的 DOCX（内核模板构建器产出，全 STORE 写入器）。 */
function sampleDocx(paragraphs: readonly string[] = ['第一段内容', '第二段内容', '第三段内容']): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '会话宿主测试文档',
      description: '',
      paragraphs: [...paragraphs],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '会话宿主测试夹具' }],
  }).bytes;
}

/** 居中第二段（零模型直接格式命令，R134）。 */
function centerSecondParagraph(): unknown {
  return {
    steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
  };
}

function alignFirstRight(): unknown {
  return {
    steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'right' } }],
  };
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-session-host-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function newHost(documents: DocumentPort | null = createDocumentPort(workDir)): DocumentSessionHost {
  return new DocumentSessionHost({
    documents,
    artifact_root_dir: workDir.split('\\').join('/'),
    run_id: 'TEST-RUN',
    now: () => new Date('2026-10-02T00:00:00.000Z'),
  });
}

function openSample(host: DocumentSessionHost, sessionId = 'S-1', mode: 'new' | 'import' = 'import') {
  const opened = host.openSession({
    session_id: sessionId,
    filename: '会话文档.docx',
    mode,
    template_bytes: sampleDocx(),
  });
  if (!opened.ok) {
    throw new Error(`夹具开会话失败：${opened.code} ${opened.message}`);
  }
  return opened.value;
}

/** 盘上那份文件的路径（按 artifactId 找）。 */
function fileOnDisk(artifactId: string): string {
  return join(workDir, artifactId, '会话文档.docx');
}

// ---------------------------------------------------------------------------
// 发布链复用
// ---------------------------------------------------------------------------

describe('发布链复用：产物经内核任务发布（不绕过任务链）', () => {
  it('编辑 → 内核任务版本递增 → staged 记录 → 写盘回读 → published 记录', async () => {
    const host = newHost();
    const opened = openSample(host);
    const taskBefore = host.kernelTask(opened.session_id);
    expect(taskBefore?.revision).toBe(1);
    expect(host.kernelArtifactCount()).toBe(0);

    const outcome = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'edit-1',
      base_revision: opened.edit_revision,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    const status = host.status(opened.session_id);
    expect(status?.published).toHaveLength(1);
    const version = status?.published[0];
    expect(version).toBeDefined();
    if (version === undefined) return;

    // ① 内核任务版本被**内核自己的 patch 语义**递增（deliverables 变更 = 实质性）。
    const taskAfter = host.kernelTask(opened.session_id);
    expect(taskAfter?.revision).toBe(2);
    expect(version.task_revision).toBe(2);

    // ② store 里有**这一条**产物记录，且是 published（不是 staged、不是宿主自报）。
    const record = host.kernelArtifact(version.artifact_id);
    expect(record).toBeDefined();
    expect(record?.status).toBe('published');
    expect(record?.task_id).toBe(String(opened.kernel_task_id));
    expect(record?.task_revision).toBe(2);
    expect(record?.artifact_version).toBe(version.artifact_version);
    expect(record?.receipt).not.toBeNull();

    // ③ 回执摘要来自**实际回读**，与盘上字节逐字节一致（I-1）。
    const onDisk = readFileSync(fileOnDisk(version.artifact_id));
    expect(digestBytes(onDisk)).toBe(version.content_digest);
    expect(record?.receipt?.readback_digest).toBe(version.content_digest);
    expect(record?.content_digest).toBe(version.content_digest);

    // ④ 交付前检查留在了记录上（不是"生成即交付"）。
    expect(record?.verifications.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('下载面返回的是**盘上的真实字节**，且与版本映射的摘要一致', async () => {
    const host = newHost();
    const opened = openSample(host);
    await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'edit-1',
      base_revision: opened.edit_revision,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    const version = host.status(opened.session_id)?.published[0];
    expect(version).toBeDefined();
    if (version === undefined) return;

    const fetched = await host.versionBytes(opened.session_id, version.edit_revision);
    expect(fetched).toBeDefined();
    const direct = readFileSync(fileOnDisk(version.artifact_id));
    expect(fetched?.bytes.byteLength).toBe(direct.byteLength);
    expect(digestBytes(fetched?.bytes as Uint8Array)).toBe(digestBytes(direct));
    expect(fetched?.content_digest).toBe(version.content_digest);
  });

  it('盘上字节被换过之后，下载面**拒绝**返回（不发自证不了的字节）', async () => {
    const host = newHost();
    const opened = openSample(host);
    await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'edit-1',
      base_revision: opened.edit_revision,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    const version = host.status(opened.session_id)?.published[0];
    if (version === undefined) throw new Error('夹具未发布');

    // 模拟"盘上的文件被替换"。
    writeFileSync(fileOnDisk(version.artifact_id), Buffer.from('这不是那份文档'));

    const fetched = await host.versionBytes(opened.session_id, version.edit_revision);
    expect(fetched).toBeUndefined();
  });

  it('实现里**没有**直接写文件的路径（文本扫描：写盘只发生在物化端口）', () => {
    const source = readFileSync(join(import.meta.dirname, 'session-host.ts'), 'utf8');
    // 扫的是**调用**而不是文档里的字样：注释里出现 `fs.writeFile` 是在说明"没有这条路"，
    // 把注释也算进来会让这条断言变成"禁止谈论写盘"，那是错的。
    expect(source).not.toMatch(/\bwriteFile(Sync)?\s*\(/);
    expect(source).not.toMatch(/\bcreateWriteStream\s*\(/);
    expect(source).not.toMatch(/from 'node:fs/);
    // 而它确实用了物化端口（不是"什么都不干所以没有写盘"）。
    expect(source).toMatch(/materialize\(/);
    expect(source).toMatch(/createArtifactPublicationProjection/);
  });

  it('物化端口未接入 ⇒ 发布如实失败，不伪造已保存', async () => {
    const host = newHost(null);
    const opened = openSample(host);
    const outcome = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'edit-1',
      base_revision: opened.edit_revision,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('publish_failed');
    }
    expect(host.status(opened.session_id)?.published).toHaveLength(0);
    expect(host.kernelArtifactCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 版本分开 / 并发 / 幂等 / 失败保留
// ---------------------------------------------------------------------------

describe('版本分开（R141）与并发（R143）', () => {
  it('三个号分别可读，且映射表把它们连起来', async () => {
    const host = newHost();
    const opened = openSample(host);
    await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'a',
      base_revision: opened.edit_revision,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'b',
      base_revision: 1,
      base_digest: host.status(opened.session_id)?.content_digest ?? '',
      intent: alignFirstRight(),
    });

    const mapping = host.mapping(opened.session_id);
    expect(mapping).toEqual([
      { edit_revision: 1, task_revision: 2, artifact_version: 1 },
      { edit_revision: 2, task_revision: 3, artifact_version: 2 },
    ]);
    // 三个号**互不相等**的这一行最能说明"它们不是一个号"。
    expect(mapping[0]?.edit_revision).not.toBe(mapping[0]?.task_revision);
    expect(mapping[1]?.artifact_version).not.toBe(mapping[1]?.task_revision);
  });

  it('两个操作基于同一 revision：只有一个成功，另一个 stale_revision + 当前 revision', async () => {
    const host = newHost();
    const opened = openSample(host);
    const first = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'first',
      base_revision: 0,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    expect(first.ok).toBe(true);

    const second = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'second',
      base_revision: 0,
      base_digest: opened.content_digest,
      intent: alignFirstRight(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('stale_revision');
      expect(second.detail.currentRevision).toBe(1);
      expect(second.detail.requestedRevision).toBe(0);
    }
    expect(host.kernelArtifactCount()).toBe(1);
  });
});

describe('幂等（R137/R146）', () => {
  it('同一幂等键重复提交 ⇒ 不产生第二个版本，也不新增内核产物记录', async () => {
    const host = newHost();
    const opened = openSample(host);
    const input = {
      session_id: opened.session_id,
      idempotency_key: 'same',
      base_revision: 0,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    };
    const first = await host.submitEdit(input);
    expect(first.ok).toBe(true);
    expect(host.kernelArtifactCount()).toBe(1);
    const taskAfterFirst = host.kernelTask(opened.session_id)?.revision;

    const retry = await host.submitEdit(input);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      const value = retry.value as { readonly replayed: boolean };
      expect(value.replayed).toBe(true);
    }
    // 版本数、内核产物条数、内核任务版本**都没有再动**。
    expect(host.status(opened.session_id)?.published).toHaveLength(1);
    expect(host.kernelArtifactCount()).toBe(1);
    expect(host.kernelTask(opened.session_id)?.revision).toBe(taskAfterFirst);
  });

  it('同一幂等键 + 不同输入 ⇒ idempotency_conflict（不放行成第二个版本）', async () => {
    const host = newHost();
    const opened = openSample(host);
    await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'reused',
      base_revision: 0,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    const digestNow = host.status(opened.session_id)?.content_digest ?? '';
    const conflict = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'reused',
      base_revision: 1,
      base_digest: digestNow,
      intent: alignFirstRight(),
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict');
    expect(host.kernelArtifactCount()).toBe(1);
  });
});

describe('失败保留旧文件（R145）', () => {
  it('物化失败 ⇒ 旧版本与盘上的旧文件都在，且没有半截新文件', async () => {
    // 先成功发布一版。
    const real = createDocumentPort(workDir);
    let failing = false;
    const flaky: DocumentPort = {
      materialize: (req) => {
        if (failing) {
          return Promise.reject(new Error('模拟磁盘写失败'));
        }
        return real.materialize(req);
      },
      readBack: (id) => real.readBack(id),
    };
    const host = newHost(flaky);
    const opened = openSample(host);
    await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'ok',
      base_revision: 0,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    const version = host.status(opened.session_id)?.published[0];
    if (version === undefined) throw new Error('夹具首版未发布');
    const oldBytes = readFileSync(fileOnDisk(version.artifact_id));
    const digestBefore = host.status(opened.session_id)?.content_digest;

    // 让下一次物化失败。
    failing = true;
    const failed = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'will-fail',
      base_revision: 1,
      base_digest: digestBefore ?? '',
      intent: alignFirstRight(),
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe('publish_failed');

    // 旧文件逐字节未变；交付面仍指向旧版本；编辑版本没有前进。
    const stillThere = readFileSync(fileOnDisk(version.artifact_id));
    expect(digestBytes(stillThere)).toBe(digestBytes(oldBytes));
    const status = host.status(opened.session_id);
    expect(status?.published).toHaveLength(1);
    expect(status?.content_digest).toBe(digestBefore);
    expect(status?.edit_revision).toBe(1);
    expect(status?.last_failure?.kind).toBe('write_failed');
    // 内核里多了一条 **failed** 记录（失败也必须留痕），但**没有新的已交付版本**：
    // 一条 published（上面那一版）+ 一条 failed（这一次）。
    expect(host.kernelArtifactCount()).toBe(2);
    expect(host.kernelArtifactList().filter((record) => record.status === 'published')).toHaveLength(1);
    expect(host.kernelArtifactList().filter((record) => record.status === 'failed')).toHaveLength(1);

    // 失败不是终局：修好端口后用同一基线重试即成功，且落到**新**目录。
    failing = false;
    const retried = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'will-fail',
      base_revision: 1,
      base_digest: digestBefore ?? '',
      intent: alignFirstRight(),
    });
    expect(retried.ok).toBe(true);
    const versions = host.status(opened.session_id)?.published ?? [];
    expect(versions).toHaveLength(2);
    expect(versions[1]?.artifact_id).not.toBe(versions[0]?.artifact_id);
    // 旧文件仍然在（另存不覆盖，WF-084）。
    expect(digestBytes(readFileSync(fileOnDisk(version.artifact_id)))).toBe(digestBytes(oldBytes));
  });

  it('版本闸门：物化期间发生需求变更 ⇒ 迟到结果被拒（不得发布旧候选，R142）', async () => {
    // 用真实物化端口，但在**写盘回读之后、发布投影之前**登记一次真实的需求变更。
    // 这正是 R142 描述的场景：候选已经算好，期间任务版本被推了一版。
    const real = createDocumentPort(workDir);
    let hostRef: DocumentSessionHost | null = null;
    let sessionIdRef = '';
    let revised: number | null = null;
    const racing: DocumentPort = {
      materialize: async (req) => {
        const receipt = await real.materialize(req);
        const advanced = hostRef?.reviseDeliverable(sessionIdRef, '用户在提交期间改了需求');
        revised = advanced !== undefined && advanced.ok ? advanced.value : null;
        return receipt;
      },
      readBack: (id) => real.readBack(id),
    };
    const host = newHost(racing);
    hostRef = host;
    const opened = openSample(host);
    sessionIdRef = opened.session_id;

    const outcome = await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'race',
      base_revision: 0,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });

    // 需求变更**确实**发生了（否则这个用例什么都没证明）：任务版本从暂存时的 2 推到 3。
    expect(revised).toBe(3);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('publish_failed');

    // 内核里那条记录被记为**过期**（不是"坏了"），且没有任何版本被交付。
    expect(host.status(opened.session_id)?.published).toHaveLength(0);
    const artifacts = host.kernelArtifactList();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.status).toBe('superseded');
    expect(artifacts[0]?.failure_kind).toBe('version_stale');
    expect(artifacts[0]?.receipt).toBeNull();
  });
});

describe('会话登记与边界', () => {
  it('重复开会话 / 未开会话的提交 / 会话上限 ⇒ 结构化拒绝', async () => {
    const host = newHost();
    openSample(host, 'S-1');
    const again = host.openSession({
      session_id: 'S-1',
      filename: 'x.docx',
      mode: 'new',
      template_bytes: sampleDocx(),
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('session_already_exists');

    const missing = await host.submitEdit({
      session_id: 'S-NOPE',
      idempotency_key: 'k',
      base_revision: 0,
      base_digest: 'a'.repeat(64),
      intent: centerSecondParagraph(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('session_not_found');

    const limited = new DocumentSessionHost({
      documents: createDocumentPort(workDir),
      artifact_root_dir: workDir.split('\\').join('/'),
      run_id: 'TEST-RUN',
      max_sessions: 1,
      now: () => new Date('2026-10-02T00:00:00.000Z'),
    });
    openSample(limited, 'S-1');
    const over = limited.openSession({
      session_id: 'S-2',
      filename: 'x.docx',
      mode: 'new',
      template_bytes: sampleDocx(),
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe('session_limit_reached');
  });

  it('导入非 DOCX 字节 ⇒ import_failed（不伪造一个空文档）', () => {
    const host = newHost();
    const result = host.openSession({
      session_id: 'S-BAD',
      filename: '坏.docx',
      mode: 'import',
      template_bytes: Uint8Array.from([1, 2, 3, 4]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('import_failed');
  });

  it('会话状态可落盘并由 restoreSession 读回（WF-083）', async () => {
    // 会话状态里**有二进制**（未改动部件的原始字节），裸 `JSON.stringify` 会把它变成
    // `{0:1,1:2,...}` 而悄悄毁掉模型——所以持久化必须走会话包提供的编解码器。
    const store = new Map<string, unknown>();
    const persistence = (sessionId: string): { save(state: unknown): void; load(): unknown } => ({
      save: (state) => store.set(sessionId, JSON.parse(JSON.stringify(encodeSessionState(state))) as unknown),
      load: () => {
        const raw = store.get(sessionId);
        return raw === undefined ? null : decodeSessionState(raw);
      },
    });
    const host = new DocumentSessionHost({
      documents: createDocumentPort(workDir),
      artifact_root_dir: workDir.split('\\').join('/'),
      run_id: 'TEST-RUN',
      session_persistence: persistence,
      now: () => new Date('2026-10-02T00:00:00.000Z'),
    });
    const opened = openSample(host);
    await host.submitEdit({
      session_id: opened.session_id,
      idempotency_key: 'k',
      base_revision: 0,
      base_digest: opened.content_digest,
      intent: centerSecondParagraph(),
    });
    const before = host.status(opened.session_id);

    const fresh = new DocumentSessionHost({
      documents: createDocumentPort(workDir),
      artifact_root_dir: workDir.split('\\').join('/'),
      run_id: 'TEST-RUN',
      session_persistence: persistence,
      now: () => new Date('2026-10-02T00:00:00.000Z'),
    });
    const restored = fresh.restoreSession({ session_id: opened.session_id, filename: '会话文档.docx' });
    expect(restored.ok).toBe(true);
    const after = fresh.status(opened.session_id);
    expect(after?.edit_revision).toBe(before?.edit_revision);
    expect(after?.published).toEqual(before?.published);
  });
});
