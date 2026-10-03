/**
 * **外部语料登记**（W-R01）。WORD.md 本线独立验收要求：语料须按来源分类，
 * **不得把全部 fixtures 称为独立 Office 语料**。本登记把仓内 DOCX 语料按
 * `hand-authored-ooxml / real-office / self-produced / external-real-document` 分类，
 * 并显式登记 `not-present` 的缺口（例如 WPS 产物、手机端保存产物），避免「不存在的语料」被
 * 默认当作已具备。
 *
 * 每条 `path` 非空的行由验收测试断言**在磁盘存在**；`not-present` 行的 `path` 为空，
 * 由 `note` 说明缺什么。分类判据来自 `tests/word-acceptance/fixtures/PROVENANCE.md`（只读）。
 */

import type { CorpusEntry } from './types.js';

/** 语料来源说明文件（只读）。 */
export const CORPUS_PROVENANCE_DOC = 'tests/word-acceptance/fixtures/PROVENANCE.md';

export const CORPUS_REGISTER: readonly CorpusEntry[] = [
  {
    id: 'corpus-a-independent-deflate',
    origin: 'hand-authored-ooxml',
    path: 'tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx',
    compression: 'DEFLATE',
    provenanceRef: CORPUS_PROVENANCE_DOC,
    note: 'WCF-D10 手工拼 OOXML；证明「按规范可解析」，不证明 Word 接受（Word 拒绝打开该文件，错误码 24601）。',
  },
  {
    id: 'corpus-b-independent-deflate',
    origin: 'hand-authored-ooxml',
    path: 'tests/word-acceptance/fixtures/corpus-b-independent-deflate.docx',
    compression: 'DEFLATE',
    provenanceRef: CORPUS_PROVENANCE_DOC,
    note: '手工拼 OOXML（公文风，独立内容）。',
  },
  {
    id: 'corpus-c-word16-created',
    origin: 'real-office',
    path: 'tests/word-acceptance/fixtures/corpus-c-word16-created.docx',
    compression: 'DEFLATE',
    provenanceRef: CORPUS_PROVENANCE_DOC,
    note: '本机真实 Microsoft Word 16.0.20430（COM 自动化）新建并保存；只支持「Word 16.0.20430 通过」这一条声明。',
  },
  {
    id: 'legacy-golden-potbot-store',
    origin: 'self-produced',
    path: 'tests/word-acceptance/fixtures/legacy-golden-potbot-store.docx',
    compression: 'STORE',
    provenanceRef: CORPUS_PROVENANCE_DOC,
    note: 'FREEZE-6 时期 potbot 生成器自产产物的逐字节副本（兼容回归）；摘要已钉死。',
  },
  {
    id: 'corpus-d-reference-elements',
    origin: 'hand-authored-ooxml',
    path: 'tests/word-acceptance/fixtures/corpus-d-reference-elements.docx',
    compression: 'unknown',
    provenanceRef: CORPUS_PROVENANCE_DOC,
    note: '手工 OOXML，覆盖引用类元素。',
  },
  {
    id: 'corpus-e-annotation-export',
    origin: 'hand-authored-ooxml',
    path: 'tests/word-acceptance/fixtures/corpus-e-annotation-export.docx',
    compression: 'unknown',
    provenanceRef: CORPUS_PROVENANCE_DOC,
    note: '手工 OOXML，覆盖批注/修订导出。',
  },
  {
    id: 'research-real-word16',
    origin: 'real-office',
    path: 'src/adapters/research/__fixtures__/real-word16.docx',
    compression: 'unknown',
    note: '研究用真实 Word 16 产物；具体授权/来源未在本文件复述，以所在目录说明为准。',
  },
  {
    id: 'source-roadshow-docx',
    origin: 'external-real-document',
    path: 'docs/source/项目介绍_路演策划版.docx',
    compression: 'unknown',
    note: '项目真实文档（只读素材区）。**来源工具（Word/WPS/其它）未登记**，不得据此宣称 Word 兼容已验。',
  },
  {
    id: 'missing-wps-saved',
    origin: 'not-present',
    path: '',
    note: '仓内无 WPS 保存的真实产物；「WPS 通过」目前无任何证据。',
  },
  {
    id: 'missing-phone-saved',
    origin: 'not-present',
    path: '',
    note: '仓内无手机端（荣耀真机）保存的 DOCX；真机层语料空白，手机闭环未验。',
  },
  {
    id: 'missing-word-other-version',
    origin: 'not-present',
    path: '',
    note: '仓内仅有 Word 16.0.20430 一份真实产物；无其它 Word 版本语料。',
  },
];
