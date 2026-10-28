import * as os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchedulerService } from "../../src/server/scheduler.js";
import { nextOccurrenceForRecurrence } from "../../src/server/recurrence.js";
import { loadWorkspaceLedger, saveWorkspaceLedger } from "../../src/server/storage.js";

describe("scheduler service integration", () => {
  let tempHome: string;
  let workspacePath: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "scheduled-prompts-int-"));
    workspacePath = path.join(tempHome, "project");
    await mkdir(workspacePath, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("creates and reloads a persisted recurring task with computed summary and next run", async () => {
    const scheduler = new SchedulerService();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    expect(task.recurrenceSummary).toContain("Daily at 09:00");
    expect(task.nextRunAt).toBeTruthy();

    const state = await scheduler.loadWorkspaceState(workspacePath, {
      status: "needs_config",
      message: "not configured"
    });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.name).toBe("Morning summary");
  });

  it("updates a task and recalculates its recurrence summary", async () => {
    const scheduler = new SchedulerService();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Weekly review",
      prompt: "Review weekly changes.",
      recurrence: {
        scheduleType: "weekly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfWeek: "monday"
      }
    });

    const updated = await scheduler.updateTask(task.id, {
      workspacePath,
      recurrence: {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "10:15",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      }
    });

    expect(updated.recurrenceSummary).toContain("Monthly on day 31");
    expect(updated.nextRunAt).toBeTruthy();
  });

  it("executes due runs through the local command profile and records the result", async () => {
    const scheduler = new SchedulerService();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    await scheduler.saveExecutionProfile({
      workspacePath,
      command: process.execPath,
      args: [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log('stdin:'+d);});"
      ],
      timeoutMs: 10_000
    });

    const ledger = await loadWorkspaceLedger(workspacePath);
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    ledger.tasks[0]!.nextRunAt = dueAt;
    await saveWorkspaceLedger(ledger);

    await scheduler.tickWithoutDispatcher();

    const updated = await loadWorkspaceLedger(workspacePath);
    expect(updated.runs).toHaveLength(1);
    expect(updated.runs[0]?.status).toBe("succeeded");
    expect(updated.runs[0]?.outcomeSummary).toContain("stdin:Summarize the workspace.");
    expect(updated.tasks[0]?.lastRunStatus).toBe("succeeded");

    await scheduler.tickWithoutDispatcher();
    const replayCheck = await loadWorkspaceLedger(workspacePath);
    expect(replayCheck.runs).toHaveLength(1);
  });

  it("marks due runs as missed when no execution profile is configured", async () => {
    const scheduler = new SchedulerService();
    await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveWorkspaceLedger(ledger);

    await scheduler.tickWithoutDispatcher();

    const updated = await loadWorkspaceLedger(workspacePath);
    expect(updated.runs[0]?.status).toBe("missed");
    expect(updated.runs[0]?.outcomeSummary).toContain("Configure a local execution command");
  });

  it("records all missed recurring occurrences in one tick and resumes from the next future slot", async () => {
    const scheduler = new SchedulerService();
    const recurrence = {
      scheduleType: "daily" as const,
      timezone: "Europe/Paris",
      localTime: "09:00"
    };

    await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence
    });

    const ledger = await loadWorkspaceLedger(workspacePath);
    const firstMissed = DateTime.now()
      .setZone("Europe/Paris")
      .minus({ days: 3 })
      .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const expectedOccurrences: string[] = [];
    let cursor = firstMissed;
    const now = DateTime.now().toUTC();

    while (cursor.toUTC() <= now) {
      expectedOccurrences.push(cursor.toUTC().toISO()!);
      cursor = cursor.plus({ days: 1 });
    }

    ledger.tasks[0]!.nextRunAt = expectedOccurrences[0]!;
    await saveWorkspaceLedger(ledger);

    await scheduler.tickWithoutDispatcher();

    const updated = await loadWorkspaceLedger(workspacePath);
    expect(updated.runs).toHaveLength(expectedOccurrences.length);
    expect(updated.runs.every((run) => run.status === "missed")).toBe(true);
    expect(updated.runs.map((run) => run.scheduledFor).sort()).toEqual([...expectedOccurrences].sort());
    expect(updated.runs.every((run) => run.outcomeSummary.includes("Configure a local execution command"))).toBe(true);
    expect(updated.tasks[0]?.nextRunAt).toBe(
      nextOccurrenceForRecurrence(recurrence, expectedOccurrences.at(-1))
    );
  });

  it("does not execute paused tasks until they are resumed", async () => {
    const scheduler = new SchedulerService();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    await scheduler.pauseTask(task.id, workspacePath);

    const pausedLedger = await loadWorkspaceLedger(workspacePath);
    pausedLedger.tasks[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveWorkspaceLedger(pausedLedger);

    await scheduler.tickWithoutDispatcher();

    const stillPaused = await loadWorkspaceLedger(workspacePath);
    expect(stillPaused.runs).toHaveLength(0);
    expect(stillPaused.tasks[0]?.enabled).toBe(false);

    const resumed = await scheduler.resumeTask(task.id, workspacePath);
    expect(resumed.enabled).toBe(true);

    const resumedLedger = await loadWorkspaceLedger(workspacePath);
    resumedLedger.tasks[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveWorkspaceLedger(resumedLedger);

    await scheduler.tickWithoutDispatcher();

    const afterResume = await loadWorkspaceLedger(workspacePath);
    expect(afterResume.runs[0]?.status).toBe("missed");
  });

  it("deletes tasks so they are removed from the active list and never execute again", async () => {
    const scheduler = new SchedulerService();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Weekly review",
      prompt: "Review weekly changes.",
      recurrence: {
        scheduleType: "weekly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfWeek: "monday"
      }
    });

    await scheduler.deleteTask(task.id, workspacePath);

    const deletedLedger = await loadWorkspaceLedger(workspacePath);
    expect(deletedLedger.tasks).toHaveLength(0);

    await scheduler.tickWithoutDispatcher();

    const afterTick = await loadWorkspaceLedger(workspacePath);
    expect(afterTick.tasks).toHaveLength(0);
    expect(afterTick.runs).toHaveLength(0);
  });

  it("duplicates tasks and supports a manual run-now without waiting for the next occurrence", async () => {
    const scheduler = new SchedulerService();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Morning summary",
      prompt: "Summarize the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    const duplicate = await scheduler.duplicateTask(task.id, workspacePath);
    expect(duplicate.id).not.toBe(task.id);
    expect(duplicate.name).toContain("(Copy)");

    const manualRun = await scheduler.createManualRun(task.id, workspacePath);
    expect(["failed", "succeeded"]).toContain(manualRun.status);

    const ledger = await loadWorkspaceLedger(workspacePath);
    expect(ledger.tasks).toHaveLength(2);
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0]?.taskId).toBe(task.id);
  });

  it("retries the latest failed run against the same workspace task", async () => {
    const scheduler = new SchedulerService();
    const task = await scheduler.createTask({
      workspacePath,
      name: "Retry target",
      prompt: "Retry the workspace.",
      recurrence: {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      }
    });

    const failedRun = await scheduler.createManualRun(task.id, workspacePath);
    expect(failedRun.status).toBe("failed");

    const retriedRun = await scheduler.retryRun(failedRun.id, workspacePath);
    expect(retriedRun.taskId).toBe(task.id);
    expect(retriedRun.retryOfRunId).toBe(failedRun.id);

    const ledger = await loadWorkspaceLedger(workspacePath);
    expect(ledger.runs).toHaveLength(2);
    expect(ledger.runs[0]?.id).toBe(retriedRun.id);
    expect(ledger.runs[1]?.id).toBe(failedRun.id);
  });
});
