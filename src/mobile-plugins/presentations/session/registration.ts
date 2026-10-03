/**
 * P-I22 · **手机侧演示插件的自注册描述符**。
 *
 * ## 缺口
 *
 * `src/mobile-plugins/presentations/` 下**没有**注册表：编辑会话只能靠
 * `import ... from 'src/mobile-plugins/presentations/session/index.js'` 这样的**深路径**触达，
 * 渲染层同理（`.../rendering/index.js`）。消费端（前端文件预览、工具派发）拿不到一个"插件清单"
 * 去按名字取入口。P10 的集成请求也点名要一个注册表。
 *
 * ## 本模块给出什么
 *
 * 一个**自注册**的插件描述符 {@link PRESENTATIONS_PLUGIN_REGISTRATION}：把本插件的两个入口
 * ——`session`（编辑会话 + 稳定页游标）与 `rendering`（真实像素渲染）——登记成**具名入口**，
 * 每个入口带 `module_specifier`（深路径，仅作文档 / 懒加载回退）与 **`api`（真实的导出对象）**。
 * 消费端只要拿到描述符，就能 `resolveSurface(reg, 'session').api.createPresentationSession`
 * 直接调，**无需知道深路径**。
 *
 * `api` 里是各模块的**真实导出引用**（不是拷贝品）：用例按恒等 `===` 断言"描述符指向的就是
 * 真入口"，防止描述符与实现脱节。
 *
 * 本模块纯：无 IO、无副作用（注册表是模块加载时构造一次的冻结单例）。
 */

import { ValidationError } from '../../../protocol/index.js';

import * as cursorApi from './slide-cursor.js';
import * as sessionApi from './session.js';
import * as renderingApi from '../rendering/index.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 注册表失败原因（封闭枚举）。 */
export type PresentationRegistryErrorReason =
  /** 按名字取入口时，注册表里没有这个入口。 */
  | 'unknown_surface'
  /** 登记一个已存在的入口名（不覆盖、不静默）。 */
  | 'duplicate_surface'
  /** 入口名为空或非法。 */
  | 'invalid_surface_name';

/** 注册表错误。`reason` 是判定用的稳定标识；`message` 只给人看。 */
export class PresentationRegistryError extends ValidationError {
  readonly reason: PresentationRegistryErrorReason;

  constructor(reason: PresentationRegistryErrorReason, message: string) {
    super(message);
    this.name = 'PresentationRegistryError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 描述符
// ---------------------------------------------------------------------------

/** 本插件的具名入口。 */
export type PresentationSurfaceName = 'session' | 'rendering';

/** 插件标识与版本（`api` 形状变化时升版，消费端据此判定兼容）。 */
export const PRESENTATIONS_PLUGIN_ID = 'mobile-plugins.presentations';
export const PRESENTATIONS_PLUGIN_VERSION = '1.0.0';

/** 一个具名入口的描述符。 */
export interface PresentationSurfaceDescriptor {
  readonly name: PresentationSurfaceName;
  /**
   * 深路径模块标识（POSIX 仓库相对路径，以 `.js` 结尾）。
   * 仅作文档 / 懒加载回退；消费端正常情况下用 {@link PresentationSurfaceDescriptor.api}。
   */
  readonly module_specifier: string;
  /** 该入口能做什么（机器可读的粗能力标签）。 */
  readonly capabilities: readonly string[];
  /** 该模块的**真实导出对象**（恒等，不是拷贝）。 */
  readonly api: Readonly<Record<string, unknown>>;
}

/** 一张插件注册表（不可变值）。 */
export interface PresentationPluginRegistry {
  readonly plugin_id: string;
  readonly version: string;
  readonly surfaces: readonly PresentationSurfaceDescriptor[];
}

function assertSurfaceName(name: unknown): asserts name is PresentationSurfaceName {
  if (name !== 'session' && name !== 'rendering') {
    throw new PresentationRegistryError('invalid_surface_name', `未知的演示插件入口 ${JSON.stringify(String(name))}`);
  }
}

/** 造一个入口描述符（做形状自检：名字合法、路径非空、api 非空、能力标签非空）。 */
export function makeSurfaceDescriptor(input: {
  readonly name: PresentationSurfaceName;
  readonly module_specifier: string;
  readonly capabilities: readonly string[];
  readonly api: Readonly<Record<string, unknown>>;
}): PresentationSurfaceDescriptor {
  assertSurfaceName(input.name);
  if (typeof input.module_specifier !== 'string' || input.module_specifier.trim() === '') {
    throw new PresentationRegistryError('invalid_surface_name', `入口 ${input.name} 的 module_specifier 不能为空`);
  }
  const keys = Object.keys(input.api);
  if (keys.length === 0) {
    throw new PresentationRegistryError('invalid_surface_name', `入口 ${input.name} 的 api 不能为空`);
  }
  if (input.capabilities.length === 0 || input.capabilities.some((tag) => tag.trim() === '')) {
    throw new PresentationRegistryError('invalid_surface_name', `入口 ${input.name} 的 capabilities 不能为空`);
  }
  return Object.freeze({
    name: input.name,
    module_specifier: input.module_specifier,
    capabilities: Object.freeze([...input.capabilities]),
    api: Object.freeze({ ...input.api }),
  });
}

// ---------------------------------------------------------------------------
// 注册表操作
// ---------------------------------------------------------------------------

/**
 * 登记一个入口；同名已存在 ⇒ `duplicate_surface`（不覆盖、不静默——要改请显式换名或新版本）。
 */
export function registerSurface(
  registry: PresentationPluginRegistry,
  descriptor: PresentationSurfaceDescriptor,
): PresentationPluginRegistry {
  assertSurfaceName(descriptor.name);
  if (registry.surfaces.some((surface) => surface.name === descriptor.name)) {
    throw new PresentationRegistryError('duplicate_surface', `入口 ${descriptor.name} 已登记；重复登记被拒`);
  }
  return Object.freeze({
    plugin_id: registry.plugin_id,
    version: registry.version,
    surfaces: Object.freeze([...registry.surfaces, descriptor]),
  });
}

/** 按名字取入口；没有 ⇒ `unknown_surface`（具名拒绝）。 */
export function resolveSurface(
  name: PresentationSurfaceName,
  registry: PresentationPluginRegistry = PRESENTATIONS_PLUGIN_REGISTRATION,
): PresentationSurfaceDescriptor {
  const found = registry.surfaces.find((surface) => surface.name === name);
  if (found === undefined) {
    throw new PresentationRegistryError(
      'unknown_surface',
      `注册表 ${registry.plugin_id} 里没有入口 ${JSON.stringify(String(name))}`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// 自注册：模块加载时登记本插件的两个入口
// ---------------------------------------------------------------------------

/** `session` 入口的 api：编辑会话 + 稳定页游标（同一命名空间里合并，避免消费端拼两次深路径）。 */
const SESSION_API: Readonly<Record<string, unknown>> = Object.freeze({
  ...sessionApi,
  ...cursorApi,
});

const RENDERING_API: Readonly<Record<string, unknown>> = Object.freeze({ ...renderingApi });

const EMPTY_REGISTRY: PresentationPluginRegistry = Object.freeze({
  plugin_id: PRESENTATIONS_PLUGIN_ID,
  version: PRESENTATIONS_PLUGIN_VERSION,
  surfaces: Object.freeze([]),
});

/**
 * 本插件的**默认注册表**（模块加载即自注册 `session` + `rendering`）。
 *
 * 消费端拿到它即可按名字取到两个真实入口，不必知道任何深路径。
 */
export const PRESENTATIONS_PLUGIN_REGISTRATION: PresentationPluginRegistry = registerSurface(
  registerSurface(
    EMPTY_REGISTRY,
    makeSurfaceDescriptor({
      name: 'session',
      module_specifier: 'src/mobile-plugins/presentations/session/index.js',
      capabilities: Object.freeze(['edit_session', 'undo_redo', 'fact_gate', 'save_reopen', 'stable_slide_cursor']),
      api: SESSION_API,
    }),
  ),
  makeSurfaceDescriptor({
    name: 'rendering',
    module_specifier: 'src/mobile-plugins/presentations/rendering/index.js',
    capabilities: Object.freeze(['raster_png', 'pdf', 'glyph_port']),
    api: RENDERING_API,
  }),
);

/** 便捷：从**默认注册表**按名字取入口（等价 `resolveSurface(name)`）。 */
export function surfaceOf(name: PresentationSurfaceName): PresentationSurfaceDescriptor {
  return resolveSurface(name);
}
