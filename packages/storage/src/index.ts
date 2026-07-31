export { openAppDatabase } from "./db";
export { latestMigrationVersion, runMigrations } from "./migrations";
export { recordActivity, recordActivityOnce, listActivity } from "./repositories/activityRepository";
export {
  claimReviewItem,
  createReviewItem,
  expireReviewItemClaims,
  getReviewItem,
  getReviewItemState,
  listReviewItems,
  renewReviewItemClaim,
  transitionClaimedReviewItem,
  transitionReviewItem,
  updateReviewItemApplication,
  updateReviewItemPayload,
} from "./repositories/reviewRepository";
export { appendMessage } from "./repositories/sessionRepository";
export { searchNotes, searchSessions } from "./search";
export { SqliteVectorIndex } from "./vectorIndex";
export type {
  ActivityEvent,
  AppDatabase,
  NoteSearchResult,
  ReviewItem,
  ReviewState,
  SearchFilters,
  SessionMessage,
  SessionSearchResult,
  ChunkVectorRecord,
  ChunkVectorSearchResult,
  NoteVectorRecord,
  NoteVectorSearchResult,
  VectorIndex,
  VectorSearchFilters,
} from "./types";
