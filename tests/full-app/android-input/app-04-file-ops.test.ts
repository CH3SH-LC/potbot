/**
 * APP-04（任务与文件：搜索 / 历史版本 / 重命名 / 打开 / 另存 / 分享 + URI 授权与失权）
 * —— **源码级结构断言**。
 *
 * 判据（都可机判，且每条关键判据都用**合成的坏源码**自证会变红）：
 *   ① 六个入口都在（搜索、历史版本、重命名、打开、另存、分享）；
 *   ② 空关键词**不**返回全部（返回全部等于没有搜索）；
 *   ③ 历史版本按版本号**倒序**；
 *   ④ 重命名校验非法字符、并**保留原扩展名**；
 *   ⑤ ★读权限以 {@code getPersistedUriPermissions()} 为准：没持久化就报
 *       {@link #ST_URI_PERMISSION_LOST}，**绝不假装还能读**；
 *   ⑥ 取消（RESULT_CANCELED）与"拿不到 URI"分开报；
 *   ⑦ 写回后**关闭再读回**，先比长度再比摘要，才可能报已保存；
 *   ⑧ 打开/分享的意图带临时读授权；另存走 ACTION_CREATE_DOCUMENT；
 *   ⑨ 失败文案都带**用户能照做**的下一步。
 *
 * ⚠️ **未验证（需真机）**：真实的持久授权/撤销授权行为、各家系统选择器返回的 URI
 * 形态，本包**没有设备**，未验证。
 */

import { describe, expect, it } from 'vitest';

import {
  FILE_OPS,
  STRINGS_XML,
  extractMethodBody,
  readText,
  resourceTexts,
  stripJavaComments,
} from './android-input-source.js';

const java = readText(FILE_OPS);
const code = stripJavaComments(java);
const strings = resourceTexts(readText(STRINGS_XML));

// ---------------------------------------------------------------------------
// 合成坏实现（判别力自证）
// ---------------------------------------------------------------------------

/** 空关键词就返回全部的天真搜索。 */
const NAIVE_SEARCH = `
public static List<Record> search(List<Record> all, String q) {
    List<Record> out = new ArrayList<Record>();
    for (Record r : all) { out.add(r); }
    return out;
}`;

/** 不看系统记录、一律宣称"还能读"的天真授权判定。 */
const NAIVE_ALWAYS_READABLE = `
public static Decision checkPersistedRead(Context c, Uri uri) {
    return Decision.ok(uri, ST_READBACK_OK);
}
public static boolean isPersistedRead(Context c, Uri uri) { return true; }`;

/** 先比摘要再比长度、且失败也报成功的天真读回。 */
const NAIVE_READBACK = `
public static Decision verifyReadBack(Context c, Uri t, byte[] written) {
    String a = sha256Hex(written);
    return Decision.ok(t, ST_READBACK_OK);
}`;

/** 什么名字都放行的天真重命名。 */
const NAIVE_RENAME = `
public static Decision rename(String currentName, String requested) {
    return Decision.ok(null, ST_RENAME_OK);
}`;

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

function searchRejectsBlankQuery(src: string): boolean {
  const body = extractMethodBody(stripJavaComments(src), 'public static List<Record> search(') ?? '';
  const flat = body.replace(/\s+/g, ' ');
  const blankIdx = flat.indexOf('isEmpty()');
  const loopIdx = flat.indexOf('for (');
  return blankIdx >= 0 && loopIdx > blankIdx && flat.includes('return out;');
}

function readIsGatedByPersistedPermission(src: string): boolean {
  const c = stripJavaComments(src);
  const gate = extractMethodBody(c, 'public static Decision checkPersistedRead(') ?? '';
  const probe = extractMethodBody(c, 'public static boolean isPersistedRead(') ?? '';
  return gate.includes('isPersistedRead(context, uri)')
      && gate.includes('ST_URI_PERMISSION_LOST')
      && probe.includes('getPersistedUriPermissions()')
      && probe.includes('isReadPermission()');
}

function readbackComparesLengthThenDigest(src: string): boolean {
  const body = extractMethodBody(stripJavaComments(src), 'public static Decision verifyReadBack(') ?? '';
  const iLen = body.indexOf('back.length != written.length');
  const iDig = body.indexOf('equalsIgnoreCase');
  const iOk = body.indexOf('ST_READBACK_OK');
  return iLen >= 0 && iDig > iLen && iOk > iDig && body.includes('ST_READBACK_MISMATCH');
}

function renameValidatesAndPreservesExtension(src: string): boolean {
  const c = stripJavaComments(src);
  const validate = extractMethodBody(c, 'public static Decision rename(') ?? '';
  const applied = extractMethodBody(c, 'public static String renamedName(') ?? '';
  const preserve = extractMethodBody(c, 'private static String appendPreservedExtension(') ?? '';
  return validate.includes('ST_RENAME_EMPTY') && validate.includes('ST_RENAME_INVALID')
      && validate.includes('containsIllegalNameChar')
      && applied.includes('appendPreservedExtension')
      && preserve.includes('PotbotInputGateway.extensionOf');
}

// ---------------------------------------------------------------------------

describe('判别力自证（合成坏源码必须被抓）', () => {
  it('空关键词返回全部的天真搜索 → 判据为假', () => {
    expect(searchRejectsBlankQuery(NAIVE_SEARCH)).toBe(false);
  });

  it('一律宣称"还能读"的天真判定 → 判据为假', () => {
    expect(readIsGatedByPersistedPermission(NAIVE_ALWAYS_READABLE)).toBe(false);
  });

  it('不比长度/摘要的天真读回 → 判据为假', () => {
    expect(readbackComparesLengthThenDigest(NAIVE_READBACK)).toBe(false);
  });

  it('什么名字都放行的天真重命名 → 判据为假', () => {
    expect(renameValidatesAndPreservesExtension(NAIVE_RENAME)).toBe(false);
  });
});

describe('六个入口都在（搜索 / 历史版本 / 重命名 / 打开 / 另存 / 分享）', () => {
  it('入口方法完备', () => {
    expect(code).toMatch(/public static List<Record> search\(/);
    expect(code).toMatch(/public static List<Record> history\(/);
    expect(code).toMatch(/public static String renamedName\(/);
    expect(code).toMatch(/public static Decision open\(/);
    expect(code).toMatch(/public static Intent buildOpenIntent\(/);
    expect(code).toMatch(/public static Intent buildShareIntent\(/);
    expect(code).toMatch(/public static Intent buildSaveAsIntent\(/);
  });
});

describe('搜索与历史版本', () => {
  it('空关键词不返回全部', () => {
    expect(searchRejectsBlankQuery(java)).toBe(true);
  });

  it('搜索匹配名字或编号，并按更新时间倒序', () => {
    const body = extractMethodBody(code, 'public static List<Record> search(') ?? '';
    expect(body).toContain('name.contains(q)');
    expect(body).toContain('id.contains(q)');
    expect(body).toContain('byUpdatedDesc()');
  });

  it('历史版本按版本号倒序（最新在前）', () => {
    const body = extractMethodBody(code, 'public static List<Record> history(') ?? '';
    expect(body.replace(/\s+/g, ' ')).toContain('Integer.compare(b.version, a.version)');
    expect(body).toContain('id.equals(r.id)');
  });

  it('搜不到 / 没有更早版本各有独立状态（不与成功混同）', () => {
    expect(java).toContain('ST_SEARCH_EMPTY = "file_search_empty"');
    expect(java).toContain('ST_HISTORY_EMPTY = "file_history_empty"');
  });
});

describe('重命名', () => {
  it('校验空名 / 非法字符，并保留原扩展名', () => {
    expect(renameValidatesAndPreservesExtension(java)).toBe(true);
  });

  it('非法字符清单覆盖路径分隔符与通配符', () => {
    const body = extractMethodBody(code, 'private static boolean containsIllegalNameChar(') ?? '';
    for (const ch of ["'/'", "'\\\\'", "':'", "'*'", "'?'", "'|'"]) {
      expect(body, `非法字符清单少了 ${ch}`).toContain(ch);
    }
  });
});

describe('URI 授权 / 失权（本工作包的核心纪律）', () => {
  it('★读权限以 getPersistedUriPermissions() 为准；没持久化就报"权限已失效"', () => {
    expect(readIsGatedByPersistedPermission(java)).toBe(true);
  });

  it('尽可能持久化读权限，失败如实回 false（GET_CONTENT 来的注定失败）', () => {
    const body = extractMethodBody(code, 'public static boolean takePersistableRead(') ?? '';
    expect(body).toContain('takePersistableUriPermission');
    expect(body).toContain('FLAG_GRANT_READ_URI_PERMISSION');
    expect(body.replace(/\s+/g, ' ')).toMatch(/catch \(Throwable e\) \{ return false;/);
  });

  it('提供撤销授权（releasePersistableUriPermission）', () => {
    const body = extractMethodBody(code, 'public static boolean releasePersistableRead(') ?? '';
    expect(body).toContain('releasePersistableUriPermission');
  });

  it('打开前先过权限门：读不到就报权限问题，不假装能打开', () => {
    const body = extractMethodBody(code, 'public static Decision open(') ?? '';
    expect(body).toContain('checkPersistedRead(context, uri)');
    expect(body).toContain('ST_OPEN_NO_APP');
  });

  it('取消与"拿不到 URI"分开报（取消不算失败，也不留残留状态）', () => {
    const body = extractMethodBody(code, 'public static Decision fromPickerResult(') ?? '';
    expect(body).toContain('RESULT_CANCELED');
    expect(body).toContain('ST_CANCELLED');
    expect(body).toContain('ST_URI_INVALID');
    expect(body).toContain('ST_URI_NOT_CONTENT');
  });

  it('只接受 content://（拒绝 file:// 直传磁盘路径）', () => {
    const body = extractMethodBody(code, 'private static byte[] readAll(') ?? '';
    expect(body).toContain('"content"');
    expect(body).toContain('ST_URI_NOT_CONTENT');
    expect(body).toContain('ST_URI_PERMISSION_LOST');
  });
});

describe('读回核对（写成功 ≠ 读得到对的内容）', () => {
  it('先比长度、再比摘要，之后才可能报已保存', () => {
    expect(readbackComparesLengthThenDigest(java)).toBe(true);
  });

  it('权限不足在读回路径上是独立状态', () => {
    const body = extractMethodBody(code, 'private static byte[] readAll(') ?? '';
    expect(body.replace(/\s+/g, ' ')).toMatch(/catch \(SecurityException e\) \{ throw new UriReadException\(ST_URI_PERMISSION_LOST\)/);
    expect(body.replace(/\s+/g, ' ')).toMatch(/catch \(FileNotFoundException e\) \{ throw new UriReadException\(ST_URI_PERMISSION_LOST\)/);
  });
});

describe('打开 / 另存 / 分享的意图构造', () => {
  it('打开：ACTION_VIEW + content:// + 临时读授权', () => {
    const body = extractMethodBody(code, 'public static Intent buildOpenIntent(') ?? '';
    expect(body).toContain('ACTION_VIEW');
    expect(body).toContain('setDataAndType');
    expect(body).toContain('FLAG_GRANT_READ_URI_PERMISSION');
  });

  it('分享：ACTION_SEND + EXTRA_STREAM + 临时读授权', () => {
    const body = extractMethodBody(code, 'public static Intent buildShareIntent(') ?? '';
    expect(body).toContain('ACTION_SEND');
    expect(body).toContain('EXTRA_STREAM');
    expect(body).toContain('FLAG_GRANT_READ_URI_PERMISSION');
  });

  it('另存：ACTION_CREATE_DOCUMENT + 可选默认名', () => {
    const body = extractMethodBody(code, 'public static Intent buildSaveAsIntent(') ?? '';
    expect(body).toContain('ACTION_CREATE_DOCUMENT');
    expect(body).toContain('CATEGORY_OPENABLE');
    expect(body).toContain('EXTRA_TITLE');
  });

  it('没有可接的应用时如实报"没有应用"（不静默什么都不发生）', () => {
    expect(code).toMatch(/public static boolean canResolve\(/);
    expect(java).toContain('ST_OPEN_NO_APP = "file_open_no_app"');
    expect(java).toContain('ST_SHARE_NO_APP = "file_share_no_app"');
  });
});

describe('失败文案都给出下一步（APP-07 同款判据）', () => {
  const failureStatuses = [
    'file_uri_permission_lost', 'file_uri_persist_not_granted', 'file_uri_not_content',
    'file_uri_invalid', 'file_readback_mismatch', 'file_readback_failed',
    'file_search_empty', 'file_history_empty', 'file_rename_empty', 'file_rename_invalid',
    'file_open_no_app', 'file_share_no_app', 'file_save_as_failed',
  ] as const;

  it('每个失败文案都含一个"照做"的动作词', () => {
    for (const status of failureStatuses) {
      const text = strings.get(`potbot_${status}`);
      expect(text, `strings.xml 缺少 potbot_${status}`).toBeDefined();
      expect(text ?? '', `potbot_${status} 没有给用户下一步`).toMatch(/请|试试|选择|重新|改用|点/);
    }
  });
});
