import type { ContentCategory, ContentCategoryDefinition } from "@kb-agent/workspace";

const initialCategoryLabels: Readonly<Record<string, string>> = {
  profile: "Profile",
  project: "Project",
  knowledge: "Knowledge",
  resource: "Resource",
  unknown: "Unknown",
};

export const initialCategoryFallback: ContentCategoryDefinition[] = Object.entries(
  initialCategoryLabels,
).map(([id, label]) => categoryDefinitionFallback(id, label));

export function categoryDefinitionFallback(
  id: ContentCategory,
  label = id,
): ContentCategoryDefinition {
  return {
    id,
    label,
    description: "Category details are loading from the workspace registry.",
    defaultDestination: "",
    defaultRisk: "review_required",
    examples: [],
    source: "built_in",
    kind: "parent",
  };
}
