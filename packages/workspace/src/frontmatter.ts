import { z } from "zod";

const frontmatterDate = z.preprocess((value) => {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value;
}, z.string().min(1));

export const noteFrontmatterSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["inbox", "project", "knowledge", "memory", "decision", "resource", "profile"]),
  status: z.string().min(1),
  owner: z.string().min(1),
  scope: z.enum(["personal", "shared"]),
  sensitivity: z.enum(["normal", "personal", "private", "restricted", "sensitive"]),
  created: frontmatterDate,
  updated: frontmatterDate.optional(),
  tags: z.array(z.string()),
  summary: z.string().optional(),
  source_type: z.string().optional(),
  source_file: z.string().optional(),
  source_files: z.array(z.string()).optional(),
  content_category: z.string().min(1).optional(),
  classification_confidence: z.number().min(0).max(1).optional(),
  classification_evidence: z.array(z.string()).optional(),
  review_decision: z.enum(["auto_write", "review_required", "blocked"]).optional(),
  safety_reason_codes: z.array(z.string()).optional(),
  route_status: z.string().min(1).optional(),
  route_destination: z.string().min(1).optional(),
  page_count: z.number().int().positive().optional(),
  requires_ocr: z.boolean().optional(),
});

export type NoteFrontmatter = z.infer<typeof noteFrontmatterSchema>;

export function parseFrontmatter(data: unknown): NoteFrontmatter {
  const result = noteFrontmatterSchema.safeParse(data);

  if (!result.success) {
    const firstIssue = result.error.issues[0];
    if (firstIssue?.path[0]) {
      throw new Error(`Invalid frontmatter field ${String(firstIssue.path[0])}: ${firstIssue.message}`);
    }

    throw new Error("Invalid frontmatter");
  }

  return result.data;
}
