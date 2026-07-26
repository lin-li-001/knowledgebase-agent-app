// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ImportDropzone } from "../src/components/ImportDropzone";
import { ReviewItemCard } from "../src/components/ReviewItemCard";
import { ChatRoute } from "../src/routes/ChatRoute";
import { KnowledgeRoute } from "../src/routes/KnowledgeRoute";

describe("desktop shell", () => {
  afterEach(() => {
    cleanup();
    window.kbAgent = undefined;
  });

  it("renders primary navigation and Activity", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "Chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Knowledge" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Activity" })).toBeVisible();
    expect(screen.getByText("No activity yet")).toBeVisible();
  });

  it("renders review proposal payload details", () => {
    render(
      <ReviewItemCard
        item={{
          id: "review-1",
          state: "proposed",
          proposalType: "propose_memory",
          risk: "high",
          reason: "Model proposed a knowledge-base change.",
          sourceSessionId: "session-1",
          sourceTurnId: "turn-1",
          payload: {
            body: "Lin Li has two kids, Grace and Leo.",
            source: {
              origin: "turn_reflection",
              userMessage: "hello my name is lin li, i have two kids grace and leo",
              assistantMessage: "Nice to meet you, Lin Li.",
              reason: "Stable personal profile fact.",
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Memory proposal")).toBeVisible();
    expect(screen.getByText("Memory to save")).toBeVisible();
    expect(screen.getByText("Lin Li has two kids, Grace and Leo.")).toBeVisible();
    expect(screen.getByText("proposed")).toBeVisible();
    expect(screen.getByText("From session session-1, turn turn-1")).toBeVisible();
    expect(screen.getByText("Why this was proposed")).toBeVisible();
    expect(screen.getByText("Stable personal profile fact.")).toBeVisible();
    expect(screen.getByText("User message")).toBeVisible();
    expect(screen.getByText("hello my name is lin li, i have two kids grace and leo")).toBeVisible();
    expect(screen.getByText("Assistant message")).toBeVisible();
    expect(screen.getByText("Nice to meet you, Lin Li.")).toBeVisible();
  });

  it("disables review actions after a proposal is applied", () => {
    render(
      <ReviewItemCard
        item={{
          id: "review-1",
          state: "applied",
          proposalType: "propose_memory",
          risk: "high",
          reason: "Model proposed a knowledge-base change.",
          payload: { body: "User's name is Lin Li." },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("renders import controls for document batches", () => {
    render(<ImportDropzone disabled={false} onImport={async () => undefined} />);

    expect(screen.getByLabelText("Batch name")).toBeVisible();
    expect(screen.getByLabelText("Import files")).toBeVisible();
    expect(screen.getByRole("button", { name: "Import Documents" })).toBeDisabled();
  });

  it("renders workspace audit findings in the Knowledge route", () => {
    render(
      <KnowledgeRoute
        rebuilding={false}
        auditing={false}
        importDisabled={false}
        auditResult={{
          status: "fail",
          findings: [
            {
              code: "missing_frontmatter",
              severity: "error",
              path: "03-Knowledge/Broken.md",
              message: "Invalid frontmatter field title",
            },
          ],
        }}
        onRebuild={async () => undefined}
        onAudit={async () => undefined}
        onImport={async () => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Run Audit" })).toBeVisible();
    expect(screen.getByText("Workspace audit: fail")).toBeVisible();
    expect(screen.getByText("missing_frontmatter")).toBeVisible();
    expect(screen.getByText("03-Knowledge/Broken.md")).toBeVisible();
  });

  it("renders assistant markdown as visual structure", () => {
    render(
      <ChatRoute
        messages={[
          {
            role: "assistant",
            content: "## SQL topics\n\n- Window functions\n- Join optimization\n\n```sql\nSELECT user_id FROM events\n```",
          },
        ]}
        hasWorkspace
        hasApiKey
        turnState="complete"
        onSend={async () => undefined}
        onCancel={async () => undefined}
      />,
    );

    expect(screen.getByRole("heading", { name: "SQL topics" })).toBeVisible();
    expect(screen.getByRole("list")).toBeVisible();
    expect(screen.getByText("Window functions")).toBeVisible();
    expect(screen.getByText("Join optimization")).toBeVisible();
    expect(screen.getByText("SELECT user_id FROM events")).toBeVisible();
  });

  it("shows source evidence returned by a chat turn", async () => {
    window.kbAgent = {
      invoke: vi.fn(async (channel) => {
        if (channel === "workspace:get-active") {
          return { ok: true, data: { rootPath: "/tmp/kb", workspaceId: "workspace-1", sessionId: "session-1" } };
        }
        if (channel === "settings:get") {
          return { ok: true, data: { hasApiKey: false, modelName: "mock" } };
        }
        if (channel === "activity:list" || channel === "review:list") {
          return { ok: true, data: [] };
        }
        if (channel === "chat:run-turn") {
          return {
            ok: true,
            data: {
              events: [
                {
                  type: "sources",
                  sources: [
                    {
                      title: "Resume",
                      path: "04-Resources/Imports/Resume.md",
                      snippet: "LQ Digital, San Francisco, CA | Jun 2017 - Mar 2019",
                      matchedFields: ["body"],
                    },
                  ],
                },
                { type: "message", content: "You worked at LQ Digital in 2018." },
                { type: "done", response: { role: "assistant", content: "You worked at LQ Digital in 2018." } },
              ],
            },
          };
        }
        return { ok: true, data: null };
      }),
    };

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "where did I work in 2018" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Sources used")).toBeVisible();
    expect(screen.getByText("Resume")).toBeVisible();
    expect(screen.getByText("04-Resources/Imports/Resume.md")).toBeVisible();
    expect(screen.getByText("LQ Digital, San Francisco, CA | Jun 2017 - Mar 2019")).toBeVisible();
    expect(screen.getByText("You worked at LQ Digital in 2018.")).toBeVisible();
  });

  it("shows a workspace file tree and previews selected files", async () => {
    window.kbAgent = {
      invoke: vi.fn(async (channel, input) => {
        if (channel === "workspace:get-active") {
          return { ok: true, data: { rootPath: "/tmp/kb", workspaceId: "workspace-1", sessionId: "session-1" } };
        }
        if (channel === "settings:get") {
          return { ok: true, data: { hasApiKey: false, modelName: "mock" } };
        }
        if (channel === "activity:list" || channel === "review:list") {
          return { ok: true, data: [] };
        }
        if (channel === "workspace:tree") {
          return {
            ok: true,
            data: {
              name: "kb",
              path: "",
              type: "directory",
              children: [
                {
                  name: "01-Projects",
                  path: "01-Projects",
                  type: "directory",
                  children: [
                    { name: "Plan.md", path: "01-Projects/Plan.md", type: "file" },
                  ],
                },
              ],
            },
          };
        }
        if (channel === "workspace:read-file") {
          expect(input).toEqual({ path: "01-Projects/Plan.md" });
          return { ok: true, data: { path: "01-Projects/Plan.md", content: "# Plan\n\nBuild the explorer.", previewType: "text" } };
        }
        return { ok: true, data: null };
      }),
    };

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Files" }));
    expect(await screen.findByText("01-Projects")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Plan.md" }));

    expect(await screen.findByText("01-Projects/Plan.md")).toBeVisible();
    const preview = screen.getByLabelText("File preview");
    expect(preview).toHaveTextContent("# Plan");
    expect(preview).toHaveTextContent("Build the explorer.");
  });
});
