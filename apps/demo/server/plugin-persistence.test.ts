/**
 * FA-PLG-PERSIST-PORT 的**真实文件**测试：真临时目录、真写盘、真读回。
 *
 * 不 mock `node:fs`——每个用例都在 `os.tmpdir()` 下的临时目录里落一个真文件，
 * 断言的是**磁盘上的字节**与**新实例读回的状态**，不是内存里函数的返回值。
 *
 * 每条判据都有反向对照：
 *
 * | 判据 | 正例 | 反向对照 |
 * |---|---|---|
 * | 状态真实往返 | 安装→启用→停用→卸载各态读回逐项一致 | 未 `reload()` 的新实例**查不到**任何记录 |
 * | 版本冻结绑定 | 绑定读回逐项一致 | 绑定形状非法 ⇒ `invalid_binding` 拒收 |
 * | 损坏文件拒载 | 文件不存在 ⇒ `undefined`（合法空） | **损坏 / 空 / 截断 / 形状非法 ⇒ 抛具名错误，不当作空** |
 * | 凭据不落盘 | 非敏感字段原样保留 | **原始文件文本里搜不到密钥值，也搜不到敏感键名；被剔除字段逐条记名** |
 * | 并发写不互相覆盖 | 接力写（A 写→B 读→B 写）不误报 | **B 拿着过期读取写 ⇒ `write_conflict`，A 的数据仍在** |
 * | 原子写 | 一次 `save()` 后目录里无 `.tmp-*` 残留 | 目录不存在 ⇒ 自动创建（而非写失败） |
 *
 * ## 未验证项（如实标注）
 *
 * 冲突检测在**本进程内两个实例**之间验证；**未做真实跨进程**（两个 OS 进程同时打开同一文件）
 * 的验证，也未注入崩溃来实测"写到一半断电"的恢复——原子性由"写临时文件 + 同目录 rename"
 * 保证，测试只覆盖"无残留 / 完整替换"这两个可观察面。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileInstallStateStore,
  PLUGIN_PERSISTENCE_SCHEMA,
  PluginPersistenceError,
  createFileInstallStateStore,
  listStaleTempFiles,
  redactSecrets,
} from './plugin-persistence.js';
import {
  createInstallSourceManager,
  type DiscoveryProbes,
  type PluginBinding,
} from '../../../src/plugins/index.js';
import { asCapabilityId, asLogicalTime, type LogicalTime } from '../../../src/protocol/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BASE_MS = Date.UTC(2026, 9, 3, 8, 0, 0);
const at = (offsetSeconds: number): LogicalTime => asLogicalTime(BASE_MS + offsetSeconds * 1000);

/**
 * **仅测试注入**的探针：内置构建器就绪 + 实测支持为真。
 * 产品路径不注入它；这里只用来让"五态全真"可观察，从而能签出版本冻结绑定。
 * 它**不代表**任何能力已被真机实测。
 */
const READY_PROBES: DiscoveryProbes = {
  dependencies: {
    isAdapterReady: (adapterId) =>
      ['builtin.docx_builder', 'builtin.xlsx_builder', 'builtin.pptx_builder'].includes(adapterId),
  },
  support: { isActuallySupported: () => true },
};

/** 跑一次并返回具名失败码（成功返回 `null`）。 */
function failureCodeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof PluginPersistenceError ? error.code : `unexpected:${String(error)}`;
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'potbot-plg-persist-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. 真实往返
// ---------------------------------------------------------------------------

describe('状态真实往返（落盘 → 新实例读回）', () => {
  it('安装→启用→停用→卸载各态落盘后，新实例 reload() 读回逐项一致', () => {
    const store1 = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const first = createInstallSourceManager({ store: store1 });

    expect(first.install('template.document', at(1)).ok).toBe(true);
    first.enable('template.document', at(2));

    expect(first.install('template.spreadsheet', at(3)).ok).toBe(true);
    first.enable('template.spreadsheet', at(4));
    first.disable('template.spreadsheet', at(5)); // 停用态

    expect(first.install('template.presentation', at(6)).ok).toBe(true);
    first.uninstall('template.presentation', at(7)); // 卸载态（保留记录）

    // 版本冻结绑定（R230）：注册表快照装不下它，必须与本端口一起落盘
    const binding: PluginBinding = first.pluginRegistry.pin('template.document', at(8), READY_PROBES);
    store1.saveBindings([binding]);

    first.persist();

    // 真文件落在磁盘上，且是合法的本端口格式
    expect(existsSync(store1.filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(store1.filePath, 'utf8')) as { schema: string };
    expect(onDisk.schema).toBe(PLUGIN_PERSISTENCE_SCHEMA);

    // 新实例：读回前看不到任何记录（反例：不是"默认就有"）
    const store2 = createFileInstallStateStore({ dir, writerId: 'B', now: () => at(9) });
    const second = createInstallSourceManager({ store: store2 });
    expect(second.pluginRegistry.recordOf('template.document')).toBeUndefined();

    expect(second.reload()).toBe(true);

    // 逐项一致（含 install_source / 时间戳 / 各布尔态）
    for (const id of ['template.document', 'template.spreadsheet', 'template.presentation']) {
      expect(second.pluginRegistry.recordOf(id)).toEqual(first.pluginRegistry.recordOf(id));
    }
    expect(second.pluginRegistry.listRecords()).toEqual(first.pluginRegistry.listRecords());

    // 各态确实被区分开了（不是都落成同一个值）
    expect(second.pluginRegistry.recordOf('template.document')?.enabled).toBe(true);
    expect(second.pluginRegistry.recordOf('template.spreadsheet')?.enabled).toBe(false);
    expect(second.pluginRegistry.recordOf('template.presentation')?.installed).toBe(false);

    // 版本冻结绑定也读回逐项一致
    const reloaded = store2.loadAll();
    expect(reloaded?.bindings).toEqual([binding]);
    expect(reloaded?.bindings[0]).toEqual(binding);
  });

  it('未 reload() 的新实例不编造任何记录（反例）', () => {
    const store1 = createFileInstallStateStore({ dir, writerId: 'A' });
    const first = createInstallSourceManager({ store: store1 });
    first.install('template.document', at(1));
    first.persist();

    const store2 = createFileInstallStateStore({ dir, writerId: 'B' });
    const second = createInstallSourceManager({ store: store2 });
    expect(second.pluginRegistry.listRecords()).toHaveLength(0);
  });

  it('非法绑定形状被拒收（invalid_binding）', () => {
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    const bad = { plugin_id: 'template.document', version: '0.9.0', capability_ids: 'not-an-array', pinned_at: 1 };
    expect(failureCodeOf(() => store.saveBindings([bad as unknown as PluginBinding]))).toBe('invalid_binding');
  });
});

// ---------------------------------------------------------------------------
// 1b. 暂存值随下次 save() 落盘（**文件已存在时同样成立**）
// ---------------------------------------------------------------------------

/**
 * `recordBinding()` / `saveBindings()` / `setPackageDeclarations()` 的文档契约是
 * **"暂存，随下次 `save()` 落盘"**。缺陷：`save()` 先 `readState()`，而 `readState()` 在
 * 目标文件**已存在**时把刚暂存的值用磁盘旧值覆盖回去 ⇒ 第二次及之后的写入上暂存值被
 * **静默丢弃**（文件尚不存在时不触发，所以上面第 1 节的原有用例照不到）。
 *
 * 下面的用例断言的是**磁盘上的字节**（经**新实例**读回），不是内存 getter——
 * 内存 getter 在缺陷下也会"看起来对"，只有落盘/读回才是真判据。
 */
describe('暂存值随下次 save() 落盘（文件已存在时也成立）', () => {
  const bindingAt = (pinnedAt: LogicalTime, version = '0.9.0'): PluginBinding => ({
    plugin_id: 'template.document',
    version,
    capability_ids: Object.freeze([asCapabilityId('doc.write')]),
    pinned_at: pinnedAt,
  });

  it('复现：第一次 save（文件不存在）后 recordBinding()，第二次 save() 必须落盘（改前红）', () => {
    const store = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));

    // 第一次写入时文件尚不存在：这条链修复前也能落盘（所以原用例照不到缺陷）。
    const first = bindingAt(at(2));
    store.saveBindings([first]);
    manager.persist();
    expect(store.loadAll()?.bindings).toEqual([first]);

    // 文件已存在：契约要求"暂存绑定 ⇒ 随下次 save() 落盘"。
    // 修复前 readState() 会用磁盘上的 [first] 覆盖暂存的 [second]，此处读到 [first]。
    const second = bindingAt(at(9));
    store.recordBinding(second);
    manager.persist();

    // 判据是**磁盘上的字节**（新实例读回），不是本实例的内存 getter。
    const disk = createFileInstallStateStore({ dir, writerId: 'C' }).loadAll();
    expect(disk?.bindings).toEqual([second]);
    expect(disk?.bindings[0]?.pinned_at).toBe(at(9));
    expect(store.pendingBindings).toEqual([second]);
  });

  it('复现（同源缺陷）：暂存的包声明在文件已存在时也必须随下次 save() 落盘', () => {
    const store = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));

    store.setPackageDeclarations({ 'template.document': { display_name: '第一版' } });
    manager.persist();
    expect(store.loadAll()?.package_declarations).toEqual({ 'template.document': { display_name: '第一版' } });

    store.setPackageDeclarations({ 'template.document': { display_name: '第二版' } });
    manager.persist();

    const disk = createFileInstallStateStore({ dir, writerId: 'C' }).loadAll();
    expect(disk?.package_declarations).toEqual({ 'template.document': { display_name: '第二版' } });
  });

  it('反向对照：本实例未暂存任何值时，save() 保持磁盘上的既有绑定不变（既有行为不得改坏）', () => {
    // A 写下第 1 代（含一个冻结绑定）
    const storeA = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const managerA = createInstallSourceManager({ store: storeA });
    managerA.install('template.document', at(1));
    const pinned = bindingAt(at(2));
    storeA.saveBindings([pinned]);
    managerA.persist();

    // B 只读回、**不**暂存任何东西，然后写入自己的快照
    const storeB = createFileInstallStateStore({ dir, writerId: 'B', now: () => at(3) });
    const managerB = createInstallSourceManager({ store: storeB });
    expect(managerB.reload()).toBe(true);
    managerB.install('template.spreadsheet', at(4));
    managerB.persist();

    const disk = createFileInstallStateStore({ dir, writerId: 'C' }).loadAll();
    expect(disk?.bindings).toEqual([pinned]);
    expect(disk?.generation).toBe(2);
  });

  it('反向对照：文件损坏时仍具名拒载，暂存值也不会覆盖损坏文件（改前改后都要绿）', () => {
    const target = join(dir, 'plugin-install-state.json');
    const store = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));
    store.recordBinding(bindingAt(at(2)));
    manager.persist();

    writeFileSync(target, 'not-json-at-all', 'utf8');
    manager.install('template.spreadsheet', at(3));
    store.recordBinding(bindingAt(at(5)));

    expect(failureCodeOf(() => manager.persist())).toBe('corrupt_json');
    expect(failureCodeOf(() => store.loadAll())).toBe('corrupt_json');
    // 损坏文件原样保留，没被暂存值悄悄洗掉
    expect(readFileSync(target, 'utf8')).toBe('not-json-at-all');
  });
});

// ---------------------------------------------------------------------------
// 2. 损坏文件 ⇒ 拒绝加载（不得当作"什么都没装"）
// ---------------------------------------------------------------------------

describe('损坏文件拒载（反向：绝不能静默当作空）', () => {
  const target = (): string => join(dir, 'plugin-install-state.json');

  it('文件不存在 ⇒ undefined（合法的"还没有状态"，与损坏严格区分）', () => {
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    expect(store.load()).toBeUndefined();
    expect(store.loadAll()).toBeUndefined();
  });

  it('乱码 JSON ⇒ corrupt_json 抛错（不是返回 undefined）', () => {
    writeFileSync(target(), '这不是 JSON {{{', 'utf8');
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    expect(failureCodeOf(() => store.load())).toBe('corrupt_json');
  });

  it('空文件 ⇒ corrupt_json（空 ≠ 没装过）', () => {
    writeFileSync(target(), '', 'utf8');
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    expect(failureCodeOf(() => store.load())).toBe('corrupt_json');
  });

  it('截断 JSON ⇒ corrupt_json（半截写入不得被当成空）', () => {
    writeFileSync(target(), '{"schema":"potbot.plugin-install-state","snapshot":{"records":[', 'utf8');
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    expect(failureCodeOf(() => store.load())).toBe('corrupt_json');
  });

  it('JSON 合法但形状非法 ⇒ invalid_snapshot（不是"空"）', () => {
    writeFileSync(
      target(),
      JSON.stringify({
        schema: PLUGIN_PERSISTENCE_SCHEMA,
        schema_version: 1,
        generation: 1,
        written_at: 0,
        last_writer: 'x',
        snapshot: { records: 'not-an-array', revision: 1 },
        bindings: [],
        package_declarations: {},
        redacted_keys: [],
      }),
      'utf8',
    );
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    expect(failureCodeOf(() => store.load())).toBe('invalid_snapshot');
  });

  it('records 里有一条记录字段缺失 ⇒ invalid_snapshot 并给出条目位置', () => {
    writeFileSync(
      target(),
      JSON.stringify({
        schema: PLUGIN_PERSISTENCE_SCHEMA,
        schema_version: 1,
        generation: 1,
        written_at: 0,
        last_writer: 'x',
        snapshot: { records: [{ plugin_id: 'template.document' }], revision: 1 },
        bindings: [],
        package_declarations: {},
        redacted_keys: [],
      }),
      'utf8',
    );
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    let detail = '';
    try {
      store.load();
    } catch (error) {
      detail = error instanceof PluginPersistenceError ? (error as PluginPersistenceError).detail : '';
    }
    expect(detail).toContain('records[0]');
  });

  it('schema 版本不认识 ⇒ unsupported_schema（不猜、不降级）', () => {
    writeFileSync(
      target(),
      JSON.stringify({
        schema: PLUGIN_PERSISTENCE_SCHEMA,
        schema_version: 999,
        generation: 1,
        written_at: 0,
        last_writer: 'x',
        snapshot: { records: [], revision: 0 },
        bindings: [],
        package_declarations: {},
        redacted_keys: [],
      }),
      'utf8',
    );
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    expect(failureCodeOf(() => store.load())).toBe('unsupported_schema');
  });

  it('InstallSourceManager.reload() 遇损坏文件 ⇒ 抛错，而不是返回 false', () => {
    writeFileSync(target(), 'garbage', 'utf8');
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    const manager = createInstallSourceManager({ store });
    // 关键：不能是 `false`（false 会被上层读成"没有可恢复快照"）
    expect(() => manager.reload()).toThrow(PluginPersistenceError);
  });

  it('save() 不会覆盖损坏文件（拒绝把损坏悄悄洗掉）', () => {
    writeFileSync(target(), 'garbage-not-json', 'utf8');
    const store = createFileInstallStateStore({ dir, writerId: 'A' });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));
    expect(failureCodeOf(() => manager.persist())).toBe('corrupt_json');
    // 损坏文件原样还在，没被半截数据覆盖
    expect(readFileSync(target(), 'utf8')).toBe('garbage-not-json');
  });
});

// ---------------------------------------------------------------------------
// 3. 凭据不落盘
// ---------------------------------------------------------------------------

describe('凭据 / 密钥不落盘（反向：值不得出现，键名也不得出现）', () => {
  it('敏感字段写盘前剔除并逐条记名，非敏感字段原样保留', () => {
    const store = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    store.setPackageDeclarations({
      'template.document': {
        display_name: '文档模板',
        api_token: 'TOPSECRET-TOKEN-VALUE-9f3a',
        password: 'P@ssw0rd-should-not-persist',
        nested: { client_secret: 'NESTED-SECRET-VALUE', keep_me: 'ok' },
      },
    });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));
    manager.persist();

    const text = readFileSync(store.filePath, 'utf8');

    // 反向对照：密钥值一个都不许出现
    expect(text).not.toContain('TOPSECRET-TOKEN-VALUE-9f3a');
    expect(text).not.toContain('P@ssw0rd-should-not-persist');
    expect(text).not.toContain('NESTED-SECRET-VALUE');
    // 反向对照：敏感**键名**不作为字段落盘（只允许作为 `redacted_keys` 里的"记名"字符串出现）
    expect(text).not.toContain('"api_token":');
    expect(text).not.toContain('"client_secret":');
    expect(text).not.toContain('"password":');

    // 正例：普通字段照常落盘
    expect(text).toContain('文档模板');
    expect(text).toContain('keep_me');

    // 记名：被剔除字段的路径逐条在册
    expect(store.lastRedactedKeys).toContain('package_declarations.template.document.api_token');
    expect(store.lastRedactedKeys).toContain('package_declarations.template.document.password');
    expect(store.lastRedactedKeys).toContain('package_declarations.template.document.nested.client_secret');

    // 读回：剔除生效、其余完整
    const reloaded = createFileInstallStateStore({ dir, writerId: 'B' }).loadAll();
    expect(reloaded?.redacted_keys).toContain('package_declarations.template.document.api_token');
    const declaration = (reloaded?.package_declarations['template.document'] ?? {}) as Record<string, unknown>;
    expect(declaration.display_name).toBe('文档模板');
    expect(declaration.api_token).toBeUndefined();
    expect(declaration.password).toBeUndefined();
    expect(declaration.nested).toEqual({ keep_me: 'ok' });
  });

  it('redactSecrets 纯函数：数组下标路径也记名', () => {
    const result = redactSecrets({ list: [{ auth_token: 'x', name: 'n' }], plain: 1 });
    expect(result.redacted_keys).toEqual(['list[0].auth_token']);
    expect(result.value).toEqual({ list: [{ name: 'n' }], plain: 1 });
  });
});

// ---------------------------------------------------------------------------
// 4. 并发写不互相覆盖
// ---------------------------------------------------------------------------

describe('并发写冲突（反向：覆盖必须被检出）', () => {
  it('两个写入者各自读过同一代后，后写者不得覆盖先写者（write_conflict）', () => {
    const storeA = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const first = createInstallSourceManager({ store: storeA });
    first.install('template.document', at(1));
    first.persist(); // 第 1 代，写入者 A

    // B 读到第 1 代
    const storeB = createFileInstallStateStore({ dir, writerId: 'B', now: () => at(2) });
    const second = createInstallSourceManager({ store: storeB });
    expect(second.reload()).toBe(true);

    // A 又写了一次 → 磁盘推进到第 2 代
    first.install('template.spreadsheet', at(3));
    first.persist();
    expect(storeA.loadAll()?.generation).toBe(2);

    // B 拿的是过期读取 → 必须被检出并拒绝覆盖
    expect(failureCodeOf(() => second.persist())).toBe('write_conflict');

    // A 的数据**原样还在**（没有被 B 静默抹掉）
    const storeC = createFileInstallStateStore({ dir, writerId: 'C', now: () => at(4) });
    const envelope = storeC.loadAll();
    expect(envelope?.generation).toBe(2);
    expect(envelope?.last_writer).toBe('A');
    const ids = (envelope?.snapshot.records ?? []).map((record) => record.plugin_id);
    expect(ids).toContain('template.document');
    expect(ids).toContain('template.spreadsheet');
  });

  it('接力写（A 写 → B 读 → B 写）不误报冲突（反例：检查不能太紧）', () => {
    const storeA = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const first = createInstallSourceManager({ store: storeA });
    first.install('template.document', at(1));
    first.persist();

    const storeB = createFileInstallStateStore({ dir, writerId: 'B', now: () => at(2) });
    const second = createInstallSourceManager({ store: storeB });
    expect(second.reload()).toBe(true);
    second.enable('template.document', at(3));
    expect(() => second.persist()).not.toThrow();

    const storeC = createFileInstallStateStore({ dir, writerId: 'C', now: () => at(4) });
    expect(storeC.loadAll()?.generation).toBe(2);
    expect(storeC.loadAll()?.last_writer).toBe('B');
    expect(storeC.loadAll()?.snapshot.records[0]?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. 原子写
// ---------------------------------------------------------------------------

describe('原子写', () => {
  it('一次 save() 后目录里没有临时文件残留，目标文件是完整可解析 JSON', () => {
    const store = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));

    manager.persist();
    manager.persist(); // 连续两次写

    expect(listStaleTempFiles(dir)).toEqual([]);
    const parsed = JSON.parse(readFileSync(store.filePath, 'utf8')) as { generation: number };
    expect(parsed.generation).toBe(2);
  });

  it('目标目录不存在时自动创建（而非写失败）', () => {
    const nested = join(dir, 'runtime', 'deep');
    const store = createFileInstallStateStore({ dir: nested, writerId: 'A' });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));
    expect(() => manager.persist()).not.toThrow();
    expect(existsSync(store.filePath)).toBe(true);
    expect(store.load()?.records).toHaveLength(1);
  });

  it('第 1 代写入后重新写入，磁盘内容被完整替换（不是追加/残留）', () => {
    const store = createFileInstallStateStore({ dir, writerId: 'A', now: () => at(0) });
    const manager = createInstallSourceManager({ store });
    manager.install('template.document', at(1));
    manager.persist();
    manager.install('template.spreadsheet', at(2));
    manager.persist();

    const text = readFileSync(store.filePath, 'utf8');
    const parsed = JSON.parse(text) as { snapshot: { records: readonly { plugin_id: string }[] } };
    // 文件里应当**同时**有两块记录；且 JSON 能被完整解析（没有被截断 / 拼两段）
    expect(parsed.snapshot.records.map((record) => record.plugin_id)).toEqual([
      'template.document',
      'template.spreadsheet',
    ]);
    expect(text).not.toContain('}{'); // 粗查：不是两段 JSON 拼接
  });

  it('目标的路径其实是目录 ⇒ 具名 path_is_directory（不是静默失败）', () => {
    const store = new FileInstallStateStore({ dir: join(dir, 'plugin-install-state.json') });
    // 文件尚不存在 ⇒ 合法的 undefined
    expect(store.load()).toBeUndefined();
    // 把目标路径做成目录，重读必须具名报错，而不是当成空
    mkdirSync(store.filePath, { recursive: true });
    expect(failureCodeOf(() => store.load())).toBe('path_is_directory');
  });
});
