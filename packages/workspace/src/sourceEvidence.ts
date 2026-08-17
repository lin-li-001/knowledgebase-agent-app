import { createHash } from "node:crypto";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./markdown";

export const sourceBodyStartMarker = "<!-- kb-agent:source-body:start -->";
export const sourceBodyEndMarker = "<!-- kb-agent:source-body:end -->";

export interface ImportedSourceAnnotationInput {
  body: string;
  date: string;
  reviewItemId: string;
  sessionId: string;
  turnId: string;
}

export function importedSourceBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function wrapImportedSourceBody(body: string): string {
  if (body.includes(sourceBodyStartMarker) || body.includes(sourceBodyEndMarker)) {
    throw new Error("Imported source body contains a reserved source marker");
  }
  return `${sourceBodyStartMarker}\n${body}\n${sourceBodyEndMarker}`;
}

export function appendImportedSourceAnnotation(
  raw: string,
  input: ImportedSourceAnnotationInput,
): string {
  const annotation = input.body.trim();
  if (!annotation) {
    throw new Error("Annotation body is required");
  }
  if (annotation.includes(sourceBodyStartMarker) || annotation.includes(sourceBodyEndMarker)) {
    throw new Error("Annotation contains a reserved source marker");
  }

  const document = parseMarkdownDocument(raw);
  if (
    document.frontmatter.source_type !== "import"
    || document.frontmatter.source_integrity !== "source_evidence"
    || !document.frontmatter.source_body_sha256
  ) {
    throw new Error("Target is not verified imported source evidence");
  }

  const sourceBody = extractImportedSourceBody(document.content);
  if (importedSourceBodyHash(sourceBody) !== document.frontmatter.source_body_sha256) {
    throw new Error("Imported source body integrity check failed");
  }

  const existingAnnotations = document.content.slice(
    document.content.indexOf(sourceBodyEndMarker) + sourceBodyEndMarker.length,
  );
  if (existingAnnotations.includes(annotation)) {
    return raw;
  }

  const provenance = `_Source: chat | session \`${sanitizeIdentifier(input.sessionId)}\` | turn \`${sanitizeIdentifier(input.turnId)}\` | review \`${sanitizeIdentifier(input.reviewItemId)}\`_`;
  const entry = `### ${input.date}\n\n${annotation}\n\n${provenance}`;
  const annotationsHeading = /^## Annotations\s*$/mu;
  document.content = annotationsHeading.test(document.content)
    ? `${document.content.trimEnd()}\n\n${entry}\n`
    : `${document.content.trimEnd()}\n\n## Annotations\n\n${entry}\n`;
  return serializeMarkdownDocument(document);
}

export function assertImportedSourceBodyPreserved(currentRaw: string, nextRaw: string): void {
  if (!/(?:^|\n)source_type:\s*import\s*$/mu.test(currentRaw)) {
    return;
  }
  const current = parseMarkdownDocument(currentRaw);
  if (current.frontmatter.source_type !== "import") {
    return;
  }
  if (
    current.frontmatter.source_integrity !== "source_evidence"
    || !current.frontmatter.source_body_sha256
  ) {
    throw new Error("Imported source documents require a source-safe proposal");
  }

  const currentBody = extractImportedSourceBody(current.content);
  const next = parseMarkdownDocument(nextRaw);
  const nextBody = extractImportedSourceBody(next.content);
  const expectedHash = current.frontmatter.source_body_sha256;
  if (
    next.frontmatter.source_type !== "import"
    || next.frontmatter.source_integrity !== "source_evidence"
    || next.frontmatter.source_sha256 !== current.frontmatter.source_sha256
    || next.frontmatter.source_body_sha256 !== expectedHash
    || next.frontmatter.extraction_version !== current.frontmatter.extraction_version
  ) {
    throw new Error("Imported source identity metadata cannot be modified");
  }
  if (
    importedSourceBodyHash(currentBody) !== expectedHash
    || importedSourceBodyHash(nextBody) !== expectedHash
  ) {
    throw new Error("Imported source body cannot be modified");
  }
}

function extractImportedSourceBody(content: string): string {
  const startIndex = content.indexOf(sourceBodyStartMarker);
  const endIndex = content.indexOf(sourceBodyEndMarker, startIndex + sourceBodyStartMarker.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error("Target is not verified imported source evidence");
  }

  const bodyStart = startIndex + sourceBodyStartMarker.length;
  const beforeBody = content.slice(bodyStart, bodyStart + 2);
  const offset = beforeBody === "\r\n" ? 2 : beforeBody.startsWith("\n") ? 1 : 0;
  const rawBody = content.slice(bodyStart + offset, endIndex);
  return rawBody.endsWith("\r\n")
    ? rawBody.slice(0, -2)
    : rawBody.endsWith("\n")
      ? rawBody.slice(0, -1)
      : rawBody;
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[`\r\n]/gu, "").trim() || "unknown";
}
