/**
 * **图形工作流**（WF 文档工作流的"图片与图形"操作面）。
 *
 * ## 这一层是什么、不是什么
 *
 * 它是 `operations/drawing/**`（WF-065–070 的实现层）之上的**一层薄操作面**：
 * 把"用户/上层想做的图形事"归成一组意图级入口（插入 / 替换 / 删除、尺寸与位置、
 * 环绕方式、裁剪、题注与交叉引用目标），并在每次改动**之后**跑一遍
 * **媒体部件与关系成对**的检查。
 *
 * | 层 | 文件 | 职责 |
 * |---|---|---|
 * | 实现层 | `operations/drawing/**` | 逐能力的纯计算 + 结构化拒绝 |
 * | **本层** | `image-workflow.ts` | 意图级入口 + **r:embed ⇄ 媒体部件配对**（双向）+ 题注/交叉引用目标 |
 * | 消费层 | 上层 | 决定"要不要写进文件""要不要回显" |
 *
 * ## "媒体部件与关系成对"是怎么被**断言**的（双向）
 *
 * `checkPicturePairing` 两个方向都查，**缺任一半都报**：
 *
 * | 方向 | 现象 | 报什么 |
 * |---|---|---|
 * | 引用 → 部件 | 正文里 `r:embed` / `DrawingNode.relationship_id` 指不到关系 | `dangling_reference` |
 * | 引用 → 部件 | 关系在，但它指向的部件既不在 `media[]` 也不在 `opaque_parts` | `reference_without_media` |
 * | **部件 → 引用（反之亦然）** | `media[]` 里有字节，但**正文里没有任何片段引用它** | `orphan_media` |
 * | 配对 | `media[]` 绑的 rId 不在关系表 / 媒体没有内容类型声明 | `media_without_relationship` / `content_type_missing` |
 *
 * **本层相对包级检查的增量**（诚实登记）：`operations/drawing/media.ts` 的
 * `checkMediaIntegrity` 只扫 `opaque` 里的 `r:embed` 片段，**看不见类型化 `DrawingNode`**
 * （`insertImageDrawing` 产出的那种），也不查"有部件没引用"。本层把这两点补齐，并复用它的
 * 包级判据（媒体 / 关系 / 内容类型）——两边口径一致，不各说各话。
 *
 * ## 改动后为什么用"回归"而不是"绝对干净"
 *
 * 导入来的文档本身可能就带着悬空引用（残缺的源文件）。若每次编辑都要求"整篇绝对干净"，
 * 就会把"本来坏的文档"变成"一个字都改不了"。因此本层断言的是**回归**：
 * 这次操作**不得引入新的**配对问题（`pairingRegressions`）；旧问题照原样留在报告里
 * （`checkPicturePairing` 随时可查），**不掩盖、不顺手清掉**（R110/R105）。
 *
 * ## 未验证的部分（**不得当作已验证**）
 *
 * - 渲染效果（Word 里长得对不对）**未验证（需消费端）**——本机无 Word 授权、真机未连接；
 * - **题注编号未计算**：写入 `SEQ` 域指令 ≠ 已算出编号（R158），`refresh_state` 恒为 `'unknown'`；
 * - **交叉引用不解析**：写入 `REF` 域指令、登记目标书签，都只是"把引用/目标摆好"，
 *   域结果需要消费端刷新。
 *
 * ## 交付说明（身份标注，不得省略）
 *
 * 工作包 **FA-DOC-WF-TABLES**（分支 `fa/doc-wf-tables`）。
 * **子智能体模型身份未确认为 DS**；本文件由该子智能体产出，未经 DS 身份确认。
 */

import { DocumentModelError } from './model/errors.js';
import { createNodeIdAllocator, nodePathSegment, parseNodeId, withSegment, type NodePath } from './model/ids.js';
import { insertAt } from './model/immutable.js';
import { collectNodeIds, findNodeById, replaceBlockInModel } from './model/walk.js';
import { findContentType, resolveRelationshipTarget } from './model/preservation.js';
import type {
  BlockNode,
  DocumentModel,
  DrawingNode,
  FieldNode,
  Length,
  NodeId,
  ParagraphNode,
  SourceKind,
} from './model/types.js';
import {
  checkMediaIntegrity,
  deleteImage,
  existingPartPaths,
  findDrawings,
  insertImage,
  insertImageDrawing,
  insertShape,
  mainDocumentPartPath,
  referencedRelationshipIds,
  replaceImage,
  runDrawingEdit,
  setAltText,
  setCaption,
  setImageCrop,
  setImageRotation,
  setImageSize,
  setImageWrap,
  type AnchorSpec,
  type CropRect,
  type DrawingOutcome,
  type DrawingParams,
  type DrawingRef,
  type InsertImageDrawingRequest,
  type InsertImageRequest,
  type InsertShapeRequest,
  type MediaIntegrityProblem,
  type WrapMode,
} from './operations/drawing/index.js';
import { addBookmark } from './references/bookmarks.js';
import { emptyReferenceIndex, type ReferenceIndex } from './references/types.js';
import { fail, succeed, type DocumentRange, type Result } from './selection/types.js';

// ---------------------------------------------------------------------------
// 能力清单（机器可判）
// ---------------------------------------------------------------------------

/** 图形工作流的一项能力。 */
export interface ImageWorkflowCapability {
  readonly id: string;
  readonly label: string;
  /** 参数是否**端到端**（写进模型且导出器消费）。`false` ≠ "无入口"。 */
  readonly wired: boolean;
  readonly exposed: boolean;
  readonly note: string;
}

const RENDER_UNVERIFIED = '渲染效果未验证（需消费端；本机无 Word 授权、真机未连接）';
const NUMBERING_UNVERIFIED = '题注编号未计算（写域指令 ≠ 已算出编号，R158）';

/** 图形能力清单（WF-065–070）。 */
export const IMAGE_WORKFLOW_CAPABILITIES: readonly ImageWorkflowCapability[] = Object.freeze([
  {
    id: 'image.insert',
    label: '插入图片（片段表示法）',
    wired: true,
    exposed: true,
    note: `WF-065；同时装配媒体部件 + 关系 + 内容类型（r:embed 不悬空）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.insert.node',
    label: '插入图片（类型化 DrawingNode 表示法）',
    wired: true,
    exposed: true,
    note:
      'WF-065；产出 DrawingNode，导出器按 renderDrawingNode 重建 w:drawing。' +
      '**与片段表示法互不通用**：参数编辑类操作只认片段表示法（见 image.ts 文件头）。' +
      `${RENDER_UNVERIFIED}`,
  },
  {
    id: 'shape.insert',
    label: '插入文本框 / 形状',
    wired: true,
    exposed: true,
    note: `WF-070；形状不带关系引用（不涉及媒体配对）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.replace',
    label: '替换图片',
    wired: true,
    exposed: true,
    note: `WF-065；换媒体与关系，位置与参数保持；旧媒体与旧关系一起清理。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.delete',
    label: '删除图片',
    wired: true,
    exposed: true,
    note: `WF-065；片段 + 包级三件套一起删；不认识的图形默认拒删（避免孤儿部件）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.size',
    label: '图片尺寸',
    wired: true,
    exposed: true,
    note: `WF-066；保持纵横比时用"当前显示尺寸"的比值（原图像素尺寸不在模型里）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.rotate',
    label: '图片旋转',
    wired: true,
    exposed: true,
    note: `WF-066；负角按 OOXML 0–21600000 周期归一化。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.position',
    label: '位置（行内 / 浮动）',
    wired: true,
    exposed: true,
    note: `WF-068；行内 = wp:inline，浮动 = wp:anchor + 锚点框与偏移。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.wrap',
    label: '环绕方式',
    wired: true,
    exposed: true,
    note: `WF-068；square / topAndBottom / inFront / behind。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.crop',
    label: '裁剪',
    wired: true,
    exposed: true,
    note: `WF-067；只写 a:srcRect，**媒体字节一个字节都不动**。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.alt_text',
    label: '替代文字（可及性）',
    wired: true,
    exposed: true,
    note: `WF-069。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.caption',
    label: '题注',
    wired: true,
    exposed: true,
    note: `WF-069；写 SEQ 域指令并给出目标描述符。${NUMBERING_UNVERIFIED}；${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.crossref.target',
    label: '交叉引用目标（题注书签 + REF 域）',
    wired: true,
    exposed: true,
    note:
      'WF-075/076；登记目标书签（references 侧表）+ 写 REF 域指令。' +
      `域结果需消费端刷新才能解析——**未验证**；${RENDER_UNVERIFIED}`,
  },
  {
    id: 'image.media.pairing',
    label: '媒体部件与关系成对（双向检查）',
    wired: true,
    exposed: true,
    note: 'r:embed ⇄ 媒体部件双向检查；正文片段与类型化 DrawingNode 都算引用来源。',
  },
]);

// ---------------------------------------------------------------------------
// 配对检查（双向）
// ---------------------------------------------------------------------------

/** 配对问题的种类（可机械分支）。 */
export type PicturePairingProblemKind =
  | 'dangling_reference'
  | 'reference_without_media'
  | 'orphan_media'
  | 'media_without_relationship'
  | 'content_type_missing';

/** 一项配对问题。 */
export interface PicturePairingProblem {
  readonly kind: PicturePairingProblemKind;
  readonly detail: string;
  readonly relationship_id: string | null;
  readonly part_path: string | null;
}

/** 把包级完整性检查的结果映射到本层的词汇表（口径一致，不各说各话）。 */
function fromIntegrity(problem: MediaIntegrityProblem): PicturePairingProblem {
  const base = {
    relationship_id: problem.relationship_id ?? null,
    part_path: problem.part_path ?? null,
    detail: problem.detail,
  };
  switch (problem.kind) {
    case 'dangling_r_embed':
      return { kind: 'dangling_reference', ...base };
    case 'media_without_relationship':
      return { kind: 'media_without_relationship', ...base };
    case 'content_type_missing':
      return { kind: 'content_type_missing', ...base };
    case 'relationship_target_missing':
    case 'orphan_media_relationship':
      return { kind: 'reference_without_media', ...base };
  }
}

/** 遍历所有块（含表格、嵌套表），对每个块/行/单元格/行内节点调一次回调。 */
function visitEveryNode(
  model: DocumentModel,
  visit: {
    readonly paragraph?: (paragraph: ParagraphNode) => void;
    readonly drawing?: (drawing: DrawingNode, owner: ParagraphNode) => void;
  },
): void {
  const visitBlocks = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        visit.paragraph?.(block);
        for (const inline of block.inlines) {
          if (inline.kind === 'drawing') {
            visit.drawing?.(inline, block);
          }
        }
        continue;
      }
      for (const row of block.rows) {
        for (const cell of row.cells) {
          visitBlocks(cell.blocks);
        }
      }
    }
  };
  visitBlocks(model.blocks);
}

/** 文档里全部**类型化** `DrawingNode`（不含片段表示法）。 */
export function typedDrawings(
  model: DocumentModel,
): readonly { readonly drawing: DrawingNode; readonly paragraph: ParagraphNode }[] {
  const found: { drawing: DrawingNode; paragraph: ParagraphNode }[] = [];
  visitEveryNode(model, {
    drawing: (drawing, paragraph) => {
      found.push({ drawing, paragraph });
    },
  });
  return found;
}

/**
 * 正文里**全部**图形引用（`r:embed` 等片段引用 + 类型化 `DrawingNode.relationship_id`）。
 *
 * 这是"反之亦然"那一半的判据来源：一个媒体部件若不在这个集合里，就是**没人引用的孤儿**。
 */
export function pictureReferenceIds(model: DocumentModel): ReadonlySet<string> {
  const ids = new Set<string>(referencedRelationshipIds(model));
  for (const { drawing } of typedDrawings(model)) {
    const id = drawing.relationship_id;
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
  }
  return ids;
}

function pairingKey(problem: PicturePairingProblem): string {
  return `${problem.kind}|${problem.relationship_id ?? ''}|${problem.part_path ?? ''}`;
}

/**
 * 检查"媒体部件与关系成对"（**双向、只读、可独立复算**）。
 *
 * 见文件头的两个方向表。**不抛**——调用方据此决定是拒绝还是仅记录。
 */
export function checkPicturePairing(model: DocumentModel): readonly PicturePairingProblem[] {
  const problems: PicturePairingProblem[] = [];
  const seen = new Set<string>();
  const push = (problem: PicturePairingProblem): void => {
    const key = pairingKey(problem);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    problems.push(problem);
  };

  // 1) 包级判据（媒体 / 关系 / 内容类型）——与既有完整性检查同源。
  for (const problem of checkMediaIntegrity(model)) {
    push(fromIntegrity(problem));
  }

  // 2) 扩展：类型化 DrawingNode 的引用（包级检查只看 opaque 片段，看不见它们）。
  const byId = new Map(model.relationships.map((record) => [record.id, record]));
  const parts = existingPartPaths(model);
  for (const { drawing } of typedDrawings(model)) {
    const id = drawing.relationship_id;
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    const record = byId.get(id);
    if (record === undefined) {
      push({
        kind: 'dangling_reference',
        relationship_id: id,
        part_path: null,
        detail: `类型化图形节点 ${JSON.stringify(drawing.id)} 引用的关系 ${id} 不存在（悬空引用）`,
      });
      continue;
    }
    if (record.target_mode === 'Internal') {
      let resolved: string | null = null;
      try {
        resolved = resolveRelationshipTarget(record.owner_part_path, record.target);
      } catch {
        resolved = null;
      }
      if (resolved === null || !parts.has(resolved)) {
        push({
          kind: 'reference_without_media',
          relationship_id: id,
          part_path: resolved,
          detail: `类型化图形节点 ${JSON.stringify(drawing.id)} 的关系 ${id} 指向的部件 ${String(
            resolved,
          )} 不在媒体/不透明部件里`,
        });
      }
    }
  }

  // 3) 反之亦然：媒体部件存在，但正文里**没有任何**引用指着它。
  const referenced = pictureReferenceIds(model);
  for (const part of model.media) {
    if (!referenced.has(part.relationship_id)) {
      push({
        kind: 'orphan_media',
        relationship_id: part.relationship_id,
        part_path: part.path,
        detail: `媒体部件 ${part.path}（关系 ${part.relationship_id}）没有任何正文引用——是孤儿部件`,
      });
    }
    if (findContentType(model.content_types, part.path) === null) {
      push({
        kind: 'content_type_missing',
        relationship_id: part.relationship_id,
        part_path: part.path,
        detail: `媒体部件 ${part.path} 没有内容类型声明`,
      });
    }
  }

  return problems;
}

/** 断言配对完好：有问题即抛（结构化，含**第一条**问题的具体位置）。 */
export function assertPicturePairing(model: DocumentModel): void {
  const problems = checkPicturePairing(model);
  const first = problems[0];
  if (first === undefined) {
    return;
  }
  throw new DocumentModelError(
    'media_relationship_mismatch',
    `媒体配对检查失败（共 ${String(problems.length)} 项）：${first.kind}：${first.detail}`,
  );
}

/** 这次操作**新引入**的配对问题（旧问题不算——理由见文件头）。 */
export function pairingRegressions(
  before: DocumentModel,
  after: DocumentModel,
): readonly PicturePairingProblem[] {
  const prior = new Set(checkPicturePairing(before).map(pairingKey));
  return checkPicturePairing(after).filter((problem) => !prior.has(pairingKey(problem)));
}

/** 解包成功分支；失败即抛（由 `runDrawingEdit` 再转回失败分支）。 */
function unwrap<T extends object>(outcome: DrawingOutcome<T>): T {
  if (!outcome.ok) {
    throw new DocumentModelError(outcome.code, outcome.detail);
  }
  return outcome;
}

/** 改动后断言"没有引入新的配对问题"，否则整条操作失败（失败分支不带 model）。 */
function guardPairing<Payload extends { readonly model: DocumentModel }>(
  before: DocumentModel,
  payload: Payload,
): Payload {
  const regressions = pairingRegressions(before, payload.model);
  const first = regressions[0];
  if (first !== undefined) {
    throw new DocumentModelError(
      'media_relationship_mismatch',
      `该操作引入了新的悬空/孤儿引用（实现缺陷，不是用户输入问题）：${first.detail}`,
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// WF-065 插入 / 替换 / 删除
// ---------------------------------------------------------------------------

/** 插入图片的结果（片段表示法）。 */
export interface InsertPictureSuccess {
  readonly model: DocumentModel;
  readonly run_id: NodeId;
  readonly relationship_id: string;
  readonly part_path: string;
  readonly doc_pr_id: number;
  /** 造出的 `w:drawing` 文本（**形状证据**；进文件的是 run.opaque 里的那段片段）。 */
  readonly xml: string;
  /** **恒为 `true`**：媒体部件 + 关系 + 内容类型一次装配，r:embed 不悬空。 */
  readonly pairing_ok: true;
  readonly note: string;
}

/** 插入图片（WF-065，**片段表示法**）。包级三件套 + run 里的 `w:drawing` 一次到位。 */
export function insertPicture(
  model: DocumentModel,
  request: InsertImageRequest,
): DrawingOutcome<InsertPictureSuccess> {
  return runDrawingEdit(() => {
    const success = unwrap(insertImage(model, request));
    return guardPairing(model, {
      model: success.model,
      run_id: success.run_id,
      relationship_id: success.relationship_id,
      part_path: success.part_path,
      doc_pr_id: success.doc_pr_id,
      xml: success.xml,
      pairing_ok: true as const,
      note: `媒体部件 ${success.part_path} 已注册，关系 ${success.relationship_id} 指向它。${RENDER_UNVERIFIED}`,
    });
  });
}

/** 插入图片的结果（类型化节点表示法）。 */
export interface InsertPictureNodeSuccess {
  readonly model: DocumentModel;
  readonly node_id: NodeId;
  readonly relationship_id: string;
  readonly part_path: string;
  readonly pairing_ok: true;
  readonly note: string;
}

/** 插入图片（WF-065，**类型化 `DrawingNode` 表示法**）。 */
export function insertPictureNode(
  model: DocumentModel,
  request: InsertImageDrawingRequest,
): DrawingOutcome<InsertPictureNodeSuccess> {
  return runDrawingEdit(() => {
    const success = unwrap(insertImageDrawing(model, request));
    return guardPairing(model, {
      model: success.model,
      node_id: success.node_id,
      relationship_id: success.relationship_id,
      part_path: success.part_path,
      pairing_ok: true as const,
      note: `类型化图形节点 ${JSON.stringify(success.node_id)} 引用 ${success.relationship_id}。${RENDER_UNVERIFIED}`,
    });
  });
}

/** 插入文本框 / 形状（WF-070）。形状不带关系引用，不涉及媒体配对。 */
export function insertTextBoxOrShape(
  model: DocumentModel,
  request: InsertShapeRequest,
): DrawingOutcome<{ readonly model: DocumentModel; readonly run_id: NodeId; readonly doc_pr_id: number; readonly xml: string }> {
  return runDrawingEdit(() => {
    const success = unwrap(insertShape(model, request));
    return guardPairing(model, {
      model: success.model,
      run_id: success.run_id,
      doc_pr_id: success.doc_pr_id,
      xml: success.xml,
    });
  });
}

/** 替换图片（WF-065）：换媒体与关系，位置与参数保持；旧媒体与旧关系一起清理。 */
export function replacePicture(
  model: DocumentModel,
  request: {
    readonly run_id: NodeId;
    readonly opaque_index?: number;
    readonly bytes: Uint8Array;
    readonly content_type: string;
  },
): DrawingOutcome<{ readonly model: DocumentModel; readonly relationship_id: string; readonly part_path: string; readonly pairing_ok: true }> {
  return runDrawingEdit(() => {
    const success = unwrap(replaceImage(model, request));
    return guardPairing(model, {
      model: success.model,
      relationship_id: success.relationship_id,
      part_path: success.part_path,
      pairing_ok: true as const,
    });
  });
}

/** 删除图片（WF-065）：片段 + 包级三件套一起删。 */
export function deletePicture(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly allow_unknown?: boolean },
): DrawingOutcome<{
  readonly model: DocumentModel;
  readonly removed_run: boolean;
  readonly removed_part_path: string | null;
  readonly pairing_ok: true;
}> {
  return runDrawingEdit(() => {
    const success = unwrap(deleteImage(model, request));
    return guardPairing(model, {
      model: success.model,
      removed_run: success.removed_run,
      removed_part_path: success.removed_part_path,
      pairing_ok: true as const,
    });
  });
}

// ---------------------------------------------------------------------------
// WF-066–069 尺寸 / 旋转 / 位置 / 环绕 / 裁剪 / 替代文字
// ---------------------------------------------------------------------------

/** 参数类操作的结果。 */
export interface PictureParamsSuccess {
  readonly model: DocumentModel;
  /** 回读自己写出去的 XML 得到的权威参数（不是"我打算写什么"）。 */
  readonly params: DrawingParams | null;
  readonly xml: string;
  readonly pairing_ok: true;
}

function paramsOutcome(
  before: DocumentModel,
  outcome: DrawingOutcome<{ readonly model: DocumentModel; readonly params: DrawingParams; readonly xml: string }>,
): DrawingOutcome<PictureParamsSuccess> {
  return runDrawingEdit(() => {
    const success = unwrap(outcome);
    return guardPairing(before, {
      model: success.model,
      params: success.params,
      xml: success.xml,
      pairing_ok: true as const,
    });
  });
}

/** 设置图片显示尺寸（WF-066）。 */
export function resizePicture(
  model: DocumentModel,
  request: {
    readonly run_id: NodeId;
    readonly opaque_index?: number;
    readonly width?: Length;
    readonly height?: Length;
    readonly keep_aspect_ratio?: boolean;
  },
): DrawingOutcome<PictureParamsSuccess> {
  return paramsOutcome(model, setImageSize(model, request));
}

/** 设置图片旋转角（WF-066）。 */
export function rotatePicture(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly degrees: number },
): DrawingOutcome<PictureParamsSuccess> {
  return paramsOutcome(model, setImageRotation(model, request));
}

/** 设置图片裁剪（WF-067）；**只写 `a:srcRect`**，媒体字节不动。 */
export function cropPicture(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly crop: CropRect },
): DrawingOutcome<PictureParamsSuccess> {
  return paramsOutcome(model, setImageCrop(model, request));
}

/**
 * 放置图片（WF-068）：`inline`（嵌入正文，随文字流动）或 `floating`（浮动 + 环绕 + 锚点）。
 *
 * `floating` 未给环绕方式时默认 `square`（四周环绕）——这是 Word 里"浮动图片"的常见形态；
 * 要精确控制请显式传 `wrap`。
 */
export function placePicture(
  model: DocumentModel,
  request: {
    readonly run_id: NodeId;
    readonly opaque_index?: number;
    readonly placement: 'inline' | 'floating';
    readonly wrap?: WrapMode;
    readonly anchor?: AnchorSpec;
  },
): DrawingOutcome<PictureParamsSuccess> {
  const wrap: WrapMode = request.placement === 'inline' ? 'inline' : (request.wrap ?? 'square');
  return paramsOutcome(
    model,
    setImageWrap(model, {
      run_id: request.run_id,
      ...(request.opaque_index === undefined ? {} : { opaque_index: request.opaque_index }),
      wrap,
      ...(request.anchor === undefined ? {} : { anchor: request.anchor }),
    }),
  );
}

/** 设置环绕方式（WF-068）。`inline` 会清掉锚点。 */
export function setPictureWrap(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly wrap: WrapMode; readonly anchor?: AnchorSpec },
): DrawingOutcome<PictureParamsSuccess> {
  return paramsOutcome(model, setImageWrap(model, request));
}

/** 设置替代文字（WF-069）。 */
export function setPictureAltText(
  model: DocumentModel,
  request: {
    readonly run_id: NodeId;
    readonly opaque_index?: number;
    readonly alt: { readonly name?: string; readonly description?: string; readonly title?: string | null };
  },
): DrawingOutcome<PictureParamsSuccess> {
  return paramsOutcome(model, setAltText(model, request));
}

// ---------------------------------------------------------------------------
// WF-069/075 题注与交叉引用目标
// ---------------------------------------------------------------------------

/** 题注目标描述符（交叉引用指向的"身份"，**不是**当时的文字）。 */
export interface CaptionTarget {
  readonly kind: 'caption';
  /** 题注所在段落 id——交叉引用存的就是它（目标文字改了，引用仍指向它）。 */
  readonly node_id: NodeId;
  readonly label: string;
  readonly field_instruction: string;
  /** 题注号是否已算出：**恒为 `'unknown'`**（只写了域指令，R158）。 */
  readonly refresh_state: 'unknown';
  readonly note: string;
}

/** 插入题注的结果。 */
export interface AddPictureCaptionSuccess {
  readonly model: DocumentModel;
  readonly caption_paragraph_id: NodeId;
  readonly label: string;
  readonly field_instruction: string;
  readonly refresh_state: 'unknown';
  readonly target: CaptionTarget;
  readonly note: string;
}

/**
 * 给图片所在段落**之后**插入一段题注（WF-069）。
 *
 * 题注号用 `SEQ <label> \* ARABIC` 域表达——**这只是指令**；本内核没有排版引擎，
 * 无法算真实编号，`refresh_state` 恒为 `'unknown'`。同时返回**交叉引用目标描述符**
 * （`target`），供 `registerCaptionTarget` / `insertCaptionReference` 使用。
 */
export function addPictureCaption(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly label?: string; readonly separator?: string; readonly text?: string },
): DrawingOutcome<AddPictureCaptionSuccess> {
  return runDrawingEdit(() => {
    const success = unwrap(setCaption(model, request));
    const label = request.label ?? '图';
    const target: CaptionTarget = {
      kind: 'caption',
      node_id: success.paragraph_id,
      label,
      field_instruction: success.field_instruction,
      refresh_state: 'unknown' as const,
      note: success.note,
    };
    return guardPairing(model, {
      model: success.model,
      caption_paragraph_id: success.paragraph_id,
      label,
      field_instruction: success.field_instruction,
      refresh_state: 'unknown' as const,
      target,
      note: success.note,
    });
  });
}

/** 题注目标存在性查询的结果（只读；**只回答"这个目标还在不在"**，不臆造标签/编号）。 */
export interface CaptionTargetLookup {
  readonly kind: 'caption';
  readonly node_id: NodeId;
  readonly usable: boolean;
  readonly detail: string;
}

/**
 * 查一个段落能不能当**交叉引用目标**（只读）。
 *
 * 目标被删 ⇒ `not_found`（**绝不沿用旧快照**，R112）。目标身份就是**段落 id 本身**——
 * 交叉引用存的是它，而不是题注当时的文字，因此题注改了字，引用仍不断链。
 */
export function captionTargetOf(model: DocumentModel, paragraphId: NodeId): Result<CaptionTargetLookup> {
  const node = findNodeById(model, paragraphId);
  if (node === null || node.kind !== 'paragraph') {
    return fail('not_found', `题注目标段落 ${JSON.stringify(paragraphId)} 不存在。`, {
      extra: { node_id: paragraphId },
    });
  }
  return succeed({
    kind: 'caption' as const,
    node_id: paragraphId,
    usable: true,
    detail: '该段落存在，可作为交叉引用目标（标签与编号以创建题注时写入的域指令为准）。',
  });
}

/** 登记题注目标（交叉引用目标）请求。 */
export interface RegisterCaptionTargetRequest {
  readonly bookmark_id: string;
  readonly bookmark_name: string;
  readonly caption_paragraph_id: NodeId;
  /** 书签覆盖的码位长度（题注段落文本长度；止为**开区间**）。 */
  readonly text_length: number;
  readonly hidden?: boolean;
}

/** 一个空的引用侧表（便利构造，供调用方起步用）。 */
export function newCaptionReferenceIndex(): ReferenceIndex {
  return emptyReferenceIndex();
}

/**
 * 把题注段落登记成一个**交叉引用目标**（书签，WF-071/075）。
 *
 * 目标是**书签 id/名字**而不是当时的文字：题注文字改了，引用仍指向它（不断链）；
 * 目标被删，解析返回 `not_found`（不伪造）。书签名必须唯一（重名会让 `w:anchor` 指不唯一）。
 */
export function registerCaptionTarget(
  model: DocumentModel,
  index: ReferenceIndex,
  request: RegisterCaptionTargetRequest,
): Result<ReferenceIndex> {
  const node = findNodeById(model, request.caption_paragraph_id);
  if (node === null || node.kind !== 'paragraph') {
    return fail('not_found', `题注目标段落 ${JSON.stringify(request.caption_paragraph_id)} 不存在，无法登记交叉引用目标。`, {
      extra: { node_id: request.caption_paragraph_id },
    });
  }
  const range: DocumentRange = {
    node_id: request.caption_paragraph_id,
    start: 0,
    end: request.text_length,
  };
  return addBookmark(index, {
    id: request.bookmark_id,
    name: request.bookmark_name,
    range,
    ...(request.hidden === undefined ? {} : { hidden: request.hidden }),
  });
}

/** 插入交叉引用（REF 域）请求。 */
export interface InsertCaptionReferenceRequest {
  readonly paragraph_id: NodeId;
  /** 目标书签名（`REF <名字> \h` 的 `w:anchor`）。 */
  readonly bookmark_name: string;
  /** 插到段落的第几个行内节点之前；省略 = 追加到末尾。 */
  readonly inline_index?: number;
  readonly source?: SourceKind;
}

/** 插入交叉引用（REF 域）的结果。 */
export interface InsertCaptionReferenceSuccess {
  readonly model: DocumentModel;
  readonly field_id: NodeId;
  readonly instruction: string;
  /** **恒为 `'unknown'`**：写了域指令 ≠ 域已刷新出结果（R158）。 */
  readonly refresh_state: 'unknown';
  readonly note: string;
}

/**
 * 往段落里插入一个**交叉引用域**（`REF <书签名>`，WF-075/076）。
 *
 * 域结果不解析（无排版/域引擎）：`cached_result` 留 `null`、`refresh_state` 标 `'unknown'`，
 * 结果里的 `note` 把这件事写清楚——不得把"写了域指令"说成"引用已完成"。
 */
export function insertCaptionReference(
  model: DocumentModel,
  request: InsertCaptionReferenceRequest,
): DrawingOutcome<InsertCaptionReferenceSuccess> {
  return runDrawingEdit(() => {
    const node = findNodeById(model, request.paragraph_id);
    if (node === null || node.kind !== 'paragraph') {
      throw new DocumentModelError(
        'unknown_node',
        `段落 ${JSON.stringify(request.paragraph_id)} 不存在（交叉引用只能插进段落）`,
      );
    }
    const name = request.bookmark_name.trim();
    if (name.length === 0) {
      throw new DocumentModelError('unsupported', '交叉引用的目标书签名不能为空');
    }
    const index = request.inline_index ?? node.inlines.length;
    if (!Number.isInteger(index) || index < 0 || index > node.inlines.length) {
      throw new DocumentModelError(
        'invalid_index',
        `行内插入位置越界：${String(index)}（该段共 ${String(node.inlines.length)} 个行内节点）`,
      );
    }
    const source: SourceKind = request.source ?? 'user_request';
    const instruction = `REF ${name} \\h`;
    const allocator = createNodeIdAllocator(collectNodeIds(model));
    const path: NodePath = withSegment(paragraphOwnPath(node.id), 'field', index);
    const field: FieldNode = {
      id: allocator.allocate(path),
      kind: 'field',
      source,
      opaque: [],
      instruction,
      cached_result: null,
      refresh_state: 'unknown',
    };
    const next: ParagraphNode = { ...node, inlines: insertAt(node.inlines, index, field) };
    return guardPairing(model, {
      model: replaceBlockInModel(model, node.id, next),
      field_id: field.id,
      instruction,
      refresh_state: 'unknown' as const,
      note: '已写入 REF 域指令；域结果需消费端刷新后才能解析（R158）——未刷新前标「未验证」。',
    });
  });
}

/** 段落自身的路径（从规范 id 反解；反解失败时退回合成路径）。 */
function paragraphOwnPath(paragraphId: NodeId): NodePath {
  return parseNodeId(paragraphId)?.path ?? [nodePathSegment('paragraph', 0)];
}

// ---------------------------------------------------------------------------
// 只读投影
// ---------------------------------------------------------------------------

/** 一段图形在文档里的投影（含配对状态）。 */
export interface PictureInfo {
  readonly run_id: NodeId;
  readonly paragraph_id: NodeId;
  readonly opaque_index: number;
  /** `picture` / `shape` / `unknown`（认不出的图形不猜种类）。 */
  readonly graphic_kind: string;
  readonly relationship_id: string | null;
  readonly media_part_path: string | null;
  readonly relationship_exists: boolean;
  /** 是否**认识的**图片片段（不认识的图形实现层一律拒绝改写）。 */
  readonly editable_as_picture: boolean;
}

/** 列出文档里的全部图形片段（只读；含认不出的图形，标出来而不是藏起来）。 */
export function listPictures(model: DocumentModel): readonly PictureInfo[] {
  const partsById = new Map(model.media.map((part) => [part.relationship_id, part.path]));
  const relationships = new Set(model.relationships.map((record) => record.id));
  const refs: readonly DrawingRef[] = findDrawings(model);
  return refs.map((ref) => {
    const relationshipId = ref.relationship_id;
    return {
      run_id: ref.run_id,
      paragraph_id: ref.paragraph_id,
      opaque_index: ref.opaque_index,
      graphic_kind: ref.params === null ? 'unknown' : ref.params.graphic_kind,
      relationship_id: relationshipId,
      media_part_path: relationshipId === null ? null : (partsById.get(relationshipId) ?? null),
      relationship_exists: relationshipId === null ? true : relationships.has(relationshipId),
      editable_as_picture: ref.params !== null && ref.params.graphic_kind === 'picture',
    };
  });
}

/** 主部件路径（只读；供上层核对媒体归属）。直接复用实现层的解析（不另抄一份口径）。 */
export function pictureMainPart(model: DocumentModel): string {
  return mainDocumentPartPath(model);
}
