import { describe, expect, it } from "vitest";
import {
  normalizeWorkspacePath,
  projectNameFromWorkspacePath,
  workspaceKeyFromPath
} from "../../src/shared/workspace.js";

describe("workspace helpers", () => {
  it("normalizes workspace paths", () => {
    expect(normalizeWorkspacePath("./specs")).toContain("/specs");
  });

  it("generates stable workspace keys", () => {
    const first = workspaceKeyFromPath("/tmp/project");
    const second = workspaceKeyFromPath("/tmp/project");
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
  });

  it("derives project names from paths", () => {
    expect(projectNameFromWorkspacePath("/tmp/my-project")).toBe("my-project");
  });
});
