/**
 * 表格域 X01：**XLSX 保真**子模块的唯一公开出口。
 *
 * 三块能力：
 * - {@link auditWorkbookResave}：导入 → 另存的**字节级保真审计**（EXCEL.md「不能用"保留未知
 *   部件"代替保真验证」）；逐部件 / 逐关系 / 逐内容类型给出可陈述的对比；
 * - {@link auditWorkbookAssembly}：**多来源整合**（`assembleWorkbookPackage`）产物的核对——
 *   结构自洽 + 逐来源部件去向 + 跨来源路径冲突是否全部无覆盖；
 * - {@link inspectWorkbookPackage}：损坏包的**准确分层拒绝**（container vs package）。
 *
 * 装配器（`package-assembly.ts`）与读 / 写器（`xlsx-read.ts` / `xlsx-write.ts`）都在
 * 同一 X01 写权内；本出口只做聚合，不引入新的写入路径。
 */

export {
  auditWorkbookResave,
  auditWorkbookAssembly,
  partFidelityOf,
  type WorkbookResaveAudit,
  type WorkbookAssemblyAudit,
  type AssemblySourcePart,
  type AssemblyPathCollision,
  type AssemblyRelationshipIssue,
  type AssemblyDanglingTarget,
  type PartFidelity,
  type PartFidelityStatus,
  type PartFidelityRole,
  type RelationshipFidelity,
  type ContentTypeFidelity,
} from './roundtrip-audit.js';

export {
  inspectWorkbookPackage,
  isRejected,
  type PackageInspection,
  type PackageOk,
  type PackageRejected,
  type PackageRejectionLayer,
} from './corruption.js';
