/**
 * K09 存储端口 —— **平台文件系统端口 `FileSystemPort`**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么再抽一层
 *
 * `StoragePort`（`types.ts`）是**业务语义**层：原子事务、版本 CAS、读回凭据……
 * 这些语义与介质无关。真正把字节落到手机上的动作（临时文件、`rename`、列目录）
 * 属于**平台**层，安卓侧要走 SAF / 应用私有目录、桌面侧走 `node:fs`、内存侧什么都没有。
 * 用一个**同步、极小**的端口把这层隔开，`FileStoragePort` 才能只写一次，
 * 由不同平台各自提供实现（对照 `model/` 的 `ModelPort`）。
 *
 * ## 红线：端口只在**平台内部**用真实路径
 *
 * 本端口的入参/出参是**平台路径**（例如 `C:/tmp/x/data/blobs/a.bin`），这是**平台层内部**的事。
 * `StoragePort` 的**返回值**永远不含平台路径——所有对外 URI 都经 `uri.ts` 变成
 * `content://potbot/…`。因此"不得返回电脑绝对路径"这条红线落在 `FileStoragePort`，
 * 而不是落在这个端口上（端口本身就是平台边界的里侧）。
 *
 * ## 实现分布（如实标注）
 *
 * - **安卓原生**：`apps/android/app/src/main/java/com/potbot/kernel/storage/` 提供实现——
 *   **本包未做**（原生侧是后续集成人的活）。
 * - **桌面 / 测试**：`node:fs` 实现**只在测试里**（`tests/mobile-kernel/K09/file-store.test.ts`），
 *   刻意不放进产品树，保证产品代码图里没有 `node:fs`。
 * - 因此本文件只提供**接口**，不提供任何具体实现——这不是"空壳"：真正的逻辑与
 *   崩溃恢复在 `FileStoragePort` 里，测试用真实的 `node:fs` 适配器把它跑在真磁盘上。
 */

export interface FileSystemPort {
  /**
   * 幂等创建目录（含所有父级）。已存在不算错误。
   */
  ensureDir(dirPath: string): void;

  /** 路径是否指向一个**普通文件**（目录或不存在都返回 false）。 */
  exists(path: string): boolean;

  /** 读取整个文件。不存在或不是文件应抛错（调用方先 `exists` 判断）。 */
  readFile(path: string): Uint8Array;

  /**
   * 覆盖写整个文件。**必须**按需创建父目录。
   * 注意：本方法**不保证**原子——原子性由 `FileStoragePort` 用"写临时文件 + `rename`"实现。
   */
  writeFile(path: string, bytes: Uint8Array): void;

  /**
   * 原子重命名 / 覆盖移动。语义须对齐 POSIX `rename(2)`：同一文件系统内**要么完成、
   * 要么不发生**；目标已存在时被**原子替换**（Windows 上由 `MOVEFILE_REPLACE_EXISTING`
   * 提供等价语义）。`FileStoragePort` 的全部原子性都建立在这一点上。
   */
  rename(fromPath: string, toPath: string): void;

  /** 删除文件；不存在不算错误。 */
  removeFile(path: string): void;

  /** 列出目录下**普通文件**的名字（不含路径、不递归）；目录不存在返回空数组。 */
  listFiles(dirPath: string): readonly string[];

  /** 列出目录下**子目录**的名字（不含路径、不递归）；目录不存在返回空数组。 */
  listDirs(dirPath: string): readonly string[];
}
