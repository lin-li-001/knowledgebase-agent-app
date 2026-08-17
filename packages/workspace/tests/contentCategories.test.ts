import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateWorkspaceContentCategory,
  addWorkspaceUserContentCategory,
  contentCategoryContractDrift,
  createContentCategoryRegistry,
  initialActiveBuiltInCategoryIds,
  loadContentCategoryRegistry,
  normalizeContentCategoryId,
  renderContentCategoryContract,
  resolveCategoryDestination,
  serializeContentCategoryConfig,
} from "../src/index";

describe("content category registry", () => {
  it("maps legacy category IDs onto the progressive taxonomy", () => {
    expect(normalizeContentCategoryId("profile.career")).toBe("profile.career.work_history");
    expect(normalizeContentCategoryId("memory.candidate")).toBe("profile.personal_fact");
  });

  it("starts with a compact active taxonomy while retaining hidden classifier candidates", () => {
    const registry = createContentCategoryRegistry();

    expect(registry.activeCategories.map((category) => category.id)).toEqual(
      initialActiveBuiltInCategoryIds,
    );
    expect(registry.activeCategoryIds.has("finance")).toBe(false);
    expect(registry.activeCategoryIds.has("decision")).toBe(false);
    expect(registry.classifierCategories.map((category) => category.id)).toContain("finance.tax");
    expect(registry.classifierCategories.map((category) => category.id)).toContain("decision.architecture");
  });

  it("activates a proposed leaf and its parent after Review", async () => {
    const root = await createCategoryWorkspace();

    const registry = await activateWorkspaceContentCategory(root, "finance.insurance");

    expect(registry.activeCategoryIds.has("finance")).toBe(true);
    expect(registry.activeCategoryIds.has("finance.insurance")).toBe(true);
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toContain("`finance.insurance`");
  });

  it("preserves a manually edited managed AGENTS block and reports drift", async () => {
    const root = await createCategoryWorkspace();
    const agentsPath = path.join(root, "AGENTS.md");
    const original = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, original.replace("## Active Content Categories", "## My Content Categories"), "utf8");

    const registry = await activateWorkspaceContentCategory(root, "resource.book");
    const after = await readFile(agentsPath, "utf8");

    expect(after).toContain("## My Content Categories");
    expect(after).not.toContain("`resource.book`");
    expect(contentCategoryContractDrift(after, registry)).toBe(true);
  });

  it("adds a user category as active and uses its destination", async () => {
    const root = await createCategoryWorkspace();

    const registry = await addWorkspaceUserContentCategory(root, {
      id: "writing.draft",
      parentId: "writing",
      label: "Writing Draft",
      description: "Drafts of personal long-form writing.",
      defaultDestination: "02-Personal/<profile-id>/Writing/Drafts/",
      defaultRisk: "normal",
      examples: [],
      kind: "leaf",
    });

    expect(registry.activeCategoryIds.has("writing.draft")).toBe(true);
    expect(resolveCategoryDestination({
      registry,
      category: "writing.draft",
      title: "A New Essay",
      profileId: "Lin",
    })).toBe("02-Personal/Lin/Writing/Drafts/A New Essay.md");
  });
});

async function createCategoryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kb-agent-categories-"));
  await mkdir(path.join(root, ".vault"), { recursive: true });
  const registry = createContentCategoryRegistry();
  await writeFile(
    path.join(root, ".vault/content-categories.json"),
    serializeContentCategoryConfig(registry.config),
    "utf8",
  );
  await writeFile(
    path.join(root, "AGENTS.md"),
    `# Workspace\n\n${renderContentCategoryContract(registry)}\n`,
    "utf8",
  );
  return root;
}
