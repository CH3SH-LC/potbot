/**
 * D53 测试用的**假端口**。
 *
 * 为什么要它们：判据要求「引擎不可用 / 未授权 / 超时 / 不可写各自是**结构化失败**，
 * 有测试（可以注入假的引擎端口）」。真实 Word 既慢又可能被授权策略收回，
 * 把它们当**日常**测试前提是错的——所以真实引擎走显式 opt-in（`word-com-optin.test.ts`），
 * 这里只造**确定性**的假端口。
 *
 * 一处刻意的设计：{@link engineProducingRealPdf} 会**真的产出一份真 PDF**
 * （用 reportlab，另一个真实生成器）。这样"成功路径"的判据仍然落在**真实读回**上，
 * 而不是两个假货互相对台词。
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  PdfEngine, PdfEngineIdentity, PdfEngineOutcome, PdfEngineRequest,
} from '../../../apps/demo/rendering/index.js';
import { makeRealPdf } from './support.js';

export const FAKE_IDENTITY: PdfEngineIdentity = {
  name: 'Fake Engine',
  version: '1.0',
  build: 'test',
  route: 'fake/test-double',
  platform: 'windows-desktop',
  license: { state: 'licensed', evidence: '测试注入', unlicensedButUsableObserved: false },
};

/** 记录调用次数的假引擎。 */
export interface RecordingEngine extends PdfEngine {
  readonly calls: readonly PdfEngineRequest[];
}

/** 恒定返回某个结局的假引擎（成功或失败都行）。 */
export function engineReturning(outcome: PdfEngineOutcome): RecordingEngine {
  const calls: PdfEngineRequest[] = [];
  return {
    calls,
    async probe() {
      return outcome.ok ? outcome.identity : null;
    },
    async export(request) {
      calls.push(request);
      return outcome;
    },
  };
}

/** 造一个"引擎说自己成功"的结局。 */
export function successOutcome(artifact: {
  path: string; byteLength: number; magic?: string; magicOk?: boolean;
}, identity: PdfEngineIdentity = FAKE_IDENTITY): PdfEngineOutcome {
  return {
    ok: true,
    identity,
    artifact: {
      path: artifact.path,
      byteLength: artifact.byteLength,
      magic: artifact.magic ?? '%PDF-',
      magicOk: artifact.magicOk ?? true,
    },
    durationMs: 1,
    raw: JSON.stringify({ fake: true }),
  };
}

/** 造一个失败的结局。 */
export function failureOutcome(kind: string, message: string): PdfEngineOutcome {
  return {
    ok: false,
    failure: { kind: kind as never, message },
    durationMs: 1,
    raw: JSON.stringify({ fake: true, kind }),
  };
}

/**
 * 假引擎：调 `reportlab` 在目标路径**真的产出一份真 PDF**，然后自报成功。
 *
 * 这样成功路径的判据落在**真实读回**上——读回器看到的不是假货。
 */
let realPdfCounter = 0;

export function engineProducingRealPdf(pages: number, footerPrefix = 'potbot-footer'): RecordingEngine {
  const calls: PdfEngineRequest[] = [];
  const identity = FAKE_IDENTITY;
  const serial = (realPdfCounter += 1);
  return {
    calls,
    async probe() {
      return identity;
    },
    async export(request) {
      calls.push(request);
      const produced = makeRealPdf(
        `fake-engine-${pages}p-${serial}.pdf`,
        pages,
        footerPrefix,
      );
      // 假引擎"导出"到请求的目标路径：复制真 PDF 字节过去。
      const bytes = readFileSync(produced);
      mkdirSync(dirname(request.targetPdfPath), { recursive: true });
      writeFileSync(request.targetPdfPath, bytes);
      return successOutcome(
        { path: request.targetPdfPath, byteLength: statSync(request.targetPdfPath).size },
        identity,
      );
    },
  };
}
