/**
 * **PPT 媒体 / 形状 / 表格 / 图表 / 音视频 的 HTTP 面（harness）**
 * —— 工作包 **FA-PPT-MEDIA-PRODUCT**（PPT-06 / 07 / 08 / 09 / 12）。
 *
 * ## 这个文件是什么，以及它**不是**什么（必须摆到明面上）
 *
 * `src/presentations/**` 已经把 PPT-06..09/12 的模型层与字节层做完了，但**产品 HTTP 面上一条路都没有**：
 * `POST /api/deliverables`（pptx）只认 `add_slide / set_slide_title / remove_slide / set_slide_notes`
 * 四个 op（`src/session/adapters/pptx.ts` 的**封闭枚举**），而且它的 `fileBase64` 入参在
 * `DeliverableHost.open()` 里**没有被消费**（`OpenDeliverableInput.bytes` 声明了却没落到 `#openWith`
 * 的任何分支）——因此"导入一份带图/带图表的既有演示"在产品面上也不成立。
 *
 * 本文件**只做一件事**：把这些能力**原样**架在一条真实 HTTP 路由上（`/api/ppt-media/**`），
 * 让端到端用例可以在**真 HTTP** 上走完并拿到**每步的状态码**。
 *
 * 【挂载状态】工作包 **FA-PPT-MEDIA-MOUNT** 已把它挂进产品宿主 `apps/demo/server/http.ts`
 * （在 `/api/**` 兜底 404 **之前**按前缀转交，只做加法）——`main.js` 上命中 `/api/ppt-media/**`
 * 现在由本模块作答（`/status` 里 `mounted_in_product_host:true`）。本模块**零端口、零落盘**，
 * 因此没有"端口缺席 ⇒ 结构化未就绪"这一分支（与 `/api/tool-loop` 等有端口模块不同）。
 *
 * 与 `ppt-facts-product.ts` 同一套契约形状：纯函数路由、`routeXxx`（进程内直调，供路由级断言）
 * + `handleXxx`（真 `node:http`，供真服务断言）、零 IO、零墙钟、零随机数、无隐藏状态
 * （每个请求自带全部输入）。
 *
 * ## 它**只调用**、不重造
 *
 * | HTTP 端点 | 复用的 src 能力 |
 * |---|---|
 * | `POST /pictures` | `insertPicture` / `replacePicture` / `deletePicture` / `buildMediaDeck` |
 * | `POST /shapes` | `addFlowDiagram` / `addAutoShape` / `addConnector` / `buildShapesDeck` |
 * | `POST /tables` | `addTable` / `setCellText` / `insertRow` / `removeColumn` / `mergeCells` / `resolveTableText` |
 * | `POST /charts` | `insertChart` / `setChartData` / `setChartTitle` / `setChartType`，打包走 `renderPresentation` |
 * | `POST /av` | `checkAvMediaPermission` / `avMediaBoard` / `auditAvMedia`（**不渲染**：见下） |
 * | `POST /verify` | `verifyMediaPairingInPackage` / `verifyChartPackage` / `assertNoFullPageBitmap` |
 * | `GET  /status` | 路由清单 + 明确拒绝项 + 未验证清单 |
 *
 * ## 三条如实登记的边界（不得越界宣称）
 *
 * 1. **音视频不渲染**：`renderPresentation` 对 `kind: 'media'` 显式抛
 *    `unsupported_shape_kind`（"音视频渲染未实现"）。因此 `/av` 只回答
 *    **「这项引用到底是不是真嵌入了」**（`resolveAvMedia` 读回媒体目录真字节的事实判定），
 *    不产出 PPTX——**绝不**用一份没有媒体部件的包冒充"已嵌入"。
 * 2. **真机 / Office 播放未验证**：本层没有任何消费端（PowerPoint / WPS / 安卓）。
 *    产物"能播放"一律标未验证，随每个响应原样带出。
 * 3. **包内 ZIP 是本层渲染出来的**：`/verify` 的读回结果是**本仓的**判据，不是第三方校验器；
 *    因此用例还必须**自带独立 ZIP 解析器**再核一遍（见 `ppt-media-e2e.test.ts`）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DEFAULT_AV_MEDIA_PERMISSIONS,
  NO_AV_MEDIA_PERMISSIONS,
  addAutoShape,
  addConnector,
  addFlowDiagram,
  addSlide,
  addTable,
  assertNoFullPageBitmap,
  auditAvMedia,
  avMediaBoard,
  avPlayback,
  buildMediaDeck,
  buildShapesDeck,
  checkAvMediaPermission,
  deletePicture,
  describeSlideObjects,
  emptyPresentation,
  insertChart,
  insertColumn,
  insertPicture,
  insertRow,
  literalText,
  mediaCatalog,
  mergeCells,
  removeColumn,
  removeRow,
  renderPresentation,
  replacePicture,
  requireTable,
  resolveTableText,
  setCellText,
  setChartData,
  setChartTitle,
  setChartType,
  transform,
  verifyChartPackage,
  verifyMediaPairingInPackage,
  type AvMediaItem,
  type AvMediaPermissions,
  type ChartModel,
  type MediaCatalog,
  type Presentation,
  type Transform,
} from '../../../src/presentations/index.js';

// ---------------------------------------------------------------------------
// 常量与清单
// ---------------------------------------------------------------------------

export const PPT_MEDIA_ROOT = '/api/ppt-media';

export const PPT_MEDIA_ROUTES: readonly string[] = Object.freeze([
  `${PPT_MEDIA_ROOT}/status`,
  `${PPT_MEDIA_ROOT}/pictures`,
  `${PPT_MEDIA_ROOT}/shapes`,
  `${PPT_MEDIA_ROOT}/tables`,
  `${PPT_MEDIA_ROOT}/charts`,
  `${PPT_MEDIA_ROOT}/av`,
  `${PPT_MEDIA_ROOT}/verify`,
]);

/** 本层**明确拒绝**的事（写进 `/status`，不靠文档口头约定）。 */
export const PPT_MEDIA_EXPLICIT_REFUSALS: readonly string[] = Object.freeze([
  '不为音视频产出 PPTX：renderPresentation 对 media 形状显式抛 unsupported_shape_kind（音视频渲染未实现）。/av 只给"是否真嵌入"的事实判定。',
  '不接受外部 URL 的字节：媒体只能是请求体里的 base64（本层零网络）。',
  '不在本层落盘：无会话、无账本、无第二份状态；每个请求自带全部输入。',
  '不把"链接地址看着对"说成"链接有效"：无消费端，link_liveness_verified 恒为 false。',
  '不偷偷补齐缺失的媒体：引用了未提供的部件 ⇒ buildMediaDeck 具名报错，不产出半成品字节。',
]);

/** 未验证清单（随每个成功响应原样带出）。 */
export const PPT_MEDIA_UNVERIFIED: readonly string[] = Object.freeze([
  '真机 PowerPoint / WPS 打开产物是否有修复提示：未验证（无消费端）。',
  '音视频能否真的播放：未验证（无消费端；且本层不产出含媒体的包）。',
  '外部媒体链接是否可达：未验证（零网络）。',
  '形状 / 图表在第三方软件里的视觉呈现是否与模型一致：未验证（无消费端）。',
]);

const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 线级形状
// ---------------------------------------------------------------------------

export interface PptxMediaWireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 端点输入（与 `routePptxFactsRequest` 同形状，便于用例进程内直调）。 */
export interface PptxMediaWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

// ---------------------------------------------------------------------------
// 小工具（自足，不 import 任何产品宿主）
// ---------------------------------------------------------------------------

function ok(status: number, body: unknown): PptxMediaWireResponse {
  return { status, body };
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): PptxMediaWireResponse {
  return { status, body: { code, message, ...extra } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** 严格 base64（本层不猜：形状不对就报错，不靠 Buffer 的宽进）。 */
function decodeBase64Strict(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return null;
  return bytes;
}

/** 领域错误的具名 reason（本仓各领域错误都带 `reason`）。 */
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return error instanceof Error ? error.name : 'unknown_error';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 领域错误 → 422（判据不成立，输入合法但模型/字节层拒绝）。 */
function domainFailure(stage: string, error: unknown): PptxMediaWireResponse {
  return fail(422, 'ppt_media_invariant_violated', describe(error), {
    stage,
    reason: reasonOf(error),
    bytes_emitted: 0,
  });
}

/** 某一个 op 失败 → 422（该 op 没成，且**不产出任何字节**）。 */
function opFailure(stage: string, error: unknown, extra?: Record<string, unknown>): PptxMediaWireResponse {
  return fail(422, 'ppt_media_op_failed', describe(error), {
    stage,
    reason: reasonOf(error),
    bytes_emitted: 0,
    ...extra,
  });
}

function pptxView(bytes: Buffer, slideCount: number, entryCount: number, digest: string): Record<string, unknown> {
  return {
    base64: bytes.toString('base64'),
    byte_length: bytes.byteLength,
    entry_count: entryCount,
    content_digest: digest,
    slide_count: slideCount,
  };
}

function transformOf(value: unknown, fallback: Transform | null): Transform | null {
  if (value === undefined) return fallback;
  if (!isRecord(value)) return null;
  const x = asInteger(value['x']);
  const y = asInteger(value['y']);
  const cx = asInteger(value['cx']);
  const cy = asInteger(value['cy']);
  if (x === null || y === null || cx === null || cy === null) return null;
  return transform(x, y, cx, cy);
}

function deckFrom(spec: Record<string, unknown>): Presentation {
  const id = asString(spec['id']) ?? 'deck';
  const title = asString(spec['title']) ?? '演示文稿';
  const slides = asInteger(spec['slides']);
  if (slides === null || slides < 1) {
    throw new Error('deck.slides 必须是 ≥1 的整数（页数由调用方决定，本层不替它决定）');
  }
  let deck = emptyPresentation(id, title);
  for (let index = 0; index < slides; index += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function catalogFrom(value: unknown): MediaCatalog {
  if (value === undefined) return mediaCatalog([]);
  if (!Array.isArray(value)) throw new Error('parts 必须是数组');
  const parts = value.map((raw) => {
    if (!isRecord(raw)) throw new Error('parts 里每一项都必须是对象');
    const path = asString(raw['path']);
    const base64 = asString(raw['base64']);
    if (path === null || base64 === null) throw new Error('parts 每一项都要有 path 与 base64');
    const bytes = decodeBase64Strict(base64);
    if (bytes === null) throw new Error(`parts 里 ${path} 的 base64 不合法`);
    return { path, bytes };
  });
  return mediaCatalog(parts);
}

// ---------------------------------------------------------------------------
// POST /pictures —— PPT-06：插入 / 替换 / 删除 + 成对打包
// ---------------------------------------------------------------------------

function handlePictures(body: Record<string, unknown>): PptxMediaWireResponse {
  const deckSpec = body['deck'];
  if (!isRecord(deckSpec)) return fail(400, 'invalid_deck', '缺少 deck{id,title,slides}');
  const ops = body['ops'];
  if (!Array.isArray(ops) || ops.length === 0) return fail(400, 'invalid_ops', '缺少 ops（非空数组）');

  let deck: Presentation;
  let catalog: MediaCatalog;
  try {
    deck = deckFrom(deckSpec);
    catalog = catalogFrom(body['parts']);
  } catch (error) {
    return fail(400, 'invalid_body', describe(error));
  }

  const steps: Record<string, unknown>[] = [];
  for (const [index, raw] of ops.entries()) {
    if (!isRecord(raw)) return fail(400, 'invalid_ops', `ops[${String(index)}] 不是对象`, { steps });
    const op = asString(raw['op']);
    try {
      if (op === 'insert') {
        const slideId = asInteger(raw['slide_id']);
        const mediaPath = asString(raw['media_path']);
        if (slideId === null || mediaPath === null) {
          return fail(400, 'invalid_ops', `ops[${String(index)}] 的 insert 需要 slide_id 与 media_path`, { steps });
        }
        const box = transformOf(raw['transform'], transform(0, 0, 3000000, 2000000));
        if (box === null) {
          return fail(400, 'invalid_ops', `ops[${String(index)}] 的 transform 需要整数 x/y/cx/cy`, { steps });
        }
        const shapeId = asInteger(raw['shape_id']);
        const inserted = insertPicture(
          deck,
          slideId,
          {
            ...(shapeId === null ? {} : { shape_id: shapeId }),
            transform: box,
            media_path: mediaPath,
            alt_text: asString(raw['alt_text']) ?? '',
          },
          catalog,
        );
        deck = inserted.presentation;
        steps.push({ op: 'insert', ok: true, slide_id: slideId, shape_id: inserted.shape_id, media_path: mediaPath });
      } else if (op === 'replace') {
        const slideId = asInteger(raw['slide_id']);
        const shapeId = asInteger(raw['shape_id']);
        const mediaPath = asString(raw['media_path']);
        if (slideId === null || shapeId === null || mediaPath === null) {
          return fail(400, 'invalid_ops', `ops[${String(index)}] 的 replace 需要 slide_id/shape_id/media_path`, { steps });
        }
        const bytesRaw = raw['base64'];
        const bytes = bytesRaw === undefined ? undefined : decodeBase64Strict(String(bytesRaw));
        if (bytesRaw !== undefined && bytes === null) {
          return fail(400, 'invalid_ops', `ops[${String(index)}] 的 base64 不合法`, { steps });
        }
        const altText = asString(raw['alt_text']);
        const replaced = replacePicture(
          deck,
          catalog,
          { slide_id: slideId, shape_id: shapeId },
          { media_path: mediaPath, ...(bytes === undefined || bytes === null ? {} : { bytes }), ...(altText === null ? {} : { alt_text: altText }) },
        );
        deck = replaced.presentation;
        catalog = replaced.catalog;
        steps.push({ op: 'replace', ok: true, slide_id: slideId, shape_id: shapeId, media_path: mediaPath });
      } else if (op === 'delete') {
        const slideId = asInteger(raw['slide_id']);
        const shapeId = asInteger(raw['shape_id']);
        if (slideId === null || shapeId === null) {
          return fail(400, 'invalid_ops', `ops[${String(index)}] 的 delete 需要 slide_id 与 shape_id`, { steps });
        }
        const deleted = deletePicture(deck, catalog, { slide_id: slideId, shape_id: shapeId });
        deck = deleted.presentation;
        catalog = deleted.catalog;
        steps.push({ op: 'delete', ok: true, slide_id: slideId, shape_id: shapeId });
      } else {
        return fail(400, 'invalid_ops', `ops[${String(index)}] 的 op 只支持 insert / replace / delete`, { steps });
      }
    } catch (error) {
      // 该步失败 ⇒ **不产出任何字节**（不返回半成品演示）。
      return opFailure(`pictures.ops[${String(index)}]`, error, { op, steps });
    }
  }

  let built;
  try {
    built = buildMediaDeck(deck, catalog);
  } catch (error) {
    return domainFailure('pictures.build', error);
  }
  // 读回：成对校验在打包内已经跑过一次；这里把它的结论如实带出来（用例仍会**独立**再核一遍）。
  const pairing = verifyMediaPairingInPackage(built.bytes);

  return ok(200, {
    ok: true,
    steps,
    pptx: pptxView(built.bytes, built.slide_count, built.entry_count, built.content_digest),
    media: {
      media_part_count: built.media_part_count,
      media_part_paths: pairing.media_part_paths,
      references: pairing.references,
    },
    unverified: PPT_MEDIA_UNVERIFIED,
  });
}

// ---------------------------------------------------------------------------
// POST /shapes —— PPT-07：形状 / 连接符（仍是可编辑对象）
// ---------------------------------------------------------------------------

function handleShapes(body: Record<string, unknown>): PptxMediaWireResponse {
  const deckSpec = body['deck'];
  if (!isRecord(deckSpec)) return fail(400, 'invalid_deck', '缺少 deck{id,title,slides}');
  let deck: Presentation;
  try {
    deck = deckFrom(deckSpec);
  } catch (error) {
    return fail(400, 'invalid_body', describe(error));
  }
  const slideId = asInteger(deckSpec['slide_id'] ?? body['slide_id']) ?? 1;

  const steps: Record<string, unknown>[] = [];
  const flowRaw = body['flow'];
  if (flowRaw !== undefined) {
    if (!isRecord(flowRaw) || !Array.isArray(flowRaw['texts'])) {
      return fail(400, 'invalid_body', 'flow 需要 texts（非空字符串数组）');
    }
    try {
      const flow = addFlowDiagram(deck, slideId, {
        texts: flowRaw['texts'].map((text) => String(text)),
      });
      deck = flow.presentation;
      steps.push({ op: 'add_flow', ok: true, node_ids: flow.node_ids, connector_ids: flow.connector_ids });
    } catch (error) {
      return domainFailure('shapes.flow', error);
    }
  }

  const extra = body['ops'];
  if (extra !== undefined) {
    if (!Array.isArray(extra)) return fail(400, 'invalid_ops', 'ops 必须是数组');
    for (const [index, raw] of extra.entries()) {
      if (!isRecord(raw)) return fail(400, 'invalid_ops', `ops[${String(index)}] 不是对象`, { steps });
      const op = asString(raw['op']);
      try {
        if (op === 'add_auto_shape') {
          const box = transformOf(raw['transform'], null);
          const preset = asString(raw['preset']);
          if (box === null || preset === null) {
            return fail(400, 'invalid_ops', `ops[${String(index)}] 的 add_auto_shape 需要 preset 与 transform{x,y,cx,cy}`, { steps });
          }
          const text = asString(raw['text']);
          const added = addAutoShape(deck, slideId, {
            transform: box,
            preset,
            ...(text === null ? {} : { text: literalText(text) }),
          });
          deck = added.presentation;
          steps.push({ op: 'add_auto_shape', ok: true, shape_id: added.shape_id });
        } else if (op === 'add_connector') {
          const from = asInteger(raw['from']);
          const to = asInteger(raw['to']);
          if (from === null || to === null) {
            return fail(400, 'invalid_ops', `ops[${String(index)}] 的 add_connector 需要 from 与 to（shape_id）`, { steps });
          }
          const added = addConnector(deck, slideId, { preset: asString(raw['preset']) ?? 'line', from, to });
          deck = added.presentation;
          steps.push({ op: 'add_connector', ok: true, shape_id: added.shape_id });
        } else {
          return fail(400, 'invalid_ops', `ops[${String(index)}] 只支持 add_auto_shape / add_connector`, { steps });
        }
      } catch (error) {
        return opFailure(`shapes.ops[${String(index)}]`, error, { steps });
      }
    }
  }

  let built;
  try {
    built = buildShapesDeck(deck);
  } catch (error) {
    return domainFailure('shapes.build', error);
  }

  return ok(200, {
    ok: true,
    steps,
    pptx: pptxView(built.bytes, built.slide_count, built.entry_count, built.content_digest),
    inventory: built.inventory_by_slide.map((entry) => describeSlideObjects(deck, entry.slide_id)),
    page_size: deck.size,
    unverified: PPT_MEDIA_UNVERIFIED,
  });
}

// ---------------------------------------------------------------------------
// POST /tables —— PPT-08：建表 + 改格 / 增删行列 / 合并
// ---------------------------------------------------------------------------

function handleTables(body: Record<string, unknown>): PptxMediaWireResponse {
  const deckSpec = body['deck'];
  const tableSpec = body['table'];
  if (!isRecord(deckSpec)) return fail(400, 'invalid_deck', '缺少 deck{id,title,slides}');
  if (!isRecord(tableSpec)) return fail(400, 'invalid_table', '缺少 table{rows,columns}');
  const rows = asInteger(tableSpec['rows']);
  const columns = asInteger(tableSpec['columns']);
  if (rows === null || columns === null || rows < 1 || columns < 1) {
    return fail(400, 'invalid_table', 'table.rows / table.columns 必须是 ≥1 的整数');
  }
  const slideId = asInteger(tableSpec['slide_id'] ?? 1) ?? 1;

  let deck: Presentation;
  let shapeId: number;
  const steps: Record<string, unknown>[] = [];
  try {
    deck = deckFrom(deckSpec);
    const textsRaw = tableSpec['texts'];
    const texts = Array.isArray(textsRaw)
      ? textsRaw.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell)) : []))
      : undefined;
    const width = asInteger(tableSpec['column_width_emu']);
    const added = addTable(deck, slideId, {
      rows,
      columns,
      transform: transformOf(tableSpec['transform'], transform(457200, 457200, 7315200, 2743200)) ?? transform(0, 0, 1000, 1000),
      ...(texts === undefined ? {} : { texts }),
      ...(width === null ? {} : { column_width_emu: width }),
    });
    deck = added.presentation;
    shapeId = added.shape_id;
    steps.push({ op: 'add_table', ok: true, shape_id: shapeId, rows, columns });
  } catch (error) {
    return domainFailure('tables.build', error);
  }

  const ops = body['ops'];
  if (ops !== undefined) {
    if (!Array.isArray(ops)) return fail(400, 'invalid_ops', 'ops 必须是数组');
    for (const [index, raw] of ops.entries()) {
      if (!isRecord(raw)) return fail(400, 'invalid_ops', `ops[${String(index)}] 不是对象`, { steps });
      const op = asString(raw['op']);
      const row = asInteger(raw['row']);
      const col = asInteger(raw['col']);
      try {
        switch (op) {
          case 'set_cell_text': {
            if (row === null || col === null) {
              return fail(400, 'invalid_ops', `ops[${String(index)}] 的 set_cell_text 需要 row 与 col`, { steps });
            }
            const text = raw['text'];
            deck = setCellText(deck, slideId, shapeId, row, col, text === undefined || text === null ? null : literalText(String(text)));
            break;
          }
          case 'insert_row': {
            if (row === null) return fail(400, 'invalid_ops', `ops[${String(index)}] 的 insert_row 需要 row`, { steps });
            deck = insertRow(deck, slideId, shapeId, row).presentation;
            break;
          }
          case 'remove_row': {
            if (row === null) return fail(400, 'invalid_ops', `ops[${String(index)}] 的 remove_row 需要 row`, { steps });
            deck = removeRow(deck, slideId, shapeId, row).presentation;
            break;
          }
          case 'insert_column': {
            if (col === null) return fail(400, 'invalid_ops', `ops[${String(index)}] 的 insert_column 需要 col`, { steps });
            deck = insertColumn(deck, slideId, shapeId, col).presentation;
            break;
          }
          case 'remove_column': {
            if (col === null) return fail(400, 'invalid_ops', `ops[${String(index)}] 的 remove_column 需要 col`, { steps });
            deck = removeColumn(deck, slideId, shapeId, col).presentation;
            break;
          }
          case 'merge': {
            const rowSpan = asInteger(raw['row_span']);
            const colSpan = asInteger(raw['col_span']);
            if (row === null || col === null || rowSpan === null || colSpan === null) {
              return fail(400, 'invalid_ops', `ops[${String(index)}] 的 merge 需要 row/col/row_span/col_span`, { steps });
            }
            deck = mergeCells(deck, slideId, shapeId, { row, col, row_span: rowSpan, col_span: colSpan });
            break;
          }
          default:
            return fail(400, 'invalid_ops', `ops[${String(index)}] 不支持 set_cell_text / insert_row / remove_row / insert_column / remove_column / merge`);
        }
        steps.push({ op, ok: true, row, col });
      } catch (error) {
        return opFailure(`tables.ops[${String(index)}]`, error, { steps });
      }
    }
  }

  let built;
  let grid: readonly (readonly string[])[];
  try {
    built = renderPresentation(deck);
    grid = resolveTableText(requireTable(deck, slideId, shapeId));
  } catch (error) {
    return domainFailure('tables.render', error);
  }

  return ok(200, {
    ok: true,
    steps,
    pptx: pptxView(built.bytes, built.slide_count, built.entry_count, built.content_digest),
    table: { shape_id: shapeId, slide_id: slideId, grid },
    unverified: PPT_MEDIA_UNVERIFIED,
  });
}

// ---------------------------------------------------------------------------
// POST /charts —— PPT-09：插图表 + 改数据（嵌入工作簿随图形打进去）
// ---------------------------------------------------------------------------

function chartFrom(value: unknown): ChartModel {
  if (!isRecord(value)) throw new Error('chart 必须是对象');
  const chartType = asString(value['chart_type']);
  const categories = value['categories'];
  const series = value['series'];
  if (chartType === null || !Array.isArray(categories) || !Array.isArray(series)) {
    throw new Error('chart 需要 chart_type / categories / series');
  }
  return {
    chart_type: chartType as ChartModel['chart_type'],
    categories: categories.map((entry) => String(entry)),
    series: series.map((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry['values'])) throw new Error('chart.series 每一项需要 name 与 values');
      return { name: String(entry['name'] ?? ''), values: entry['values'].map((number_) => Number(number_)) };
    }),
    title: asString(value['title']),
  };
}

function handleCharts(body: Record<string, unknown>): PptxMediaWireResponse {
  const deckSpec = body['deck'];
  if (!isRecord(deckSpec)) return fail(400, 'invalid_deck', '缺少 deck{id,title,slides}');

  let deck: Presentation;
  let shapeId: number;
  const steps: Record<string, unknown>[] = [];
  try {
    deck = deckFrom(deckSpec);
    const slideId = asInteger(body['slide_id']) ?? 1;
    const added = insertChart(deck, slideId, {
      transform: transformOf(body['transform'], transform(838200, 457200, 6096000, 4064000)) ?? transform(0, 0, 1000, 1000),
      chart: chartFrom(body['chart']),
    });
    deck = added.presentation;
    shapeId = added.shape_id;
    steps.push({ op: 'insert_chart', ok: true, shape_id: shapeId });
  } catch (error) {
    return domainFailure('charts.insert', error);
  }

  const ops = body['ops'];
  const slideId = asInteger(body['slide_id']) ?? 1;
  if (ops !== undefined) {
    if (!Array.isArray(ops)) return fail(400, 'invalid_ops', 'ops 必须是数组');
    for (const [index, raw] of ops.entries()) {
      if (!isRecord(raw)) return fail(400, 'invalid_ops', `ops[${String(index)}] 不是对象`, { steps });
      const op = asString(raw['op']);
      try {
        switch (op) {
          case 'set_data': {
            const categories = raw['categories'];
            const series = raw['series'];
            if (!Array.isArray(categories) || !Array.isArray(series)) {
              return fail(400, 'invalid_ops', `ops[${String(index)}] 的 set_data 需要 categories 与 series`, { steps });
            }
            deck = setChartData(deck, slideId, shapeId, {
              categories: categories.map((entry) => String(entry)),
              series: series.map((entry) => {
                if (!isRecord(entry) || !Array.isArray(entry['values'])) {
                  throw new Error('series 每一项需要 name 与 values');
                }
                return { name: String(entry['name'] ?? ''), values: entry['values'].map((number_) => Number(number_)) };
              }),
            });
            break;
          }
          case 'set_title':
            deck = setChartTitle(deck, slideId, shapeId, asString(raw['text']));
            break;
          case 'set_type':
            deck = setChartType(deck, slideId, shapeId, String(raw['chart_type']) as ChartModel['chart_type']);
            break;
          default:
            return fail(400, 'invalid_ops', `ops[${String(index)}] 只支持 set_data / set_title / set_type`);
        }
        steps.push({ op, ok: true });
      } catch (error) {
        return opFailure(`charts.ops[${String(index)}]`, error, { steps });
      }
    }
  }

  let built;
  try {
    built = renderPresentation(deck);
  } catch (error) {
    return domainFailure('charts.render', error);
  }

  return ok(200, {
    ok: true,
    steps,
    pptx: pptxView(built.bytes, built.slide_count, built.entry_count, built.content_digest),
    chart: { shape_id: shapeId, slide_id: slideId },
    unverified: PPT_MEDIA_UNVERIFIED,
  });
}

// ---------------------------------------------------------------------------
// POST /av —— PPT-12：受控引用的事实判定（**不渲染**）
// ---------------------------------------------------------------------------

function permissionsFrom(value: unknown): AvMediaPermissions {
  if (value === undefined) return DEFAULT_AV_MEDIA_PERMISSIONS;
  if (!isRecord(value)) return NO_AV_MEDIA_PERMISSIONS;
  const embed = value['allow_embed'];
  const link = value['allow_link'];
  const autoplay = value['allow_autoplay'];
  if (embed === false && link === false && autoplay === false) return NO_AV_MEDIA_PERMISSIONS;
  return Object.freeze({
    allow_embed: embed !== false,
    allow_link: link !== false,
    allow_autoplay: autoplay !== false,
  });
}

function handleAv(body: Record<string, unknown>): PptxMediaWireResponse {
  const itemsRaw = body['items'];
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) return fail(400, 'invalid_items', '缺少 items（非空数组）');
  const permissions = permissionsFrom(body['permissions']);

  let catalog: MediaCatalog;
  try {
    catalog = catalogFrom(body['parts']);
  } catch (error) {
    return fail(400, 'invalid_body', describe(error));
  }

  const items: AvMediaItem[] = [];
  const decisions: Record<string, unknown>[] = [];
  for (const [index, raw] of itemsRaw.entries()) {
    if (!isRecord(raw)) return fail(400, 'invalid_items', `items[${String(index)}] 不是对象`);
    const mediaPath = asString(raw['media_path']);
    if (mediaPath === null) return fail(400, 'invalid_items', `items[${String(index)}] 缺少 media_path`);
    const base64 = raw['base64'];
    const bytes = base64 === undefined ? undefined : decodeBase64Strict(String(base64));
    if (base64 !== undefined && bytes === null) {
      return fail(400, 'invalid_items', `items[${String(index)}] 的 base64 不合法`);
    }
    const external = raw['external'] === true;
    const autoplay = isRecord(raw['playback']) && raw['playback']['autoplay'] === true;

    // **权限有明确结果**：不允许 ⇒ 409，带具名 reason —— 不静默降级成另一种处理。
    const decision = checkAvMediaPermission(
      { bytes: bytes ?? null, external, playback: autoplay ? { autoplay: true } : {} },
      permissions,
    );
    decisions.push({ index, media_path: mediaPath, ...decision });
    if (!decision.allowed) {
      return fail(409, 'av_permission_denied', decision.detail, {
        stage: `av.items[${String(index)}]`,
        reason: decision.reason,
        decisions,
      });
    }

    if (bytes !== undefined && bytes !== null) {
      // 真有字节 ⇒ 放进目录（`resolveAvMedia` 随后读回判定 embedded 事实）。
      catalog = mediaCatalog([...catalog.parts.map((part) => ({ path: part.path, bytes: part.bytes })), { path: mediaPath, bytes }]);
    }
    const declaredRaw = asString(raw['declared']);
    // `declared` 是**声明**（事实由 `resolveAvMedia` 读回判定）：显式给就用给的，
    // 没给则"有字节 ⇒ 声明嵌入 / 没字节 ⇒ 声明外链"。声明嵌入但无部件 ⇒ 正是要抓的假称。
    const declared: 'embedded' | 'linked' =
      declaredRaw === 'embedded' ? 'embedded' : declaredRaw === 'linked' ? 'linked' : bytes === undefined ? 'linked' : 'embedded';
    items.push({
      media_id: asString(raw['media_id']) ?? `media-${String(index + 1)}`,
      slide_id: asInteger(raw['slide_id']) ?? 1,
      shape_id: asInteger(raw['shape_id']) ?? 10 + index,
      media_path: mediaPath,
      kind: mediaPath.toLowerCase().endsWith('.mp3') || mediaPath.toLowerCase().endsWith('.m4a') || mediaPath.toLowerCase().endsWith('.wav') ? 'audio' : 'video',
      declared,
      cover: null,
      playback: avPlayback(autoplay ? { autoplay: true } : {}),
      alt_text: asString(raw['alt_text']) ?? '',
    });
  }

  let board;
  let audit;
  try {
    board = avMediaBoard(items);
    audit = auditAvMedia(emptyPresentation('av-deck', '音视频审计'), board, catalog);
  } catch (error) {
    return domainFailure('av.audit', error);
  }

  return ok(200, {
    ok: true,
    decisions,
    audit: {
      resolutions: audit.resolutions.map((resolution) => ({
        media_id: resolution.media_id,
        media_path: resolution.media_path,
        declared: resolution.declared,
        embedded: resolution.embedded,
        link_status: resolution.link_status,
        link_liveness_verified: resolution.link_liveness_verified,
        problem: resolution.problem,
      })),
      broken: audit.broken.map((resolution) => resolution.media_id),
      false_embed_claims: audit.false_embed_claims.map((resolution) => resolution.media_id),
      orphan_media_paths: audit.orphan_media_paths,
    },
    render_supported: false,
    render_refusal:
      'renderPresentation 对 media 形状显式抛 unsupported_shape_kind（音视频渲染未实现）——本端点因此只给"是否真嵌入"的事实判定，不产出 PPTX。',
    unverified: PPT_MEDIA_UNVERIFIED,
  });
}

// ---------------------------------------------------------------------------
// POST /verify —— 读回校验（本仓判据；用例另带独立 ZIP 解析器）
// ---------------------------------------------------------------------------

function handleVerify(body: Record<string, unknown>): PptxMediaWireResponse {
  const kind = asString(body['kind']);
  if (kind === 'media') {
    const base64 = asString(body['pptx_base64']);
    if (base64 === null) return fail(400, 'invalid_body', 'kind=media 需要 pptx_base64');
    const bytes = decodeBase64Strict(base64);
    if (bytes === null) return fail(400, 'invalid_body', 'pptx_base64 不合法');
    try {
      const report = verifyMediaPairingInPackage(bytes);
      return ok(200, { ok: true, kind, report });
    } catch (error) {
      return domainFailure('verify.media', error);
    }
  }
  if (kind === 'chart') {
    const base64 = asString(body['pptx_base64']);
    if (base64 === null) return fail(400, 'invalid_body', 'kind=chart 需要 pptx_base64');
    const bytes = decodeBase64Strict(base64);
    if (bytes === null) return fail(400, 'invalid_body', 'pptx_base64 不合法');
    try {
      const report = verifyChartPackage(bytes);
      return ok(200, { ok: true, kind, report });
    } catch (error) {
      return domainFailure('verify.chart', error);
    }
  }
  if (kind === 'slide_bitmap') {
    const slideXml = asString(body['slide_xml']);
    const size = body['size'];
    if (slideXml === null || !isRecord(size)) {
      return fail(400, 'invalid_body', 'kind=slide_bitmap 需要 slide_xml 与 size{cx_emu,cy_emu}');
    }
    const cx = asInteger(size['cx_emu']);
    const cy = asInteger(size['cy_emu']);
    if (cx === null || cy === null) return fail(400, 'invalid_body', 'size 需要整数 cx_emu / cy_emu');
    try {
      assertNoFullPageBitmap(slideXml, { cx_emu: cx, cy_emu: cy });
      return ok(200, { ok: true, kind, page_screenshot: false });
    } catch (error) {
      return domainFailure('verify.slide_bitmap', error);
    }
  }
  return fail(400, 'invalid_kind', 'kind 只支持 media / chart / slide_bitmap');
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

function dispatch(request: { readonly method: string; readonly pathname: string; readonly body: unknown }): PptxMediaWireResponse {
  const { method, pathname } = request;
  if (pathname === `${PPT_MEDIA_ROOT}/status`) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', '该接口只接受 GET');
    return ok(200, {
      ok: true,
      root: PPT_MEDIA_ROOT,
      routes: PPT_MEDIA_ROUTES,
      explicit_refusals: PPT_MEDIA_EXPLICIT_REFUSALS,
      unverified: PPT_MEDIA_UNVERIFIED,
      mounted_in_product_host: true,
      mount_note:
        '本路由**已**挂进 apps/demo/server/http.ts（FA-PPT-MEDIA-MOUNT：在 `/api/**` 兜底 404 之前' +
        '按前缀转交，只做加法）：main.js 上命中 /api/ppt-media/** 由本模块作答。' +
        '本模块零端口、零落盘（每个请求自带全部输入），因此不存在"端口缺席 ⇒ 未就绪"分支。',
    });
  }

  const bodies: Readonly<Record<string, (body: Record<string, unknown>) => PptxMediaWireResponse>> = {
    [`${PPT_MEDIA_ROOT}/pictures`]: handlePictures,
    [`${PPT_MEDIA_ROOT}/shapes`]: handleShapes,
    [`${PPT_MEDIA_ROOT}/tables`]: handleTables,
    [`${PPT_MEDIA_ROOT}/charts`]: handleCharts,
    [`${PPT_MEDIA_ROOT}/av`]: handleAv,
    [`${PPT_MEDIA_ROOT}/verify`]: handleVerify,
  };
  const handler = bodies[pathname];
  if (handler === undefined) return fail(404, 'not_found', `没有这个路由：${pathname}`);
  if (method !== 'POST') return fail(405, 'method_not_allowed', '该接口只接受 POST');
  if (!isRecord(request.body)) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  return handler(request.body);
}

/** 进程内直调（路由级断言用；不需要真 socket）。 */
export function routePptxMediaRequest(request: PptxMediaWireRequest): PptxMediaWireResponse {
  if (request.pathname !== PPT_MEDIA_ROOT && !request.pathname.startsWith(`${PPT_MEDIA_ROOT}/`)) {
    return fail(404, 'not_found', '不是本前缀');
  }
  return dispatch(request);
}

// ---------------------------------------------------------------------------
// 真 node:http 挂载
// ---------------------------------------------------------------------------

type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly too_large: boolean };

async function readBody(req: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return { ok: false, too_large: true };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, too_large: false };
  }
}

function sendJson(res: ServerResponse, response: PptxMediaWireResponse): void {
  const text = `${JSON.stringify(response.body)}\n`;
  res.writeHead(response.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * 真 HTTP 处理器。返回 `true` = 本模块接管了该请求。
 *
 * 与 `handlePptxFactsRequest` 同契约：非本前缀一律返回 `false`，让上层既有分支继续。
 */
export async function handlePptxMediaRequest(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
}): Promise<boolean> {
  const { req, res, url } = input;
  if (!url.pathname.startsWith(PPT_MEDIA_ROOT)) return false;
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    sendJson(res, dispatch({ method, pathname: url.pathname, body: null }));
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, fail(405, 'method_not_allowed', '该接口只接受 GET / POST'));
    return true;
  }
  const parsed = await readBody(req);
  if (!parsed.ok) {
    sendJson(
      res,
      parsed.too_large
        ? fail(413, 'body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`)
        : fail(400, 'invalid_json', '请求体不是合法 JSON'),
    );
    return true;
  }
  sendJson(res, dispatch({ method, pathname: url.pathname, body: parsed.value }));
  return true;
}
