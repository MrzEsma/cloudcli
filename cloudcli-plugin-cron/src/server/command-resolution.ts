import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ExecutionCommandResolution {
  requestedCommand: string;
  resolvedCommand: string;
  found: boolean;
  source: "explicit" | "environment" | "path" | "known_location" | "unresolved";
}

const CLI_PATH_ENV: Record<string, string> = {
  codex: "CODEX_CLI_PATH",
  claude: "CLAUDE_CLI_PATH",
  gemini: "GEMINI_CLI_PATH"
};

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathComponent(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function knownLocations(command: string, homeDir: string): string[] {
  return [
    path.join("/app", "node_modules", ".bin", command),
    path.join(homeDir, ".local", "bin", command),
    path.join(homeDir, ".npm-global", "bin", command),
    path.join("/usr", "local", "bin", command),
    path.join("/usr", "bin", command)
  ];
}

export function resolveExecutionCommand(
  requestedCommand: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): ExecutionCommandResolution {
  const command = requestedCommand.trim();
  if (!command) {
    return {
      requestedCommand: command,
      resolvedCommand: command,
      found: false,
      source: "unresolved"
    };
  }

  if (hasPathComponent(command)) {
    return {
      requestedCommand: command,
      resolvedCommand: command,
      found: isExecutable(command),
      source: "explicit"
    };
  }

  const envKey = CLI_PATH_ENV[command];
  const environmentCandidate = envKey ? env[envKey]?.trim() : undefined;
  if (environmentCandidate && isExecutable(environmentCandidate)) {
    return {
      requestedCommand: command,
      resolvedCommand: environmentCandidate,
      found: true,
      source: "environment"
    };
  }

  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) {
      return {
        requestedCommand: command,
        resolvedCommand: candidate,
        found: true,
        source: "path"
      };
    }
  }

  for (const candidate of knownLocations(command, homeDir)) {
    if (isExecutable(candidate)) {
      return {
        requestedCommand: command,
        resolvedCommand: candidate,
        found: true,
        source: "known_location"
      };
    }
  }

  return {
    requestedCommand: command,
    resolvedCommand: command,
    found: false,
    source: "unresolved"
  };
}
