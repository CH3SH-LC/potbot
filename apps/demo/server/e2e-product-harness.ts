/**
 * FA-E2E-PRODUCT 的**独立夹具**：自带 ZIP 解析器 + 产品入口服务启停 + HTTP 小工具。
 *
 * ## 为什么 ZIP 解析器要「自带」（且不 import 内核）
 *
 * 三格式互不冒充的判据必须是**独立证据**：如果拿内核自己的结构自检器
 * （`src/artifacts/verify.ts` 的 `selfCheckArtifactBytes`）来读回，那么"自检器分不清格式"
 * 这个缺陷会同时污染被测对象与量尺。因此这里**只读 ZIP 的中央目录**，把"包里到底有哪些
 * 部件"原样列出来——DOCX 必有 `word/document.xml`，XLSX 必有 `xl/workbook.xml`，
 * PPTX 必有 `ppt/presentation.xml`，三者互斥。
 *
 * 解析器只依赖字节布局（EOCD 0x06054b50 → 中央目录 0x02014b50 → 文件名），
 * 不 import 本仓任何模块。压缩方法与数据本体一概不碰（只需目录项）。
 *
 * ## 为什么经 `createDemoServer` 起服务
 *
 * 任务要求"真实 HTTP + 真实 store 落盘 + 产品入口"。`createDemoServer` 正是产品入口：
 * 它按环境变量解析运行目录、建**落盘的内核存储**（`<runDir>/kernel-store/store.json`）、
 * 组装会话 / 交付 / 适配器三个宿主，并把它们挂到同一条 `createDemoRequestHandler` 上。
 * 夹具只是把它 `listen(0, 127.0.0.1)`，不替换任何一层。
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDemoServer, type DemoServer } from './main.js';
import { createLocalAdapterExecutor } from './adapters-actions.js';

// ---------------------------------------------------------------------------
// 独立 ZIP 解析器（只读中央目录）
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** EOCD 定长部分；注释最长 65535 是 ZIP 规范，扫描窗口取该上界。 */
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
/** 中央目录记录里文件名的字段偏移（定长头 46 字节）。 */
const CENTRAL_FIXED_LENGTH = 46;

/**
 * 列出 ZIP 包内的全部部件路径（**不校验、不解压**，只读中央目录）。
 *
 * @throws 找不到 EOCD、或中央目录签名不符（不是合法 ZIP / 被截断）。
 */
export function zipEntryNames(bytes: Uint8Array): readonly string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanFrom = Math.max(0, bytes.byteLength - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  let eocd = -1;
  for (let offset = bytes.byteLength - EOCD_MIN_LENGTH; offset >= scanFrom; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('不是合法 ZIP：找不到 EOCD（0x06054b50）');
  }
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const names: string[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符（不是合法 ZIP）`);
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + CENTRAL_FIXED_LENGTH;
    names.push(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)));
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return Object.freeze(names);
}

// ---------------------------------------------------------------------------
// 产品服务启停
// ---------------------------------------------------------------------------

export interface RunningProduct {
  readonly demo: DemoServer;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * 经**产品入口**起一个真实服务（`createDemoServer` + `listen`）。
 *
 * 环境只给 `POTBOT_RUN_DIR`：模型配置一律缺席 ⇒ 模型端口如实为 `null`（本套件不碰模型）。
 * 端口用 `0` 让内核分配，避免与并行工作者抢固定端口。
 *
 * **受控执行器（FA-FIX-DEFAULT-EXECUTOR）**：产品缺省是 fail-closed（`server.executor.unwired`），
 * 这里**显式注入**本机存根执行器，恢复"注入执行器 ⇒ 可确认完成"的正向能力——
 * 本套件要验的是"可信回执链"本身，而不是"产品没装执行器"（后者由专门的缺省路径用例钉住）。
 */
export async function startProduct(runDir: string): Promise<RunningProduct> {
  const demo = await createDemoServer(
    { POTBOT_RUN_DIR: runDir },
    { adapterExecutor: createLocalAdapterExecutor() },
  );
  const server: Server = demo.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    demo,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

export async function getJson(baseUrl: string, path: string): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Json };
}

export interface DownloadedBytes {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

/** 取下载面的**原始字节**（不解析 JSON，供独立 ZIP 解析器读回）。 */
export async function getBytes(baseUrl: string, path: string): Promise<DownloadedBytes> {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}
