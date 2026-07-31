import { createHash } from "node:crypto";

export interface ImportedChunk {
  id: string;
  noteId: string;
  text: string;
  headingPath: string[];
  pageNumber?: number;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export interface ChunkMarkdownOptions {
  noteId: string;
  maxCharacters?: number;
}

const pageMarker = /^<!--\s*Page\s+(\d+)\s*-->$/u;
const headingPattern = /^(#{1,6})\s+(.+?)\s*$/u;

export function chunkMarkdownBody(body: string, options: ChunkMarkdownOptions): ImportedChunk[] {
  const maxCharacters = options.maxCharacters ?? 1_600;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("Chunk maxCharacters must be a positive integer");
  }

  const lines = body.split(/\r?\n/u);
  const headings: Array<string | undefined> = [];
  const chunks: ImportedChunk[] = [];
  let pageNumber: number | undefined;
  let buffer: string[] = [];
  let bufferStartLine = 0;
  let bufferPageNumber: number | undefined;
  let bufferHeadingPath: string[] = [];
  let chunkIndex = 0;

  const flush = (endLine: number): void => {
    const text = buffer.join("\n").trim();
    if (!text) {
      buffer = [];
      bufferStartLine = 0;
      bufferPageNumber = undefined;
      return;
    }

    chunks.push({
      id: `${options.noteId}:${chunkIndex}`,
      noteId: options.noteId,
      text,
      headingPath: bufferHeadingPath,
      ...(bufferPageNumber === undefined ? {} : { pageNumber: bufferPageNumber }),
      startLine: bufferStartLine,
      endLine,
      tokenCount: text.split(/\s+/u).filter(Boolean).length,
    });
    chunkIndex += 1;
    buffer = [];
      bufferStartLine = 0;
      bufferPageNumber = undefined;
      bufferHeadingPath = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? "";
    const page = line.match(pageMarker);
    if (page) {
      flush(lineNumber - 1);
      pageNumber = Number(page[1]);
      continue;
    }

    const heading = line.match(headingPattern);
    if (heading) {
      flush(lineNumber - 1);
      const level = heading[1]?.length ?? 1;
      headings.length = level - 1;
      headings[level - 1] = heading[2]?.trim() ?? "";
    }

    const parts = splitLine(line, maxCharacters);
    for (const part of parts) {
      if (!bufferStartLine) {
        bufferStartLine = lineNumber;
        bufferPageNumber = pageNumber;
        bufferHeadingPath = headings.filter((heading): heading is string => Boolean(heading));
      }
      const candidate = [...buffer, part].join("\n").trim();
      if (buffer.length > 0 && candidate.length > maxCharacters) {
        flush(lineNumber - 1);
        bufferStartLine = lineNumber;
        bufferPageNumber = pageNumber;
      }
      buffer.push(part);
      if (buffer.join("\n").length >= maxCharacters) {
        flush(lineNumber);
      }
    }
  }

  flush(lines.length);
  return chunks.map((chunk, index) => ({
    ...chunk,
    id: `${options.noteId}:${index}:${createHash("sha256").update(chunk.text).digest("hex").slice(0, 12)}`,
  }));
}

function splitLine(line: string, maxCharacters: number): string[] {
  if (line.length <= maxCharacters) {
    return [line];
  }

  const parts: string[] = [];
  for (let start = 0; start < line.length; start += maxCharacters) {
    parts.push(line.slice(start, start + maxCharacters));
  }
  return parts;
}
