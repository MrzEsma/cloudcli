import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExecutionCommand } from "../../src/server/command-resolution.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createExecutable(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scheduled-command-"));
  tempDirs.push(directory);
  const executable = path.join(directory, name);
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o700);
  return executable;
}

describe("execution command resolution", () => {
  it("prefers the host-provided CLI path for known commands", async () => {
    const executable = await createExecutable("codex-host");
    const resolution = resolveExecutionCommand("codex", {
      PATH: "",
      CODEX_CLI_PATH: executable
    });

    expect(resolution).toMatchObject({
      requestedCommand: "codex",
      resolvedCommand: executable,
      found: true,
      source: "environment"
    });
  });

  it("resolves a bare command from PATH", async () => {
    const executable = await createExecutable("custom-cli");
    const resolution = resolveExecutionCommand("custom-cli", {
      PATH: path.dirname(executable)
    });

    expect(resolution.resolvedCommand).toBe(executable);
    expect(resolution.source).toBe("path");
    expect(resolution.found).toBe(true);
  });

  it("reports an unavailable explicit path as unresolved", () => {
    const resolution = resolveExecutionCommand("/definitely/missing/scheduled-cli", { PATH: "" });

    expect(resolution.found).toBe(false);
    expect(resolution.source).toBe("explicit");
  });
});
