/**
 * P10 手机侧演示编辑会话（PPT-01 / PPT-14 / PPT-16）公开出口。
 *
 * 典型用法（手机内，无电脑）：
 * ```ts
 * import {
 *   createPresentationSession, applySessionEdit, undoSession, verifySessionFacts,
 *   saveSession, openSessionFromBytes, sessionSummary,
 * } from './session/index.js';
 *
 * let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
 * const added = applySessionEdit(session, { op: 'add_slide', title: '封面' }, session.revision);
 * if (added.ok) session = added.session;
 *
 * // 保存 → 重开 → 再编辑
 * const saved = saveSession(session);
 * if (saved.ok) {
 *   const reopened = openSessionFromBytes(saved.record.bytes);
 *   if (reopened.ok) {
 *     const again = applySessionEdit(reopened.session, { op: 'set_slide_title', slide_id: 1, text: '改过' }, reopened.session.revision);
 *   }
 * }
 * ```
 */

export { PresentationSessionError, describeError } from './errors.js';
export type { PresentationSessionErrorReason } from './errors.js';

export {
  attachFactLedger,
  emptyFactLedger,
  factHistoryFor,
  forceLedgerTarget,
  publishFactValue,
  selectFactVersion,
} from './fact-ledger.js';
export type { FactLedger } from './fact-ledger.js';

export {
  applySessionEdit,
  createPresentationSession,
  openSessionFromBytes,
  openSessionFromPresentation,
  redoSession,
  saveSession,
  sessionFactVersion,
  sessionPresentation,
  sessionRevision,
  sessionSummary,
  undoSession,
  verifySessionFacts,
} from './session.js';
export type {
  CreatePresentationSessionOptions,
  PresentationSession,
  PresentationSessionOptions,
  SessionOpenOutcome,
} from './session.js';

export { PRESENTATION_SESSION_OPS } from './types.js';
export type {
  PresentationSessionEdit,
  PresentationSessionOpName,
  SessionEditOk,
  SessionEditOutcome,
  SessionEditRejected,
  SessionEditStale,
  SessionFactGate,
  SessionSaveOutcome,
  SessionSaveRecord,
  SessionSummary,
} from './types.js';

// P-I22：跨保存稳定的"当前页"引用与放映游标（消费 P-R05 放映层）。
export {
  SlideCursorError,
  captureCurrentSlideRef,
  findSlideOrdinal,
  playheadFromShow,
  playheadToSlideRef,
  resolveCurrentSlideRef,
  resolvePlayhead,
  slideIdAtOrdinal,
  slideRefAtOrdinal,
} from './slide-cursor.js';
export type {
  CurrentSlideRef,
  ResolvedSlide,
  SlideCursorErrorReason,
  SlideshowPlayhead,
  SlideshowPlayheadSource,
} from './slide-cursor.js';

// P-I22：自注册描述符（消费端按名字取 session / rendering 入口，无需深路径）。
export {
  PRESENTATIONS_PLUGIN_ID,
  PRESENTATIONS_PLUGIN_REGISTRATION,
  PRESENTATIONS_PLUGIN_VERSION,
  PresentationRegistryError,
  makeSurfaceDescriptor,
  registerSurface,
  resolveSurface,
  surfaceOf,
} from './registration.js';
export type {
  PresentationPluginRegistry,
  PresentationRegistryErrorReason,
  PresentationSurfaceDescriptor,
  PresentationSurfaceName,
} from './registration.js';
