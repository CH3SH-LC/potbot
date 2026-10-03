package com.potbot.demo;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * APP-05：**跨进程/进程回收的状态持久化 + 动作幂等键**（合同 R255/R256/R257）。
 *
 * 两件事分开、都要经得起"进程被回收"：
 *
 * <h3>1. 回到任务（R256）</h3>
 * {@link #saveActive}/{@link #restoreActive} 把"当前任务 id / 会话 id / 界面路由 / 页面地址"
 * 落进应用私有 {@link SharedPreferences}。**Bundle 不够**——系统强杀（用户在最近任务里划掉）
 * 时 Bundle 不会回来，而 SharedPreferences 会。冷启动后宿主据此把用户送回原任务，
 * 并把"上次已知进度"一并带回去（{@link #readProgress}）。
 *
 * <h3>2. 不重复执行（R257）</h3>
 * {@link #beginAction} 对一个 {@code (taskId, action)} 意图**只发一个幂等键**：键由
 * 一次生成并持久化的 nonce 派生（{@link #idempotencyKey}），因此
 * <b>取消/重连重试、进程重启后重试、用户连点</b>都会拿到**同一个键**，后端按 R207/R243
 * 的幂等约定去重；只有 {@link #completeAction} 之后才会允许生成新的键。
 * 这不是"假装幂等"，而是把键的**单飞**做在客户端。
 *
 * <h3>诚实边界</h3>
 * 本类只做本地持久化与键生成，**不**保证后端真的按该键去重（那要后端配合，且需真机实测）；
 * 也不把"未知进度"写成 0（{@link Progress#percent} 用 -1 表示未知）。
 */
public final class PotbotTaskState {

    /** 状态所在的私有 prefs。 */
    static final String PREFS = "potbot.app.state";

    // ---- 当前任务（用于冷启动回到任务） ----
    static final String KEY_TASK_ID = "potbot.active.taskId";
    static final String KEY_CONVERSATION_ID = "potbot.active.conversationId";
    static final String KEY_ROUTE = "potbot.active.route";
    static final String KEY_URL = "potbot.active.url";
    static final String KEY_SAVED_AT = "potbot.active.savedAtMillis";

    // ---- 后台进度（由后台作业轮询写入） ----
    static final String KEY_PROGRESS_TASK_ID = "potbot.progress.taskId";
    static final String KEY_PROGRESS_STATE = "potbot.progress.state";
    static final String KEY_PROGRESS_PERCENT = "potbot.progress.percent";
    static final String KEY_PROGRESS_MESSAGE = "potbot.progress.message";
    static final String KEY_PROGRESS_CURSOR = "potbot.progress.cursor";
    static final String KEY_PROGRESS_AT = "potbot.progress.atMillis";

    /** 幂等键台账前缀：{@code potbot.idem.<taskId>.<action>} -> nonce。 */
    static final String IDEM_PREFIX = "potbot.idem.";

    /** 进度未知时的百分比哨兵——**不把未知当 0**。 */
    public static final int PERCENT_UNKNOWN = -1;

    // ------------------------------------------------------------------
    // 任务运行态：与内核 `src/scheduler/task-lifecycle.ts` 的 TASK_RUNTIME_STATUSES 同名同义。
    // 手机侧只做**回显与判终态**，不自己发明状态。
    // ------------------------------------------------------------------
    public static final String ST_RUNNING = "running";
    public static final String ST_PAUSED = "paused";
    public static final String ST_CANCELLED = "cancelled";
    public static final String ST_TIMED_OUT = "timed_out";
    public static final String ST_FAILED = "failed";
    public static final String ST_COMPLETED = "completed";

    /** 终态（与内核 TASK_TERMINAL_STATUSES 一致）：到终态就**不再轮询**。 */
    static final String[] TERMINAL_STATUSES = {ST_CANCELLED, ST_COMPLETED};

    private PotbotTaskState() {
    }

    // ------------------------------------------------------------------
    // 动作名（幂等键的 action 段）
    // ------------------------------------------------------------------
    public static final String ACTION_CANCEL = "cancel";
    public static final String ACTION_RECONNECT = "reconnect";

    /** 当前任务的持久快照。 */
    public static final class Active {
        public final String taskId;
        public final String conversationId;
        public final String route;
        public final String url;
        public final long savedAtMillis;

        Active(String taskId, String conversationId, String route, String url, long savedAtMillis) {
            this.taskId = taskId;
            this.conversationId = conversationId;
            this.route = route;
            this.url = url;
            this.savedAtMillis = savedAtMillis;
        }

        public boolean isPresent() {
            return taskId != null && !taskId.isEmpty();
        }
    }

    /** 后台进度的持久快照。 */
    public static final class Progress {
        public final String taskId;
        public final String state;
        /** {@link #PERCENT_UNKNOWN} 表示未知——**不是 0**。 */
        public final int percent;
        public final String message;
        public final String cursor;
        public final long atMillis;

        Progress(String taskId, String state, int percent, String message, String cursor, long atMillis) {
            this.taskId = taskId;
            this.state = state;
            this.percent = percent;
            this.message = message;
            this.cursor = cursor;
            this.atMillis = atMillis;
        }

        public boolean isPresent() {
            return taskId != null && !taskId.isEmpty();
        }

        public boolean isTerminal() {
            return isTerminalState(state);
        }
    }

    /** 一次动作意图的幂等键。 */
    public static final class ActionKey {
        /** 派生的幂等键（64 位十六进制）。 */
        public final String key;
        public final String action;
        /** true = 复用了**已存在**的键（说明这是一次重试/连点，不是新意图）。 */
        public final boolean reused;

        ActionKey(String key, String action, boolean reused) {
            this.key = key;
            this.action = action;
            this.reused = reused;
        }
    }

    /** 该状态是否终态（照抄内核口径，不另立一套）。 */
    public static boolean isTerminalState(String state) {
        if (state == null) {
            return false;
        }
        for (String terminal : TERMINAL_STATUSES) {
            if (terminal.equals(state)) {
                return true;
            }
        }
        return false;
    }

    /** 是否是内核认识的运行态（防止把任意字符串当状态显示）。 */
    public static boolean isKnownState(String state) {
        if (state == null) {
            return false;
        }
        return state.equals(ST_RUNNING) || state.equals(ST_PAUSED)
                || state.equals(ST_CANCELLED) || state.equals(ST_TIMED_OUT)
                || state.equals(ST_FAILED) || state.equals(ST_COMPLETED);
    }

    // ------------------------------------------------------------------
    // 1) 当前任务
    // ------------------------------------------------------------------

    /** 记下"用户当前停在哪个任务"。taskId 为空则视为清除。 */
    public static void saveActive(Context context, String taskId, String conversationId,
                                  String route, String url) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return;
        }
        if (taskId == null || taskId.isEmpty()) {
            clearActive(context);
            return;
        }
        try {
            prefs.edit()
                    .putString(KEY_TASK_ID, taskId)
                    .putString(KEY_CONVERSATION_ID, orEmpty(conversationId))
                    .putString(KEY_ROUTE, orEmpty(route))
                    .putString(KEY_URL, orEmpty(url))
                    .putLong(KEY_SAVED_AT, System.currentTimeMillis())
                    .commit();
        } catch (Throwable e) {
            // 持久化失败不致命：下次冷启动会退回首页，而不是崩溃。
        }
    }

    /** 读回当前任务；没有则返回 null。 */
    public static Active restoreActive(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return null;
        }
        try {
            String taskId = prefs.getString(KEY_TASK_ID, null);
            if (taskId == null || taskId.isEmpty()) {
                return null;
            }
            return new Active(taskId,
                    prefs.getString(KEY_CONVERSATION_ID, null),
                    prefs.getString(KEY_ROUTE, null),
                    prefs.getString(KEY_URL, null),
                    prefs.getLong(KEY_SAVED_AT, 0L));
        } catch (Throwable e) {
            return null;
        }
    }

    /** 清除"当前任务"（任务到达终态或被用户关闭时调用）。 */
    public static void clearActive(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return;
        }
        try {
            prefs.edit()
                    .remove(KEY_TASK_ID)
                    .remove(KEY_CONVERSATION_ID)
                    .remove(KEY_ROUTE)
                    .remove(KEY_URL)
                    .remove(KEY_SAVED_AT)
                    .commit();
        } catch (Throwable e) {
            // 忽略：清除失败只会导致下次冷启动多恢复一次。
        }
    }

    // ------------------------------------------------------------------
    // 2) 后台进度（前台不常开也能获知——由后台作业写入，冷启动读回）
    // ------------------------------------------------------------------

    /** 写入一次后台进度（后台作业轮询到后调用）。percent 用 {@link #PERCENT_UNKNOWN} 表示未知。 */
    public static void saveProgress(Context context, String taskId, String state,
                                    int percent, String message, String cursor) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null || taskId == null || taskId.isEmpty()) {
            return;
        }
        try {
            prefs.edit()
                    .putString(KEY_PROGRESS_TASK_ID, taskId)
                    .putString(KEY_PROGRESS_STATE, orEmpty(state))
                    .putInt(KEY_PROGRESS_PERCENT, percent)
                    .putString(KEY_PROGRESS_MESSAGE, orEmpty(message))
                    .putString(KEY_PROGRESS_CURSOR, orEmpty(cursor))
                    .putLong(KEY_PROGRESS_AT, System.currentTimeMillis())
                    .commit();
        } catch (Throwable e) {
            // 忽略：进度写失败只影响展示，不影响任务本身。
        }
    }

    /** 读回后台进度；没有则返回 null。 */
    public static Progress readProgress(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return null;
        }
        try {
            String taskId = prefs.getString(KEY_PROGRESS_TASK_ID, null);
            if (taskId == null || taskId.isEmpty()) {
                return null;
            }
            return new Progress(taskId,
                    prefs.getString(KEY_PROGRESS_STATE, null),
                    prefs.getInt(KEY_PROGRESS_PERCENT, PERCENT_UNKNOWN),
                    prefs.getString(KEY_PROGRESS_MESSAGE, null),
                    prefs.getString(KEY_PROGRESS_CURSOR, null),
                    prefs.getLong(KEY_PROGRESS_AT, 0L));
        } catch (Throwable e) {
            return null;
        }
    }

    public static void clearProgress(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return;
        }
        try {
            prefs.edit()
                    .remove(KEY_PROGRESS_TASK_ID)
                    .remove(KEY_PROGRESS_STATE)
                    .remove(KEY_PROGRESS_PERCENT)
                    .remove(KEY_PROGRESS_MESSAGE)
                    .remove(KEY_PROGRESS_CURSOR)
                    .remove(KEY_PROGRESS_AT)
                    .commit();
        } catch (Throwable e) {
            // 忽略
        }
    }

    // ------------------------------------------------------------------
    // 3) 动作幂等键（取消/重连不重复执行）
    // ------------------------------------------------------------------

    /**
     * 取（或首次生成）一次动作意图的幂等键。
     *
     * 同一个 {@code (taskId, action)} 在 {@link #completeAction} 之前，无论调用多少次、
     * 无论进程是否重启，都返回**同一个键**——这就是"取消/重连不会重复执行"的客户端锚点。
     */
    public static ActionKey beginAction(Context context, String taskId, String action) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null || taskId == null || taskId.isEmpty()
                || action == null || action.isEmpty()) {
            return null;
        }
        String ledgerKey = ledgerKey(taskId, action);
        try {
            String existing = prefs.getString(ledgerKey, null);
            if (existing != null && !existing.isEmpty()) {
                return new ActionKey(idempotencyKey(taskId, action, existing), action, true);
            }
            String nonce = newNonce();
            prefs.edit().putString(ledgerKey, nonce).commit();
            // 读回核对：只有确认写进去了才把键交出去，避免"以为记住了其实没记住"。
            String readBack = prefs.getString(ledgerKey, null);
            if (readBack == null || !readBack.equals(nonce)) {
                return null;
            }
            return new ActionKey(idempotencyKey(taskId, action, nonce), action, false);
        } catch (Throwable e) {
            return null;
        }
    }

    /** 只读地看当前意图的键（不存在返回 null）；**不**创建。 */
    public static ActionKey peekAction(Context context, String taskId, String action) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null || taskId == null || taskId.isEmpty()
                || action == null || action.isEmpty()) {
            return null;
        }
        try {
            String nonce = prefs.getString(ledgerKey(taskId, action), null);
            if (nonce == null || nonce.isEmpty()) {
                return null;
            }
            return new ActionKey(idempotencyKey(taskId, action, nonce), action, true);
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * 意图**已被后端确认受理**后才调用。此后同一个 (taskId, action) 会拿到新键
     * ——这是**新的一次意图**，不是重试。
     */
    public static void completeAction(Context context, String taskId, String action) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null || taskId == null || taskId.isEmpty()
                || action == null || action.isEmpty()) {
            return;
        }
        try {
            prefs.edit().remove(ledgerKey(taskId, action)).commit();
        } catch (Throwable e) {
            // 忽略
        }
    }

    /** 幂等键 = sha256(taskId | action | nonce) 的十六进制。确定性、可复算。 */
    static String idempotencyKey(String taskId, String action, String nonce) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest((taskId + "|" + action + "|" + nonce)
                    .getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Throwable e) {
            return null;
        }
    }

    private static String ledgerKey(String taskId, String action) {
        return IDEM_PREFIX + taskId + "." + action;
    }

    /** 进程内一次性的 nonce（只作为键的输入，不是密钥；不写入任何外部通道）。 */
    private static String newNonce() {
        long now = System.currentTimeMillis();
        long nano = System.nanoTime();
        String seed = now + "-" + nano + "-" + (now ^ (nano >>> 7));
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(seed.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                sb.append(String.format(Locale.ROOT, "%02x", digest[i]));
            }
            return sb.toString();
        } catch (Throwable e) {
            return Long.toHexString(now);
        }
    }

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

    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }
}
