import { useEffect, useMemo, useState } from "react";
import type { ActivityItem } from "./components/ActivityFeed";
import type { ReviewApprovalOptions, ReviewCardItem } from "./components/ReviewItemCard";
import { WorkspacePanel, type WorkspaceFilePreview, type WorkspaceTreeNode } from "./components/WorkspacePanel";
import { ChatRoute } from "./routes/ChatRoute";
import { KnowledgeRoute, type WorkspaceAuditResult } from "./routes/KnowledgeRoute";
import { ReviewRoute } from "./routes/ReviewRoute";
import { SettingsRoute } from "./routes/SettingsRoute";
import { createRendererApi, type RendererApi } from "./state/api";
import "./styles.css";

type Route = "Chat" | "Knowledge" | "Review" | "Settings";

const routes: Route[] = ["Chat", "Knowledge", "Review", "Settings"];

interface WorkspaceState {
  rootPath: string;
  workspaceId: string;
  sessionId: string;
}

interface SettingsState {
  hasApiKey: boolean;
  modelName?: string;
}

interface ChatSource {
  title: string;
  path: string;
  text?: string;
  snippet?: string;
  matchedFields?: string[];
}

type ChatMessage =
  | { role: "assistant" | "user" | "error"; content: string }
  | { role: "sources"; sources: ChatSource[] };

interface ChatTurnEvent {
  type: string;
  content?: string;
  error?: string;
  sources?: ChatSource[];
}

declare global {
  interface Window {
    kbAgent?: {
      invoke: RendererApi["invoke"];
    };
  }
}

export function App() {
  const [activeRoute, setActiveRoute] = useState<Route>("Chat");
  const api = useMemo(() => (window.kbAgent ? createRendererApi(window.kbAgent.invoke) : null), []);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [settings, setSettings] = useState<SettingsState>({ hasApiKey: false, modelName: "mock" });
  const [reviewItems, setReviewItems] = useState<ReviewCardItem[]>([]);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceTreeNode | null>(null);
  const [filePreview, setFilePreview] = useState<WorkspaceFilePreview | null>(null);
  const [auditResult, setAuditResult] = useState<WorkspaceAuditResult | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Ask about your notes or propose a safe knowledge update." },
  ]);
  const [turnState, setTurnState] = useState<"idle" | "queued" | "streaming" | "tool-running" | "interrupted" | "failed" | "complete">("idle");
  const [error, setError] = useState<string | null>(null);
  const desktopBridgeReady = Boolean(api);

  async function refreshPanels() {
    if (!api) {
      setError("Desktop bridge unavailable in browser preview.");
      return;
    }

    const [workspaceResult, settingsResult] = await Promise.all([
      api.invoke<WorkspaceState | null>("workspace:get-active", {}),
      api.invoke<SettingsState>("settings:get", {}),
    ]);
    if (workspaceResult.ok) {
      setWorkspace(workspaceResult.data);
    }
    if (settingsResult.ok) {
      setSettings(settingsResult.data);
    }

    if (workspaceResult.ok && workspaceResult.data) {
      const [activityResult, reviewResult, treeResult] = await Promise.all([
        api.invoke<ActivityItem[]>("activity:list", {}),
        api.invoke<ReviewCardItem[]>("review:list", {}),
        api.invoke<WorkspaceTreeNode>("workspace:tree", {}),
      ]);
      if (activityResult.ok) {
        setActivityItems(activityResult.data);
      }
      if (reviewResult.ok) {
        setReviewItems(reviewResult.data);
      }
      if (treeResult.ok) {
        setWorkspaceTree(treeResult.data);
      }
    } else {
      setWorkspaceTree(null);
      setFilePreview(null);
    }
  }

  useEffect(() => {
    void refreshPanels();
  }, [api]);

  async function runChatTurn(message: string) {
    if (!api || !workspace) {
      return;
    }

    setError(null);
    setTurnState("queued");
    setChatMessages((messages) => [...messages, { role: "user", content: message }]);
    const result = await api.invoke<{ events: ChatTurnEvent[] }>("chat:run-turn", {
      sessionId: workspace.sessionId,
      message,
    });
    if (!result.ok) {
      setTurnState("failed");
      setError(result.error);
      return;
    }

    const assistantMessages = result.data.events.flatMap((event): ChatMessage[] => {
      if (event.type === "sources" && event.sources?.length) {
        return [{ role: "sources", sources: event.sources }];
      }
      if (event.type === "message" && event.content) {
        return [{ role: "assistant", content: event.content }];
      }
      if (event.type === "error" && event.error) {
        return [{ role: "error", content: `Error: ${event.error}` }];
      }
      return [];
    });
    setChatMessages((messages) => [...messages, ...assistantMessages]);
    const errorEvent = result.data.events.find((event) => event.type === "error");
    if (errorEvent?.error) {
      setError(errorEvent.error);
    }
    setTurnState(errorEvent ? "failed" : "complete");
    await refreshPanels();
  }

  async function cancelTurn() {
    if (!api || !workspace) {
      return;
    }

    await api.invoke("chat:cancel-turn", { sessionId: workspace.sessionId });
    setTurnState("interrupted");
  }

  async function rebuildIndex() {
    if (!api || !workspace) {
      return;
    }

    setError(null);
    const result = await api.invoke("index:rebuild", {});
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshPanels();
  }

  async function runWorkspaceAudit() {
    if (!api || !workspace) {
      return;
    }

    setError(null);
    setAuditing(true);
    const result = await api.invoke<WorkspaceAuditResult>("workspace:audit", {});
    setAuditing(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAuditResult(result.data);
    await refreshPanels();
  }

  async function runImportBatch(input: { batchName: string; filePaths: string[] }) {
    if (!api || !workspace) {
      setError("Create or open a workspace before importing.");
      return;
    }

    setError(null);
    const result = await api.invoke<{ state: string; summaryNotePath?: string; failureReason?: string }>("import:start", input);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.data.state === "failed") {
      setError(result.data.failureReason ?? "Import failed.");
    }
    await refreshPanels();
  }

  async function updateSettings(next: { apiKey?: string; modelName?: string }) {
    if (!api) {
      setError("Desktop bridge unavailable in browser preview.");
      return;
    }

    const result = await api.invoke<SettingsState>("settings:update", next);
    if (result.ok) {
      setSettings(result.data);
    } else {
      setError(result.error);
    }
  }

  async function activateWorkspace(channel: "workspace:open" | "workspace:create", rootPath: string) {
    if (!api) {
      return;
    }

    setError(null);
    const trimmed = rootPath.trim();
    if (!trimmed) {
      setError("Workspace path is required.");
      return;
    }

    const result = await api.invoke<WorkspaceState>(channel, { rootPath: trimmed });
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setWorkspace(result.data);
    await refreshPanels();
  }

  async function updateReviewState(channel: "review:approve" | "review:reject", id: string, options?: ReviewApprovalOptions) {
    if (!api) {
      return;
    }

    const result = await api.invoke(channel, { id, ...(options ?? {}) });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshPanels();
  }

  async function readWorkspaceFile(filePath: string) {
    if (!api || !workspace) {
      return;
    }

    setError(null);
    const result = await api.invoke<WorkspaceFilePreview>("workspace:read-file", { path: filePath });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setFilePreview(result.data);
  }

  return (
    <main className="app-shell">
      <nav className="sidebar" aria-label="Primary">
        <div className="brand">Knowledgebase Agent</div>
        {routes.map((route) => (
          <button
            key={route}
            type="button"
            className={route === activeRoute ? "nav-button active" : "nav-button"}
            onClick={() => setActiveRoute(route)}
          >
            {route}
          </button>
        ))}
      </nav>
      <div className="content-area">
        {error ? <p className="error-text">{error}</p> : null}
        {activeRoute === "Chat" ? (
          <ChatRoute
            messages={chatMessages}
            hasWorkspace={Boolean(workspace)}
            hasApiKey={settings.hasApiKey}
            turnState={turnState}
            onSend={runChatTurn}
            onCancel={cancelTurn}
          />
        ) : null}
        {activeRoute === "Knowledge" ? (
          <KnowledgeRoute
            rebuilding={false}
            auditing={auditing}
            importDisabled={!workspace}
            auditResult={auditResult}
            onRebuild={rebuildIndex}
            onAudit={runWorkspaceAudit}
            onImport={runImportBatch}
          />
        ) : null}
        {activeRoute === "Review" ? (
          <ReviewRoute
            items={reviewItems}
            onApprove={(id, options) => updateReviewState("review:approve", id, options)}
            onReject={(id) => updateReviewState("review:reject", id)}
          />
        ) : null}
        {activeRoute === "Settings" ? (
          <SettingsRoute
            hasApiKey={settings.hasApiKey}
            modelName={settings.modelName ?? "mock"}
            workspaceRoot={workspace?.rootPath ?? ""}
            desktopBridgeReady={desktopBridgeReady}
            onSave={updateSettings}
            onOpenWorkspace={(rootPath) => activateWorkspace("workspace:open", rootPath)}
            onCreateWorkspace={(rootPath) => activateWorkspace("workspace:create", rootPath)}
          />
        ) : null}
      </div>
      <WorkspacePanel
        activityItems={activityItems}
        tree={workspaceTree}
        preview={filePreview}
        hasWorkspace={Boolean(workspace)}
        onReadFile={readWorkspaceFile}
      />
    </main>
  );
}
