/**
 * PPT-02 幻灯片**结构操作的机器可读清单**（operation schemas / types）。
 *
 * ## 用途
 *
 * OfficePlugin 契约（总方案 §5）要求业务线交付 `apply` 的可驱动操作面。这个清单把
 * PPT-02 的每个操作连同 **payload 字段、类型、必填性、作用层（对象模型 / 导入包）**
 * 一次性写清，供：
 * - 前端 / 内核构造命令 payload 时校验字段；
 * - `slide-structure` 之外的消费者（测试、检查器）枚举"本包到底提供了哪些操作"；
 * - 文档与实现不被悄悄改歪（`SLIDE_OPERATION_SCHEMAS` 是单一真相源）。
 *
 * ## 作用层 `tier`
 *
 * - `model`：操作 `Presentation`（`slide-ops.ts` 上半部分 / `operations.ts` 原语）。
 * - `deck`：操作导入的 `EditableDeck` 包（`slide-ops.ts` 下半部分）。
 *
 * 同名操作两层都有（如 `insert_slide` / `set_slide_layout`），`tier` 区分，
 * 这样"导入文稿同样适用"可以被机器核对：每个 `model` 操作都有对应的 `deck` 操作。
 */

/** 操作 payload 里一个字段的类型。 */
export type SlideFieldType =
  | 'page_number'
  | 'page_number[]'
  | 'slide_id'
  | 'slide_id[]'
  | 'section_id'
  | 'section_id_or_null'
  | 'layout_ref'
  | 'layout_part_path'
  | 'string'
  | 'boolean'
  | 'int';

/** payload 字段规格。 */
export interface SlideFieldSpec {
  readonly name: string;
  readonly type: SlideFieldType;
  /** `true` = 必填；`false` = 可省（函数有缺省语义）。 */
  readonly required: boolean;
  readonly description: string;
}

/** 操作作用层。 */
export type SlideOperationTier = 'model' | 'deck';

/** 一个结构操作的规格。 */
export interface SlideOperationSchema {
  readonly kind: SlideOperationKind;
  readonly tier: SlideOperationTier;
  /** 人类可读的一句话说明（中文）。 */
  readonly summary: string;
  readonly payload: readonly SlideFieldSpec[];
  /** 返回值的一句话说明。 */
  readonly result: string;
}

/** PPT-02 全部结构操作的 kind。 */
export type SlideOperationKind =
  | 'insert_slide'
  | 'delete_slide'
  | 'duplicate_slide'
  | 'move_slide'
  | 'set_slide_hidden'
  | 'set_slide_layout'
  | 'create_section'
  | 'rename_section'
  | 'move_section'
  | 'set_layout_for_slides'
  | 'move_section_with_pages'
  | 'delete_section'
  | 'assign_slide_to_section';

const PAGE: SlideFieldSpec = { name: 'at', type: 'page_number', required: false, description: '1 起页码；缺省 = 追加到末尾' };
const PAGE_FROM: SlideFieldSpec = { name: 'from_page', type: 'page_number', required: true, description: '1 起起始页码' };
const PAGE_TO: SlideFieldSpec = { name: 'to_page', type: 'page_number', required: true, description: '1 起目标页码' };
const HIDDEN: SlideFieldSpec = { name: 'hidden', type: 'boolean', required: true, description: 'true = 隐藏，false = 显示' };
const LAYOUT_MODEL: SlideFieldSpec = { name: 'layout', type: 'layout_ref', required: true, description: '对象模型版式引用 {master_id, layout_id}' };
const LAYOUT_DECK: SlideFieldSpec = { name: 'layout_part_path', type: 'layout_part_path', required: true, description: '包内版式部件路径 ppt/slideLayouts/slideLayoutN.xml' };
const SECTION_NAME: SlideFieldSpec = { name: 'name', type: 'string', required: true, description: '分节名（非空）' };
const SECTION_ID: SlideFieldSpec = { name: 'section_id', type: 'section_id', required: true, description: '分节 id' };
const SECTION_ORDER: SlideFieldSpec = { name: 'to_index', type: 'int', required: true, description: '分节序列内 0 起目标位置' };
const SECTION_ASSIGN: SlideFieldSpec = { name: 'section_id', type: 'section_id_or_null', required: true, description: '目标分节 id；null = 从所有分节摘出' };

/**
 * PPT-02 结构操作清单。**顺序稳定**，`kind + tier` 唯一。
 *
 * 每个 `model` 操作都有对应 `deck` 操作（"导入文稿同样适用"的机器可核判据）。
 */
export const SLIDE_OPERATION_SCHEMAS: readonly SlideOperationSchema[] = Object.freeze([
  { kind: 'insert_slide', tier: 'model', summary: '新建一页（可指定位置与版式）', payload: [PAGE, LAYOUT_MODEL], result: '{ presentation, slide_id, page_number }' },
  { kind: 'insert_slide', tier: 'deck', summary: '在导入包里新建一页空白页', payload: [PAGE], result: '{ deck, slide_id, page_number }' },
  { kind: 'delete_slide', tier: 'model', summary: '删除一页（对象引用不变，页码收紧）', payload: [{ name: 'slide_id', type: 'slide_id', required: true, description: '要删的页的对象引用' }], result: 'Presentation' },
  { kind: 'delete_slide', tier: 'deck', summary: '删除一页并连带其部件/备注/关系；被放映引用则报错', payload: [PAGE_FROM], result: 'EditableDeck' },
  { kind: 'duplicate_slide', tier: 'model', summary: '复制一页，副本带新 slide_id', payload: [{ name: 'slide_id', type: 'slide_id', required: true, description: '源页对象引用' }, PAGE], result: '{ presentation, slide_id, page_number }' },
  { kind: 'duplicate_slide', tier: 'deck', summary: '复制一页：新部件 + 新备注部件（不共用）', payload: [PAGE_FROM, PAGE], result: '{ deck, slide_id, page_number }' },
  { kind: 'move_slide', tier: 'model', summary: '把一页移到目标页码', payload: [{ name: 'slide_id', type: 'slide_id', required: true, description: '要移动的页' }, PAGE_TO], result: 'Presentation' },
  { kind: 'move_slide', tier: 'deck', summary: '改 p:sldIdLst 顺序；分节成员不变、节内页序重排', payload: [PAGE_FROM, PAGE_TO], result: 'EditableDeck' },
  { kind: 'set_slide_hidden', tier: 'model', summary: '设置隐藏态', payload: [{ name: 'slide_id', type: 'slide_id', required: true, description: '目标页' }, HIDDEN], result: 'Presentation' },
  { kind: 'set_slide_hidden', tier: 'deck', summary: '设置隐藏态（写 p:sld@show="0"）', payload: [PAGE_FROM, HIDDEN], result: 'EditableDeck' },
  { kind: 'set_slide_layout', tier: 'model', summary: '切换一页版式（模型引用）', payload: [{ name: 'slide_id', type: 'slide_id', required: true, description: '目标页' }, LAYOUT_MODEL], result: 'Presentation' },
  { kind: 'set_slide_layout', tier: 'deck', summary: '切换一页版式（改该页 _rels 的 slideLayout Target）', payload: [PAGE_FROM, LAYOUT_DECK], result: 'EditableDeck' },
  { kind: 'create_section', tier: 'model', summary: '新建分节（可同时归页）', payload: [SECTION_NAME, { name: 'slide_ids', type: 'slide_id[]', required: false, description: '初始归入的页' }], result: '{ presentation, section_id }' },
  { kind: 'create_section', tier: 'deck', summary: '新建分节（写 p14:sectionLst）', payload: [SECTION_NAME, { name: 'slide_ids', type: 'slide_id[]', required: false, description: '初始归入的页' }], result: '{ deck, section_id }' },
  { kind: 'rename_section', tier: 'model', summary: '分节改名', payload: [SECTION_ID, SECTION_NAME], result: 'Presentation' },
  { kind: 'rename_section', tier: 'deck', summary: '分节改名', payload: [SECTION_ID, SECTION_NAME], result: 'EditableDeck' },
  { kind: 'move_section', tier: 'deck', summary: '调整分节声明顺序', payload: [SECTION_ID, SECTION_ORDER], result: 'EditableDeck' },
  {
    kind: 'set_layout_for_slides',
    tier: 'deck',
    summary: '给一批页套同一版式（每页只改其 _rels 的 slideLayout Target）',
    payload: [
      { name: 'pages', type: 'page_number[]', required: true, description: '1 起页码列表（去重后升序套用）' },
      LAYOUT_DECK,
    ],
    result: 'EditableDeck',
  },
  {
    kind: 'move_section_with_pages',
    tier: 'deck',
    summary: '移动分节并把其成员页作为连续块一并搬走（非成员页相对顺序不变）',
    payload: [SECTION_ID, SECTION_ORDER],
    result: 'EditableDeck',
  },
  { kind: 'delete_section', tier: 'model', summary: '删除分节（页保留）', payload: [SECTION_ID], result: 'Presentation' },
  { kind: 'delete_section', tier: 'deck', summary: '删除分节（页保留）', payload: [SECTION_ID], result: 'EditableDeck' },
  { kind: 'assign_slide_to_section', tier: 'model', summary: '把一页归入/摘出分节（一页至多一节）', payload: [{ name: 'slide_id', type: 'slide_id', required: true, description: '目标页' }, SECTION_ASSIGN], result: 'Presentation' },
  { kind: 'assign_slide_to_section', tier: 'deck', summary: '把一页归入/摘出分节（保持节内页序）', payload: [PAGE_FROM, SECTION_ASSIGN], result: 'EditableDeck' },
]);

/** 按 kind 取全部作用层规格。找不到 ⇒ 空数组（不抛错，便于枚举消费）。 */
export function operationSchemas(kind: SlideOperationKind): readonly SlideOperationSchema[] {
  return SLIDE_OPERATION_SCHEMAS.filter((schema) => schema.kind === kind);
}

/** 取某个 `kind + tier` 的规格；两者组合不存在 ⇒ 抛错（清单是单一真相源）。 */
export function operationSchema(kind: SlideOperationKind, tier: SlideOperationTier): SlideOperationSchema {
  const found = SLIDE_OPERATION_SCHEMAS.find((schema) => schema.kind === kind && schema.tier === tier);
  if (found === undefined) {
    throw new Error(`未知的幻灯片结构操作：kind=${kind} tier=${tier}`);
  }
  return found;
}

/** 本清单覆盖的全部 kind（去重）。 */
export function slideOperationKinds(): readonly SlideOperationKind[] {
  return [...new Set(SLIDE_OPERATION_SCHEMAS.map((schema) => schema.kind))];
}
