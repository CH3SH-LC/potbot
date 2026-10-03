/**
 * 敏感字段脱敏。
 *
 * 视图里**只能**出现脱敏值；明文只允许经 `DeliveryDetailPort` 在声明用途下取用。
 * 这两个函数是视图转换的唯一出口，越界即测试变红。
 */

/**
 * 脱敏手机号：保留前 3 位与后 4 位，中间以 `****` 代替（`13800008000` → `138****8000`）。
 * 短号按「只留末 2 位」处理，空串返回空串——任何情况下都不原样返回。
 */
export function maskPhone(phone: string): string {
  if (phone.length === 0) return '';
  if (phone.length <= 4) return '*'.repeat(phone.length);
  if (phone.length < 8) return `${'*'.repeat(phone.length - 2)}${phone.slice(-2)}`;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 脱敏联系人名：保留首字符，其余以 `*` 代替（`张三` → `张*`；单字 → `*`）。 */
export function maskContactName(name: string): string {
  if (name.length === 0) return '';
  if (name.length === 1) return '*';
  return `${name.slice(0, 1)}${'*'.repeat(name.length - 1)}`;
}
