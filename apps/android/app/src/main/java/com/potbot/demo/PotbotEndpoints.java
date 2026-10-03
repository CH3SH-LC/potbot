package com.potbot.demo;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.net.HttpURLConnection;
import java.util.Locale;

/**
 * APP-06：**日常使用不把 USB 调试连接当产品必需条件**（合同 R254/R258）。
 *
 * 现状（历史）：宿主把服务地址写死成 {@code http://127.0.0.1:8765}，而该端口要靠
 * {@code adb reverse} 才能映射到电脑上的 Node 服务 ⇒ 正常运行**以 USB 调试为前提**，
 * 与 R254「USB 只用于开发验证，不是产品运行前提」冲突。
 *
 * 本类把地址与凭据变成**可配置**的：
 * <ul>
 *   <li>{@link #baseUrl} 从应用私有 prefs 读；没配置时回退到开发默认
 *       {@link #DEV_USB_BASE_URL}（仍然可用，但**只是开发便利**，不是产品前提）；</li>
 *   <li>{@link #isDevUsbMode} 明确标出"当前正跑在回环/dev 模式"——界面据此提示，
 *       而**不假装**已经是产品部署形态；</li>
 *   <li>{@link #matchesConfiguredOrigin} 把"可信同源"从写死的回环改成**配置的那个源**，
 *       仍是**严格**的 scheme + host + port 全等（不跟随跳转、不接受子域、不接受任意主机）；</li>
 *   <li>凭据（若有）只存在应用私有 prefs，并只以请求头形式发出：
 *       **不进 APK、不进网页、不进普通日志**（{@link #describe} 只报"有无"，不报值）。</li>
 * </ul>
 *
 * 部署形态（R206）：换成远程地址**不等于**内核进了手机；本类只负责"连得上哪个后端"，
 * 不声称内核已迁移。远程后端必须是 HTTPS（明文只对回环放行，见 network_security_config.xml）。
 */
public final class PotbotEndpoints {

    /** 地址与凭据所在的私有 prefs。 */
    static final String PREFS = "potbot.endpoints";
    static final String KEY_BASE_URL = "potbot.endpoint.baseUrl";
    /** 凭据键：**值本身不写进源码、不进日志**。 */
    static final String KEY_CREDENTIAL = "potbot.endpoint.credential";

    /** 请求头名（避免与任何"看起来像密钥"的常量名混淆）。 */
    static final String HEADER_AUTHORIZATION = "Authorization";
    static final String SCHEME_BEARER = "Bearer";

    /**
     * 开发默认地址：电脑服务经 {@code adb reverse} 映射到回环。
     * **它只是默认值**——产品运行不应依赖它（R254）。
     */
    public static final String DEV_USB_BASE_URL = "http://127.0.0.1:8765";

    private PotbotEndpoints() {
    }

    /** 当前配置的服务地址（已规范化，无尾斜杠）；未配置时返回开发默认。 */
    public static String baseUrl(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs != null) {
            try {
                String raw = prefs.getString(KEY_BASE_URL, null);
                if (raw != null && !raw.isEmpty()) {
                    String normalized = normalizeBaseUrl(raw);
                    if (normalized != null) {
                        return normalized;
                    }
                }
            } catch (Throwable e) {
                // 读失败 → 回退默认，不抛。
            }
        }
        return DEV_USB_BASE_URL;
    }

    /**
     * 保存服务地址。非法地址**抛出** {@link IllegalArgumentException}（不改动现值）——
     * 与其存下一个打不开的地址再让用户困惑，不如当场拒绝。
     */
    public static void setBaseUrl(Context context, String rawUrl) {
        String normalized = normalizeBaseUrl(rawUrl);
        if (normalized == null) {
            throw new IllegalArgumentException("服务地址非法（须为 http/https 的绝对地址，不含查询串）：" + rawUrl);
        }
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            throw new IllegalStateException("无法打开地址配置存储");
        }
        prefs.edit().putString(KEY_BASE_URL, normalized).commit();
    }

    /** 恢复开发默认（回环）——测试与排障用，不删除凭据。 */
    public static void clearBaseUrl(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return;
        }
        prefs.edit().remove(KEY_BASE_URL).commit();
    }

    /**
     * 规范化并校验地址。返回 {@code scheme://host[:port][/path]}（无尾斜杠），非法返回 null。
     * 规则：scheme 限 http/https；host 非空；无 userinfo；无查询串/片段；path 前缀不得含 {@code ..}。
     */
    public static String normalizeBaseUrl(String rawUrl) {
        if (rawUrl == null) {
            return null;
        }
        String trimmed = rawUrl.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        Uri uri;
        try {
            uri = Uri.parse(trimmed);
        } catch (Throwable e) {
            return null;
        }
        if (uri == null) {
            return null;
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            return null;
        }
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            return null;
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            return null;
        }
        if (uri.getUserInfo() != null) {
            return null; // 不接受把凭据塞进 URL
        }
        if (uri.getQuery() != null || uri.getFragment() != null) {
            return null;
        }
        String path = uri.getPath();
        if (path == null || "/".equals(path)) {
            path = "";
        } else {
            while (path.endsWith("/")) {
                path = path.substring(0, path.length() - 1);
            }
            if (path.contains("..")) {
                return null;
            }
            if (!path.startsWith("/")) {
                path = "/" + path;
            }
        }
        StringBuilder sb = new StringBuilder();
        sb.append(scheme).append("://").append(host.toLowerCase(Locale.ROOT));
        int port = uri.getPort();
        if (port > 0 && !isDefaultPort(scheme, port)) {
            sb.append(':').append(port);
        }
        sb.append(path);
        return sb.toString();
    }

    private static boolean isDefaultPort(String scheme, int port) {
        return ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
    }

    /**
     * 当前是否跑在"USB/回环开发模式"。为 true 时界面应提示"这是开发连接，不是产品形态"
     * （R254：USB 只用于开发验证）。**不把它当成错误**，只是不许把它说成产品前提。
     */
    public static boolean isDevUsbMode(Context context) {
        String host = hostOf(baseUrl(context));
        return "127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host);
    }

    /**
     * 严格同源判定：给定 URL 的方案 + 主机 + 端口必须与**当前配置的服务地址**完全一致。
     *
     * 与改动前的写死回环判定**同样严格**（无子域、无跳转、无任意主机），只是把可信源
     * 从常量换成配置项——这样换后端地址不再需要改代码，同时不放松可信边界。
     */
    public static boolean matchesConfiguredOrigin(Context context, Uri candidate) {
        if (candidate == null) {
            return false;
        }
        Uri base;
        try {
            base = Uri.parse(baseUrl(context));
        } catch (Throwable e) {
            return false;
        }
        if (base == null) {
            return false;
        }
        String scheme = candidate.getScheme();
        if (scheme == null || !scheme.equalsIgnoreCase(base.getScheme())) {
            return false;
        }
        String host = candidate.getHost();
        if (host == null || !host.equalsIgnoreCase(base.getHost())) {
            return false;
        }
        return portOf(candidate, scheme) == portOf(base, base.getScheme());
    }

    // ------------------------------------------------------------------
    // 凭据（不进 APK / 网页 / 普通日志）
    // ------------------------------------------------------------------

    /** 是否已配置访问凭据（只回答有无）。 */
    public static boolean hasCredential(Context context) {
        return credential(context) != null;
    }

    /**
     * 读凭据。**调用者不得把返回值写进日志或页面**——只用于 {@link #applyAuth}。
     * 未配置返回 null。
     */
    static String credential(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return null;
        }
        try {
            String value = prefs.getString(KEY_CREDENTIAL, null);
            if (value == null || value.isEmpty()) {
                return null;
            }
            return value;
        } catch (Throwable e) {
            return null;
        }
    }

    /** 保存凭据（只进应用私有 prefs）。空串等同清除。 */
    public static void setCredential(Context context, String credential) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            throw new IllegalStateException("无法打开凭据存储");
        }
        if (credential == null || credential.trim().isEmpty()) {
            prefs.edit().remove(KEY_CREDENTIAL).commit();
            return;
        }
        prefs.edit().putString(KEY_CREDENTIAL, credential.trim()).commit();
    }

    public static void clearCredential(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return;
        }
        prefs.edit().remove(KEY_CREDENTIAL).commit();
    }

    /**
     * 给请求挂上认证头（若已配置凭据）。**只发值，不记录值**；任何异常都不打印凭据。
     */
    public static void applyAuth(Context context, HttpURLConnection connection) {
        if (connection == null) {
            return;
        }
        String value = credential(context);
        if (value == null) {
            return;
        }
        try {
            connection.setRequestProperty(HEADER_AUTHORIZATION, SCHEME_BEARER + " " + value);
        } catch (Throwable e) {
            // 不打印 value；只报类型。
        }
    }

    /**
     * 供状态回报的**无秘密**摘要：地址、是否开发模式、是否已配置凭据。
     * 凭据的值**绝不出现在这里**。
     */
    public static String describe(Context context) {
        return "{\"baseUrl\":" + quote(baseUrl(context))
                + ",\"devUsbMode\":" + isDevUsbMode(context)
                + ",\"credentialConfigured\":" + hasCredential(context) + "}";
    }

    // ------------------------------------------------------------------

    private static SharedPreferences prefs(Context context) {
        if (context == null) {
            return null;
        }
        try {
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        } catch (Throwable e) {
            return null;
        }
    }

    private static String hostOf(String url) {
        try {
            Uri uri = Uri.parse(url);
            String host = uri == null ? null : uri.getHost();
            return host == null ? "" : host.toLowerCase(Locale.ROOT);
        } catch (Throwable e) {
            return "";
        }
    }

    private static int portOf(Uri uri, String scheme) {
        int port = uri.getPort();
        if (port > 0) {
            return port;
        }
        if (scheme != null && "https".equalsIgnoreCase(scheme)) {
            return 443;
        }
        return 80;
    }

    private static String quote(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') {
                sb.append('\\');
            }
            sb.append(c);
        }
        return sb.append('"').toString();
    }
}
