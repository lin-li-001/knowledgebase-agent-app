// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ImportDropzone } from "../src/components/ImportDropzone";
import { ReviewItemCard } from "../src/components/ReviewItemCard";
import { ChatRoute } from "../src/routes/ChatRoute";
import { KnowledgeRoute } from "../src/routes/KnowledgeRoute";
import { SettingsRoute } from "../src/routes/SettingsRoute";

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

  it("creates a custom category from Settings", async () => {
    const onCreateCategory = vi.fn(async () => true);
    render(
      <SettingsRoute
        hasApiKey={false}
        modelName="mock"
        embeddingBaseUrl="http://127.0.0.1:11434"
        embeddingModel="bge-m3"
        workspaceRoot="/tmp/kb"
        desktopBridgeReady
        activeCategories={[]}
        onSave={async () => undefined}
        onOpenWorkspace={async () => undefined}
        onCreateWorkspace={async () => undefined}
        onCreateCategory={onCreateCategory}
      />,
    );

    fireEvent.change(screen.getByLabelText("Category ID"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Writing" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Personal writing projects." } });
    fireEvent.change(screen.getByLabelText("Default Destination"), { target: { value: "02-Personal/default/Writing/" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Category" }));

    await waitFor(() => expect(onCreateCategory).toHaveBeenCalledWith({
      id: "writing",
      label: "Writing",
      description: "Personal writing projects.",
      defaultDestination: "02-Personal/default/Writing/",
      defaultRisk: "normal",
    }));
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

  it("labels source annotations as additions rather than document rewrites", () => {
    render(
      <ReviewItemCard
        item={{
          id: "review-annotation",
          state: "proposed",
          proposalType: "propose_annotation",
          risk: "medium",
          targetPath: "04-Resources/Resume.md",
          reason: "User clarified an imported source.",
          payload: {
            path: "04-Resources/Resume.md",
            body: "This project was completed at Example Corp.",
          },
        }}
      />,
    );

    expect(screen.getByText("Source annotation proposal")).toBeVisible();
    expect(screen.getByText("Annotation to append")).toBeVisible();
    expect(screen.getByText("This project was completed at Example Corp.")).toBeVisible();
    expect(screen.queryByLabelText("Destination")).not.toBeInTheDocument();
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

  it("renders import safety evidence and lets users override category, destination, and future routing", () => {
    const approve = vi.fn(async () => undefined);
    render(
      <ReviewItemCard
        item={{
          id: "review-1",
          state: "proposed",
          proposalType: "propose_create_note",
          risk: "medium",
          targetPath: "04-Resources/Imports/Utility Bills.md",
          reason: "Model proposed a knowledge-base change.",
          payload: {
            sourceNotePath: ".app/import-staging/import-1/Utility Bills.md",
            destination: "04-Resources/Imports/Utility Bills.md",
            sourceFile: "Utility Bills.pdf",
            classification: {
              primaryCategory: "finance.utility",
              alternativeCategories: [],
              sensitivity: "personal",
              confidence: 0.92,
              evidence: ["Amount due $184.27"],
              signals: [],
              suggestedDestination: "04-Resources/Imports/Utility Bills.md",
              conflict: false,
            },
            safetyDecision: {
              decision: "review_required",
              reasonCodes: ["CATEGORY_REQUIRES_REVIEW"],
            },
            body: "# Utility Bills\n\nActual staged note content.",
          },
        }}
        onApprove={approve}
      />,
    );

    expect(screen.getByText("Category: finance.utility")).toBeVisible();
    expect(screen.getByText("Sensitivity: personal")).toBeVisible();
    expect(screen.getByText("Confidence: 0.92")).toBeVisible();
    expect(screen.getByText("Evidence: Amount due $184.27")).toBeVisible();
    expect(screen.getByText("Reasons: CATEGORY_REQUIRES_REVIEW")).toBeVisible();
    expect(
      screen.getByText((_content, element) => (
        element?.tagName === "PRE"
        && element.textContent === "# Utility Bills\n\nActual staged note content."
      )),
    ).toBeVisible();
    expect(screen.getByLabelText("Category")).toHaveValue("finance.utility");

    expect(screen.queryByRole("option", { name: /Insurance/iu })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "resource" } });
    fireEvent.change(screen.getByLabelText("Destination"), {
      target: { value: "02-Personal/default/Finance/Insurance/Policy.md" },
    });
    fireEvent.click(screen.getByLabelText("Save as future routing rule"));
    fireEvent.change(screen.getByLabelText("Routing rule pattern"), {
      target: { value: "policy number" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(approve).toHaveBeenCalledWith("review-1", {
      categoryOverride: "resource",
      targetPathOverride: "02-Personal/default/Finance/Insurance/Policy.md",
      saveAsRoutingRule: true,
      routingRulePattern: "policy number",
    });
  });

  it("never falls back to raw payload JSON for an imported Review item", () => {
    render(
      <ReviewItemCard
        item={{
          id: "review-import-missing-body",
          state: "proposed",
          proposalType: "propose_create_note",
          risk: "high",
          targetPath: "04-Resources/Imports/Report.md",
          reason: "Imported note requires Review.",
          payload: {
            sourceNotePath: ".app/import-staging/import-1/Report.md",
            destination: "04-Resources/Imports/Report.md",
            sourceFile: "Report.pdf",
            classification: {
              primaryCategory: "resource",
              alternativeCategories: [],
              sensitivity: "normal",
              confidence: 1,
              evidence: [],
              signals: [],
              conflict: false,
            },
            safetyDecision: {
              decision: "review_required",
              reasonCodes: ["CLASSIFIER_CONFLICT"],
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Staged note content is unavailable.")).toBeVisible();
    expect(screen.queryByText(/"sourceNotePath"/u)).not.toBeInTheDocument();
  });

  it("allows failed Review items to be retried and disables claimed Review items", async () => {
    const approve = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    const item = {
      id: "review-1",
      proposalType: "propose_memory",
      risk: "high",
      reason: "Model proposed a knowledge-base change.",
      payload: { body: "User's name is Lin Li." },
    };
    const { rerender } = render(<ReviewItemCard item={{ ...item, state: "failed" }} onApprove={approve} onReject={reject} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(approve).toHaveBeenCalledWith("review-1", undefined);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(reject).toHaveBeenCalledWith("review-1");

    rerender(<ReviewItemCard item={{ ...item, state: "applying" }} onApprove={approve} onReject={reject} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();

    rerender(<ReviewItemCard item={{ ...item, state: "rejecting" }} onApprove={approve} onReject={reject} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("offers approval recovery and no rejection for a prepared application", () => {
    const reject = vi.fn(async () => undefined);
    render(
      <ReviewItemCard
        item={{
          id: "review-prepared",
          state: "failed",
          proposalType: "propose_create_note",
          risk: "high",
          reason: "Previous approval stopped after publication.",
          targetPath: "04-Resources/Approved/A.md",
          payload: {
            path: "04-Resources/Approved/A.md",
            body: "# Approved A",
          },
          application: {
            kind: "exclusive_write",
            destination: "04-Resources/Approved/A.md",
          },
        }}
        onReject={reject}
      />,
    );

    expect(screen.getByRole("button", { name: "Resume approval" })).toBeEnabled();
    expect(screen.getByText(/approval is already prepared/iu)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("initializes Resume controls from the persisted application", () => {
    const approve = vi.fn(async () => undefined);
    render(
      <ReviewItemCard
        item={{
          id: "review-prepared-import",
          state: "failed",
          proposalType: "propose_create_note",
          risk: "high",
          reason: "Previous approval stopped after prepare.",
          targetPath: "04-Resources/Imports/Utility Bill.md",
          payload: {
            sourceNotePath: ".app/import-staging/import-1/Utility Bill.md",
            destination: "04-Resources/Imports/Utility Bill.md",
            sourceFile: "Utility Bill.pdf",
            classification: {
              primaryCategory: "finance.utility",
              alternativeCategories: [],
              sensitivity: "personal",
              confidence: 0.8,
              evidence: ["Amount due"],
              signals: [],
              conflict: false,
            },
            safetyDecision: {
              decision: "review_required",
              reasonCodes: ["CATEGORY_REQUIRES_REVIEW"],
            },
          },
          application: {
            kind: "import_move",
            destination: "04-Resources/Approved/Persisted A.md",
            options: {
              targetPathOverride: "04-Resources/Approved/Persisted A.md",
              categoryOverride: "resource",
              saveAsRoutingRule: true,
              routingRulePattern: "persisted utility",
            },
          },
        }}
        onApprove={approve}
      />,
    );

    expect(screen.getByLabelText("Destination")).toHaveValue(
      "04-Resources/Approved/Persisted A.md",
    );
    expect(screen.getByLabelText("Category")).toHaveValue("resource");
    expect(screen.getByLabelText("Save as future routing rule")).toBeChecked();
    expect(screen.getByLabelText("Routing rule pattern")).toHaveValue(
      "persisted utility",
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume approval" }));

    expect(approve).toHaveBeenCalledWith("review-prepared-import", {
      categoryOverride: "resource",
      targetPathOverride: "04-Resources/Approved/Persisted A.md",
      saveAsRoutingRule: true,
      routingRulePattern: "persisted utility",
    });
  });

  it("reinitializes Resume controls only when the persisted application version changes", async () => {
    const item = {
      id: "review-versioned-application",
      state: "failed",
      proposalType: "propose_create_note",
      risk: "high",
      reason: "Previous approval stopped after prepare.",
      targetPath: "04-Resources/Imports/Utility Bill.md",
      payload: {
        sourceNotePath: ".app/import-staging/import-1/Utility Bill.md",
        destination: "04-Resources/Imports/Utility Bill.md",
        sourceFile: "Utility Bill.pdf",
        classification: {
          primaryCategory: "finance.utility",
          alternativeCategories: [],
          sensitivity: "personal",
          confidence: 0.8,
          evidence: ["Amount due"],
          signals: [],
          conflict: false,
        },
        safetyDecision: {
          decision: "review_required",
          reasonCodes: ["CATEGORY_REQUIRES_REVIEW"],
        },
      },
      application: {
        kind: "import_move",
        transactionId: "application-v1",
        destination: "04-Resources/Approved/A.md",
        options: {
          targetPathOverride: "04-Resources/Approved/A.md",
          categoryOverride: "resource",
          saveAsRoutingRule: true,
          routingRulePattern: "application a",
        },
      },
    };
    const { rerender } = render(<ReviewItemCard item={item} />);

    fireEvent.change(screen.getByLabelText("Destination"), {
      target: { value: "04-Resources/Unsaved/User Edit.md" },
    });
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "unknown" },
    });
    fireEvent.click(screen.getByLabelText("Save as future routing rule"));

    rerender(
      <ReviewItemCard
        item={{
          ...item,
          application: {
            ...item.application,
            options: { ...item.application.options },
          },
        }}
      />,
    );
    expect(screen.getByLabelText("Destination")).toHaveValue(
      "04-Resources/Unsaved/User Edit.md",
    );
    expect(screen.getByLabelText("Category")).toHaveValue("unknown");
    expect(screen.getByLabelText("Save as future routing rule")).not.toBeChecked();

    rerender(
      <ReviewItemCard
        item={{
          ...item,
          application: {
            kind: "import_move",
            transactionId: "application-v2",
            destination: "04-Resources/Approved/C.md",
            options: {
              targetPathOverride: "04-Resources/Approved/C.md",
              categoryOverride: "project.document",
              saveAsRoutingRule: true,
              routingRulePattern: "application c",
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Destination")).toHaveValue(
        "04-Resources/Approved/C.md",
      );
      expect(screen.getByLabelText("Category")).toHaveValue("project.document");
      expect(screen.getByLabelText("Save as future routing rule")).toBeChecked();
      expect(screen.getByLabelText("Routing rule pattern")).toHaveValue(
        "application c",
      );
    });
  });

  it("refreshes a failed approval into persisted Resume state", async () => {
    const proposedItem = {
      id: "review-refresh-after-failure",
      state: "proposed",
      proposalType: "propose_create_note",
      risk: "high",
      reason: "Imported note requires Review.",
      targetPath: "04-Resources/Imports/Utility Bill.md",
      payload: {
        sourceNotePath: ".app/import-staging/import-1/Utility Bill.md",
        destination: "04-Resources/Imports/Utility Bill.md",
        sourceFile: "Utility Bill.pdf",
        classification: {
          primaryCategory: "finance.utility",
          alternativeCategories: [],
          sensitivity: "personal",
          confidence: 0.8,
          evidence: ["Amount due"],
          signals: [],
          conflict: false,
        },
        safetyDecision: {
          decision: "review_required",
          reasonCodes: ["CATEGORY_REQUIRES_REVIEW"],
        },
      },
    };
    const persistedDestination = "04-Resources/Approved/Persisted A.md";
    let approvalFailed = false;
    window.kbAgent = {
      invoke: vi.fn(async (channel, input) => {
        if (channel === "workspace:get-active") {
          return {
            ok: true,
            data: {
              rootPath: "/tmp/kb",
              workspaceId: "workspace-1",
              sessionId: "session-1",
            },
          };
        }
        if (channel === "settings:get") {
          return { ok: true, data: { hasApiKey: false, modelName: "mock" } };
        }
        if (channel === "activity:list") {
          return { ok: true, data: [] };
        }
        if (channel === "workspace:tree") {
          return {
            ok: true,
            data: { name: "kb", path: "", type: "directory", children: [] },
          };
        }
        if (channel === "review:list") {
          return {
            ok: true,
            data: [
              approvalFailed
                ? {
                  ...proposedItem,
                  state: "failed",
                  failureReason: "simulated approval crash",
                  application: {
                    kind: "import_move",
                    transactionId: "application-a",
                    destination: persistedDestination,
                    options: {
                      targetPathOverride: persistedDestination,
                      categoryOverride: "resource",
                      saveAsRoutingRule: true,
                      routingRulePattern: "persisted utility",
                    },
                  },
                }
                : proposedItem,
            ],
          };
        }
        if (channel === "review:approve") {
          expect(input).toEqual({
            id: proposedItem.id,
            targetPathOverride: persistedDestination,
            categoryOverride: "resource",
            saveAsRoutingRule: true,
            routingRulePattern: "persisted utility",
          });
          approvalFailed = true;
          return { ok: false, error: "simulated approval crash" };
        }
        return { ok: true, data: null };
      }),
    };

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.change(await screen.findByLabelText("Destination"), {
      target: { value: persistedDestination },
    });
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "resource" },
    });
    fireEvent.click(screen.getByLabelText("Save as future routing rule"));
    fireEvent.change(screen.getByLabelText("Routing rule pattern"), {
      target: { value: "persisted utility" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("button", {
      name: "Resume approval",
    })).toBeEnabled();
    expect(screen.getByLabelText("Destination")).toHaveValue(
      persistedDestination,
    );
    expect(screen.getByLabelText("Category")).toHaveValue("resource");
    expect(screen.getByLabelText("Save as future routing rule")).toBeChecked();
    expect(screen.getByLabelText("Routing rule pattern")).toHaveValue(
      "persisted utility",
    );
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("disables Review actions while an approval is pending and prevents duplicate requests", async () => {
    let resolveApproval: (() => void) | undefined;
    const approve = vi.fn(() => new Promise<void>((resolve) => {
      resolveApproval = resolve;
    }));
    render(
      <ReviewItemCard
        item={{
          id: "review-1",
          state: "failed",
          proposalType: "propose_memory",
          risk: "high",
          reason: "Model proposed a knowledge-base change.",
          payload: { body: "User's name is Lin Li." },
        }}
        onApprove={approve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(approve).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();

    resolveApproval?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
  });

  it("restores Review actions after a rejected request", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const reject = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => {
      rejectRequest = rejectPromise;
    }));
    render(
      <ReviewItemCard
        item={{
          id: "review-1",
          state: "failed",
          proposalType: "propose_memory",
          risk: "high",
          reason: "Model proposed a knowledge-base change.",
          payload: { body: "User's name is Lin Li." },
        }}
        onReject={reject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(reject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();

    rejectRequest?.(new Error("request failed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled());
  });

  it("renders import controls for document batches", () => {
    render(<ImportDropzone disabled={false} onImport={async () => undefined} />);

    expect(screen.getByLabelText("Batch name")).toBeVisible();
    expect(screen.getByLabelText("Import files")).toHaveAttribute("accept", ".pdf,.md,.markdown,.txt");
    expect(screen.getByRole("button", { name: "Import Documents" })).toBeDisabled();
  });

  it("shows each imported source note path and route status after import", async () => {
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
        if (channel === "workspace:tree") {
          return { ok: true, data: { name: "kb", path: "", type: "directory", children: [] } };
        }
        if (channel === "import:start") {
          return {
            ok: true,
            data: {
              state: "completed",
              notes: [
                { notePath: "00-Inbox/Imports/Handbook.md", status: "auto_written" },
                { notePath: ".app/import-staging/Bills/Electric.md", status: "pending_review" },
              ],
            },
          };
        }
        return { ok: true, data: null };
      }),
    };

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    fireEvent.change(await screen.findByLabelText("Batch name"), { target: { value: "Handbook" } });
    fireEvent.change(screen.getByLabelText("Import files"), { target: { files: [new File(["body"], "Handbook.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "Import Documents" }));

    expect(await screen.findByText("Imported note: 00-Inbox/Imports/Handbook.md (auto_written)")).toBeVisible();
    expect(screen.getByText("Imported note: .app/import-staging/Bills/Electric.md (pending_review)")).toBeVisible();
  });

  it("renders workspace audit findings in the Knowledge route", () => {
    render(
      <KnowledgeRoute
        rebuilding={false}
        auditing={false}
        importDisabled={false}
        importNotices={[]}
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
