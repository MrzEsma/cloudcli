// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderTaskForm } from "../../src/client/views/task-form.js";
import type { WorkspaceTask } from "../../src/shared/model.js";

function seedForm(section: HTMLElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const field = section.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
    if (!field) {
      continue;
    }
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

describe("task form", () => {
  it("blocks invalid schedules and shows feedback", () => {
    const onSubmit = vi.fn();
    const section = renderTaskForm(null, {
      onSubmit,
      onCancelEdit: vi.fn()
    });

    seedForm(section, {
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      scheduleType: "daily",
      timezone: "Europe/Paris",
      localTime: "25:00"
    });

    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(section.querySelector('[data-testid="task-form-feedback"]')?.textContent).toContain("localTime");
  });

  it("shows a recurrence preview and submits a valid schedule", () => {
    const onSubmit = vi.fn();
    const section = renderTaskForm(null, {
      onSubmit,
      onCancelEdit: vi.fn()
    });

    seedForm(section, {
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      scheduleType: "daily",
      timezone: "Europe/Paris",
      localTime: "09:00"
    });

    const preview = section.querySelector('[data-testid="task-form-preview"]');
    expect(preview?.textContent).toContain("Daily at 09:00");

    section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders edit mode and supports canceling edits", () => {
    const task: WorkspaceTask = {
      id: "task-1",
      workspaceKey: "workspace-1",
      workspacePath: "/tmp/project",
      name: "Weekly review",
      prompt: "Review changes",
      recurrence: {
        scheduleType: "weekly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfWeek: "monday"
      },
      recurrenceSummary: "Every monday at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: "2026-04-27T07:00:00.000Z",
      lastRunStatus: null,
      createdAt: "2026-04-26T10:00:00.000Z",
      updatedAt: "2026-04-26T10:00:00.000Z"
    };

    const onCancelEdit = vi.fn();
    const section = renderTaskForm(task, {
      onSubmit: vi.fn(),
      onCancelEdit
    });

    expect(section.querySelector("h2")?.textContent).toContain("Edit");
    section.querySelector<HTMLButtonElement>('[data-testid="cancel-edit"]')?.click();
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
  });
});
