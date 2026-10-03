package com.potbot.demo;

import android.content.Context;
import android.os.StatFs;

import org.json.JSONObject;

import java.io.File;
import java.util.Locale;

/**
 * APP-07（授权入口 / 撤销 / 账号与服务连接 / 额度与存储管理）—— **唯一**的账号与容量入口。
 *
 * <p><b>凭据纪律（本类最重要的一条）：</b>
 * <ul>
 *   <li>凭据的**值**只在 {@link PotbotEndpoints} 的私有存储里，本类只读写、**从不**回显、
 *       **从不**进日志、**从不**进给页面的 JSON（只报"有没有配置"）；</li>
 *   <li>{@link #beginAuthorize} 收到凭据后直接交给 {@link PotbotEndpoints#setCredential}，
 *       中途**不打印**、不拼进异常消息；</li>
 *   <li>{@link #revoke} 只做清除，并回报"已断开"，**不清除就说清除**是不可能的——
 *       清除失败会如实报 {@link #ST_ACCOUNT_REVOKE_FAILED}。</li>
 * </ul>
 *
 * <p><b>错误必须能让人行动：</b>每个状态在 {@code strings.xml} 里的文案都带
 * "请…/试试…/选择…" 这一类**用户能照做**的下一步（见 tests 的措辞判据）。
 * 本类里没有面向用户的硬编码文本。
 *
 * <p><b>额度与存储：</b>{@link #readStorage} 只读 {@code getFilesDir()} 所在卷的
 * 可用/总字节；{@link #canAcceptInput} 在写之前预留 {@link #MIN_FREE_BYTES}——
 * 空间不足是**独立结论**，不与"写失败"混为一谈。
 *
 * <p><b>未验证（需真机）</b>：真实服务的授权往返、真实设备的可用空间数值、
 * 以及各家系统对存储查询的返回值，均未在设备上核对（本包不跑 Gradle、不连真机）。
 */
public final class PotbotAccountOps {

    // ---------------------------------------------------------------- 状态（机器可判）

    /** 已连接服务（已配置凭据）。 */
    public static final String ST_ACCOUNT_CONNECTED = "account_connected";
    /** 已断开（凭据已清除）。 */
    public static final String ST_ACCOUNT_DISCONNECTED = "account_disconnected";
    /** 还没连接，需要先连接。 */
    public static final String ST_ACCOUNT_AUTH_NEEDED = "account_auth_needed";
    /** 连不上服务。 */
    public static final String ST_ACCOUNT_SERVICE_UNREACHABLE = "account_service_unreachable";
    /** 断开失败（凭据可能仍在）。 */
    public static final String ST_ACCOUNT_REVOKE_FAILED = "account_revoke_failed";
    /** 空间不足。 */
    public static final String ST_QUOTA_LOW = "account_quota_low";
    /** 空间充足。 */
    public static final String ST_QUOTA_OK = "account_quota_ok";

    /** 接受一份新内容前预留的可用空间。 */
    public static final long MIN_FREE_BYTES = 32L * 1024L * 1024L;

    private PotbotAccountOps() {
    }

    /** 状态 → 文案资源号（文案只在 strings.xml）。 */
    public static int messageRes(String status) {
        if (ST_ACCOUNT_CONNECTED.equals(status)) return R.string.potbot_account_connected;
        if (ST_ACCOUNT_DISCONNECTED.equals(status)) return R.string.potbot_account_disconnected;
        if (ST_ACCOUNT_AUTH_NEEDED.equals(status)) return R.string.potbot_account_auth_needed;
        if (ST_ACCOUNT_SERVICE_UNREACHABLE.equals(status)) {
            return R.string.potbot_account_service_unreachable;
        }
        if (ST_ACCOUNT_REVOKE_FAILED.equals(status)) return R.string.potbot_account_revoke_failed;
        if (ST_QUOTA_LOW.equals(status)) return R.string.potbot_account_quota_low;
        if (ST_QUOTA_OK.equals(status)) return R.string.potbot_account_quota_ok;
        return R.string.potbot_account_auth_needed;
    }

    /** 授权入口的按钮文案资源号（入口本身要能被用户找到）。 */
    public static int authorizeEntryLabelRes() {
        return R.string.potbot_account_authorize_entry;
    }

    // ---------------------------------------------------------------- 结果

    /** 一次账号操作的结果。 */
    public static final class Decision {
        public final boolean ok;
        public final String status;

        Decision(boolean ok, String status) {
            this.ok = ok;
            this.status = status;
        }

        public static Decision ok(String status) {
            return new Decision(true, status);
        }

        public static Decision fail(String status) {
            return new Decision(false, status);
        }

        public int messageRes() {
            return PotbotAccountOps.messageRes(status);
        }
    }

    // ---------------------------------------------------------------- 连接状态

    /** 服务连接状态（**只含事实，不含凭据值**）。 */
    public static final class Connection {
        public final boolean connected;
        public final String baseUrl;
        public final boolean devUsb;

        Connection(boolean connected, String baseUrl, boolean devUsb) {
            this.connected = connected;
            this.baseUrl = baseUrl;
            this.devUsb = devUsb;
        }
    }

    /** 只读连接状态：**只报凭据有没有配置**，不返回值本身。 */
    public static Connection readConnection(Context context) {
        boolean has = false;
        String baseUrl = null;
        boolean dev = false;
        try {
            has = PotbotEndpoints.hasCredential(context);
            baseUrl = PotbotEndpoints.baseUrl(context);
            dev = PotbotEndpoints.isDevUsbMode(context);
        } catch (Throwable e) {
            has = false;
        }
        return new Connection(has, baseUrl, dev);
    }

    /** 还没连接就给出"需要连接"的结论（不假装已连接）。 */
    public static Decision requireConnected(Context context) {
        return readConnection(context).connected
                ? Decision.ok(ST_ACCOUNT_CONNECTED)
                : Decision.fail(ST_ACCOUNT_AUTH_NEEDED);
    }

    /**
     * 授权入口：把用户拿到的凭据存起来（走 {@link PotbotEndpoints#setCredential}）。
     * **凭据的值不进日志、不进回报、不进给页面的 JSON。**
     */
    public static Decision beginAuthorize(Context context, String credential) {
        if (context == null || credential == null || credential.trim().isEmpty()) {
            return Decision.fail(ST_ACCOUNT_AUTH_NEEDED);
        }
        try {
            PotbotEndpoints.setCredential(context, credential);
        } catch (Throwable e) {
            // 刻意只报类型，不带消息——异常消息可能夹带凭据。
            return Decision.fail(ST_ACCOUNT_SERVICE_UNREACHABLE);
        }
        return Decision.ok(ST_ACCOUNT_CONNECTED);
    }

    /** 撤销：清除本机凭据；清除失败如实报（绝不宣称已断开）。 */
    public static Decision revoke(Context context) {
        if (context == null) {
            return Decision.fail(ST_ACCOUNT_REVOKE_FAILED);
        }
        try {
            PotbotEndpoints.clearCredential(context);
        } catch (Throwable e) {
            return Decision.fail(ST_ACCOUNT_REVOKE_FAILED);
        }
        if (PotbotEndpoints.hasCredential(context)) {
            // 读回仍是"有凭据"——那就是没清掉，不能报已断开。
            return Decision.fail(ST_ACCOUNT_REVOKE_FAILED);
        }
        return Decision.ok(ST_ACCOUNT_DISCONNECTED);
    }

    // ---------------------------------------------------------------- 额度与存储

    /** 存储信息（字节）。 */
    public static final class Storage {
        public final long freeBytes;
        public final long totalBytes;
        public final boolean readable;

        Storage(long freeBytes, long totalBytes, boolean readable) {
            this.freeBytes = freeBytes;
            this.totalBytes = totalBytes;
            this.readable = readable;
        }
    }

    /** 只读本应用私有目录所在卷的可用/总空间；读不到时 readable=false（不编数字）。 */
    public static Storage readStorage(Context context) {
        if (context == null) {
            return new Storage(0L, 0L, false);
        }
        try {
            File dir = context.getFilesDir();
            if (dir == null) {
                return new Storage(0L, 0L, false);
            }
            StatFs stat = new StatFs(dir.getAbsolutePath());
            long blockSize = stat.getBlockSizeLong();
            long free = stat.getAvailableBlocksLong() * blockSize;
            long total = stat.getBlockCountLong() * blockSize;
            return new Storage(free, total, true);
        } catch (Throwable e) {
            return new Storage(0L, 0L, false);
        }
    }

    /** 接一份约 incomingBytes 的内容前先看空间；不够就明确报 {@link #ST_QUOTA_LOW}。 */
    public static Decision canAcceptInput(Context context, long incomingBytes) {
        Storage s = readStorage(context);
        if (!s.readable) {
            // 读不到空间不等于空间不足，但也不能假装充足——按"需要用户确认"处理。
            return Decision.fail(ST_QUOTA_LOW);
        }
        long need = Math.max(0L, incomingBytes);
        if (s.freeBytes - need < MIN_FREE_BYTES) {
            return Decision.fail(ST_QUOTA_LOW);
        }
        return Decision.ok(ST_QUOTA_OK);
    }

    /** 人类可读的字节数（给"剩余 %1$s"这类文案用）。 */
    public static String formatBytes(long bytes) {
        if (bytes < 0) {
            return "0 B";
        }
        if (bytes < 1024L) {
            return bytes + " B";
        }
        double kb = bytes / 1024.0;
        if (kb < 1024.0) {
            return String.format(Locale.ROOT, "%.0f KB", kb);
        }
        double mb = kb / 1024.0;
        if (mb < 1024.0) {
            return String.format(Locale.ROOT, "%.1f MB", mb);
        }
        return String.format(Locale.ROOT, "%.1f GB", mb / 1024.0);
    }

    // ---------------------------------------------------------------- 给页面看的结果

    /** 只读 JSON：连接状态 + 存储额度。**任何字段都不含凭据值**。 */
    public static String describeJson(Context context) {
        try {
            Connection c = readConnection(context);
            Storage s = readStorage(context);
            JSONObject o = new JSONObject();
            o.put("connected", c.connected);
            o.put("baseUrl", c.baseUrl == null ? JSONObject.NULL : c.baseUrl);
            o.put("devUsbMode", c.devUsb);
            o.put("storageReadable", s.readable);
            o.put("freeBytes", s.freeBytes);
            o.put("totalBytes", s.totalBytes);
            o.put("freeText", formatBytes(s.freeBytes));
            return o.toString();
        } catch (Throwable e) {
            return "{\"connected\":false}";
        }
    }
}
