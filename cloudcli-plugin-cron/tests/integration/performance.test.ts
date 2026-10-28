import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScheduledRun, WorkspaceTask } from "../../src/shared/model.js";
import { buildGlobalDashboardSnapshot } from "../../src/server/dashboard.js";
import { SchedulerService } from "../../src/server/scheduler.js";
import { saveWorkspaceLedger } from "../../src/server/storage.js";
import { workspaceKeyFromPath } from "../../src/shared/workspace.js";

describe("performance fixtures", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-perf-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("loads 100 tasks and 500 runs within the documented budget", async () => {
    const workspaceKey = workspaceKeyFromPath(workspacePath);
    const createdAt = "2026-04-26T08:00:00.000Z";
    const tasks: WorkspaceTask[] = Array.from({ length: 100 }, (_, index) => ({
      id: `task-${index}`,
      workspaceKey,
      workspacePath,
      name: `Task ${index}`,
      prompt: `Prompt ${index}`,
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      },
      recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
      enabled: true,
      nextRunAt: "2099-01-01T08:00:00.000Z",
      lastRunStatus: index % 3 === 0 ? "succeeded" : null,
      createdAt,
      updatedAt: createdAt
    }));

    const runs: ScheduledRun[] = Array.from({ length: 500 }, (_, index) => ({
      id: `run-${index}`,
      occurrenceKey: `task-${index % tasks.length}:2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:00.000Z`,
      taskId: `task-${index % tasks.length}`,
      workspaceKey,
      scheduledFor: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:00.000Z`,
      startedAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:05.000Z`,
      finishedAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:10.000Z`,
      status: index % 7 === 0 ? "failed" : "succeeded",
      outcomeSummary: `Run ${index}`,
      failureReason: index % 7 === 0 ? `Failure ${index}` : null,
      retryOfRunId: null,
      executionRequest: null
    }));

    await saveWorkspaceLedger({
      version: 1,
      workspaceKey,
      workspacePath,
      tasks,
      runs,
      executionProfile: null,
      updatedAt: createdAt
    });

    const scheduler = new SchedulerService();
    const startedAt = performance.now();
    const state = await scheduler.loadWorkspaceState(workspacePath, {
      status: "needs_config",
      message: "Configure a local execution command to enable automatic prompt runs."
    });
    const durationMs = performance.now() - startedAt;

    expect(state.tasks).toHaveLength(100);
    expect(state.runs).toHaveLength(500);
    expect(durationMs).toBeLessThan(2_000);
  });

  it("builds a 100-job global dashboard snapshot within the documented budget", async () => {
    const workspacePaths = Array.from({ length: 4 }, (_, index) => path.join(tempHome, `project-${index}`));
    const startedAt = performance.now();

    for (const [workspaceIndex, currentPath] of workspacePaths.entries()) {
      await mkdir(currentPath, { recursive: true });
      const workspaceKey = workspaceKeyFromPath(currentPath);
      const tasks: WorkspaceTask[] = Array.from({ length: 25 }, (_, taskIndex) => ({
        id: `task-${workspaceIndex}-${taskIndex}`,
        workspaceKey,
        workspacePath: currentPath,
        name: `Task ${workspaceIndex}-${taskIndex}`,
        prompt: `Prompt ${workspaceIndex}-${taskIndex}`,
        recurrence: {
          scheduleType: "daily",
          timezone: "Europe/Paris",
          localTime: "09:00"
        },
        recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
        enabled: taskIndex % 3 !== 0,
        nextRunAt: "2099-01-01T08:00:00.000Z",
        lastRunStatus: taskIndex % 5 === 0 ? "failed" : "succeeded",
        createdAt: "2026-04-26T08:00:00.000Z",
        updatedAt: "2026-04-26T08:00:00.000Z"
      }));

      await saveWorkspaceLedger({
        version: 1,
        workspaceKey,
        workspacePath: currentPath,
        tasks,
        runs: [],
        executionProfile: null,
        updatedAt: "2026-04-26T08:00:00.000Z"
      });
    }

    const snapshot = await buildGlobalDashboardSnapshot({ sortBy: "urgency" });
    const durationMs = performance.now() - startedAt;

    expect(snapshot.jobs).toHaveLength(100);
    expect(snapshot.summary.totalJobs).toBe(100);
    expect(durationMs).toBeLessThan(2_000);
  });
});
