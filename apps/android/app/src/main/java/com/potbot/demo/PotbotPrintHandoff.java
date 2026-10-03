package com.potbot.demo;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;

/**
 * design-05 **WF-090（手机侧）** 的**打印交接**——**只做交接，不代打印**。
 *
 * ## 一句话纪律（任务书 §12 七态）
 *
 * 任务书把"动作走到哪一步"分成七态，**不许互相冒充**。本类只表达其中两态：
 *
 * | 本类的 state | 七态对应 | 精确含义 |
 * |---|---|---|
 * | {@link State#PREPARED} | `prepared` | 产物已就绪/核对过，但交接**没有发生**（含各类失败） |
 * | {@link State#HANDED_OFF} | `handed_off` | 已把活交给系统打印服务，**不表示用户提交，更不表示已打印** |
 *
 * **`submitted` / `confirmed_complete` 在本类里不可表达**——因为本波没有任何可信回执
 * 证明"打印请求已送达打印机"或"纸张已打印"。没有回执就不许宣称。
 *
 * ## 类型上就没有"已打印"
 *
 *  {@link #PRINTED} 是 `static final boolean` 且**只有 `false` 一个取值来源**；
 *  两个结果工厂 {@link Outcome#prepared} / {@link Outcome#handedOff} 都把它原样带出。
 *  任何代码路径都不存在"把 printed 写成 true"的可能——**要宣称已打印，必须另外拿到
 *  可信回执，而本批没有这种回执**。
 *
 * ## 只交接**已核对过**的产物
 *
 * {@link #handOff} 只接受"已被 {@link PotbotPdfReadback} 独立读回核对通过"的 PDF
 * （由调用方给出路径 + 该文件的 sha256）。交接前**重新计算盘上字节的摘要**并与期望值
 * 比对：不一致就是 `target_digest_mismatch`，绝不把换过的文件交出去。
 *
 * ## 边界（必须随结论一起带出）
 *
 * 真实的打印是否发生、打印机是否出纸，本类**不掌握**；Android 打印框架的
 * {@code PrintDocumentAdapter} 回调只证明"系统打印服务取走了内容"，
 * **不等于**用户提交了打印作业，更不等于纸张已打印。真机打印在本波**未验证**。
 */
final class PotbotPrintHandoff {

    private PotbotPrintHandoff() {
    }

    /**
     * `printed` 的**唯一**取值来源：永远 `false`。
     *
     * 刻意声明成 `static final boolean`（而不是可写字段）：类型系统 + 源码级断言共同保证
     * 没有任何代码路径能把它变成 `true`。本批没有可信打印回执，所以这条通路在本批**关闭**。
     */
    static final boolean PRINTED = false;

    /** 只表达两态；**没有** `PRINTED` / `CONFIRMED_COMPLETE` 成员。 */
    enum State {
        /** 产物就绪但交接未发生（含各类失败）。 */
        PREPARED,
        /** 已交接给系统打印服务；不表示提交、不表示打印。 */
        HANDED_OFF
    }

    /** 与任何打印结论一并带出的**边界**（手机端未验证必须显眼）。 */
    static final String[] BOUNDARIES = new String[] {
        "本批只做到「已交接」；**没有**任何\"纸张已打印\"的证据，不得如此宣称。",
        "PrintDocumentAdapter 回调只证明系统打印服务取走了内容，不代表用户提交了打印作业。",
        "**真机打印在本波未验证**：没有设备窗口，APK 未安装，未实际出纸。",
    };

    static final String FAILURE_TARGET_MISSING = "target_missing";
    static final String FAILURE_TARGET_DIGEST_MISMATCH = "target_digest_mismatch";
    static final String FAILURE_HANDOFF_UNAVAILABLE = "handoff_unavailable";
    static final String FAILURE_PERMISSION_DENIED = "permission_denied";
    static final String FAILURE_OPEN_FAILED = "open_failed";

    /** 交接结果。**没有**任何"已打印"的取值。 */
    static final class Outcome {
        final State state;
        /** **恒为** {@link #PRINTED}（false）；任何构造路径都不可能给 true。 */
        final boolean printed;
        final String claim;
        /** 交接失败时的结构化原因；成功时为 null。 */
        final String failureKind;
        final String detail;
        final String jobName;
        final int pageCount;
        /** 真实使用的交接通路（便于事后追溯是哪条路线）。 */
        final String handoffPath;
        final String[] boundaries;

        private Outcome(State state, boolean printed, String claim, String failureKind,
                        String detail, String jobName, int pageCount, String handoffPath) {
            this.state = state;
            this.printed = printed;
            this.claim = claim;
            this.failureKind = failureKind;
            this.detail = detail;
            this.jobName = jobName;
            this.pageCount = pageCount;
            this.handoffPath = handoffPath;
            this.boundaries = BOUNDARIES;
        }

        /** 未交接：停在**已准备**，带结构化失败原因。 */
        static Outcome prepared(String failureKind, String detail, String jobName, int pageCount) {
            return new Outcome(State.PREPARED, PRINTED,
                    "未交接：打印请求没有交出去（原因 " + failureKind + "）。**不表示已打印**。",
                    failureKind, detail, jobName, pageCount, "");
        }

        /** 已交接：**已交给系统打印服务**，明确 `printed=false`。 */
        static Outcome handedOff(String detail, String jobName, int pageCount, String path) {
            return new Outcome(State.HANDED_OFF, PRINTED,
                    "已交接：已把已核对过的 PDF 交给系统打印服务。"
                            + "**这不代表用户提交了打印，更不代表纸张已打印**。",
                    null, detail, jobName, pageCount, path);
        }

        boolean isHandedOff() {
            return state == State.HANDED_OFF;
        }
    }

    /** 真实使用的交接通路（写进结果，便于追溯与静态断言）。 */
    static final String HANDOFF_PATH = "android.print.PrintManager + PrintDocumentAdapter";

    /**
     * 把一份**已经独立读回核对通过**的 PDF 交给 Android 系统打印框架。
     *
     * @param verifiedPdf     已读回核对通过的 PDF 文件
     * @param expectedSha256  读回核对时那份字节的 sha256；交接前**重新计算**并比对
     * @param pageCount       读回器报出的真实页数（>0 才交接）
     */
    static Outcome handOff(Context context, String jobName, File verifiedPdf,
                           String expectedSha256, int pageCount) {
        final String name = (jobName == null || jobName.trim().isEmpty()) ? "potbot" : jobName.trim();

        if (context == null) {
            return Outcome.prepared(FAILURE_HANDOFF_UNAVAILABLE, "没有可用的 Context。", name, pageCount);
        }
        if (verifiedPdf == null || !verifiedPdf.exists() || verifiedPdf.length() <= 0) {
            return Outcome.prepared(FAILURE_TARGET_MISSING,
                    "未交接：待打印的 PDF 不存在或为空——只有\"准备交接\"的意图。", name, pageCount);
        }
        if (pageCount <= 0) {
            return Outcome.prepared(FAILURE_TARGET_MISSING,
                    "未交接：页数 " + pageCount + " 不可信，拒绝交接。", name, pageCount);
        }
        if (expectedSha256 == null || expectedSha256.isEmpty()) {
            return Outcome.prepared(FAILURE_TARGET_MISSING,
                    "未交接：没有读回核对时的摘要，无法证明交出去的是核对过的那份。", name, pageCount);
        }

        // 交接前**重新**核对盘上字节：被换过的文件不许交出去。
        String actual;
        try {
            actual = sha256Of(verifiedPdf);
        } catch (Throwable e) {
            return Outcome.prepared(FAILURE_OPEN_FAILED,
                    "未交接：交接前无法重新读取产物（" + e.getClass().getSimpleName() + " " + safe(e) + "）。",
                    name, pageCount);
        }
        if (!actual.equalsIgnoreCase(expectedSha256)) {
            return Outcome.prepared(FAILURE_TARGET_DIGEST_MISMATCH,
                    "未交接：盘上字节与读回核对时的摘要不一致（盘上 " + actual + "，期望 "
                            + expectedSha256 + "），交出去的不是核对过的那份。", name, pageCount);
        }

        byte[] bytes;
        try {
            bytes = readAll(verifiedPdf, PotbotPdfReadback.MAX_READBACK_BYTES);
        } catch (Throwable e) {
            return Outcome.prepared(FAILURE_OPEN_FAILED,
                    "未交接：读取产物失败（" + e.getClass().getSimpleName() + " " + safe(e) + "）。",
                    name, pageCount);
        }

        PrintManager manager;
        try {
            manager = (PrintManager) context.getSystemService(Context.PRINT_SERVICE);
        } catch (Throwable e) {
            manager = null;
        }
        if (manager == null) {
            return Outcome.prepared(FAILURE_HANDOFF_UNAVAILABLE,
                    "未交接：本设备没有系统打印服务（PrintManager 不可用）。", name, pageCount);
        }

        PrintAttributes attributes = new PrintAttributes.Builder()
                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .build();

        try {
            manager.print(name, new VerifiedPdfAdapter(name, bytes, pageCount), attributes);
        } catch (SecurityException e) {
            return Outcome.prepared(FAILURE_PERMISSION_DENIED,
                    "未交接：系统打印服务拒绝（权限不足：" + e.getClass().getSimpleName() + "）。",
                    name, pageCount);
        } catch (Throwable e) {
            return Outcome.prepared(FAILURE_HANDOFF_UNAVAILABLE,
                    "未交接：调用系统打印服务失败（" + e.getClass().getSimpleName() + " " + safe(e) + "）。",
                    name, pageCount);
        }

        String detail = "已把 1 份已核对的 PDF（" + bytes.length + " 字节，" + pageCount
                + " 页，sha256 " + actual + "）交给系统打印服务；交接通路 = " + HANDOFF_PATH
                + "。系统打印服务是否被用户确认、是否真的出纸，本应用**不掌握**。";
        return Outcome.handedOff(detail, name, pageCount, HANDOFF_PATH);
    }

    /**
     * 把**已核对过**的 PDF 字节写进系统打印框架给的描述符。
     *
     * 注意：本适配器**不做任何自称已打印**的事——它只把字节交给系统；
     * 之后发生什么（用户确认 / 取消 / 出纸）本应用收不到可信回执。
     */
    static final class VerifiedPdfAdapter extends PrintDocumentAdapter {

        private final String jobName;
        private final byte[] bytes;
        private final int pageCount;

        VerifiedPdfAdapter(String jobName, byte[] bytes, int pageCount) {
            this.jobName = jobName;
            this.bytes = bytes;
            this.pageCount = pageCount;
        }

        @Override
        public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes,
                             CancellationSignal cancellationSignal, LayoutResultCallback callback,
                             Bundle extras) {
            if (cancellationSignal != null && cancellationSignal.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(jobName)
                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                    .setPageCount(pageCount > 0 ? pageCount : PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                    .build();
            callback.onLayoutFinished(info, true);
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
                            CancellationSignal cancellationSignal, WriteResultCallback callback) {
            if (cancellationSignal != null && cancellationSignal.isCanceled()) {
                callback.onWriteCancelled();
                return;
            }
            if (destination == null) {
                callback.onWriteFailed("系统没有给出目标文件描述符。");
                return;
            }
            OutputStream os = null;
            try {
                os = new FileOutputStream(destination.getFileDescriptor());
                os.write(bytes);
                os.flush();
            } catch (Throwable e) {
                callback.onWriteFailed("写入打印流失败：" + e.getClass().getSimpleName() + " " + safe(e));
                return;
            } finally {
                // 只 flush，不 close：这个描述符属于系统打印框架，不由本应用关闭。
                if (os != null) {
                    try {
                        os.flush();
                    } catch (Throwable ignored) {
                        // 已经报告过失败；flush 的二次异常不覆盖结论。
                    }
                }
            }
            callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
        }
    }

    private static byte[] readAll(File file, long max) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > max) {
                    throw new IOException("内容超过 " + max + " 字节上限");
                }
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        }
    }

    private static String sha256Of(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                md.update(buf, 0, n);
            }
        }
        byte[] d = md.digest();
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static String safe(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return "";
        }
        return m.length() > 200 ? m.substring(0, 200) : m;
    }
}
