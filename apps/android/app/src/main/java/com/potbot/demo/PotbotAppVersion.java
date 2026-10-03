package com.potbot.demo;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.Locale;

/**
 * APP-01：**版本身份可核对**。
 *
 * 打包时 {@code versionCode}/{@code versionName} 来自 {@code apps/android/version.properties}；
 * 同一文件里的 {@code productVersion} 被注入为字符串资源 {@code R.string.potbot_product_version}
 * （见 {@code apps/android/app/build.gradle} 的 {@code resValue}）。
 *
 * 于是"可核对"是**在设备上算出来的**，不是一句声明：
 *   - {@link #read(Context)} 从 PackageManager 读**真正装上去的** versionName/versionCode；
 *   - 再从资源读**产品版本**；
 *   - {@link Identity#consistent} 只有当两者相等（且都非空）才为 true。
 *
 * 只有当 {@code consistent} 为 true 时，宿主才会对外宣称"版本身份一致"；不一致时
 * **如实报不一致**并把两个值都带出来（不掩盖、不改写），见 MainActivity 的状态回报。
 *
 * 说明：本类只读身份，不做任何网络或文件写入。
 */
public final class PotbotAppVersion {

    /** 由 build.gradle 的 resValue 生成；此处只做**常量名**引用，值不在此文件里。 */
    private static final String RES_PRODUCT_VERSION = "potbot_product_version";

    private PotbotAppVersion() {
    }

    /** 版本身份快照。字段一律**原样**携带读到的值，不做"看起来更合理"的修补。 */
    public static final class Identity {
        /** 设备上实际安装的 versionName（读不到时为 null）。 */
        public final String installedVersionName;
        /** 设备上实际安装的 versionCode（读不到时为 -1）。 */
        public final long installedVersionCode;
        /** 由 build.gradle 注入的产品版本资源（读不到时为 null）。 */
        public final String productVersion;
        /** 读身份本身是否成功（PackageManager 是否给出包信息）。 */
        public final boolean readable;
        /** 读不到时的原因（可读时为 ""）。 */
        public final String detail;

        Identity(String installedVersionName, long installedVersionCode,
                 String productVersion, boolean readable, String detail) {
            this.installedVersionName = installedVersionName;
            this.installedVersionCode = installedVersionCode;
            this.productVersion = productVersion;
            this.readable = readable;
            this.detail = detail == null ? "" : detail;
        }

        /** 打包版本名与产品版本是否**一致**——只有这一条为真才算"版本身份可核对通过"。 */
        public boolean isConsistent() {
            return readable
                    && installedVersionName != null && !installedVersionName.isEmpty()
                    && productVersion != null && !productVersion.isEmpty()
                    && installedVersionName.equals(productVersion);
        }

        /** 人类可读摘要（不含任何密钥；可安全写入日志）。 */
        public String describe() {
            if (!readable) {
                return "版本身份不可读（" + detail + "）";
            }
            return "版本 " + installedVersionName + "（versionCode " + installedVersionCode
                    + "），产品版本 " + productVersion
                    + "，" + (isConsistent() ? "一致" : "**不一致**");
        }
    }

    /** 读一次版本身份。任何异常都不抛出，而是转成 {@code readable=false} + 原因。 */
    public static Identity read(Context context) {
        if (context == null) {
            return new Identity(null, -1L, null, false, "context 为空");
        }
        String installedName = null;
        long installedCode = -1L;
        boolean readable = false;
        String detail = "";
        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo info = pm.getPackageInfo(context.getPackageName(), 0);
            if (info != null) {
                installedName = info.versionName;
                installedCode = versionCodeOf(info);
                readable = true;
            } else {
                detail = "PackageManager 未返回包信息";
            }
        } catch (PackageManager.NameNotFoundException e) {
            detail = "NameNotFoundException";
        } catch (Throwable e) {
            detail = e.getClass().getSimpleName() + " " + safeMessage(e);
        }

        String productVersion = null;
        try {
            productVersion = context.getString(
                    context.getResources().getIdentifier(
                            RES_PRODUCT_VERSION, "string", context.getPackageName()));
        } catch (Throwable e) {
            // 资源缺失不致命：consistent 会自然为 false，并如实反映"读不到产品版本"。
            productVersion = null;
        }
        if (productVersion != null && productVersion.isEmpty()) {
            productVersion = null;
        }
        return new Identity(installedName, installedCode, productVersion, readable, detail);
    }

    /** 取 versionCode，兼容 API 28 前后两种字段。 */
    @SuppressWarnings("deprecation")
    private static long versionCodeOf(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.getLongVersionCode();
        }
        return info.versionCode;
    }

    private static String safeMessage(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return "";
        }
        return m.length() > 160 ? m.substring(0, 160) : m;
    }

    /** 版本号字符串形态校验（供设置/自检复用，避免把任意串当版本号显示）。 */
    public static boolean looksLikeVersion(String value) {
        if (value == null) {
            return false;
        }
        return value.matches("(?i)[0-9]+(\\.[0-9]+){1,3}([-.+][0-9a-z.]+)?");
    }

    static String lower(String value) {
        return value == null ? null : value.toLowerCase(Locale.ROOT);
    }
}
