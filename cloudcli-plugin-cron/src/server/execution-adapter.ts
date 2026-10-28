import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExecutionProfile, WorkspaceTask } from "../shared/model.js";
import { resolveExecutionCommand } from "./command-resolution.js";

const CLAUDE_HOST_ENV_KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;

type HostEnvironmentProvider = () => NodeJS.ProcessEnv;

export interface ExecutionRequestMetadata {
  [key: string]: unknown;
  requestedCommand: string;
  command: string;
  args: string[];
  cwd: string;
  promptTransport: "stdin" | "argument";
  model: string | null;
  reasoningEffort: string | null;
}

export interface ExecutionResult {
  status: "succeeded" | "failed";
  outcomeSummary: string;
  failureReason: string | null;
  executionRequest: ExecutionRequestMetadata;
}

function trimCapturedOutput(output: string): string {
  const normalized = output.trim();
  if (!normalized) {
    return "";
  }
  return normalized;
}

function summarizeSuccess(stdout: string, stderr: string): string {
  const stdoutPreview = trimCapturedOutput(stdout);
  const stderrPreview = trimCapturedOutput(stderr);

  if (stdoutPreview) {
    return `Command completed successfully. stdout: ${stdoutPreview}`;
  }
  if (stderrPreview) {
    return `Command completed successfully with stderr output: ${stderrPreview}`;
  }
  return "Command completed successfully.";
}

function summarizeFailure(reason: string, stdout: string, stderr: string): string {
  const stdoutPreview = trimCapturedOutput(stdout);
  const stderrPreview = trimCapturedOutput(stderr);
  const details = [reason];
  if (stderrPreview) {
    details.push(`stderr: ${stderrPreview}`);
  }
  if (stdoutPreview) {
    details.push(`stdout: ${stdoutPreview}`);
  }
  return details.join(" | ");
}

function replaceTemplateTokens(input: string, task: WorkspaceTask, scheduledFor: string): string {
  return input
    .replaceAll("{{prompt}}", task.prompt)
    .replaceAll("{{workspacePath}}", task.workspacePath)
    .replaceAll("{{taskName}}", task.name)
    .replaceAll("{{taskId}}", task.id)
    .replaceAll("{{scheduledFor}}", scheduledFor);
}

function usesPromptTemplate(profile: ExecutionProfile): boolean {
  return profile.command.includes("{{prompt}}") || profile.args.some((entry) => entry.includes("{{prompt}}"));
}

function argumentValue(args: string[], shortName: string, longName: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === shortName || entry === longName) {
      return args[index + 1] ?? null;
    }
    if (entry.startsWith(`${longName}=`)) {
      return entry.slice(longName.length + 1);
    }
  }
  return null;
}

function configValue(args: string[], key: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c" && args[index] !== "--config") {
      continue;
    }
    const assignment = args[index + 1] ?? "";
    const prefix = `${key}=`;
    if (!assignment.startsWith(prefix)) {
      continue;
    }
    return assignment.slice(prefix.length).replace(/^['"]|['"]$/gu, "") || null;
  }
  return null;
}

function isClaudeCommand(request: ExecutionRequestMetadata): boolean {
  return [request.requestedCommand, request.command].some((command) => {
    const normalized = command.replaceAll("\\", "/").toLowerCase();
    const executable = path.posix.basename(normalized);
    return executable === "claude" || executable === "claude.exe" || normalized.includes("/claude/versions/");
  });
}

function parseEnvironmentBlock(block: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of block.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function readClaudeEnvironmentFromCloudCliParent(): NodeJS.ProcessEnv {
  if (process.platform !== "linux" || process.ppid <= 1) {
    return {};
  }

  try {
    const parentRoot = `/proc/${process.ppid}`;
    const parentCommand = readFileSync(`${parentRoot}/cmdline`, "utf8").replaceAll("\0", " ");
    if (!/(?:^|[\s/])cloudcli(?:\s|$)|@cloudcli-ai\/cloudcli/u.test(parentCommand)) {
      return {};
    }

    const parentEnvironment = parseEnvironmentBlock(readFileSync(`${parentRoot}/environ`, "utf8"));
    const claudeEnvironment: NodeJS.ProcessEnv = {};
    for (const key of CLAUDE_HOST_ENV_KEYS) {
      const value = parentEnvironment[key];
      if (value) {
        claudeEnvironment[key] = value;
      }
    }
    return claudeEnvironment;
  } catch {
    return {};
  }
}

function buildExecutionRequest(task: WorkspaceTask, profile: ExecutionProfile, scheduledFor: string): ExecutionRequestMetadata {
  const args = profile.args.map((entry) => replaceTemplateTokens(entry, task, scheduledFor));
  const requestedCommand = replaceTemplateTokens(profile.command, task, scheduledFor);
  const resolution = resolveExecutionCommand(requestedCommand);
  return {
    requestedCommand,
    command: resolution.resolvedCommand,
    args,
    cwd: task.workspacePath,
    promptTransport: usesPromptTemplate(profile) ? "argument" : "stdin",
    model: argumentValue(args, "-m", "--model"),
    reasoningEffort: configValue(args, "model_reasoning_effort")
  };
}

export class LocalExecutionAdapter {
  constructor(private readonly hostEnvironmentProvider: HostEnvironmentProvider = readClaudeEnvironmentFromCloudCliParent) {}

  createRequest(task: WorkspaceTask, profile: ExecutionProfile, scheduledFor: string): ExecutionRequestMetadata {
    return buildExecutionRequest(task, profile, scheduledFor);
  }

  async execute(
    task: WorkspaceTask,
    profile: ExecutionProfile,
    scheduledFor: string,
    request = this.createRequest(task, profile, scheduledFor)
  ): Promise<ExecutionResult> {

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finalize = (result: ExecutionResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      let child;
      try {
        const hostEnvironment = isClaudeCommand(request) ? this.hostEnvironmentProvider() : {};
        child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: {
            ...process.env,
            ...hostEnvironment,
            SCHEDULED_PROMPT: task.prompt,
            SCHEDULED_TASK_ID: task.id,
            SCHEDULED_TASK_NAME: task.name,
            SCHEDULED_WORKSPACE_PATH: task.workspacePath,
            SCHEDULED_FOR: scheduledFor
          },
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Failed to launch local command.";
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(reason, stdout, stderr),
          failureReason: reason,
          executionRequest: request
        });
        return;
      }

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(`Command timed out after ${profile.timeoutMs}ms.`, stdout, stderr),
          failureReason: `Command timed out after ${profile.timeoutMs}ms.`,
          executionRequest: request
        });
      }, profile.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(error.message, stdout, stderr),
          failureReason: error.message,
          executionRequest: request
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (settled) {
          return;
        }
        if (code === 0) {
          finalize({
            status: "succeeded",
            outcomeSummary: summarizeSuccess(stdout, stderr),
            failureReason: null,
            executionRequest: request
          });
          return;
        }

        const reason = signal
          ? `Command terminated by signal ${signal}.`
          : `Command exited with code ${code ?? "unknown"}.`;
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(reason, stdout, stderr),
          failureReason: reason,
          executionRequest: request
        });
      });

      if (request.promptTransport === "stdin") {
        child.stdin.write(task.prompt);
      }
      child.stdin.end();
    });
  }
}
