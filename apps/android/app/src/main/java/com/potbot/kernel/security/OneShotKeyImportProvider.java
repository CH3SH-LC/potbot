package com.potbot.kernel.security;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * K03 / K-I22 原生实现 —— **桌面到设备的一次性密钥导入通道**。
 *
 * 这是 K03 TS 侧 {@code ImportSourceProvider}（{@code apps/mobile-kernel/security/import-source.ts}）
 * 的原生对应物。TS 侧只拿一个句柄 {@code sourceRef}；明文**永远不跨进程进 JS**：
 * 原生侧读文件、交给 {@link AndroidKeyStorePort#seal}、随后立刻销毁一切可复原明文的痕迹。
 *
 * ## 一次导入的完整步骤（与 K03 findings 集成请求 #4 逐条对应）
 *
 * 1. 集成人用 {@code ACTION_OPEN_DOCUMENT} + {@code FLAG_GRANT_READ_URI_PERMISSION} 让用户选中
 *    桌面密钥文件，拿到一个**临时授权**的 {@code content://} URI（绝不 {@code takePersistableUriPermission}）。
 * 2. {@link #openChannel(Uri)} 把它登记成一个不透明句柄 {@code sourceRef}（形如 {@code import:N}），
 *    句柄里**不含明文、不含密钥路径以外的东西**。
 * 3. {@link #consumeAndSeal(String, String, int)} 一次性消费该句柄：
 *    URI → App 私有 no-backup 目录的中间文件 → 读入内存 → {@code port.seal()}。
 * 4. 无论成败，{@code finally} 里依次：**明文填零** → **删除中间文件** → **撤销临时 URI 授权** →
 *    焚毁句柄。失败不留任何可复原明文的产物。
 *
 * ## 硬约束（K03 契约 + 本单元静态合同测试机器化断言）
 *
 * - **本类任何方法都不返回明文**：唯一的字节产出是交给 {@code port.seal()}；公开返回值只有
 *   {@link ChannelResult} / {@link ImportResult}（元数据：sourceRef / keyRef / 状态 / 错误码）。
 *   没有任何方法（公开或包内）以 {@code byte[]} 为返回类型。
 * - **读完即焚**：每个句柄持一个 {@link AtomicBoolean consumed}，{@code compareAndSet} 失败即
 *   返回 {@link #ERROR_ALREADY_CONSUMED}（= K03 的 {@code secret_source_exhausted}）。
 * - **落零**：读出的明文字节数组在 {@code finally} 里 {@code Arrays.fill(..., (byte) 0)}。
 *   （{@code AndroidKeyStorePort.seal} 内部也会再填一次，这里是双保险。）
 * - **不打印**：本类**不用** {@code Log} / {@code System.out} / {@code printStackTrace}，
 *   错误里也不回显 URI 或明文。
 *
 * ## ⚠️ 状态：**未编译、未上真机**
 *
 * 本机无 Android SDK / NDK / gradle wrapper / adb（同 K01/K03 局限）。本文件按 Android
 * 标准 API 写成，是原生对照实现与集成起点，**不得**当作"已验证"。真机层（临时授权撤销是否
 * 生效、中间文件是否可被其他 App 读到、重启后 Keystore 仍可解密）属 {@code on-device}，未做。
 *
 * ## 与 TS 错误码的对应
 *
 * 下述常量凡在 {@code apps/mobile-kernel/security/errors.ts} 的 {@code SECURITY_ERROR_CODES}
 * 中出现的，取值**逐字相同**（静态合同测试机器化核对）；{@link #ERROR_READ_FAILED} 与
 * {@link #ERROR_TOO_LARGE} 是原生独有码，桥接层须映射到 K03 词表后再出口。
 */
public final class OneShotKeyImportProvider {

    // --- 与 K03 SECURITY_ERROR_CODES 逐字对应的共享码 ---
    /** = K03 {@code secret_source_unknown}：句柄未开 / 已撤销 / URI 不可读。 */
    public static final String ERROR_SOURCE_UNKNOWN = "secret_source_unknown";
    /** = K03 {@code secret_source_exhausted}：通道被第二次消费（读完即焚）。 */
    public static final String ERROR_ALREADY_CONSUMED = "secret_source_exhausted";
    /** = K03 {@code secret_source_empty}：读到的字节为空。 */
    public static final String ERROR_SOURCE_EMPTY = "secret_source_empty";
    /** = K03 {@code not_provisioned}：AndroidKeyStore 包装密钥未就绪。 */
    public static final String ERROR_NOT_PROVISIONED = "not_provisioned";
    /** = K03 {@code keystore_unavailable}：{@code provision()} 失败。 */
    public static final String ERROR_KEYSTORE_UNAVAILABLE = "keystore_unavailable";
    /** = K03 {@code backup_not_excluded}：备份未排除，拒绝落盘。 */
    public static final String ERROR_BACKUP_NOT_EXCLUDED = "backup_not_excluded";
    /** = K03 {@code seal_failed}：密文落盘失败。 */
    public static final String ERROR_SEAL_FAILED = "seal_failed";

    // --- 原生独有码（桥接层须映射到 K03 词表） ---
    /** 原生独有：从临时授权 URI 读取 / 落中间文件失败。 */
    public static final String ERROR_READ_FAILED = "source_read_failed";
    /** 原生独有：密钥文件超过 {@link #MAX_SECRET_BYTES}（拒绝把超大文件读进内存）。 */
    public static final String ERROR_TOO_LARGE = "source_too_large";

    /** 一次性导入可接受的明文字节上限（防超大文件把内存吃满）。 */
    public static final int MAX_SECRET_BYTES = 4096;

    /** 中间文件目录（位于 no-backup 目录下；用完即删）。 */
    private static final String STAGE_DIR = "potbot-import-stage";
    /** 复制分块大小。 */
    private static final int COPY_CHUNK = 1024;

    private final Context context;
    private final AndroidKeyStorePort port;
    private final Map<String, Channel> channels = new HashMap<>();
    private long seq = 0L;

    /**
     * @param context App context
     * @param port    同一包内的 AndroidKeyStore 端口（密封/探针/销毁）
     */
    public OneShotKeyImportProvider(Context context, AndroidKeyStorePort port) {
        this.context = context.getApplicationContext();
        this.port = port;
    }

    // ------------------------------------------------------------------
    // 句柄登记 / 撤销
    // ------------------------------------------------------------------

    /**
     * 登记一条**临时授权**的 content URI，返回不透明句柄 {@code sourceRef}。
     * 本方法不读内容、不持有明文。
     */
    public ChannelResult openChannel(Uri grantedUri) {
        if (grantedUri == null) {
            return new ChannelResult(false, null, ERROR_SOURCE_UNKNOWN);
        }
        seq += 1;
        final String sourceRef = "import:" + seq;
        channels.put(sourceRef, new Channel(grantedUri));
        return new ChannelResult(true, sourceRef, null);
    }

    /** 撤销一个**尚未消费**的句柄：移除登记并撤销临时 URI 授权。不读内容。 */
    public boolean revoke(String sourceRef) {
        if (sourceRef == null) {
            return false;
        }
        final Channel channel = channels.remove(sourceRef);
        if (channel == null) {
            return false;
        }
        revokeGrant(channel.uri);
        return true;
    }

    // ------------------------------------------------------------------
    // 一次性消费：读 -> seal -> 填零/删中间文件/撤销授权
    // ------------------------------------------------------------------

    /**
     * 一次性消费：把 URI 指向的明文交给 Keystore 密封，随后销毁一切痕迹。
     * 返回值**只有元数据**，不含明文。
     *
     * @param sourceRef {@link #openChannel} 返回的句柄
     * @param keyRef    K03 语义的引用（如 {@code keyref:model.deepseek-flash}）
     * @param revision  该代密钥的修订号
     */
    public ImportResult consumeAndSeal(String sourceRef, String keyRef, int revision) {
        final Channel channel = channels.get(sourceRef);
        if (channel == null) {
            return ImportResult.failed(sourceRef, keyRef, revision, ERROR_SOURCE_UNKNOWN);
        }
        // ★ 读完即焚：CAS 失败即第二次消费，立刻拒绝，不读任何字节。
        if (!channel.consumed.compareAndSet(false, true)) {
            return ImportResult.failed(sourceRef, keyRef, revision, ERROR_ALREADY_CONSUMED);
        }

        File staged = null;
        byte[] secret = null;
        try {
            if (!port.isProvisioned() && !port.provision()) {
                return ImportResult.failed(sourceRef, keyRef, revision, ERROR_KEYSTORE_UNAVAILABLE);
            }
            final AndroidKeyStorePort.BackupPosture posture = port.backupPosture();
            if (posture.allowBackup || !posture.excluded) {
                return ImportResult.failed(sourceRef, keyRef, revision, ERROR_BACKUP_NOT_EXCLUDED);
            }

            final StageResult stage = stageToPrivateFile(channel.uri);
            if (stage.file == null) {
                return ImportResult.failed(sourceRef, keyRef, revision, stage.errorCode);
            }
            staged = stage.file;
            if (staged.length() == 0L) {
                return ImportResult.failed(sourceRef, keyRef, revision, ERROR_SOURCE_EMPTY);
            }

            secret = readAll(staged);
            if (secret.length == 0) {
                return ImportResult.failed(sourceRef, keyRef, revision, ERROR_SOURCE_EMPTY);
            }
            final AndroidKeyStorePort.SealResult sealed = port.seal(keyRef, revision, secret);
            if (!sealed.ok) {
                return ImportResult.failed(sourceRef, keyRef, revision, ERROR_SEAL_FAILED);
            }
            return ImportResult.succeeded(sourceRef, keyRef, revision, sealed.byteLength);
        } catch (IOException | RuntimeException error) {
            // 不回显异常细节（可能含 URI / 路径）；只给可机读码。
            return ImportResult.failed(sourceRef, keyRef, revision, ERROR_READ_FAILED);
        } finally {
            if (secret != null) {
                Arrays.fill(secret, (byte) 0); // ★ 落零：明文留在堆上的一律清零
            }
            if (staged != null) {
                //noinspection ResultOfMethodCallIgnored
                staged.delete(); // ★ 删除中间文件（无论成败）
            }
            revokeGrant(channel.uri); // ★ 撤销临时 URI 授权
            channels.remove(sourceRef); // 焚毁句柄；再次消费 → secret_source_unknown
        }
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    /**
     * 把临时授权的 content URI 复制进 App 私有 **no-backup** 目录的中间文件。
     * 复制期间用 {@link #MAX_SECRET_BYTES} 封顶；超限或读取失败即删除半成品并返回错误码。
     */
    private StageResult stageToPrivateFile(Uri uri) {
        final File dir = new File(context.getNoBackupFilesDir(), STAGE_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            return new StageResult(null, ERROR_READ_FAILED);
        }
        final File out = new File(dir, "stage-" + seq + ".bin");
        InputStream in = null;
        OutputStream os = null;
        try {
            final ContentResolver resolver = context.getContentResolver();
            in = resolver.openInputStream(uri);
            if (in == null) {
                return new StageResult(null, ERROR_READ_FAILED);
            }
            os = new FileOutputStream(out);
            final byte[] buffer = new byte[COPY_CHUNK];
            int total = 0;
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (n == 0) {
                    continue;
                }
                total += n;
                if (total > MAX_SECRET_BYTES) {
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    return new StageResult(null, ERROR_TOO_LARGE);
                }
                os.write(buffer, 0, n);
            }
            os.flush();
            return new StageResult(out, null);
        } catch (IOException | SecurityException error) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            return new StageResult(null, ERROR_READ_FAILED);
        } finally {
            closeQuietly(in);
            closeQuietly(os);
        }
    }

    /** 撤销临时读授权。失败不抛给调用者，也不打印 URI。 */
    private void revokeGrant(Uri uri) {
        if (uri == null) {
            return;
        }
        try {
            context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (RuntimeException ignored) {
            // 撤销失败属尽力而为；不把 URI 写进日志。
        }
    }

    private static byte[] readAll(File file) throws IOException {
        final byte[] buf = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < buf.length) {
                final int n = in.read(buf, read, buf.length - read);
                if (n < 0) {
                    break;
                }
                read += n;
            }
        }
        return buf;
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException ignored) {
            // 关闭失败无需上报，且不打印。
        }
    }

    /** 每个句柄的状态：**只有** URI 引用与一次性标记，不含明文。 */
    private static final class Channel {
        final Uri uri;
        final AtomicBoolean consumed = new AtomicBoolean(false);

        Channel(Uri uri) {
            this.uri = uri;
        }
    }

    /** 中间文件的暂存结果（内部用；不出口）。 */
    private static final class StageResult {
        final File file;
        final String errorCode;

        StageResult(File file, String errorCode) {
            this.file = file;
            this.errorCode = errorCode;
        }
    }

    // ------------------------------------------------------------------
    // 出口形状（与 TS 侧 ImportSourceProvider / KeyManager 结果对应）
    // ------------------------------------------------------------------

    /** {@link #openChannel} 的结果：只给句柄，不含明文。 */
    public static final class ChannelResult {
        public final boolean ok;
        public final String sourceRef;
        public final String errorCode;

        ChannelResult(boolean ok, String sourceRef, String errorCode) {
            this.ok = ok;
            this.sourceRef = sourceRef;
            this.errorCode = errorCode;
        }
    }

    /** 一次导入的结果：**只有元数据**（无明文、无密文）。 */
    public static final class ImportResult {
        public final boolean ok;
        public final String sourceRef;
        public final String keyRef;
        public final int revision;
        public final int byteLength;
        public final String errorCode;

        private ImportResult(boolean ok, String sourceRef, String keyRef, int revision, int byteLength, String errorCode) {
            this.ok = ok;
            this.sourceRef = sourceRef;
            this.keyRef = keyRef;
            this.revision = revision;
            this.byteLength = byteLength;
            this.errorCode = errorCode;
        }

        static ImportResult succeeded(String sourceRef, String keyRef, int revision, int byteLength) {
            return new ImportResult(true, sourceRef, keyRef, revision, byteLength, null);
        }

        static ImportResult failed(String sourceRef, String keyRef, int revision, String errorCode) {
            return new ImportResult(false, sourceRef, keyRef, revision, 0, errorCode);
        }
    }
}
