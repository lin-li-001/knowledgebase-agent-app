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
    const { PDFParse } = await import("pdf-parse");
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
