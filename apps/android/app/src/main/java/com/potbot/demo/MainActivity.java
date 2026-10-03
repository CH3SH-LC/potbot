package com.potbot.demo;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.potbot.kernel.runtime.KernelLocalUiBridge;
import com.potbot.kernel.runtime.KernelRuntimeService;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * potbot 手机 Word Demo 的最小宿主。
 *
 * 职责边界（S1 独占）：
 *  - 用 WebView 只加载**唯一可信源**：来自可配置端点 {@link PotbotEndpoints#baseUrl(Context)}
 *    （开发默认 {@link #ORIGIN} = 本机 127.0.0.1:8765，需 adb reverse；**那只是开发便利**，
 *    不是产品运行前提——APP-06 / R254）。
 *  - 其他外部链接一律交给系统浏览器，不在 WebView 内打开，也不暴露通用原生执行桥。
 *  - 提供一个**用途单一**的 JS 桥 {@code window.PotbotNative}，能力有且只有七类：
 *      1. 从同源 artifact 接口取 DOCX 字节 → 校验长度与 SHA256 → 存进应用私有目录
 *         → 用 FileProvider 的 content:// URI + DOCX MIME + 临时读权限交给系统选择器/ACTION_VIEW。
 *      2. 另存副本走 ACTION_CREATE_DOCUMENT，由用户选位置。
 *      3. 用户选文件导入走 SAF ACTION_OPEN_DOCUMENT（content:// URI）。
 *      4. 把先前经本应用取得授权的 content:// 文档重新读回（另存副本导回）。
 *      5. **PDF 导出**（WF-089，本轮新增）：用 {@link PotbotPdfLayout}（真排版引擎）
 *         把文档模型排到 A4 页面 → 写盘 → **独立读回核对**（{@link PotbotPdfReadback}：
 *         非空 / `%PDF-` 魔数 / 系统解析器页数 / 首页墨迹 / 摘要）；同名另存走 SAF。
 *      6. **打印交接**（WF-090，本轮新增）：把**已核对过**的 PDF 交给
 *         {@link PotbotPrintHandoff}（PrintManager + PrintDocumentAdapter）；
 *         **只到"已交接"**，绝不宣称"已打印"（本批没有可信回执）。
 *      7. **App 生命周期**（APP-01/05/06，本轮新增）：{@code appInfo()} **只读**回报
 *         版本身份/升级结论/连接与地址/凭据有无；{@code reportActiveTask(...)} 只把
 *         "当前停在哪个任务"落盘；{@code cancelTask(taskId)} 与 {@code reconnectTask(taskId)}
 *         只对**已配置的服务地址**、对给定的 task id 发出**带持久幂等键**的取消/续取请求
 *         （取消与重连因此不会重复执行，R257）。它们**不**读任意内容、**不**执行任意命令。
 *  - 每一条落盘路径都必须**关闭流之后重新读回目标字节**并核对长度 + SHA256，
 *    核对通过才允许宣称保存成功（design-05-P10 / §2.1 缺口 2）。
 *
 * 明确**不做**的事：不给办公软件传 file:// 或电脑磁盘路径；不关闭 TLS 校验；
 * 不实现任意 URL 拉取、任意命令执行、任意文件读取（content:// 只允许本应用取得过授权的 URI）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "PotbotDemo";

    /**
     * 开发默认服务地址（回环，需电脑侧映射）。**仅作默认值**：
     * 真实运行地址来自可配置的 {@link PotbotEndpoints#baseUrl(Context)}（APP-06 / R254），
     * 不再把"USB 调试 + adb reverse"当成产品运行前提。
     */
    public static final String ORIGIN = PotbotEndpoints.DEV_USB_BASE_URL;
    /** 开发默认地址的回环 host/port（{@link #isDevLoopbackOrigin} 用）。 */
    private static final String HOST = "127.0.0.1";
    private static final int PORT = 8765;

    /** 通知/深链回任务时携带的任务 id（APP-05，点通知回到任务）。 */
    public static final String EXTRA_TASK_ID = "potbot.taskId";

    // ------------------------------------------------------- APP-01/05/06 生命周期回报状态词表
    //
    // 纪律：这些状态**不描述任何文件保存/导出结论**，因此**不走** reportStatus——
    // 那条通道的每个成功语义都被静态判据要求"只有独立读回核对通过才能发"。
    // 生命周期/连接/版本身份是**另一类事实**，走 reportAppLifecycle；
    // 混用会让"保存成功"的判据失去意义。

    /** 版本身份一致（打包 versionName == 注入的产品版本）。 */
    static final String ST_APP_VERSION_CONSISTENT = "app_version_consistent";
    /** 版本身份**不一致**（如实报，不掩盖）。 */
    static final String ST_APP_VERSION_MISMATCH = "app_version_mismatch";
    /** 升级路径结论：新装 / 无需迁移 / 已迁移。 */
    static final String ST_APP_UPGRADE_OK = "app_upgrade_ok";
    /** 升级失败（原数据已保留）。 */
    static final String ST_APP_UPGRADE_FAILED = "app_upgrade_failed";
    /** 拒绝降级（未改动任何数据）。 */
    static final String ST_APP_UPGRADE_DOWNGRADE = "app_upgrade_downgrade_rejected";
    /** 冷启动恢复：回到了一个未结束的任务。 */
    static final String ST_APP_TASK_RESTORED = "app_task_restored";
    /** 网络恢复在线。 */
    static final String ST_APP_NET_ONLINE = "app_net_online";
    /** 网络离线。 */
    static final String ST_APP_NET_OFFLINE = "app_net_offline";
    /** 网络状态未知（既非在线也非离线）。 */
    static final String ST_APP_NET_UNKNOWN = "app_net_unknown";
    /** 页面加载失败（不拿旧内容冒充已加载）。 */
    static final String ST_APP_PAGE_LOAD_FAILED = "app_page_load_failed";
    /** 页面请求返回错误状态。 */
    static final String ST_APP_PAGE_HTTP_ERROR = "app_page_http_error";
    /** 非可信页面发来的请求被拒（同源校验失败）。 */
    static final String ST_APP_REJECTED = "app_request_rejected";

    private static final String DOCX_MIME =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    private static final String PDF_MIME = "application/pdf";

    /** 桥名固定为 window.PotbotNative。 */
    private static final String JS_BRIDGE_NAME = "PotbotNative";
    /** 回报通道函数名，由手机页面实现；成功和失败都必须回调，不静默。签名固定 (ok:boolean, message:string)。 */
    private static final String JS_RESULT_FN = "PotbotBridgeResult";
    /**
     * **可选**结构化状态通道（附加、不是修改既有合同）：页面若实现则额外收到一个 JSON 字符串，
     * 含 {@code {status, ok, message, platform}}。消息正文本身也带 {@code [status=...]} 尾巴，
     * 因此 2 参数的旧页面实现不受影响，也不会丢状态信息。
     */
    private static final String JS_STATUS_FN = "PotbotBridgeStatus";

    // ------------------------------------------------------- 本地内核（K01）接线常量
    //
    // 手机内核（com.potbot.kernel.runtime.*）是**同进程**的：Service 起在应用自己的进程里，
    // 桥（KernelLocalUiBridge）就是它的一个对象。页面拿到的能力**只有四个**
    // （submit / subscribe / unsubscribe / cancel，每个先过本地 origin 门），
    // 与既有 window.PotbotNative（保存 / 导出 / 打印 / 生命周期）是**两个独立**的 JS 面。

    /**
     * 内核桥在页面全局对象上的名字。页面用 {@code window.PotbotKernel.submit(origin, cmdJson)} 等调用。
     * （与 {@code window.PotbotNative} 并列，互不替代。）
     */
    private static final String JS_KERNEL_BRIDGE_NAME = "PotbotKernel";
    /**
     * 内核事件下行回调：页面实现 {@code window.PotbotKernelEvent(subscriptionId, eventJson)} 才会收到。
     * 未实现则静默（不报错、也不假装已送达）。
     */
    private static final String JS_KERNEL_EVENT_FN = "PotbotKernelEvent";
    /** 内核桥就绪的**可选**回调：注册成功后调用一次，页面不必轮询 {@code window.PotbotKernel}。 */
    private static final String JS_KERNEL_READY_FN = "PotbotKernelReady";
    /** 桥注册重试：最多几次、每次间隔（不阻塞主线程；合计约 1.2 秒后放弃并记日志）。 */
    private static final int KERNEL_ATTACH_MAX_ATTEMPTS = 8;
    private static final long KERNEL_ATTACH_RETRY_MS = 150L;

    // ------------------------------------------------------- PC 后端 HTTP 桥（window.PotbotHost）
    //
    // 为什么需要它：页面现在从 **本 APK 的 assets**（file:///android_asset/ui/index.html）加载，
    // 该源的 origin 是 "null"；而 PC 后端（{@link PotbotEndpoints#baseUrl(Context)}，经 USB/HDB
    // 反向隧道可达）**不返回任何 CORS 头**。于是页面里的 window.fetch / XMLHttpRequest 一律被
    // 浏览器按同源策略拦下——**这不是配置问题，是页面自己做不到**。
    // 因此另开一个**只做 HTTP 转发**的原生面：页面把"相对路径 + 可选 JSON 体"交给宿主，
    // 由宿主（Java，不受同源策略约束）代发一次请求并**同步**把响应体文本还回去。
    //
    // 与 window.PotbotNative（保存/导出/打印/生命周期）、window.PotbotKernel（本地内核）
    // 是**三个互不替代**的 JS 面；本面能力只有两个方法，且**不是**通用网络代理：
    //   - base 固定为**配置端点**（不接受页面给主机名）；
    //   - path 只允许"/ 开头的相对路径"，禁 :// 、.. 、CR/LF（见 pathRejectReason）；
    //   - 不跟随跳转、不转发任何 Cookie/Authorization、响应体有上限。
    // 完整契约（含错误形状与未验证事项）见 apps/android/HOST-HTTP-BRIDGE.md。

    /** PC 后端桥在页面全局对象上的名字：{@code window.PotbotHost}。 */
    private static final String JS_HOST_BRIDGE_NAME = "PotbotHost";
    /**
     * PC 后端桥的连接/读取超时（各 10 秒）。比产物下载（{@link #HTTP_TIMEOUT_MS}）短得多：
     * 页面是**同步**等这个返回值的，超时必须尽早让页面看到失败而不是一直吊着。
     */
    private static final int HOST_HTTP_TIMEOUT_MS = 10000;
    /** PC 后端桥单次响应体上限：4 MB。**超出即失败**（绝不截断后冒充完整 JSON）。 */
    private static final long MAX_HOST_RESPONSE_BYTES = 4L * 1024L * 1024L;
    /** 非 2xx 时从错误流里最多读多少字节来拼一句"短原因"。 */
    private static final int MAX_HOST_ERROR_READ_BYTES = 4096;
    /** 上面那段摘录最终折进 error 字段的字符数上限（保证 "short reason" 真的很短）。 */
    private static final int MAX_HOST_ERROR_EXCERPT_CHARS = 300;
    /** POST 体固定按 JSON + UTF-8 发。 */
    private static final String HOST_JSON_CONTENT_TYPE = "application/json; charset=utf-8";

    // ------------------------------------------------------- APK 内置本地页面
    //
    // 首选加载打进 APK 的本地界面（离线、无 PC、无 adb reverse），**不存在就回退**
    // 到今天这条远程端点路径 —— 这正是 K01 桥白名单里 `file:///android_asset` 那一项的用途
    // （页面 origin 与桥的本地 origin 门对得上）。

    /** 内置界面的 assets 路径（另一 lane 产出；本文件只消费，不创建、不编辑）。 */
    private static final String LOCAL_UI_ASSET_PATH = "ui/index.html";
    /** 内置界面所在目录的 URL 前缀，同时也是"可信内置页面"的判定边界（只认本 APK 的 ui/ 目录）。 */
    private static final String LOCAL_UI_ASSET_DIR_URL = "file:///android_asset/ui/";
    /** 内置界面首页 URL。 */
    private static final String LOCAL_UI_ASSET_URL = LOCAL_UI_ASSET_DIR_URL + "index.html";

    private static final int REQ_CREATE_DOCUMENT = 1001;
    private static final int REQ_OPEN_DOCUMENT = 1002;
    /** 另存 PDF 副本（SAF ACTION_CREATE_DOCUMENT）。 */
    private static final int REQ_CREATE_PDF = 1003;

    private static final int HTTP_TIMEOUT_MS = 30000;
    private static final long MAX_DOWNLOAD_BYTES = 64L * 1024L * 1024L;
    /** 另存副本读回 / 导入读入的字节上限（与下载上限一致，避免无限读入）。 */
    private static final long MAX_IO_BYTES = 64L * 1024L * 1024L;
    private static final String ARTIFACT_DIR = "artifacts";
    /** 导入暂存目录（应用私有；不经 FileProvider 暴露给其他应用）。 */
    private static final String IMPORT_DIR = "imports";
    /**
     * PDF 导出子目录。**刻意放在 `artifacts/` 之下**：FileProvider 的暴露面完全不变
     * （仍是既有 `files-path path="artifacts/"`），不因新增 PDF 能力放宽任何外部可见面。
     */
    private static final String EXPORT_DIR = "exports";
    /** 写 PDF 前要求的最小可用空间（空间不足是独立失败状态，不与写失败混为一谈）。 */
    private static final long MIN_PDF_FREE_BYTES = 4L * 1024L * 1024L;

    // ------------------------------------------------------- 保存/导入回报状态词表
    //
    // 纪律（§2.1 缺口 2）：**只有** saved_verified 允许携带“保存成功”语义。
    // “读回失败”“权限不足”“URI 失效”“关闭失败”“状态丢失”“摘要不符”必须是
    // **互不相同**的状态，不能合并成一种笼统的“失败”。测试按这些常量做结构化断言。

    /** 保存（写盘 + 关闭 + 读回核对）全部通过——唯一允许宣称保存成功。 */
    static final String ST_SAVED_VERIFIED = "saved_verified";
    /** 保存已读回核对通过，但打开交接失败（无可用应用或启动异常）——保存本身仍成立。 */
    static final String ST_SAVED_VERIFIED_HANDOFF_FAILED = "saved_verified_handoff_failed";

    /** 保存前置校验被拒（同源、路径、摘要格式、文件名）。 */
    static final String ST_SAVE_REJECTED = "save_rejected";
    /** 从同源 artifact 接口取字节失败（HTTP/网络）。 */
    static final String ST_ARTIFACT_FETCH_FAILED = "artifact_fetch_failed";
    /** 接口返回字节与页面声明的长度不一致。 */
    static final String ST_ARTIFACT_LENGTH_MISMATCH = "artifact_length_mismatch";
    /** 接口返回字节的 SHA256 与页面声明不一致。 */
    static final String ST_ARTIFACT_DIGEST_MISMATCH = "artifact_digest_mismatch";
    /** 应用私有目录不可创建。 */
    static final String ST_LOCAL_DIR_FAILED = "local_dir_failed";

    /** 本地文件写入/刷新失败。 */
    static final String ST_LOCAL_WRITE_FAILED = "local_write_failed";
    /** 本地文件**关闭流**失败（内容可能不完整）。 */
    static final String ST_LOCAL_CLOSE_FAILED = "local_close_failed";
    /** 本地文件关闭后读回失败。 */
    static final String ST_LOCAL_READBACK_FAILED = "local_readback_failed";
    /** 本地文件读回与期望长度/摘要不符。 */
    static final String ST_LOCAL_READBACK_MISMATCH = "local_readback_mismatch";

    /** 用户取消另存。 */
    static final String ST_SAVE_COPY_CANCELLED = "save_copy_cancelled";
    /** 系统未返回可用目标 URI（或 URI 已失效）。 */
    static final String ST_SAVE_COPY_URI_INVALID = "save_copy_uri_invalid";
    /** 目标 URI 写入权限被拒。 */
    static final String ST_SAVE_COPY_WRITE_PERMISSION_DENIED = "save_copy_write_permission_denied";
    /** 目标写入/刷新失败。 */
    static final String ST_SAVE_COPY_WRITE_FAILED = "save_copy_write_failed";
    /** 目标**关闭流**失败（内容可能不完整；绝不宣称成功）。 */
    static final String ST_SAVE_COPY_CLOSE_FAILED = "save_copy_close_failed";
    /** 关闭后重新读取目标 URI 时权限不足。 */
    static final String ST_SAVE_COPY_READBACK_PERMISSION_DENIED = "save_copy_readback_permission_denied";
    /** 关闭后目标 URI 已失效/不可读。 */
    static final String ST_SAVE_COPY_READBACK_URI_INVALID = "save_copy_readback_uri_invalid";
    /** 关闭后读回本身失败（IO 错误，非权限、非 URI 失效）。 */
    static final String ST_SAVE_COPY_READBACK_FAILED = "save_copy_readback_failed";
    /** 关闭后读回的长度或 SHA256 与写入内容不符。 */
    static final String ST_SAVE_COPY_READBACK_MISMATCH = "save_copy_readback_mismatch";
    /** Activity 重建 / 进程终止导致待保存内容丢失，且无法从应用私有副本恢复。 */
    static final String ST_SAVE_COPY_STATE_LOST = "save_copy_state_lost";
    /** 系统另存选择器无法打开。 */
    static final String ST_SAVE_COPY_PICKER_FAILED = "save_copy_picker_failed";

    /** 用户取消导入。 */
    static final String ST_IMPORT_CANCELLED = "import_cancelled";
    /** 未取得系统返回的文件 URI。 */
    static final String ST_IMPORT_URI_INVALID = "import_uri_invalid";
    /** 传入的 URI 不是本应用取得过授权的 content:// 文档（拒绝任意读取）。 */
    static final String ST_IMPORT_URI_NOT_GRANTED = "import_uri_not_granted";
    /** 打开所选 URI 读入时权限不足。 */
    static final String ST_IMPORT_PERMISSION_DENIED = "import_permission_denied";
    /** 读入过程 IO 失败（非权限、非 URI 失效）。 */
    static final String ST_IMPORT_READ_FAILED = "import_read_failed";
    /** 文件超过读入上限。 */
    static final String ST_IMPORT_TOO_LARGE = "import_too_large";
    /** 文件为空。 */
    static final String ST_IMPORT_EMPTY = "import_empty";
    /** 两次独立读入的字节不一致（字节核对失败）。 */
    static final String ST_IMPORT_READBACK_MISMATCH = "import_readback_mismatch";
    /** 读入字节与系统声明的 SIZE 不一致。 */
    static final String ST_IMPORT_DECLARED_SIZE_MISMATCH = "import_declared_size_mismatch";
    /** 不是 ZIP/OOXML 形态（前两字节不是 PK）——拒绝把别的文件当 DOCX 导入。 */
    static final String ST_IMPORT_NOT_ZIP = "import_not_zip";
    /** 暂存到应用私有目录后读回核对失败。 */
    static final String ST_IMPORT_STAGE_FAILED = "import_stage_failed";
    /** 导入并完成字节核对通过。 */
    static final String ST_IMPORT_OK = "import_ok";
    /** 打开文件选择器失败。 */
    static final String ST_IMPORT_PICKER_FAILED = "import_picker_failed";

    // ------------------------------------------------------- PDF 导出 / 打印交接状态词表
    //
    // 纪律（design-05-P8 / WF-089）：**只有** pdf_exported_verified 与 pdf_copy_verified
    // 允许携带“导出成功”语义，且必须**在关闭流之后独立读回核对通过**才允许发出。
    // “无引擎 / 权限不足 / 空间不足 / 超时 / 读回失败 / 不是 PDF / 页数不符 / 空白页 /
    // 摘要不符 / 空文件”必须是**互不相同**的状态，不能合并成一种笼统的“失败”。
    // 打印交接（WF-090）**只有** handed_off，**没有**任何“已打印”的状态。

    /** PDF 导出（应用私有目录）并**独立读回核对通过**——唯一允许宣称导出成功。 */
    static final String ST_PDF_EXPORTED_VERIFIED = "pdf_exported_verified";
    /** PDF 副本已另存到用户所选位置，且**关闭后读回核对通过**。 */
    static final String ST_PDF_COPY_VERIFIED = "pdf_copy_verified";

    /** 请求被拒（同源失败、JSON 非法、文件名非法、超限）——参数问题，不是引擎故障。 */
    static final String ST_PDF_REJECTED = "pdf_rejected";
    /** 设备上没有可用的排版引擎。 */
    static final String ST_PDF_NO_ENGINE = "pdf_no_engine";
    /** 排版超出 deadline。 */
    static final String ST_PDF_TIMEOUT = "pdf_timeout";
    /** 版面计算失败（非引擎缺失、非超时）。 */
    static final String ST_PDF_LAYOUT_FAILED = "pdf_layout_failed";
    /** 目标目录可用空间不足。 */
    static final String ST_PDF_NO_SPACE = "pdf_no_space";
    /** 写入/刷新失败。 */
    static final String ST_PDF_WRITE_FAILED = "pdf_write_failed";
    /** **关闭流**失败（内容可能不完整）。 */
    static final String ST_PDF_CLOSE_FAILED = "pdf_close_failed";
    /** 目标位置写入权限被拒。 */
    static final String ST_PDF_PERMISSION_DENIED = "pdf_permission_denied";
    /** 目标 URI 不可写/已失效。 */
    static final String ST_PDF_TARGET_URI_INVALID = "pdf_target_uri_invalid";
    /** 用户取消另存 PDF。 */
    static final String ST_PDF_COPY_CANCELLED = "pdf_copy_cancelled";
    /** 本会话还没有通过读回核对的 PDF（另存/交接被拒，停在未验证）。 */
    static final String ST_PDF_NOT_VERIFIED = "pdf_not_verified";

    /** 读回本身失败（读不回来 / 系统解析器打不开）。 */
    static final String ST_PDF_READBACK_FAILED = "pdf_readback_failed";
    /** 读回后长度/摘要与写入内容不符。 */
    static final String ST_PDF_COPY_READBACK_MISMATCH = "pdf_copy_readback_mismatch";
    /** 读回内容是 0 字节。 */
    static final String ST_PDF_EMPTY = "pdf_empty";
    /** 读回内容不是 PDF（文件头不是 %PDF-）——改扩展名伪造在这里被抓住。 */
    static final String ST_PDF_NOT_PDF = "pdf_not_pdf";
    /** 读回页数与排版自报页数不符。 */
    static final String ST_PDF_PAGE_MISMATCH = "pdf_page_mismatch";
    /** 读回首页渲染为纯空白（有页无内容）。 */
    static final String ST_PDF_BLANK = "pdf_blank";
    /** 读回摘要与写入内容不符。 */
    static final String ST_PDF_COPY_READBACK_DIGEST_MISMATCH = "pdf_copy_readback_digest_mismatch";
    /** 另存副本时目标 URI 的读回权限被拒（区别于写入权限被拒）。 */
    static final String ST_PDF_COPY_READBACK_PERMISSION_DENIED =
            "pdf_copy_readback_permission_denied";
    /** Activity 重建/进程终止导致待另存 PDF 丢失且无法从核验过的副本恢复。 */
    static final String ST_PDF_STATE_LOST = "pdf_state_lost";

    /** **已交接**给系统打印服务（**不表示已打印**，任务书 §12 七态）。 */
    static final String ST_PRINT_HANDED_OFF = "print_handed_off";
    /** 本会话没有通过读回核对的 PDF，拒绝交接（停在 prepared）。 */
    static final String ST_PRINT_NOT_VERIFIED = "print_not_verified";
    /** 待打印 PDF 不存在或为空。 */
    static final String ST_PRINT_TARGET_MISSING = "print_target_missing";
    /** 交接前重新核对的摘要与读回时不一致（盘上文件被换过）。 */
    static final String ST_PRINT_DIGEST_MISMATCH = "print_digest_mismatch";
    /** 设备没有系统打印服务（PrintManager 不可用）。 */
    static final String ST_PRINT_UNAVAILABLE = "print_unavailable";
    /** 系统打印服务拒绝（权限不足）。 */
    static final String ST_PRINT_PERMISSION_DENIED = "print_permission_denied";
    /** 交接前读取产物失败。 */
    static final String ST_PRINT_OPEN_FAILED = "print_open_failed";

    // ---------------------------------------------------------------- 状态

    private WebView webView;
    private final Handler ui = new Handler(Looper.getMainLooper());

    // ---- APP-01/05/06 生命周期状态 ----

    /** 网络回调句柄（onResume 注册，onDestroy 注销）。 */
    private ConnectivityManager.NetworkCallback networkCallback = null;
    /** 最近一次连通性判定（三态；**未知不折叠成离线**）。 */
    private volatile PotbotConnectivity.Tri connectivity = PotbotConnectivity.Tri.UNKNOWN;
    /** 冷启动迁移结论（onCreate 时算一次，持久化后可用 {@link PotbotUpgrade#lastResult} 复读）。 */
    private PotbotUpgrade.Result upgradeResult = null;
    /** 版本身份（onCreate 时读一次）。 */
    private PotbotAppVersion.Identity appVersion = null;
    /** 冷启动/深链要送回的任务 id（能回到任务就靠它）。 */
    private volatile String pendingRestoreTaskId = null;
    /** 页面是否已加载完成——恢复指令只在页面就绪后推送，避免推给空页面。 */
    private volatile boolean pageReady = false;

    /** 最近一次真正停在本机服务上的页面地址，用于桥方法的同源校验。 */
    private volatile String lastLocalPageUrl = null;

    // ---- 本地内核（K01）接线状态 ----

    /**
     * 本地内核桥是否已经注册进当前 WebView 的 JS 面。
     * **只在主线程读写**（注册点是 onCreate / onResume 的 {@link #requestKernelBridgeAttach}）。
     */
    private boolean kernelBridgeAttached = false;
    /** 是否已有一条注册重试链在跑（避免 onCreate 与 onResume 各起一条）。 */
    private boolean kernelAttachInFlight = false;

    // ---- APK 内置本地页面状态 ----

    /** 本次正在加载的是 APK 内置页面（用于失败回退判定；只在主线程读写）。 */
    private boolean loadingBundledLocalUi = false;
    /** 内置页面加载失败后的**一次性**远程回退是否已用掉（防止来回跳）。 */
    private boolean localUiFallbackDone = false;

    /**
     * APP-03：最近一次外部输入（系统分享 / 用本应用打开）的**判定结论**。
     * 只存结论（识别到什么、不支持什么），页面通过 {@code incomingInput()} 读它。
     */
    private volatile PotbotInputGateway.Incoming lastIncomingInput = null;

    /** APP-08：长文本草稿（进程重建时恢复用；旋转由清单 configChanges 就地处理）。 */
    private volatile String composerDraft = null;

    /** ACTION_CREATE_DOCUMENT 待写入的内容（仅在内存；另存有应用私有副本可恢复）。 */
    private volatile byte[] pendingBytes = null;
    private volatile String pendingFileName = null;
    /** 另存请求是否在途（跨 Activity 重建用 Bundle 恢复）。 */
    private volatile boolean pendingSaveCopyInFlight = false;
    /** 另存前的应用私有副本绝对路径——Activity 重建后据此恢复待保存内容。 */
    private volatile String pendingSaveCopyArtifactPath = null;

    /** 导入请求是否在途（跨 Activity 重建用 Bundle 恢复）。 */
    private volatile boolean pendingImportInFlight = false;
    /** 导入请求来源：picker（用户选文件）或 reimport（导回已知 URI）。 */
    private volatile String pendingImportOrigin = null;
    /** reimport 请求的 URI 字符串。 */
    private volatile String pendingImportUri = null;

    /**
     * 本应用真正取得过授权的 content:// 文档。**只允许**对这里登记过的 URI 做再次读入，
     * 页面不能凭一个字符串让宿主读任意 content:// 内容。
     */
    private final Set<String> grantedContentUris = Collections.synchronizedSet(new HashSet<String>());

    // ---- PDF / 打印：**只有**通过独立读回核对的产物才会被登记到这里 ----

    /** 最近一次通过读回核对的 PDF 绝对路径；未经核对一律为 null（交接会因此被拒）。 */
    private volatile String verifiedPdfPath = null;
    /** 该 PDF 读回时的 sha256（交接前据此重新核对盘上字节）。 */
    private volatile String verifiedPdfSha256 = null;
    /** 读回器报出的真实页数。 */
    private volatile int verifiedPdfPages = -1;
    /** 该 PDF 的显示文件名（仅用于打印作业名 / 另存默认名）。 */
    private volatile String verifiedPdfName = null;

    /** 另存 PDF 请求是否在途（跨 Activity 重建用 Bundle 恢复）。 */
    private volatile boolean pendingPdfCopyInFlight = false;
    /** 待另存的、已核对 PDF 的绝对路径。 */
    private volatile String pendingPdfCopySourcePath = null;

    // ---------------------------------------------------------------- 生命周期

    private static final String STATE_SAVE_COPY_IN_FLIGHT = "potbot.saveCopyInFlight";
    private static final String STATE_SAVE_COPY_ARTIFACT = "potbot.saveCopyArtifact";
    private static final String STATE_SAVE_COPY_NAME = "potbot.saveCopyName";
    private static final String STATE_IMPORT_IN_FLIGHT = "potbot.importInFlight";
    private static final String STATE_IMPORT_ORIGIN = "potbot.importOrigin";
    private static final String STATE_IMPORT_URI = "potbot.importUri";
    private static final String STATE_PDF_COPY_IN_FLIGHT = "potbot.pdfCopyInFlight";
    private static final String STATE_PDF_COPY_SOURCE = "potbot.pdfCopySource";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // APP-01：冷启动**先跑一次**升级/迁移路径（结论持久化，随后回报给页面）。
        // 失败/拒绝时只记录，不崩、不静默改数据。
        upgradeResult = PotbotUpgrade.run(this);
        // APP-01：读一次版本身份（设备上实际安装的版本 vs 注入的产品版本）。
        appVersion = PotbotAppVersion.read(this);
        // APP-05：冷启动"回到任务"——除 Bundle 外还有持久状态（系统强杀后 Bundle 不回来）。
        PotbotTaskState.Active restoredActive = PotbotTaskState.restoreActive(this);
        if (restoredActive != null && restoredActive.isPresent()) {
            pendingRestoreTaskId = restoredActive.taskId;
        }
        String intentTaskId = taskIdFromIntent(getIntent());
        if (intentTaskId != null) {
            pendingRestoreTaskId = intentTaskId; // 深链优先级更高
        }
        // APP-03：把外部输入（系统分享等）解析成"识别到什么 / 不支持什么"的**结论**。
        // 判定只发生在 PotbotInputGateway，页面通过 incomingInput() 读结论，不自己猜类型。
        lastIncomingInput = PotbotInputGateway.parseIncoming(this, getIntent());
        // APP-08：进程被系统回收后重建时把长文本草稿带回来。
        // （旋转/字号变化由清单的 configChanges 就地处理，不重建，因此不走这里。）
        composerDraft = PotbotAccessibility.getDraft(savedInstanceState);

        if (savedInstanceState != null) {
            pendingSaveCopyInFlight = savedInstanceState.getBoolean(STATE_SAVE_COPY_IN_FLIGHT, false);
            pendingSaveCopyArtifactPath = savedInstanceState.getString(STATE_SAVE_COPY_ARTIFACT);
            pendingFileName = savedInstanceState.getString(STATE_SAVE_COPY_NAME);
            pendingImportInFlight = savedInstanceState.getBoolean(STATE_IMPORT_IN_FLIGHT, false);
            pendingImportOrigin = savedInstanceState.getString(STATE_IMPORT_ORIGIN);
            pendingImportUri = savedInstanceState.getString(STATE_IMPORT_URI);
            pendingPdfCopyInFlight = savedInstanceState.getBoolean(STATE_PDF_COPY_IN_FLIGHT, false);
            pendingPdfCopySourcePath = savedInstanceState.getString(STATE_PDF_COPY_SOURCE);
        }

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 收紧 WebView：不给本地文件/内容协议访问权，避免页面借 WebView 读本地文件。
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(true);
        }
        // APP-08：跟随系统字号（大字模式），不做固定死字号；并给内容区一个朗读文案，
        // 免得屏幕阅读器把整块内容读成空白。
        s.setTextZoom(PotbotAccessibility.textZoomPercent(this));
        webView.setContentDescription(getString(R.string.potbot_a11y_content_desc));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return routeUrl(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return routeUrl(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (isTrustedPageOrigin(url)) {
                    lastLocalPageUrl = url;
                    pageReady = true;
                    // 页面就绪后：把"回到任务"与上次已知进度推给页面（页面实现了才收到）。
                    pushRestoreToPage();
                    reportAppState();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) {
                    return; // 子资源错误不冒充"页面没加载出来"
                }
                pageReady = false;
                if (fallBackToRemoteIfBundledPageFailed(request)) {
                    return; // 已切回既有远程端点：这不是"页面彻底打不开"，按回退处理（原因已入日志）
                }
                String detail = error == null ? "" : String.valueOf(error.getDescription());
                reportAppLifecycle(false, ST_APP_PAGE_LOAD_FAILED,
                        "页面加载失败（未把旧内容当成已加载）：" + detail);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse errorResponse) {
                if (request == null || !request.isForMainFrame()) {
                    return;
                }
                if (fallBackToRemoteIfBundledPageFailed(request)) {
                    return; // 同上：内置页面 404/500 时回退，而不是把宿主页面开成空白
                }
                int code = errorResponse == null ? -1 : errorResponse.getStatusCode();
                reportAppLifecycle(false, ST_APP_PAGE_HTTP_ERROR,
                        "页面请求返回 HTTP " + code + "：内容可能不完整。");
            }
        });

        // WebView 不会自动下载文件；这里也不替它猜。凡是走到普通下载路径的，
        // 一律如实回报失败，让页面提示改用应用内保存按钮——不允许静默什么都不发生。
        webView.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                reportStatus(false, ST_SAVE_REJECTED,
                        "该链接走的是浏览器下载路径，本 Demo 不接管；"
                        + "请使用页面上的「保存到手机 / 打开」按钮（它走 window.PotbotNative.saveDocx 并对文件做摘要校验）。URL=" + url);
            }
        });

        webView.addJavascriptInterface(new PotbotBridge(), JS_BRIDGE_NAME);
        // 本地页面是 file://（origin="null"），PC 后端又不发 CORS 头 ⇒ 页面自己 fetch 必然被拦。
        // 因此再注册一个**只做 HTTP 转发**的面：window.PotbotHost.getJson/postJson（见本类分节）。
        webView.addJavascriptInterface(new PotbotHostBridge(), JS_HOST_BRIDGE_NAME);
        // K01：把手机内核运行时拉起来（同进程显式 Intent），并在主线程尝试把它的桥注册进
        // 页面 JS 面。**fail-safe**：服务没起来 / 取不到桥 / 注册抛错，一律只记日志——
        // 页面继续按"远程页面"模式工作，与改动前完全一致，不崩、不卡主线程。
        requestKernelBridgeAttach("onCreate");
        setContentView(webView);
        // APP-06：首页地址来自**可配置**端点，而不是写死的回环地址。
        // K-UI：但**优先**加载打进 APK 的内置页面；没有（或加载失败）才回退到上面这条远程路径。
        loadStartPage();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putBoolean(STATE_SAVE_COPY_IN_FLIGHT, pendingSaveCopyInFlight);
        outState.putString(STATE_SAVE_COPY_ARTIFACT, pendingSaveCopyArtifactPath);
        outState.putString(STATE_SAVE_COPY_NAME, pendingFileName);
        outState.putBoolean(STATE_IMPORT_IN_FLIGHT, pendingImportInFlight);
        outState.putString(STATE_IMPORT_ORIGIN, pendingImportOrigin);
        outState.putString(STATE_IMPORT_URI, pendingImportUri);
        outState.putBoolean(STATE_PDF_COPY_IN_FLIGHT, pendingPdfCopyInFlight);
        outState.putString(STATE_PDF_COPY_SOURCE, pendingPdfCopySourcePath);
        // APP-08：长文本草稿（超长时**整体不存**，不存半截冒充全文）。
        PotbotAccessibility.putDraft(outState, composerDraft);
    }

    // ------------------------------------------------- APP-05/06 生命周期（退后台/锁屏/网络切换/回到任务）

    @Override
    protected void onResume() {
        super.onResume();
        // 回到前台：不再需要后台轮询，取消作业（避免与前台双份读取）。
        PotbotProgressJobService.cancel(this);
        refreshConnectivity();
        registerNetworkCallbackIfNeeded();
        pushRestoreToPage();
        reportAppState();
        // FA-APP-NOTIFY-PERM：API 33+ 的 POST_NOTIFICATIONS 只在"未授权且没问过"时请求一次；
        // 拒绝即降级（通知发不出，进度仍可从持久层读回），不重复弹窗、不崩溃。
        PotbotNotificationPermission.requestIfNeeded(this);
        // K01：回前台再确认一次内核桥（服务被杀过、或上次重试超时的情况靠这里补上）。
        // 幂等：已注册或已有尝试链时立即返回；取不到仍只记日志，不影响页面。
        requestKernelBridgeAttach("onResume");
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 任何离开前台（含锁屏）都先落一次"当前任务"，系统随时可能回收进程。
        persistActiveTaskState();
    }

    @Override
    protected void onStop() {
        super.onStop();
        persistActiveTaskState();
        if (!isFinishing()) {
            // 退后台/锁屏：排一次后台进度作业——**前台不常开也能获知进度**（R256）。
            // 任务到终态或没有活动任务时，作业自己不再重排（见 PotbotProgressJobService）。
            PotbotProgressJobService.schedule(this);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent); // singleTask：新意图必须显式接管，否则 getIntent() 仍是旧的
        // APP-03：分享进来的第二次及以后（singleTask 不重建 Activity），同样只解析**结论**。
        lastIncomingInput = PotbotInputGateway.parseIncoming(this, intent);
        String taskId = taskIdFromIntent(intent);
        if (taskId != null) {
            // 点通知/深链回到任务（R256）。
            pendingRestoreTaskId = taskId;
            pushRestoreToPage();
        }
    }

    @Override
    protected void onDestroy() {
        unregisterNetworkCallback();
        // K01：先摘内核桥的事件下行口，切断"内核线程 → 本 Activity"的引用，再销毁 WebView。
        detachKernelBridge();
        if (webView != null) {
            webView.removeJavascriptInterface(JS_BRIDGE_NAME);
            // 与上面同一时机、同一方式摘掉后端转发面（两个面都是本 Activity 的对象，
            // 不摘会留一个指向已销毁 WebView 的悬垂引用）。
            webView.removeJavascriptInterface(JS_HOST_BRIDGE_NAME);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // APP-08：旋转/字号变化是**就地**处理的（清单声明 configChanges），不重建 Activity，
        // 因此页面里的输入内容天然保留；这里只需把文本缩放重新按系统字号算一次。
        WebView v = webView;
        if (v != null) {
            try {
                v.getSettings().setTextZoom(PotbotAccessibility.textZoomPercent(this));
            } catch (Throwable e) {
                Log.w(TAG, "重算文本缩放失败（保持原值）", e);
            }
        }
    }

    // ------------------------------------------------------- 本地内核（K01）接线
    //
    // 这一节做三件事，顺序固定：
    //   1) 用**显式 Intent** 启动同进程的 KernelRuntimeService（ACTION_START）；
    //   2) 在主线程取回它 **当前存活** 的桥（KernelRuntimeService.getBridge()），
    //      取到才注册：WebView.addJavascriptInterface(bridge, "PotbotKernel")；
    //   3) 给桥接上**事件下行口**（setEventSink）：内核线程把事件 JSON 交进来，
    //      宿主切主线程用 evaluateJavascript 投给页面的 window.PotbotKernelEvent。
    //
    // fail-safe（本轮硬要求）：任一步失败都**不**影响页面加载——页面继续只连远程端点，
    // 与改动前行为一致。**绝不**在主线程上等待服务就绪（只用一次有界重试链）。
    //
    // 未在本节做的事（如实登记，见 MAINACTIVITY-KERNEL-WIRING.md）：
    //   - 不启动 ForegroundTaskService / ResumeJobService（K-I21 那两个服务只在"真跑长任务"
    //     时才该起；当前没有任何调用方，且前台服务要常驻通知，起它等于多一个用户可见副作用）；
    //   - 不注入 JsEngine（选型归 arm64 spike），也不拷 assets 引导层（归 K-I14 lane）。
    //     因此即使桥注册成功，submit 仍会 fail-closed 返回 EXECUTOR_UNAVAILABLE —— 不谎报成功。

    /** 是否已经请求过启动内核服务（避免每次回前台都重发同一条启动指令）。 */
    private boolean kernelRuntimeStartRequested = false;

    /**
     * 请求启动本地内核运行时服务。**同进程**显式 Intent（{@code ACTION_START}），
     * 任何异常只记日志：API 26+ 在后台直接 {@code startService} 会抛
     * {@link IllegalStateException}，这里必须吞掉而不是让宿主崩。
     */
    private void startKernelRuntimeIfNeeded() {
        if (kernelRuntimeStartRequested) {
            return;
        }
        kernelRuntimeStartRequested = true;
        try {
            Intent intent = new Intent(this, KernelRuntimeService.class);
            intent.setAction(KernelRuntimeService.ACTION_START);
            startService(intent);
            Log.i(TAG, "已请求启动本地内核运行时服务（ACTION_START）");
        } catch (Throwable e) {
            // 起不来不是致命：页面照旧走远程端点。
            Log.w(TAG, "启动本地内核服务失败，保持原远程页面模式：" + e.getClass().getSimpleName());
        }
    }

    /**
     * 发起一次"把内核桥注册进页面"的尝试链（主线程、有界、非阻塞）。
     * 幂等：已注册或已有尝试链在跑时直接返回。
     */
    private void requestKernelBridgeAttach(String reason) {
        if (kernelBridgeAttached || kernelAttachInFlight) {
            return;
        }
        startKernelRuntimeIfNeeded();
        kernelAttachInFlight = true;
        Log.i(TAG, "尝试注册本地内核桥（" + reason + "）");
        attachKernelBridgeAttempt(0);
    }

    /**
     * 单次注册尝试；取不到桥就稍后重试（服务 onCreate 与 Activity onCreate 同一消息循环，
     * 服务实例通常在下一条主线程消息才就绪，所以必须"再取一次"而不是立刻放弃）。
     */
    private void attachKernelBridgeAttempt(final int attempt) {
        attachKernelBridgeOnce();
        if (kernelBridgeAttached) {
            kernelAttachInFlight = false;
            return;
        }
        if (attempt >= KERNEL_ATTACH_MAX_ATTEMPTS) {
            kernelAttachInFlight = false;
            Log.w(TAG, "内核桥在 " + (attempt + 1) + " 次尝试（约 "
                    + (KERNEL_ATTACH_MAX_ATTEMPTS * KERNEL_ATTACH_RETRY_MS) + " ms）内仍未就绪："
                    + "不注册 window." + JS_KERNEL_BRIDGE_NAME
                    + "，页面按原远程模式继续工作（fail-safe，非致命）。");
            return;
        }
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                attachKernelBridgeAttempt(attempt + 1);
            }
        }, KERNEL_ATTACH_RETRY_MS);
    }

    /**
     * 一次注册尝试（主线程）。三道 fail-safe 闸门：
     * WebView 已销毁 ⇒ 不注册；服务未起（getBridge() 返回 null）⇒ 不注册；
     * 注册本身抛错 ⇒ 记日志、不注册。**任何情况下都不向页面暴露半成品桥**。
     */
    private void attachKernelBridgeOnce() {
        if (kernelBridgeAttached) {
            return;
        }
        final WebView v = webView;
        if (v == null) {
            Log.w(TAG, "WebView 已销毁，跳过内核桥注册");
            return;
        }
        KernelLocalUiBridge bridge;
        try {
            bridge = KernelRuntimeService.getBridge();
        } catch (Throwable e) {
            Log.w(TAG, "取内核桥失败（保持远程页面模式）：" + e.getClass().getSimpleName());
            return;
        }
        if (bridge == null) {
            Log.i(TAG, "内核桥暂不可用（服务尚未创建或已销毁）：本次不注册");
            return;
        }
        try {
            // 先接事件下行口，再注册 JS 面：页面一旦能调 subscribe，事件就已经有去处。
            bridge.setEventSink(new KernelEventSink());
            v.addJavascriptInterface(bridge, JS_KERNEL_BRIDGE_NAME);
            kernelBridgeAttached = true;
            Log.i(TAG, "本地内核桥已注册为 window." + JS_KERNEL_BRIDGE_NAME
                    + "（submit / subscribe / unsubscribe / cancel）");
            notifyKernelReady();
        } catch (Throwable e) {
            Log.w(TAG, "注册本地内核桥失败（保持远程页面模式）：" + e.getClass().getSimpleName());
        }
    }

    /**
     * 事件下行口：内核线程上被调用 ⇒ 切回主线程 ⇒ 经 {@code evaluateJavascript} 投给页面。
     * 页面未实现 {@link #JS_KERNEL_EVENT_FN} 时静默（既有页面不受影响）。
     */
    private final class KernelEventSink implements KernelLocalUiBridge.EventSink {
        @Override
        public void onEvent(String subscriptionId, String eventJson) {
            final String js = "javascript:(function(){try{"
                    + "if(typeof window." + JS_KERNEL_EVENT_FN + "==='function'){window."
                    + JS_KERNEL_EVENT_FN + "("
                    + JSONObject.quote(subscriptionId == null ? "" : subscriptionId) + ","
                    + JSONObject.quote(eventJson == null ? "" : eventJson) + ");}"
                    + "}catch(e){}})()";
            emitKernelJs(js, "内核事件下行");
        }
    }

    /** 通知页面"内核桥已就绪"（页面未实现该可选回调时静默）。 */
    private void notifyKernelReady() {
        final String js = "javascript:(function(){try{"
                + "if(typeof window." + JS_KERNEL_READY_FN + "==='function'){window."
                + JS_KERNEL_READY_FN + "();}"
                + "}catch(e){}})()";
        emitKernelJs(js, "内核就绪通知");
    }

    /** 把一段 JS 切回主线程投给当前 WebView；WebView 已销毁则丢弃（不报错、不崩溃）。 */
    private void emitKernelJs(final String js, final String what) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                WebView v = webView;
                if (v == null) {
                    return;
                }
                try {
                    v.evaluateJavascript(js, null);
                } catch (Throwable e) {
                    Log.w(TAG, what + "失败（不致命）：" + e.getClass().getSimpleName());
                }
            }
        });
    }

    /**
     * 摘掉内核桥接线（Activity 销毁时）：先把桥的事件下行口置空，切断
     * "内核线程 → 本 Activity"的引用（防止泄漏已销毁的 Activity / WebView）。
     * 内核服务本身**不**在这里停：它是进程级的，回收交给系统。
     */
    private void detachKernelBridge() {
        if (kernelBridgeAttached) {
            try {
                KernelLocalUiBridge bridge = KernelRuntimeService.getBridge();
                if (bridge != null) {
                    bridge.setEventSink(null);
                }
            } catch (Throwable e) {
                Log.w(TAG, "摘除内核事件下行口失败（已忽略）：" + e.getClass().getSimpleName());
            }
            WebView v = webView;
            if (v != null) {
                try {
                    v.removeJavascriptInterface(JS_KERNEL_BRIDGE_NAME);
                } catch (Throwable e) {
                    Log.w(TAG, "注销内核 JS 面失败（已忽略）：" + e.getClass().getSimpleName());
                }
            }
            kernelBridgeAttached = false;
            kernelAttachInFlight = false;
        }
    }

    // ------------------------------------------------------------- URL 路由

    /** true = 已被本方法处理（外部浏览器/系统），false = 允许 WebView 自己加载。 */
    private boolean routeUrl(Uri uri) {
        if (uri == null) {
            return true;
        }
        if (isTrustedPageOrigin(uri.toString())) {
            return false; // 只放行本机服务
        }
        // 其他一切（含 https 外链、mailto:、tel: 等）交给系统处理，不在 WebView 内打开。
        try {
            Intent ext = new Intent(Intent.ACTION_VIEW, uri);
            ext.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(ext);
        } catch (ActivityNotFoundException e) {
            toast("没有可用于打开该链接的应用：" + uri.getScheme());
        }
        return true;
    }

    /**
     * 开发默认地址的严格判定：scheme/http + host/127.0.0.1 + port/8765，其它一律不算。
     * **仅用于回环开发模式**；真实可信同源见 {@link #isTrustedPageOrigin(String)}。
     */
    private static boolean isDevLoopbackOrigin(String url) {
        if (url == null) {
            return false;
        }
        Uri u;
        try {
            u = Uri.parse(url);
        } catch (Exception e) {
            return false;
        }
        if (!"http".equalsIgnoreCase(u.getScheme())) {
            return false;
        }
        if (!HOST.equals(u.getHost())) {
            return false;
        }
        int p = u.getPort();
        return p == PORT || p == -1 && PORT == 80;
    }

    /**
     * **可信同源**：当前配置的服务地址（{@link PotbotEndpoints#baseUrl}）本身、
     * 开发默认回环地址，或**本 APK 自带的内置页面**（{@link #LOCAL_UI_ASSET_DIR_URL}）。
     * 判定与改动前的写死回环**同样严格**（scheme + host + port 全等，无子域、无跳转、
     * 无任意主机）；内置页面的边界见 {@link #isBundledLocalUiUrl(String)}。
     */
    private boolean isTrustedPageOrigin(String url) {
        if (isDevLoopbackOrigin(url)) {
            return true;
        }
        if (isBundledLocalUiUrl(url)) {
            return true;
        }
        if (url == null) {
            return false;
        }
        try {
            return PotbotEndpoints.matchesConfiguredOrigin(this, Uri.parse(url));
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 是不是**本 APK 自带的**内置页面。
     *
     * <p>边界为什么是安全的：`file:///android_asset/` 由 WebView **直接解析本应用 APK 内的
     * assets**，外部应用/网页**无法**提供这个源下的内容（没有可写入口，也不是可被第三方
     * 注册的 scheme handler）。判定只认 `ui/` 目录前缀，不接受别的 assets 路径，
     * 也不接受任何其他 `file://` 路径。
     */
    private static boolean isBundledLocalUiUrl(String url) {
        return url != null && url.startsWith(LOCAL_UI_ASSET_DIR_URL);
    }

    /** 当前要加载的远程首页地址（来自可配置端点，APP-06）。 */
    private String startUrl() {
        return PotbotEndpoints.baseUrl(this) + "/";
    }

    /**
     * 加载首页：**优先**用打进 APK 的内置界面（离线可用），否则按今天的远程端点加载。
     *
     * <p>fail-safe：assets 探测或 `loadUrl` 任一步失败 ⇒ 落到既有的
     * {@code webView.loadUrl(startUrl())} 路径，行为与改动前**逐字一致**，
     * 绝不留白屏、绝不崩。回退原因记日志。
     */
    private void loadStartPage() {
        if (hasBundledLocalUi()) {
            try {
                loadingBundledLocalUi = true;
                Log.i(TAG, "加载 APK 内置本地页面：" + LOCAL_UI_ASSET_URL);
                webView.loadUrl(LOCAL_UI_ASSET_URL);
                return;
            } catch (Throwable e) {
                loadingBundledLocalUi = false;
                Log.w(TAG, "内置本地页面加载失败，回退远程端点：" + e.getClass().getSimpleName());
            }
        } else {
            Log.i(TAG, "未发现内置本地页面（assets/" + LOCAL_UI_ASSET_PATH + " 缺失或不可读）：按原远程端点加载");
        }
        loadingBundledLocalUi = false;
        webView.loadUrl(startUrl());
    }

    /** APK 里到底有没有内置界面（能打开 assets 里的首页即算有；打不开一律当作没有）。 */
    private boolean hasBundledLocalUi() {
        InputStream in = null;
        try {
            in = getAssets().open(LOCAL_UI_ASSET_PATH);
            return true;
        } catch (Throwable e) {
            return false;
        } finally {
            closeQuietly(in);
        }
    }

    /**
     * 内置页面加载失败时的**一次性**远程回退。
     *
     * @return true = 已经发起回退（调用方不必再按"页面彻底失败"回报）；
     *         false = 与内置页面无关（或回退已用掉），调用方照旧走既有失败回报。
     */
    private boolean fallBackToRemoteIfBundledPageFailed(WebResourceRequest request) {
        if (!loadingBundledLocalUi || localUiFallbackDone) {
            return false;
        }
        final String failing = request.getUrl() == null ? null : request.getUrl().toString();
        if (!isBundledLocalUiUrl(failing)) {
            return false;
        }
        localUiFallbackDone = true;
        loadingBundledLocalUi = false;
        Log.w(TAG, "内置本地页面加载失败（" + failing + "），回退到配置端点 " + configuredOrigin());
        try {
            webView.loadUrl(startUrl());
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "回退远程端点也失败：" + e.getClass().getSimpleName());
            return false;
        }
    }

    /** 当前可信源的显示地址（用于拒绝消息；开发模式即回环地址，部署模式即后端地址）。 */
    private String configuredOrigin() {
        return PotbotEndpoints.baseUrl(this);
    }

    // ------------------------------------------------------------- JS 桥

    /**
     * 唯一原生能力入口。
     *
     * 既有方法名与签名是共享合同 v1 的一部分，**未改动**：
     *   {@code saveDocx(downloadPath, filename, sha256, byteLength) -> void}
     *   {@code saveCopy(downloadPath, filename, sha256, byteLength) -> void}
     *
     * 本轮**新增**（design-05-P8 文件导入/导回）：
     *   {@code importDocx() -> void}            —— SAF ACTION_OPEN_DOCUMENT 选文件导入
     *   {@code importDocxFromUri(uri) -> void}  —— 把先前取得过授权的 content:// 文档重新读回
     * 两者都不改变既有两个方法的行为语义。回报通道仍是
     * {@code PotbotBridgeResult(ok, message)}（签名不变），消息带 {@code [status=...]} 尾巴；
     * 另有一个**可选**的 {@code PotbotBridgeStatus(json)} 结构化通道（页面未实现则忽略）。
     */
    private final class PotbotBridge {

        @JavascriptInterface
        public void saveDocx(String downloadPath, String filename, String sha256, long byteLength) {
            startSave(downloadPath, filename, sha256, byteLength, false);
        }

        @JavascriptInterface
        public void saveCopy(String downloadPath, String filename, String sha256, long byteLength) {
            startSave(downloadPath, filename, sha256, byteLength, true);
        }

        /** 用户选一个既有 DOCX 导入（SAF ACTION_OPEN_DOCUMENT）。 */
        @JavascriptInterface
        public void importDocx() {
            startImportPicker();
        }

        /** 把先前经本应用取得授权的 content:// 文档重新读回（例如刚另存的副本）。 */
        @JavascriptInterface
        public void importDocxFromUri(String uriString) {
            startReimport(uriString);
        }

        /**
         * 本轮**新增**（design-05-P8 / WF-089）：把页面送来的文档模型用**真实排版引擎**
         * 排成 PDF，写入应用私有目录，并**独立读回核对**（存在 / 非空 / `%PDF-` 魔数 /
         * 系统解析器页数 / 首页有墨迹 / 摘要）。核对通过才回报 `pdf_exported_verified`。
         */
        @JavascriptInterface
        public void exportPdf(String docJson) {
            startExportPdf(docJson);
        }

        /**
         * 本轮**新增**（WF-089）：把刚导出并**通过读回核对**的 PDF 另存到用户选的位置
         * （SAF ACTION_CREATE_DOCUMENT），写入后同样**关闭流并读回核对**才标 verified。
         */
        @JavascriptInterface
        public void savePdfCopy() {
            startSavePdfCopy();
        }

        /**
         * 本轮**新增**（WF-090）：把**已核对过**的 PDF 交给系统打印服务。
         * **只交接，不代打印**——回报到 `print_handed_off` 为止，绝不宣称"已打印"。
         */
        @JavascriptInterface
        public void printPdf() {
            startPrintHandoff();
        }

        /**
         * APP-01：**只读**回报 App 侧事实（版本身份 / 升级结论 / 连接与地址 / 凭据有无）。
         * 凭据的值**不在**返回值里（只报有无）。
         */
        @JavascriptInterface
        public String appInfo() {
            return buildAppInfoJson();
        }

        /**
         * APP-05：页面告诉宿主"用户当前停在哪个任务"。落盘后，冷启动/进程被强杀再回来
         * 也能送回该任务。只接受可信页面调用；只写本应用的私有状态。
         */
        @JavascriptInterface
        public void reportActiveTask(String taskId, String conversationId, String route, String url) {
            if (!isTrustedPageOrigin(lastLocalPageUrl)) {
                reportAppLifecycle(false, ST_APP_REJECTED,
                        "同源校验失败：非可信页面，拒绝写入当前任务状态。");
                return;
            }
            PotbotTaskState.saveActive(MainActivity.this, taskId, conversationId, route, url);
            if (taskId != null && !taskId.isEmpty()) {
                pendingRestoreTaskId = taskId;
            }
        }

        /**
         * APP-03：只读回报"最近一次外部输入的识别结论"（来源 / 类型 / 是否接受 / 为什么不接受）。
         * 页面据此显示"这个类型不支持"，**不自己猜**。不含任何凭据、不含长文本全文。
         */
        @JavascriptInterface
        public String incomingInput() {
            return PotbotInputGateway.describeJson(lastIncomingInput);
        }

        /**
         * APP-08：页面把**长文本草稿**交给宿主，进程被杀后重建时还能还回来
         * （旋转/字号变化不重建，不需要走这里）。只接受可信页面调用。
         */
        @JavascriptInterface
        public void reportComposerDraft(String draft) {
            if (!isTrustedPageOrigin(lastLocalPageUrl)) {
                reportAppLifecycle(false, ST_APP_REJECTED,
                        "同源校验失败：非可信页面，拒绝写入草稿。");
                return;
            }
            composerDraft = draft;
        }

        /** APP-08：读回上次的长文本草稿（没有则返回空串——由页面自己判断"无草稿"）。 */
        @JavascriptInterface
        public String readComposerDraft() {
            return composerDraft == null ? "" : composerDraft;
        }

        /**
         * APP-05：取消任务。带**持久幂等键**——连点/重试/重启后重试都是同一个键，
         * 因此取消不会重复执行（R257）。后端不支持取消时如实报"未取消"，绝不宣称已取消。
         */
        @JavascriptInterface
        public void cancelTask(String taskId) {
            if (!isTrustedPageOrigin(lastLocalPageUrl)) {
                reportAppLifecycle(false, ST_APP_REJECTED, "同源校验失败：非可信页面，拒绝取消请求。");
                return;
            }
            PotbotTaskActions.cancel(MainActivity.this, taskId, actionReporter());
        }

        /**
         * APP-05：重连续取。同样带持久幂等键与**续取游标**（R208）——只续取，不重放；
         * 读不到就如实报离线，不假装已恢复。
         */
        @JavascriptInterface
        public void reconnectTask(String taskId) {
            if (!isTrustedPageOrigin(lastLocalPageUrl)) {
                reportAppLifecycle(false, ST_APP_REJECTED, "同源校验失败：非可信页面，拒绝重连请求。");
                return;
            }
            PotbotTaskActions.reconnect(MainActivity.this, taskId, actionReporter());
        }

        /** 只回报事实，不暴露任何执行能力。 */
        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }

    /**
     * PC 后端 HTTP 桥 —— 页面全局名 {@code window.PotbotHost}。
     *
     * <p>存在的理由（页面侧的事实，不是猜测）：页面从 {@code file:///android_asset/ui/index.html}
     * 加载，该源的 origin 是 {@code "null"}；PC 后端不给 {@code Access-Control-Allow-Origin}，
     * 所以页面里的 {@code fetch} 必然被判同源策略拦下。**唯一**绕开的办法是让原生侧代发
     * ——原生 HTTP 不受 CORS 约束。这里就是那个代发口。
     *
     * <p>契约（页面对它编码中，**不得**单方面改签名/返回形状；见 HOST-HTTP-BRIDGE.md）：
     * <pre>
     *   String getJson(String path)                 // GET  &lt;base&gt;&lt;path&gt; → 响应体 JSON 文本
     *   String postJson(String path, String body)   // POST &lt;base&gt;&lt;path&gt;（JSON 体）→ 响应体 JSON 文本
     * </pre>
     * {@code base} = {@link PotbotEndpoints#baseUrl(Context)}（与 App 其他出网路径**同源**，
     * 不是写死的回环地址）；2xx 时**原样返回响应体文本**（不套 {"ok":true} 外壳）；
     * 任何失败一律返回 {@code {"ok":false,"error":"<short reason>"}}，**绝不**向 JS 抛异常。
     *
     * <p>线程：这两个方法**在调用线程上同步阻塞**（JS 侧在等返回值，无法异步回填）。
     * 这是安全的，因为 WebView 把 {@code @JavascriptInterface} 调用放在它自建的
     * **私有后台线程**（线程名 {@code JavaBridge}）上执行，不是 UI 线程；本工程
     * {@code minSdk 24}（≥ API 17 的 JellyBean MR1，该行为自 L MR1 / Chromium M39 起固定），
     * 因此阻塞的**只有那条桥线程**。
     *
     * <p>**不做**的事：不接受页面给的主机名（base 固定）、不跟随跳转、
     * 不转发 Cookie/Authorization、不提供任意 URL 抓取（path 有硬校验）、
     * 不做流式/分块上传（POST 体一次性按字节发）。
     */
    private final class PotbotHostBridge {

        /** GET {@code <base><path>}，返回响应体文本（JSON 字符串）。 */
        @JavascriptInterface
        public String getJson(String path) {
            return hostRoundTrip("GET", path, null);
        }

        /** POST {@code <base><path>}（body 按 application/json; charset=utf-8 发），返回响应体文本。 */
        @JavascriptInterface
        public String postJson(String path, String body) {
            // body 为 null 也当空 JSON 体发，不让 null 直接落到 IO 层。
            return hostRoundTrip("POST", path, body == null ? "" : body);
        }
    }

    /**
     * 一次转发的**全部**失败处理都收在这里：先校验 path，再发请求；
     * 无论哪一步抛错，都只回 {@code {"ok":false,...}}，绝不把异常穿到 JS 边界。
     * 方法在调用线程（WebView 的 JavaBridge 后台线程）上同步跑完。
     */
    private String hostRoundTrip(String method, String path, String body) {
        try {
            String reason = hostPathRejectReason(path);
            if (reason != null) {
                return hostErrorJson(reason);
            }
            return hostHttpRequest(method, path, body);
        } catch (Throwable e) {
            // 兜底臂：校验、建连、读体、编码任何一处抛错都从这里出去。
            Log.w(TAG, "PC 后端转发失败（已转为错误 JSON，不抛给页面）：" + e.getClass().getSimpleName());
            return hostErrorJson(e.getClass().getSimpleName() + ": " + safeMsg(e));
        }
    }

    /**
     * 页面送来的 path 校验。返回 {@code null} = 放行；否则返回一句**短的**拒绝原因。
     *
     * <p>规则（顺序执行，任一命中即拒）：
     * <ol>
     *   <li>非空；</li>
     *   <li>必须以**单个** {@code /} 开头（相对本机服务），{@code //} 开头也拒（会被当协议相对地址）；</li>
     *   <li>不得含 {@code ://}（禁止绝对 URL，防止被当开放代理）；</li>
     *   <li>不得含 {@code ..}（禁止路径穿越出服务根）；</li>
     *   <li>不得含 CR/LF（禁止请求行/头注入）；</li>
     *   <li>不得含反斜杠（与既有的 downloadPath 校验同一口径）。</li>
     * </ol>
     * 查询串（{@code ?a=b}）是允许的，路径里也不会再拼主机名——base 由宿主自己取配置端点。
     */
    private static String hostPathRejectReason(String path) {
        if (path == null || path.isEmpty()) {
            return "path 为空";
        }
        if (!path.startsWith("/")) {
            return "path 必须以 \"/\" 开头（相对本机服务），收到：" + path;
        }
        if (path.startsWith("//")) {
            return "path 不能以 \"//\" 开头（会被当作协议相对地址）";
        }
        if (path.contains("://")) {
            return "path 不得含 \"://\"（禁止绝对 URL）";
        }
        if (path.contains("..")) {
            return "path 不得含 \"..\"（禁止路径穿越）";
        }
        if (path.contains("\r") || path.contains("\n")) {
            return "path 不得含 CR/LF（禁止请求行/头注入）";
        }
        if (path.indexOf('\\') >= 0) {
            return "path 不得含反斜杠";
        }
        return null;
    }

    /** 统一的失败返回（唯一的错误形状）：{@code {"ok":false,"error":"<short reason>"}}。 */
    private static String hostErrorJson(String reason) {
        String text = (reason == null || reason.isEmpty()) ? "unknown" : reason;
        return "{\"ok\":false,\"error\":" + JSONObject.quote(text) + "}";
    }

    /**
     * 真正发请求：base 固定取**配置端点**，不跟随跳转，10 秒连接/读取超时，
     * 响应体按 {@link #MAX_HOST_RESPONSE_BYTES} 封顶读全后按 UTF-8 解成文本。
     *
     * <p>2xx ⇒ 原样返回响应体（空体视为异常，如实报错而不是编一个 {@code {}} 出来）；
     * 非 2xx ⇒ 抛开响应体，回 {@code HTTP <code>} 加一小段错误流摘录（便于页面对日志）。
     */
    private String hostHttpRequest(String method, String path, String body) throws Exception {
        final String url = PotbotEndpoints.baseUrl(this) + path;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(HOST_HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HOST_HTTP_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false); // 不跟随跳转，避免被引到非本机地址
            conn.setRequestProperty("Accept", "application/json");
            if (body == null) {
                conn.connect();
            } else {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", HOST_JSON_CONTENT_TYPE);
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(payload.length);
                conn.connect();
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(payload);
                }
            }
            int code = conn.getResponseCode();
            if (code < 200 || code > 299) {
                return hostErrorJson("HTTP " + code + hostErrorExcerpt(conn));
            }
            String text = readHostBody(conn);
            if (text == null || text.isEmpty()) {
                return hostErrorJson("HTTP " + code + " 但响应体为空，无法作为 JSON 返回");
            }
            return text;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * 读全响应体（只用于 2xx 的 inputStream）。声明长度或实际读到的字节任一超过
     * {@link #MAX_HOST_RESPONSE_BYTES} 就抛错——**绝不截断**后当成完整响应返回。
     */
    private static String readHostBody(HttpURLConnection conn) throws IOException {
        long declared = conn.getContentLength();
        if (declared > MAX_HOST_RESPONSE_BYTES) {
            throw new IOException("响应声明长度 " + declared + " 字节超过 "
                    + MAX_HOST_RESPONSE_BYTES + " 字节上限");
        }
        try (InputStream in = conn.getInputStream();
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > MAX_HOST_RESPONSE_BYTES) {
                    throw new IOException("响应体超过 " + MAX_HOST_RESPONSE_BYTES + " 字节上限");
                }
                bos.write(buf, 0, n);
            }
            return bos.toString(StandardCharsets.UTF_8.name());
        }
    }

    /**
     * 非 2xx 时给一句可读的短原因：从错误流读至多 {@link #MAX_HOST_ERROR_READ_BYTES} 字节，
     * 压成单行、截到 {@link #MAX_HOST_ERROR_EXCERPT_CHARS} 字。读不到就返回空串
     * （宁可少说，不编）。异常一律吞掉——这里已经在失败路径上，不能再生一个失败。
     */
    private static String hostErrorExcerpt(HttpURLConnection conn) {
        InputStream in = null;
        try {
            in = conn.getErrorStream();
            if (in == null) {
                return "";
            }
            byte[] buf = new byte[MAX_HOST_ERROR_READ_BYTES];
            int total = 0;
            int n;
            while (total < buf.length && (n = in.read(buf, total, buf.length - total)) != -1) {
                total += n;
            }
            String text = new String(buf, 0, Math.max(total, 0), StandardCharsets.UTF_8)
                    .replace('\r', ' ').replace('\n', ' ').replace('\t', ' ').trim();
            if (text.isEmpty()) {
                return "";
            }
            if (text.length() > MAX_HOST_ERROR_EXCERPT_CHARS) {
                text = text.substring(0, MAX_HOST_ERROR_EXCERPT_CHARS) + "…";
            }
            return "：" + text;
        } catch (Throwable e) {
            return "";
        } finally {
            closeQuietly(in);
        }
    }

    private void startSave(final String downloadPath, final String filename,
                           final String sha256, final long byteLength, final boolean saveCopy) {
        // @JavascriptInterface 方法本来就在非 UI 线程执行；仍显式开线程，避免未来被改成主线程调用后卡 UI。
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    doSave(downloadPath, filename, sha256, byteLength, saveCopy);
                } catch (Throwable e) {
                    Log.e(TAG, "save failed", e);
                    reportStatus(false, ST_SAVE_REJECTED,
                            "保存失败：" + e.getClass().getSimpleName() + " " + safeMsg(e));
                }
            }
        }, "potbot-save");
        t.setDaemon(true);
        t.start();
    }

    private void doSave(String downloadPath, String filename, String sha256,
                        long byteLength, boolean saveCopy) throws Exception {
        // ---- 1. 同源校验：页面必须停在本机服务上 ----
        String page = lastLocalPageUrl;
        if (!isTrustedPageOrigin(page)) {
            reportStatus(false, ST_SAVE_REJECTED,
                    "同源校验失败：当前页面不是来自 " + configuredOrigin() + "，拒绝保存。");
            return;
        }

        // ---- 2. downloadPath 必须是本机服务上的相对路径，禁止绝对 URL / 反跳 ----
        if (downloadPath == null || downloadPath.isEmpty()) {
            reportStatus(false, ST_SAVE_REJECTED, "downloadPath 为空。");
            return;
        }
        if (!downloadPath.startsWith("/") || downloadPath.startsWith("//")) {
            reportStatus(false, ST_SAVE_REJECTED,
                    "downloadPath 必须以单个 \"/\" 开头（相对本机服务），收到：" + downloadPath);
            return;
        }
        if (downloadPath.contains("://") || downloadPath.contains("..")
                || downloadPath.contains("@") || downloadPath.contains("\\")) {
            reportStatus(false, ST_SAVE_REJECTED, "downloadPath 含非法片段，拒绝：" + downloadPath);
            return;
        }

        // ---- 3. 摘要与文件名基本校验 ----
        if (sha256 == null || !sha256.matches("(?i)[0-9a-f]{64}")) {
            reportStatus(false, ST_SAVE_REJECTED, "sha256 不是 64 位十六进制字符串。");
            return;
        }
        String safeName = sanitizeFilename(filename);
        if (safeName == null) {
            reportStatus(false, ST_SAVE_REJECTED, "filename 非法：" + filename);
            return;
        }

        // ---- 4. 从同源 artifact 接口取二进制（固定 base = **配置的**端点，不接受任意主机） ----
        final String url = PotbotEndpoints.baseUrl(this) + downloadPath;
        byte[] bytes;
        try {
            bytes = httpGet(url);
        } catch (Throwable e) {
            reportStatus(false, ST_ARTIFACT_FETCH_FAILED,
                    "取产物失败：" + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }

        // ---- 5. 校验长度与 SHA256，不一致即失败，绝不落盘冒充成功 ----
        if (byteLength >= 0 && bytes.length != byteLength) {
            reportStatus(false, ST_ARTIFACT_LENGTH_MISMATCH,
                    "长度校验失败：期望 " + byteLength + " 字节，实际 " + bytes.length + " 字节。");
            return;
        }
        String actual = sha256Hex(bytes);
        if (!actual.equalsIgnoreCase(sha256)) {
            reportStatus(false, ST_ARTIFACT_DIGEST_MISMATCH,
                    "SHA256 校验失败：期望 " + sha256.toLowerCase(Locale.ROOT)
                            + "，实际 " + actual + "。文件未保存。");
            return;
        }

        // ---- 6. 保存到应用专用目录 ----
        File dir = new File(getFilesDir(), ARTIFACT_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            reportStatus(false, ST_LOCAL_DIR_FAILED, "无法创建应用私有目录：" + dir.getAbsolutePath());
            return;
        }
        File out = new File(dir, safeName);

        // 6a. 写入并**显式关闭**；写入/刷新失败与关闭失败分别是不同状态。
        OutputStream os;
        try {
            os = new FileOutputStream(out);
        } catch (Throwable e) {
            reportStatus(false, ST_LOCAL_WRITE_FAILED,
                    "本地写入失败：无法打开输出流 " + safeMsg(e));
            return;
        }
        try {
            os.write(bytes);
            os.flush();
        } catch (Throwable e) {
            closeQuietly(os);
            reportStatus(false, ST_LOCAL_WRITE_FAILED,
                    "本地写入失败：" + e.getClass().getSimpleName() + " " + safeMsg(e) + "。文件未视为已保存。");
            return;
        }
        try {
            os.close();
        } catch (Throwable e) {
            reportStatus(false, ST_LOCAL_CLOSE_FAILED,
                    "本地保存失败：关闭输出流时出错（内容可能不完整）："
                            + e.getClass().getSimpleName() + " " + safeMsg(e) + "。未宣称保存成功。");
            return;
        }

        // 6b. **关闭之后**重新读回本地文件，核对长度与摘要；核对通过才可能宣称保存成功。
        byte[] localBack;
        try {
            localBack = readFileBytes(out);
        } catch (Throwable e) {
            reportStatus(false, ST_LOCAL_READBACK_FAILED,
                    "本地保存未验证：关闭后读回 " + safeName + " 失败："
                            + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }
        if (localBack == null) {
            reportStatus(false, ST_LOCAL_READBACK_FAILED,
                    "本地保存未验证：关闭后读回 " + safeName + " 得到空内容。");
            return;
        }
        if (localBack.length != bytes.length || !sha256Hex(localBack).equalsIgnoreCase(sha256)) {
            reportStatus(false, ST_LOCAL_READBACK_MISMATCH,
                    "本地保存未验证：关闭后读回与写入内容不符（读回 " + localBack.length
                            + " 字节 / sha256 " + sha256Hex(localBack) + "，期望 " + bytes.length
                            + " 字节 / sha256 " + sha256.toLowerCase(Locale.ROOT) + "）。");
            return;
        }

        if (saveCopy) {
            // 另存副本：交给用户选位置，写入与读回核对在 onActivityResult 完成。
            // 同时记下应用私有副本路径：Activity 重建/进程终止后据此恢复待保存内容。
            pendingBytes = bytes;
            pendingFileName = safeName;
            pendingSaveCopyInFlight = true;
            pendingSaveCopyArtifactPath = out.getAbsolutePath();
            final String title = safeName;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType(DOCX_MIME);
                        intent.putExtra(Intent.EXTRA_TITLE, title);
                        startActivityForResult(intent, REQ_CREATE_DOCUMENT);
                    } catch (Throwable e) {
                        clearPendingSaveCopy();
                        reportStatus(false, ST_SAVE_COPY_PICKER_FAILED,
                                "无法打开系统另存选择器：" + safeMsg(e));
                    }
                }
            });
            return;
        }

        // ---- 7. content:// + DOCX MIME + 临时读权限，交给系统选择器 / ACTION_VIEW ----
        final File savedFile = out;
        final String verifiedMessage = "已保存到应用私有目录并**读回核对通过**（关闭后重读长度与 SHA256 一致）："
                + safeName + "（" + localBack.length + " 字节，sha256 "
                + sha256.toLowerCase(Locale.ROOT) + "）";
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Uri uri = FileProvider.getUriForFile(
                            MainActivity.this,
                            getPackageName() + ".fileprovider",
                            savedFile);

                    Intent view = new Intent(Intent.ACTION_VIEW);
                    view.setDataAndType(uri, DOCX_MIME);
                    view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    // ClipData 一并带上，保证选择器把临时读权限传播到最终应用。
                    view.setClipData(android.content.ClipData.newRawUri(safeName, uri));

                    Intent chooser = Intent.createChooser(view, "用办公软件打开");
                    chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                    startActivity(chooser);
                    // 保存本身已读回核对通过；打开交接**只是发出**，打开结果未验证。
                    reportStatus(true, ST_SAVED_VERIFIED,
                            verifiedMessage + "；打开交接已发出（**打开结果未验证**，无回执）。");
                } catch (ActivityNotFoundException e) {
                    // 没有安装能打开 DOCX 的软件：文件已读回核对通过，但**打开**确实失败——分开报告。
                    reportStatus(true, ST_SAVED_VERIFIED_HANDOFF_FAILED,
                            verifiedMessage + "；但本机没有可打开 DOCX 的应用，交接未发出。"
                                    + "文件已存于应用私有目录，可改用「另存副本」后在其他软件打开。");
                } catch (Throwable e) {
                    reportStatus(true, ST_SAVED_VERIFIED_HANDOFF_FAILED,
                            verifiedMessage + "；但打开交接失败：" + safeMsg(e));
                }
            }
        });
    }

    // ------------------------------------------------------------- 下载

    private byte[] httpGet(String url) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false); // 不跟随跳转，避免被引到非本机地址
            conn.connect();
            int code = conn.getResponseCode();
            if (code != 200) {
                throw new IllegalStateException("artifact 接口返回 HTTP " + code + "（" + url + "）");
            }
            long declared = conn.getContentLength();
            if (declared > MAX_DOWNLOAD_BYTES) {
                throw new IllegalStateException("声明长度超出上限：" + declared);
            }
            try (InputStream in = conn.getInputStream();
                 ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16 * 1024];
                long total = 0;
                int n;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > MAX_DOWNLOAD_BYTES) {
                        throw new IllegalStateException("响应体超过 " + MAX_DOWNLOAD_BYTES + " 字节上限");
                    }
                    bos.write(buf, 0, n);
                }
                return bos.toByteArray();
            }
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    // ------------------------------------------------------------- 另存结果

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_CREATE_DOCUMENT) {
            handleCreateDocumentResult(resultCode, data);
            return;
        }
        if (requestCode == REQ_OPEN_DOCUMENT) {
            handleOpenDocumentResult(resultCode, data);
            return;
        }
        if (requestCode == REQ_CREATE_PDF) {
            handleCreatePdfResult(resultCode, data);
        }
    }

    private void handleCreateDocumentResult(int resultCode, Intent data) {
        final Uri target = (data == null) ? null : data.getData();

        // 待保存内容优先取内存；内存没有时（Activity 重建 / 进程终止后重建）尝试从
        // 应用私有副本恢复——恢复失败才是真的丢失。两者都如实报告。
        byte[] bytes = pendingBytes;
        String recoveryNote = "";
        if (bytes == null && pendingSaveCopyArtifactPath != null) {
            try {
                bytes = readFileBytes(new File(pendingSaveCopyArtifactPath));
                if (bytes != null) {
                    recoveryNote = "（待保存内容已从应用私有副本恢复）";
                }
            } catch (Throwable e) {
                Log.w(TAG, "另存状态恢复失败", e);
            }
        }
        final String name = pendingFileName;
        clearPendingSaveCopy();

        if (resultCode != RESULT_OK) {
            reportStatus(false, ST_SAVE_COPY_CANCELLED, "用户取消了另存副本。");
            return;
        }
        if (target == null) {
            reportStatus(false, ST_SAVE_COPY_URI_INVALID,
                    "另存未验证：系统返回了成功码，但没有给出目标 URI。");
            return;
        }
        if (bytes == null) {
            // 不再静默 return：这是 Activity 重建 / 进程终止后的真实丢失状态，必须报出来。
            reportStatus(false, ST_SAVE_COPY_STATE_LOST,
                    "另存未验证：系统返回了目标位置，但待保存内容已丢失（Activity 重建或进程被终止后无法从应用私有副本恢复）。请重新发起保存。");
            return;
        }

        final byte[] finalBytes = bytes;
        final String finalNote = recoveryNote;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    writeAndVerifyCopy(target, finalBytes, name == null ? "" : name, finalNote);
                } catch (Throwable e) {
                    Log.e(TAG, "save copy failed", e);
                    reportStatus(false, ST_SAVE_COPY_WRITE_FAILED,
                            "另存失败：" + e.getClass().getSimpleName() + " " + safeMsg(e));
                }
            }
        }, "potbot-savecopy");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 另存副本的**唯一**落盘 + 核对路径（design-05-P10 主判据）。
     *
     * 顺序固定：写入 → 刷新 → **显式关闭** → **关闭后重新打开目标 URI 读回** → 核对长度与
     * SHA256 → 只有全部通过才回报 {@link #ST_SAVED_VERIFIED}。任何一步失败都回报各自的
     * 独立状态，**绝不**在关闭前或读回前宣称成功（§2.1 缺口 2）。
     */
    private void writeAndVerifyCopy(Uri target, byte[] bytes, String name, String recoveryNote) {
        // ---- 1. 打开写入流（区分权限不足 / URI 失效 / 其它写入失败） ----
        OutputStream os;
        try {
            // 版本闸门（与 AndroidFileSystemPort.writeContentUri 同一写法）：带模式的
            // ContentResolver.openOutputStream(Uri, String) 是 **API 26(O)** 才引入的，本工程
            // minSdk = 24 —— API 24/25 上直接调会在运行期抛 NoSuchMethodError（编译期查不出来）。
            // API 26+ 传 "w"；API < 26 退回一参重载，平台语义即模式 "w"（write-only + 创建 +
            // 截断），两条路径保持"存在即截断覆盖"的同一契约，行为不变。
            os = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? getContentResolver().openOutputStream(target, "w")
                    : getContentResolver().openOutputStream(target);
        } catch (SecurityException e) {
            reportStatus(false, ST_SAVE_COPY_WRITE_PERMISSION_DENIED,
                    "另存失败：写入所选位置权限被拒（" + e.getClass().getSimpleName() + "）。文件未写入。");
            return;
        } catch (FileNotFoundException e) {
            reportStatus(false, ST_SAVE_COPY_URI_INVALID,
                    "另存失败：所选目标 URI 不可写（FileNotFoundException）。文件未写入。");
            return;
        } catch (Throwable e) {
            reportStatus(false, ST_SAVE_COPY_WRITE_FAILED,
                    "另存失败：无法打开输出流 " + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }
        if (os == null) {
            reportStatus(false, ST_SAVE_COPY_URI_INVALID,
                    "另存失败：系统没有给出可写流（目标 URI 可能已失效）。");
            return;
        }

        // ---- 2. 写入 + 刷新 ----
        try {
            os.write(bytes);
            os.flush();
        } catch (SecurityException e) {
            closeQuietly(os);
            reportStatus(false, ST_SAVE_COPY_WRITE_PERMISSION_DENIED,
                    "另存失败：写入过程中权限被拒（" + e.getClass().getSimpleName() + "）。");
            return;
        } catch (Throwable e) {
            closeQuietly(os);
            reportStatus(false, ST_SAVE_COPY_WRITE_FAILED,
                    "另存失败：写入/刷新出错 " + e.getClass().getSimpleName() + " " + safeMsg(e)
                            + "。未宣称保存成功。");
            return;
        }

        // ---- 3. **显式关闭**：关闭失败是独立状态，内容可能不完整 ----
        try {
            os.close();
        } catch (Throwable e) {
            reportStatus(false, ST_SAVE_COPY_CLOSE_FAILED,
                    "另存未验证：关闭目标输出流时出错（内容可能不完整）："
                            + e.getClass().getSimpleName() + " " + safeMsg(e) + "。未宣称保存成功。");
            return;
        }

        // ---- 4. **关闭之后**重新打开目标 URI 读回（权限不足 / URI 失效 / 读失败分别报告） ----
        byte[] readBack;
        try {
            readBack = readAllContent(target, MAX_IO_BYTES);
        } catch (SecurityException e) {
            reportStatus(false, ST_SAVE_COPY_READBACK_PERMISSION_DENIED,
                    "另存未验证：写入已关闭，但重新打开目标 URI 读取时权限不足（"
                            + e.getClass().getSimpleName() + "）。不宣称保存成功。");
            return;
        } catch (UriInvalidException e) {
            reportStatus(false, ST_SAVE_COPY_READBACK_URI_INVALID,
                    "另存未验证：写入已关闭，但目标 URI 已失效/不可读（" + safeMsg(e) + "）。");
            return;
        } catch (Throwable e) {
            reportStatus(false, ST_SAVE_COPY_READBACK_FAILED,
                    "另存未验证：写入已关闭，但读回目标 URI 失败 " + e.getClass().getSimpleName()
                            + " " + safeMsg(e) + "。");
            return;
        }
        if (readBack == null) {
            reportStatus(false, ST_SAVE_COPY_READBACK_URI_INVALID,
                    "另存未验证：写入已关闭，但目标 URI 读取返回空流。");
            return;
        }

        // ---- 5. 长度与摘要核对；不符即非 verified ----
        if (readBack.length != bytes.length) {
            reportStatus(false, ST_SAVE_COPY_READBACK_MISMATCH,
                    "另存未验证：关闭后读回长度 " + readBack.length + " 字节，与写入内容 "
                            + bytes.length + " 字节不符。");
            return;
        }
        final String writtenSha;
        final String readBackSha;
        try {
            writtenSha = sha256Hex(bytes);
            readBackSha = sha256Hex(readBack);
        } catch (Throwable e) {
            reportStatus(false, ST_SAVE_COPY_READBACK_FAILED,
                    "另存未验证：读回内容无法计算 SHA256：" + safeMsg(e));
            return;
        }
        if (!readBackSha.equalsIgnoreCase(writtenSha)) {
            reportStatus(false, ST_SAVE_COPY_READBACK_MISMATCH,
                    "另存未验证：关闭后读回 SHA256 " + readBackSha + " 与写入内容 " + writtenSha + " 不符。");
            return;
        }

        // ---- 6. 全部通过：登记授权，允许日后导回；此时才允许宣称保存成功 ----
        registerGrantedUri(target);
        reportStatus(true, ST_SAVED_VERIFIED,
                "副本已另存并**关闭后读回核对通过**" + recoveryNote + "：" + name
                        + "（" + readBack.length + " 字节，sha256 " + readBackSha.toLowerCase(Locale.ROOT) + "）");
    }

    // ------------------------------------------------------------- 导入

    private void startImportPicker() {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                if (!isTrustedPageOrigin(lastLocalPageUrl)) {
                    reportStatus(false, ST_SAVE_REJECTED,
                            "同源校验失败：当前页面不是来自 " + configuredOrigin() + "，拒绝导入。");
                    return;
                }
                pendingImportInFlight = true;
                pendingImportOrigin = "picker";
                pendingImportUri = null;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                            intent.addCategory(Intent.CATEGORY_OPENABLE);
                            intent.setType(DOCX_MIME);
                            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                            startActivityForResult(intent, REQ_OPEN_DOCUMENT);
                        } catch (Throwable e) {
                            clearPendingImport();
                            reportStatus(false, ST_IMPORT_PICKER_FAILED,
                                    "无法打开系统文件选择器：" + safeMsg(e));
                        }
                    }
                });
            }
        }, "potbot-import-picker");
        t.setDaemon(true);
        t.start();
    }

    private void startReimport(final String uriString) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                if (!isTrustedPageOrigin(lastLocalPageUrl)) {
                    reportStatus(false, ST_SAVE_REJECTED,
                            "同源校验失败：当前页面不是来自 " + configuredOrigin() + "，拒绝导入。");
                    return;
                }
                Uri uri;
                try {
                    uri = Uri.parse(uriString);
                } catch (Throwable e) {
                    reportStatus(false, ST_IMPORT_URI_INVALID, "导回失败：URI 无法解析。");
                    return;
                }
                // 只允许读本应用真正取得过授权的 content:// 文档；不做任意内容读取。
                if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) {
                    reportStatus(false, ST_IMPORT_URI_INVALID,
                            "导回失败：只接受 content:// 文档 URI，收到：" + uriString);
                    return;
                }
                if (!isGrantedUri(uri)) {
                    reportStatus(false, ST_IMPORT_URI_NOT_GRANTED,
                            "导回失败：该 content:// 文档不是本应用取得过授权的文档，拒绝读取。");
                    return;
                }
                readAndVerifyImport(uri, "reimport");
            }
        }, "potbot-import-reimport");
        t.setDaemon(true);
        t.start();
    }

    private void handleOpenDocumentResult(int resultCode, Intent data) {
        final Uri uri = (data == null) ? null : data.getData();
        final String origin = pendingImportOrigin == null ? "picker" : pendingImportOrigin;
        final boolean wasInFlight = pendingImportInFlight;
        clearPendingImport();

        if (resultCode != RESULT_OK) {
            reportStatus(false, ST_IMPORT_CANCELLED, "用户取消了导入。");
            return;
        }
        if (uri == null) {
            reportStatus(false, ST_IMPORT_URI_INVALID, "导入失败：系统未返回文件 URI。");
            return;
        }
        if (!wasInFlight) {
            // Activity 重建后 Bundle 未带回来途信息：仍按 picker 语义继续，但如实记录。
            Log.w(TAG, "导入请求未标记在途（可能 Activity 重建），按 picker 语义继续");
        }
        if (!"content".equalsIgnoreCase(uri.getScheme())) {
            reportStatus(false, ST_IMPORT_URI_INVALID,
                    "导入失败：只接受 content:// 文档 URI，收到 scheme=" + uri.getScheme());
            return;
        }
        // 尝试持久化读权限（失败不致命，但读回时可能因此权限不足并如实报告）。
        try {
            getContentResolver().takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Throwable e) {
            Log.w(TAG, "未能持久化读权限（不致命）", e);
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                readAndVerifyImport(uri, origin);
            }
        }, "potbot-import-read");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 导入的**唯一**读入 + 字节核对路径（design-05-P8 / WF-082 / WF-084）。
     *
     * 关键纪律：**打开回执 ≠ 保存成功，也不等于读到了正确字节**。只有在
     * 实际读入字节、并与系统声明 SIZE 及**第二次独立读入**的摘要交叉核对通过后，
     * 才回报 {@link #ST_IMPORT_OK}。
     */
    private void readAndVerifyImport(Uri uri, String origin) {
        // ---- 1. 查询系统声明的显示名与 SIZE（仅作交叉核对，不作为成功依据） ----
        String displayName = null;
        long declaredSize = -1L;
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIdx >= 0) {
                    displayName = cursor.getString(nameIdx);
                }
                if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                    declaredSize = cursor.getLong(sizeIdx);
                }
            }
        } catch (Throwable e) {
            Log.w(TAG, "无法查询文档元数据（不致命，但无 SIZE 交叉核对）", e);
        } finally {
            closeQuietly(cursor);
        }

        // ---- 2. 第一次读入（权限不足 / URI 失效 / 超限 / 空文件分别报告） ----
        final byte[] first;
        try {
            first = readAllContent(uri, MAX_IO_BYTES);
        } catch (SecurityException e) {
            reportStatus(false, ST_IMPORT_PERMISSION_DENIED,
                    "导入失败：读取所选文档权限不足（" + e.getClass().getSimpleName() + "）。");
            return;
        } catch (UriInvalidException e) {
            reportStatus(false, ST_IMPORT_URI_INVALID,
                    "导入失败：所选文档 URI 已失效/不可读（" + safeMsg(e) + "）。");
            return;
        } catch (TooLargeException e) {
            reportStatus(false, ST_IMPORT_TOO_LARGE,
                    "导入失败：文档超过 " + MAX_IO_BYTES + " 字节上限，未读入。");
            return;
        } catch (Throwable e) {
            reportStatus(false, ST_IMPORT_READ_FAILED,
                    "导入失败：读入文档出错 " + e.getClass().getSimpleName() + " " + safeMsg(e) + "。");
            return;
        }
        if (first == null || first.length == 0) {
            reportStatus(false, ST_IMPORT_EMPTY, "导入失败：文档内容为空。");
            return;
        }

        // ---- 3. 与系统声明的 SIZE 交叉核对 ----
        if (declaredSize >= 0 && declaredSize != first.length) {
            reportStatus(false, ST_IMPORT_DECLARED_SIZE_MISMATCH,
                    "导入未验证：读入 " + first.length + " 字节，与系统声明 SIZE " + declaredSize
                            + " 字节不符，拒绝导入。");
            return;
        }

        // ---- 4. 第二次独立读入，核对两次字节摘要一致（真正的字节核对） ----
        final byte[] second;
        try {
            second = readAllContent(uri, MAX_IO_BYTES);
        } catch (SecurityException e) {
            reportStatus(false, ST_IMPORT_PERMISSION_DENIED,
                    "导入未验证：第二次读入时权限不足（" + e.getClass().getSimpleName() + "）。");
            return;
        } catch (UriInvalidException e) {
            reportStatus(false, ST_IMPORT_URI_INVALID,
                    "导入未验证：第二次读入时 URI 已失效（" + safeMsg(e) + "）。");
            return;
        } catch (TooLargeException e) {
            reportStatus(false, ST_IMPORT_TOO_LARGE,
                    "导入未验证：第二次读入超过 " + MAX_IO_BYTES + " 字节上限。");
            return;
        } catch (Throwable e) {
            reportStatus(false, ST_IMPORT_READ_FAILED,
                    "导入未验证：第二次读入出错 " + e.getClass().getSimpleName() + " " + safeMsg(e) + "。");
            return;
        }
        final String firstSha;
        final String secondSha;
        try {
            firstSha = sha256Hex(first);
            secondSha = sha256Hex(second);
        } catch (Throwable e) {
            reportStatus(false, ST_IMPORT_READ_FAILED, "导入未验证：无法计算文档 SHA256：" + safeMsg(e));
            return;
        }
        if (!firstSha.equalsIgnoreCase(secondSha) || second.length != first.length) {
            reportStatus(false, ST_IMPORT_READBACK_MISMATCH,
                    "导入未验证：两次读入的字节不一致（第一次 " + first.length + " 字节 / " + firstSha
                            + "，第二次 " + second.length + " 字节 / " + secondSha + "）。");
            return;
        }

        // ---- 5. ZIP/OOXML 形态检查：不把别的文件当 DOCX 导入 ----
        if (!isZipMagic(first)) {
            reportStatus(false, ST_IMPORT_NOT_ZIP,
                    "导入失败：所选文件不是 ZIP/OOXML 形态（缺少 PK 头），拒绝按 DOCX 导入。");
            return;
        }

        // ---- 6. 暂存到应用私有目录，并对暂存结果再做一次读回核对 ----
        File stageDir = new File(getFilesDir(), IMPORT_DIR);
        if (!stageDir.exists() && !stageDir.mkdirs()) {
            reportStatus(false, ST_IMPORT_STAGE_FAILED,
                    "导入未验证：无法创建导入暂存目录 " + stageDir.getAbsolutePath());
            return;
        }
        File staged = new File(stageDir, firstSha.toLowerCase(Locale.ROOT) + ".docx");
        OutputStream os;
        try {
            os = new FileOutputStream(staged);
        } catch (Throwable e) {
            reportStatus(false, ST_IMPORT_STAGE_FAILED,
                    "导入未验证：无法打开暂存文件 " + safeMsg(e));
            return;
        }
        try {
            os.write(first);
            os.flush();
        } catch (Throwable e) {
            closeQuietly(os);
            reportStatus(false, ST_IMPORT_STAGE_FAILED,
                    "导入未验证：暂存写入失败 " + safeMsg(e));
            return;
        }
        try {
            os.close();
        } catch (Throwable e) {
            reportStatus(false, ST_IMPORT_STAGE_FAILED,
                    "导入未验证：暂存关闭失败（内容可能不完整）" + safeMsg(e));
            return;
        }
        try {
            byte[] stagedBack = readFileBytes(staged);
            if (stagedBack == null || stagedBack.length != first.length
                    || !sha256Hex(stagedBack).equalsIgnoreCase(firstSha)) {
                reportStatus(false, ST_IMPORT_STAGE_FAILED,
                        "导入未验证：暂存文件读回与读入内容不符。");
                return;
            }
        } catch (Throwable e) {
            reportStatus(false, ST_IMPORT_STAGE_FAILED,
                    "导入未验证：暂存文件读回失败 " + safeMsg(e));
            return;
        }

        // ---- 7. 通过：登记授权（允许日后导回），回报字节核对结果 ----
        registerGrantedUri(uri);
        String shownName = (displayName == null || displayName.isEmpty()) ? staged.getName() : displayName;
        reportStatus(true, ST_IMPORT_OK,
                "导入完成并**字节核对通过**（两次读入长度与 SHA256 一致）：" + shownName
                        + "（" + first.length + " 字节，sha256 " + firstSha.toLowerCase(Locale.ROOT)
                        + "，已暂存 " + staged.getAbsolutePath() + "）");
    }

    // ------------------------------------------------------------- PDF 导出（WF-089）

    private void startExportPdf(final String docJson) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    doExportPdf(docJson);
                } catch (Throwable e) {
                    Log.e(TAG, "pdf export failed", e);
                    reportStatus(false, ST_PDF_WRITE_FAILED,
                            "PDF 导出失败：" + e.getClass().getSimpleName() + " " + safeMsg(e));
                }
            }
        }, "potbot-pdf-export");
        t.setDaemon(true);
        t.start();
    }

    /**
     * PDF 导出的**唯一**路径（design-05-P8 / WF-089 手机侧）。
     *
     * 顺序固定（与 WCF-D09 的保存链**同一条纪律**，不放松）：
     * 同源校验 → 参数解析 → 空间预检 → **真实排版引擎**写入 → 刷新 → **显式关闭**
     * → **关闭之后独立读回核对**（非空 / `%PDF-` 魔数 / 系统解析器页数 / 首页有墨迹 / 摘要）
     * → 只有全部通过才允许 `reportStatus(true, ST_PDF_EXPORTED_VERIFIED, ...)`。
     *
     * 引擎段（无引擎 / 超时 / 版面失败 / 空间不足）与读回段（读回失败 / 不是 PDF /
     * 页数不符 / 空白页 / 空文件 / 摘要不符）是**互不相同**的状态，不合并、不冒充。
     */
    private void doExportPdf(String docJson) {
        // ---- 1. 同源校验：页面必须停在本机服务上 ----
        if (!isTrustedPageOrigin(lastLocalPageUrl)) {
            reportStatus(false, ST_PDF_REJECTED,
                    "同源校验失败：当前页面不是来自 " + configuredOrigin() + "，拒绝导出 PDF。");
            return;
        }

        // ---- 2. 参数解析（参数问题与引擎/读回故障分开报告） ----
        final PotbotPdfLayout.Request request;
        try {
            request = PotbotPdfLayout.parseRequest(docJson);
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_REJECTED,
                    "PDF 导出被拒：" + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }
        final String safeName = sanitizePdfFilename(request.filename);
        if (safeName == null) {
            reportStatus(false, ST_PDF_REJECTED, "filename 非法：" + request.filename);
            return;
        }

        // ---- 3. 输出目录 + 空间预检（空间不足是**独立**状态） ----
        File dir = new File(new File(getFilesDir(), ARTIFACT_DIR), EXPORT_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            reportStatus(false, ST_PDF_WRITE_FAILED,
                    "无法创建 PDF 导出目录：" + dir.getAbsolutePath());
            return;
        }
        long usable = dir.getUsableSpace();
        if (usable > 0 && usable < MIN_PDF_FREE_BYTES) {
            reportStatus(false, ST_PDF_NO_SPACE,
                    "PDF 导出已中止：可用空间 " + usable + " 字节，低于下限 "
                            + MIN_PDF_FREE_BYTES + " 字节，未写入。");
            return;
        }
        File out = new File(dir, safeName);

        // ---- 4. 真实排版引擎写入（引擎段失败各自分类） ----
        final PotbotPdfLayout.Result layout;
        OutputStream os;
        try {
            os = new FileOutputStream(out);
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_WRITE_FAILED, "PDF 写入失败：无法打开输出流 " + safeMsg(e));
            return;
        }
        try {
            layout = PotbotPdfLayout.render(request, os);
        } catch (PotbotPdfLayout.NoEngineException e) {
            closeQuietly(os);
            reportStatus(false, ST_PDF_NO_ENGINE, "未导出：本设备没有可用的排版引擎：" + safeMsg(e));
            return;
        } catch (PotbotPdfLayout.TimeoutException e) {
            closeQuietly(os);
            reportStatus(false, ST_PDF_TIMEOUT, "未导出：PDF 排版超时：" + safeMsg(e));
            return;
        } catch (PotbotPdfLayout.LayoutException e) {
            closeQuietly(os);
            reportStatus(false, ST_PDF_LAYOUT_FAILED, "未导出：版面计算失败：" + safeMsg(e));
            return;
        } catch (Throwable e) {
            closeQuietly(os);
            if (isNoSpace(e)) {
                reportStatus(false, ST_PDF_NO_SPACE, "未导出：写入过程中空间不足：" + safeMsg(e));
                return;
            }
            reportStatus(false, ST_PDF_WRITE_FAILED,
                    "未导出：写入 PDF 失败 " + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }

        // ---- 5. 刷新 + **显式关闭**（关闭失败是独立状态，绝不在关闭前宣称成功） ----
        try {
            os.flush();
        } catch (Throwable e) {
            closeQuietly(os);
            reportStatus(false, ST_PDF_WRITE_FAILED, "未导出：刷新输出流失败 " + safeMsg(e));
            return;
        }
        try {
            os.close();
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_CLOSE_FAILED,
                    "PDF 导出未验证：关闭输出流时出错（内容可能不完整）："
                            + e.getClass().getSimpleName() + " " + safeMsg(e) + "。未宣称导出成功。");
            return;
        }

        // ---- 6. **关闭之后**独立读回核对：存在 / 非空 / 魔数 / 解析器页数 / 首页墨迹 ----
        PotbotPdfReadback.Outcome readback = PotbotPdfReadback.inspect(out, layout.pageCount, null);
        if (!readback.isOk()) {
            reportStatus(false, pdfReadbackStatus(readback.failure.kind),
                    "PDF 导出未验证：" + readback.failure.message
                            + " [readback_kind=" + readback.failure.kind + "]");
            return;
        }

        // ---- 7. 全部通过：登记为"已核对"，允许后续另存 / 打印交接；此时才允许宣称成功 ----
        registerVerifiedPdf(out, readback.result.sha256, readback.result.parsedPageCount, safeName);
        reportStatus(true, ST_PDF_EXPORTED_VERIFIED,
                "PDF 已导出并**独立读回核对通过**（非空 / %PDF- 魔数 / 系统解析器读出 "
                        + readback.result.parsedPageCount + " 页 / 首页有墨迹 / sha256 "
                        + readback.result.sha256.toLowerCase(Locale.ROOT) + "）：" + safeName
                        + "（" + readback.result.byteLength + " 字节，引擎 = " + layout.engine
                        + "，段数 " + layout.paragraphCount + "，排版 " + layout.layoutMs
                        + " ms，读回核对 " + readback.result.elapsedMs + " ms）");
    }

    /** 读回失败分类 → **互不相同**的状态（不合并成一种笼统的"读回失败"）。 */
    private static String pdfReadbackStatus(String kind) {
        if ("empty".equals(kind)) {
            return ST_PDF_EMPTY;
        }
        if ("magic_mismatch".equals(kind)) {
            return ST_PDF_NOT_PDF;
        }
        if ("page_count_mismatch".equals(kind)) {
            return ST_PDF_PAGE_MISMATCH;
        }
        if ("blank".equals(kind)) {
            return ST_PDF_BLANK;
        }
        if ("digest_failed".equals(kind)) {
            return ST_PDF_COPY_READBACK_DIGEST_MISMATCH;
        }
        return ST_PDF_READBACK_FAILED;
    }

    /** 只有通过读回核对的产物才会被登记；未经登记一律不允许另存 / 打印交接。 */
    private void registerVerifiedPdf(File file, String sha256, int pages, String name) {
        verifiedPdfPath = file == null ? null : file.getAbsolutePath();
        verifiedPdfSha256 = sha256;
        verifiedPdfPages = pages;
        verifiedPdfName = name;
    }

    // ------------------------------------------------------------- PDF 副本（WF-089）

    private void startSavePdfCopy() {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                if (!isTrustedPageOrigin(lastLocalPageUrl)) {
                    reportStatus(false, ST_PDF_REJECTED,
                            "同源校验失败：当前页面不是来自 " + configuredOrigin() + "，拒绝另存 PDF。");
                    return;
                }
                final String src = verifiedPdfPath;
                if (src == null) {
                    reportStatus(false, ST_PDF_NOT_VERIFIED,
                            "另存 PDF 被拒：本会话还没有通过读回核对的 PDF，请先「导出 PDF」。");
                    return;
                }
                pendingPdfCopyInFlight = true;
                pendingPdfCopySourcePath = src;
                final String title = verifiedPdfName == null ? "potbot.pdf" : verifiedPdfName;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                            intent.addCategory(Intent.CATEGORY_OPENABLE);
                            intent.setType(PDF_MIME);
                            intent.putExtra(Intent.EXTRA_TITLE, title);
                            startActivityForResult(intent, REQ_CREATE_PDF);
                        } catch (Throwable e) {
                            clearPendingPdfCopy();
                            reportStatus(false, ST_PDF_WRITE_FAILED,
                                    "无法打开系统另存选择器：" + safeMsg(e));
                        }
                    }
                });
            }
        }, "potbot-pdf-copy");
        t.setDaemon(true);
        t.start();
    }

    private void handleCreatePdfResult(int resultCode, Intent data) {
        final Uri target = (data == null) ? null : data.getData();
        final String src = pendingPdfCopySourcePath;
        clearPendingPdfCopy();

        if (resultCode != RESULT_OK) {
            reportStatus(false, ST_PDF_COPY_CANCELLED, "用户取消了另存 PDF 副本。");
            return;
        }
        if (target == null) {
            reportStatus(false, ST_PDF_TARGET_URI_INVALID,
                    "另存 PDF 未验证：系统返回了成功码，但没有给出目标 URI。");
            return;
        }
        if (src == null) {
            reportStatus(false, ST_PDF_STATE_LOST,
                    "另存 PDF 未验证：系统返回了目标位置，但待另存内容已丢失"
                            + "（Activity 重建或进程被终止后无法恢复）。请重新导出。");
            return;
        }
        final String name = verifiedPdfName == null ? "potbot.pdf" : verifiedPdfName;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    writeAndVerifyPdfCopy(target, new File(src), name);
                } catch (Throwable e) {
                    Log.e(TAG, "pdf copy failed", e);
                    reportStatus(false, ST_PDF_WRITE_FAILED,
                            "另存 PDF 失败：" + e.getClass().getSimpleName() + " " + safeMsg(e));
                }
            }
        }, "potbot-pdf-copy-write");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 另存 PDF 副本的**唯一**落盘 + 核对路径——与 {@link #writeAndVerifyCopy}（WCF-D09）
     * **同一条纪律**：写入 → 刷新 → **显式关闭** → **关闭后重新打开目标 URI 读回**
     * → 核对长度 + SHA256 + `%PDF-` 魔数 → 只有全部通过才回报 verified。
     */
    private void writeAndVerifyPdfCopy(Uri target, File source, String name) {
        byte[] bytes;
        try {
            bytes = readFileBytes(source);
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_READBACK_FAILED,
                    "另存 PDF 未验证：无法读取已核对的源 PDF " + safeMsg(e));
            return;
        }
        if (bytes == null || bytes.length == 0) {
            reportStatus(false, ST_PDF_STATE_LOST, "另存 PDF 未验证：源 PDF 已不可读或为空。");
            return;
        }

        // ---- 1. 打开写入流（权限不足 / URI 失效 / 其它分别报告） ----
        OutputStream os;
        try {
            // 版本闸门（与 AndroidFileSystemPort.writeContentUri 同一写法）：带模式的重载是
            // API 26(O) 才引入的，minSdk = 24 ⇒ API 24/25 直接调会在运行期抛 NoSuchMethodError。
            // API 26+ 传 "w"；API < 26 退回一参重载（平台语义即模式 "w"），契约不变。
            os = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? getContentResolver().openOutputStream(target, "w")
                    : getContentResolver().openOutputStream(target);
        } catch (SecurityException e) {
            reportStatus(false, ST_PDF_PERMISSION_DENIED,
                    "另存 PDF 失败：写入所选位置权限被拒（" + e.getClass().getSimpleName() + "）。未写入。");
            return;
        } catch (FileNotFoundException e) {
            reportStatus(false, ST_PDF_TARGET_URI_INVALID,
                    "另存 PDF 失败：所选目标 URI 不可写（FileNotFoundException）。未写入。");
            return;
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_WRITE_FAILED,
                    "另存 PDF 失败：无法打开输出流 " + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }
        if (os == null) {
            reportStatus(false, ST_PDF_TARGET_URI_INVALID,
                    "另存 PDF 失败：系统没有给出可写流（目标 URI 可能已失效）。");
            return;
        }

        // ---- 2. 写入 + 刷新 ----
        try {
            os.write(bytes);
            os.flush();
        } catch (SecurityException e) {
            closeQuietly(os);
            reportStatus(false, ST_PDF_PERMISSION_DENIED,
                    "另存 PDF 失败：写入过程中权限被拒（" + e.getClass().getSimpleName() + "）。");
            return;
        } catch (Throwable e) {
            closeQuietly(os);
            if (isNoSpace(e)) {
                reportStatus(false, ST_PDF_NO_SPACE, "另存 PDF 失败：写入过程中空间不足 " + safeMsg(e));
                return;
            }
            reportStatus(false, ST_PDF_WRITE_FAILED,
                    "另存 PDF 失败：写入/刷新出错 " + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }

        // ---- 3. **显式关闭**：关闭失败是独立状态，内容可能不完整 ----
        try {
            os.close();
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_CLOSE_FAILED,
                    "另存 PDF 未验证：关闭目标输出流时出错（内容可能不完整）："
                            + e.getClass().getSimpleName() + " " + safeMsg(e) + "。未宣称保存成功。");
            return;
        }

        // ---- 4. **关闭之后**重新打开目标 URI 读回 ----
        byte[] readBack;
        try {
            readBack = readAllContent(target, MAX_IO_BYTES);
        } catch (SecurityException e) {
            reportStatus(false, ST_PDF_COPY_READBACK_PERMISSION_DENIED,
                    "另存 PDF 未验证：写入已关闭，但重新打开目标 URI 读取时权限不足（"
                            + e.getClass().getSimpleName() + "）。不宣称保存成功。");
            return;
        } catch (UriInvalidException e) {
            reportStatus(false, ST_PDF_TARGET_URI_INVALID,
                    "另存 PDF 未验证：写入已关闭，但目标 URI 已失效/不可读（" + safeMsg(e) + "）。");
            return;
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_READBACK_FAILED,
                    "另存 PDF 未验证：写入已关闭，但读回目标 URI 失败 "
                            + e.getClass().getSimpleName() + " " + safeMsg(e));
            return;
        }
        if (readBack == null || readBack.length == 0) {
            reportStatus(false, ST_PDF_EMPTY, "另存 PDF 未验证：读回目标 URI 得到空内容。");
            return;
        }

        // ---- 5. 形态 + 长度 + 摘要核对；不符即非 verified ----
        if (!isPdfMagic(readBack)) {
            reportStatus(false, ST_PDF_NOT_PDF,
                    "另存 PDF 未验证：读回内容不是 PDF（文件头前 5 字节 = "
                            + asciiPrefix(readBack, 5) + "，要求 %PDF-）。");
            return;
        }
        if (readBack.length != bytes.length) {
            reportStatus(false, ST_PDF_COPY_READBACK_MISMATCH,
                    "另存 PDF 未验证：关闭后读回长度 " + readBack.length + " 字节，与写入内容 "
                            + bytes.length + " 字节不符。");
            return;
        }
        final String writtenSha;
        final String readBackSha;
        try {
            writtenSha = sha256Hex(bytes);
            readBackSha = sha256Hex(readBack);
        } catch (Throwable e) {
            reportStatus(false, ST_PDF_READBACK_FAILED,
                    "另存 PDF 未验证：读回内容无法计算 SHA256：" + safeMsg(e));
            return;
        }
        if (!readBackSha.equalsIgnoreCase(writtenSha)) {
            reportStatus(false, ST_PDF_COPY_READBACK_DIGEST_MISMATCH,
                    "另存 PDF 未验证：关闭后读回 SHA256 " + readBackSha + " 与写入内容 "
                            + writtenSha + " 不符。");
            return;
        }

        // ---- 6. 全部通过：登记授权（允许导回），此时才允许宣称保存成功 ----
        registerGrantedUri(target);
        reportStatus(true, ST_PDF_COPY_VERIFIED,
                "PDF 副本已另存并**关闭后读回核对通过**（%PDF- 魔数 / 长度 / sha256 一致）："
                        + name + "（" + readBack.length + " 字节，sha256 "
                        + readBackSha.toLowerCase(Locale.ROOT) + "）");
    }

    // ------------------------------------------------------------- 打印交接（WF-090）

    private void startPrintHandoff() {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    doPrintHandoff();
                } catch (Throwable e) {
                    Log.e(TAG, "print handoff failed", e);
                    reportStatus(false, ST_PRINT_UNAVAILABLE,
                            "打印未交接：" + e.getClass().getSimpleName() + " " + safeMsg(e));
                }
            }
        }, "potbot-print-handoff");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 打印交接（design-05-P8 / WF-090 手机侧）。
     *
     * **只交接，不代打印**：只接受**已经过独立读回核对**的 PDF（路径 + 当时的 sha256），
     * 交接前**重新计算盘上字节的摘要**比对；结论**最多**到 `print_handed_off`。
     * 本方法**没有**任何能宣称"已打印"的分支——{@link PotbotPrintHandoff#PRINTED}
     * 恒为 `false`，而 `submitted` / `confirmed_complete` 两态在本批不可表达
     * （没有可信回执）。真机打印**未验证**。
     */
    private void doPrintHandoff() {
        if (!isTrustedPageOrigin(lastLocalPageUrl)) {
            reportStatus(false, ST_PDF_REJECTED,
                    "同源校验失败：当前页面不是来自 " + configuredOrigin() + "，拒绝打印交接。");
            return;
        }
        final String src = verifiedPdfPath;
        final String sha = verifiedPdfSha256;
        final int pages = verifiedPdfPages;
        if (src == null || sha == null) {
            // 只有在**这个会话里**通过读回核对的产物才允许交接；否则停在 prepared。
            reportStatus(false, ST_PRINT_NOT_VERIFIED,
                    "打印未交接（prepared）：本会话还没有通过读回核对的 PDF——只有\"准备交接\"的意图。"
                            + "请先「导出 PDF」并等它回报 pdf_exported_verified。");
            return;
        }
        final String jobName = verifiedPdfName == null ? "potbot.pdf" : verifiedPdfName;
        PotbotPrintHandoff.Outcome outcome = PotbotPrintHandoff.handOff(
                this, jobName, new File(src), sha, pages);
        if (outcome.isHandedOff()) {
            reportStatus(true, ST_PRINT_HANDED_OFF,
                    outcome.claim + " [state=handed_off, printed=" + outcome.printed
                            + "] " + outcome.detail);
            return;
        }
        reportStatus(false, printFailureStatus(outcome.failureKind),
                "打印未交接（" + outcome.state.name().toLowerCase(Locale.ROOT) + " / "
                        + outcome.failureKind + "）：" + outcome.detail
                        + " [state=" + outcome.state.name().toLowerCase(Locale.ROOT)
                        + ", printed=" + outcome.printed + "]");
    }

    /** 交接失败分类 → **互不相同**的状态。 */
    private static String printFailureStatus(String kind) {
        if (PotbotPrintHandoff.FAILURE_TARGET_MISSING.equals(kind)) {
            return ST_PRINT_TARGET_MISSING;
        }
        if (PotbotPrintHandoff.FAILURE_TARGET_DIGEST_MISMATCH.equals(kind)) {
            return ST_PRINT_DIGEST_MISMATCH;
        }
        if (PotbotPrintHandoff.FAILURE_PERMISSION_DENIED.equals(kind)) {
            return ST_PRINT_PERMISSION_DENIED;
        }
        if (PotbotPrintHandoff.FAILURE_OPEN_FAILED.equals(kind)) {
            return ST_PRINT_OPEN_FAILED;
        }
        return ST_PRINT_UNAVAILABLE;
    }

    // ------------------------------------------------------------- 读入 / 工具

    /** 目标 URI 已失效（区别于权限不足与一般 IO 错误）。 */
    private static final class UriInvalidException extends Exception {
        private static final long serialVersionUID = 1L;

        UriInvalidException(String message) {
            super(message);
        }
    }

    /** 读入内容超过上限（区别于一般 IO 错误）。 */
    private static final class TooLargeException extends Exception {
        private static final long serialVersionUID = 1L;

        TooLargeException(String message) {
            super(message);
        }
    }

    /**
     * 从 content:// URI 一次性读入全部字节。
     * 抛出形态有意区分：{@link SecurityException}（权限不足）、{@link UriInvalidException}
     * （URI 失效）、{@link TooLargeException}（超限）、其它 {@link IOException}（一般读失败）。
     */
    private byte[] readAllContent(Uri uri, long max) throws IOException, UriInvalidException, TooLargeException {
        InputStream in;
        try {
            in = getContentResolver().openInputStream(uri);
        } catch (SecurityException e) {
            throw e;
        } catch (FileNotFoundException e) {
            throw new UriInvalidException("openInputStream 抛出 FileNotFoundException");
        } catch (Throwable e) {
            throw new IOException("openInputStream 失败：" + safeMsg(e), e);
        }
        if (in == null) {
            throw new UriInvalidException("openInputStream 返回 null");
        }
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > max) {
                    throw new TooLargeException("内容超过 " + max + " 字节上限");
                }
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } finally {
            closeQuietly(in);
        }
    }

    private static byte[] readFileBytes(File file) throws IOException {
        if (file == null || !file.exists()) {
            return null;
        }
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        }
    }

    /** ZIP/OOXML 的本地文件头魔数：前两字节 'P' 'K'。 */
    private static boolean isZipMagic(byte[] data) {
        return data != null && data.length >= 2 && data[0] == 'P' && data[1] == 'K';
    }

    private void registerGrantedUri(Uri uri) {
        if (uri == null) {
            return;
        }
        grantedContentUris.add(uri.toString());
    }

    private boolean isGrantedUri(Uri uri) {
        return uri != null && grantedContentUris.contains(uri.toString());
    }

    private void clearPendingSaveCopy() {
        pendingBytes = null;
        pendingFileName = null;
        pendingSaveCopyInFlight = false;
        pendingSaveCopyArtifactPath = null;
    }

    private void clearPendingImport() {
        pendingImportInFlight = false;
        pendingImportOrigin = null;
        pendingImportUri = null;
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (Throwable e) {
            Log.w(TAG, "关闭资源失败（已忽略）", e);
        }
    }

    /**
     * 统一回报：**只报事实**。
     *
     * 既有通道 {@code PotbotBridgeResult(ok, message)} 的签名**未改动**；状态以
     * {@code [status=...]} 尾巴写进消息，另有一个可选的 {@code PotbotBridgeStatus(json)}
     * 结构化通道（页面未实现时忽略，不会报错）。
     */
    private void reportStatus(final boolean ok, final String status, final String message) {
        final String full = message + " [status=" + status + "]";
        final String statusJson = buildStatusJson(ok, status, message);
        emitStatusJs(full, statusJson, ok);
    }

    /**
     * APP-01/05/06 的**生命周期回报通道**。
     *
     * 与 {@link #reportStatus} **分开**是刻意的：那条通道的每个 {@code ok=true} 语义都被
     * 静态判据要求"只有独立读回核对通过才能发"（保存/导出链）。版本身份、升级结论、
     * 连接状态、重连/取消结果**不是文件保存结论**，混进去会让保存链的判据失真。
     * 本通道**不得**被用来报告任何文件已保存/已导出。
     */
    private void reportAppLifecycle(final boolean ok, final String status, final String message) {
        final String full = message + " [status=" + status + "]";
        final String statusJson = buildStatusJson(ok, status, message);
        emitStatusJs(full, statusJson, ok);
    }

    /** 统一把一次状态回报投递到页面（两个通道共用；不改任何签名）。 */
    private void emitStatusJs(final String full, final String statusJson, final boolean ok) {
        final String js = "javascript:(function(){try{"
                + "if(typeof window." + JS_RESULT_FN + "==='function'){window." + JS_RESULT_FN
                + "(" + (ok ? "true" : "false") + "," + JSONObject.quote(full) + ");}"
                + "if(typeof window." + JS_STATUS_FN + "==='function'){window." + JS_STATUS_FN
                + "(" + JSONObject.quote(statusJson) + ");}"
                + "}catch(e){}})()";
        ui.post(new Runnable() {
            @Override
            public void run() {
                WebView v = webView;
                if (v != null) {
                    try {
                        v.evaluateJavascript(js, null);
                    } catch (Throwable e) {
                        Log.w(TAG, "回报失败", e);
                    }
                }
            }
        });
    }

    // ------------------------------------------------- APP-01/05/06 生命周期辅助

    /** 把 {@link PotbotTaskState} 的幂等键动作结果接到回报通道。 */
    private PotbotTaskActions.Reporter actionReporter() {
        return new PotbotTaskActions.Reporter() {
            @Override
            public void onResult(boolean ok, String status, String message) {
                reportAppLifecycle(ok, status, message);
            }
        };
    }

    /** 从深链/通知意图里取任务 id（没有返回 null）。 */
    private static String taskIdFromIntent(Intent intent) {
        if (intent == null) {
            return null;
        }
        String taskId = intent.getStringExtra(EXTRA_TASK_ID);
        if (taskId == null || taskId.isEmpty()) {
            return null;
        }
        return taskId;
    }

    /** 把"当前任务 / 界面位置"落盘（进程随时可能被回收）。 */
    private void persistActiveTaskState() {
        String taskId = pendingRestoreTaskId;
        String url = lastLocalPageUrl;
        if (taskId == null || taskId.isEmpty()) {
            // 没有活动任务：保留既有记录（可能在别处仍有效），不写入空值。
            return;
        }
        PotbotTaskState.saveActive(this, taskId, null, null, url);
    }

    /**
     * 把"回到任务"与上次已知进度推给页面。页面若实现 {@code PotbotRestoreTask(json)} 才收到；
     * 未实现则**静默**（页面自己也会从持久状态恢复），不报错。
     */
    private void pushRestoreToPage() {
        final String taskId = pendingRestoreTaskId;
        if (taskId == null || taskId.isEmpty() || !pageReady) {
            return;
        }
        final PotbotTaskState.Progress progress = PotbotTaskState.readProgress(this);
        final String json = buildRestoreJson(taskId, progress);
        ui.post(new Runnable() {
            @Override
            public void run() {
                WebView v = webView;
                if (v == null) {
                    return;
                }
                try {
                    v.evaluateJavascript("javascript:(function(){try{"
                            + "if(typeof window.PotbotRestoreTask==='function'){window.PotbotRestoreTask("
                            + JSONObject.quote(json) + ");}"
                            + "}catch(e){}})()", null);
                } catch (Throwable e) {
                    Log.w(TAG, "推送恢复指令失败（不致命）", e);
                }
            }
        });
    }

    private String buildRestoreJson(String taskId, PotbotTaskState.Progress progress) {
        try {
            JSONObject o = new JSONObject();
            o.put("taskId", taskId);
            if (progress != null && progress.isPresent()) {
                o.put("state", progress.state == null ? JSONObject.NULL : progress.state);
                o.put("percent", progress.percent);
                o.put("message", progress.message == null ? JSONObject.NULL : progress.message);
                o.put("cursor", progress.cursor == null ? JSONObject.NULL : progress.cursor);
                o.put("atMillis", progress.atMillis);
            } else {
                o.put("state", JSONObject.NULL);
                o.put("percent", PotbotTaskState.PERCENT_UNKNOWN);
            }
            return o.toString();
        } catch (Throwable e) {
            return "{\"taskId\":" + JSONObject.quote(taskId) + "}";
        }
    }

    /** 重读连通性（三态）。 */
    private void refreshConnectivity() {
        connectivity = PotbotConnectivity.isOnline(this);
    }

    /** 网络回调只注册一次。 */
    private void registerNetworkCallbackIfNeeded() {
        if (networkCallback != null) {
            return;
        }
        networkCallback = PotbotConnectivity.register(this, new PotbotConnectivity.Listener() {
            @Override
            public void onConnectivityChanged(final boolean online, boolean known) {
                connectivity = known
                        ? (online ? PotbotConnectivity.Tri.ONLINE : PotbotConnectivity.Tri.OFFLINE)
                        : PotbotConnectivity.Tri.UNKNOWN;
                reportConnectivity();
                if (online) {
                    // 网络恢复：把续取交给页面/动作层，**不在这里重发任何动作**（避免重复执行）。
                    reportAppLifecycle(true, ST_APP_NET_ONLINE, "网络已恢复；可续取任务进度。");
                } else if (known) {
                    reportAppLifecycle(false, ST_APP_NET_OFFLINE, "网络已断开；已停止重试。");
                }
            }
        });
    }

    private void unregisterNetworkCallback() {
        if (networkCallback != null) {
            PotbotConnectivity.unregister(this, networkCallback);
            networkCallback = null;
        }
    }

    /** 只报事实的连接状态（未知就是未知）。 */
    private void reportConnectivity() {
        if (connectivity == PotbotConnectivity.Tri.ONLINE) {
            reportAppLifecycle(true, ST_APP_NET_ONLINE, getString(R.string.potbot_state_online));
        } else if (connectivity == PotbotConnectivity.Tri.OFFLINE) {
            reportAppLifecycle(false, ST_APP_NET_OFFLINE, getString(R.string.potbot_state_offline));
        } else {
            reportAppLifecycle(false, ST_APP_NET_UNKNOWN, getString(R.string.potbot_state_unknown));
        }
    }

    /**
     * 冷启动/回到前台时回报 App 侧事实一次：版本身份、升级结论、连接状态。
     * **版本身份不一致与升级失败都如实报**（不掩盖）。
     */
    private void reportAppState() {
        if (appVersion != null) {
            if (appVersion.isConsistent()) {
                reportAppLifecycle(true, ST_APP_VERSION_CONSISTENT, appVersion.describe());
            } else {
                reportAppLifecycle(false, ST_APP_VERSION_MISMATCH, appVersion.describe());
            }
        }
        if (upgradeResult != null) {
            if (upgradeResult.state == PotbotUpgrade.State.MIGRATION_FAILED) {
                reportAppLifecycle(false, ST_APP_UPGRADE_FAILED,
                        upgradeResult.describe() + "；" + getString(R.string.potbot_upgrade_failed));
            } else if (upgradeResult.state == PotbotUpgrade.State.DOWNGRADE_REJECTED) {
                reportAppLifecycle(false, ST_APP_UPGRADE_DOWNGRADE,
                        upgradeResult.describe() + "；" + getString(R.string.potbot_upgrade_downgrade));
            } else {
                reportAppLifecycle(true, ST_APP_UPGRADE_OK, upgradeResult.describe());
            }
        }
        String taskId = pendingRestoreTaskId;
        if (taskId != null && !taskId.isEmpty()) {
            PotbotTaskState.Progress progress = PotbotTaskState.readProgress(this);
            String detail = "已回到任务 " + taskId;
            if (progress != null && progress.isPresent() && progress.state != null) {
                detail = detail + "（上次已知状态 " + progress.state
                        + (progress.percent >= 0 ? "，进度 " + progress.percent + "%" : "，进度未知") + "）";
            }
            reportAppLifecycle(true, ST_APP_TASK_RESTORED, detail);
        }
        reportConnectivity();
    }

    /** 只读的 App 侧事实 JSON（供 appInfo()）。**不含任何凭据值**。 */
    private String buildAppInfoJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("platform", "android");
            o.put("appVersion", appVersion == null ? JSONObject.NULL : appVersion.installedVersionName);
            o.put("versionCode", appVersion == null ? -1L : appVersion.installedVersionCode);
            o.put("productVersion", appVersion == null ? JSONObject.NULL : appVersion.productVersion);
            o.put("versionConsistent", appVersion != null && appVersion.isConsistent());
            o.put("upgradeState", upgradeResult == null ? JSONObject.NULL : upgradeResult.state.name());
            o.put("baseUrl", PotbotEndpoints.baseUrl(this));
            o.put("devUsbMode", PotbotEndpoints.isDevUsbMode(this));
            o.put("credentialConfigured", PotbotEndpoints.hasCredential(this));
            o.put("online", connectivity == PotbotConnectivity.Tri.ONLINE);
            o.put("onlineKnown", connectivity != PotbotConnectivity.Tri.UNKNOWN);
            o.put("activeTaskId", pendingRestoreTaskId == null ? JSONObject.NULL : pendingRestoreTaskId);
            o.put("backgroundJobScheduled", PotbotProgressJobService.isScheduled(this));
            return o.toString();
        } catch (Throwable e) {
            return "{\"platform\":\"android\",\"error\":\"app_info_failed\"}";
        }
    }

    private static String buildStatusJson(boolean ok, String status, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("status", status);
            o.put("ok", ok);
            o.put("message", message);
            o.put("platform", "android");
            return o.toString();
        } catch (Throwable e) {
            return "{\"status\":\"status_report_failed\",\"ok\":false,\"platform\":\"android\"}";
        }
    }

    private static String sanitizeFilename(String name) {
        if (name == null) {
            return null;
        }
        String n = name.trim();
        if (n.isEmpty()) {
            return null;
        }
        // 只取最后一段，去掉任何目录成分
        n = n.replace('\\', '/');
        int slash = n.lastIndexOf('/');
        if (slash >= 0) {
            n = n.substring(slash + 1);
        }
        n = n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
        if (n.isEmpty() || ".".equals(n) || "..".equals(n)) {
            return null;
        }
        if (n.length() > 120) {
            n = n.substring(0, 120);
        }
        if (!n.toLowerCase(Locale.ROOT).endsWith(".docx")) {
            n = n + ".docx";
        }
        return n;
    }

    /** PDF 文件名的同名消毒规则（与 DOCX 一致，只是扩展名换成 .pdf）。 */
    private static String sanitizePdfFilename(String name) {
        if (name == null) {
            return null;
        }
        String n = name.trim();
        if (n.isEmpty()) {
            return null;
        }
        n = n.replace('\\', '/');
        int slash = n.lastIndexOf('/');
        if (slash >= 0) {
            n = n.substring(slash + 1);
        }
        n = n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
        if (n.isEmpty() || ".".equals(n) || "..".equals(n)) {
            return null;
        }
        if (n.length() > 120) {
            n = n.substring(0, 120);
        }
        if (!n.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
            n = n + ".pdf";
        }
        return n;
    }

    /** 产物是不是 PDF（文件头前 5 字节 `%PDF-`）——改扩展名伪造在这里被抓住。 */
    private static boolean isPdfMagic(byte[] data) {
        if (data == null || data.length < 5) {
            return false;
        }
        return data[0] == '%' && data[1] == 'P' && data[2] == 'D' && data[3] == 'F'
                && data[4] == '-';
    }

    /** 取前 n 字节的可打印形式（供失败消息里逐字引用）。 */
    private static String asciiPrefix(byte[] data, int n) {
        if (data == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n && i < data.length; i++) {
            int c = data[i] & 0xFF;
            sb.append(c >= 32 && c < 127 ? (char) c : '?');
        }
        return sb.toString();
    }

    /** 磁盘空间不足（与一般 IO 失败分开判定）。 */
    private static boolean isNoSpace(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return false;
        }
        String lower = m.toLowerCase(Locale.ROOT);
        return lower.contains("enospc") || lower.contains("no space left")
                || lower.contains("no space") || lower.contains("磁盘空间不足");
    }

    private void clearPendingPdfCopy() {
        pendingPdfCopyInFlight = false;
        pendingPdfCopySourcePath = null;
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(data);
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static String safeMsg(Throwable e) {
        String m = e == null ? null : e.getMessage();
        if (m == null) {
            return "";
        }
        return m.length() > 300 ? m.substring(0, 300) : m;
    }

    private void toast(final String msg) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }
}
