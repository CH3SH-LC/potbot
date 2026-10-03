/**
 * M05 定位授权状态机（四态：未授权 / 已授权 / 被拒 / 撤销）。
 *
 * ## 纪律
 *
 * - 状态**只能**经显式事件转移，本类不读系统权限、不读环境；
 * - 被请求的权限结果由注入的 `LocationPermissionPort` 给出（fixture 可独立驱动），
 *   本包**不**自行假设「默认已授权」；
 * - 「被拒」是一个**可见的终态**（`denied`），不是静默回退：状态机不会因为
 *   被拒就自动切到别的状态（换地址的判定在 `./view-model.ts`）。
 *
 * 合法转移：
 * - `unauthorized` / `denied` / `revoked` --request(granted)--> `authorized`
 * - `unauthorized` / `denied` / `revoked` --request(denied)-->  `denied`
 * - `authorized` --revoke--> `revoked`
 * - 任意态 --reset--> `unauthorized`
 *
 * 其余转移一律抛 `LocationPermissionError`（例如「已授权还去请求」「未授权就撤销」）。
 */

import { LocationPermissionError } from './errors.js';
import type {
  LocationPermissionPort,
  LocationPermissionResult,
  LocationPermissionState,
} from './types.js';

/** 可发起授权请求的前置状态。 */
const REQUESTABLE: readonly LocationPermissionState[] = Object.freeze(['unauthorized', 'denied', 'revoked']);

/** 四态词表（供断言与 UI 映射）。 */
export const LOCATION_PERMISSION_STATES: readonly LocationPermissionState[] = Object.freeze([
  'unauthorized',
  'authorized',
  'denied',
  'revoked',
]);

export class LocationPermissionMachine {
  #state: LocationPermissionState;

  constructor(initial: LocationPermissionState = 'unauthorized') {
    if (!LOCATION_PERMISSION_STATES.includes(initial)) {
      throw new LocationPermissionError(`未知的初始授权状态：${String(initial)}`);
    }
    this.#state = initial;
  }

  get state(): LocationPermissionState {
    return this.#state;
  }

  /** 是否处于「可被自动使用定位」的授权态。 */
  get isAuthorized(): boolean {
    return this.#state === 'authorized';
  }

  /** 是否处于「不得自动使用地址」的阻断态（未授权 / 被拒 / 撤销）。 */
  get isBlocked(): boolean {
    return this.#state !== 'authorized';
  }

  /**
   * 向注入端口请求授权并落到 `authorized` / `denied`。
   *
   * @throws {LocationPermissionError} 已授权时（不该再次请求，失败要看得见）。
   */
  async request(port: LocationPermissionPort): Promise<LocationPermissionState> {
    if (!REQUESTABLE.includes(this.#state)) {
      throw new LocationPermissionError(`当前状态 ${this.#state} 不允许发起授权请求`);
    }
    const result = await port.requestPermission();
    this.applyResult(result);
    return this.#state;
  }

  /** 外部（如系统回调）拿到结果后落到状态机。 */
  applyResult(result: LocationPermissionResult): LocationPermissionState {
    if (!REQUESTABLE.includes(this.#state)) {
      throw new LocationPermissionError(`当前状态 ${this.#state} 不允许应用授权结果 ${result}`);
    }
    if (result !== 'granted' && result !== 'denied') {
      throw new LocationPermissionError(`未知的授权结果：${String(result)}`);
    }
    this.#state = result === 'granted' ? 'authorized' : 'denied';
    return this.#state;
  }

  /** 撤销授权（仅从 `authorized`）。 */
  revoke(): LocationPermissionState {
    if (this.#state !== 'authorized') {
      throw new LocationPermissionError(`只有已授权状态才能撤销，当前为 ${this.#state}`);
    }
    this.#state = 'revoked';
    return this.#state;
  }

  /** 复位到未授权（如换账号 / 重装后的初态）。 */
  reset(): LocationPermissionState {
    this.#state = 'unauthorized';
    return this.#state;
  }
}
