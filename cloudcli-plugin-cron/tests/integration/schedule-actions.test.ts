// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderScheduleList } from "../../src/client/views/schedule-list.js";
import type { WorkspaceTask } from "../../src/shared/model.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("schedule actions", () => {
  it("dispatches edit, pause, duplicate, and run-now actions from the task list", () => {
    const handlers = {
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onDuplicate: vi.fn(),
      onRunNow: vi.fn()
    };

    const section = renderScheduleList([task], handlers);
    const buttons = Array.from(section.querySelectorAll("button"));

    buttons.find((button) => button.textContent === "Edit")?.click();
    buttons.find((button) => button.textContent === "Pause")?.click();
    buttons.find((button) => button.textContent === "Duplicate")?.click();
    buttons.find((button) => button.textContent === "Run Now")?.click();

    expect(handlers.onEdit).toHaveBeenCalledWith(task.id);
    expect(handlers.onPause).toHaveBeenCalledWith(task.id);
    expect(handlers.onDuplicate).toHaveBeenCalledWith(task.id);
    expect(handlers.onRunNow).toHaveBeenCalledWith(task.id);
  });

  it("confirms deletion before dispatching delete", () => {
    const handlers = {
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onDuplicate: vi.fn(),
      onRunNow: vi.fn()
    };

    vi.stubGlobal("confirm", vi.fn(() => false));
    const section = renderScheduleList([task], handlers);
    const deleteButton = Array.from(section.querySelectorAll("button")).find((button) => button.textContent === "Delete");
    deleteButton?.click();
    expect(handlers.onDelete).not.toHaveBeenCalled();

    vi.stubGlobal("confirm", vi.fn(() => true));
    const confirmedSection = renderScheduleList([task], handlers);
    const confirmedDelete = Array.from(confirmedSection.querySelectorAll("button")).find((button) => button.textContent === "Delete");
    confirmedDelete?.click();
    expect(handlers.onDelete).toHaveBeenCalledWith(task.id);
  });

  it("shows resume instead of pause for disabled tasks", () => {
    const handlers = {
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onDuplicate: vi.fn(),
      onRunNow: vi.fn()
    };

    const pausedTask = { ...task, enabled: false };
    const section = renderScheduleList([pausedTask], handlers);
    const resumeButton = Array.from(section.querySelectorAll("button")).find((button) => button.textContent === "Resume");
    resumeButton?.click();

    expect(handlers.onResume).toHaveBeenCalledWith(task.id);
    expect(handlers.onPause).not.toHaveBeenCalled();
  });
});
