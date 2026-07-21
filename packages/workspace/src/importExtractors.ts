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
    throw new Error("PDF import requires the PDF parser dependency");
  }

  if (extension === ".docx") {
    throw new Error("DOCX import requires the DOCX parser dependency");
  }

  throw new Error(`Unsupported import file type: ${extension || "unknown"}`);
}
