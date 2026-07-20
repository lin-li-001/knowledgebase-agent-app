// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("desktop shell", () => {
  it("renders primary navigation and Activity", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "Chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Knowledge" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Activity" })).toBeVisible();
    expect(screen.getByText("No activity yet")).toBeVisible();
  });
});
