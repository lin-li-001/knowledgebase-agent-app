import { useState } from "react";
import type { ContentCategoryDefinition, ContentCategoryRisk } from "@kb-agent/workspace";

export function SettingsRoute({
  hasApiKey,
  modelName,
  embeddingBaseUrl,
  embeddingModel,
  workspaceRoot,
  desktopBridgeReady,
  activeCategories,
  onSave,
  onOpenWorkspace,
  onCreateWorkspace,
  onCreateCategory,
}: {
  hasApiKey: boolean;
  modelName: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  workspaceRoot: string;
  desktopBridgeReady: boolean;
  activeCategories: ContentCategoryDefinition[];
  onSave(settings: { apiKey?: string; modelName?: string; embeddingBaseUrl?: string; embeddingModel?: string }): Promise<void>;
  onOpenWorkspace(rootPath: string): Promise<void>;
  onCreateWorkspace(rootPath: string): Promise<void>;
  onCreateCategory(input: {
    id: string;
    label: string;
    description: string;
    defaultDestination: string;
    defaultRisk: ContentCategoryRisk;
    parentId?: string;
  }): Promise<boolean>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(modelName);
  const [embeddingUrl, setEmbeddingUrl] = useState(embeddingBaseUrl);
  const [embedding, setEmbedding] = useState(embeddingModel);
  const [rootPath, setRootPath] = useState(workspaceRoot);
  const [categoryId, setCategoryId] = useState("");
  const [categoryLabel, setCategoryLabel] = useState("");
  const [categoryDescription, setCategoryDescription] = useState("");
  const [categoryDestination, setCategoryDestination] = useState("");
  const [categoryRisk, setCategoryRisk] = useState<ContentCategoryRisk>("normal");
  const [categoryParent, setCategoryParent] = useState("");

  async function createCategory() {
    const created = await onCreateCategory({
      id: categoryId.trim(),
      label: categoryLabel.trim(),
      description: categoryDescription.trim(),
      defaultDestination: categoryDestination.trim(),
      defaultRisk: categoryRisk,
      ...(categoryParent.trim() ? { parentId: categoryParent.trim() } : {}),
    });
    if (!created) {
      return;
    }
    setCategoryId("");
    setCategoryLabel("");
    setCategoryDescription("");
    setCategoryDestination("");
    setCategoryRisk("normal");
    setCategoryParent("");
  }

  return (
    <section className="route-panel" aria-labelledby="settings-heading">
      <div className="route-header">
        <h1 id="settings-heading">Settings</h1>
      </div>
      {!desktopBridgeReady ? <p className="inline-note">Desktop bridge unavailable in browser preview.</p> : null}
      <div className="settings-grid">
        <label>
          Workspace Root
          <input
            value={rootPath}
            placeholder="/Users/name/Knowledgebase"
            onChange={(event) => setRootPath(event.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            value={apiKey}
            placeholder={hasApiKey ? "Connected" : "Paste API key"}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label>
          Model
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label>
          Embedding URL
          <input value={embeddingUrl} onChange={(event) => setEmbeddingUrl(event.target.value)} />
        </label>
        <label>
          Embedding Model
          <input value={embedding} onChange={(event) => setEmbedding(event.target.value)} />
        </label>
        <label>
          Auto-save Feedback
          <select defaultValue="activity-feed">
            <option value="activity-feed">Activity Feed</option>
          </select>
        </label>
        <label>
          Import Destination
          <input value="Available in v0.1B" readOnly />
        </label>
      </div>
      <div className="button-row">
        <button type="button" disabled={!desktopBridgeReady} onClick={() => void onOpenWorkspace(rootPath)}>
          Open Workspace
        </button>
        <button type="button" className="secondary-button" disabled={!desktopBridgeReady} onClick={() => void onCreateWorkspace(rootPath)}>
          Create Workspace
        </button>
      </div>
      <button type="button" disabled={!desktopBridgeReady} onClick={() => void onSave({ apiKey, modelName: model, embeddingBaseUrl: embeddingUrl, embeddingModel: embedding })}>
        Save Settings
      </button>
      <section className="category-settings" aria-labelledby="category-settings-heading">
        <h2 id="category-settings-heading">Content Categories</h2>
        <div className="category-list" aria-label="Active content categories">
          {activeCategories.map((category) => (
            <span key={category.id}>{category.label}</span>
          ))}
        </div>
        <div className="settings-grid">
          <label>
            Category ID
            <input value={categoryId} placeholder="writing.draft" onChange={(event) => setCategoryId(event.target.value)} />
          </label>
          <label>
            Label
            <input value={categoryLabel} placeholder="Writing Draft" onChange={(event) => setCategoryLabel(event.target.value)} />
          </label>
          <label>
            Description
            <input value={categoryDescription} onChange={(event) => setCategoryDescription(event.target.value)} />
          </label>
          <label>
            Default Destination
            <input value={categoryDestination} placeholder="02-Personal/default/Writing/" onChange={(event) => setCategoryDestination(event.target.value)} />
          </label>
          <label>
            Parent ID
            <input value={categoryParent} placeholder="writing" onChange={(event) => setCategoryParent(event.target.value)} />
          </label>
          <label>
            Risk
            <select value={categoryRisk} onChange={(event) => setCategoryRisk(event.target.value as ContentCategoryRisk)}>
              <option value="normal">Normal</option>
              <option value="review_required">Review Required</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          disabled={!desktopBridgeReady || !workspaceRoot || !categoryId.trim() || !categoryLabel.trim() || !categoryDescription.trim() || !categoryDestination.trim()}
          onClick={() => void createCategory()}
        >
          Create Category
        </button>
      </section>
    </section>
  );
}
