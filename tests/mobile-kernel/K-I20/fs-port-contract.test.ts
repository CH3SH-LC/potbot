/**
 * K-I20 集成验证 —— **原生 `FileSystemPort`（安卓应用私有目录）与 TS 端口的静态契约对齐**。
 *
 * 对应 K09 集成请求 #1：`apps/android/app/src/main/java/com/potbot/kernel/storage/`
 * 实现 `apps/mobile-kernel/storage/fs-port.ts` 的 `FileSystemPort`，用原子 tmp+rename。
 *
 * 本文件**不编译 Java、不连真机**，只做结构化断言：
 *   ① Java 端口方法集 == TS 端口方法集（并钉住 8 个方法的签名形状）；
 *   ② 实现类 `implements FileSystemPort` 且 `@Override` 覆盖全部 8 个方法；
 *   ③ 原子性模式存在：`rename` 走 POSIX `rename(2)`（`Os.rename`），`writeFile` 走
 *      tmp+rename、写后有 `fsync`，并有越界围栏；
 *   ④ 判别力自证：拿**真实文件文本**做变异，扫描器结论必须翻转（否则是空断言）。
 *
 * 真机行为（杀进程重开后旧产物可读）**未验证**，见同目录 README 的局限段。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_PORT_METHODS,
  JAVA_IMPL,
  JAVA_INTERFACE,
  PORT_SOURCE,
  REPO_ROOT,
  extractInterfaceMethodList,
  hasConfinementCheck,
  hasDurabilityFsync,
  hasPosixAtomicRename,
  hasTmpRenameWrite,
  interfaceMethodSet,
  normalizeWs,
  overriddenMethodSet,
} from './fs-port-contract.js';

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

const tsPort = read(PORT_SOURCE);
const javaInterface = read(JAVA_INTERFACE);
const javaImpl = read(JAVA_IMPL);

// ---------------------------------------------------------------------------
// ① 端口方法集对齐（TS ⇄ Java）
// ---------------------------------------------------------------------------

describe('K-I20 ① 端口方法集对齐（TS ⇄ Java）', () => {
  it('TS FileSystemPort 恰好是钉住的 8 个方法', () => {
    expect(interfaceMethodSet(tsPort, 'FileSystemPort')).toEqual([...EXPECTED_PORT_METHODS]);
    expect(extractInterfaceMethodList(tsPort, 'FileSystemPort')).toHaveLength(8);
  });

  it('Java FileSystemPort 方法集与 TS 端口逐一相等', () => {
    expect(interfaceMethodSet(javaInterface, 'FileSystemPort')).toEqual(
      interfaceMethodSet(tsPort, 'FileSystemPort'),
    );
  });

  it('实现类 implements FileSystemPort 且 @Override 覆盖全部 8 个端口方法', () => {
    expect(normalizeWs(javaImpl)).toContain('class AndroidFileSystemPort implements FileSystemPort');
    expect(overriddenMethodSet(javaImpl)).toEqual([...EXPECTED_PORT_METHODS]);
  });

  it('关键签名形状正确（byte[] 读、String+byte[] 写、双 String rename、List<String> 列目录）', () => {
    const norm = normalizeWs(javaInterface);
    expect(norm).toContain('void ensureDir(String dirPath)');
    expect(norm).toContain('boolean exists(String path)');
    expect(norm).toContain('byte[] readFile(String path)');
    expect(norm).toContain('void writeFile(String path, byte[] bytes)');
    expect(norm).toContain('void rename(String fromPath, String toPath)');
    expect(norm).toContain('void removeFile(String path)');
    expect(norm).toContain('List<String> listFiles(String dirPath)');
    expect(norm).toContain('List<String> listDirs(String dirPath)');
  });
});

// ---------------------------------------------------------------------------
// ② 原子性模式
// ---------------------------------------------------------------------------

describe('K-I20 ② 原子性模式（tmp + rename）存在', () => {
  it('rename 走 POSIX rename(2)（Os.rename / ATOMIC_MOVE）', () => {
    expect(hasPosixAtomicRename(javaImpl)).toBe(true);
  });

  it('writeFile 走 tmp+rename 原子落盘', () => {
    expect(hasTmpRenameWrite(javaImpl)).toBe(true);
  });

  it('写后有文件级 fsync', () => {
    expect(hasDurabilityFsync(javaImpl)).toBe(true);
  });

  it('有越界围栏（canonical 规整 + path_outside_root）', () => {
    expect(hasConfinementCheck(javaImpl)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ③ 判别力自证：在真实文本上做变异，扫描器必须翻转
// ---------------------------------------------------------------------------

describe('K-I20 ③ 判别力自证（反空断言）', () => {
  it('抽掉 Os.rename → 原子 rename 判定翻假', () => {
    expect(hasPosixAtomicRename(javaImpl.replace(/Os\.rename/g, 'noop_call'))).toBe(false);
  });

  it('抽掉 TMP_SUFFIX → tmp+rename 判定翻假', () => {
    expect(hasTmpRenameWrite(javaImpl.replace(/TMP_SUFFIX/g, 'X_MARKER'))).toBe(false);
  });

  it('抽掉"把 tmp rename 到目标"那一步 → tmp+rename 判定翻假', () => {
    expect(hasTmpRenameWrite(javaImpl.replace(/atomicRename\(tmp, target\)/g, 'discard(tmp)'))).toBe(false);
  });

  it('抽掉 fsync → 持久化判定翻假', () => {
    expect(hasDurabilityFsync(javaImpl.replace(/getFD\(\)\.sync\(\)/g, 'noop_flush()'))).toBe(false);
  });

  it('抽掉围栏 → 越界判定翻假', () => {
    expect(hasConfinementCheck(javaImpl.replace(/path_outside_root/g, 'noop'))).toBe(false);
  });

  it('方法集抽取非恒真：改名的合成 Java 接口与 TS 端口不再相等', () => {
    const synth = javaInterface.replace(
      'void rename(String fromPath, String toPath);',
      'void moveIt(String a, String b);',
    );
    const set = interfaceMethodSet(synth, 'FileSystemPort');
    expect(set).not.toEqual(interfaceMethodSet(tsPort, 'FileSystemPort'));
    expect(set).toContain('moveIt');
    expect(set).not.toContain('rename');
  });

  it('@Override 抽取非恒真：删掉一个端口方法的实现会被抓到', () => {
    const synth = javaImpl.replace(
      '@Override\n    public boolean exists(String path) {',
      'public boolean existsRenamed(String path) {',
    );
    const overridden = overriddenMethodSet(synth);
    expect(overridden).not.toEqual([...EXPECTED_PORT_METHODS]);
    expect(overridden).not.toContain('exists');
    expect(overridden).toHaveLength(7);
  });
});
