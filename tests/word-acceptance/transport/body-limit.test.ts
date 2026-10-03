/**
 * R164 传输侧 —— **默认档**：请求体上限的确切阈值、拒绝是否结构化、是否截断正文。
 *
 * 这一档只发"裸字节"，不需要 Python 造语料，**默认就跑**（几十~几百毫秒级）。
 * 真正的重压档（Python 造 ≥10 MiB DOCX + 整链上传/下载往返）在
 * `docx-transport.test.ts`，由 `POTBOT_TRANSPORT_STRESS=1` 显式开启。
 *
 * ## 被测事实（全部来自只读的 `apps/demo/server/http.ts`）
 *
 * | 路由 | 上限常量 | 字节 |
 * |---|---|---|
 * | `POST /api/documents` | `MAX_BODY_BYTES` | 65,536 |
 * | `POST /api/artifacts/:id/observations` | `MAX_BODY_BYTES` | 65,536 |
 * | `POST /api/sessions/:id/edits` | `MAX_BODY_BYTES` | 65,536 |
 * | `POST /api/sessions`（DOCX 导入） | `SESSION_LIMITS.maxUploadBytes` | 16,777,216 |
 * | `GET /api/…/download` | **没有**请求体上限（GET 无体；响应侧也不设限） | — |
 *
 * **所以"64 KiB 上限会把 11 MiB 的 DOCX 挡在门外"这个前提本身是要被检验的**：
 * DOCX 走的是 `POST /api/sessions`，它的上限是 16 MiB（且是 base64 包装后的长度）。
 * 本档就把这两条路由的阈值分别量出来。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXPECTED_MAX_BODY_BYTES,
  EXPECTED_MAX_SESSION_BODY_BYTES,
  allRows,
  dumpRawResponse,
  findFreePort,
  getRaw,
  jsonBodyOfExactSize,
  liveRuntimeDir,
  outcomeOf,
  postRaw,
  recordEvidence,
  recordRow,
  startIsolatedServer,
  writeTransportReport,
  type RawResponse,
  type TransportHarness,
} from './support.js';

const MIB = 1024 * 1024;

let harness: TransportHarness;
let port: number;
let stopResult: { readonly portRefused: boolean } | null = null;

/** 一次探针 + 立即落一行（行与原始响应都留证）。 */
function probe(
  slug: string,
  scenario: string,
  route: string,
  limitDeclared: number | null,
  response: RawResponse,
  verdict: string,
): void {
  const outcome = outcomeOf(response);
  recordRow({
    slug,
    route,
    scenario,
    limitDeclared,
    requestBytes: outcome.requestBytes,
    status: outcome.status,
    code: outcome.code,
    message: outcome.message,
    responseBytes: outcome.responseBytes,
    truncated: !outcome.responseComplete || outcome.aborted,
    structuredError: outcome.jsonParsed && outcome.code !== null,
    deliveredToClient: outcome.status !== null && outcome.responseComplete,
    socketError: outcome.socketError,
    elapsedMs: outcome.elapsedMs,
    verdict,
  });
  dumpRawResponse(`raw-${slug}`, `${scenario}｜${route}｜请求 ${String(outcome.requestBytes)} B`, response);
}

beforeAll(async () => {
  port = await findFreePort();
  harness = await startIsolatedServer('body-limit', port);
  // 隔离是硬约束：只监听回环。
  expect(harness.bind, '服务必须只绑定回环地址').toBe('127.0.0.1');
  expect(harness.liveTouched, `.runtime live 目录被动了：${String(harness.liveTouched)}`).toBeNull();
  recordEvidence('harness-body-limit', {
    port: harness.port,
    bind: harness.bind,
    runDir: harness.runDir,
    runtimeDir: harness.runtimeDir,
    webDir: harness.webDir,
    pid: harness.pid,
    health: harness.health,
    liveRuntimeDir: liveRuntimeDir(),
    liveTouched: harness.liveTouched,
    expectedMaxBodyBytes: EXPECTED_MAX_BODY_BYTES,
    expectedMaxSessionBodyBytes: EXPECTED_MAX_SESSION_BODY_BYTES,
  });
}, 300_000);

afterAll(async () => {
  stopResult = await harness.stop();
  recordEvidence('teardown-body-limit', {
    port: harness.port,
    portRefusedAfterClose: stopResult.portRefused,
    liveTouchedOverWholeRun: harness.liveTouched,
    liveFilesAfterRun: harness.liveAfter.files.length,
    rows: allRows().length,
  });
  writeTransportReport('默认档（裸字节阈值与拒绝行为）', 'default');
  // 跑完必须关掉，且端口真的释放。
  expect(stopResult.portRefused, `服务已关闭但端口 ${String(harness.port)} 仍在监听`).toBe(true);
}, 120_000);

describe('R164 传输侧：POST /api/documents 的 body 上限（实测阈值）', () => {
  it('阈值二分：65536 B 过闸门，65537 B 被结构化 413 拒绝', async () => {
    const sizes = [
      EXPECTED_MAX_BODY_BYTES - 1,
      EXPECTED_MAX_BODY_BYTES,
      EXPECTED_MAX_BODY_BYTES + 1,
    ];
    const results: { size: number; status: number | null; code: string | null }[] = [];

    for (const size of sizes) {
      const body = jsonBodyOfExactSize({ requestId: `probe-${String(size)}`, instruction: 'hi' }, size);
      expect(body.byteLength, '构造的请求体必须逐字节精确').toBe(size);
      const response = await postRaw(port, '/api/documents', body, 60_000);
      const outcome = outcomeOf(response);
      results.push({ size, status: outcome.status, code: outcome.code });
      probe(
        `documents-exact-${String(size)}`,
        `恰好 ${String(size)} B`,
        'POST /api/documents',
        EXPECTED_MAX_BODY_BYTES,
        response,
        outcome.status === 413 ? '被 413 拒绝（超上限）' : '未被大小闸门拒绝',
      );
    }

    recordEvidence('threshold-documents', { limit: EXPECTED_MAX_BODY_BYTES, results });

    const below = results[0];
    const at = results[1];
    const above = results[2];
    // 上限**含**：恰好 65536 通过闸门（随后是业务处理，也可能 400/202，但绝不是 413）。
    expect(below?.code, `${String(below?.size)} B 不该被大小闸门拒绝`).not.toBe('body_too_large');
    expect(at?.code, `${String(at?.size)} B（＝上限）不该被大小闸门拒绝`).not.toBe('body_too_large');
    // 上限 +1 必须被拒，且错误码稳定。
    expect(above?.status, `${String(above?.size)} B 必须被拒`).toBe(413);
    expect(above?.code).toBe('body_too_large');
  }, 120_000);

  it('413 的响应体是**完整**的结构化 JSON（R164：错误不得截断正文）', async () => {
    const size = EXPECTED_MAX_BODY_BYTES + 1;
    const body = jsonBodyOfExactSize({ requestId: 'probe-truncation', instruction: 'hi' }, size);
    const response = await postRaw(port, '/api/documents', body, 60_000);
    const outcome = outcomeOf(response);

    probe(
      'documents-413-shape',
      '413 响应体完整性',
      'POST /api/documents',
      EXPECTED_MAX_BODY_BYTES,
      response,
      '错误体完整、可 JSON 解析、带稳定 code',
    );

    expect(outcome.status).toBe(413);
    expect(outcome.responseComplete, '响应必须收完整，不能半截').toBe(true);
    expect(outcome.aborted).toBe(false);
    expect(outcome.jsonParsed, '错误体必须是完整合法 JSON').toBe(true);
    expect(outcome.code).toBe('body_too_large');
    expect(outcome.message).toContain(String(EXPECTED_MAX_BODY_BYTES));
    // content-length 与实际收到的字节数一致 —— 传输没有截断。
    const declaredLength = response.rawHeaders.reduce<string | null>((found, header, index) => {
      if (found !== null) return found;
      if (header.toLowerCase() === 'content-length') return response.rawHeaders[index + 1] ?? null;
      return null;
    }, null);
    expect(Number(declaredLength), 'content-length 必须等于实际响应体字节数').toBe(outcome.responseBytes);
    expect(response.bodyBytes).toBeGreaterThan(0);
  }, 120_000);

  it('远超上限的 11 MiB body：记录客户端**究竟**收到什么（结构化错误 vs socket 被重置）', async () => {
    const size = 11 * MIB;
    const body = Buffer.alloc(size, 0x78); // 11 MiB 的 'x'
    const response = await postRaw(port, '/api/documents', body, 120_000);
    const outcome = outcomeOf(response);

    const delivered = outcome.status !== null && outcome.responseComplete;
    probe(
      'documents-11mib',
      '11 MiB body（远超 64 KiB 上限）',
      'POST /api/documents',
      EXPECTED_MAX_BODY_BYTES,
      response,
      delivered
        ? `客户端收到 ${String(outcome.status)} ${String(outcome.code)}`
        : `客户端**未**收到结构化响应（socket=${String(outcome.socketError)}）`,
    );

    // 服务端**必须**拒（不能悄悄收下 11 MiB）。
    if (delivered) {
      expect(outcome.status).toBe(413);
      expect(outcome.code).toBe('body_too_large');
      expect(outcome.jsonParsed).toBe(true);
    }
    // 无论哪条路径，都**不允许**出现"被接受"（2xx）。
    expect(outcome.status === null || outcome.status < 200 || outcome.status >= 300).toBe(true);
  }, 300_000);

  it('超大请求之后服务仍存活（没有因为拒收而崩溃/泄漏连接）', async () => {
    const health = await getRaw(port, '/health', 30_000);
    probe(
      'health-after-oversize',
      '超大请求后的存活探针',
      'GET /health',
      null,
      health,
      '服务仍可响应',
    );
    expect(health.status).toBe(200);
    expect(health.jsonParsed).toBe(true);
  }, 60_000);
});

describe('R164 传输侧：POST /api/sessions（DOCX 导入）的 body 上限（实测阈值）', () => {
  it('阈值二分：16777216 B 过闸门，16777217 B 被结构化 413 拒绝', async () => {
    const base = {
      sessionId: 'S-limit-probe',
      filename: 'probe.docx',
      mode: 'import',
      docxBase64: 'AAAA',
    };
    const sizes = [
      EXPECTED_MAX_SESSION_BODY_BYTES,
      EXPECTED_MAX_SESSION_BODY_BYTES + 1,
    ];
    const results: { size: number; status: number | null; code: string | null }[] = [];

    for (const size of sizes) {
      const body = jsonBodyOfExactSize(base, size);
      expect(body.byteLength).toBe(size);
      const response = await postRaw(port, '/api/sessions', body, 180_000);
      const outcome = outcomeOf(response);
      results.push({ size, status: outcome.status, code: outcome.code });
      probe(
        `sessions-exact-${String(size)}`,
        `恰好 ${String(size)} B（base64 包装后）`,
        'POST /api/sessions',
        EXPECTED_MAX_SESSION_BODY_BYTES,
        response,
        outcome.status === 413 ? '被 413 拒绝（超上限）' : '未被大小闸门拒绝（进入业务校验）',
      );
    }

    recordEvidence('threshold-sessions', { limit: EXPECTED_MAX_SESSION_BODY_BYTES, results });

    const at = results[0];
    const above = results[1];
    expect(at?.code, `${String(at?.size)} B（＝上限）不该被大小闸门拒绝`).not.toBe('body_too_large');
    expect(above?.status, `${String(above?.size)} B 必须被拒`).toBe(413);
    expect(above?.code).toBe('body_too_large');
  }, 300_000);

  it('被拒的上传**没有**在服务端留下半个会话（R165：超限/失败不得产生副作用）', async () => {
    // 用远超上限的体（预期客户端连 413 都收不到，只会 ECONNRESET）——
    // 恰恰在这种最糟的形态下，服务端也**不得**悄悄建出半截会话。
    const sessionId = 'S-rejected-no-side-effect';
    const body = jsonBodyOfExactSize(
      { sessionId, filename: 'rejected.docx', mode: 'import', docxBase64: 'AAAA' },
      20 * MIB,
    );
    const upload = await postRaw(port, '/api/sessions', body, 180_000);
    const outcome = outcomeOf(upload);
    probe(
      'sessions-rejected-no-side-effect',
      '被拒上传后查会话（应 404）',
      'POST /api/sessions',
      EXPECTED_MAX_SESSION_BODY_BYTES,
      upload,
      `上传结果：${outcome.status === null ? `无响应（${String(outcome.socketError)}）` : String(outcome.status)}`,
    );
    expect(outcome.status === null || outcome.status >= 400, '超限上传不得被接受').toBe(true);

    const status = await getRaw(port, `/api/sessions/${sessionId}`, 30_000);
    probe(
      'sessions-after-reject-status',
      '被拒上传的会话查询结果',
      'GET /api/sessions/:id',
      null,
      status,
      `${String(status.status)} ${String(outcomeOf(status).code)}`,
    );
    // 会话不存在 ⇒ 404 session_not_found；**绝不能**是 200（半个会话）。
    expect(status.status, '被拒的上传不得在服务端留下任何会话').toBe(404);
  }, 300_000);
});

describe('R164 传输侧：越界拒绝必须**送达客户端**（不得被 socket 重置吃掉）', () => {
  it('从 64 KiB+1 逐级放大：每一级都必须收到**完整的结构化 413**', async () => {
    const ladder = [
      65_537, 128 * 1024, 256 * 1024, 512 * 1024,
      1 * MIB, 2 * MIB, 4 * MIB, 8 * MIB,
    ];
    const observations: {
      size: number; status: number | null; code: string | null;
      delivered: boolean; socketError: string | null;
    }[] = [];

    for (const size of ladder) {
      // 前缀是合法 JSON 的开头，后面全是 'x'：无论是否被解析，大小闸门都在解析之前开火。
      const body = Buffer.alloc(size, 0x78);
      const response = await postRaw(port, '/api/documents', body, 120_000);
      const outcome = outcomeOf(response);
      const delivered = outcome.status !== null && outcome.responseComplete;
      observations.push({
        size, status: outcome.status, code: outcome.code,
        delivered, socketError: outcome.socketError,
      });
      probe(
        `crossover-${String(size)}`,
        `${String(size)} B 阶梯探针`,
        'POST /api/documents',
        EXPECTED_MAX_BODY_BYTES,
        response,
        delivered
          ? `客户端收到 ${String(outcome.status)} ${String(outcome.code)}`
          : `客户端**未**收到结构化响应（socket=${String(outcome.socketError)}）`,
      );
    }

    recordEvidence('crossover-client-delivery', {
      note: '每一级的请求体都远超 64 KiB 上限；差别只在"超出多少"。',
      ladder: observations,
      firstUndelivered: observations.find((item) => !item.delivered) ?? null,
      largestDelivered: [...observations].reverse().find((item) => item.delivered) ?? null,
    });

    // 事实层：每一级都**必须**被服务端拒绝（要么 413，要么连接被重置），不许有 2xx。
    for (const item of observations) {
      expect(
        item.status === null || item.status >= 400,
        `${String(item.size)} B 不该被接受（实测 ${String(item.status)}）`,
      ).toBe(true);
    }
    // 结构性事实（**2026-10-03 翻转**）：每一级都必须**送到客户端**。
    //
    // 这条原先断言的是相反的事实——当时 `readBody` 在首个超限块上直接 `return null`，
    // 请求里还有未读字节，Node 随即 RST 套接字，**客户端只看到 ECONNRESET**
    // （WCF-D63 实测：≥1 MiB 的越界请求全部收不到 413）。协调者把两处读取改为
    // **先有界排空再拒绝**（`drainRequest`，上限 32 MiB）后，全部档位都收到了完整 413。
    //
    // 因此这条现在钉住的是**修复后**的行为：R164 的"错误不得截断正文"要求错误
    // **真的能被客户端读到**——收不到的错误等于没有错误。
    const undelivered = observations.filter((item) => !item.delivered);
    expect(
      undelivered,
      `这些档位的越界拒绝没有送达客户端：${JSON.stringify(undelivered)}`,
    ).toEqual([]);
    // 且收到的是**结构化**的 413（不是 200、也不是空响应）。
    for (const item of observations) {
      expect(item.status, `${String(item.size)} B 应当收到 413`).toBe(413);
      expect(item.code, `${String(item.size)} B 的 413 应当带 code`).toBe('body_too_large');
    }
  }, 300_000);
});

describe('R164 传输侧：隔离纪律（服务全程没碰 .runtime live 目录）', () => {
  it('服务运行期间 `.runtime/mobile-word-demo/MWD-20261002-A` 指纹无变化', () => {
    expect(
      harness.liveTouched,
      `.runtime live 目录被改动了：${String(harness.liveTouched)}；本任务禁止触碰 live 索引/账本`,
    ).toBeNull();
    // 顺带把两侧指纹都留证（空目录也是一种可核对的事实）。
    recordEvidence('runtime-untouched', {
      liveRuntimeDir: liveRuntimeDir(),
      before: harness.liveBefore,
      after: harness.liveAfter,
      diff: harness.liveTouched,
      isolatedRunDir: harness.runDir,
      isolatedRuntimeDir: harness.runtimeDir,
    });
  });
});
