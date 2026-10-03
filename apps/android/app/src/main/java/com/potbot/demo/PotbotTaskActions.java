package com.potbot.demo;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * APP-05：**取消与重连不会重复执行**（合同 R257，呼应内核的幂等键约定 R207/R243）。
 *
 * 两条动作都走同一个客户端锚点：{@link PotbotTaskState#beginAction} 给出的幂等键。
 * 同一个 {@code (taskId, action)} 在本次意图被确认受理之前**只有一个键**——用户连点、
 * 断网重试、进程重启后重试，发出的都是**同一个键**，后端据此去重；只有后端受理之后
 * （{@link PotbotTaskState#completeAction}）下一次点击才算**新意图**。
 *
 * <ul>
 *   <li>{@link #reconnect}：带上持久化的**续取游标**去读一次进度（R208）——
 *       只"续取"，不"重放"；读不到就如实报离线，**不假装已恢复**。</li>
 *   <li>{@link #cancel}：以同一幂等键 POST 取消；后端不支持该接口（404/405/501）时
 *       明确报 {@link #STATUS_CANCEL_NOT_SUPPORTED}，**绝不宣称已取消**（R205：不假称
 *       已发生的外部副作用被撤销）。</li>
 * </ul>
 *
 * 未验证：真实后端的取消路由与去重语义**未在本包核对**（需真机 + 后端）。路径是常量，
 * 便于总协调按其真实 API 校正。
 */
public final class PotbotTaskActions {

    private static final String TAG = "PotbotTaskActions";

    /** 进度读取路径前缀（与后台作业一致）。 */
    static final String PROGRESS_PATH_PREFIX = "/api/tasks/";
    /** 取消路径后缀。 */
    static final String CANCEL_PATH_SUFFIX = "/cancel";
    /** 幂等键请求头名（后端按此去重；R243）。 */
    static final String HEADER_IDEMPOTENCY = "Idempotency-Key";

    // ---- 回报状态词表（互不相同，供页面显示） ----
    /** 重连成功并从游标续取。 */
    static final String STATUS_RECONNECT_RESUMED = "reconnect_resumed";
    /** 重连时读不到（网络/超时）。 */
    static final String STATUS_RECONNECT_OFFLINE = "reconnect_offline";
    /** 后端没有该进度接口。 */
    static final String STATUS_RECONNECT_UNSUPPORTED = "reconnect_unsupported";
    /** 取消已被后端受理。 */
    static final String STATUS_CANCEL_ACCEPTED = "cancel_accepted";
    /** 后端不支持取消接口——**没有取消任何东西**。 */
    static final String STATUS_CANCEL_NOT_SUPPORTED = "cancel_not_supported";
    /** 取消请求失败（网络/其它）。 */
    static final String STATUS_CANCEL_FAILED = "cancel_failed";
    /** 无法生成/读取幂等键（本地存储问题）。 */
    static final String STATUS_ACTION_KEY_UNAVAILABLE = "action_key_unavailable";

    private static final int HTTP_TIMEOUT_MS = 20_000;

    /** 结果回调（宿主据此回报给页面）。 */
    public interface Reporter {
        void onResult(boolean ok, String status, String message);
    }

    private PotbotTaskActions() {
    }

    /**
     * 重连：用**同一个**幂等键 + 持久游标读一次进度。不重放已消费内容（R208）。
     */
    public static void reconnect(final Context context, final String taskId, final Reporter reporter) {
        if (context == null || taskId == null || taskId.isEmpty()) {
            report(reporter, false, STATUS_ACTION_KEY_UNAVAILABLE, "taskId 为空，无法重连。");
            return;
        }
        final PotbotTaskState.ActionKey key = PotbotTaskState.beginAction(
                context, taskId, PotbotTaskState.ACTION_RECONNECT);
        if (key == null) {
            report(reporter, false, STATUS_ACTION_KEY_UNAVAILABLE,
                    "无法取得重连幂等键（本地存储不可用），未发出任何请求。");
            return;
        }
        final PotbotTaskState.Progress previous = PotbotTaskState.readProgress(context);
        final String cursor = previous == null ? null : previous.cursor;
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                String baseUrl = PotbotEndpoints.baseUrl(context);
                String url = baseUrl + PROGRESS_PATH_PREFIX + taskId
                        + (cursor == null || cursor.isEmpty() ? "" : "?cursor=" + cursor);
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setRequestMethod("GET");
                    conn.setConnectTimeout(HTTP_TIMEOUT_MS);
                    conn.setReadTimeout(HTTP_TIMEOUT_MS);
                    conn.setInstanceFollowRedirects(false);
                    conn.setRequestProperty(HEADER_IDEMPOTENCY, key.key);
                    PotbotEndpoints.applyAuth(context, conn);
                    conn.connect();
                    int code = conn.getResponseCode();
                    if (code == 404 || code == 405 || code == 501) {
                        report(reporter, false, STATUS_RECONNECT_UNSUPPORTED,
                                "后端没有进度接口（HTTP " + code + "），无法续取；未编造进度。");
                        return;
                    }
                    if (code != 200) {
                        report(reporter, false, STATUS_RECONNECT_OFFLINE,
                                "重连未成功：HTTP " + code + "。");
                        return;
                    }
                    String body = readBody(conn);
                    if (body == null) {
                        report(reporter, false, STATUS_RECONNECT_OFFLINE, "重连未成功：响应不可读。");
                        return;
                    }
                    JSONObject json = new JSONObject(body);
                    String state = json.optString("status", null);
                    int percent = json.has("percent") && !json.isNull("percent")
                            ? json.optInt("percent", PotbotTaskState.PERCENT_UNKNOWN)
                            : PotbotTaskState.PERCENT_UNKNOWN;
                    String nextCursor = json.optString("cursor", null);
                    String message = json.optString("message", null);
                    if (nextCursor == null || nextCursor.isEmpty()) {
                        nextCursor = cursor;
                    }
                    PotbotTaskState.saveProgress(context, taskId, state, percent, message, nextCursor);
                    report(reporter, true, STATUS_RECONNECT_RESUMED,
                            "已从游标续取" + (key.reused ? "（复用同一幂等键）" : "")
                                    + "：状态 " + state
                                    + (percent >= 0 ? "（" + percent + "%）" : "（进度未知）")
                                    + "，游标 " + (nextCursor == null ? "无" : nextCursor));
                } catch (Throwable e) {
                    Log.w(TAG, "重连失败", e);
                    report(reporter, false, STATUS_RECONNECT_OFFLINE,
                            "重连失败：" + e.getClass().getSimpleName() + " " + safeMessage(e));
                } finally {
                    if (conn != null) {
                        try {
                            conn.disconnect();
                        } catch (Throwable e) {
                            // 忽略
                        }
                    }
                }
            }
        }, "potbot-reconnect");
        worker.setDaemon(true);
        worker.start();
    }

    /**
     * 取消：以**同一个**幂等键 POST；后端受理才清除该键（允许下一次"新意图"）。
     * 不支持取消时明确报"未取消"，绝不宣称已取消。
     */
    public static void cancel(final Context context, final String taskId, final Reporter reporter) {
        if (context == null || taskId == null || taskId.isEmpty()) {
            report(reporter, false, STATUS_ACTION_KEY_UNAVAILABLE, "taskId 为空，无法取消。");
            return;
        }
        final PotbotTaskState.ActionKey key = PotbotTaskState.beginAction(
                context, taskId, PotbotTaskState.ACTION_CANCEL);
        if (key == null) {
            report(reporter, false, STATUS_ACTION_KEY_UNAVAILABLE,
                    "无法取得取消幂等键（本地存储不可用），未发出任何请求。");
            return;
        }
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                String baseUrl = PotbotEndpoints.baseUrl(context);
                String url = baseUrl + PROGRESS_PATH_PREFIX + taskId + CANCEL_PATH_SUFFIX;
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setRequestMethod("POST");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(HTTP_TIMEOUT_MS);
                    conn.setReadTimeout(HTTP_TIMEOUT_MS);
                    conn.setInstanceFollowRedirects(false);
                    conn.setRequestProperty(HEADER_IDEMPOTENCY, key.key);
                    conn.setRequestProperty("Content-Length", "0");
                    PotbotEndpoints.applyAuth(context, conn);
                    conn.connect();
                    int code = conn.getResponseCode();
                    if (code == 404 || code == 405 || code == 501) {
                        // 没有取消接口：**没有取消任何东西**，且**保留**幂等键（意图未受理）。
                        report(reporter, false, STATUS_CANCEL_NOT_SUPPORTED,
                                "后端没有取消接口（HTTP " + code + "）——**未取消任何任务**。");
                        return;
                    }
                    if (code >= 200 && code < 300) {
                        // 后端受理：清除该意图，允许下一次"新意图"用新键。
                        PotbotTaskState.completeAction(context, taskId, PotbotTaskState.ACTION_CANCEL);
                        report(reporter, true, STATUS_CANCEL_ACCEPTED,
                                "取消已受理（HTTP " + code + "）" + (key.reused
                                        ? "；本次复用同一幂等键（此前已发出过该取消意图）。"
                                        : "。"));
                        return;
                    }
                    report(reporter, false, STATUS_CANCEL_FAILED,
                            "取消未受理：HTTP " + code + "。");
                } catch (Throwable e) {
                    Log.w(TAG, "取消失败", e);
                    report(reporter, false, STATUS_CANCEL_FAILED,
                            "取消失败：" + e.getClass().getSimpleName() + " " + safeMessage(e));
                } finally {
                    if (conn != null) {
                        try {
                            conn.disconnect();
                        } catch (Throwable e) {
                            // 忽略
                        }
                    }
                }
            }
        }, "potbot-cancel");
        worker.setDaemon(true);
        worker.start();
    }

    private static String readBody(HttpURLConnection conn) {
        try {
            InputStream in = conn.getInputStream();
            try {
                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(in, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                    if (sb.length() > 256 * 1024) {
                        return null;
                    }
                }
                return sb.toString();
            } finally {
                try {
                    in.close();
                } catch (Throwable e) {
                    // 忽略
                }
            }
        } catch (Throwable e) {
            return null;
        }
    }

    private static void report(Reporter reporter, boolean ok, String status, String message) {
        if (reporter != null) {
            reporter.onResult(ok, status, message);
        }
    }

    private static String safeMessage(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return e == null ? "" : e.getClass().getSimpleName();
        }
        return m.length() > 200 ? m.substring(0, 200) : m;
    }
}
