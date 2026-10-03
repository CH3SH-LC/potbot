/**
 * K09 存储端口 —— **content URI 形状与"不得返回电脑绝对路径"红线**（零依赖）。
 *
 * ## 契约
 *
 * `contracts/mobile-v1/schemas/storage-port.schema.json` 的 `$defs.contentUri` 用
 * `allOf` 三条同时约束：
 *   - `not ^[A-Za-z]:` —— 拒绝 Windows 盘符（`C:\…`、`C:/…`）；
 *   - `not ^/`          —— 拒绝 POSIX 绝对路径；
 *   - `^ (content|blob|app):/ ` —— 只接受手机内容 URI scheme。
 *
 * 本文件把这套规则**同时**在"校验方向"（`isContentUri` / `assertContentUri`）与
 * "构造方向"（`relativePathToContentUri`）落地。构造方向同样要拒绝绝对路径——
 * 否则调用方把 `C:\Users\<user>\x.docx` 当"相对路径"传进来，构造器会好心把它
 * 拼成一个看似合法的 `content://potbot/C:\Users\…`，红线就在出口处被绕过了。
 */

import { StorageError } from './errors.js';

/** 允许的手机内容 URI scheme。 */
export const CONTENT_URI_SCHEMES = ['content', 'blob', 'app'] as const;
export type ContentUriScheme = (typeof CONTENT_URI_SCHEMES)[number];

/** 契约 `$defs.contentUri` 的正向 pattern。 */
export const CONTENT_URI_PATTERN = /^(content|blob|app):\/[^\s]*$/;

/** Windows 盘符（`C:` / `d:`）。 */
export const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

/** POSIX 绝对路径。 */
export const POSIX_ABSOLUTE_PATTERN = /^\//;

/**
 * 是否是"电脑绝对路径"（盘符或 POSIX 根）——两条红线合并成一个可复用判据。
 *
 * 注意返回的是**布尔**而非类型谓词：调用方常把它作用在**已是 `string`** 的变量上
 * （如 `relativePathToContentUri` 的入参）。若写成 `value is string`，TypeScript 会在
 * `if (!isDesktopAbsolutePath(x))` 的假分支把 `string` 收窄成 `never`，后续 `x.length` 直接报错。
 */
export function isDesktopAbsolutePath(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (WINDOWS_DRIVE_PATTERN.test(value) || POSIX_ABSOLUTE_PATTERN.test(value))
  );
}

/**
 * 是否是合法的手机内容 URI。**先**拒绝对路径再匹配正向 pattern——顺序有意为之：
 * 若先匹配 pattern，`C:/x` 会因为不匹配 `^(content|blob|app):/` 而被归为
 * `invalid_content_uri`，红线拒因就被"形状不合法"覆盖掉了，验收无法区分
 * "它拒绝了盘符"还是"它只是没认出来"。
 */
export function isContentUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (isDesktopAbsolutePath(value)) return false;
  return CONTENT_URI_PATTERN.test(value);
}

/** 校验并返回内容 URI；不合规就抛**可区分的**拒因。 */
export function assertContentUri(value: unknown, what: string): string {
  if (isDesktopAbsolutePath(value)) {
    throw new StorageError('desktop_path_rejected', `${what} 不得是电脑绝对路径`, String(value));
  }
  if (!isContentUri(value)) {
    throw new StorageError(
      'invalid_content_uri',
      `${what} 必须是 content:/ blob:/ app:/ 开头的手机内容 URI`,
      typeof value === 'string' ? value : String(value),
    );
  }
  return value;
}

/**
 * 把**相对路径**转换为内容 URI。拒绝绝对路径（盘符 / 前导 `/`）、`..`、反斜杠与空白，
 * 保证输出永远落在 `content://potbot/…` 命名空间内。
 */
export function relativePathToContentUri(relativePath: string, scheme: ContentUriScheme = 'content'): string {
  if (isDesktopAbsolutePath(relativePath)) {
    throw new StorageError('desktop_path_rejected', '不得把电脑绝对路径当作相对路径构造 URI', relativePath);
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new StorageError('invalid_relative_path', '相对路径不得为空', String(relativePath));
  }
  if (relativePath.includes('\\')) {
    throw new StorageError('invalid_relative_path', '相对路径不得含反斜杠', relativePath);
  }
  const segments = relativePath.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new StorageError('invalid_relative_path', '相对路径不得为空或含 ..', relativePath);
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new StorageError('invalid_relative_path', `路径段含非法字符：${segment}`, relativePath);
    }
  }
  return `${scheme}://potbot/${segments.join('/')}`;
}

/** `<scheme>://potbot/<relativePath>` —— `relativePathToContentUri` 的**逆**。 */
const POTBOT_CONTENT_URI_PATTERN = /^(content|blob|app):\/\/potbot\/(.+)$/;

/**
 * 把内容 URI 还原为**相对路径**（`relativePathToContentUri` 的逆运算）。
 *
 * 用途：持久化后端要把 `content://potbot/blobs/a.bin` 落到磁盘上的
 * `…/data/blobs/a.bin`——**平台路径只在后端内部出现，绝不回给调用方**。
 *
 * 红线：先跑 `assertContentUri`（拒电脑绝对路径与非法 scheme），再要求
 * authority 必须是 `potbot`，并逐段校验字符集、拒绝 `..` 与反斜杠。任何一步不合规都抛
 * **可区分**的拒因，绝不"猜一个路径出来"。
 */
export function contentUriToRelativePath(uri: unknown, what = 'uri'): string {
  const safe = assertContentUri(uri, what);
  const match = POTBOT_CONTENT_URI_PATTERN.exec(safe);
  if (match === null) {
    throw new StorageError(
      'invalid_content_uri',
      `${what} 必须是 <scheme>://potbot/<relativePath> 形式（authority 只认 potbot）`,
      safe,
    );
  }
  const rest = match[2]!;
  if (rest.includes('\\')) {
    throw new StorageError('invalid_relative_path', '内容 URI 的路径不得含反斜杠', safe);
  }
  const segments = rest.split('/');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new StorageError('invalid_relative_path', '内容 URI 的路径不得含空段 / . / ..', safe);
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new StorageError('invalid_relative_path', `路径段含非法字符：${segment}`, safe);
    }
  }
  return segments.join('/');
}
