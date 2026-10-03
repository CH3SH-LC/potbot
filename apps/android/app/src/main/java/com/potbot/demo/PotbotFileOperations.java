package com.potbot.demo;

import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * APP-04（任务与文件：搜索 / 历史版本 / 重命名 / 打开 / 另存 / 分享 + URI 授权与失权）
 * —— **唯一**的文件操作入口。
 *
 * <p>六件事各只有一条路：
 * <ol>
 *   <li>{@link #search} 在"任务 + 文件"的同一个列表上按名字/编号模糊搜；</li>
 *   <li>{@link #history} 同一份文档的**历史版本**（按版本号倒序，最新在前）；</li>
 *   <li>{@link #rename} 重命名，**校验非法字符并把扩展名保留住**；</li>
 *   <li>{@link #buildOpenIntent} 用系统里能打开该类型的应用打开（content:// + 临时读授权）；</li>
 *   <li>{@link #buildSaveAsIntent} 另存到用户选的位置（SAF {@code ACTION_CREATE_DOCUMENT}）；</li>
 *   <li>{@link #buildShareIntent} 分享出去（content:// + 临时读授权）。</li>
 * </ol>
 *
 * <p><b>URI 授权/失权（本类的核心纪律）：</b>
 * <ul>
 *   <li>{@link #takePersistableRead} 尽量把读权限持久化（{@code ACTION_OPEN_DOCUMENT}
 *       来的才有；{@code ACTION_GET_CONTENT} 来的**注定失败**，此时如实返回 false）；</li>
 *   <li>{@link #isPersistedRead} 逐条核对 {@code getPersistedUriPermissions()}
 *       ——**这才是"现在还能不能读"的唯一依据**；</li>
 *   <li>{@link #checkPersistedRead} 在没持久化权限时给出
 *       {@link #ST_URI_PERMISSION_LOST}，**绝不假装还能读**；</li>
 *   <li>{@link #fromPickerResult} 把"用户取消"与"拿不到 URI"分开报，不混为一谈；</li>
 *   <li>{@link #verifyReadBack} 写入后**关闭流再读回**、比对长度与摘要——写成功不等于
 *       读得到对的内容。</li>
 * </ul>
 *
 * <p>用户可见文案一律在 {@code strings.xml}（{@link Decision#messageRes} 只给资源号），
 * 本类内**没有**面向用户的硬编码文本。
 *
 * <p><b>未验证（需真机）</b>：真实的持久授权行为、各家系统选择器返回的 URI 形态、
 * 以及"撤销授权后"的实机表现，本批**没有设备**，未验证。
 */
public final class PotbotFileOperations {

    // ---------------------------------------------------------------- 状态（机器可判）

    /** 该 URI 的读权限已失效（未持久化 / 被撤销）——不得假装还能读。 */
    public static final String ST_URI_PERMISSION_LOST = "file_uri_permission_lost";
    /** 只能拿到本次临时授权（例如 GET_CONTENT 来的），下次要重新选。 */
    public static final String ST_URI_PERSIST_NOT_GRANTED = "file_uri_persist_not_granted";
    /** 不是 content:// 的 URI。 */
    public static final String ST_URI_NOT_CONTENT = "file_uri_not_content";
    /** URI 无法解析 / 系统没返回。 */
    public static final String ST_URI_INVALID = "file_uri_invalid";
    /** 用户在系统选择器里取消了。 */
    public static final String ST_CANCELLED = "file_op_cancelled";
    /** 写回后读回核对通过。 */
    public static final String ST_READBACK_OK = "file_readback_ok";
    /** 读回的长度/摘要与写入内容不符。 */
    public static final String ST_READBACK_MISMATCH = "file_readback_mismatch";
    /** 读回本身失败。 */
    public static final String ST_READBACK_FAILED = "file_readback_failed";
    /** 搜不到。 */
    public static final String ST_SEARCH_EMPTY = "file_search_empty";
    /** 没有更早的版本。 */
    public static final String ST_HISTORY_EMPTY = "file_history_empty";
    /** 新名字为空。 */
    public static final String ST_RENAME_EMPTY = "file_rename_empty";
    /** 新名字含非法字符。 */
    public static final String ST_RENAME_INVALID = "file_rename_invalid";
    /** 重命名成功。 */
    public static final String ST_RENAME_OK = "file_rename_ok";
    /** 没有能打开该文件的应用。 */
    public static final String ST_OPEN_NO_APP = "file_open_no_app";
    /** 没有能分享的应用。 */
    public static final String ST_SHARE_NO_APP = "file_share_no_app";
    /** 另存被系统拒了。 */
    public static final String ST_SAVE_AS_FAILED = "file_save_as_failed";
    /** 已交给系统应用打开。 */
    public static final String ST_OPEN_OK = "file_open_ok";

    /** 单次读入上限（与保存链一致，避免无限读入）。 */
    public static final long MAX_IO_BYTES = 64L * 1024L * 1024L;
    /** 文件名长度上限。 */
    public static final int MAX_NAME_LENGTH = 120;

    private PotbotFileOperations() {
    }

    /** 状态 → 文案资源号（文案只在 strings.xml）。 */
    public static int messageRes(String status) {
        if (ST_URI_PERMISSION_LOST.equals(status)) return R.string.potbot_file_uri_permission_lost;
        if (ST_URI_PERSIST_NOT_GRANTED.equals(status)) {
            return R.string.potbot_file_uri_persist_not_granted;
        }
        if (ST_URI_NOT_CONTENT.equals(status)) return R.string.potbot_file_uri_not_content;
        if (ST_URI_INVALID.equals(status)) return R.string.potbot_file_uri_invalid;
        if (ST_CANCELLED.equals(status)) return R.string.potbot_file_op_cancelled;
        if (ST_READBACK_MISMATCH.equals(status)) return R.string.potbot_file_readback_mismatch;
        if (ST_READBACK_FAILED.equals(status)) return R.string.potbot_file_readback_failed;
        if (ST_READBACK_OK.equals(status)) return R.string.potbot_file_readback_ok;
        if (ST_SEARCH_EMPTY.equals(status)) return R.string.potbot_file_search_empty;
        if (ST_HISTORY_EMPTY.equals(status)) return R.string.potbot_file_history_empty;
        if (ST_RENAME_EMPTY.equals(status)) return R.string.potbot_file_rename_empty;
        if (ST_RENAME_INVALID.equals(status)) return R.string.potbot_file_rename_invalid;
        if (ST_RENAME_OK.equals(status)) return R.string.potbot_file_rename_ok;
        if (ST_OPEN_NO_APP.equals(status)) return R.string.potbot_file_open_no_app;
        if (ST_SHARE_NO_APP.equals(status)) return R.string.potbot_file_share_no_app;
        if (ST_OPEN_OK.equals(status)) return R.string.potbot_file_open_ok;
        return R.string.potbot_file_save_as_failed;
    }

    // ---------------------------------------------------------------- 决策

    /** 一次文件操作的结果（ok/状态/URI）。 */
    public static final class Decision {
        public final boolean ok;
        public final String status;
        public final Uri uri;

        Decision(boolean ok, String status, Uri uri) {
            this.ok = ok;
            this.status = status;
            this.uri = uri;
        }

        public static Decision ok(Uri uri, String status) {
            return new Decision(true, status, uri);
        }

        public static Decision fail(String status) {
            return new Decision(false, status, null);
        }

        public int messageRes() {
            return PotbotFileOperations.messageRes(status);
        }
    }

    // ---------------------------------------------------------------- 任务/文件记录

    /** 一条"任务或文件"的元数据（搜索/历史/重命名的对象）。 */
    public static final class Record {
        public final String id;
        public final String name;
        public final int version;
        public final long updatedAt;
        public final long sizeBytes;

        public Record(String id, String name, int version, long updatedAt, long sizeBytes) {
            this.id = id;
            this.name = name;
            this.version = version;
            this.updatedAt = updatedAt;
            this.sizeBytes = sizeBytes;
        }

        /** 重命名后得到的新记录（id/版本/时间不变，只换名字）。 */
        public Record withName(String newName) {
            return new Record(id, newName, version, updatedAt, sizeBytes);
        }
    }

    // ---------------------------------------------------------------- 1. 搜索

    /** 关键词搜索：空关键词**不**返回全部（否则等于没有搜索）；匹配名字或编号，时间倒序。 */
    public static List<Record> search(List<Record> all, String query) {
        List<Record> out = new ArrayList<Record>();
        if (all == null || query == null) {
            return out;
        }
        String q = query.trim().toLowerCase(Locale.ROOT);
        if (q.isEmpty()) {
            return out;
        }
        for (Record r : all) {
            if (r == null) {
                continue;
            }
            String name = r.name == null ? "" : r.name.toLowerCase(Locale.ROOT);
            String id = r.id == null ? "" : r.id.toLowerCase(Locale.ROOT);
            if (name.contains(q) || id.contains(q)) {
                out.add(r);
            }
        }
        Collections.sort(out, byUpdatedDesc());
        return out;
    }

    // ---------------------------------------------------------------- 2. 历史版本

    /** 同一份文档的历史版本：按版本号**倒序**（最新在前）；只有一条也算，空则空。 */
    public static List<Record> history(List<Record> all, String id) {
        List<Record> out = new ArrayList<Record>();
        if (all == null || id == null) {
            return out;
        }
        for (Record r : all) {
            if (r != null && id.equals(r.id)) {
                out.add(r);
            }
        }
        Collections.sort(out, new Comparator<Record>() {
            @Override
            public int compare(Record a, Record b) {
                return Integer.compare(b.version, a.version);
            }
        });
        return out;
    }

    // ---------------------------------------------------------------- 3. 重命名

    /**
     * 重命名：为空 / 含非法字符 / 过长都拒绝；**没有扩展名时保留原扩展名**
     * （避免把 {@code 报告.docx} 改成 {@code 报告} 之后打不开）。
     */
    public static Decision rename(String currentName, String requested) {
        String n = requested == null ? "" : requested.trim();
        if (n.isEmpty()) {
            return Decision.fail(ST_RENAME_EMPTY);
        }
        if (n.length() > MAX_NAME_LENGTH) {
            return Decision.fail(ST_RENAME_INVALID);
        }
        if (".".equals(n) || "..".equals(n)) {
            return Decision.fail(ST_RENAME_INVALID);
        }
        if (containsIllegalNameChar(n)) {
            return Decision.fail(ST_RENAME_INVALID);
        }
        return Decision.ok(null, ST_RENAME_OK);
    }

    /** 重命名的完整形态：直接返回新名字（{@link #rename} 只做校验，这里是结果）。 */
    public static String renamedName(String currentName, String requested) {
        Decision d = rename(currentName, requested);
        if (!d.ok) {
            return null;
        }
        return appendPreservedExtension(currentName, requested == null ? "" : requested.trim());
    }

    private static String appendPreservedExtension(String currentName, String newName) {
        String ext = PotbotInputGateway.extensionOf(currentName);
        if (PotbotInputGateway.extensionOf(newName) == null && ext != null) {
            return newName + "." + ext;
        }
        return newName;
    }

    private static boolean containsIllegalNameChar(String n) {
        for (int i = 0; i < n.length(); i++) {
            char c = n.charAt(i);
            if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?'
                    || c == '"' || c == '<' || c == '>' || c == '|') {
                return true;
            }
            if (c < 0x20) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 4/5/6. 打开 / 另存 / 分享

    /** 打开：交给系统能打开该类型的应用（content:// + 临时读授权）。 */
    public static Intent buildOpenIntent(Uri uri, String mime) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mime == null ? PotbotInputGateway.MIME_WILDCARD : mime);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    /** 分享：{@code ACTION_SEND} + content:// + 临时读授权。 */
    public static Intent buildShareIntent(Uri uri, String mime, String subject) {
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType(mime == null ? PotbotInputGateway.MIME_WILDCARD : mime);
        intent.putExtra(Intent.EXTRA_STREAM, uri);
        if (subject != null && !subject.isEmpty()) {
            intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    /** 另存：{@code ACTION_CREATE_DOCUMENT}，由用户选位置与文件名。 */
    public static Intent buildSaveAsIntent(String mime, String defaultName) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null ? PotbotInputGateway.MIME_WILDCARD : mime);
        if (defaultName != null && !defaultName.isEmpty()) {
            intent.putExtra(Intent.EXTRA_TITLE, defaultName);
        }
        return intent;
    }

    /** 有没有应用能接这个意图（没有就如实报"没有应用"，不静默什么都不发生）。 */
    public static boolean canResolve(Context context, Intent intent) {
        if (context == null || intent == null) {
            return false;
        }
        try {
            return !context.getPackageManager().queryIntentActivities(intent, 0).isEmpty();
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 打开一个 URI：先过**权限门**（content:// 且没有持久读权限就别假装能打开），
     * 再交给系统；系统没有可接的应用时返回 {@link #ST_OPEN_NO_APP}。
     */
    public static Decision open(Context context, Uri uri, String mime) {
        if (uri == null) {
            return Decision.fail(ST_URI_INVALID);
        }
        Decision gate = checkPersistedRead(context, uri);
        if (!gate.ok) {
            return gate;
        }
        Intent intent = buildOpenIntent(uri, mime);
        if (!canResolve(context, intent)) {
            return Decision.fail(ST_OPEN_NO_APP);
        }
        return Decision.ok(uri, ST_OPEN_OK);
    }

    // ---------------------------------------------------------------- URI 授权 / 失权

    /**
     * 尝试把读权限持久化。{@code ACTION_GET_CONTENT} 来的 URI **拿不到持久授权**，
     * 此时返回 false——调用方据此如实标注"只有本次临时授权"。
     */
    public static boolean takePersistableRead(Context context, Uri uri) {
        if (context == null || uri == null) {
            return false;
        }
        if (!"content".equalsIgnoreCase(uri.getScheme())) {
            return false;
        }
        try {
            context.getContentResolver().takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 撤销读权限（用户主动断开时用）。 */
    public static boolean releasePersistableRead(Context context, Uri uri) {
        if (context == null || uri == null) {
            return false;
        }
        try {
            context.getContentResolver().releasePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 现在是否**真的**还持有该 URI 的持久读权限（逐条核对系统记录，不看记忆）。 */
    public static boolean isPersistedRead(Context context, Uri uri) {
        if (context == null || uri == null) {
            return false;
        }
        try {
            List<UriPermission> held = context.getContentResolver().getPersistedUriPermissions();
            if (held == null) {
                return false;
            }
            String want = uri.toString();
            for (UriPermission p : held) {
                if (p != null && p.isReadPermission() && p.getUri() != null
                        && want.equals(p.getUri().toString())) {
                    return true;
                }
            }
            return false;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 还能不能读：没持久权限就 {@link #ST_URI_PERMISSION_LOST}，**不假装还能读**。 */
    public static Decision checkPersistedRead(Context context, Uri uri) {
        if (uri == null) {
            return Decision.fail(ST_URI_INVALID);
        }
        if (!"content".equalsIgnoreCase(uri.getScheme())) {
            return Decision.fail(ST_URI_NOT_CONTENT);
        }
        if (isPersistedRead(context, uri)) {
            return Decision.ok(uri, ST_READBACK_OK);
        }
        return Decision.fail(ST_URI_PERMISSION_LOST);
    }

    /**
     * 选文件回来：把**取消**、**没给 URI**、**不是 content://** 分开报；
     * 成功的那个再尝试持久化（失败则如实告诉用户"本次有效"）。
     */
    public static Decision fromPickerResult(Context context, int resultCode, Intent data) {
        // RESULT_CANCELED = 0；用常量而不是字面量，免得哪天平台常量变了。
        if (resultCode == android.app.Activity.RESULT_CANCELED) {
            return Decision.fail(ST_CANCELLED);
        }
        Uri uri = data == null ? null : data.getData();
        if (uri == null) {
            return Decision.fail(ST_URI_INVALID);
        }
        if (!"content".equalsIgnoreCase(uri.getScheme())) {
            return Decision.fail(ST_URI_NOT_CONTENT);
        }
        if (!takePersistableRead(context, uri)) {
            return new Decision(true, ST_URI_PERSIST_NOT_GRANTED, uri);
        }
        return Decision.ok(uri, ST_READBACK_OK);
    }

    /** 写回后**关闭流再读回**，比对长度与 SHA-256；不符就是不符。 */
    public static Decision verifyReadBack(Context context, Uri target, byte[] written) {
        if (written == null) {
            return Decision.fail(ST_READBACK_FAILED);
        }
        byte[] back;
        try {
            back = readAll(context, target);
        } catch (UriReadException e) {
            return Decision.fail(e.status);
        }
        if (back == null || back.length == 0) {
            return Decision.fail(ST_READBACK_FAILED);
        }
        if (back.length != written.length) {
            return Decision.fail(ST_READBACK_MISMATCH);
        }
        String a = sha256Hex(back);
        String b = sha256Hex(written);
        if (a == null || b == null || !a.equalsIgnoreCase(b)) {
            return Decision.fail(ST_READBACK_MISMATCH);
        }
        return Decision.ok(target, ST_READBACK_OK);
    }

    // ---------------------------------------------------------------- 读入

    /** 读入失败时带出的状态。 */
    private static final class UriReadException extends Exception {
        final String status;

        UriReadException(String status) {
            this.status = status;
        }
    }

    private static byte[] readAll(Context context, Uri uri) throws UriReadException {
        if (context == null || uri == null) {
            throw new UriReadException(ST_URI_INVALID);
        }
        if (!"content".equalsIgnoreCase(uri.getScheme())) {
            throw new UriReadException(ST_URI_NOT_CONTENT);
        }
        InputStream in = null;
        try {
            in = context.getContentResolver().openInputStream(uri);
            if (in == null) {
                throw new UriReadException(ST_URI_INVALID);
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (bos.size() + n > MAX_IO_BYTES) {
                    throw new UriReadException(ST_READBACK_FAILED);
                }
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } catch (UriReadException e) {
            throw e;
        } catch (SecurityException e) {
            throw new UriReadException(ST_URI_PERMISSION_LOST);
        } catch (FileNotFoundException e) {
            throw new UriReadException(ST_URI_PERMISSION_LOST);
        } catch (Throwable e) {
            throw new UriReadException(ST_READBACK_FAILED);
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable e) {
                    // 忽略
                }
            }
        }
    }

    private static String sha256Hex(byte[] data) {
        if (data == null) {
            return null;
        }
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(data);
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

    private static Comparator<Record> byUpdatedDesc() {
        return new Comparator<Record>() {
            @Override
            public int compare(Record a, Record b) {
                return Long.compare(b.updatedAt, a.updatedAt);
            }
        };
    }
}
