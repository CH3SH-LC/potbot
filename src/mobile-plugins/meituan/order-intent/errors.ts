/**
 * M-I18 落盘下单意图 —— 错误类型。
 *
 * 纪律与 M07 / M09 一致：**所有失败都显式抛出**，绝不静默吞掉或「顺手修正」。
 * 尤其是恢复时读到的磁盘字节**不可信**：结构不对 / 版本不对 / 指纹对不上，
 * 一律抛错，绝不「尽力补一个默认值」把一份被改过的记录当成真。
 */

/** 本包全部错误的基类。 */
export class OrderIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderIntentError';
  }
}

/**
 * 落盘意图记录**结构 / 版本**不合法（不是对象、版本不符、kind 不对、缺字段…）。
 *
 * 与 {@link OrderIntentIntegrityError} 的区别：本错误说的是「这份记录压根不是
 * 本模块写出的那种形状」；后者说的是「形状对、但内容与被改动的字节对不上」。
 */
export class PersistedOrderIntentError extends OrderIntentError {
  constructor(message: string) {
    super(message);
    this.name = 'PersistedOrderIntentError';
  }
}

/**
 * 落盘意图记录**内容被改动**（指纹对不上）。
 *
 * 这是「磁盘上的字节被改过」的证据，而不是要本地去修补的东西。恢复遇到本错误
 * 必须整体拒绝该记录，不得「就按改后的金额继续跟踪」。
 *
 * 注意（如实说明强度）：本包的指纹是**非密钥**校验——它能发现**意外损坏 /
 * 朴素编辑**（例如把金额 +1、把 externalId 换成另一单），**不能**阻止一个
 * 能重写快照并重算指纹的攻击者。真正的权威核验是 M09 恢复后**重新查原单**、
 * 用平台回执与本地意图逐项比对。
 */
export class OrderIntentIntegrityError extends OrderIntentError {
  /** 期望的指纹（由本地五字段重算得出）。 */
  readonly expected: string;
  /** 记录里携带的指纹（来自磁盘字节）。 */
  readonly found: string;

  constructor(expected: string, found: string, detail: string) {
    super(`落盘下单意图指纹不符：期望 ${expected}，记录携带 ${found}；${detail}`);
    this.name = 'OrderIntentIntegrityError';
    this.expected = expected;
    this.found = found;
  }
}

/**
 * 输入对象长得像**授权**（携带 grant 标记字段），被拒。
 *
 * 本模块产出的是「下单事实记录」，**不是** K07 的 `AuthorizationGrant` / M07 的
 * `AuthorizationRef`——它不能被用来授权一次提交、不能被占用、不能被重放。
 * 一旦有人把授权对象塞进来（哪怕只是多带了 `grantId` / `consumed` 这类字段），
 * 这里就 fail-closed，避免「事实」与「凭证」在同一份落盘记录里混淆。
 */
export class OrderIntentGrantShapeError extends PersistedOrderIntentError {
  /** 触发的授权标记字段（去重、稳定排序）。 */
  readonly markers: readonly string[];

  constructor(markers: readonly string[]) {
    super(
      `落盘下单意图是事实记录、不是授权：输入携带授权标记字段 ${markers.join(', ')}；` +
        '请改用 K07 AuthorizationGrant / M07 AuthorizationRef 表达授权，不要把它混进意图快照',
    );
    this.name = 'OrderIntentGrantShapeError';
    this.markers = Object.freeze([...markers]);
  }
}
