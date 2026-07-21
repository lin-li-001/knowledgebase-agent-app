// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ReviewItemCard } from "../src/components/ReviewItemCard";

describe("desktop shell", () => {
  afterEach(() => {
    cleanup();
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
          payload: { body: "Lin Li has two kids, Grace and Leo." },
        }}
      />,
    );

    expect(screen.getByText("Memory proposal")).toBeVisible();
    expect(screen.getByText("Memory to save")).toBeVisible();
    expect(screen.getByText("Lin Li has two kids, Grace and Leo.")).toBeVisible();
    expect(screen.getByText("proposed")).toBeVisible();
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
});
