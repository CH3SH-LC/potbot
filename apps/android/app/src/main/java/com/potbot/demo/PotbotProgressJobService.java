package com.potbot.demo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;

/**
 * APP-05：**前台不常开也能获知后台进度**（合同 R255/R256）。
 *
 * 机制选择：用平台自带的 {@link JobScheduler} + {@link JobService}——
 *   - 它把"后台工作"与 Activity 生命周期**解耦**（R255：模型/服务器工作不必绑在 Activity 上）；
 *   - 进程被回收、设备进入 doze，系统仍会在允许的窗口把作业拉起（**不保证实时**，系统会节流）；
 *   - **不需要任何新权限**（声明 {@code BIND_JOB_SERVICE} 是组件属性，不是 uses-permission）。
 *
 * 每次被拉起只做一次"读进度"：
 *   ① 若当前没有活动任务、或上次进度已是终态 ⇒ 直接结束**不再重排**（不空转）；
 *   ② 否则带上 {@link PotbotTaskState} 里保存的**续取游标**去后端读一次进度
 *      （R208：断线后从上一次游标继续，不重放已消费内容）；
 *   ③ 读到的进度**原样**写进 {@link PotbotTaskState}（未知就是未知，不写 0）；
 *   ④ 尝试发一条通知（带深链回任务的 PendingIntent）；发不出就**如实记录原因**，不假装发过；
 *   ⑤ 重新排一次作业（带最小延迟），直到终态。
 *
 * <h3>明确未验证 / 已知缺口（不得掩盖）</h3>
 * <ul>
 *   <li>{@code POST_NOTIFICATIONS}（FA-APP-NOTIFY-PERM）**已声明**在清单里（权限白名单由
 *       Word 包与完整 App 的测试共同锁定为 INTERNET + ACCESS_NETWORK_STATE +
 *       POST_NOTIFICATIONS；白名单外的权限仍报红）。声明 ≠ 已授权：API 33+ 上由
 *       {@link PotbotNotificationPermission#requestIfNeeded(android.app.Activity)} 在回前台时请求一次，用户拒绝后
 *       不再重复打扰；此时通知发不出去，只能依赖"回到 App 时读回持久进度"，
 *       {@link #NOTIFY_DENIED} 会如实记录原因。**真机上的弹窗/授权/降级行为未验证（需真机）。**</li>
 *   <li>进度接口路径 {@link #PROGRESS_PATH_PREFIX} 是按既有 REST 习惯的**假设**，
 *       未对真实后端核对；404/405 时按 {@link #STATE_ENDPOINT_UNSUPPORTED} 如实记，
 *       **不猜测、不编造进度**。</li>
 *   <li>真机上的后台拉起时机、doze 行为、通知是否真出现，均**未验证（需真机）**。</li>
 * </ul>
 */
public class PotbotProgressJobService extends JobService {

    private static final String TAG = "PotbotProgress";

    /** 作业 id（固定，重复 schedule 会覆盖）。 */
    static final int JOB_ID = 0x706F74;
    /** 通知渠道 / 通知 id。 */
    static final String CHANNEL_ID = "potbot.background.progress";
    static final int NOTIFICATION_ID = 0x706F01;
    /** 两次读进度之间的最小延迟（系统另有节流，实际间隔可能更长）。 */
    static final long MIN_INTERVAL_MS = 15_000L;
    static final long DEADLINE_MS = 60_000L;

    /** 读进度的路径前缀（**假设**，未对真实后端核对）。 */
    static final String PROGRESS_PATH_PREFIX = "/api/tasks/";

    /** 通知发不出去时的原因（如实记录，不假装发过）。 */
    static final String NOTIFY_DENIED = "notification_permission_not_declared_or_denied";
    static final String NOTIFY_OK = "notification_posted";
    /** 后端不支持该进度接口。 */
    static final String STATE_ENDPOINT_UNSUPPORTED = "endpoint_unsupported";
    /** 读取失败（网络/超时/解析）。 */
    static final String STATE_READ_FAILED = "progress_read_failed";

    private static final int HTTP_TIMEOUT_MS = 20_000;
    private static final long MAX_BODY_BYTES = 256L * 1024L;

    // ------------------------------------------------------------------
    // 调度
    // ------------------------------------------------------------------

    /** 排一次后台进度作业（幂等：同 id 覆盖）。 */
    static void schedule(Context context) {
        schedule(context, 0L);
    }

    /** 排一次后台进度作业，带最小延迟。 */
    static void schedule(Context context, long minLatencyMs) {
        if (context == null) {
            return;
        }
        try {
            JobScheduler scheduler = (JobScheduler)
                    context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (scheduler == null) {
                return;
            }
            ComponentName component = new ComponentName(context, PotbotProgressJobService.class);
            JobInfo.Builder builder = new JobInfo.Builder(JOB_ID, component)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setMinimumLatency(Math.max(0L, minLatencyMs))
                    .setOverrideDeadline(DEADLINE_MS);
            scheduler.schedule(builder.build());
        } catch (Throwable e) {
            Log.w(TAG, "无法排后台进度作业", e);
        }
    }

    /** 取消后台进度作业（回到前台 / 任务终态时调用）。 */
    static void cancel(Context context) {
        if (context == null) {
            return;
        }
        try {
            JobScheduler scheduler = (JobScheduler)
                    context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (scheduler != null) {
                scheduler.cancel(JOB_ID);
            }
        } catch (Throwable e) {
            Log.w(TAG, "无法取消后台进度作业", e);
        }
    }

    /** 是否有已排的作业（供自检/回报）。 */
    static boolean isScheduled(Context context) {
        if (context == null) {
            return false;
        }
        try {
            JobScheduler scheduler = (JobScheduler)
                    context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (scheduler == null) {
                return false;
            }
            List<JobInfo> pending = scheduler.getAllPendingJobs();
            if (pending == null) {
                return false;
            }
            for (JobInfo info : pending) {
                if (info != null && info.getId() == JOB_ID) {
                    return true;
                }
            }
            return false;
        } catch (Throwable e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // 作业执行
    // ------------------------------------------------------------------

    @Override
    public boolean onStartJob(final JobParameters params) {
        final PotbotTaskState.Active active = PotbotTaskState.restoreActive(this);
        if (active == null || !active.isPresent()) {
            // 没有活动任务：不空转，也不再重排。
            return false;
        }
        final PotbotTaskState.Progress previous = PotbotTaskState.readProgress(this);
        if (previous != null && previous.isTerminal()) {
            // 已到终态：不再轮询（通知已在终态那次发出）。
            return false;
        }

        final String taskId = active.taskId;
        final String cursor = previous == null ? null : previous.cursor;
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                boolean keepGoing = true;
                try {
                    keepGoing = pollOnce(taskId, cursor);
                } catch (Throwable e) {
                    Log.w(TAG, "后台读进度失败", e);
                    PotbotTaskState.saveProgress(PotbotProgressJobService.this, taskId,
                            null, PotbotTaskState.PERCENT_UNKNOWN,
                            STATE_READ_FAILED, cursor);
                }
                if (keepGoing) {
                    schedule(PotbotProgressJobService.this, MIN_INTERVAL_MS);
                }
                jobFinished(params, false);
            }
        }, "potbot-progress");
        worker.setDaemon(true);
        worker.start();
        return true; // 有工作在跑，系统不应立刻回收
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // 系统中断了本次执行：保留作业，稍后重试。
        return true;
    }

    /**
     * 读一次进度。返回 true 表示"还需要继续轮询"。
     * 任何失败都**如实记录**，绝不编造进度或状态。
     */
    private boolean pollOnce(String taskId, String cursor) {
        String baseUrl = PotbotEndpoints.baseUrl(this);
        String url = baseUrl + PROGRESS_PATH_PREFIX + taskId
                + (cursor == null || cursor.isEmpty() ? "" : "?cursor=" + cursor);
        String body = httpGet(url);
        if (body == null) {
            PotbotTaskState.saveProgress(this, taskId, null,
                    PotbotTaskState.PERCENT_UNKNOWN, STATE_READ_FAILED, cursor);
            return true; // 网络问题：下次再试
        }
        String state;
        int percent = PotbotTaskState.PERCENT_UNKNOWN;
        String message = null;
        String nextCursor = cursor;
        try {
            JSONObject json = new JSONObject(body);
            state = json.optString("status", null);
            if (json.has("percent") && !json.isNull("percent")) {
                percent = json.optInt("percent", PotbotTaskState.PERCENT_UNKNOWN);
            }
            message = json.optString("message", null);
            String returnedCursor = json.optString("cursor", null);
            if (returnedCursor != null && !returnedCursor.isEmpty()) {
                nextCursor = returnedCursor;
            }
        } catch (Throwable e) {
            PotbotTaskState.saveProgress(this, taskId, null,
                    PotbotTaskState.PERCENT_UNKNOWN, STATE_READ_FAILED, cursor);
            return true;
        }
        if (state == null || !PotbotTaskState.isKnownState(state)) {
            // 后端给了未知状态：如实记录，不当成成功。
            PotbotTaskState.saveProgress(this, taskId, null, percent,
                    STATE_ENDPOINT_UNSUPPORTED, nextCursor);
            return true;
        }
        PotbotTaskState.saveProgress(this, taskId, state, percent, message, nextCursor);
        notifyProgress(taskId, state, percent, message);
        return !PotbotTaskState.isTerminalState(state);
    }

    /** 发进度通知；发不出去时如实记录原因，并**不假装**已经通知到用户。 */
    private void notifyProgress(String taskId, String state, int percent, String message) {
        String reason;
        if (!canNotify()) {
            reason = NOTIFY_DENIED;
        } else {
            try {
                NotificationManager nm = (NotificationManager)
                        getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) {
                    reason = NOTIFY_DENIED;
                } else {
                    ensureChannel(nm);
                    String text = buildText(state, percent, message);
                    Notification.Builder nb = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                            ? new Notification.Builder(this, CHANNEL_ID)
                            : new Notification.Builder(this);
                    nb.setSmallIcon(android.R.drawable.stat_notify_sync)
                            .setContentTitle(getString(R.string.potbot_progress_notification_title))
                            .setContentText(text)
                            .setOnlyAlertOnce(true)
                            .setOngoing(!PotbotTaskState.isTerminalState(state))
                            .setContentIntent(openTaskIntent(taskId));
                    nm.notify(NOTIFICATION_ID, nb.build());
                    reason = NOTIFY_OK;
                }
            } catch (Throwable e) {
                reason = NOTIFY_DENIED;
            }
        }
        try {
            getSharedPreferences("potbot.app.state", Context.MODE_PRIVATE)
                    .edit()
                    .putString("potbot.progress.notified", reason)
                    .putLong("potbot.progress.notifiedAtMillis", System.currentTimeMillis())
                    .commit();
        } catch (Throwable e) {
            // 记录失败只影响可观测性，不影响任务。
        }
    }

    /** 深链回任务的 PendingIntent——用户点通知即可**回到任务**（R256）。 */
    private PendingIntent openTaskIntent(String taskId) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra(MainActivity.EXTRA_TASK_ID, taskId);
        return PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * 当前能否发通知。API &lt; 33 无需运行时权限；API ≥ 33 需要 POST_NOTIFICATIONS——
     * 而该权限**未声明**在清单里（见类注释的已知缺口），因此这里会返回 false。
     */
    private boolean canNotify() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        try {
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable e) {
            return false;
        }
    }

    private void ensureChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    getString(R.string.potbot_notification_channel),
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.potbot_notification_channel_desc));
            nm.createNotificationChannel(channel);
        } catch (Throwable e) {
            // 渠道创建失败会在 notify 时抛，由上层抓住并记为 NOTIFY_DENIED。
        }
    }

    private String buildText(String state, int percent, String message) {
        StringBuilder sb = new StringBuilder();
        sb.append("状态：").append(state);
        if (percent >= 0) {
            sb.append("（").append(percent).append("%）");
        } else {
            sb.append("（进度未知）"); // 未知不写成 0%
        }
        if (message != null && !message.isEmpty()) {
            sb.append(" ").append(message);
        }
        return sb.toString();
    }

    /** 读一次 URL 的正文；失败返回 null（调用方按"读失败"处理，不编造内容）。 */
    private String httpGet(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false); // 不跟随跳转
            PotbotEndpoints.applyAuth(this, conn);
            conn.connect();
            int code = conn.getResponseCode();
            if (code == 404 || code == 405 || code == 501) {
                // 后端没有这个进度接口：如实记为"不支持"，不编造进度。
                return "{\"status\":\"" + STATE_ENDPOINT_UNSUPPORTED + "\"}";
            }
            if (code != 200) {
                return null;
            }
            InputStream in = conn.getInputStream();
            try {
                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(in, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                    if (sb.length() > MAX_BODY_BYTES) {
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

    /** 供宿主/测试引用的状态名（小写，避免拼错）。 */
    static String lower(String value) {
        return value == null ? null : value.toLowerCase(Locale.ROOT);
    }
}
