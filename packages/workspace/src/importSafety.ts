import { createHash } from "node:crypto";
import path from "node:path";
import { assertInsideWorkspace } from "./pathGuard";

export type ContentCategory =
  | "finance.utility"
  | "finance.insurance"
  | "finance.tax"
  | "finance.statement"
  | "profile.career"
  | "profile.personal_fact"
  | "memory.candidate"
  | "decision.record"
  | "project.document"
  | "resource"
  | "unknown";

export type ImportSensitivity = "normal" | "personal" | "private" | "restricted";
export type ReviewDecision = "auto_write" | "review_required" | "blocked";
export type ImportOperation = "stage" | "create" | "move" | "overwrite" | "delete";

export type SafetyReasonCode =
  | "PATH_ESCAPES_WORKSPACE"
  | "DESTINATION_EXISTS"
  | "OPERATION_NOT_ALLOWED"
  | "CLASSIFICATION_MISSING"
  | "CLASSIFICATION_INVALID"
  | "CLASSIFICATION_UNKNOWN"
  | "CLASSIFIER_CONFLICT"
  | "CONFIDENCE_BELOW_THRESHOLD"
  | "SENSITIVITY_REQUIRES_REVIEW"
  | "CATEGORY_REQUIRES_REVIEW"
  | "DESTINATION_REQUIRES_REVIEW"
  | "SAFETY_SIGNAL_REQUIRES_REVIEW"
  | "INTERNAL_EVALUATION_ERROR";

export interface ClassificationSignal {
  source: "detector" | "model" | "saved_user_policy" | "current_user_override";
  category?: ContentCategory;
  sensitivity?: ImportSensitivity;
  confidence?: number;
  evidence: string[];
  destination?: string;
  ruleId?: string;
}

export interface ImportClassification {
  primaryCategory: ContentCategory;
  alternativeCategories: ContentCategory[];
  sensitivity: ImportSensitivity;
  confidence: number;
  evidence: string[];
  signals: ClassificationSignal[];
  suggestedDestination?: string;
  conflict: boolean;
}

export interface ImportWriteIntent {
  workspaceRoot: string;
  operation: ImportOperation;
  destination?: string;
  destinationExists: boolean;
  autoWriteThreshold: number;
  approval?: ImportApprovalProof;
  classification?: ImportClassification;
}

export interface ImportApprovalProof {
  reviewItemId: string;
  destination: string;
  classificationFingerprint: string;
}

export interface SafetyDecision {
  decision: ReviewDecision;
  reasonCodes: SafetyReasonCode[];
  allowedDestination?: string;
}

const CONTENT_CATEGORIES = new Set<ContentCategory>([
  "finance.utility",
  "finance.insurance",
  "finance.tax",
  "finance.statement",
  "profile.career",
  "profile.personal_fact",
  "memory.candidate",
  "decision.record",
  "project.document",
  "resource",
  "unknown",
]);

const IMPORT_SENSITIVITIES = new Set<ImportSensitivity>([
  "normal",
  "personal",
  "private",
  "restricted",
]);

const IMPORT_OPERATIONS = new Set<ImportOperation>([
  "stage",
  "create",
  "move",
  "overwrite",
  "delete",
]);

const PROTECTED_CATEGORIES = new Set<ContentCategory>([
  "finance.utility",
  "finance.insurance",
  "finance.tax",
  "finance.statement",
  "profile.career",
  "profile.personal_fact",
  "memory.candidate",
  "decision.record",
]);

const PROTECTED_DESTINATION_ROOTS = [
  "02-Personal",
  "02-Profiles",
  "07-Private",
  path.join(".vault", "decisions"),
];

export function evaluateImportSafety(intent: ImportWriteIntent): SafetyDecision {
  try {
    return evaluateImportSafetyInternal(intent);
  } catch {
    return {
      decision: "review_required",
      reasonCodes: ["INTERNAL_EVALUATION_ERROR"],
    };
  }
}

export function fingerprintImportClassification(classification: ImportClassification): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(classification)))
    .digest("hex");
}

function evaluateImportSafetyInternal(intent: ImportWriteIntent): SafetyDecision {
  const blockedReasons: SafetyReasonCode[] = [];
  const operation = intent.operation as string;
  const normalizedDestination = normalizeDestination(intent.workspaceRoot, intent.destination);

  if (!normalizedDestination) {
    blockedReasons.push("PATH_ESCAPES_WORKSPACE");
  }

  if (!IMPORT_OPERATIONS.has(operation as ImportOperation)) {
    blockedReasons.push("OPERATION_NOT_ALLOWED");
  }

  if (operation === "overwrite" || operation === "delete") {
    blockedReasons.push("OPERATION_NOT_ALLOWED");
  }

  if (
    intent.destinationExists &&
    (operation === "stage" || operation === "create" || operation === "move")
  ) {
    blockedReasons.push("DESTINATION_EXISTS");
  }

  if (blockedReasons.length > 0) {
    return {
      decision: "blocked",
      reasonCodes: uniqueReasons(blockedReasons),
    };
  }

  const reviewReasons: SafetyReasonCode[] = [];
  const classificationState = validateClassification(intent.classification);
  const validClassification = classificationState === "valid" ? intent.classification : undefined;

  if (classificationState === "missing") {
    reviewReasons.push("CLASSIFICATION_MISSING");
  } else if (classificationState === "invalid") {
    reviewReasons.push("CLASSIFICATION_INVALID");
  } else if (validClassification !== undefined) {
    const classification = validClassification;
    if (classification.primaryCategory === "unknown") {
      reviewReasons.push("CLASSIFICATION_UNKNOWN");
    }
    if (classification.conflict) {
      reviewReasons.push("CLASSIFIER_CONFLICT");
    }
    if (classification.confidence < intent.autoWriteThreshold) {
      reviewReasons.push("CONFIDENCE_BELOW_THRESHOLD");
    }
    if (classification.sensitivity !== "normal") {
      reviewReasons.push("SENSITIVITY_REQUIRES_REVIEW");
    }
    if (PROTECTED_CATEGORIES.has(classification.primaryCategory)) {
      reviewReasons.push("CATEGORY_REQUIRES_REVIEW");
    }
    if (hasConflictingSafetySignal(classification, intent.autoWriteThreshold)) {
      reviewReasons.push("SAFETY_SIGNAL_REQUIRES_REVIEW");
    }
  }

  if (normalizedDestination && isProtectedDestination(intent.workspaceRoot, normalizedDestination)) {
    reviewReasons.push("DESTINATION_REQUIRES_REVIEW");
  }

  if (!Number.isFinite(intent.autoWriteThreshold) || intent.autoWriteThreshold < 0 || intent.autoWriteThreshold > 1) {
    reviewReasons.push("INTERNAL_EVALUATION_ERROR");
  }

  const uniqueReviewReasons = uniqueReasons(reviewReasons);
  const approvalClearsReview =
    validClassification !== undefined &&
    isValidApprovalProof(intent, normalizedDestination, validClassification) &&
    !uniqueReviewReasons.includes("INTERNAL_EVALUATION_ERROR");
  const remainingReviewReasons = approvalClearsReview ? [] : uniqueReviewReasons;
  const isApprovedMove = approvalClearsReview;
  const isNewFileOperation = operation === "create" || operation === "stage";

  if (remainingReviewReasons.length > 0 || (!isNewFileOperation && !isApprovedMove)) {
    return {
      decision: "review_required",
      reasonCodes: remainingReviewReasons,
      ...(normalizedDestination ? { allowedDestination: normalizedDestination } : {}),
    };
  }

  return {
    decision: "auto_write",
    reasonCodes: [],
    ...(normalizedDestination ? { allowedDestination: normalizedDestination } : {}),
  };
}

function normalizeDestination(workspaceRoot: string, destination: string | undefined): string | undefined {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    return undefined;
  }
  if (typeof destination !== "string" || destination.trim() === "" || destination.includes("\0")) {
    return undefined;
  }

  try {
    const normalizedRoot = path.resolve(workspaceRoot);
    const normalizedDestination = assertInsideWorkspace(normalizedRoot, destination);
    if (normalizedDestination === normalizedRoot) {
      return undefined;
    }
    return normalizedDestination;
  } catch {
    return undefined;
  }
}

function isProtectedDestination(workspaceRoot: string, normalizedDestination: string): boolean {
  const relativeDestination = path
    .relative(path.resolve(workspaceRoot), normalizedDestination)
    .toLowerCase();
  return PROTECTED_DESTINATION_ROOTS.some(
    (root) => {
      const normalizedRoot = root.toLowerCase();
      return (
        relativeDestination === normalizedRoot ||
        relativeDestination.startsWith(`${normalizedRoot}${path.sep}`)
      );
    },
  );
}

function validateClassification(
  classification: ImportClassification | undefined,
): "missing" | "invalid" | "valid" {
  if (classification === undefined) {
    return "missing";
  }
  if (!isRecord(classification)) {
    return "invalid";
  }
  if (
    !isContentCategory(classification.primaryCategory) ||
    !Array.isArray(classification.alternativeCategories) ||
    !classification.alternativeCategories.every(isContentCategory) ||
    !isImportSensitivity(classification.sensitivity) ||
    !isConfidence(classification.confidence) ||
    !Array.isArray(classification.evidence) ||
    !classification.evidence.every((item) => typeof item === "string") ||
    !Array.isArray(classification.signals) ||
    !classification.signals.every(isClassificationSignal) ||
    typeof classification.conflict !== "boolean" ||
    (classification.suggestedDestination !== undefined && typeof classification.suggestedDestination !== "string")
  ) {
    return "invalid";
  }
  return "valid";
}

function isClassificationSignal(signal: unknown): signal is ClassificationSignal {
  if (!isRecord(signal)) {
    return false;
  }
  return (
    signal.source === "detector" ||
    signal.source === "model" ||
    signal.source === "saved_user_policy" ||
    signal.source === "current_user_override"
  ) &&
    (signal.category === undefined || isContentCategory(signal.category)) &&
    (signal.sensitivity === undefined || isImportSensitivity(signal.sensitivity)) &&
    (signal.confidence === undefined || isConfidence(signal.confidence)) &&
    Array.isArray(signal.evidence) &&
    signal.evidence.every((item) => typeof item === "string") &&
    (signal.destination === undefined || typeof signal.destination === "string") &&
    (signal.ruleId === undefined || typeof signal.ruleId === "string");
}

function hasConflictingSafetySignal(
  classification: ImportClassification,
  autoWriteThreshold: number,
): boolean {
  return classification.signals.some((signal) => {
    const protectedOrUnknownCategory =
      signal.category === "unknown" ||
      (signal.category !== undefined && PROTECTED_CATEGORIES.has(signal.category));
    const sensitiveSignal = signal.sensitivity !== undefined && signal.sensitivity !== "normal";
    const belowThreshold =
      signal.confidence !== undefined && signal.confidence < autoWriteThreshold;
    return protectedOrUnknownCategory || sensitiveSignal || belowThreshold;
  });
}

function isValidApprovalProof(
  intent: ImportWriteIntent,
  normalizedDestination: string | undefined,
  classification: ImportClassification,
): boolean {
  if (intent.operation !== "move" || normalizedDestination === undefined) {
    return false;
  }

  const approval = intent.approval;
  if (
    !isRecord(approval) ||
    typeof approval.reviewItemId !== "string" ||
    approval.reviewItemId.trim() === "" ||
    typeof approval.destination !== "string" ||
    typeof approval.classificationFingerprint !== "string" ||
    approval.classificationFingerprint === ""
  ) {
    return false;
  }

  const normalizedApprovalDestination = normalizeDestination(intent.workspaceRoot, approval.destination);
  if (
    normalizedApprovalDestination === undefined ||
    normalizedApprovalDestination !== normalizedDestination
  ) {
    return false;
  }

  return approval.classificationFingerprint === fingerprintImportClassification(classification);
}

function isContentCategory(value: unknown): value is ContentCategory {
  return typeof value === "string" && CONTENT_CATEGORIES.has(value as ContentCategory);
}

function isImportSensitivity(value: unknown): value is ImportSensitivity {
  return typeof value === "string" && IMPORT_SENSITIVITIES.has(value as ImportSensitivity);
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        sorted[key] = canonicalize(value[key]);
      }
    }
    return sorted;
  }
  return value;
}

function uniqueReasons(reasonCodes: SafetyReasonCode[]): SafetyReasonCode[] {
  return [...new Set(reasonCodes)];
}
