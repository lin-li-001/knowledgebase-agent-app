import { useState } from "react";

export function SettingsRoute({
  hasApiKey,
  modelName,
  embeddingBaseUrl,
  embeddingModel,
  workspaceRoot,
  desktopBridgeReady,
  onSave,
  onOpenWorkspace,
  onCreateWorkspace,
}: {
  hasApiKey: boolean;
  modelName: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  workspaceRoot: string;
  desktopBridgeReady: boolean;
  onSave(settings: { apiKey?: string; modelName?: string; embeddingBaseUrl?: string; embeddingModel?: string }): Promise<void>;
  onOpenWorkspace(rootPath: string): Promise<void>;
  onCreateWorkspace(rootPath: string): Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(modelName);
  const [embeddingUrl, setEmbeddingUrl] = useState(embeddingBaseUrl);
  const [embedding, setEmbedding] = useState(embeddingModel);
  const [rootPath, setRootPath] = useState(workspaceRoot);

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
    </section>
  );
}
