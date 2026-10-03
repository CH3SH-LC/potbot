package com.potbot.kernel.storage;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.system.ErrnoException;
import android.system.Os;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * K-I20 原生平台文件系统端口 —— **应用私有目录**实现（对应 TS
 * {@code apps/mobile-kernel/storage/fs-port.ts} 的 {@code FileSystemPort}）。
 *
 * <p>⚠️ 状态：**本文件未编译、未上真机**（本环境无 Android SDK 构建，见仓库
 * {@code tests/mobile-kernel/K-I20/README.md}）。它按安卓标准用法写成，作为 TS 侧
 * {@code FileSystemPort} 的原生对照实现与集成起点。Android 集成人须把它编译进 APK，
 * 并在真机跑 {@code FileStoragePort} 的崩溃恢复用例（杀进程重开读旧产物）。**不得**
 * 把本文件当作"已完成/已验证"。
 *
 * <h2>为什么根在应用私有目录（而不是 SAF）</h2>
 * 上层 {@code FileStoragePort} 的崩溃安全性依赖两件事：{@code writeFile} 到临时名 +
 * {@link #rename} 原子替换，以及**目录级 fsync 语义**。SAF（{@code content://}）的
 * {@code DocumentsContract.renameDocument} 是否原子、是否替换同名文档**由各 provider 决定**，
 * 无法保证 POSIX {@code rename(2)} 语义。因此：
 * <ul>
 *   <li><b>事务根</b>（data/meta/tmp/journal）落在 {@code filesDir} 下的应用私有目录——
 *       Linux 同一文件系统内，{@link #rename} 走 {@link Os#rename}（= {@code rename(2)}），
 *       是严格原子的。</li>
 *   <li><b>SAF</b> 只作为**导入/导出通道**（用户选的文件 → 读进私有目录；产物 → 写回用户
 *       选的位置），见 {@link #readContentUri}/{@link #writeContentUri}。SAF 不承担事务根。</li>
 * </ul>
 *
 * <h2>原子落盘（tmp+rename）</h2>
 * {@link #writeFile} 并不直接覆盖目标，而是：同目录写 {@code <name><TMP_SUFFIX><seq>} →
 * flush + {@code fsync} → {@link Os#rename} 原子替换到目标。崩溃在任一时刻，目标要么是
 * 旧内容、要么是新内容，**不会出现半截字节**。这比 TS 契约要求的更强（契约只要求
 * writeFile 创建父目录、不要求原子），不违反契约。
 *
 * <h2>路径围栏</h2>
 * 所有入参先经 {@link #resolve}：相对路径拼到根下、绝对路径须落在根内，并做
 * {@code getCanonicalFile} 规整 + {@code ".."} 穿越检查，越界抛 {@link SecurityException}
 * （{@code path_outside_root}）。这是"平台绝对路径不得逃出沙箱"的实现方式。
 *
 * <h2>未做的部分（如实标注）</h2>
 * <ul>
 *   <li>没有接进 {@code MainActivity} / 内核宿主（写权在集成人）。</li>
 *   <li><b>目录级 fsync</b>：Java 无法直接 {@code fsync} 一个目录（无公开 API 打开目录 fd），
 *       故只有文件数据的 {@code fsync}。断电级持久化需 root/NDK 才能补，安卓应用层无法完全保证。</li>
 *   <li>单写者假设：并发写同一路径由上层 {@code FileStoragePort} 保证串行，本类只对
 *       {@code seq} 计数做原子自增。</li>
 * </ul>
 */
public final class AndroidFileSystemPort implements FileSystemPort {

    /** 临时文件后缀（写文件时先落到 {@code <name><TMP_SUFFIX><seq>}，再原子 rename 到位）。 */
    public static final String TMP_SUFFIX = ".potbot-tmp";

    private final Context context;
    private final File root;
    private final AtomicLong seq = new AtomicLong();

    /**
     * @param context App context（内部取 applicationContext）
     * @param root    事务根目录（必须位于应用私有空间，例如
     *                {@code new File(context.getFilesDir(), "potbot-store")}）。
     *                上层 {@code FileStoragePortOptions.root} 必须与本根**同一路径**。
     */
    public AndroidFileSystemPort(Context context, File root) {
        if (context == null) throw new IllegalArgumentException("null_context");
        if (root == null) throw new IllegalArgumentException("null_root");
        this.context = context.getApplicationContext();
        this.root = root;
    }

    /** 便捷工厂：事务根 = {@code filesDir/potbot-store}。 */
    public static AndroidFileSystemPort appPrivate(Context context) {
        return new AndroidFileSystemPort(context, new File(context.getFilesDir(), "potbot-store"));
    }

    /** 事务根目录（只读；**不得**进入任何对外返回值/URI）。 */
    public File rootDir() {
        return root;
    }

    // ------------------------------------------------------------------
    // FileSystemPort
    // ------------------------------------------------------------------

    @Override
    public void ensureDir(String dirPath) {
        File dir = resolve(dirPath);
        if (dir.exists()) {
            if (!dir.isDirectory()) throw new IllegalStateException("not_a_directory:" + dirPath);
            return;
        }
        if (!dir.mkdirs() && !dir.isDirectory()) {
            throw new IllegalStateException("mkdir_failed:" + dirPath);
        }
    }

    @Override
    public boolean exists(String path) {
        // 契约：只看"普通文件"；目录或不存在都返回 false（不抛错）。
        return resolve(path).isFile();
    }

    @Override
    public byte[] readFile(String path) {
        File file = resolve(path);
        if (!file.isFile()) throw new IllegalStateException("not_a_file:" + path);
        try (InputStream in = new FileInputStream(file)) {
            return readAll(in);
        } catch (IOException e) {
            throw new IllegalStateException("read_failed:" + path, e);
        }
    }

    @Override
    public void writeFile(String path, byte[] bytes) {
        if (bytes == null) throw new IllegalArgumentException("null_bytes");
        File target = resolve(path);
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IllegalStateException("mkdir_failed:" + path);
        }
        // 原子落盘：先写同目录临时文件（flush + fsync），再 rename 原子替换目标。
        File tmp = new File(parent, target.getName() + TMP_SUFFIX + seq.incrementAndGet());
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
            out.flush();
            out.getFD().sync();
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IllegalStateException("write_failed:" + path, e);
        }
        try {
            atomicRename(tmp, target);
        } catch (RuntimeException e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw e;
        }
    }

    @Override
    public void rename(String fromPath, String toPath) {
        atomicRename(resolve(fromPath), resolve(toPath));
    }

    @Override
    public void removeFile(String path) {
        File file = resolve(path);
        if (!file.exists()) return; // 契约：不存在不算错误
        if (!file.delete() && file.exists()) throw new IllegalStateException("remove_failed:" + path);
    }

    @Override
    public List<String> listFiles(String dirPath) {
        return listChildren(dirPath, false);
    }

    @Override
    public List<String> listDirs(String dirPath) {
        return listChildren(dirPath, true);
    }

    // ------------------------------------------------------------------
    // SAF 导入/导出通道（不承担事务根）
    // ------------------------------------------------------------------

    /**
     * 从 SAF 文档 URI 读入字节（导入通道）。{@code uri} 为用户经
     * {@code ACTION_OPEN_DOCUMENT} 选定的 {@code content://} 文档。
     */
    public byte[] readContentUri(Uri uri) throws IOException {
        if (uri == null) throw new IllegalArgumentException("null_uri");
        try (InputStream in = context.getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("content_open_null");
            return readAll(in);
        }
    }

    /**
     * 把字节写入 SAF 文档 URI（导出通道）。用截断语义（{@code "wt"}）覆盖已有内容：
     * 不能凭此声明原子——SAF 的原子性由 provider 决定，故产物应先落私有目录再拷出。
     *
     * <p><b>版本闸门</b>：带模式的重载 {@code ContentResolver.openOutputStream(Uri, String)}
     * 是 **API 26（O）** 才引入的，本工程 {@code minSdk = 24}；API 24/25 直接调用会在运行期抛
     * {@link NoSuchMethodError}。故 API 26+ 传 {@code "wt"}，API &lt; 26 退回一参重载
     * （平台语义等价于模式 {@code "w"}，同样是 write-only + 创建 + 截断）。两条路径都保持
     * "存在即截断覆盖"的契约，不在低版本上悄悄改成"不截断"。
     */
    public void writeContentUri(Uri uri, byte[] bytes) throws IOException {
        if (uri == null) throw new IllegalArgumentException("null_uri");
        if (bytes == null) throw new IllegalArgumentException("null_bytes");
        ContentResolver resolver = context.getContentResolver();
        OutputStream out = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? resolver.openOutputStream(uri, "wt")
                : resolver.openOutputStream(uri);
        try (OutputStream stream = out) {
            if (stream == null) throw new IOException("content_open_null");
            stream.write(bytes);
            stream.flush();
        }
    }

    /** SAF 文档是否存在（可读）。读失败/无权限一律 false（不抛错）。 */
    public boolean existsContentUri(Uri uri) {
        if (uri == null) return false;
        try (InputStream in = context.getContentResolver().openInputStream(uri)) {
            return in != null;
        } catch (IOException | SecurityException e) {
            return false;
        }
    }

    /** 删除 SAF 文档。返回是否删掉了（不存在或删不掉返回 false）。 */
    public boolean deleteContentUri(Uri uri) {
        if (uri == null) return false;
        try {
            return context.getContentResolver().delete(uri, null, null) > 0;
        } catch (SecurityException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    private List<String> listChildren(String dirPath, boolean wantDirs) {
        File dir = resolve(dirPath);
        if (!dir.isDirectory()) return Collections.emptyList(); // 契约：目录不存在返回空
        File[] children = dir.listFiles();
        if (children == null) return Collections.emptyList();
        List<String> names = new ArrayList<>();
        for (File child : children) {
            if (child.isDirectory() == wantDirs) names.add(child.getName());
        }
        Collections.sort(names); // 确定性顺序（上层崩溃恢复的遍历不该被目录枚举顺序左右）
        return names;
    }

    /**
     * 原子替换移动。优先 {@link Os#rename}（安卓 API 21+，直接映射 libc {@code rename(2)}，
     * 同卷内**原子替换**已存在的目标）；异常时退回 {@link File#renameTo}（同卷同样是单次
     * rename(2)，best effort）。二者都失败才抛错——绝不静默半完成。
     */
    private static void atomicRename(File from, File to) {
        try {
            Os.rename(from.getAbsolutePath(), to.getAbsolutePath());
            return;
        } catch (ErrnoException e) {
            // 落到下面的 File.renameTo 兜底（不同卷 / 特殊文件系统）。
        }
        if (!from.renameTo(to)) {
            throw new IllegalStateException("rename_failed:" + from.getName() + "->" + to.getName());
        }
    }

    /**
     * 把入参规整成**根内**的规范文件路径。相对路径拼到根下；绝对路径必须落在根内。
     * 越界抛 {@link SecurityException}（{@code path_outside_root}）。
     */
    private File resolve(String path) {
        if (path == null || path.isEmpty()) throw new IllegalArgumentException("empty_path");
        File candidate = new File(path);
        if (!candidate.isAbsolute()) candidate = new File(root, path);
        File canonical;
        try {
            canonical = candidate.getCanonicalFile();
        } catch (IOException e) {
            throw new IllegalArgumentException("bad_path:" + path, e);
        }
        String rootCanonical = canonicalRoot();
        String p = canonical.getPath();
        if (!p.equals(rootCanonical) && !p.startsWith(rootCanonical + File.separator)) {
            throw new SecurityException("path_outside_root:" + path);
        }
        return canonical;
    }

    private String canonicalRoot() {
        try {
            return root.getCanonicalPath();
        } catch (IOException e) {
            return root.getAbsolutePath();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = in.read(chunk)) >= 0) buffer.write(chunk, 0, read);
        return buffer.toByteArray();
    }
}
