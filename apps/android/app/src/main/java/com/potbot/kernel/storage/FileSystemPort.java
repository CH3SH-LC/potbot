package com.potbot.kernel.storage;

import java.util.List;

/**
 * K-I20 原生平台文件系统端口 —— 对应 TS 侧 `apps/mobile-kernel/storage/fs-port.ts` 的
 * {@code interface FileSystemPort}。
 *
 * <p>这是**平台层里侧**的极小、同步端口：入参/出参都是**平台路径**（安卓应用私有目录下的
 * 绝对路径，或 {@code content://} 文档 URI）。对外 URI（{@code content://potbot/…}）的归口
 * 落在上层 {@code FileStoragePort}（`apps/mobile-kernel/storage/file-store.ts`），
 * **本端口不负责**生成对外 URI，也**不得**把平台绝对路径带回业务层。
 *
 * <p>方法集必须与 TS 侧逐一对齐（本仓库 K-I20 的静态契约测试
 * `tests/mobile-kernel/K-I20/fs-port-contract.test.ts` 机器化断言这一点）：
 * {@link #ensureDir}、{@link #exists}、{@link #readFile}、{@link #writeFile}、
 * {@link #rename}、{@link #removeFile}、{@link #listFiles}、{@link #listDirs}。
 *
 * <p>语义红线（与 TS 接口注释同源）：
 * <ul>
 *   <li>{@link #rename} 必须对齐 POSIX {@code rename(2)}——同一文件系统内**要么完成、
 *       要么不发生**，目标已存在时被**原子替换**。上层 {@code FileStoragePort} 的全部
 *       崩溃安全性都建立在这一条上。</li>
 *   <li>{@link #writeFile} 在 TS 契约里**不保证**原子；实现可提供更强的原子落盘
 *       （tmp+rename）而不违反契约。</li>
 *   <li>{@link #listFiles}/{@link #listDirs} 目录不存在时返回**空列表**，不抛错。</li>
 * </ul>
 *
 * <p>⚠️ 状态：本文件**未编译、未上真机**（本环境无 Android SDK 构建）。它写的是集成起点，
 * 不是"已完成/已验证"。
 */
public interface FileSystemPort {

    /** 幂等创建目录（含所有父级）。已存在不算错误。 */
    void ensureDir(String dirPath);

    /** 路径是否指向一个**普通文件**（目录或不存在都返回 false）。 */
    boolean exists(String path);

    /** 读取整个文件。不存在或不是文件应抛错（调用方先 {@link #exists} 判断）。 */
    byte[] readFile(String path);

    /**
     * 覆盖写整个文件。**必须**按需创建父目录。
     * TS 契约不要求原子；本实现提供 tmp+rename 的原子落盘（更强，不破坏契约）。
     */
    void writeFile(String path, byte[] bytes);

    /**
     * 原子重命名 / 覆盖移动，语义对齐 POSIX {@code rename(2)}：同一文件系统内要么完成、
     * 要么不发生；目标已存在时被**原子替换**。
     */
    void rename(String fromPath, String toPath);

    /** 删除文件；不存在不算错误。 */
    void removeFile(String path);

    /** 列出目录下**普通文件**的名字（不含路径、不递归）；目录不存在返回空数组。 */
    List<String> listFiles(String dirPath);

    /** 列出目录下**子目录**的名字（不含路径、不递归）；目录不存在返回空数组。 */
    List<String> listDirs(String dirPath);
}
