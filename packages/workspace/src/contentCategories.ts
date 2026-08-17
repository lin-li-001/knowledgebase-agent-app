import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  secureAtomicReplaceWorkspaceFile,
  secureReadWorkspaceArtifact,
  secureWorkspacePathExists,
} from "./secureWorkspaceIo";
import { withWorkspaceWriteLock } from "./workspaceWriteLock";

export type ContentCategory = string;
export type ContentCategoryRisk = "normal" | "review_required";

export interface ContentCategoryDefinition {
  id: ContentCategory;
  label: string;
  description: string;
  defaultDestination: string;
  defaultRisk: ContentCategoryRisk;
  parentId?: ContentCategory;
  examples: string[];
  source: "built_in" | "user";
  kind: "parent" | "leaf";
}

export interface WorkspaceContentCategoryConfig {
  version: 1;
  activeBuiltInCategories: ContentCategory[];
  disabledBuiltInCategories: ContentCategory[];
  userCategories: ContentCategoryDefinition[];
}

export interface ContentCategoryRegistry {
  config: WorkspaceContentCategoryConfig;
  categories: ContentCategoryDefinition[];
  classifierCategories: ContentCategoryDefinition[];
  activeCategories: ContentCategoryDefinition[];
  activeCategoryIds: Set<ContentCategory>;
}

export const contentCategoryConfigPath = ".vault/content-categories.json";

export const initialActiveBuiltInCategoryIds = [
  "profile",
  "project",
  "knowledge",
  "resource",
  "unknown",
] as const satisfies readonly ContentCategory[];

export const hiddenBuiltInParentCategoryIds = [
  "finance",
  "family",
  "decision",
] as const satisfies readonly ContentCategory[];

const builtIn = (
  definition: Omit<ContentCategoryDefinition, "source">,
): ContentCategoryDefinition => ({ ...definition, source: "built_in" });

export const builtInContentCategoryCatalog: readonly ContentCategoryDefinition[] = [
  builtIn({
    id: "profile",
    label: "Profile",
    description: "Information primarily about a person's identity, education, career, or stable personal facts.",
    defaultDestination: "02-Personal/<profile-id>/",
    defaultRisk: "review_required",
    examples: ["career history", "education record", "personal profile"],
    kind: "parent",
  }),
  builtIn({
    id: "profile.career.resume",
    parentId: "profile",
    label: "Resume",
    description: "A resume or curriculum vitae summarizing employment, education, and skills.",
    defaultDestination: "02-Personal/<profile-id>/Career/Resume/",
    defaultRisk: "review_required",
    examples: ["resume", "curriculum vitae", "CV"],
    kind: "leaf",
  }),
  builtIn({
    id: "profile.career.work_history",
    parentId: "profile",
    label: "Work History",
    description: "Employment history, performance material, or detailed records of previous work.",
    defaultDestination: "02-Personal/<profile-id>/Career/Work History/",
    defaultRisk: "review_required",
    examples: ["employment history", "performance review", "promotion packet"],
    kind: "leaf",
  }),
  builtIn({
    id: "profile.education",
    parentId: "profile",
    label: "Education",
    description: "Education history, qualifications, transcripts, or certificates about a person.",
    defaultDestination: "02-Personal/<profile-id>/Education/",
    defaultRisk: "review_required",
    examples: ["transcript", "degree", "certificate"],
    kind: "leaf",
  }),
  builtIn({
    id: "profile.personal_fact",
    parentId: "profile",
    label: "Personal Fact",
    description: "Stable personal facts or preferences that may be useful as durable memory.",
    defaultDestination: "02-Personal/<profile-id>/Profile/",
    defaultRisk: "review_required",
    examples: ["preferred language", "home city", "long-term preference"],
    kind: "leaf",
  }),
  builtIn({
    id: "project",
    label: "Project",
    description: "Material whose primary purpose is to describe or operate a project.",
    defaultDestination: "01-Projects/<profile-id>/",
    defaultRisk: "normal",
    examples: ["project brief", "implementation context", "project artifact"],
    kind: "parent",
  }),
  builtIn({
    id: "project.document",
    parentId: "project",
    label: "Project Document",
    description: "A project document that cannot yet be classified more specifically.",
    defaultDestination: "01-Projects/<profile-id>/",
    defaultRisk: "normal",
    examples: ["project notes", "handoff", "project brief"],
    kind: "leaf",
  }),
  builtIn({
    id: "project.spec",
    parentId: "project",
    label: "Specification",
    description: "A product or technical specification defining requirements or expected behavior.",
    defaultDestination: "01-Projects/<profile-id>/",
    defaultRisk: "normal",
    examples: ["PRD", "technical design", "API specification"],
    kind: "leaf",
  }),
  builtIn({
    id: "project.plan",
    parentId: "project",
    label: "Plan",
    description: "A project plan, roadmap, execution plan, or implementation sequence.",
    defaultDestination: "01-Projects/<profile-id>/",
    defaultRisk: "normal",
    examples: ["roadmap", "execution plan", "milestones"],
    kind: "leaf",
  }),
  builtIn({
    id: "project.report",
    parentId: "project",
    label: "Report",
    description: "A status report, retrospective, meeting record, or account of project progress.",
    defaultDestination: "01-Projects/<profile-id>/",
    defaultRisk: "normal",
    examples: ["status report", "retrospective", "meeting notes"],
    kind: "leaf",
  }),
  builtIn({
    id: "knowledge",
    label: "Knowledge",
    description: "Reusable concepts, explanations, techniques, or synthesized understanding.",
    defaultDestination: "03-Knowledge/",
    defaultRisk: "normal",
    examples: ["technical concept", "general technique", "synthesized explanation"],
    kind: "parent",
  }),
  builtIn({
    id: "knowledge.technical",
    parentId: "knowledge",
    label: "Technical Knowledge",
    description: "Reusable technical concepts, coding documentation, patterns, or system knowledge.",
    defaultDestination: "03-Knowledge/",
    defaultRisk: "normal",
    examples: ["database indexing", "API design", "coding guide"],
    kind: "leaf",
  }),
  builtIn({
    id: "knowledge.general",
    parentId: "knowledge",
    label: "General Knowledge",
    description: "Reusable non-technical concepts or synthesized general understanding.",
    defaultDestination: "03-Knowledge/",
    defaultRisk: "normal",
    examples: ["framework", "general concept", "method"],
    kind: "leaf",
  }),
  builtIn({
    id: "resource",
    label: "Resource",
    description: "A source kept primarily for reference, reading, or learning rather than as synthesized knowledge.",
    defaultDestination: "04-Resources/",
    defaultRisk: "normal",
    examples: ["book", "paper", "course", "article"],
    kind: "parent",
  }),
  builtIn({
    id: "resource.book",
    parentId: "resource",
    label: "Book",
    description: "A book or book-length learning resource.",
    defaultDestination: "04-Resources/Books/",
    defaultRisk: "normal",
    examples: ["book", "ebook", "handbook"],
    kind: "leaf",
  }),
  builtIn({
    id: "resource.paper",
    parentId: "resource",
    label: "Paper",
    description: "An academic paper, research report, or scholarly publication.",
    defaultDestination: "04-Resources/Papers/",
    defaultRisk: "normal",
    examples: ["research paper", "white paper", "study"],
    kind: "leaf",
  }),
  builtIn({
    id: "resource.course",
    parentId: "resource",
    label: "Course",
    description: "Course material, lessons, lecture notes, or a training program.",
    defaultDestination: "04-Resources/Courses/",
    defaultRisk: "normal",
    examples: ["course", "lesson", "lecture"],
    kind: "leaf",
  }),
  builtIn({
    id: "resource.article",
    parentId: "resource",
    label: "Article",
    description: "An article, web page, or shorter reference source.",
    defaultDestination: "04-Resources/Articles/",
    defaultRisk: "normal",
    examples: ["article", "blog post", "web reference"],
    kind: "leaf",
  }),
  builtIn({
    id: "finance",
    label: "Finance",
    description: "Personal or household financial records.",
    defaultDestination: "02-Personal/<profile-id>/Finance/",
    defaultRisk: "review_required",
    examples: ["bill", "tax record", "account statement"],
    kind: "parent",
  }),
  builtIn({
    id: "finance.utility",
    parentId: "finance",
    label: "Utility",
    description: "Water, electricity, gas, internet, or other utility bills.",
    defaultDestination: "02-Personal/<profile-id>/Finance/Utilities/",
    defaultRisk: "review_required",
    examples: ["electric bill", "water bill", "utility statement"],
    kind: "leaf",
  }),
  builtIn({
    id: "finance.insurance",
    parentId: "finance",
    label: "Insurance",
    description: "Insurance policies, renewals, statements, or claims.",
    defaultDestination: "02-Personal/<profile-id>/Finance/Insurance/",
    defaultRisk: "review_required",
    examples: ["insurance policy", "premium statement", "claim"],
    kind: "leaf",
  }),
  builtIn({
    id: "finance.tax",
    parentId: "finance",
    label: "Tax",
    description: "Tax forms, returns, notices, or tax planning records.",
    defaultDestination: "02-Personal/<profile-id>/Finance/Tax/",
    defaultRisk: "review_required",
    examples: ["W-2", "1099", "tax return"],
    kind: "leaf",
  }),
  builtIn({
    id: "finance.statement",
    parentId: "finance",
    label: "Statement",
    description: "Bank, credit card, brokerage, or other financial account statements.",
    defaultDestination: "02-Personal/<profile-id>/Finance/Statements/",
    defaultRisk: "review_required",
    examples: ["bank statement", "credit card statement", "brokerage statement"],
    kind: "leaf",
  }),
  builtIn({
    id: "family",
    label: "Family",
    description: "Records primarily about a family member or household relationship.",
    defaultDestination: "02-Personal/<profile-id>/Family/",
    defaultRisk: "review_required",
    examples: ["family member profile", "dependent record", "household record"],
    kind: "parent",
  }),
  builtIn({
    id: "family.record",
    parentId: "family",
    label: "Family Record",
    description: "A document or stable record about a family member.",
    defaultDestination: "02-Personal/<profile-id>/Family/",
    defaultRisk: "review_required",
    examples: ["child record", "family profile", "dependent information"],
    kind: "leaf",
  }),
  builtIn({
    id: "decision",
    label: "Decision",
    description: "A formal document whose primary purpose is to record a durable decision and its rationale.",
    defaultDestination: "01-Projects/<profile-id>/Decisions/",
    defaultRisk: "review_required",
    examples: ["decision log", "accepted proposal", "architecture decision"],
    kind: "parent",
  }),
  builtIn({
    id: "decision.architecture",
    parentId: "decision",
    label: "Architecture Decision",
    description: "A formal architecture decision record. Ordinary project or personal decisions should be proposed as durable memory instead.",
    defaultDestination: ".vault/decisions/",
    defaultRisk: "review_required",
    examples: ["ADR", "architecture decision record", "technical choice and consequences"],
    kind: "leaf",
  }),
  builtIn({
    id: "decision.record",
    parentId: "decision",
    label: "Decision Record",
    description: "A dedicated formal decision record. Documents that merely contain decisions remain in their primary document category.",
    defaultDestination: "01-Projects/<profile-id>/Decisions/",
    defaultRisk: "review_required",
    examples: ["decision record", "approved choice", "policy decision"],
    kind: "leaf",
  }),
  builtIn({
    id: "unknown",
    label: "Unknown",
    description: "The document cannot be classified reliably and must remain in the import inbox for Review.",
    defaultDestination: "00-Inbox/Imports/",
    defaultRisk: "review_required",
    examples: ["ambiguous document", "insufficient evidence"],
    kind: "parent",
  }),
] as const;

const categoryIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const legacyContentCategoryAliases: Readonly<Record<string, ContentCategory>> = {
  "profile.career": "profile.career.work_history",
  "memory.candidate": "profile.personal_fact",
};

const categoryDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(categoryIdPattern),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000),
  defaultDestination: z.string().trim().min(1).max(500),
  defaultRisk: z.enum(["normal", "review_required"]),
  parentId: z.string().trim().min(1).max(120).regex(categoryIdPattern).optional(),
  examples: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  source: z.literal("user").default("user"),
  kind: z.enum(["parent", "leaf"]).default("leaf"),
});

const configSchema = z.object({
  version: z.literal(1),
  activeBuiltInCategories: z.array(z.string()).default([...initialActiveBuiltInCategoryIds]),
  disabledBuiltInCategories: z.array(z.string()).default([]),
  userCategories: z.array(categoryDefinitionSchema).default([]),
});

export function defaultContentCategoryConfig(): WorkspaceContentCategoryConfig {
  return {
    version: 1,
    activeBuiltInCategories: [...initialActiveBuiltInCategoryIds],
    disabledBuiltInCategories: [],
    userCategories: [],
  };
}

export function serializeContentCategoryConfig(config: WorkspaceContentCategoryConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function createContentCategoryRegistry(
  config: WorkspaceContentCategoryConfig = defaultContentCategoryConfig(),
): ContentCategoryRegistry {
  const builtInIds = new Set(builtInContentCategoryCatalog.map((category) => category.id));
  const disabled = new Set(config.disabledBuiltInCategories.filter((id) => builtInIds.has(id)));
  const userCategories = config.userCategories.filter((category) => !builtInIds.has(category.id));
  const categories = [
    ...builtInContentCategoryCatalog.filter((category) => !disabled.has(category.id)),
    ...userCategories,
  ];
  const activeCategoryIds = new Set<ContentCategory>([
    ...initialActiveBuiltInCategoryIds,
    ...config.activeBuiltInCategories.filter((id) => builtInIds.has(id) && !disabled.has(id)),
    ...userCategories.map((category) => category.id),
  ]);

  return {
    config: {
      ...config,
      activeBuiltInCategories: [...activeCategoryIds].filter((id) => builtInIds.has(id)),
      disabledBuiltInCategories: [...disabled],
      userCategories,
    },
    categories,
    classifierCategories: categories,
    activeCategories: categories.filter((category) => activeCategoryIds.has(category.id)),
    activeCategoryIds,
  };
}

export async function loadContentCategoryRegistry(workspaceRoot: string): Promise<ContentCategoryRegistry> {
  const config = await readContentCategoryConfig(workspaceRoot);
  return createContentCategoryRegistry(config);
}

export function isContentCategoryId(value: unknown): value is ContentCategory {
  return typeof value === "string" && value.length <= 120 && categoryIdPattern.test(value);
}

export function normalizeContentCategoryId(value: unknown): ContentCategory | undefined {
  if (!isContentCategoryId(value)) {
    return undefined;
  }
  return legacyContentCategoryAliases[value] ?? value;
}

export function categoryDefinition(
  registry: ContentCategoryRegistry,
  id: ContentCategory,
): ContentCategoryDefinition | undefined {
  const normalizedId = normalizeContentCategoryId(id);
  return registry.categories.find((category) => category.id === normalizedId);
}

export function isProtectedContentCategory(category: ContentCategory): boolean {
  const parent = category.split(".")[0];
  return parent === "profile" || parent === "finance" || parent === "family" || parent === "decision" || parent === "memory";
}

export function resolveCategoryDestination(input: {
  registry: ContentCategoryRegistry;
  category: ContentCategory;
  title: string;
  profileId?: string;
  year?: number;
}): string | undefined {
  const definition = categoryDefinition(input.registry, input.category);
  if (definition === undefined) {
    return undefined;
  }

  const directoryOrFile = definition.defaultDestination
    .replaceAll("<profile-id>", sanitizeSegment(input.profileId ?? "default"))
    .replaceAll("<year>", String(input.year ?? new Date().getFullYear()));
  if (directoryOrFile.endsWith("/")) {
    return `${directoryOrFile}${sanitizeSegment(input.title)}.md`;
  }
  return directoryOrFile;
}

export function renderContentCategoryContract(registry: ContentCategoryRegistry): string {
  const lines = registry.activeCategories.map((category) => {
    const parent = category.parentId ? `; parent: ${category.parentId}` : "";
    return `- \`${category.id}\`: ${category.description} Default: \`${category.defaultDestination}\`; risk: \`${category.defaultRisk}\`${parent}.`;
  });
  return [
    "<!-- BEGIN MANAGED: content-categories -->",
    "## Active Content Categories",
    "",
    "The runtime category registry is authoritative. Agents must not invent category IDs. Category, destination, and sensitivity are separate decisions.",
    "Built-in subcategories and the hidden `finance`, `family`, and `decision` parents may be proposed when matching content first appears. A hidden category requires Review before activation.",
    "Ordinary personal or project decisions should use Review-gated `propose_memory` or `propose_decision`; the hidden `decision` category is only for documents whose primary purpose is a formal decision record.",
    "",
    ...lines,
    "<!-- END MANAGED: content-categories -->",
  ].join("\n");
}

export function contentCategoryContractDrift(
  agentsContents: string,
  registry: ContentCategoryRegistry,
): boolean {
  const current = managedCategoryBlock(agentsContents);
  return current !== undefined && current !== renderContentCategoryContract(registry);
}

export async function activateWorkspaceContentCategory(
  workspaceRoot: string,
  categoryId: ContentCategory,
): Promise<ContentCategoryRegistry> {
  const normalizedCategoryId = normalizeContentCategoryId(categoryId);
  if (normalizedCategoryId === undefined) {
    throw new Error("Invalid content category ID");
  }
  const current = await loadContentCategoryRegistry(workspaceRoot);
  const currentDefinition = categoryDefinition(current, normalizedCategoryId);
  if (currentDefinition === undefined) {
    throw new Error(`Unknown content category: ${normalizedCategoryId}`);
  }
  if (currentDefinition.source === "user" || current.activeCategoryIds.has(normalizedCategoryId)) {
    return current;
  }
  return updateWorkspaceCategoryConfig(workspaceRoot, (registry) => {
    const definition = categoryDefinition(registry, normalizedCategoryId);
    if (definition === undefined) {
      throw new Error(`Unknown content category: ${normalizedCategoryId}`);
    }
    if (definition.source === "user" || registry.activeCategoryIds.has(normalizedCategoryId)) {
      return registry.config;
    }
    return {
      ...registry.config,
      activeBuiltInCategories: unique([
        ...registry.config.activeBuiltInCategories,
        ...(definition.parentId ? [definition.parentId] : []),
        normalizedCategoryId,
      ]),
    };
  });
}

export async function addWorkspaceUserContentCategory(
  workspaceRoot: string,
  definition: Omit<ContentCategoryDefinition, "source">,
): Promise<ContentCategoryRegistry> {
  const parsed = normalizeUserDefinition(
    categoryDefinitionSchema.parse({ ...definition, source: "user" }),
  );
  return updateWorkspaceCategoryConfig(workspaceRoot, (registry) => {
    if (builtInContentCategoryCatalog.some((category) => category.id === parsed.id)) {
      throw new Error(`Content category ID is reserved: ${parsed.id}`);
    }
    if (legacyContentCategoryAliases[parsed.id] !== undefined) {
      throw new Error(`Content category ID is reserved: ${parsed.id}`);
    }
    if (registry.config.userCategories.some((category) => category.id === parsed.id)) {
      throw new Error(`Content category already exists: ${parsed.id}`);
    }
    return {
      ...registry.config,
      userCategories: [...registry.config.userCategories, parsed],
    };
  });
}

async function readContentCategoryConfig(workspaceRoot: string): Promise<WorkspaceContentCategoryConfig> {
  const configPath = path.join(path.resolve(workspaceRoot), contentCategoryConfigPath);
  try {
    const parsed = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    return {
      version: 1,
      activeBuiltInCategories: unique(parsed.activeBuiltInCategories.flatMap((id) => normalizeContentCategoryId(id) ?? [])),
      disabledBuiltInCategories: unique(parsed.disabledBuiltInCategories.flatMap((id) => normalizeContentCategoryId(id) ?? [])),
      userCategories: parsed.userCategories.map(normalizeUserDefinition),
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return defaultContentCategoryConfig();
    }
    throw new Error(`Invalid ${contentCategoryConfigPath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function updateWorkspaceCategoryConfig(
  workspaceRoot: string,
  update: (registry: ContentCategoryRegistry) => WorkspaceContentCategoryConfig,
): Promise<ContentCategoryRegistry> {
  return withWorkspaceWriteLock(workspaceRoot, async (canonicalRoot) => {
    const previous = await loadContentCategoryRegistry(canonicalRoot);
    const next = createContentCategoryRegistry(update(previous));
    const configPath = path.join(canonicalRoot, contentCategoryConfigPath);
    const snapshot = await secureWorkspacePathExists(canonicalRoot, configPath)
      ? await secureReadWorkspaceArtifact(canonicalRoot, configPath, { operation: "category_config_read" })
      : undefined;
    await secureAtomicReplaceWorkspaceFile(
      canonicalRoot,
      configPath,
      serializeContentCategoryConfig(next.config),
      {
        operation: "category_config_write",
        tempToken: "content-categories",
        ...(snapshot === undefined ? { requireAbsent: true } : { expectedArtifact: snapshot.artifact }),
      },
    );
    await synchronizeManagedCategoryBlock(canonicalRoot, previous, next);
    return next;
  });
}

async function synchronizeManagedCategoryBlock(
  workspaceRoot: string,
  previous: ContentCategoryRegistry,
  next: ContentCategoryRegistry,
): Promise<void> {
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  if (!await secureWorkspacePathExists(workspaceRoot, agentsPath)) {
    return;
  }
  const snapshot = await secureReadWorkspaceArtifact(workspaceRoot, agentsPath, { operation: "category_contract_read" });
  const current = snapshot.contents.toString("utf8");
  const currentBlock = managedCategoryBlock(current);
  const previousBlock = renderContentCategoryContract(previous);
  if (currentBlock !== undefined && currentBlock !== previousBlock) {
    return;
  }
  const nextBlock = renderContentCategoryContract(next);
  const contents = currentBlock === undefined
    ? `${current.trimEnd()}\n\n${nextBlock}\n`
    : current.replace(currentBlock, nextBlock);
  await secureAtomicReplaceWorkspaceFile(workspaceRoot, agentsPath, contents, {
    operation: "category_contract_write",
    tempToken: "content-categories-contract",
    expectedArtifact: snapshot.artifact,
  });
}

function managedCategoryBlock(contents: string): string | undefined {
  return contents.match(/<!-- BEGIN MANAGED: content-categories -->[\s\S]*?<!-- END MANAGED: content-categories -->/u)?.[0];
}

function sanitizeSegment(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim() || "Untitled";
}

function normalizeUserDefinition(
  definition: z.infer<typeof categoryDefinitionSchema>,
): ContentCategoryDefinition {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    defaultDestination: definition.defaultDestination,
    defaultRisk: definition.defaultRisk,
    examples: definition.examples,
    source: "user",
    kind: definition.kind,
    ...(definition.parentId === undefined ? {} : { parentId: definition.parentId }),
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
