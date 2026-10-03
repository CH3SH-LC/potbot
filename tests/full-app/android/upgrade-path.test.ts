/**
 * APP-01（旧数据迁移与升级失败处理的**显式路径**）—— 源码级结构断言。
 *
 * 合同依据：能力目录 APP-01；`full-app-contract-v1.md` R215（崩溃窗口/恢复）与
 * 本项目「结果不得编造」纪律（失败必须如实报、原数据必须保留）。
 *
 * 判据（都可机判）：
 *   ① 结论是**五个互不相同**的状态：新装 / 无需迁移 / 已迁移 / **迁移失败** / **拒绝降级**；
 *   ② 迁移**逐级**执行；**没有登记的跳跃直接判失败**，不许"跳过一步当无事发生"；
 *   ③ 任何一步抛异常 ⇒ 失败，且**不回写 schema 版本、不删数据**；
 *   ④ schema 版本号**只在整轮迁移全部成功之后**才写一次；
 *   ⑤ 降级（已存版本更高）**不改任何数据、不回写版本号**；
 *   ⑥ 失败原因（步骤名 + 原因）持久化，宿主如实回报。
 *
 * ⚠️ **未验证（需真机 + 两个版本的 APK）**：跨版本升级本身**未在设备上执行过**；
 * 本文件只核对源码结构，不核对真机上"旧数据真的被安全迁移"。目前也**没有**已发布旧版本
 * 会写入 schema 版本键，因此线上设备实际走"新装"分支——登记下来，不假称已实测迁移。
 */

import { describe, expect, it } from 'vitest';

import { JAVA_DIR, MAIN_ACTIVITY, enumMembers, extractMethodBody, readText } from './android-app-source.js';

const UPGRADE = `${JAVA_DIR}/PotbotUpgrade.java`;

/** 迁移登记表的判别谓词：允许"缺登记步时**显式失败**"且"版本号**只在成功后**写一次"。 */
export function upgradePathIsExplicit(source: string): boolean {
  const body = extractMethodBody(source, 'public static Result run(Context context)');
  if (body === null) return false;
  const idxNoStep = body.indexOf('FAILURE_NO_STEP');
  const idxWhile = body.indexOf('while (current < SCHEMA_VERSION)');
  const idxWrite = body.indexOf('putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION)');
  if (idxNoStep < 0 || idxWhile < 0 || idxWrite < 0) return false;
  if (idxNoStep < idxWhile) return false; // 缺步判定必须在迁移循环**之内**
  if (idxWrite < idxWhile) return false;  // 版本号不得在循环之前就写
  const writes = source.split('putInt(KEY_SCHEMA_VERSION').length - 1;
  return writes === 1; // 只允许一处回写
}

describe('迁移路径判别器（判别力自证）', () => {
  it('干净镜像放行', () => {
    const good = `
      public static Result run(Context context) {
        while (current < SCHEMA_VERSION) {
          if (match == null) {
            return persist(prefs, new Result(State.MIGRATION_FAILED, stored, current,
                    FAILURE_NO_STEP, "没有登记迁移步"));
          }
        }
        prefs.edit().putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION).commit();
        return persist(prefs, new Result(State.MIGRATED, stored, SCHEMA_VERSION, "", ""));
      }
    `;
    expect(upgradePathIsExplicit(good)).toBe(true);
  });

  it('抓得到「缺登记步时静默跳过、直接当成功」', () => {
    const bad = `
      public static Result run(Context context) {
        while (current < SCHEMA_VERSION) {
          current = current + 1;
        }
        prefs.edit().putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION).commit();
        return persist(prefs, new Result(State.MIGRATED, stored, SCHEMA_VERSION, "", ""));
      }
    `;
    expect(upgradePathIsExplicit(bad)).toBe(false);
  });

  it('抓得到「迁移还没做就把版本号写上去」', () => {
    const bad = `
      public static Result run(Context context) {
        prefs.edit().putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION).commit();
        if (false) { String s = "FAILURE_NO_STEP"; }
        while (current < SCHEMA_VERSION) { current = current + 1; }
        return persist(prefs, new Result(State.MIGRATED, stored, SCHEMA_VERSION, "", ""));
      }
    `;
    expect(upgradePathIsExplicit(bad)).toBe(false);
  });

  it('抓得到「版本号被写了两处（失败时也可能被写上）」', () => {
    const bad = `
      public static Result run(Context context) {
        prefs.edit().putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION).commit();
        while (current < SCHEMA_VERSION) {
          if (match == null) { String s = "FAILURE_NO_STEP"; }
        }
        prefs.edit().putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION).commit();
        return persist(prefs, new Result(State.MIGRATED, stored, SCHEMA_VERSION, "", ""));
      }
    `;
    expect(upgradePathIsExplicit(bad)).toBe(false);
  });
});

describe('真实源码：PotbotUpgrade（升级/迁移的显式路径）', () => {
  const java = readText(UPGRADE);
  const run = extractMethodBody(java, 'public static Result run(Context context)') ?? '';
  const registry = extractMethodBody(java, 'static List<Migration> registry()') ?? '';

  it('结论是五个互不相同的状态', () => {
    const members = enumMembers(java, 'State');
    expect(members).not.toBeNull();
    const expected = ['FRESH_INSTALL', 'NO_MIGRATION_NEEDED', 'MIGRATED', 'MIGRATION_FAILED',
      'DOWNGRADE_REJECTED'];
    for (const name of expected) {
      expect(members, `缺少状态 ${name}`).toContain(name);
    }
    expect(new Set(members ?? []).size).toBe((members ?? []).length); // 不取重
  });

  it('迁移是逐级登记的（registry），且缺少登记步时显式失败', () => {
    expect(registry.length, '找不到 registry()').toBeGreaterThan(0);
    expect(registry).toMatch(/new Migration\(\s*1\s*,\s*2\s*,\s*"/);
    expect(run).toContain('FAILURE_NO_STEP');
    expect(run).toContain('find(registry, current)');
  });

  it('★版本号只在整轮迁移成功后写一次（升级路径判别器放行）', () => {
    expect(upgradePathIsExplicit(java), '升级路径不满足"成功后唯一回写"').toBe(true);
  });

  it('迁移循环在回写之前，且失败分支在循环之内', () => {
    const idxWhile = run.indexOf('while (current < SCHEMA_VERSION)');
    const idxWrite = run.indexOf('putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION)');
    const idxNoStep = run.indexOf('FAILURE_NO_STEP');
    expect(idxWhile).toBeGreaterThan(-1);
    expect(idxWrite).toBeGreaterThan(idxWhile);
    expect(idxNoStep).toBeGreaterThan(idxWhile);
    expect(idxNoStep).toBeLessThan(idxWrite);
  });

  it('任何一步抛异常 ⇒ MIGRATION_FAILED，且走 persist（保留原数据、不删键）', () => {
    expect(run).toMatch(/catch\s*\(Throwable e\)/);
    expect(run).toContain('State.MIGRATION_FAILED');
    expect(run).toMatch(/match\.step\.apply\(prefs\)/);
    const idxApply = run.indexOf('match.step.apply(prefs)');
    const idxCatch = run.indexOf('catch (Throwable e)', idxApply);
    expect(idxCatch, '迁移步调用后没有 catch').toBeGreaterThan(idxApply);
    const idxFail = run.indexOf('State.MIGRATION_FAILED', idxCatch);
    expect(idxFail, 'catch 里没有报 MIGRATION_FAILED').toBeGreaterThan(idxCatch);
  });

  it('失败原因（步骤名 + 原因）持久化；成功时清空', () => {
    const persist = extractMethodBody(java, 'private static Result persist(') ?? '';
    expect(persist).toContain('State.MIGRATION_FAILED');
    expect(persist).toContain('KEY_FAILED_STEP');
    expect(persist).toContain('KEY_FAILED_DETAIL');
    expect(persist).toMatch(/remove\(KEY_FAILED_STEP\)/);
  });

  it('降级：不改数据、不回写版本号，明确拒绝', () => {
    const idxDown = run.indexOf('State.DOWNGRADE_REJECTED');
    expect(idxDown).toBeGreaterThan(-1);
    const idxWhile = run.indexOf('while (current < SCHEMA_VERSION)');
    // 降级分支在迁移循环之前，且两者之间没有任何 schema 版本回写。
    expect(idxDown).toBeLessThan(idxWhile);
    const between = run.slice(idxDown, idxWhile);
    expect(between).not.toContain('putInt(KEY_SCHEMA_VERSION');
    expect(java).toContain('DOWNGRADE_REJECTED');
  });

  it('schema 版本键不是 int 时**不猜**，如实判失败并保留现场', () => {
    expect(run).toMatch(/getInt\(KEY_SCHEMA_VERSION/);
    expect(java).toContain('schema 版本键不是整数');
  });

  it('迁移步本身是幂等的（只在目标键缺失时复制，不覆盖现值）', () => {
    expect(registry).toContain('prefs.contains(normalized)');
    expect(registry).toContain('LEGACY_PREFIX');
  });

  it('MainActivity 冷启动跑一次并把失败/降级如实回报（不掩盖）', () => {
    const activity = readText(MAIN_ACTIVITY);
    expect(activity).toContain('PotbotUpgrade.run(this)');
    expect(activity).toContain('ST_APP_UPGRADE_FAILED');
    expect(activity).toContain('ST_APP_UPGRADE_DOWNGRADE');
    expect(activity).toMatch(/MIGRATION_FAILED|State\.DOWNGRADE_REJECTED/);
  });
});
