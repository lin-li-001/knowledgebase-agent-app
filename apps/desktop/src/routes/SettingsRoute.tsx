import { useState } from "react";

export function SettingsRoute({
  hasApiKey,
  modelName,
  workspaceRoot,
  onSave,
}: {
  hasApiKey: boolean;
  modelName: string;
  workspaceRoot: string;
  onSave(settings: { apiKey?: string; modelName?: string }): Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(modelName);

  return (
    <section className="route-panel" aria-labelledby="settings-heading">
      <div className="route-header">
        <h1 id="settings-heading">Settings</h1>
      </div>
      <div className="settings-grid">
        <label>
          Workspace Root
          <input value={workspaceRoot || "No workspace selected"} readOnly />
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
      <button type="button" onClick={() => void onSave({ apiKey, modelName: model })}>
        Save Settings
      </button>
    </section>
  );
}
