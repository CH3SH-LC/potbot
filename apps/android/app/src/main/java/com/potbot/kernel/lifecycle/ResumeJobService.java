package com.potbot.kernel.lifecycle;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;

/**
 * K-I21 —— JobScheduler 接线：把"恢复续跑"交给系统调度器（不抢占用户的延迟工作）。
 *
 * <p>对应 {@code types.ts} 的 {@code background-deferred} 可见性——这类工作不该以前台服务
 * 常驻，而应由系统在允许窗口拉起。作业带网络要求（{@code NETWORK_TYPE_ANY}），断网时系统
 * 自然不拉起；恢复网络后按最小延迟重排。
 *
 * <p><b>权限（如实说明）</b>：
 * {@code BIND_JOB_SERVICE} 是组件属性（在清单 {@code <service>} 上），**不是** uses-permission；
 * 本类确实**不新增任何权限**（旧版注释止于此，掩盖了一个平台约束，现补全）：把作业设为
 * **跨重启持久化**
 * （persisted job，即 {@code setPersisted(true)}）需要清单声明
 * {@code RECEIVE_BOOT_COMPLETED}，而本 App **故意不声明**它。权限缺失时，
 * {@code JobInfo.Builder.build()} 会抛 {@link IllegalArgumentException}
 * （消息大意："no RECEIVE_BOOT_COMPLETED permission in the manifest"）。
 *
 * <p>因此 {@link #schedule} **只在真的持有该权限时**才请求持久化；否则退回**非持久化作业**——
 * 非持久化作业仍能在**进程被回收**后由系统保留并重排，这不是本设计要放弃的能力；
 * 放弃的只是"**跨设备重启**续跑"，而本设计**并不依赖**它（见 {@link #onStartJob} 的注释：
 * 真正的续跑由持有 {@code TaskLedger} 的主进程按落盘状态执行，重启后由下次排程重新拉起）。
 * 这样既不抛异常、也不谎报"已跨重启持久化"。
 *
 * <p><b>不谎报</b>：{@code onStartJob} 返回 true 仅表示"仍有未完成工作、稍后重试"，
 * 不代表已续跑成功；真正的续跑由持有 {@code TaskLedger} 的主进程执行。
 *
 * <p><b>未验证</b>：未编译、未上真机；清单里的 {@code <service>} 声明归集成人。
 */
public final class ResumeJobService extends JobService {

    /**
     * 排一次恢复作业（幂等：同 id 覆盖）。
     *
     * <p>持久化是**机会性**的：只有真的持有 {@code RECEIVE_BOOT_COMPLETED} 才
     * {@code setPersisted(true)}；否则用非持久化作业（进程回收仍在，跨重启不在），
     * 避免在缺权限时由 {@code build()} 抛 {@link IllegalArgumentException}。
     */
    public static void schedule(Context context) {
        if (context == null) {
            return;
        }
        JobScheduler scheduler = (JobScheduler) context.getApplicationContext()
                .getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) {
            return;
        }
        JobInfo.Builder builder = new JobInfo.Builder(
                LifecycleConstants.RESUME_JOB_ID,
                new ComponentName(context, ResumeJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(LifecycleConstants.RESUME_JOB_MIN_LATENCY_MS);
        if (canPersistAcrossReboot(context)) {
            builder.setPersisted(true);
        }
        scheduler.schedule(builder.build());
    }

    /**
     * 是否可请求**跨重启持久化**。
     *
     * <p>persisted job 需要清单声明 {@code RECEIVE_BOOT_COMPLETED}，否则
     * {@code JobInfo.Builder.build()} 抛 {@link IllegalArgumentException}。本 App
     * **故意不声明**该权限（本类不新增权限），故正常返回 {@code false}，从而
     * {@link #schedule} 不会请求持久化、也就不会抛异常。保留这条机会性判断，是为了将来若确需
     * 跨重启续跑、由集成人在清单显式加权限后，本类**无需再改**。
     */
    private static boolean canPersistAcrossReboot(Context context) {
        try {
            return context.checkSelfPermission("android.permission.RECEIVE_BOOT_COMPLETED")
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable error) {
            // 判不出（异常/受限环境）一律保守：不请求持久化，绝不因它崩溃。
            return false;
        }
    }

    /** 取消恢复作业（任务结清/用户取消后调用，避免空转重排）。 */
    public static void cancel(Context context) {
        if (context == null) {
            return;
        }
        JobScheduler scheduler = (JobScheduler) context.getApplicationContext()
                .getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) {
            scheduler.cancel(LifecycleConstants.RESUME_JOB_ID);
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        // 由主进程读取 TaskLedger 的可续跑任务并驱动 NetworkResumeController；
        // 本作业只负责"到点拉起"，不在此宣称续跑成功。
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // 被系统打断（如网络再次丢失）⇒ 请求重排，绝不静默丢弃。
        return true;
    }
}
