export function SettingsRoute({ hasApiKey }: { hasApiKey: boolean }) {
  return (
    <section className="route-panel" aria-labelledby="settings-heading">
      <div className="route-header">
        <h1 id="settings-heading">Settings</h1>
      </div>
      <div className="settings-grid">
        <label>
          Workspace Root
          <input value="/local/workspace" readOnly />
        </label>
        <label>
          API Key
          <input value={hasApiKey ? "Connected" : "Not connected"} readOnly />
        </label>
        <label>
          Model
          <input defaultValue="mock" />
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
    </section>
  );
}
