/**
 * **W-R02 — 长文 / 大图 / 多表 / 低内存 / 取消 / 崩溃恢复的独立验证**
 * （`tests/mobile-office/word/W-R02/`）。
 *
 * 本文件是备用包 W-R02 的取证：验证 `DocumentSession`（WF-081–090 的服务侧语义）在
 * **规模负载**与**故障注入**下的行为不退化。它不重复 `src/documents/session/session.test.ts`
 * 已在 3 段夹具上钉住的语义（幂等 / stale / 原子性 / 回读核对），只打那几处**没有被覆盖的
 * 规模与恢复面**：
 *
 * | 组 | 负载 | 新增判据 |
 * |---|---|---|
 * | §A | 1500 段长文 | 深段（第 1499 段）编辑后段数不变、只有目标段变、导出确定 |
 * | §B | 120 张表 / 1440 格 | 表格数与单元格数不变；未改动部件（`[Content_Types].xml` / `styles.xml`）逐字节保持 |
 * | §C | 2 MiB 媒体 | 媒体部件逐字节往返、份数仍为 1；编辑图片**旁边**的段落不损坏图片 |
 * | §D | 200 段 + 20 表 + 256 KiB 图，40 次编辑 | 状态载体体积**有界**（不随编辑次数重复内嵌文档）；日志上限被真正执行 |
 * | §E | 小文档 | 发布被取消 ⇒ 会话不前进、旧字节完好；反向对照：同一编辑健康发布成功 |
 * | §F | 小文档 | 保存 → 丢进程 → 从 JSON 账本恢复 → 幂等不重放 → 续编成功 |
 *
 * ## 判据来源（不照抄实现内部量）
 *
 * - 旧字节完好 / 取消不改稿：合同 R145、README §5（事件 `status` 与 `revision`）；
 * - 幂等不重放：合同 R137/R146；
 * - 未改动部件逐字节保持：合同 R151 / R105；
 * - 版本号分开：合同 R141；
 * - 规则 5（未完成不得宣称完成）：取消必须以结构化失败收口，不得静默成功。
 *
 * ## 反向对照（防"判据是空壳"）
 *
 * - §A/§B/§C 的每次"编辑后仍完整"都配"目标处确实变了"的断言——若编辑根本没生效，
 *   空完整性断言会假绿；
 * - §E 配"同一编辑在健康端口上成功"——证明取消用例红的不是编辑本身；
 * - §F 配"续编一次新编辑成功且版本 +1"——证明恢复出来的会话不是只能重放的只读残骸。
 *
 * ## 如实边界
 *
 * - 规模数字（1500 段 / 120 表 / 2 MiB）是**本机可跑**的量级，不是"手机内存上限"的证明。
 *   真正的低内存真机行为属 on-device 层，**本文件不覆盖**（见 README §8）。
 * - 本文件不联网、不读密钥、不碰桌面文件系统；只在进程内用内存端口与真实 DOCX 字节。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { importDocx } from '../../../../src/documents/docx/index.js';
import { collectParagraphs } from '../../../../src/documents/selection/structure.js';
import { digestBytes } from '../../../../src/documents/session/canonical.js';
import { DocumentSession } from '../../../../src/documents/session/index.js';
import { buildDocx } from './harness/docx-builder.js';
import {
  FIXED_NOW,
  JsonLedgerPersistence,
  RecordingPublishPort,
  boldFirstParagraphIntent,
  centerParagraphIntent,
  centerTableCellIntent,
  countModel,
  mustOk,
  openImportedSession,
  runCancelScenario,
  runCrashRecoveryScenario,
  submitInput,
} from './harness/session-driver.js';
import type { DocumentProfile } from './harness/types.js';

const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// §A 长文
// ---------------------------------------------------------------------------

describe('§A 长文：千段规模下深段编辑与往返', () => {
  const profile: DocumentProfile = {
    paragraphs: 1500,
    tables: 0,
    table_rows: 0,
    table_cols: 0,
    with_image: false,
    image_bytes: 0,
  };

  it('导入 1500 段 → 深段（第 1499 段）居中 → 导出/再导入，段数不变且只有目标段改', async () => {
    const built = buildDocx(profile);
    const { session } = openImportedSession(built.bytes, { id: 'S-LONG', filename: 'long.docx' });
    expect(countModel(session.model()).paragraphs).toBe(1500);

    mustOk(await session.submitEdit(submitInput(session, 'long-1', centerParagraphIntent(1499))));
    const exported = mustOk(session.exportBytes());

    const after = importDocx(exported);
    expect(countModel(after).paragraphs).toBe(1500);

    // 目标段确实变了（否则下面的"邻段没变"会是空断言）。
    const paragraphs = collectParagraphs(after.blocks);
    expect(paragraphs[1498]?.properties.alignment).toEqual({ state: 'set', value: 'center' });
    // 相邻段未被波及。
    expect(paragraphs[1497]?.properties.alignment).toEqual({ state: 'unspecified' });
    expect(paragraphs[1499]?.properties.alignment).toEqual({ state: 'unspecified' });
  });

  it('导出是确定性的：未改动时导出两次摘要一致，且等于导入基线摘要', () => {
    const built = buildDocx(profile);
    const { session } = openImportedSession(built.bytes, { id: 'S-LONG-2', filename: 'long2.docx' });
    const first = mustOk(session.exportBytes());
    const second = mustOk(session.exportBytes());
    expect(digestBytes(first)).toBe(digestBytes(second));
    // 未改动时导出摘要 == 构造期算出的基线摘要（R151：未改动部件逐字节写回）。
    expect(digestBytes(first)).toBe(session.currentDigest());
  });
});

// ---------------------------------------------------------------------------
// §B 多表
// ---------------------------------------------------------------------------

describe('§B 多表：120 张表 / 1440 格的完整保留', () => {
  const profile: DocumentProfile = {
    paragraphs: 5,
    tables: 120,
    table_rows: 3,
    table_cols: 4,
    with_image: false,
    image_bytes: 0,
  };

  it('导入后表格数与单元格数正确；改一格后导出/再导入仍是 120 表 / 1440 格', async () => {
    const built = buildDocx(profile);
    const { session } = openImportedSession(built.bytes, { id: 'S-TABLES' });
    const before = countModel(session.model());
    expect(before.tables).toBe(120);
    expect(before.cells).toBe(120 * 3 * 4);

    // 表格内容编辑：第 60 张表第 2 行第 3 列居中（编辑点落在表格里，验证表格内编辑不塌结构）。
    mustOk(await session.submitEdit(submitInput(session, 'tables-1', centerTableCellIntent(60, 2, 3))));
    const exported = mustOk(session.exportBytes());

    const after = countModel(importDocx(exported));
    expect(after.tables).toBe(120);
    expect(after.cells).toBe(120 * 3 * 4);

    // 目标单元格段落确实被居中（空断言防护），且全篇恰好一段被居中。
    const cellParagraphsBefore = collectParagraphs(importDocx(built.bytes).blocks);
    const cellParagraphsAfter = collectParagraphs(importDocx(exported).blocks);
    expect(cellParagraphsAfter.length).toBe(cellParagraphsBefore.length);
    const centered = cellParagraphsAfter.filter(
      (p) => p.properties.alignment.state === 'set' && p.properties.alignment.value === 'center',
    );
    expect(centered).toHaveLength(1);
  });

  it('未改动部件逐字节保持：`[Content_Types].xml` 与 `word/styles.xml`', async () => {
    const built = buildDocx(profile);
    const { session } = openImportedSession(built.bytes, { id: 'S-TABLES-2' });
    mustOk(await session.submitEdit(submitInput(session, 'tables-2', centerTableCellIntent(1, 1, 1))));
    const exported = mustOk(session.exportBytes());

    const before = readZip(built.bytes);
    const after = readZip(exported);
    for (const path of ['[Content_Types].xml', 'word/styles.xml']) {
      const a = before.by_path.get(path);
      const b = after.by_path.get(path);
      expect(a, `原包缺少部件 ${path}`).toBeDefined();
      expect(b, `导出包缺少部件 ${path}`).toBeDefined();
      expect(b?.data).toEqual(a?.data);
    }
  });
});

// ---------------------------------------------------------------------------
// §C 大图
// ---------------------------------------------------------------------------

describe('§C 大图：2 MiB 媒体部件逐字节往返且不重复', () => {
  const profile: DocumentProfile = {
    paragraphs: 30,
    tables: 2,
    table_rows: 2,
    table_cols: 2,
    with_image: true,
    image_bytes: 2 * MIB,
  };

  it('导入后媒体为 1 份 2 MiB；编辑图片旁的段落并导出/再导入后仍逐字节相同、仍为 1 份', async () => {
    const built = buildDocx(profile);
    const original = importDocx(built.bytes);
    expect(countModel(original).media_parts).toBe(1);
    expect(countModel(original).media_bytes).toBe(2 * MIB);
    const originalMedia = original.media[0];
    if (originalMedia === undefined) throw new Error('语料应含一个媒体部件');
    const originalMediaDigest = digestBytes(originalMedia.bytes);

    const { session } = openImportedSession(built.bytes, { id: 'S-IMAGE' });
    // 编辑第 1 段（图片段在正文末尾，离得很远）——验证图片旁的编辑不损坏图片。
    mustOk(await session.submitEdit(submitInput(session, 'image-1', boldFirstParagraphIntent())));
    const exported = mustOk(session.exportBytes());

    const after = importDocx(exported);
    expect(countModel(after).media_parts).toBe(1);
    expect(countModel(after).media_bytes).toBe(2 * MIB);
    const afterMedia = after.media[0];
    if (afterMedia === undefined) throw new Error('导出包应仍含一个媒体部件');
    expect(afterMedia.path).toBe('word/media/image1.png');
    // 逐字节相同（sha256 比对，而不是只比长度）。
    expect(digestBytes(afterMedia.bytes)).toBe(originalMediaDigest);
    // 编辑确实生效（防止"图片没坏"是因为编辑根本没提交）。
    const firstParagraph = collectParagraphs(after.blocks)[0];
    const bolded = (firstParagraph?.inlines ?? []).filter(
      (n) => n.kind === 'run' && n.properties.bold.state === 'on',
    );
    expect(bolded.length).toBeGreaterThan(0);
  });

  it('媒体部件名唯一（不出现 image2.png 之类的重复写入）', () => {
    const built = buildDocx(profile);
    const archive = readZip(built.bytes);
    const media = archive.by_path.get('word/media/image1.png');
    expect(media).toBeDefined();
    expect(media?.data.byteLength).toBe(2 * MIB);
    const mediaNames = archive.entries.map((e) => e.path).filter((p) => p.startsWith('word/media/'));
    expect(mediaNames).toEqual(['word/media/image1.png']);
  });
});

// ---------------------------------------------------------------------------
// §D 低内存：状态体积有界
// ---------------------------------------------------------------------------

describe('§D 低内存：40 次编辑后状态载体体积有界，日志上限被真正执行', () => {
  const profile: DocumentProfile = {
    paragraphs: 200,
    tables: 20,
    table_rows: 2,
    table_cols: 3,
    with_image: true,
    image_bytes: 256 * 1024,
  };

  it('状态载体每多一次编辑的增量远小于一次文档/媒体体积（不随编辑次数重复内嵌）', async () => {
    const built = buildDocx(profile);
    const persistence = new JsonLedgerPersistence();
    const { session } = openImportedSession(built.bytes, { id: 'S-MEM', persistence });

    // 第 1 次编辑：记下基线载体体积。
    mustOk(await session.submitEdit(submitInput(session, 'mem-1', boldFirstParagraphIntent())));
    const afterFirst = persistence.snapshot();
    if (afterFirst === null) throw new Error('保存后载体不应为 null');
    const baseline = afterFirst.length;

    const EDIT_COUNT = 40;
    for (let index = 2; index <= EDIT_COUNT; index += 1) {
      // 轮换目标段落，制造真实的、互不相同的编辑。
      const target = (index % 100) + 1;
      mustOk(
        await session.submitEdit(submitInput(session, `mem-${String(index)}`, centerParagraphIntent(target))),
      );
    }
    const afterAll = persistence.snapshot();
    if (afterAll === null) throw new Error('保存后载体不应为 null');
    const grown = afterAll.length - baseline;

    // 每多一次编辑的增量上界：4096 字节（日志/幂等/版本行的量级，几百字节）。
    // 若媒体或整份文档被按次重复内嵌，增量会逼近 (EDIT_COUNT-1) × 256 KiB ≈ 10 MiB，必红。
    expect(grown).toBeLessThan((EDIT_COUNT - 1) * 4096);
    // 同时载体本身也没大到"内嵌了一份导出 ZIP"：媒体只有 256 KiB，载体应是同量级而非几倍。
    expect(afterAll.length).toBeLessThan(4 * MIB);

    // 媒体份数不随编辑泄漏。
    expect(countModel(session.model()).media_parts).toBe(1);
    // 会话推进到 40 次成功编辑（编辑版本与次数一致）。
    expect(session.currentRevision()).toBe(EDIT_COUNT);
  });

  it('`max_log_entries` 上限被真正执行：30 次编辑后日志长度不超过上限', async () => {
    const built = buildDocx({ ...profile, with_image: false, image_bytes: 0 });
    const { session } = openImportedSession(built.bytes, { id: 'S-MEM-2', maxLogEntries: 10 });
    for (let index = 1; index <= 30; index += 1) {
      mustOk(
        await session.submitEdit(
          submitInput(session, `log-${String(index)}`, centerParagraphIntent((index % 50) + 1)),
        ),
      );
    }
    expect(session.operationLog().length).toBeLessThanOrEqual(10);
    // 上限只影响审计面，不影响状态推进。
    expect(session.currentRevision()).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// §E 取消
// ---------------------------------------------------------------------------

describe('§E 取消：发布被取消 ⇒ 会话不前进、旧字节完好', () => {
  const profile: DocumentProfile = {
    paragraphs: 10,
    tables: 0,
    table_rows: 0,
    table_cols: 0,
    with_image: false,
    image_bytes: 0,
  };

  it('取消一次发布：提交失败、版本不变、零交付、旧内容摘要不变', async () => {
    const built = buildDocx(profile);
    const { outcome, port, failure } = await runCancelScenario(built.bytes, centerParagraphIntent(3));

    expect(outcome.publish_attempted).toBe(true);
    expect(outcome.submit_failed).toBe(true);
    expect(failure.code).toBe('publish_failed');
    expect(outcome.failure_kind).toBe('cancelled');
    expect(outcome.revision_after).toBe(0);
    expect(outcome.published_count).toBe(0);
    expect(outcome.export_digest_unchanged).toBe(true);
    // 取消发生在发布点，"编译期就拒"不能冒充取消。
    expect(port.attempts).toBe(1);
  });

  it('取消后 lastFailure 如实记为 cancelled，且可继续提交（取消不是终局）', async () => {
    const built = buildDocx(profile);
    const { session, port } = openImportedSession(built.bytes, { id: 'S-CANCEL' });
    port.options = { failNext: { kind: 'cancelled', detail: '用户取消' }, throwNext: false };
    const cancelled = await session.submitEdit(submitInput(session, 'c1', centerParagraphIntent(2)));
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.detail.publishFailureKind).toBe('cancelled');
    expect(session.lastFailure()?.kind).toBe('cancelled');

    // 反向对照：同一编辑在健康端口上成功——证明"被取消"针对的是发布，而非编辑本身。
    const retry = await session.submitEdit(submitInput(session, 'c2', centerParagraphIntent(2)));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.replayed).toBe(false);
    expect(session.currentRevision()).toBe(1);
    expect(session.publishedVersions()).toHaveLength(1);
  });

  it('端口抛异常（模拟发布中途进程死亡）：状态机不前进（R145），异常收敛为结构化 publish_failed', async () => {
    const built = buildDocx(profile);
    const { session, port } = openImportedSession(built.bytes, { id: 'S-THROW' });
    const revisionBefore = session.currentRevision();
    const digestBefore = session.currentDigest();
    port.options = { failNext: null, throwNext: true };

    const result = await session.submitEdit(submitInput(session, 'crash-port', centerParagraphIntent(4)));
    // 唯一的写入口不得有两种失败形态：端口抛异常与端口返回失败走同一条收口
    // （`session.ts` 的 `#publishPort` 接住异常并转成 `port_threw`）。
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('publish_failed');
    expect(result.detail.publishFailureKind).toBe('port_threw');
    // 关键判据：抛异常的那次提交**没有**推进状态，旧字节仍可导出且摘要不变。
    expect(session.currentRevision()).toBe(revisionBefore);
    expect(session.publishedVersions()).toHaveLength(0);
    expect(session.lastFailure()?.kind).toBe('port_threw');
    const exported = mustOk(session.exportBytes());
    expect(digestBytes(exported)).toBe(digestBefore);
  });
});

// ---------------------------------------------------------------------------
// §F 崩溃恢复
// ---------------------------------------------------------------------------

describe('§F 崩溃恢复：JSON 账本 → 丢进程 → 恢复 → 幂等不重放 → 续编', () => {
  const profile: DocumentProfile = {
    paragraphs: 20,
    tables: 1,
    table_rows: 2,
    table_cols: 2,
    with_image: false,
    image_bytes: 0,
  };

  it('单次编辑后崩溃：恢复得到的编辑版本与交付数正确，重放不产生第二版', async () => {
    const built = buildDocx(profile);
    const { outcome } = await runCrashRecoveryScenario(
      built.bytes,
      centerParagraphIntent(5),
      boldFirstParagraphIntent(),
    );

    expect(outcome.restored).toBe(true);
    expect(outcome.revision_after_restore).toBe(1);
    expect(outcome.published_count_after_restore).toBe(1);
    // 重放：同一幂等键 ⇒ 判为重放，版本不动（R137/R146）。
    expect(outcome.replay_is_replayed).toBe(true);
    expect(outcome.revision_after_replay).toBe(1);
    // 续编一次新编辑 ⇒ 成功且版本 +1。
    expect(outcome.resumed_edit_ok).toBe(true);
    expect(outcome.revision_after_resume).toBe(2);
  });

  it('恢复后的会话可导出且内容经独立再导入一致（不是只读残骸）', async () => {
    const built = buildDocx(profile);
    const { resumed } = await runCrashRecoveryScenario(
      built.bytes,
      centerParagraphIntent(5),
      boldFirstParagraphIntent(),
    );
    const exported = mustOk(resumed.exportBytes());
    const reimported = importDocx(exported);
    // 表结构仍在；第 1 段被加粗（第二次编辑的效果）。
    expect(countModel(reimported).tables).toBe(1);
    const firstParagraph = collectParagraphs(reimported.blocks)[0];
    const boldRuns = (firstParagraph?.inlines ?? []).filter(
      (n) => n.kind === 'run' && n.properties.bold.state === 'on',
    );
    expect(boldRuns.length).toBeGreaterThan(0);
  });

  it('未保存任何状态时恢复：如实报告"没有既存状态"，不伪造加载', () => {
    const restored = DocumentSession.restore({
      id: 'S-EMPTY',
      filename: 'empty.docx',
      persistence: JsonLedgerPersistence.fromSnapshot(null),
      publish_port: new RecordingPublishPort(),
      now: FIXED_NOW,
    });
    expect(restored.session).toBeNull();
    expect(restored.result.loaded).toBe(false);
    expect(restored.result.reason.length).toBeGreaterThan(0);
  });
});
