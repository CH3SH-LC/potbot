package com.potbot.demo;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * APP-01：**旧数据迁移与升级失败处理的显式路径**。
 *
 * 这条路径必须"存在且可核对"，而不是"希望不会用到"：
 *
 * <ol>
 *   <li>每次冷启动读一次已存 schema 版本，落到五个**互不相同**的结论之一
 *       （{@link State}）：全新安装 / 无需迁移 / 已迁移 / **迁移失败** / **拒绝降级**；</li>
 *   <li>需要迁移时**逐步**执行已登记的迁移步（{@link Migration}），每一步都在
 *       {@code {from, to}} 上显式登记——没有登记的跳跃直接判失败，**不允许**"跳过一步当无事发生"；</li>
 *   <li>任何一步抛异常 ⇒ {@link State#MIGRATION_FAILED}：**保留原数据**（不删 prefs、
 *       不回退版本号、不改写已存键），并把失败步骤与原因写进持久标记；</li>
 *   <li>已存版本**高于**当前（用户装了旧包）⇒ {@link State#DOWNGRADE_REJECTED}：
 *       **不改任何数据、不回写版本号**，明确拒绝，而不是把新版数据按旧格式解读；</li>
 *   <li>失败后**不宣称升级成功**、不静默继续；结论会经宿主回报给页面（见 MainActivity）。</li>
 * </ol>
 *
 * 诚实说明（不得省略）：目前**没有已发布的旧版本会写入 schema 版本键**，因此线上设备
 * 实际会走 {@link State#FRESH_INSTALL}；本条交付的是**路径的完整性**（登记表 + 失败分支 +
 * 降级分支 + 数据保留），其行为由 {@code tests/full-app/android/upgrade-path.test.ts} 的
 * 静态断言核对，**真机上跨版本升级本身未验证（需真机 + 两个版本的 APK）**。
 */
public final class PotbotUpgrade {

    private static final String TAG = "PotbotUpgrade";

    /** 迁移台账所在的私有 prefs（应用私有，不外泄）。 */
    static final String PREFS = "potbot.upgrade";

    /** 已存 schema 版本（缺失 = 全新安装）。 */
    static final String KEY_SCHEMA_VERSION = "potbot.schemaVersion";
    /** 上次迁移结果（状态名），供回报时原样读出。 */
    static final String KEY_LAST_RESULT = "potbot.upgrade.lastResult";
    static final String KEY_LAST_FROM = "potbot.upgrade.lastFrom";
    static final String KEY_LAST_TO = "potbot.upgrade.lastTo";
    /** 失败步骤名（成功时清空）。 */
    static final String KEY_FAILED_STEP = "potbot.upgrade.failedStep";
    /** 失败原因（成功时清空）。 */
    static final String KEY_FAILED_DETAIL = "potbot.upgrade.failedDetail";

    /** 当前数据格式版本。改动数据格式必须 +1 并**同时登记**一条 {@link Migration}。 */
    public static final int SCHEMA_VERSION = 2;

    private PotbotUpgrade() {
    }

    /** 冷启动迁移的**互不相同**的结论。 */
    public enum State {
        /** 没有已存版本 —— 新装，直接写入当前版本。 */
        FRESH_INSTALL,
        /** 已存版本 == 当前版本 —— 无需迁移。 */
        NO_MIGRATION_NEEDED,
        /** 逐级迁移全部成功。 */
        MIGRATED,
        /** 迁移失败（已保留原数据）。 */
        MIGRATION_FAILED,
        /** 已存版本高于当前 —— 拒绝降级。 */
        DOWNGRADE_REJECTED
    }

    /** 失败的迁移步标识。 */
    public static final String FAILURE_NO_STEP = "no_registered_step";
    public static final String FAILURE_STEP_THREW = "step_threw";

    /** 一次迁移的结论。字段原样携带，不做修补。 */
    public static final class Result {
        public final State state;
        /** 迁移前已存版本（全新安装为 -1）。 */
        public final int fromVersion;
        /** 迁移后版本（失败/拒绝时**等于** fromVersion，表示没有改动）。 */
        public final int toVersion;
        /** 失败步骤名（非失败状态为 ""）。 */
        public final String failedStep;
        /** 失败原因 / 拒绝原因（无则 ""）。 */
        public final String detail;

        Result(State state, int fromVersion, int toVersion, String failedStep, String detail) {
            this.state = state;
            this.fromVersion = fromVersion;
            this.toVersion = toVersion;
            this.failedStep = failedStep == null ? "" : failedStep;
            this.detail = detail == null ? "" : detail;
        }

        /** 迁移是否**全部成功**（含无需迁移与新装）。失败/拒绝一律 false。 */
        public boolean isOk() {
            return state == State.FRESH_INSTALL
                    || state == State.NO_MIGRATION_NEEDED
                    || state == State.MIGRATED;
        }

        /** 是否发生过一次真实的数据改动。 */
        public boolean touchedData() {
            return state == State.MIGRATED || state == State.FRESH_INSTALL;
        }

        public String describe() {
            String head = "升级状态 " + state.name().toLowerCase(Locale.ROOT)
                    + "（schema " + fromVersion + " → " + toVersion + "）";
            if (!failedStep.isEmpty()) {
                head = head + "，失败步骤 " + failedStep;
            }
            if (!detail.isEmpty()) {
                head = head + "：" + detail;
            }
            return head;
        }
    }

    /** 一步迁移：把数据从 {@code from} 升到 {@code to}。实现必须**幂等**。 */
    interface Step {
        void apply(SharedPreferences prefs) throws Exception;
    }

    /** 一行迁移登记。 */
    static final class Migration {
        final int from;
        final int to;
        final String name;
        final Step step;

        Migration(int from, int to, String name, Step step) {
            this.from = from;
            this.to = to;
            this.name = name;
            this.step = step;
        }
    }

    /**
     * 迁移登记表：**每一次版本 +1 都必须在这里有一行**，否则升级会在
     * {@link #FAILURE_NO_STEP} 处显式失败（而不是静默跳过）。
     */
    static List<Migration> registry() {
        List<Migration> list = new ArrayList<Migration>();
        // v1 → v2：引入 schema 台账本身。把任何遗留的 "potbot.legacy." 前缀键规范化到
        // 无前缀名（**只在目标键不存在时复制**，绝不覆盖现有值；源键保留，不做删除）。
        // 幂等：重复执行不会改变结果。
        list.add(new Migration(1, 2, "adopt_schema_ledger", new Step() {
            @Override
            public void apply(SharedPreferences prefs) {
                SharedPreferences.Editor editor = prefs.edit();
                for (java.util.Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
                    String key = entry.getKey();
                    if (key == null || !key.startsWith(LEGACY_PREFIX)) {
                        continue;
                    }
                    String normalized = "potbot." + key.substring(LEGACY_PREFIX.length());
                    if (prefs.contains(normalized)) {
                        continue; // 已有该键：保留现值，不覆盖（幂等）
                    }
                    Object value = entry.getValue();
                    if (value instanceof String) {
                        editor.putString(normalized, (String) value);
                    } else if (value instanceof Integer) {
                        editor.putInt(normalized, (Integer) value);
                    } else if (value instanceof Long) {
                        editor.putLong(normalized, (Long) value);
                    } else if (value instanceof Boolean) {
                        editor.putBoolean(normalized, (Boolean) value);
                    } else if (value instanceof Float) {
                        editor.putFloat(normalized, (Float) value);
                    }
                }
                editor.commit();
            }
        }));
        return list;
    }

    /** 遗留键前缀（迁移步据此规范化；源键保留不删）。 */
    static final String LEGACY_PREFIX = "potbot.legacy.";

    /**
     * 执行冷启动迁移。**不抛异常**；任何问题都转成 {@link State} 结论。
     */
    public static Result run(Context context) {
        if (context == null) {
            return new Result(State.MIGRATION_FAILED, -1, -1,
                    FAILURE_STEP_THREW, "context 为空");
        }
        SharedPreferences prefs;
        try {
            prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        } catch (Throwable e) {
            return new Result(State.MIGRATION_FAILED, -1, -1,
                    FAILURE_STEP_THREW, "无法打开升级台账：" + safeMessage(e));
        }

        final int stored;
        try {
            stored = prefs.getInt(KEY_SCHEMA_VERSION, -1);
        } catch (Throwable e) {
            // 已有键不是 int（数据被改写）：**不猜**，如实判失败并保留现场。
            return persist(prefs, new Result(State.MIGRATION_FAILED, -1, -1,
                    FAILURE_STEP_THREW, "schema 版本键不是整数：" + safeMessage(e)));
        }

        if (stored < 0) {
            return persist(prefs, new Result(State.FRESH_INSTALL, -1, SCHEMA_VERSION, "", ""));
        }
        if (stored == SCHEMA_VERSION) {
            return persist(prefs, new Result(State.NO_MIGRATION_NEEDED,
                    stored, stored, "", ""));
        }
        if (stored > SCHEMA_VERSION) {
            // 装了旧包：不改数据、不回写版本号。
            return persist(prefs, new Result(State.DOWNGRADE_REJECTED, stored, stored, "",
                    "已存数据版本 " + stored + " 高于本应用支持的 " + SCHEMA_VERSION
                            + "；未改动任何数据（请安装不低于该版本的应用）。"));
        }

        // stored < SCHEMA_VERSION：逐级迁移。
        List<Migration> registry = registry();
        int current = stored;
        while (current < SCHEMA_VERSION) {
            Migration match = find(registry, current);
            if (match == null) {
                // 缺登记步：显式失败，绝不"跳过当完成"。
                return persist(prefs, new Result(State.MIGRATION_FAILED, stored, current,
                        FAILURE_NO_STEP, "没有登记从版本 " + current + " 出发的迁移步"));
            }
            try {
                match.step.apply(prefs);
            } catch (Throwable e) {
                Log.w(TAG, "迁移步失败：" + match.name, e);
                // 保留原数据：不删 prefs、不回写 schemaVersion、不改写已存键。
                return persist(prefs, new Result(State.MIGRATION_FAILED, stored, current,
                        match.name, safeMessage(e)));
            }
            current = match.to;
        }

        // 全部成功才回写版本号，并清空失败标记。
        try {
            prefs.edit()
                    .putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION)
                    .remove(KEY_FAILED_STEP)
                    .remove(KEY_FAILED_DETAIL)
                    .commit();
        } catch (Throwable e) {
            return persist(prefs, new Result(State.MIGRATION_FAILED, stored, current,
                    FAILURE_STEP_THREW, "回写 schema 版本失败：" + safeMessage(e)));
        }
        return persist(prefs, new Result(State.MIGRATED, stored, SCHEMA_VERSION, "", ""));
    }

    /** 读出上次结论（不重跑迁移）；从未跑过返回 null。 */
    public static Result lastResult(Context context) {
        if (context == null) {
            return null;
        }
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String name = prefs.getString(KEY_LAST_RESULT, null);
            if (name == null) {
                return null;
            }
            State state = State.valueOf(name);
            return new Result(state,
                    prefs.getInt(KEY_LAST_FROM, -1),
                    prefs.getInt(KEY_LAST_TO, -1),
                    prefs.getString(KEY_FAILED_STEP, ""),
                    prefs.getString(KEY_FAILED_DETAIL, ""));
        } catch (Throwable e) {
            return null;
        }
    }

    private static Migration find(List<Migration> registry, int from) {
        for (Migration m : registry) {
            if (m.from == from) {
                return m;
            }
        }
        return null;
    }

    /** 把结论原样写入持久标记（失败时同时登记失败步骤/原因）。 */
    private static Result persist(SharedPreferences prefs, Result result) {
        try {
            SharedPreferences.Editor editor = prefs.edit()
                    .putString(KEY_LAST_RESULT, result.state.name())
                    .putInt(KEY_LAST_FROM, result.fromVersion)
                    .putInt(KEY_LAST_TO, result.toVersion);
            if (result.state == State.MIGRATION_FAILED) {
                editor.putString(KEY_FAILED_STEP, result.failedStep);
                editor.putString(KEY_FAILED_DETAIL, result.detail);
            } else {
                editor.remove(KEY_FAILED_STEP).remove(KEY_FAILED_DETAIL);
            }
            editor.commit();
        } catch (Throwable e) {
            Log.w(TAG, "写入升级结论失败（不致命）", e);
        }
        return result;
    }

    private static String safeMessage(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return e == null ? "" : e.getClass().getSimpleName();
        }
        return m.length() > 200 ? m.substring(0, 200) : m;
    }
}
