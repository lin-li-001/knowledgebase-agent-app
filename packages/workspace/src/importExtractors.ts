import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

export interface ExtractedDocument {
  sourcePath: string;
  fileName: string;
  text: string;
  markdownBody: string;
  pageCount?: number;
  requiresOcr?: boolean;
}

export async function extractDocumentText(
  sourcePath: string,
  verifiedContents: Buffer,
): Promise<ExtractedDocument> {
  const extension = path.extname(sourcePath).toLowerCase();
  const fileName = path.basename(sourcePath);

  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    const text = verifiedContents.toString("utf8");
    return {
      sourcePath,
      fileName,
      text,
      markdownBody: text,
    };
  }

  if (extension === ".pdf") {
    await ensurePdfRuntime();
    const [{ PDFParse }, { getData }] = await Promise.all([import("pdf-parse"), import("pdf-parse/worker")]);
    PDFParse.setWorker(getData());
    const parser = new PDFParse({ data: verifiedContents });
    try {
      const result = await parser.getText();
      const pages = result.pages.map((page) => page.text.trim());
      const requiresOcr = result.total > 0 && pages.every((text) => text.length === 0);
      if (requiresOcr) {
        const ocr = await tryOcrPdf(verifiedContents, result.total);
        if (ocr !== undefined) {
          return {
            sourcePath,
            fileName,
            text: ocr.text,
            markdownBody: ocr.markdownBody,
            pageCount: result.total,
            requiresOcr: false,
          };
        }
      }
      return {
        sourcePath,
        fileName,
        text: result.text.trim(),
        markdownBody: pages
          .map((text, index) => `<!-- Page ${index + 1} -->\n\n${text}`)
          .join("\n\n"),
        pageCount: result.total,
        requiresOcr,
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

async function tryOcrPdf(contents: Buffer, pageCount: number): Promise<{ text: string; markdownBody: string } | undefined> {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "kb-agent-ocr-"));
  const pdfPath = path.join(workingDirectory, "source.pdf");
  const pagePrefix = path.join(workingDirectory, "page");
  try {
    await writeFile(pdfPath, contents);
    await execFileAsync("pdftoppm", ["-png", "-r", "150", pdfPath, pagePrefix]);
    const pageFiles = (await readdir(workingDirectory))
      .filter((fileName) => /^page-\d+\.png$/u.test(fileName))
      .sort((left, right) => pageNumber(left) - pageNumber(right));
    if (pageFiles.length !== pageCount || pageFiles.length === 0) {
      return undefined;
    }

    const language = await ocrLanguage();
    const pages: string[] = [];
    for (const pageFile of pageFiles) {
      const { stdout } = await execFileAsync("tesseract", [
        path.join(workingDirectory, pageFile),
        "stdout",
        "-l",
        language,
        "--psm",
        "3",
      ], { maxBuffer: 8 * 1024 * 1024 });
      pages.push(stdout.trim());
    }
    if (pages.every((page) => page.length === 0)) {
      return undefined;
    }
    return {
      text: pages.join("\n\n").trim(),
      markdownBody: pages
        .map((page, index) => `<!-- Page ${index + 1} -->\n\n${page}`)
        .join("\n\n"),
    };
  } catch {
    return undefined;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ocrLanguage(): Promise<string> {
  const configured = process.env.KB_AGENT_OCR_LANG?.trim();
  if (configured) {
    return configured;
  }
  try {
    const { stdout } = await execFileAsync("tesseract", ["--list-langs"]);
    return stdout.includes("chi_sim") ? "eng+chi_sim" : "eng";
  } catch {
    return "eng";
  }
}

function pageNumber(fileName: string): number {
  return Number(fileName.match(/-(\d+)\.png$/u)?.[1] ?? 0);
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
