// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
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

describe("schedule list", () => {
  it("highlights the most recently saved task", () => {
    const section = renderScheduleList([task], {
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onDuplicate: vi.fn(),
      onRunNow: vi.fn()
    }, task.id);

    const item = section.querySelector('li[data-highlighted="true"]');
    expect(item?.textContent).toContain("Saved just now.");
    expect(item?.textContent).toContain("Weekly review");
  });
});
