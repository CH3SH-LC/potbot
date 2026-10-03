/**
 * **交付文件格式轴**（design-06 P8/P9 的产品入口；合同 R232 / R247）。
 *
 * ## 为什么这一层存在（R232）
 *
 * R232 明令**模板、工具、文件格式三者分开建模，不得混成一个枚举**。本文件只回答
 * "一份产物是什么**文件格式**"：`docx` / `xlsx` / `pptx` 的 MIME 与扩展名。
 * 它**不回答**"这是哪个业务模板"（那是 `src/plugins/**` 的七个业务模板），
 * 也**不回答**"用哪个工具产出"。
 *
 * 模板种类（`TemplateKind`）与文件格式今天恰好一一对应，但**它们是两个轴**：
 * protocol 里 `document` 是"文档类模板"，`docx` 是"OOXML 字处理文件格式"。
 * 因此本文件把"对应关系"写成一条**显式映射**（{@link templateKindOfFormat}），
 * 而不是让调用方把两者当同一个东西传。
 *
 * ## 唯一的字面量来源是 protocol
 *
 * 扩展名与 MIME **不在这里另抄一份**：值全部从 `src/protocol/artifact.ts` 的
 * `TEMPLATE_KIND_EXTENSIONS` / `TEMPLATE_KIND_MIME_TYPES` 读出来。
 * 模块加载时会核对"派生出来的集合 = 本文件声明的三个格式键"，不一致当场抛错——
 * 与 `apps/demo/server/kernel.ts` 的 MIME 一致性断言同一纪律：
 * **分叉会立刻可见，而不是静默发出错误的下载头**。
 *
 * 纪律：纯数据 + 纯函数；零 IO、零墙钟、零随机数（`src/**` 的机器化断言）。
 */

import {
  TEMPLATE_KIND_EXTENSIONS,
  TEMPLATE_KIND_MIME_TYPES,
  ValidationError,
  type TemplateKind,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 文件格式（封闭枚举）
// ---------------------------------------------------------------------------

/** 交付文件格式的封闭枚举。三类之外**不得**在此悄悄扩张（R232）。 */
export const FILE_FORMATS = ['docx', 'xlsx', 'pptx'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** 一种文件格式的交付元数据（**只描述格式**，不描述模板，也不描述工具）。 */
export interface FileFormatSpec {
  /** 格式 id（小写扩展名，与 `src/plugins/manifest.ts` 的 `FILE_FORMAT_KINDS` 同集合）。 */
  readonly format: FileFormat;
  /** 该格式对应的模板种类。**这是一条映射，不是同一个东西**（R232）。 */
  readonly template_kind: TemplateKind;
  /** 官方 MIME 类型（值来自 protocol，不在此另抄）。 */
  readonly mime: string;
  /** 文件扩展名，**不带点**（值来自 protocol）。 */
  readonly extension: string;
}

/** 从 protocol 的模板种类读出扩展名与 MIME（**唯一来源**）。 */
function specOf(format: FileFormat, templateKind: TemplateKind): FileFormatSpec {
  const extension = TEMPLATE_KIND_EXTENSIONS[templateKind];
  const mime = TEMPLATE_KIND_MIME_TYPES[templateKind];
  if (extension !== format) {
    throw new ValidationError(
      `文件格式 ${format} 与模板种类 ${templateKind} 的扩展名 ${extension} 不一致：` +
        'protocol 是唯一来源，请同步 src/protocol/artifact.ts 而不是在本层另写一份',
    );
  }
  return Object.freeze({ format, template_kind: templateKind, mime, extension });
}

/**
 * 文件格式 → 元数据。**三个键就是全部**（`docx` / `xlsx` / `pptx`）。
 *
 * 值侧读 protocol；键侧是本文件声明的封闭枚举。两侧在模块加载时核对（见下方断言）。
 */
export const FILE_FORMAT_SPECS: Readonly<Record<FileFormat, FileFormatSpec>> = Object.freeze({
  docx: specOf('docx', 'document'),
  xlsx: specOf('xlsx', 'spreadsheet'),
  pptx: specOf('pptx', 'presentation'),
});

/**
 * 加载期一致性核对：protocol 的模板种类集合必须与 {@link FILE_FORMATS} 逐项对应。
 *
 * 为什么让它**抛错而不是警告**：三个格式的 MIME / 扩展名会被写进 HTTP 响应头与产物
 * 记录；一份"看起来对、其实分叉了"的映射就是"下载下来的文件打不开"这种最难查的故障。
 */
{
  const derived = (Object.keys(FILE_FORMAT_SPECS) as FileFormat[]).map(
    (format) => FILE_FORMAT_SPECS[format].format,
  );
  const derivedSet = [...derived].sort().join(',');
  const declaredSet = [...FILE_FORMATS].sort().join(',');
  if (derivedSet !== declaredSet) {
    throw new ValidationError(
      `文件格式集合与 protocol 派生结果分叉：本层 ${declaredSet}，派生 ${derivedSet}`,
    );
  }
}

/** 某字符串是否是合法文件格式（大小写敏感，精确匹配）。 */
export function isFileFormat(value: unknown): value is FileFormat {
  return typeof value === 'string' && (FILE_FORMATS as readonly string[]).includes(value);
}

/** 取某格式的交付元数据。 */
export function formatSpec(format: FileFormat): FileFormatSpec {
  return FILE_FORMAT_SPECS[format];
}

/** 模板种类 → 文件格式（R232 的显式映射；找不到即抛，不猜）。 */
export function formatOfTemplateKind(kind: TemplateKind): FileFormat {
  for (const format of FILE_FORMATS) {
    if (FILE_FORMAT_SPECS[format].template_kind === kind) return format;
  }
  throw new ValidationError(`模板种类 ${kind} 没有对应的交付文件格式（R232：不得猜）`);
}

/** 文件格式 → 模板种类（{@link formatOfTemplateKind} 的反向；同样不猜）。 */
export function templateKindOfFormat(format: FileFormat): TemplateKind {
  return FILE_FORMAT_SPECS[format].template_kind;
}

// ---------------------------------------------------------------------------
// 互不冒充（R232 的交付侧守卫）
// ---------------------------------------------------------------------------

/**
 * 从文件名推断文件格式；没有可识别的扩展名时返回 `null`（**不猜**）。
 *
 * 只做精确扩展名匹配：`.docx` / `.xlsx` / `.pptx`（大小写不敏感，因为 Windows
 * 文件名大小写不敏感，而 `XLSX` 也是合法扩展名）。
 */
export function formatOfFilename(filename: string): FileFormat | null {
  const lower = filename.toLowerCase();
  for (const format of FILE_FORMATS) {
    if (lower.endsWith(`.${FILE_FORMAT_SPECS[format].extension}`)) return format;
  }
  return null;
}

/**
 * **互不冒充守卫**：交付时"声明的格式"必须与"文件名的扩展名"一致。
 *
 * 为什么需要它：三种格式的容器都是 ZIP，肉眼与"能解压"都区分不开。一旦某条链把
 * XLSX 字节配了 `.docx` 的名字（或反之），消费端会拿到一个"打开就报损坏"的文件，
 * 而这种错误在服务端**不会自己暴露**。因此在这里把它变成一条可失败的断言。
 *
 * @throws {ValidationError} 扩展名缺失、无法识别，或与 `format` 不一致。
 */
export function assertFilenameMatchesFormat(format: FileFormat, filename: string): void {
  const actual = formatOfFilename(filename);
  const spec = FILE_FORMAT_SPECS[format];
  if (actual === null) {
    throw new ValidationError(
      `文件名 ${JSON.stringify(filename)} 没有可识别的办公文件扩展名：` +
        `交付 ${format} 时必须以 .${spec.extension} 结尾（不猜格式）`,
    );
  }
  if (actual !== format) {
    throw new ValidationError(
      `文件名扩展名与声明的文件格式不符：声明 ${format}（.${spec.extension}），` +
        `文件名 ${JSON.stringify(filename)} 看着像 ${actual}——不得互相冒充（R232）`,
    );
  }
}

/** 文件名是否与声明的格式一致（{@link assertFilenameMatchesFormat} 的非抛出版本）。 */
export function filenameMatchesFormat(format: FileFormat, filename: string): boolean {
  return formatOfFilename(filename) === format;
}
