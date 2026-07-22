import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ExtractedDocument {
  sourcePath: string;
  fileName: string;
  text: string;
}

export async function extractDocumentText(sourcePath: string): Promise<ExtractedDocument> {
  const extension = path.extname(sourcePath).toLowerCase();
  const fileName = path.basename(sourcePath);

  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    return {
      sourcePath,
      fileName,
      text: await readFile(sourcePath, "utf8"),
    };
  }

  if (extension === ".pdf") {
    await ensurePdfRuntime();
    const [{ PDFParse }, { getData }] = await Promise.all([import("pdf-parse"), import("pdf-parse/worker")]);
    PDFParse.setWorker(getData());
    const parser = new PDFParse({ data: await readFile(sourcePath) });
    try {
      const result = await parser.getText();
      return {
        sourcePath,
        fileName,
        text: result.text.trim(),
      };
    } finally {
      await parser.destroy();
    }
  }

  if (extension === ".docx") {
    throw new Error("DOCX import requires the DOCX parser dependency");
  }

  throw new Error(`Unsupported import file type: ${extension || "unknown"}`);
}

async function ensurePdfRuntime(): Promise<void> {
  const globalScope = globalThis as typeof globalThis & {
    DOMMatrix?: unknown;
    Path2D?: unknown;
    ImageData?: unknown;
  };

  if (globalScope.DOMMatrix && globalScope.Path2D && globalScope.ImageData) {
    return;
  }

  const canvas = await import("@napi-rs/canvas");
  Object.assign(globalScope, {
    DOMMatrix: globalScope.DOMMatrix ?? canvas.DOMMatrix,
    Path2D: globalScope.Path2D ?? canvas.Path2D,
    ImageData: globalScope.ImageData ?? canvas.ImageData,
  });
}
