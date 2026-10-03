/**
 * FA-G2 —— 检索适配器的**端口**（依赖注入边界）。
 *
 * 为什么是端口而不是直接文件 IO：
 * 合同 **R50.4** 要求 `src/**` 保持**零文件 IO**（纪律判据 `w-disc-kernel-discipline.test.ts`
 * 机器化断言：`src/**` 非测试文件不得出现 `node:fs` / `node:child_process` / `node:zlib`），
 * 且产品目标是安卓。因此本切片**核心不读文件系统**：由宿主（App/后台内核，B 流）
 * 实现下列端口。落盘与读文件由**验收侧**（`tests/**`）或宿主提供。
 *
 * 这**不是**共用合同层：端口只在本适配器内部使用，不注册到 `src/protocol/**`；
 * 需要跨层复用的部分写进 `outputs/FA-G2/interface-requests.md`。
 */

/** 一个待检索的来源（用户私有资料）。 */
export interface SourceDescriptor {
  /** 稳定 ID（内容寻址：sha256 十六进制），由 `digestBytes` 产出。 */
  readonly sourceId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

/**
 * 按 sourceId 取回原始字节。**必须返回与建索引时完全相同的字节**，
 * 否则引用回读会失败（这正是我们要的失败信号）。
 */
export interface SourceBytePort {
  read(sourceId: string): Promise<Uint8Array>;
}

/** 持久化端口（索引快照的落盘/读回/删除）。 */
export interface BlobPort {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string): Promise<readonly string[]>;
}

/** 逻辑时钟（可注入，便于确定性测试；不读系统时间以免破坏可复现性）。 */
export interface ClockPort {
  now(): number;
}

/** 端口集合。 */
export interface ResearchPorts {
  readonly sources: SourceBytePort;
  readonly blobs: BlobPort;
  readonly clock: ClockPort;
}

/** 内存 BlobPort —— 供测试与默认装配使用。 */
export function createMemoryBlobPort(initial: ReadonlyMap<string, string> = new Map()): BlobPort {
  const map = new Map<string, string>(initial);
  return {
    put(key, value) {
      map.set(key, value);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(map.get(key) ?? null);
    },
    delete(key) {
      map.delete(key);
      return Promise.resolve();
    },
    listKeys(prefix) {
      return Promise.resolve([...map.keys()].filter((k) => k.startsWith(prefix)));
    },
  };
}

/** 由内存字节表构造 SourceBytePort —— 供测试与证据运行使用。 */
export function createMemorySourcePort(bytes: ReadonlyMap<string, Uint8Array>): SourceBytePort {
  return {
    read(sourceId) {
      const found = bytes.get(sourceId);
      if (found === undefined) {
        return Promise.reject(new Error(`未找到来源字节：${sourceId}`));
      }
      return Promise.resolve(found);
    },
  };
}

/** 固定时钟。 */
export function createFixedClock(t: number): ClockPort {
  return { now: () => t };
}
