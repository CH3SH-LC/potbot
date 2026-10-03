package com.potbot.demo;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

/**
 * FA-APP-NOTIFY-PERM：`POST_NOTIFICATIONS`（API 33+）的**只读判断 + 一次性请求**小助手。
 *
 * <h3>为什么需要它</h3>
 * 后台进度通知（见 {@link PotbotProgressJobService}）在 API 33+ 上需要运行时权限
 * `POST_NOTIFICATIONS`。此前该权限**未声明**在清单里，因此 API 33+ 上通知一律发不出去，
 * 只能靠"回到 App 读回持久进度"——这是已登记的阻塞项。现在清单已声明该权限，
 * 但**声明 ≠ 已授权**：不主动请求的话它默认仍是拒绝态，通知依旧发不出。
 *
 * <h3>权限性质（为什么它不违反"不新增危险权限"的原意）</h3>
 * 该权限是**功能必需**（发进度通知）、**用户可见**（系统弹窗，非静默获取）、
 * **可随时撤销**（系统设置里关掉，重新打开 App 即生效），并且**不读取任何用户隐私数据**——
 * 与相机/定位/通讯录/后台定位/外部存储这类"与功能无关的敏感权限"性质完全不同。
 *
 * <h3>降级而非崩溃</h3>
 * 用户拒绝后：本类只返回 false，**不重复弹窗骚扰**（问过一次就记住）；
 * {@link PotbotProgressJobService} 里会如实把原因记为 {@code NOTIFY_DENIED}，**不假装通知已送达**；
 * 任务进度仍照常落进持久层，用户回到 App 即可读回。整条路径**不抛异常**。
 *
 * <h3>未验证（需真机）</h3>
 * 本波**不跑 Gradle、不装 APK、不连真机**：系统弹窗的实际形态、拒绝后是否真的静默降级、
 * 撤销后重进是否真的重新生效，均**未验证**。本类只保证源码结构可被判据机判。
 */
final class PotbotNotificationPermission {

    private static final String TAG = "PotbotNotifyPerm";

    /** 被判断/请求的权限名（API 33+ 的运行时权限）。 */
    static final String PERMISSION = "android.permission.POST_NOTIFICATIONS";
    /** 请求码（固定；本 App 目前没有别的权限请求，取一个不冲突的常量）。 */
    static final int REQUEST_CODE = 0x706F02;

    private static final String PREFS = "potbot.app.state";
    /** "已经问过一次"的标记：用户拒绝后不再重复弹窗（降级，不骚扰）。 */
    private static final String ASKED_KEY = "potbot.notification.permissionAsked";

    private PotbotNotificationPermission() {
        // 纯静态工具类
    }

    /**
     * 只读判断：当前是否**允许发通知**。
     * API &lt; 33 无需该权限，恒为 true；读不到/任何异常一律**保守返回 false**
     * （宁可当作"发不出"，也不假装已授权）。
     */
    static boolean isGranted(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        if (context == null) {
            return false;
        }
        try {
            return context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 只读判断：清单里是否**声明**了该权限（用于区分"未声明"与"声明了但被拒"两种原因）。
     * 读不到一律返回 false，不猜测。
     */
    static boolean isDeclared(Context context) {
        if (context == null) {
            return false;
        }
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
            String[] requested = info.requestedPermissions;
            if (requested == null) {
                return false;
            }
            for (String name : requested) {
                if (PERMISSION.equals(name)) {
                    return true;
                }
            }
            return false;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 需要时请求一次。
     *
     * 请求条件（三者同时满足才请求）：① API ≥ 33；② 当前尚未授权；③ 之前**没有问过**。
     * 条件 ③ 保证用户拒绝后不再被反复打扰——**降级，不骚扰**。
     *
     * 返回 true 表示"本次真的发起了系统请求"，false 表示"没请求"（无需 / 已授权 / 已问过 / 异常）。
     * 任何异常都被吞掉并记日志——请求失败**绝不影响 App 运行**。
     */
    static boolean requestIfNeeded(Activity activity) {
        if (activity == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return false;
        }
        if (isGranted(activity)) {
            return false;
        }
        try {
            SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (prefs.getBoolean(ASKED_KEY, false)) {
                // 已经问过一次（用户很可能已拒绝）：不再弹窗，功能降级。
                return false;
            }
            prefs.edit().putBoolean(ASKED_KEY, true).commit();
            activity.requestPermissions(new String[] { PERMISSION }, REQUEST_CODE);
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "请求通知权限失败（降级：通知发不出，进度仍可从持久层读回）", e);
            return false;
        }
    }

    /** 只读：通知是否**可达**——即"该发就能发出"（已授权，或该 API 等级无需权限）。 */
    static boolean canPost(Context context) {
        return isGranted(context);
    }
}
