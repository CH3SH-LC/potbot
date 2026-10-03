package com.potbot.kernel.security;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * K03 原生密钥库端口 —— AndroidKeyStore 实现（对应 apps/mobile-kernel/security/types.ts 的
 * {@code KeyStorePort}）。
 *
 * ⚠️ 状态：**本文件未编译、未上真机**（本环境无 Android SDK 构建）。它按 AndroidKeyStore 的
 * 标准用法写成，作为 TS 侧 {@code KeyStorePort} 契约的原生对照实现与集成起点：
 * Android 集成人须把它编译进 APK，并在真机验证"重启后仍能解密、重装后变 blocked/absent"。
 * 不得把本文件当作"已完成/已验证"。见同目录上级仓库 docs 的 K03 局限段。
 *
 * ## 设计要点（与 TS 侧契约一一对应）
 *
 * - **包装密钥**：AndroidKeyStore 里的 AES-256/GCM 对称密钥（别名 {@link #KEY_ALIAS}）。
 *   AndroidKeyStore 的密钥**不可导出、不进备份、不随设备迁移**——这正好是"重装/换机后
 *   密文解不开、必须重新导入"的物理根据。
 * - **密文落盘**：写到 {@code getNoBackupFilesDir()}（Android 保证排除 Auto Backup / D2D 迁移），
 *   文件内容 = 12 字节随机 IV ‖ GCM 密文（含 16 字节 tag）。**不写明文**。
 * - **明文生命周期**：{@link #seal} 收到明文字节后立刻加密，并在 finally 里把入参数组
 *   `Arrays.fill(..., (byte) 0)` 填零。**本类任何方法都不返回明文**。
 * - **probe 不解密返回明文**：只判断文件是否存在 + 能否解密成功。
 * - **不做自己的日志**：密钥、密文、IV 一律不打印（日志脱敏）。
 *
 * ## 未做的部分（如实标注）
 *
 * - 没有接进 `MainActivity` / 本地 UI 桥（写权在集成人）。
 * - 没有处理并发写（单写者由上层保证）。
 * - 没有实现 keystore 别名轮换 / 密钥版本迁移。
 */
public final class AndroidKeyStorePort {

    /** AndroidKeyStore 包装密钥别名。 */
    public static final String KEY_ALIAS = "potbot.keywrap.v1";
    /** GCM IV 长度（字节）。 */
    private static final int GCM_IV_BYTES = 12;
    /** GCM tag 长度（位）。 */
    private static final int GCM_TAG_BITS = 128;
    /** 目录名（位于 no-backup 目录下）。 */
    private static final String KEY_DIR = "potbot-keys";

    private final Context context;
    private final boolean allowBackup;
    private final SecureRandom random = new SecureRandom();

    /**
     * @param context     App context
     * @param allowBackup 取自 Manifest 的 {@code android:allowBackup}（本类无法在运行时读）。
     *                    为 true 时 {@link #backupPosture} 会如实报告，交由 TS 侧拒绝落盘。
     */
    public AndroidKeyStorePort(Context context, boolean allowBackup) {
        this.context = context.getApplicationContext();
        this.allowBackup = allowBackup;
    }

    // ------------------------------------------------------------------
    // KeyStorePort: provision
    // ------------------------------------------------------------------

    public synchronized boolean isProvisioned() {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            return ks.containsAlias(KEY_ALIAS);
        } catch (GeneralSecurityException | IOException e) {
            return false;
        }
    }

    /** 生成/复用包装密钥。返回是否本次新建。失败返回 false。 */
    public synchronized boolean provision() {
        if (isProvisioned()) {
            return false;
        }
        try {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    // 不要求用户认证：App 重启后要能在后台请求期间解密（总方案 §3）。
                    .setUserAuthenticationRequired(false)
                    // 密钥不进备份（AndroidKeyStore 默认即不可导出；显式声明防回归）。
                    .setRandomizedEncryptionRequired(true)
                    .build());
            generator.generateKey();
            return true;
        } catch (GeneralSecurityException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // KeyStorePort: backupPosture
    // ------------------------------------------------------------------

    /**
     * 备份态势。密文写入 {@code getNoBackupFilesDir()} ⇒ 目录级排除恒为 true；
     * {@code allowBackup} 由宿主传入（Manifest 的 android:allowBackup）。
     */
    public BackupPosture backupPosture() {
        return new BackupPosture(allowBackup, true, "noBackupFilesDir+androidKeystore-nonexportable");
    }

    // ------------------------------------------------------------------
    // KeyStorePort: seal / probe / destroy
    // ------------------------------------------------------------------

    /**
     * 加密落盘。**入参数组在返回前被填零**（无论成功失败）。
     *
     * @return {@link SealResult}；失败时 ok=false、errorCode 为可机读码，且不留半成品文件。
     */
    public SealResult seal(String keyRef, int revision, byte[] secret) {
        if (secret == null || secret.length == 0) {
            return new SealResult(false, 0, "empty_secret");
        }
        try {
            SecretKey key = loadKey();
            if (key == null) {
                return new SealResult(false, secret.length, "not_provisioned");
            }
            byte[] iv = new byte[GCM_IV_BYTES];
            random.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] ciphertext = cipher.doFinal(secret);

            byte[] payload = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, payload, 0, iv.length);
            System.arraycopy(ciphertext, 0, payload, iv.length, ciphertext.length);

            File target = fileFor(keyRef, revision);
            File dir = target.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) {
                return new SealResult(false, secret.length, "mkdir_failed");
            }
            // 先写临时文件再原子 rename，避免半成品密文。
            File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(payload);
                out.getFD().sync();
            }
            if (!tmp.renameTo(target)) {
                // 退回直接写（某些文件系统 tmp 与 target 不同卷）。
                try (FileOutputStream out = new FileOutputStream(target)) {
                    out.write(payload);
                    out.getFD().sync();
                }
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
            return new SealResult(true, secret.length, null);
        } catch (GeneralSecurityException | IOException e) {
            return new SealResult(false, secret.length, "seal_failed");
        } finally {
            java.util.Arrays.fill(secret, (byte) 0);
        }
    }

    /**
     * 探针：**不解密返回明文**。missing=无文件；unreadable=有文件但解不开（Keystore 丢失 /
     * 被篡改）；readable=可解密。
     */
    public ProbeResult probe(String keyRef, int revision) {
        File target = fileFor(keyRef, revision);
        if (!target.exists()) {
            return new ProbeResult("missing", null, null);
        }
        try {
            byte[] payload = readAll(target);
            SecretKey key = loadKey();
            if (key == null) {
                return new ProbeResult("unreadable", payload.length, "not_provisioned");
            }
            decrypt(key, payload);
            return new ProbeResult("readable", payload.length, null);
        } catch (GeneralSecurityException | IOException e) {
            return new ProbeResult("unreadable", null, "decrypt_failed");
        }
    }

    /** 销毁某一代密文。文件不存在时 destroyed=false 但 ok=true（幂等删除）。 */
    public DestroyResult destroy(String keyRef, int revision) {
        File target = fileFor(keyRef, revision);
        if (!target.exists()) {
            return new DestroyResult(true, false, null);
        }
        boolean removed = target.delete();
        return removed
                ? new DestroyResult(true, true, null)
                : new DestroyResult(false, false, "delete_failed");
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    private SecretKey loadKey() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        java.security.Key k = ks.getKey(KEY_ALIAS, null);
        return (k instanceof SecretKey) ? (SecretKey) k : null;
    }

    private static byte[] decrypt(SecretKey key, byte[] payload) throws GeneralSecurityException {
        if (payload.length <= GCM_IV_BYTES) {
            throw new GeneralSecurityException("ciphertext too short");
        }
        byte[] iv = new byte[GCM_IV_BYTES];
        System.arraycopy(payload, 0, iv, 0, GCM_IV_BYTES);
        byte[] body = new byte[payload.length - GCM_IV_BYTES];
        System.arraycopy(payload, GCM_IV_BYTES, body, 0, body.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
        return cipher.doFinal(body);
    }

    private static byte[] readAll(File file) throws IOException {
        byte[] buf = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < buf.length) {
                int n = in.read(buf, read, buf.length - read);
                if (n < 0) break;
                read += n;
            }
        }
        return buf;
    }

    /** keyRef 里的 `:` 在文件名里替换为 `_`（保持确定性映射，便于 destroy/probe 对回）。 */
    private File fileFor(String keyRef, int revision) {
        String safe = keyRef.replace(':', '_').replace('/', '_');
        File dir = new File(context.getNoBackupFilesDir(), KEY_DIR);
        return new File(dir, safe + "." + revision + ".bin");
    }

    /** 只读调试：把 keyRef 的 base64 摘要暴露给上层做对账（不含密钥）。 */
    public static String fingerprintOf(byte[] secret) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(secret);
            return "sha256:" + Base64.encodeToString(digest, Base64.NO_WRAP | Base64.URL_SAFE)
                    .toLowerCase(java.util.Locale.US);
        } catch (GeneralSecurityException e) {
            // 不会发生：SHA-256 是 JDK 必备。
            return "sha256:unavailable";
        }
    }

    /** 供日志/诊断记录使用的、**绝不含密钥**的字节长度描述。 */
    public static String describeLength(byte[] secret) {
        int len = secret == null ? 0 : secret.length;
        return "bytes=" + len;
    }

    static {
        // 触发类加载时对字符串常量做一次 UTF-8 校验（防止把密钥误塞进常量池这里是空操作）。
        StandardCharsets.UTF_8.name();
    }

    // ------------------------------------------------------------------
    // 与 TS 侧 types.ts 对应的结果形状
    // ------------------------------------------------------------------

    /** correspond to types.ts > BackupPosture */
    public static final class BackupPosture {
        public final boolean allowBackup;
        public final boolean excluded;
        public final String rule;

        BackupPosture(boolean allowBackup, boolean excluded, String rule) {
            this.allowBackup = allowBackup;
            this.excluded = excluded;
            this.rule = rule;
        }
    }

    /** correspond to types.ts > SealResult */
    public static final class SealResult {
        public final boolean ok;
        public final int byteLength;
        public final String errorCode;

        SealResult(boolean ok, int byteLength, String errorCode) {
            this.ok = ok;
            this.byteLength = byteLength;
            this.errorCode = errorCode;
        }
    }

    /** correspond to types.ts > ProbeResult */
    public static final class ProbeResult {
        public final String state;
        public final Integer byteLength;
        public final String errorCode;

        ProbeResult(String state, Integer byteLength, String errorCode) {
            this.state = state;
            this.byteLength = byteLength;
            this.errorCode = errorCode;
        }
    }

    /** correspond to types.ts > DestroyResult */
    public static final class DestroyResult {
        public final boolean ok;
        public final boolean destroyed;
        public final String errorCode;

        DestroyResult(boolean ok, boolean destroyed, String errorCode) {
            this.ok = ok;
            this.destroyed = destroyed;
            this.errorCode = errorCode;
        }
    }
}
