/**
 * R164 传输侧 —— **压力档**：真实的 ≥10 MiB DOCX 走 HTTP 传输，独立 Python 读回。
 *
 * 默认档（`body-limit.test.ts`）用裸字节量出了阈值与"拒绝送达不到"的拐点；
 * 这一档回答真正的产品问题：**一份 11 MiB 的 DOCX 到底能不能上传、能不能下载**，
 * 以及"传过去的东西"与"传回来的东西"是否一致（R167：判据交给独立工具）。
 *
 * 默认**跳过**（`fileParallelism: false` + Python 造 11/27 MiB 语料较慢，不进日常回归）。
 * 显式开关：`POTBOT_TRANSPORT_STRESS=1`。**跳过 ≠ 通过**——报告里分开列。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXPECTED_MAX_BODY_BYTES,
  EXPECTED_MAX_SESSION_BODY_BYTES,
  STRESS_ENABLED,
  STRESS_SKIP_REASON,
  buildCorpus,
  evidencePath,
  findFreePort,
  fmtBytes,
  getRaw,
  jsonBodyOfExactSize,
  liveRuntimeDir,
  outcomeOf,
  postRaw,
  readback,
  recordEvidence,
  recordRow,
  startIsolatedServer,
  writeTransportReport,
  type BuiltCorpus,
  type TransportHarness,
} from './support.js';

const MIB = 1024 * 1024;

/** D52「维度 D」用的同一份规格：≥11 MiB 容器 / 120 张有效 PNG / 500+ 段。 */
const ELEVEN_MIB_SPEC = {
  paragraphs: 500,
  images: 120,
  imagePixels: 176,
  minBytes: 11 * MIB,
} as const;

/** D52「维度 F」用的同一份规格：~27.65 MiB 容器，"已测到的最大规模"。 */
const HUGE_SPEC = {
  paragraphs: 2_000,
  hanzi: 200_000,
  images: 300,
  imagePixels: 176,
  minBytes: 24 * MIB,
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 原始响应头里某个头的值（`rawHeaders` 是扁平的 name/value 序列）。 */
function headerOf(headers: readonly string[], name: string): string | null {
  const wanted = name.toLowerCase();
  for (let index = 0; index + 1 < headers.length; index += 2) {
    if ((headers[index] ?? '').toLowerCase() === wanted) return headers[index + 1] ?? null;
  }
  return null;
}

let harness: TransportHarness;

/**
 * **钩子放在 `describe.skipIf` 里面**：整块被跳过时，一条服务都不起、一个文件都不写。
 * （放外面会让"默认档"也白起一个服务，还会用空表覆盖压力档的报告——实测踩过。）
 */
describe.skipIf(!STRESS_ENABLED)(
  `R164 传输侧压力档 ${STRESS_ENABLED ? '[已执行]' : STRESS_SKIP_REASON}`,
  () => {
    beforeAll(async () => {
      const port = await findFreePort();
      harness = await startIsolatedServer('docx-transport', port);
      expect(harness.bind).toBe('127.0.0.1');
      expect(harness.liveTouched, `.runtime live 目录被动了：${String(harness.liveTouched)}`).toBeNull();
      recordEvidence('harness-docx-transport', {
        port: harness.port,
        bind: harness.bind,
        runDir: harness.runDir,
        runtimeDir: harness.runtimeDir,
        health: harness.health,
        liveRuntimeDir: liveRuntimeDir(),
        liveTouched: harness.liveTouched,
      });
    }, 300_000);

    afterAll(async () => {
      const stopResult = await harness.stop();
      recordEvidence('teardown-docx-transport', {
        port: harness.port,
        portRefusedAfterClose: stopResult.portRefused,
        liveTouchedOverWholeRun: harness.liveTouched,
      });
      writeTransportReport('压力档（11 MiB DOCX 上传/下载往返 + 独立 Python 读回）', 'stress');
      expect(stopResult.portRefused, `服务已关闭但端口 ${String(harness.port)} 仍在监听`).toBe(true);
    }, 300_000);

    it('11.22 MiB DOCX：上传 → 编辑发布 → 下载 → 独立 Python 读回结构一致', { timeout: 900_000 }, async () => {
      // --- 1. 独立 Python 造一份 ≥11 MiB 的真实 DOCX（复用 D52 的构建器） -------------
      const built: BuiltCorpus = buildCorpus(ELEVEN_MIB_SPEC, evidencePath('corpus'), 'eleven-mib.docx');
      const sourceBytes = readFileSync(built.path);
      const sourceSha = sha256(sourceBytes);
      const base64 = sourceBytes.toString('base64');

      const uploadBody = Buffer.from(
        JSON.stringify({
          sessionId: 'S-d63-eleven',
          filename: '十一兆文档.docx',
          mode: 'import',
          docxBase64: base64,
        }),
        'utf8',
      );

      recordEvidence('corpus-eleven-mib', {
        path: built.path,
        declared: built.meta,
        containerBytes: sourceBytes.byteLength,
        containerHuman: fmtBytes(sourceBytes.byteLength),
        sha256: sourceSha,
        base64Bytes: Buffer.byteLength(base64),
        base64OverLimit: Buffer.byteLength(base64) > EXPECTED_MAX_SESSION_BODY_BYTES,
        requestBodyBytes: uploadBody.byteLength,
      });

      // --- 2. 上传：走 **DOCX 真正的入口** POST /api/sessions ------------------------
      const upload = await postRaw(harness.port, '/api/sessions', uploadBody, 600_000);
      const uploadOutcome = outcomeOf(upload);
      recordRow({
        slug: 'docx-11mib-upload',
        route: 'POST /api/sessions',
        scenario: `11.22 MiB DOCX 上传（body ${String(uploadBody.byteLength)} B）`,
        limitDeclared: EXPECTED_MAX_SESSION_BODY_BYTES,
        requestBytes: uploadOutcome.requestBytes,
        status: uploadOutcome.status,
        code: uploadOutcome.code,
        message: uploadOutcome.message,
        responseBytes: uploadOutcome.responseBytes,
        truncated: !uploadOutcome.responseComplete || uploadOutcome.aborted,
        structuredError: uploadOutcome.jsonParsed && uploadOutcome.code !== null,
        deliveredToClient: uploadOutcome.status !== null && uploadOutcome.responseComplete,
        socketError: uploadOutcome.socketError,
        elapsedMs: uploadOutcome.elapsedMs,
        verdict: uploadOutcome.status === 201
          ? '上传被接受（未越过 16 MiB 传输上限）'
          : `上传未成功（${String(uploadOutcome.status)} ${String(uploadOutcome.code)}${
              uploadOutcome.socketError === null ? '' : ` / ${uploadOutcome.socketError}`})`,
      });
      writeFileSync(
        evidencePath('raw-docx-11mib-upload-header'),
        [
          `状态行：${upload.statusLine ?? '(无)'}`,
          `请求体字节数：${String(uploadOutcome.requestBytes)}`,
          `耗时：${uploadOutcome.elapsedMs.toFixed(1)} ms`,
          `socket 错误：${uploadOutcome.socketError ?? '(无)'}`,
          `响应体：${upload.bodyText.slice(0, 2000)}`,
        ].join('\n'),
        'utf8',
      );

      expect(
        uploadOutcome.status,
        `11 MiB DOCX 上传失败：${upload.bodyText.slice(0, 500)}｜socket=${String(uploadOutcome.socketError)}`,
      ).toBe(201);

      const opened = upload.bodyJson as Record<string, unknown>;
      const contentDigest = opened['contentDigest'];
      const editRevision0 = opened['editRevision'];
      expect(typeof contentDigest).toBe('string');
      expect(editRevision0).toBe(0);

      // --- 3. 提交一次编辑，触发发布（R144：候选 → 写盘 → 回读 → 发布） -------------
      const editBody = Buffer.from(
        JSON.stringify({
          idempotencyKey: 'd63-eleven-edit-1',
          baseRevision: editRevision0,
          baseDigest: contentDigest,
          intent: { steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
        }),
        'utf8',
      );
      const edit = await postRaw(harness.port, '/api/sessions/S-d63-eleven/edits', editBody, 600_000);
      expect(edit.status, `编辑提交失败：${edit.bodyText.slice(0, 500)}`).toBe(200);
      const editJson = edit.bodyJson as Record<string, unknown>;
      const version = editJson['version'] as Record<string, unknown> | null;
      expect(version, '必须真的产生了新版本（否则没有可下载的产物）').not.toBeNull();
      const versionDigest = version?.['contentDigest'];
      const versionBytes = version?.['byteLength'];
      const publishedRevision = version?.['editRevision'];
      expect(typeof versionDigest).toBe('string');
      expect(typeof publishedRevision).toBe('number');

      // --- 4. 下载这一版（GET 无请求体上限；量的是响应侧会不会被截断） --------------
      const download = await getRaw(
        harness.port,
        `/api/sessions/S-d63-eleven/versions/${String(publishedRevision)}/download`,
        600_000,
      );
      const downloadOutcome = outcomeOf(download);
      const declaredLength = headerOf(download.rawHeaders, 'content-length');
      const receivedSha = sha256(download.bodyBuffer);
      const headerSha = headerOf(download.rawHeaders, 'x-content-sha256');

      recordRow({
        slug: 'docx-11mib-download',
        route: 'GET /api/sessions/:id/versions/:n/download',
        scenario: '下载刚发布的版本（re-export 后的 DOCX）',
        limitDeclared: null,
        requestBytes: 0,
        status: downloadOutcome.status,
        code: downloadOutcome.code,
        message: downloadOutcome.message,
        responseBytes: downloadOutcome.responseBytes,
        truncated: !downloadOutcome.responseComplete || downloadOutcome.aborted,
        structuredError: downloadOutcome.jsonParsed && downloadOutcome.code !== null,
        deliveredToClient: downloadOutcome.status !== null && downloadOutcome.responseComplete,
        socketError: downloadOutcome.socketError,
        elapsedMs: downloadOutcome.elapsedMs,
        verdict: downloadOutcome.status === 200
          ? `下载成功，收到 ${fmtBytes(downloadOutcome.responseBytes)}`
          : `下载失败（${String(downloadOutcome.status)}）`,
      });

      expect(downloadOutcome.status, `下载失败：${download.bodyText.slice(0, 500)}`).toBe(200);
      expect(downloadOutcome.responseComplete, '下载响应必须收完整（不得截断）').toBe(true);
      expect(downloadOutcome.aborted).toBe(false);
      // 头里的 length 必须等于实际收到的字节数——这是"传输没有截断"的硬证据。
      expect(Number(declaredLength), 'content-length 必须等于实际收到的字节数').toBe(
        downloadOutcome.responseBytes,
      );
      // 客户端复算的 sha256 必须等于服务端声明的摘要（传输零损坏）。
      expect(headerSha, 'x-content-sha256 必须存在').not.toBeNull();
      expect(receivedSha, '收到的字节必须与响应头声明的摘要一致').toBe(headerSha);
      expect(receivedSha, '收到的字节必须与版本映射里的回读摘要一致').toBe(versionDigest);
      expect(downloadOutcome.responseBytes).toBe(Number(versionBytes));

      // --- 5. 落盘 + 独立 Python 读回（R167：不 import 生产 TS） --------------------
      const downloadedPath = evidencePath('downloaded-eleven-mib.docx');
      writeFileSync(downloadedPath, download.bodyBuffer);

      const sourceReadback = readback(built.path);
      const downloadedReadback = readback(downloadedPath);

      recordEvidence('independent-readback-eleven-mib', {
        source: {
          path: built.path,
          ok: sourceReadback.ok,
          byteLength: sourceReadback.byteLength,
          paragraphCount: sourceReadback.paragraphCount,
          mediaCount: sourceReadback.mediaPaths.length,
        },
        downloaded: {
          path: downloadedPath,
          ok: downloadedReadback.ok,
          byteLength: downloadedReadback.byteLength,
          paragraphCount: downloadedReadback.paragraphCount,
          mediaCount: downloadedReadback.mediaPaths.length,
        },
        transport: {
          sourceSha256: sourceSha,
          downloadedSha256: receivedSha,
          byteIdentical: receivedSha === sourceSha,
          note:
            '跨传输边界的**字节一致性**在 HTTP 层由 content-length + sha256 证明（下载字节 == 服务端回读摘要，'
            + '即盘上那份）。源文件与下载文件的差异来自 import→export 的重建（非传输问题），'
            + '故结构一致性由独立 Python 读回逐项核对。',
        },
      });

      expect(downloadedReadback.ok, `独立 Python 读回失败：${JSON.stringify(downloadedReadback.error)}`).toBe(true);
      expect(downloadedReadback.byteLength).toBe(downloadOutcome.responseBytes);
      // 结构一致：段落数与图片数与构建器声明的规模一致（R163「不隐藏截断」）。
      expect(
        downloadedReadback.paragraphCount,
        `下载产物的段落数与声明不符（声明 ${String(built.meta.paragraphs)}，读回 ${String(downloadedReadback.paragraphCount)}）`,
      ).toBe(built.meta.paragraphs);
      expect(
        downloadedReadback.mediaPaths.length,
        `下载产物的图片数与声明不符（声明 ${String(built.meta.images)}，读回 ${String(downloadedReadback.mediaPaths.length)}）`,
      ).toBe(built.meta.images);
      expect(sourceReadback.paragraphCount).toBe(built.meta.paragraphs);
      expect(sourceReadback.mediaPaths.length).toBe(built.meta.images);
    });

    it('真实 ~27 MiB DOCX（base64 后远超 16 MiB 上限）：记录客户端究竟收到什么', { timeout: 900_000 }, async () => {
      const built = buildCorpus(HUGE_SPEC, evidencePath('corpus'), 'huge.docx');
      const bytes = readFileSync(built.path);
      const base64 = bytes.toString('base64');
      const body = Buffer.from(
        JSON.stringify({
          sessionId: 'S-d63-huge',
          filename: '超限文档.docx',
          mode: 'import',
          docxBase64: base64,
        }),
        'utf8',
      );

      recordEvidence('corpus-huge', {
        path: built.path,
        declared: built.meta,
        containerBytes: bytes.byteLength,
        containerHuman: fmtBytes(bytes.byteLength),
        base64Bytes: Buffer.byteLength(base64),
        requestBodyBytes: body.byteLength,
        overLimitBy: body.byteLength - EXPECTED_MAX_SESSION_BODY_BYTES,
      });

      const response = await postRaw(harness.port, '/api/sessions', body, 600_000);
      const outcome = outcomeOf(response);
      const delivered = outcome.status !== null && outcome.responseComplete;

      recordRow({
        slug: 'docx-huge-upload',
        route: 'POST /api/sessions',
        scenario: `~27 MiB DOCX 上传（body ${String(body.byteLength)} B，远超 16 MiB 上限）`,
        limitDeclared: EXPECTED_MAX_SESSION_BODY_BYTES,
        requestBytes: outcome.requestBytes,
        status: outcome.status,
        code: outcome.code,
        message: outcome.message,
        responseBytes: outcome.responseBytes,
        truncated: !outcome.responseComplete || outcome.aborted,
        structuredError: outcome.jsonParsed && outcome.code !== null,
        deliveredToClient: delivered,
        socketError: outcome.socketError,
        elapsedMs: outcome.elapsedMs,
        verdict: delivered
          ? `客户端收到 ${String(outcome.status)} ${String(outcome.code)}`
          : `客户端**未**收到结构化拒绝（socket=${String(outcome.socketError)}）`,
      });

      writeFileSync(
        evidencePath('raw-docx-huge-upload-header'),
        [
          `状态行：${response.statusLine ?? '(无)'}`,
          `请求体字节数：${String(outcome.requestBytes)}`,
          `耗时：${outcome.elapsedMs.toFixed(1)} ms`,
          `响应收完整：${String(outcome.responseComplete)}｜aborted=${String(outcome.aborted)}`,
          `socket 错误：${outcome.socketError ?? '(无)'}`,
          `响应体：${response.bodyText.slice(0, 2000)}`,
        ].join('\n'),
        'utf8',
      );

      // 事实层：绝不允许被接受；也绝不允许只有 64 KiB 那个上限在起作用。
      expect(outcome.status === null || outcome.status >= 400, '超限上传不得被接受').toBe(true);
      if (delivered) {
        expect(outcome.status).toBe(413);
        expect(outcome.code).toBe('body_too_large');
      }
      // 无论送达与否，都**不该**是"越过了 DOCX 上传上限却被 64 KiB 上限误伤"的形态。
      expect(outcome.code).not.toBe(undefined);
    });

    it('对照：把 11 MiB 的请求体补齐到**刚好**越过 16 MiB 上限（小幅超限）', { timeout: 300_000 }, async () => {
      // 小幅超限时，服务端几乎收完了整个请求体才拒绝 ⇒ 客户端**应当**能收到结构化 413。
      // 与上一条（大幅超限、可能收不到）对照，用来定位"送达不到"的成因。
      const body = jsonBodyOfExactSize(
        { sessionId: 'S-d63-edge', filename: 'edge.docx', mode: 'import', docxBase64: 'AAAA' },
        EXPECTED_MAX_SESSION_BODY_BYTES + 1,
      );
      const response = await postRaw(harness.port, '/api/sessions', body, 600_000);
      const outcome = outcomeOf(response);
      const delivered = outcome.status !== null && outcome.responseComplete;

      recordRow({
        slug: 'sessions-edge-over-limit',
        route: 'POST /api/sessions',
        scenario: `刚好越过上限 1 字节（${String(body.byteLength)} B）`,
        limitDeclared: EXPECTED_MAX_SESSION_BODY_BYTES,
        requestBytes: outcome.requestBytes,
        status: outcome.status,
        code: outcome.code,
        message: outcome.message,
        responseBytes: outcome.responseBytes,
        truncated: !outcome.responseComplete || outcome.aborted,
        structuredError: outcome.jsonParsed && outcome.code !== null,
        deliveredToClient: delivered,
        socketError: outcome.socketError,
        elapsedMs: outcome.elapsedMs,
        verdict: delivered ? `客户端收到 ${String(outcome.status)} ${String(outcome.code)}` : '未收到',
      });

      expect(outcome.status).toBe(413);
      expect(outcome.code).toBe('body_too_large');
    });

    it('二分：**能上传的最大 DOCX 容器**是多少（把"传输侧容量"钉成一个数字）', { timeout: 900_000 }, async () => {
      // 传输闸门只看**请求体字节数**（base64 包装后）；DOCX 每涨 3 字节，body 涨 4 字节。
      // 所以要回答"最大的文档有多大"，就得实测这个拐点，而不是拿容器大小直接对比 16 MiB。
      const attempt = async (minBytes: number, tag: string): Promise<{ container: number; body: number; status: number | null; code: string | null }> => {
        const built = buildCorpus(
          { paragraphs: 500, images: 120, imagePixels: 176, minBytes },
          evidencePath('corpus'),
          `bisect-${tag}.docx`,
        );
        const bytes = readFileSync(built.path);
        const body = Buffer.from(
          JSON.stringify({
            sessionId: `S-d63-bisect-${tag}`,
            filename: 'bisect.docx',
            mode: 'import',
            docxBase64: bytes.toString('base64'),
          }),
          'utf8',
        );
        const response = await postRaw(harness.port, '/api/sessions', body, 600_000);
        const outcome = outcomeOf(response);
        return { container: bytes.byteLength, body: body.byteLength, status: outcome.status, code: outcome.code };
      };

      // 已知两端：11.0 MiB 能上传；26.76 MiB 不能（base64 溢出太多）。
      let low = await attempt(11 * MIB, 'lo0');
      let high = await attempt(13_800_000, 'hi0');
      const trace: unknown[] = [low, high];
      expect(low.status, '下界必须能上传').toBe(201);

      for (let round = 0; round < 5 && high.body - low.body > 200_000; round += 1) {
        const mid = Math.floor((low.container + high.container) / 2);
        const probe = await attempt(mid, `r${String(round)}`);
        if (probe.container <= low.container || probe.container >= high.container) break;
        trace.push(probe);
        if (probe.status === 201) low = probe; else high = probe;
      }

      recordEvidence('max-uploadable-docx-bisect', {
        method: '二分容器字节数；判据是 POST /api/sessions 是否 201。filename/sessionId 固定为 bisect.docx。',
        largestAccepted: low,
        smallestRejected: high,
        note: [
          '拐点由 **base64 膨胀 4/3** 决定：body ≈ 4/3 × 容器 + JSON 开销，卡在 16,777,216 字节。',
          '故"能上传的最大容器"≈ (16,777,216 − 开销) × 3/4，显著小于 16 MiB 这个数——'
            + '读 R164 时**不能**把 16 MiB 当成"文档可以到 16 MiB"。',
          '本拐点还依赖 filename / sessionId 的长度（JSON 开销），换名字会小幅移动。',
        ],
        trace,
      });

      // 事实：被接受的那一端必须真的能进业务校验；被拒的那一端必须是大小闸门拒的。
      expect(low.status, `最大可上传容器应为 201，实得 ${String(low.status)} ${String(low.code)}`).toBe(201);
      expect(high.status === null || high.status === 413).toBe(true);
    });
  },
);

// 默认档也要有一条**可见**的说明：这一档整体被跳过，不能当成"通过"。
describe('R164 传输侧压力档的可见性声明', () => {
  it(STRESS_ENABLED ? '[已执行] 压力档见上' : STRESS_SKIP_REASON, () => {
    recordEvidence('stress-gate', {
      stressEnabled: STRESS_ENABLED,
      envVar: 'POTBOT_TRANSPORT_STRESS',
      expectedMaxBodyBytes: EXPECTED_MAX_BODY_BYTES,
      skipReason: STRESS_SKIP_REASON,
      note: '跳过 ≠ 通过：默认运行**没有**跑 11 MiB DOCX 的上传/下载往返，报告里分开列。',
    });
    expect(true).toBe(true);
  });
});
