/**
 * S6 验收用例 ①：**独立 DOCX 读回器自身的自检**（T+15 门槛）。
 *
 * 这一组用例不碰被测实现——它证明的是"我的尺子本身准"。尺子不准，后面所有
 * "读回通过"都是空话。
 *
 * 关键纪律：**样本不是 potbot 生成器造的**。正确样本用 Python 标准库 `zipfile`
 * 手工拼出最小 OOXML 部件（与 `src/artifacts/ooxml/**` 无任何共享代码），
 * 因此它是一次真正独立的读回，而不是"同一个生成器自检自己"。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pythonExecutable, readbackDocx } from './support.js';

/**
 * 用 Python `zipfile` 手工拼一个**最小但合法**的 DOCX。
 * 独立于 potbot 的 ZIP/XML 写入器（本文件不 import 任何 `src/**`）。
 */
const FIXTURE_BUILDER = String.raw`
import sys, zipfile
path, mode = sys.argv[1], sys.argv[2]

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/></Relationships>'
)
DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:body>'
    '<w:p><w:r><w:t>独立标题</w:t></w:r></w:p>'
    '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>'
    '<w:p><w:r><w:t>第二段</w:t></w:r></w:p>'
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
    '</w:body></w:document>'
)

CUSTOM_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
CUSTOM_MIME = 'application/vnd.openxmlformats-officedocument.custom-properties+xml'
CUSTOM_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties'
CUSTOM = None
if mode.startswith('presentation_') or mode == 'legacy_custom':
    marker_name = 'UnrelatedProperty' if mode == 'legacy_custom' else 'PotbotDocumentPresentation'
    property_xml = (
        '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="' + marker_name + '">'
        '<vt:lpwstr>title-body-v1</vt:lpwstr></property>'
    )
    if mode == 'presentation_duplicate_marker':
        property_xml += property_xml.replace('pid="2"', 'pid="3"')
    if mode == 'presentation_wrong_property_namespace':
        property_xml = property_xml.replace('<property ', '<property xmlns="urn:wrong" ')
    CUSTOM = (
        '<Properties xmlns="' + CUSTOM_NS + '" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        + property_xml + '</Properties>'
    )
    if mode in ('presentation_wrong_root_namespace', 'legacy_custom'):
        CUSTOM = CUSTOM.replace('<Properties xmlns="' + CUSTOM_NS + '"', '<Properties xmlns="urn:wrong"')
    if mode == 'presentation_wrong_root_name':
        CUSTOM = CUSTOM.replace('Properties', 'WrongRoot')
    custom_override = '<Override PartName="/docProps/custom.xml" ContentType="' + CUSTOM_MIME + '"/>'
    if mode == 'presentation_wrong_mime':
        custom_override = custom_override.replace(CUSTOM_MIME, 'application/xml')
    if mode == 'presentation_duplicate_mime':
        custom_override += custom_override
    if mode not in ('presentation_missing_mime', 'legacy_custom'):
        CONTENT_TYPES = CONTENT_TYPES.replace('</Types>', custom_override + '</Types>')
    target = '/docProps/custom.xml' if mode == 'presentation_absolute_internal' else 'docProps/custom.xml'
    custom_rel = '<Relationship Id="rId2" Type="' + CUSTOM_REL_TYPE + '" Target="' + target + '"/>'
    if mode == 'presentation_absolute_internal':
        custom_rel = custom_rel.replace('/>', ' TargetMode="Internal"/>')
    if mode == 'presentation_external_relation':
        custom_rel = custom_rel.replace('/>', ' TargetMode="External"/>')
    if mode == 'presentation_wrong_relation_target':
        custom_rel = custom_rel.replace('docProps/custom.xml', 'docProps/other.xml')
    if mode == 'presentation_wrong_relation_type':
        custom_rel = custom_rel.replace(CUSTOM_REL_TYPE, CUSTOM_REL_TYPE + '-wrong')
    if mode == 'presentation_duplicate_relation':
        custom_rel += custom_rel.replace('rId2', 'rId3')
    if mode not in ('presentation_missing_relation', 'legacy_custom'):
        RELS = RELS.replace('</Relationships>', custom_rel + '</Relationships>')
    if mode == 'presentation_wrong_relation_namespace':
        RELS = RELS.replace('http://schemas.openxmlformats.org/package/2006/relationships', 'urn:wrong')

with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as zf:
    zf.writestr('[Content_Types].xml', CONTENT_TYPES)
    if mode != 'presentation_missing_package_rels':
        zf.writestr('_rels/.rels', RELS)
    if mode != 'no_main_part':
        zf.writestr('word/document.xml', DOCUMENT)
    if CUSTOM is not None:
        zf.writestr('docProps/custom.xml', CUSTOM)

if mode == 'corrupt':
    data = bytearray(open(path, 'rb').read())
    i = len(data) // 2
    data[i] = data[i] ^ 0xFF
    open(path, 'wb').write(bytes(data))
`;

let dir: string;
let valid: string;
let corrupt: string;
let noMainPart: string;
let notZip: string;
const presentationFailures = [
  ['wrong_root_namespace', 'invalid_presentation_properties'],
  ['wrong_root_name', 'invalid_presentation_properties'],
  ['wrong_property_namespace', 'invalid_presentation_properties'],
  ['duplicate_marker', 'duplicate_presentation'],
  ['missing_mime', 'invalid_presentation_content_type'],
  ['wrong_mime', 'invalid_presentation_content_type'],
  ['duplicate_mime', 'invalid_presentation_content_type'],
  ['missing_package_rels', 'invalid_presentation_relationship'],
  ['missing_relation', 'invalid_presentation_relationship'],
  ['wrong_relation_type', 'invalid_presentation_relationship'],
  ['wrong_relation_target', 'invalid_presentation_relationship'],
  ['external_relation', 'invalid_presentation_relationship'],
  ['duplicate_relation', 'invalid_presentation_relationship'],
  ['wrong_relation_namespace', 'invalid_presentation_relationship'],
] as const;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 's6-readback-'));
  valid = join(dir, 'valid.docx');
  corrupt = join(dir, 'corrupt.docx');
  noMainPart = join(dir, 'no-main.docx');
  notZip = join(dir, 'not-a-zip.docx');

  const build = (target: string, mode: string): void => {
    execFileSync(pythonExecutable(), ['-c', FIXTURE_BUILDER, target, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
  };
  build(valid, 'valid');
  build(corrupt, 'corrupt');
  build(noMainPart, 'no_main_part');
  for (const mode of ['valid', 'absolute_internal', ...presentationFailures.map(([mode]) => mode)]) {
    build(join(dir, `presentation_${mode}.docx`), `presentation_${mode}`);
  }
  build(join(dir, 'legacy-custom.docx'), 'legacy_custom');
  writeFileSync(notZip, 'plain text, definitely not a zip');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('独立 DOCX 读回器 verify-docx.py（自检）', () => {
  it('正确样本：读回成功，抽出标题与段落，退出码 0', () => {
    const result = readbackDocx(valid);
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.ok).toBe(true);
    expect(result.parsed?.error).toBeNull();
    expect(result.parsed?.document?.title).toBe('独立标题');
    expect(result.parsed?.document?.body).toEqual(['第一段', '第二段']);
    expect(result.parsed?.document?.presentation).toBeNull();
  });

  it.each(['valid', 'absolute_internal'])('新版独立样本 %s：有效属性结构可读回呈现版本', (mode) => {
    const result = readbackDocx(join(dir, `presentation_${mode}.docx`));
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.ok).toBe(true);
    expect(result.parsed?.document?.presentation).toBe('title-body-v1');
    expect(result.parsed?.document?.body).toEqual(['第一段', '第二段']);
    // `checks` 在支持层的类型里是可选字段；读回器实际总会输出它。这里就地窄化，
    // 不放松断言：真缺了 checks 会得到空数组，下面三条照样过不了。
    const checks = result.parsed?.checks ?? [];
    expect(checks.filter((check) => check.name.startsWith('presentation_')))
      .toEqual([
        { name: 'presentation_properties', passed: true, detail: 'docProps/custom.xml' },
        { name: 'presentation_content_type', passed: true, detail: 'docProps/custom.xml' },
        { name: 'presentation_relationship', passed: true, detail: 'docProps/custom.xml' },
      ]);
  });

  it.each(presentationFailures)('新版损坏结构 %s：拒绝认证版本，不暴露正文', (mode, errorCode) => {
    const result = readbackDocx(join(dir, `presentation_${mode}.docx`));
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed?.ok).toBe(false);
    expect(result.parsed?.error?.code).toBe(errorCode);
    expect(result.parsed?.document).toBeNull();
    const checks = result.parsed?.checks ?? [];
    expect(checks.some((check) => !check.passed)).toBe(true);
  });

  it('旧版含无关自定义属性：保留原验收边界，不按新版结构拒绝', () => {
    const result = readbackDocx(join(dir, 'legacy-custom.docx'));
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.ok).toBe(true);
    expect(result.parsed?.document?.presentation).toBeNull();
    const checks = result.parsed?.checks ?? [];
    expect(checks.some((check) => check.name.startsWith('presentation_'))).toBe(false);
  });

  it('损坏样本（翻转一字节）：必须报错，退出码非 0，且不得给出正文', () => {
    const result = readbackDocx(corrupt);
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed?.ok).toBe(false);
    expect(result.parsed?.error?.code).toBe('corrupt_entry');
    expect(result.parsed?.document).toBeNull();
  });

  it('合法 ZIP 但缺主部件：报 missing_main_part', () => {
    const result = readbackDocx(noMainPart);
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed?.error?.code).toBe('missing_main_part');
  });

  it('根本不是 ZIP：报 not_a_zip', () => {
    const result = readbackDocx(notZip);
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed?.error?.code).toBe('not_a_zip');
  });

  it('路径不存在：报 file_missing', () => {
    const result = readbackDocx(join(dir, 'nope.docx'));
    expect(result.exitCode).not.toBe(0);
    expect(result.parsed?.error?.code).toBe('file_missing');
  });
});
