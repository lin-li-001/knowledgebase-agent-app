import { useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { ChatRoute } from "./routes/ChatRoute";
import { KnowledgeRoute } from "./routes/KnowledgeRoute";
import { ReviewRoute } from "./routes/ReviewRoute";
import { SettingsRoute } from "./routes/SettingsRoute";
import "./styles.css";

type Route = "Chat" | "Knowledge" | "Review" | "Settings";

const routes: Route[] = ["Chat", "Knowledge", "Review", "Settings"];

export function App() {
  const [activeRoute, setActiveRoute] = useState<Route>("Chat");
  const hasWorkspace = true;
  const hasApiKey = false;
  const reviewItems = [
    {
      id: "review-1",
      proposalType: "memory",
      risk: "high",
      targetPath: "02-Profiles/default/Memory.md",
      reason: "Durable preference requires Review.",
    },
  ];

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
        {activeRoute === "Chat" ? <ChatRoute hasWorkspace={hasWorkspace} hasApiKey={hasApiKey} turnState="idle" /> : null}
        {activeRoute === "Knowledge" ? <KnowledgeRoute rebuilding={false} /> : null}
        {activeRoute === "Review" ? <ReviewRoute items={reviewItems} /> : null}
        {activeRoute === "Settings" ? <SettingsRoute hasApiKey={hasApiKey} /> : null}
      </div>
      <ActivityFeed items={[]} />
    </main>
  );
}
