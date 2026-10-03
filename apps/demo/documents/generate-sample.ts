/**
 * **生成一份真实的、含多段正文的新 DOCX**（方案 S5「独立可读的新 DOCX」）。
 *
 * 用 `src/artifacts/**` 的**公开 API**（`buildDocxTemplate`）产出字节，再经 S5 的
 * **生产物化端口**（`createDocumentPort`）落盘并回读核对——一份文件同时留下两段证据：
 * "模板能产出多段正文" 与 "端口真的把它写下去并回读核对过"。
 *
 * ## 这份文件的证据层级（不得混用）
 *
 * - 它是**产物层**证据：证明模板 + 端口这条链能产出真实字节。
 * - 它**不是** Demo 运行链路的证据：本轮 Demo 要求正文由 live 模型产生、经内核
 *   任务 / 消息 / 轮次 / 发布链交付（方案「单一路线」）。这里刻意**不**冒充那一段。
 * - 它**不**证明 Word / 手机办公软件能打开（第三层证据，需真机）。
 *
 * ## 运行方式（必须在仓库根执行；本机没有 tsx/vite-node，故用 tsc 单独发射）
 *
 * ```bash
 * node node_modules/typescript/bin/tsc apps/demo/documents/generate-sample.ts \
 *   --outDir .runtime/mobile-word-demo/s5-gen --rootDir . \
 *   --module NodeNext --moduleResolution NodeNext --target ES2023 --lib ES2023 \
 *   --types node --strict --verbatimModuleSyntax --skipLibCheck
 * node .runtime/mobile-word-demo/s5-gen/apps/demo/documents/generate-sample.js [输出根目录]
 * ```
 *
 * 输出根目录默认 `.runtime/mobile-word-demo/MWD-20261002-A`；落点
 * `<根>/<artifactId>/<filename>`，脚本把路径 / 字节数 / sha256 以 JSON 打到 stdout。
 *
 * 正文**不含任何数字**：示例业务里没有已确认的人数 / 金额 / 日期，
 * 按 design-03「不捏造人数、金额、日期」的要求，宁可一个数字都不写。
 */

import { resolve } from 'node:path';

import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { createDocumentPort } from './port.js';

/** 运行 ID（与方案 / 台账一致）。 */
export const SAMPLE_RUN_ID = 'MWD-20261002-A';
/** artifactId 必须过端口白名单（字母 / 数字 / `.` `_` `-`）。 */
export const SAMPLE_ARTIFACT_ID = `${SAMPLE_RUN_ID}-invitation`;
export const SAMPLE_FILENAME = `${SAMPLE_RUN_ID}-invitation.docx`;

/** 三段正文：温暖、可读，且**不含**编造的时间 / 地点 / 联系方式 / 数字。 */
export const SAMPLE_PARAGRAPHS: readonly string[] = Object.freeze([
  '亲爱的同学，欢迎你参加本学期的新生读书会。',
  '我们会一起读完一本书，然后在某个下午坐下来，聊聊各自记住的句子和没想明白的问题。',
  '不需要提前准备，也不用担心说得不够好，带着好奇心来就好。',
]);

export const SAMPLE_TITLE = '新生读书会邀请函';

/** 默认输出根（**相对仓库根**；调用方可在 argv[2] 覆盖）。 */
export function defaultOutputRoot(cwd: string): string {
  return resolve(cwd, '.runtime', 'mobile-word-demo', SAMPLE_RUN_ID);
}

async function main(): Promise<void> {
  const outputRoot = process.argv[2] ?? defaultOutputRoot(process.cwd());

  const built = buildDocxTemplate({
    requirement: { title: SAMPLE_TITLE, description: '（段落路径不渲染 description）', paragraphs: SAMPLE_PARAGRAPHS },
    // 没有已确认事实 ⇒ 不写"已确认事实"小节，也不出现任何数字。
    fact_snapshot: [],
    references: [{ label: '写作要求', detail: '来自用户现场输入的主题描述' }],
  });

  const port = createDocumentPort(outputRoot);
  const receipt = await port.materialize({
    artifactId: SAMPLE_ARTIFACT_ID,
    filename: SAMPLE_FILENAME,
    bytes: built.bytes,
    expectedSha256: built.content_digest,
  });

  // 再走一次读回：证明"交付之后还能从盘上取回同一份字节"（下载面正是这样用的）。
  const readBack = await port.readBack(SAMPLE_ARTIFACT_ID);
  const readBackLength = readBack === undefined ? null : readBack.byteLength;

  const summary = {
    runId: SAMPLE_RUN_ID,
    artifactId: receipt.artifactId,
    path: receipt.path,
    byteLength: receipt.byteLength,
    sha256: receipt.sha256,
    builderContentDigest: built.content_digest,
    builderEntryCount: built.entry_count,
    title: SAMPLE_TITLE,
    paragraphCount: SAMPLE_PARAGRAPHS.length,
    readBackByteLength: readBackLength,
    digestMatchesBuilder: receipt.sha256 === built.content_digest,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
