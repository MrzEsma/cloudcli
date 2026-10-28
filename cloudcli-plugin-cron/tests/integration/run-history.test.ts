// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderExecutionBanner } from "../../src/client/views/execution-banner.js";
import { renderRunHistory } from "../../src/client/views/run-history.js";

describe("execution banner", () => {
  it("applies presets and submits local execution settings", () => {
    const onSave = vi.fn();
    const section = renderExecutionBanner({
      status: "needs_config",
      message: "Configure a local execution command to enable automatic prompt runs."
    }, null, { onSave });

    const preset = section.querySelector<HTMLSelectElement>('[name="preset"]');
    const command = section.querySelector<HTMLInputElement>('[name="command"]');
    const args = section.querySelector<HTMLTextAreaElement>('[name="args"]');
    const timeout = section.querySelector<HTMLInputElement>('[name="timeoutMs"]');

    if (!preset || !command || !args || !timeout) {
      throw new Error("Execution fields failed to render");
    }

    preset.value = "codex";
    preset.dispatchEvent(new Event("change", { bubbles: true }));

    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith({
      command: "codex",
      args: [
        "-m",
        "gpt-5.6-luna",
        "-c",
        "model_reasoning_effort=\"low\"",
        "-a",
        "never",
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--ephemeral"
      ],
      timeoutMs: 300000
    });
  });
});

describe("run history", () => {
  it("renders status and failure details", () => {
    const onRetry = vi.fn();
    const section = renderRunHistory([
      {
        id: "run-1",
        occurrenceKey: "task-1:2026-04-27T07:00:00.000Z",
        taskId: "task-1",
        workspaceKey: "workspace-1",
        scheduledFor: "2026-04-27T07:00:00.000Z",
        startedAt: "2026-04-27T07:00:01.000Z",
        finishedAt: "2026-04-27T07:00:02.000Z",
        status: "failed",
        outcomeSummary: "Command exited with code 2.",
        failureReason: "Command exited with code 2.",
        retryOfRunId: null,
        executionRequest: null
      }
    ], { onRetry });

    expect(section.textContent).toContain("Failed");
    expect(section.textContent).toContain("Command exited with code 2.");
    expect(section.textContent).toContain("Scheduled for");

    section.querySelector("button")?.click();
    expect(onRetry).toHaveBeenCalledWith("run-1");
  });

  it("renders run output as text instead of executable markup", () => {
    const section = renderRunHistory([
      {
        id: "run-2",
        occurrenceKey: "task-1:2026-04-27T07:00:00.000Z",
        taskId: "task-1",
        workspaceKey: "workspace-1",
        scheduledFor: "2026-04-27T07:00:00.000Z",
        startedAt: "2026-04-27T07:00:01.000Z",
        finishedAt: "2026-04-27T07:00:02.000Z",
        status: "failed",
        outcomeSummary: "<img src=x onerror=alert(1)>",
        failureReason: "<script>alert(1)</script>",
        retryOfRunId: null,
        executionRequest: null
      }
    ], { onRetry: vi.fn() });

    expect(section.querySelector("img")).toBeNull();
    expect(section.querySelector("script")).toBeNull();
    expect(section.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(section.textContent).toContain("<script>alert(1)</script>");
  });

  it("shows the model and reasoning effort used by a run", () => {
    const section = renderRunHistory([
      {
        id: "run-3",
        occurrenceKey: "task-1:2026-04-27T07:00:00.000Z",
        taskId: "task-1",
        workspaceKey: "workspace-1",
        scheduledFor: "2026-04-27T07:00:00.000Z",
        startedAt: "2026-04-27T07:00:01.000Z",
        finishedAt: "2026-04-27T07:00:02.000Z",
        status: "succeeded",
        outcomeSummary: "ok",
        failureReason: null,
        retryOfRunId: null,
        executionRequest: {
          command: "/app/node_modules/.bin/codex",
          model: "gpt-5.6-luna",
          reasoningEffort: "low"
        }
      }
    ], { onRetry: vi.fn() });

    expect(section.textContent).toContain("Model: gpt-5.6-luna / low");
  });
});
