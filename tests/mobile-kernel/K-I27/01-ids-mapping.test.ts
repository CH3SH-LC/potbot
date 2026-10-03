/**
 * K-I27 独立验证：**目录 id ⇄ 契约 fixture id** 的唯一收敛点（`templates/ids.ts`）。
 *
 * 判据分三层：
 *
 * 1. **目录层**：`CATALOG_TEMPLATE_IDS` 必须与 `catalog.ts` 真实发射的 `TEMPLATE_MANIFEST_IDS`
 *    恰好相等——目录漂移（新增/改名/删模板）而映射没跟上，本测试红。
 * 2. **契约层（真实文件，非自证）**：从磁盘读 `contracts/mobile-v1/fixtures/success/` 里的
 *    **真实 fixture**，断言两条有 fixture 背书的映射（`document→word-doc`、`meituan→meituan-order`）
 *    与 fixture 内的 `id` 逐字相同，且 `command-create.json` 的 `payload.templateId` 能反向查到目录 id。
 * 3. **逆向对照**：未知 id 双向都必须**抛错**（不得返回 undefined 静默降级）；构造期守卫对
 *    篡改过的表（契约 id 撞车 / 缺行 / 多余行）必须抛对应拒因——证明守卫不是空壳。
 *
 * 明确不做的事：不改 `contracts/**`（只读按 JSON 解析）；不 import 其他 `apps/mobile-kernel/*`
 * 兄弟包的实现，只消费本单元产出的 barrel。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CATALOG_TEMPLATE_IDS,
  CATALOG_TO_CONTRACT_TEMPLATE_ID,
  CONTRACT_TEMPLATE_IDS,
  CONTRACT_TO_CATALOG_TEMPLATE_ID,
  TEMPLATE_ID_PROVENANCE,
  TEMPLATE_ID_TABLE,
  TEMPLATE_MANIFEST_IDS,
  TemplateIdMappingError,
  assertTemplateIdMapping,
  isCatalogTemplateId,
  isContractTemplateId,
  isTemplateIdMappingError,
  templateIdRow,
  toCatalogTemplateId,
  toContractTemplateId,
  type TemplateIdRow,
} from '../../../apps/mobile-kernel/templates/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURES = 'contracts/mobile-v1/fixtures/success';

function readEnvelope(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as Record<string, unknown>;
}

/** 契约 id 的形状约束（照 `template-manifest.schema.json` 的 `$defs.id`：string, 1..128）。 */
function assertContractIdShape(id: string, label: string): void {
  expect(typeof id, label).toBe('string');
  expect(id.length, label).toBeGreaterThanOrEqual(1);
  expect(id.length, label).toBeLessThanOrEqual(128);
  expect(id, label).toMatch(/^[a-z0-9-]+$/); // 小写 + 数字 + 连字符（两套真实 id 都满足）
}

// ---------------------------------------------------------------------------
// A. 目录层：与真实目录恰好相等，不漂移
// ---------------------------------------------------------------------------

describe('K-I27 A · 目录覆盖：与 catalog.ts 发射的 id 不漂移', () => {
  it('恰好 7 条，且目录 id 集合 == TEMPLATE_MANIFEST_IDS', () => {
    expect(TEMPLATE_ID_TABLE).toHaveLength(7);
    expect(CATALOG_TEMPLATE_IDS).toHaveLength(7);
    expect(CONTRACT_TEMPLATE_IDS).toHaveLength(7);
    expect([...CATALOG_TEMPLATE_IDS].sort()).toEqual([...TEMPLATE_MANIFEST_IDS].sort());
  });

  it('真实表通过构造期守卫（正对照：守卫不是"恒抛"）', () => {
    expect(() => assertTemplateIdMapping()).not.toThrow();
    expect(() => assertTemplateIdMapping(TEMPLATE_ID_TABLE, TEMPLATE_MANIFEST_IDS)).not.toThrow();
  });

  it('每个目录 id 都可换算成契约 id；查得到对应的映射行', () => {
    for (const catalogId of CATALOG_TEMPLATE_IDS) {
      const contractId = toContractTemplateId(catalogId);
      assertContractIdShape(contractId, `contract id for ${catalogId}`);
      expect(templateIdRow(catalogId).catalogId).toBe(catalogId);
      expect(templateIdRow(catalogId).contractId).toBe(contractId);
    }
  });

  it('目录 id 词表由映射表导出：CATALOG_TEMPLATE_IDS == table.map(catalogId)', () => {
    expect([...CATALOG_TEMPLATE_IDS]).toEqual(TEMPLATE_ID_TABLE.map((row) => row.catalogId));
    expect([...CONTRACT_TEMPLATE_IDS]).toEqual(TEMPLATE_ID_TABLE.map((row) => row.contractId));
  });
});

// ---------------------------------------------------------------------------
// B. 双向一一对应
// ---------------------------------------------------------------------------

describe('K-I27 B · 双向映射：满射、单射、可往返', () => {
  it('契约 id 无重复（单射 ⇒ 反向查表无歧义）', () => {
    expect(new Set(CONTRACT_TEMPLATE_IDS).size).toBe(CONTRACT_TEMPLATE_IDS.length);
  });

  it('目录→契约→目录 往返恒等', () => {
    for (const catalogId of CATALOG_TEMPLATE_IDS) {
      expect(toCatalogTemplateId(toContractTemplateId(catalogId))).toBe(catalogId);
    }
  });

  it('契约→目录→契约 往返恒等', () => {
    for (const contractId of CONTRACT_TEMPLATE_IDS) {
      expect(toContractTemplateId(toCatalogTemplateId(contractId))).toBe(contractId);
    }
  });

  it('导出的两张查表 Record 与映射表逐行一致', () => {
    for (const row of TEMPLATE_ID_TABLE) {
      expect(CATALOG_TO_CONTRACT_TEMPLATE_ID[row.catalogId]).toBe(row.contractId);
      expect(CONTRACT_TO_CATALOG_TEMPLATE_ID[row.contractId]).toBe(row.catalogId);
      expect(TEMPLATE_ID_PROVENANCE[row.catalogId]).toBe(row.provenance);
    }
  });
});

// ---------------------------------------------------------------------------
// C. 契约层：真实 fixture 文件锚定（读磁盘，不自证）
// ---------------------------------------------------------------------------

describe('K-I27 C · 契约 fixture 锚定：读真实文件逐字对账', () => {
  it('两条 fixture 背书行与真实 fixture 的 id 逐字相同', () => {
    const wordValue = readEnvelope(`${FIXTURES}/template-manifest-word.json`)['value'] as Record<
      string,
      unknown
    >;
    const meituanValue = readEnvelope(`${FIXTURES}/template-manifest-meituan.json`)['value'] as Record<
      string,
      unknown
    >;

    expect(wordValue['id']).toBe('word-doc');
    expect(meituanValue['id']).toBe('meituan-order');

    expect(toContractTemplateId('document')).toBe(wordValue['id']);
    expect(toContractTemplateId('meituan')).toBe(meituanValue['id']);
  });

  it('command-create.json 的 payload.templateId 能反向查到目录 id', () => {
    const commandValue = readEnvelope(`${FIXTURES}/command-create.json`)['value'] as Record<
      string,
      unknown
    >;
    const payload = commandValue['payload'] as Record<string, unknown>;
    const templateId = payload['templateId'];
    expect(templateId).toBe('word-doc');
    expect(typeof templateId).toBe('string');
    expect(toCatalogTemplateId(templateId as string)).toBe('document');
  });

  it('每条 fixture 背书行的 fixtureRef 指向真实存在、且 id 相符的文件', () => {
    const fixtureRows = TEMPLATE_ID_TABLE.filter((row) => row.provenance === 'fixture');
    expect(fixtureRows).toHaveLength(2);
    for (const row of fixtureRows) {
      expect(row.fixtureRef, `${row.catalogId}.fixtureRef`).not.toBeNull();
      const value = readEnvelope(row.fixtureRef as string)['value'] as Record<string, unknown>;
      expect(value['id'], `${row.catalogId} fixture id`).toBe(row.contractId);
    }
  });
});

// ---------------------------------------------------------------------------
// D. 逆向对照：未知 id 双向抛错，不静默降级
// ---------------------------------------------------------------------------

describe('K-I27 D · 未知 id 双向抛错（反向对照）', () => {
  it('未知目录 id → unknown_catalog_template_id（含 id 与已知集合）', () => {
    for (const bad of ['ghost', '', 'document ', 'WORD', 'word-doc']) {
      let caught: unknown;
      try {
        toContractTemplateId(bad);
      } catch (error) {
        caught = error;
      }
      expect(isTemplateIdMappingError(caught), `期望 ${JSON.stringify(bad)} 抛 TemplateIdMappingError`).toBe(
        true,
      );
      const err = caught as TemplateIdMappingError;
      expect(err.code).toBe('unknown_catalog_template_id');
      expect(err.message).toContain(bad === '' ? '未知' : bad);
    }
  });

  it('未知契约 id → unknown_contract_template_id（含 id）', () => {
    for (const bad of ['document', 'WORD-DOC', 'meituan_order', 'ghost']) {
      let caught: unknown;
      try {
        toCatalogTemplateId(bad);
      } catch (error) {
        caught = error;
      }
      expect(isTemplateIdMappingError(caught), `期望 ${JSON.stringify(bad)} 抛 TemplateIdMappingError`).toBe(
        true,
      );
      const err = caught as TemplateIdMappingError;
      expect(err.code).toBe('unknown_contract_template_id');
      expect(err.message).toContain(bad);
    }
  });

  it('类型守卫：只对未知 id 返回 false，对规范 id 返回 true', () => {
    for (const catalogId of CATALOG_TEMPLATE_IDS) {
      expect(isCatalogTemplateId(catalogId)).toBe(true);
      expect(isContractTemplateId(catalogId)).toBe(false);
    }
    for (const contractId of CONTRACT_TEMPLATE_IDS) {
      expect(isContractTemplateId(contractId)).toBe(true);
    }
    expect(isCatalogTemplateId('word-doc')).toBe(false);
    expect(isContractTemplateId('document')).toBe(false);
    expect(isCatalogTemplateId('')).toBe(false);
  });

  it('isTemplateIdMappingError：认自己的错误，不认普通 Error / null', () => {
    expect(isTemplateIdMappingError(new Error('x'))).toBe(false);
    expect(isTemplateIdMappingError(null)).toBe(false);
    let caught: unknown;
    try {
      toContractTemplateId('ghost');
    } catch (error) {
      caught = error;
    }
    expect(isTemplateIdMappingError(caught)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E. 构造期守卫对篡改表必须抛错（证明守卫是活的）
// ---------------------------------------------------------------------------

describe('K-I27 E · 构造期守卫：篡改表必须被拒', () => {
  it('契约 id 撞车 ⇒ mapping_not_bijective', () => {
    const dup: TemplateIdRow[] = [
      ...TEMPLATE_ID_TABLE.map((row) => ({ ...row })),
      {
        catalogId: 'ghost-catalog',
        contractId: TEMPLATE_ID_TABLE[0]!.contractId, // 与首行契约 id 相同
        provenance: 'proposed',
        fixtureRef: null,
        note: 'tampered duplicate',
      },
    ];
    expect(() => assertTemplateIdMapping(dup, TEMPLATE_MANIFEST_IDS)).toThrowError(
      /mapping_not_bijective/,
    );
  });

  it('目录缺一行 ⇒ mapping_incomplete（点名缺了谁）', () => {
    const dropped = TEMPLATE_ID_TABLE.filter((row) => row.catalogId !== 'research').map((row) => ({
      ...row,
    }));
    expect(() => assertTemplateIdMapping(dropped, TEMPLATE_MANIFEST_IDS)).toThrowError(/research/);
    let caught: unknown;
    try {
      assertTemplateIdMapping(dropped, TEMPLATE_MANIFEST_IDS);
    } catch (error) {
      caught = error;
    }
    expect(isTemplateIdMappingError(caught)).toBe(true);
    expect((caught as TemplateIdMappingError).code).toBe('mapping_incomplete');
  });

  it('目录多一行（表里没有的规范 id 被发射）⇒ mapping_incomplete', () => {
    expect(() =>
      assertTemplateIdMapping(TEMPLATE_ID_TABLE, [...TEMPLATE_MANIFEST_IDS, 'eighth-template']),
    ).toThrowError(/eighth-template/);
  });

  it('表里多出一条目录 id（目录里没有）⇒ mapping_incomplete', () => {
    const extra: TemplateIdRow[] = [
      ...TEMPLATE_ID_TABLE.map((row) => ({ ...row })),
      {
        catalogId: 'ghost-catalog',
        contractId: 'ghost-contract',
        provenance: 'proposed',
        fixtureRef: null,
        note: 'tampered extra',
      },
    ];
    expect(() => assertTemplateIdMapping(extra, TEMPLATE_MANIFEST_IDS)).toThrowError(/ghost-catalog/);
  });
});

// ---------------------------------------------------------------------------
// F. 诚实口径：fixture 背书 vs 待冻结建议，不得混同
// ---------------------------------------------------------------------------

describe('K-I27 F · 诚实口径：只有 2 条有 fixture 背书', () => {
  it('恰好 2 条 fixture、5 条 proposed；proposed 的 fixtureRef 必须为 null', () => {
    const fixtureRows = TEMPLATE_ID_TABLE.filter((row) => row.provenance === 'fixture');
    const proposedRows = TEMPLATE_ID_TABLE.filter((row) => row.provenance === 'proposed');
    expect(fixtureRows.map((row) => row.catalogId).sort()).toEqual(['document', 'meituan']);
    expect(proposedRows).toHaveLength(5);
    for (const row of proposedRows) {
      expect(row.fixtureRef, `${row.catalogId} 是建议，不得挂 fixture`);
      if (row.fixtureRef !== null) {
        throw new Error(`proposed 行 ${row.catalogId} 不应有 fixtureRef`);
      }
    }
  });

  it('每条 fixture 背书行都带非空 fixtureRef（不得无凭据自称已背书）', () => {
    for (const row of TEMPLATE_ID_TABLE) {
      if (row.provenance === 'fixture') {
        expect(row.fixtureRef, `${row.catalogId}`).toBeTruthy();
      } else {
        expect(row.fixtureRef, `${row.catalogId}`).toBeNull();
      }
    }
  });
});
