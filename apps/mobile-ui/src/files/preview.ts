/**
 * F06 files —— 预览容器（「预览由业务插件返回」）。
 *
 * 本包是**通用容器**：Word / Excel / PPT 三条线把各自插件产出的**预览描述**交给这里
 * 统一承载，界面按描述渲染。F06 **自己不做渲染**、不解析文件格式、不读字节。
 *
 * 但预览必须可回指到**确切的那一版字节**——否则界面会出现「有预览」而内容对不上
 * 旧文件（甚至根本无字节）的假象。所以预览调 `attachPreview` 时：
 *   P1 目标 revision 必须在链上，且**该版带字节证据**；无字节 → `missing-bytes`，
 *      容器根本不进入 ready（`unavailable`）。
 *   P2 描述里的 `sourceDigest` 必须**逐字等于该版字节的摘要**——不等即 `preview-bytes-mismatch`。
 *      这是「无真实 bytes 不显示已生成」在预览上的延伸：预览绑的是那一份确切字节。
 *   P3 描述必须属于**同一文件**（`fileId`）与**同一 revision**，否则
 *      `cross-file-revision` / `preview-revision-mismatch`。
 *   P4 描述的 `producer` / `mime` / `renderParts` 形状由本包校验；形状不对 →
 *      `invalid-preview-descriptor`。
 *   P5 未接线的预览**不得**被当成可渲染：取描述时若没有描述，抛 `preview-not-attached`，
 *      不返回 null 让调用方自行猜测。
 */

import { hasBytes, isSha256Digest } from './bytes.js';
import { revisionAt } from './versions.js';
import { FileError, type FileEntry, type RevisionRecord } from './types.js';

/**
 * 业务插件给出的预览描述。**本包不解析其正确性**（插件声称渲染了哪些部件），
 * 只保证形状合法、且与真实字节摘要绑定（P2）。
 */
export interface PreviewDescriptor {
  readonly fileId: string;
  readonly revision: number;
  /** 产出预览的插件引用，例如 `word-plugin`；只存引用，不存任何密钥。 */
  readonly producer: string;
  /** 插件声明的预览 MIME。 */
  readonly mime: string;
  /** 必须等于该 revision 字节证据的摘要（P2）。 */
  readonly sourceDigest: string;
  /** 插件声称用到的渲染部件名（可空）。F06 不核对内容，只保证形状。 */
  readonly renderParts: readonly string[];
}

/** 无字节 / 未就绪：容器退化为 `unavailable`，永不携带描述（P1）。 */
export interface PreviewUnavailable {
  readonly state: 'unavailable';
  readonly revision: number;
  readonly descriptor: null;
}

/** 有字节、可承载预览；描述可未附（插件还没返回）。 */
export interface PreviewReady {
  readonly state: 'ready';
  readonly revision: number;
  readonly descriptor: PreviewDescriptor | null;
}

export type PreviewContainer = PreviewUnavailable | PreviewReady;

const PRODUCER = /^\S+$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;

function requireProducer(value: unknown): string {
  if (typeof value !== 'string' || !PRODUCER.test(value)) {
    throw new FileError('invalid-preview-descriptor', 'producer 必须是非空白字符串引用', {
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

function requireMime(value: unknown): string {
  if (typeof value !== 'string' || !MIME.test(value)) {
    throw new FileError('invalid-preview-descriptor', 'mime 形状非法', {
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

/** 渲染部件名：非空、去重；允许空数组（插件可能只返回页数等）。 */
export function requireRenderParts(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new FileError('invalid-preview-descriptor', 'renderParts 必须是数组');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new FileError('invalid-preview-descriptor', 'renderParts 元素必须是非空字符串');
    }
    const name = item.trim();
    if (seen.has(name)) {
      throw new FileError('invalid-preview-descriptor', `renderParts 出现重复部件名：${name}`);
    }
    seen.add(name);
    out.push(name);
  }
  return Object.freeze(out);
}

/**
 * 初始预览容器：目标版本有字节才 `ready`，否则 `unavailable`（P1）。
 * 版本不在链上抛 `unknown-revision`。
 */
export function initialPreviewContainer(entry: FileEntry, revision: number): PreviewContainer {
  const record = revisionAt(entry, revision);
  if (!hasBytes(record.bytes)) {
    return Object.freeze({ state: 'unavailable', revision, descriptor: null });
  }
  return Object.freeze({ state: 'ready', revision, descriptor: null });
}

/** 该版本是否具备承载预览的字节证据。 */
export function canPreview(entry: FileEntry, revision: number): boolean {
  return hasBytes(revisionAt(entry, revision).bytes);
}

/**
 * 附加业务插件返回的预览描述。
 *
 * 被拒情形（全部 fail-closed，不做「先显示后补证据」）：
 *   - 容器不是 ready（该版无字节）→ `preview-not-available`
 *   - 描述 revision 与容器不符 → `preview-revision-mismatch`
 *   - 描述 fileId 与文件不符 → `cross-file-revision`
 *   - sourceDigest 不是合法摘要 / 与该版字节摘要不等 → `preview-bytes-mismatch`
 *   - producer / mime / renderParts 形状非法 → `invalid-preview-descriptor`
 */
export function attachPreview(
  entry: FileEntry,
  container: PreviewContainer,
  descriptor: Omit<PreviewDescriptor, 'fileId' | 'revision'> & {
    fileId?: string;
    revision?: number;
  },
): PreviewContainer {
  if (container.state !== 'ready') {
    throw new FileError('preview-not-available', '该版本没有字节证据，不能承载预览', {
      fileId: entry.fileId,
      revision: container.revision,
    });
  }

  if (descriptor.fileId !== undefined && descriptor.fileId !== entry.fileId) {
    throw new FileError('cross-file-revision', '预览描述不得归属到别的文件', {
      fileId: entry.fileId,
      descriptorFileId: String(descriptor.fileId),
    });
  }
  if (descriptor.revision !== undefined && descriptor.revision !== container.revision) {
    throw new FileError('preview-revision-mismatch', '预览描述版本与容器版本不一致', {
      containerRevision: container.revision,
      descriptorRevision: String(descriptor.revision),
    });
  }

  const record: RevisionRecord = revisionAt(entry, container.revision);
  const bytes = record.bytes;
  if (!hasBytes(bytes)) {
    // 容器是 ready 但底层字节消失——内部不自洽，宁可报 missing-bytes 也不放行。
    throw new FileError('missing-bytes', '目标版本缺少字节证据，不能承载预览', {
      fileId: entry.fileId,
      revision: container.revision,
    });
  }
  if (!isSha256Digest(descriptor.sourceDigest) || descriptor.sourceDigest !== bytes.digest) {
    throw new FileError('preview-bytes-mismatch', '预览描述的 sourceDigest 与该版字节摘要不一致', {
      fileId: entry.fileId,
      revision: container.revision,
      expectedDigest: bytes.digest,
      gotDigest:
        typeof descriptor.sourceDigest === 'string' ? descriptor.sourceDigest : null,
    });
  }

  const stored: PreviewDescriptor = Object.freeze({
    fileId: entry.fileId,
    revision: container.revision,
    producer: requireProducer(descriptor.producer),
    mime: requireMime(descriptor.mime),
    sourceDigest: descriptor.sourceDigest,
    renderParts: requireRenderParts(descriptor.renderParts),
  });

  return Object.freeze({ state: 'ready', revision: container.revision, descriptor: stored });
}

/** 取预览描述；未附加一律 `preview-not-attached`（P5，不返回 null）。 */
export function previewOf(container: PreviewContainer): PreviewDescriptor {
  if (container.state !== 'ready' || container.descriptor === null) {
    throw new FileError('preview-not-attached', '尚无可渲染的预览描述', {
      state: container.state,
      revision: container.revision,
    });
  }
  return container.descriptor;
}

/** 是否已附加预览描述。 */
export function hasPreview(container: PreviewContainer): boolean {
  return container.state === 'ready' && container.descriptor !== null;
}

/** 预览是否由指定插件产出。用于界面归属展示，不做安全判断。 */
export function previewProducedBy(container: PreviewContainer, producer: string): boolean {
  return hasPreview(container) && (container.descriptor as PreviewDescriptor).producer === producer;
}

// ---------------------------------------------------------------------------
// 业务插件端口（Word / Excel / PPT 产出预览描述，F06 只消费）
// ---------------------------------------------------------------------------

/**
 * 传给业务插件的**该版确切字节证据**。插件必须把 `digest` 原样回显进
 * `PreviewDescriptor.sourceDigest`——这是「预览绑到那一份字节」的凭据（P2）。
 * 本包不把字节内容交给插件（字节读取属于插件/内核侧），只给长度与摘要。
 */
export interface PluginPreviewInput {
  readonly fileId: string;
  readonly revision: number;
  readonly digest: string;
  readonly byteLength: number;
}

/**
 * 业务插件端口：Word / Excel / PPT 的实现据此产出某版预览描述。
 *
 * 生产不 import 任何具体插件——只依赖这个**结构类型**（零依赖契约不变）；
 * 插件可用同步或异步方式产出。任何失败（抛错 / reject）按 fail-closed 处理：
 * **不产出预览**，不返回半份描述。
 */
export interface PreviewProducer {
  /** 插件引用（须与描述的 `producer` 同值），例如 `word-plugin`。 */
  readonly producer: string;
  produce(input: PluginPreviewInput): PreviewDescriptor | Promise<PreviewDescriptor>;
}

export interface AttachPluginPreviewOptions {
  /** 协作取消信号：已取消时**不调用**插件，直接按未附加处理。 */
  readonly signal?: { readonly aborted: boolean };
}

/** 出错摘要只保留错误类型/码，绝不回带请求体、路径或密钥。 */
function safeReason(error: unknown): string {
  if (error instanceof FileError) return error.code;
  if (error instanceof Error && typeof error.name === 'string') return error.name;
  return typeof error;
}

/**
 * 让**业务插件**产出预览描述并交给容器（attachPreview 的全部 P1–P5 绑定校验照跑）。
 *
 * 被拒情形（沿用既有错误码，fail-closed）：
 *   - 容器不是 ready（该版无字节）→ `preview-not-available`（且**不调用**插件）
 *   - 已取消 → `preview-not-attached`
 *   - 插件抛错 / reject / 返回非对象 → `invalid-preview-descriptor`
 *   - 返回的 `producer` 与端口注册引用不一致 → `invalid-preview-descriptor`
 *   - 描述 `fileId` / `revision` 与目标不符 → `cross-file-revision` / `preview-revision-mismatch`
 *   - 摘要不匹配 → `preview-bytes-mismatch`
 *
 * 说明：不收窄 `sourceDigest`——插件若回显旧版/他版摘要，会被 `preview-bytes-mismatch` 精确挡住。
 */
export async function attachPluginPreview(
  entry: FileEntry,
  container: PreviewContainer,
  plugin: PreviewProducer,
  options: AttachPluginPreviewOptions = {},
): Promise<PreviewContainer> {
  if (container.state !== 'ready') {
    throw new FileError('preview-not-available', '该版本没有字节证据，不能承载预览', {
      fileId: entry.fileId,
      revision: container.revision,
    });
  }
  if (!PRODUCER.test(plugin.producer)) {
    throw new FileError('invalid-preview-descriptor', '插件引用（producer）必须是非空白字符串', {
      producer: plugin.producer === undefined ? null : String(plugin.producer),
    });
  }
  if (options.signal?.aborted === true) {
    throw new FileError('preview-not-attached', '预览生成已取消', {
      fileId: entry.fileId,
      revision: container.revision,
    });
  }

  const record: RevisionRecord = revisionAt(entry, container.revision);
  const bytes = record.bytes;
  if (!hasBytes(bytes)) {
    throw new FileError('missing-bytes', '目标版本缺少字节证据，不能承载预览', {
      fileId: entry.fileId,
      revision: container.revision,
    });
  }

  let produced: PreviewDescriptor;
  try {
    produced = await plugin.produce(
      Object.freeze({
        fileId: entry.fileId,
        revision: container.revision,
        digest: bytes.digest,
        byteLength: bytes.byteLength,
      }),
    );
  } catch (error) {
    throw new FileError('invalid-preview-descriptor', '预览插件未能产出描述', {
      producer: plugin.producer,
      revision: container.revision,
      reason: safeReason(error),
    });
  }
  const raw: unknown = produced;
  if (raw === null || typeof raw !== 'object') {
    throw new FileError('invalid-preview-descriptor', '预览插件返回了非对象描述', {
      producer: plugin.producer,
      revision: container.revision,
      value: raw === null ? null : typeof raw,
    });
  }
  if (produced.producer !== plugin.producer) {
    throw new FileError('invalid-preview-descriptor', '插件返回的 producer 与端口注册引用不一致', {
      registered: plugin.producer,
      returned: typeof produced.producer === 'string' ? produced.producer : null,
    });
  }

  // 交给 attachPreview 做同一套 P2/P3/P4 校验（含 fileId/revision 归属）。
  return attachPreview(entry, container, {
    fileId: produced.fileId,
    revision: produced.revision,
    producer: produced.producer,
    mime: produced.mime,
    sourceDigest: produced.sourceDigest,
    renderParts: produced.renderParts,
  });
}
