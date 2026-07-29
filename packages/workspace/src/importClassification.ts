import type {
  ClassificationSignal,
  ContentCategory,
  ImportClassification,
  ImportSensitivity,
} from "./importSafety";

export interface SavedImportRule {
  id?: string;
  pattern: string;
  category?: ContentCategory;
  sensitivity?: ImportSensitivity;
  destination: string;
}

const sourcePriority: Record<ClassificationSignal["source"], number> = {
  model: 1,
  detector: 2,
  saved_user_policy: 3,
  current_user_override: 4,
};

const sensitivityPriority: Record<ImportSensitivity, number> = {
  normal: 0,
  personal: 1,
  private: 2,
  restricted: 3,
};

export function detectImportSignals(input: {
  batchName: string;
  fileName: string;
  text: string;
}): ClassificationSignal[] {
  const signals: ClassificationSignal[] = [];
  const textLines = input.text.split(/\r?\n/u).map(normalizeLine).filter(Boolean);
  const financeContext = `${input.batchName}\n${input.fileName}\n${input.text}`;
  const paymentEvidence = textLines.filter((line) => /\$\d|\bamount\b|\bdue\b/iu.test(line));

  if (
    /\b(bill|utility|utilities|electric|water|gas|amount|due)\b/iu.test(financeContext) &&
    paymentEvidence.length > 0
  ) {
    signals.push({
      source: "detector",
      category: "finance.utility",
      sensitivity: "personal",
      confidence: 0.8,
      evidence: snippets(paymentEvidence),
    });
  }

  const employmentEvidence = textLines.filter((line) => employmentPattern.test(line));
  if (employmentEvidence.length > 0) {
    signals.push({
      source: "detector",
      category: "profile.career",
      sensitivity: "personal",
      confidence: 1,
      evidence: snippets(employmentEvidence),
    });
  }

  return signals;
}

export function mergeImportClassification(input: {
  signals: ClassificationSignal[];
  fallbackDestination: string;
}): ImportClassification {
  const signals = input.signals.map(normalizeSignal);
  const categorySignal = winningSignal(signals, (signal) => signal.category !== undefined);
  const primaryCategory = categorySignal?.category ?? "unknown";
  const destinationSignal = winningSignal(signals, (signal) => nonEmptyString(signal.destination));

  return {
    primaryCategory,
    alternativeCategories: alternativeCategories(signals, primaryCategory),
    sensitivity: strictestSensitivity(signals),
    confidence: categorySignal === undefined ? 0 : categoryConfidence(categorySignal),
    evidence: uniqueSnippets(signals.flatMap((signal) => signal.evidence)),
    signals,
    suggestedDestination: destinationSignal?.destination ?? input.fallbackDestination,
    conflict: hasCategoryConflict(signals),
  };
}

const employmentPattern = /^.{2,120}?\s+\|\s+[A-Za-z][A-Za-z0-9&.'-]{1,80}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\s*[–-]\s*(?:Present|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})$/u;

function normalizeSignal(signal: ClassificationSignal): ClassificationSignal {
  const confidence = explicitUserCategory(signal) ? 1 : signal.confidence;
  return {
    ...signal,
    ...(confidence === undefined ? {} : { confidence }),
    evidence: snippets(signal.evidence),
  };
}

function winningSignal(
  signals: ClassificationSignal[],
  predicate: (signal: ClassificationSignal) => boolean,
): ClassificationSignal | undefined {
  let winner: ClassificationSignal | undefined;
  for (const signal of signals) {
    if (!predicate(signal) || (winner !== undefined && sourcePriority[signal.source] <= sourcePriority[winner.source])) {
      continue;
    }
    winner = signal;
  }
  return winner;
}

function alternativeCategories(signals: ClassificationSignal[], primaryCategory: ContentCategory): ContentCategory[] {
  const alternatives: ContentCategory[] = [];
  for (const signal of signals) {
    if (signal.category !== undefined && signal.category !== primaryCategory && !alternatives.includes(signal.category)) {
      alternatives.push(signal.category);
    }
  }
  return alternatives;
}

function strictestSensitivity(signals: ClassificationSignal[]): ImportSensitivity {
  let strictest: ImportSensitivity = "normal";
  for (const signal of signals) {
    if (signal.sensitivity !== undefined && sensitivityPriority[signal.sensitivity] > sensitivityPriority[strictest]) {
      strictest = signal.sensitivity;
    }
  }
  return strictest;
}

function categoryConfidence(signal: ClassificationSignal): number {
  return explicitUserCategory(signal) ? 1 : signal.confidence ?? 0;
}

function explicitUserCategory(signal: ClassificationSignal): boolean {
  return signal.category !== undefined && (
    signal.source === "saved_user_policy" || signal.source === "current_user_override"
  );
}

function hasCategoryConflict(signals: ClassificationSignal[]): boolean {
  for (const priority of Object.values(sourcePriority)) {
    const categories = new Set(
      signals
        .filter((signal) => sourcePriority[signal.source] === priority && signal.category !== undefined)
        .map((signal) => signal.category),
    );
    if (categories.size > 1) {
      return true;
    }
  }
  return false;
}

function snippets(values: string[]): string[] {
  return uniqueSnippets(values.map((value) => truncateEvidence(value)));
}

function uniqueSnippets(values: string[]): string[] {
  return [...new Set(values.map((value) => truncateEvidence(value)).filter(Boolean))];
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateEvidence(value: string): string {
  const normalized = normalizeLine(value);
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237).trimEnd()}...`;
}

function nonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
