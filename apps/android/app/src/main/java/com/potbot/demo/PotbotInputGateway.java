package com.potbot.demo;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * APP-03（输入入口与类型识别）+ APP-08（多文件/长文本）—— **唯一**的输入判定入口。
 *
 * <p>四个入口都收敛到这里，判定结果只有一个出处的 {@link Incoming}：
 * <ul>
 *   <li>{@link #fromText} / {@link #fromPaste}：用户直接输入或粘贴的**文本**；</li>
 *   <li>{@link #parseIncoming}：系统分享（{@code ACTION_SEND}）、
 *       {@code ACTION_SEND_MULTIPLE}（多文件）、{@code ACTION_VIEW}（用本应用打开）；</li>
 *   <li>{@link #buildOpenDocumentIntent}：{@code ACTION_OPEN_DOCUMENT}
 *       （可持久授权，能 {@code takePersistableUriPermission}）；</li>
 *   <li>{@link #buildGetContentIntent}：{@code ACTION_GET_CONTENT}
 *       （**只能**得到本次临时授权，不能持久化——两者的差别在方法名前就写明白）。</li>
 * </ul>
 *
 * <p><b>类型识别是双重判定（MIME + 扩展名），不是二选一：</b>
 * <ul>
 *   <li>MIME 是"不表态类型"（缺失 / 通配 / {@code application/octet-stream}）时，
 *       由扩展名定，**不当成冲突**；</li>
 *   <li>MIME 明确表示不支持（如 {@code video/mp4}）时，直接判不支持，**不拿扩展名去圆**；</li>
 *   <li>两者都表态且**不同**（例如 MIME 说表格、文件名却是 {@code .docx}）时，
 *       具名报 {@link #ST_MIME_EXTENSION_CONFLICT}，**不按任何一种类型读**——
 *       冲突就是冲突，猜一个更糟。</li>
 * </ul>
 *
 * <p><b>纪律（R205 的直接推论）：</b>判不出来就判不出来。不支持的输入一律
 * {@code accepted=false} + {@link #ST_UNSUPPORTED}，**绝不当成"已解析"**继续往下走。
 * 任何用户可见文案都在 {@code strings.xml}（{@link #messageRes} 只给资源号，本类里
 * **没有**一句面向用户的硬编码文本）。
 *
 * <p><b>未验证（需真机）</b>：真机上的分享来源、系统选择器返回的 MIME 习惯、
 * 中文输入法行为都未在本批核对（本包不跑 Gradle、不装 APK、不连设备）。
 * 本类只保证判定表与入口构造的**结构**正确。
 */
public final class PotbotInputGateway {

    // ---------------------------------------------------------------- 来源标识

    /** 没有输入。 */
    public static final String SOURCE_NONE = "none";
    /** 用户直接输入的文本。 */
    public static final String SOURCE_TEXT = "text";
    /** 粘贴进来的文本。 */
    public static final String SOURCE_PASTE = "paste";
    /** 系统分享（单条）。 */
    public static final String SOURCE_SHARE = "share";
    /** 系统分享（多条）。 */
    public static final String SOURCE_SHARE_MULTIPLE = "share_multiple";
    /** 文件选择器。 */
    public static final String SOURCE_FILE_PICKER = "file_picker";
    /** 用本应用打开（ACTION_VIEW）。 */
    public static final String SOURCE_OPEN_WITH = "open_with";

    // ---------------------------------------------------------------- 类型

    /** 被识别的输入类型。 */
    public enum Kind {
        DOCX, XLSX, PPTX, PDF, TEXT, IMAGE, UNSUPPORTED
    }

    // ---------------------------------------------------------------- MIME

    public static final String MIME_DOCX =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    public static final String MIME_XLSX =
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    public static final String MIME_PPTX =
            "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    public static final String MIME_PDF = "application/pdf";
    public static final String MIME_TEXT_PLAIN = "text/plain";
    public static final String MIME_TEXT_MARKDOWN = "text/markdown";
    public static final String MIME_TEXT_CSV = "text/csv";
    /** 图片按前缀接受（png/jpeg/gif/webp/bmp 都算）。 */
    public static final String MIME_IMAGE_PREFIX = "image/";
    /** 通配类型：**不代表任何具体类型**，因此不参与冲突判定。 */
    public static final String MIME_WILDCARD = "*/*";
    /** 兜底类型：**不代表任何具体类型**，因此不参与冲突判定。 */
    public static final String MIME_OCTET_STREAM = "application/octet-stream";

    /** 长文本上限（APP-08）：超过上限**明确拒绝**，不截断后冒充完整。 */
    public static final int MAX_TEXT_CHARS = 200_000;

    // ---------------------------------------------------------------- 状态（机器可判）

    /** 已识别一个文件。 */
    public static final String ST_ACCEPTED_FILE = "input_accepted_file";
    /** 已收到文本。 */
    public static final String ST_ACCEPTED_TEXT = "input_accepted_text";
    /** 已收到多个文件（全部识别通过）。 */
    public static final String ST_ACCEPTED_MULTIPLE = "input_accepted_multiple";
    /** 不支持的类型——如实反馈，不当成已解析。 */
    public static final String ST_UNSUPPORTED = "input_unsupported";
    /** MIME 与扩展名冲突——具名报错，不猜。 */
    public static final String ST_MIME_EXTENSION_CONFLICT = "input_mime_extension_conflict";
    /** 文本为空。 */
    public static final String ST_TEXT_EMPTY = "input_text_empty";
    /** 文本超长。 */
    public static final String ST_TEXT_TOO_LONG = "input_text_too_long";
    /** 分享/打开意图里没有文件。 */
    public static final String ST_NO_URI = "input_no_uri";
    /** 方案不是 content://（例如 file:// 直传磁盘路径）。 */
    public static final String ST_SCHEME_NOT_CONTENT = "input_scheme_not_content";
    /** 多文件里有一个没通过——整体不通过。 */
    public static final String ST_MULTIPLE_PARTIAL = "input_multiple_partial";
    /** 意图里没有任何可识别输入。 */
    public static final String ST_NONE = "input_none";

    private PotbotInputGateway() {
    }

    // ---------------------------------------------------------------- 状态 → 文案资源

    /**
     * 状态 → 用户可见文案资源号。**文案在本类里没有字面量**，只在 {@code strings.xml}。
     * 未知状态回落到"不支持"的文案（宁可保守，也不留空白）。
     */
    public static int messageRes(String status) {
        if (ST_ACCEPTED_FILE.equals(status)) return R.string.potbot_input_accepted_file;
        if (ST_ACCEPTED_TEXT.equals(status)) return R.string.potbot_input_accepted_text;
        if (ST_ACCEPTED_MULTIPLE.equals(status)) return R.string.potbot_input_accepted_multiple;
        if (ST_MIME_EXTENSION_CONFLICT.equals(status)) return R.string.potbot_input_mime_conflict;
        if (ST_TEXT_EMPTY.equals(status)) return R.string.potbot_input_text_empty;
        if (ST_TEXT_TOO_LONG.equals(status)) return R.string.potbot_input_text_too_long;
        if (ST_NO_URI.equals(status)) return R.string.potbot_input_no_uri;
        if (ST_SCHEME_NOT_CONTENT.equals(status)) return R.string.potbot_input_scheme_not_content;
        if (ST_MULTIPLE_PARTIAL.equals(status)) return R.string.potbot_input_multiple_partial;
        if (ST_NONE.equals(status)) return R.string.potbot_input_none;
        return R.string.potbot_input_unsupported;
    }

    // ---------------------------------------------------------------- 单项 / 整体

    /** 一个输入项（文件或文本）。 */
    public static final class Item {
        /** {@link Kind#name()}。 */
        public final String kind;
        public final String mime;
        public final String displayName;
        public final String uri;
        public final String text;
        public final boolean accepted;
        public final String status;

        Item(String kind, String mime, String displayName, String uri, String text,
             boolean accepted, String status) {
            this.kind = kind;
            this.mime = mime;
            this.displayName = displayName;
            this.uri = uri;
            this.text = text;
            this.accepted = accepted;
            this.status = status;
        }
    }

    /** 一次输入的判定结果（唯一的成败出处）。 */
    public static final class Incoming {
        public final String source;
        public final boolean accepted;
        public final String status;
        public final List<Item> items;

        Incoming(String source, boolean accepted, String status, List<Item> items) {
            this.source = source;
            this.accepted = accepted;
            this.status = status;
            this.items = Collections.unmodifiableList(items);
        }

        /** 没有输入（冷启动且意图无关）。 */
        public static Incoming none() {
            return new Incoming(SOURCE_NONE, false, ST_NONE, new ArrayList<Item>());
        }
    }

    // ---------------------------------------------------------------- 判定表（纯函数）

    /** 归一化 MIME：小写、去参数、去空白。空串回 null。 */
    public static String normalizeMime(String mime) {
        if (mime == null) {
            return null;
        }
        String m = mime.trim().toLowerCase(Locale.ROOT);
        int semi = m.indexOf(';');
        if (semi >= 0) {
            m = m.substring(0, semi).trim();
        }
        return m.isEmpty() ? null : m;
    }

    /**
     * MIME 是否**表态**。{@code *}{@code /*}、{@code application/octet-stream}、
     * 空、缺斜杠的类型都算"不表态"——它们不是判据，交给扩展名。
     */
    public static boolean isDefinitiveMime(String mime) {
        String m = normalizeMime(mime);
        if (m == null) {
            return false;
        }
        if (MIME_WILDCARD.equals(m) || MIME_OCTET_STREAM.equals(m)) {
            return false;
        }
        return m.indexOf('/') > 0;
    }

    /**
     * MIME → 类型。返回 {@code null} = **MIME 不表态**（不是"不支持"）；
     * 返回 {@link Kind#UNSUPPORTED} = MIME 明确表示不支持。
     */
    public static Kind kindForMime(String mime) {
        String m = normalizeMime(mime);
        if (!isDefinitiveMime(m)) {
            return null;
        }
        if (MIME_DOCX.equals(m)) return Kind.DOCX;
        if (MIME_XLSX.equals(m)) return Kind.XLSX;
        if (MIME_PPTX.equals(m)) return Kind.PPTX;
        if (MIME_PDF.equals(m)) return Kind.PDF;
        if (MIME_TEXT_PLAIN.equals(m) || MIME_TEXT_MARKDOWN.equals(m) || MIME_TEXT_CSV.equals(m)) {
            return Kind.TEXT;
        }
        if (m.startsWith(MIME_IMAGE_PREFIX)) return Kind.IMAGE;
        return Kind.UNSUPPORTED;
    }

    /** 取扩展名（小写，不含点）；没有扩展名回 null。 */
    public static String extensionOf(String displayName) {
        if (displayName == null) {
            return null;
        }
        String n = displayName.trim();
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) {
            n = n.substring(slash + 1);
        }
        int dot = n.lastIndexOf('.');
        if (dot <= 0 || dot == n.length() - 1) {
            return null;
        }
        return n.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /**
     * 扩展名 → 类型。返回 {@code null} = **扩展名不表态**（无扩展名或不在表里）。
     * 本方法**从不**返回 {@link Kind#UNSUPPORTED}：不认识的扩展名只是"没表态"。
     */
    public static Kind kindForExtension(String displayName) {
        String ext = extensionOf(displayName);
        if (ext == null) {
            return null;
        }
        if ("docx".equals(ext)) return Kind.DOCX;
        if ("xlsx".equals(ext)) return Kind.XLSX;
        if ("pptx".equals(ext)) return Kind.PPTX;
        if ("pdf".equals(ext)) return Kind.PDF;
        if ("txt".equals(ext) || "md".equals(ext) || "csv".equals(ext) || "log".equals(ext)) {
            return Kind.TEXT;
        }
        if ("png".equals(ext) || "jpg".equals(ext) || "jpeg".equals(ext) || "gif".equals(ext)
                || "webp".equals(ext) || "bmp".equals(ext)) {
            return Kind.IMAGE;
        }
        return null;
    }

    /**
     * 双重判定：MIME + 扩展名。
     *
     * <ol>
     *   <li>MIME 明确不支持 → {@link Kind#UNSUPPORTED}；</li>
     *   <li>两者都表态且不同 → {@link Kind#UNSUPPORTED}（并由调用方报
     *       {@link #ST_MIME_EXTENSION_CONFLICT}——见 {@link #classifyFile}）；</li>
     *   <li>只有一个表态 → 用表态的那个；</li>
     *   <li>都不表态 → {@link Kind#UNSUPPORTED}。</li>
     * </ol>
     */
    public static Kind kindOf(String mime, String displayName) {
        Kind byMime = kindForMime(mime);
        Kind byExt = kindForExtension(displayName);
        if (byMime == Kind.UNSUPPORTED) {
            return Kind.UNSUPPORTED;
        }
        if (byMime != null && byExt != null) {
            return byMime == byExt ? byMime : Kind.UNSUPPORTED;
        }
        if (byMime != null) {
            return byMime;
        }
        if (byExt != null) {
            return byExt;
        }
        return Kind.UNSUPPORTED;
    }

    /** MIME 与扩展名是否**互相矛盾**（两者都表态且不同）。 */
    public static boolean isMimeExtensionConflict(String mime, String displayName) {
        Kind byMime = kindForMime(mime);
        Kind byExt = kindForExtension(displayName);
        return byMime != null && byMime != Kind.UNSUPPORTED && byExt != null && byMime != byExt;
    }

    // ---------------------------------------------------------------- 识别一个文件

    /** 文件项判定：冲突具名报错，不支持如实反馈，绝不当成已解析。 */
    public static Item classifyFile(String mime, String displayName, String uri) {
        if (isMimeExtensionConflict(mime, displayName)) {
            return new Item(Kind.UNSUPPORTED.name(), mime, displayName, uri, null, false,
                    ST_MIME_EXTENSION_CONFLICT);
        }
        Kind kind = kindOf(mime, displayName);
        if (kind == Kind.UNSUPPORTED) {
            return new Item(kind.name(), mime, displayName, uri, null, false, ST_UNSUPPORTED);
        }
        return new Item(kind.name(), mime, displayName, uri, null, true, ST_ACCEPTED_FILE);
    }

    // ---------------------------------------------------------------- 文本入口

    /** 直接输入的文本。 */
    public static Incoming fromText(String text, String source) {
        return textItem(text, source == null ? SOURCE_TEXT : source);
    }

    /** 粘贴的文本。 */
    public static Incoming fromPaste(String text) {
        return textItem(text, SOURCE_PASTE);
    }

    private static Incoming textItem(String text, String source) {
        List<Item> items = new ArrayList<Item>();
        String t = text == null ? "" : text;
        if (t.trim().isEmpty()) {
            items.add(new Item(Kind.TEXT.name(), MIME_TEXT_PLAIN, null, null, t, false,
                    ST_TEXT_EMPTY));
            return new Incoming(source, false, ST_TEXT_EMPTY, items);
        }
        if (t.length() > MAX_TEXT_CHARS) {
            // 超长**不截断**：截断会让下游以为拿到的是完整内容。
            items.add(new Item(Kind.TEXT.name(), MIME_TEXT_PLAIN, null, null, null, false,
                    ST_TEXT_TOO_LONG));
            return new Incoming(source, false, ST_TEXT_TOO_LONG, items);
        }
        items.add(new Item(Kind.TEXT.name(), MIME_TEXT_PLAIN, null, null, t, true,
                ST_ACCEPTED_TEXT));
        return new Incoming(source, true, ST_ACCEPTED_TEXT, items);
    }

    // ---------------------------------------------------------------- 意图解析（系统分享 / 打开）

    /**
     * 把外部意图解析成 {@link Incoming}。
     * 支持 {@code ACTION_SEND} / {@code ACTION_SEND_MULTIPLE} / {@code ACTION_VIEW}；
     * 其余意图一律 {@link Incoming#none()}（不当成有输入）。
     */
    public static Incoming parseIncoming(Context context, Intent intent) {
        if (intent == null) {
            return Incoming.none();
        }
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            List<Uri> uris = singleUri(intent);
            if (!uris.isEmpty()) {
                return fileIncoming(context, SOURCE_SHARE, intent.getType(), uris);
            }
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && !text.trim().isEmpty()) {
                return fromText(text, SOURCE_SHARE);
            }
            return errorIncoming(SOURCE_SHARE, ST_NO_URI);
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            List<Uri> uris = multipleUris(intent);
            if (uris.isEmpty()) {
                return errorIncoming(SOURCE_SHARE_MULTIPLE, ST_NO_URI);
            }
            return fileIncoming(context, SOURCE_SHARE_MULTIPLE, intent.getType(), uris);
        }
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            List<Uri> uris = new ArrayList<Uri>();
            uris.add(intent.getData());
            return fileIncoming(context, SOURCE_OPEN_WITH, intent.getType(), uris);
        }
        return Incoming.none();
    }

    private static Incoming errorIncoming(String source, String status) {
        return new Incoming(source, false, status, new ArrayList<Item>());
    }

    /** 从一个意图里取单条 URI（ClipData 优先，其次已废弃的 EXTRA_STREAM）。 */
    private static List<Uri> singleUri(Intent intent) {
        List<Uri> out = new ArrayList<Uri>();
        ClipData clip = intent.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri u = clip.getItemAt(0).getUri();
            if (u != null) {
                out.add(u);
                return out;
            }
        }
        Uri stream = streamExtra(intent);
        if (stream != null) {
            out.add(stream);
        }
        return out;
    }

    /** 从多条分享意图里取 URI 列表。 */
    private static List<Uri> multipleUris(Intent intent) {
        List<Uri> out = new ArrayList<Uri>();
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) {
                    out.add(u);
                }
            }
        }
        if (out.isEmpty()) {
            Uri stream = streamExtra(intent);
            if (stream != null) {
                out.add(stream);
            }
        }
        return out;
    }

    private static Uri streamExtra(Intent intent) {
        try {
            android.os.Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            return p instanceof Uri ? (Uri) p : null;
        } catch (Throwable e) {
            return null;
        }
    }

    /** 逐个判定 URI 列表；全部通过才算整体通过（部分不通过具名报出）。 */
    public static Incoming fileIncoming(Context context, String source, String mime,
                                        List<Uri> uris) {
        List<Item> items = new ArrayList<Item>();
        boolean anyRejected = false;
        for (Uri uri : uris) {
            if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) {
                // 拒绝 file:// 等直传磁盘路径的"文件"入口。
                items.add(new Item(Kind.UNSUPPORTED.name(), mime, null, uri == null ? null
                        : uri.toString(), null, false, ST_SCHEME_NOT_CONTENT));
                anyRejected = true;
                continue;
            }
            String name = displayNameOf(context, uri);
            Item item = classifyFile(mime, name, uri.toString());
            if (!item.accepted) {
                anyRejected = true;
            }
            items.add(item);
        }
        String status;
        boolean accepted;
        if (anyRejected) {
            status = items.size() > 1 ? ST_MULTIPLE_PARTIAL : firstRejectedStatus(items);
            accepted = false;
        } else if (items.size() > 1) {
            status = ST_ACCEPTED_MULTIPLE;
            accepted = true;
        } else {
            status = ST_ACCEPTED_FILE;
            accepted = true;
        }
        return new Incoming(source, accepted, status, items);
    }

    private static String firstRejectedStatus(List<Item> items) {
        for (Item item : items) {
            if (!item.accepted) {
                return item.status;
            }
        }
        return ST_UNSUPPORTED;
    }

    /** 查询系统显示名（拿不到回 null——不编一个文件名）。 */
    public static String displayNameOf(Context context, Uri uri) {
        if (context == null || uri == null) {
            return null;
        }
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && !cursor.isNull(idx)) {
                    return cursor.getString(idx);
                }
            }
        } catch (Throwable e) {
            return null;
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Throwable e) {
                    // 忽略
                }
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- 选择器入口

    /** 接受的 MIME 全集（给选择器过滤用）。 */
    public static String[] supportedMimeTypes() {
        return new String[] {
                MIME_DOCX, MIME_XLSX, MIME_PPTX, MIME_PDF,
                MIME_TEXT_PLAIN, MIME_TEXT_MARKDOWN, MIME_TEXT_CSV,
                "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
        };
    }

    /**
     * {@code ACTION_OPEN_DOCUMENT}：**可以**持久授权（用户选中的文档后续仍可读）。
     * 带 {@code FLAG_GRANT_PERSISTABLE_URI_PERMISSION}。
     */
    public static Intent buildOpenDocumentIntent(boolean allowMultiple) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(MIME_WILDCARD);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, supportedMimeTypes());
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        return intent;
    }

    /**
     * {@code ACTION_GET_CONTENT}：**只能**拿到本次临时授权，
     * 因此**刻意不**带 {@code FLAG_GRANT_PERSISTABLE_URI_PERMISSION}
     * ——带了会让人误以为之后还能读（失权后不得假装还能读）。
     */
    public static Intent buildGetContentIntent(boolean allowMultiple) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(MIME_WILDCARD);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, supportedMimeTypes());
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    // ---------------------------------------------------------------- 给页面看的结果

    /** 结构化回报（只含判定事实；长文本只带长度与预览，不带全文）。 */
    public static String describeJson(Incoming incoming) {
        if (incoming == null) {
            return "{\"source\":\"none\",\"accepted\":false,\"status\":\"input_none\",\"items\":[]}";
        }
        try {
            JSONObject o = new JSONObject();
            o.put("source", incoming.source);
            o.put("accepted", incoming.accepted);
            o.put("status", incoming.status);
            JSONArray arr = new JSONArray();
            for (Item item : incoming.items) {
                JSONObject j = new JSONObject();
                j.put("kind", item.kind);
                j.put("accepted", item.accepted);
                j.put("status", item.status);
                j.put("mime", item.mime == null ? JSONObject.NULL : item.mime);
                j.put("name", item.displayName == null ? JSONObject.NULL : item.displayName);
                j.put("uri", item.uri == null ? JSONObject.NULL : item.uri);
                if (item.text != null) {
                    j.put("textLength", item.text.length());
                    j.put("textPreview", item.text.length() > 200
                            ? item.text.substring(0, 200) : item.text);
                }
                arr.put(j);
            }
            o.put("items", arr);
            return o.toString();
        } catch (Throwable e) {
            return "{\"source\":\"none\",\"accepted\":false,\"status\":\"input_none\",\"items\":[]}";
        }
    }
}
