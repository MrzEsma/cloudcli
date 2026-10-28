import { describe, expect, it } from "vitest";
import { LocalExecutionAdapter } from "../../src/server/execution-adapter.js";
import type { ExecutionProfile, WorkspaceTask } from "../../src/shared/model.js";

function createTask(): WorkspaceTask {
  return {
    id: "task-1",
    workspaceKey: "workspace-1",
    workspacePath: process.cwd(),
    name: "Morning summary",
    prompt: "Summarize the workspace.",
    recurrence: {
      scheduleType: "daily",
      timezone: "Europe/Paris",
      localTime: "09:00"
    },
    recurrenceSummary: "Daily at 09:00 (Europe/Paris)",
    enabled: true,
    nextRunAt: "2026-04-27T07:00:00.000Z",
    lastRunStatus: null,
    createdAt: "2026-04-26T10:00:00.000Z",
    updatedAt: "2026-04-26T10:00:00.000Z"
  };
}

function createProfile(args: string[]): ExecutionProfile {
  return {
    workspaceKey: "workspace-1",
    command: process.execPath,
    args,
    timeoutMs: 10_000,
    mode: "local_command",
    lastValidatedAt: "2026-04-26T10:00:00.000Z",
    validationStatus: "ready"
  };
}

describe("local execution adapter", () => {
  it("passes prompt on stdin and exposes scheduling context in the child process", async () => {
    const adapter = new LocalExecutionAdapter();
    const task = createTask();
    const scheduledFor = "2026-04-27T07:00:00.000Z";
    const profile = createProfile([
      "-e",
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({stdin:d,taskName:process.env.SCHEDULED_TASK_NAME,workspacePath:process.env.SCHEDULED_WORKSPACE_PATH,scheduledFor:process.env.SCHEDULED_FOR,arg:process.argv[1]}));});",
      "{{taskName}}"
    ]);

    const result = await adapter.execute(task, profile, scheduledFor);

    expect(result.status).toBe("succeeded");
    expect(result.outcomeSummary).toContain(task.prompt);
    expect(result.outcomeSummary).toContain(task.name);
    expect(result.executionRequest.args.at(-1)).toBe(task.name);
    expect(result.executionRequest.promptTransport).toBe("stdin");
    expect(result.executionRequest.requestedCommand).toBe(process.execPath);
  });

  it("expands {{prompt}} inline when the command preset uses argument transport", async () => {
    const adapter = new LocalExecutionAdapter();
    const task = createTask();
    const profile = createProfile([
      "-e",
      "console.log(process.argv[1]);",
      "{{prompt}}"
    ]);

    const result = await adapter.execute(task, profile, "2026-04-27T07:00:00.000Z");

    expect(result.status).toBe("succeeded");
    expect(result.outcomeSummary).toContain(task.prompt);
    expect(result.executionRequest.promptTransport).toBe("argument");
  });

  it("marks non-zero exit codes as failed and captures stderr", async () => {
    const adapter = new LocalExecutionAdapter();
    const task = createTask();
    const profile = createProfile([
      "-e",
      "process.stderr.write('boom');process.exit(2);"
    ]);

    const result = await adapter.execute(task, profile, "2026-04-27T07:00:00.000Z");

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("code 2");
    expect(result.outcomeSummary).toContain("boom");
  });

  it("records the explicit Codex model and reasoning effort in run metadata", () => {
    const adapter = new LocalExecutionAdapter();
    const task = createTask();
    const profile: ExecutionProfile = {
      ...createProfile([]),
      command: "codex",
      args: [
        "-m",
        "gpt-5.6-luna",
        "-c",
        "model_reasoning_effort=\"low\"",
        "-a",
        "never",
        "exec"
      ]
    };

    const request = adapter.createRequest(task, profile, "2026-04-27T07:00:00.000Z");

    expect(request.requestedCommand).toBe("codex");
    expect(request.model).toBe("gpt-5.6-luna");
    expect(request.reasoningEffort).toBe("low");
  });

  it("passes the CloudCLI host Claude login only to Claude executions", async () => {
    const hostEnvironment = {
      ANTHROPIC_AUTH_TOKEN: "test-only-token",
      ANTHROPIC_BASE_URL: "https://proxy.invalid"
    };
    const adapter = new LocalExecutionAdapter(() => hostEnvironment);
    const task = createTask();
    const profile = createProfile([
      "-e",
      "console.log(JSON.stringify({auth:process.env.ANTHROPIC_AUTH_TOKEN==='test-only-token',base:process.env.ANTHROPIC_BASE_URL==='https://proxy.invalid'}));"
    ]);
    const request = adapter.createRequest(task, profile, "2026-04-27T07:00:00.000Z");
    request.requestedCommand = "/home/cloudcli/.local/share/claude/versions/test";

    const result = await adapter.execute(task, profile, "2026-04-27T07:00:00.000Z", request);

    expect(result.status).toBe("succeeded");
    expect(result.outcomeSummary).toContain('{"auth":true,"base":true}');
    expect(result.executionRequest).not.toHaveProperty("environment");
  });

  it("does not expose the CloudCLI host Claude login to other commands", async () => {
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;

    try {
      const adapter = new LocalExecutionAdapter(() => ({
        ANTHROPIC_AUTH_TOKEN: "test-only-token",
        ANTHROPIC_BASE_URL: "https://proxy.invalid"
      }));
      const task = createTask();
      const profile = createProfile([
        "-e",
        "console.log(JSON.stringify({auth:!!process.env.ANTHROPIC_AUTH_TOKEN,base:!!process.env.ANTHROPIC_BASE_URL}));"
      ]);

      const result = await adapter.execute(task, profile, "2026-04-27T07:00:00.000Z");

      expect(result.status).toBe("succeeded");
      expect(result.outcomeSummary).toContain('{"auth":false,"base":false}');
    } finally {
      if (originalAuthToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
      }
      if (originalBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      }
    }
  });
});
