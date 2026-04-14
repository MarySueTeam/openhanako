import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("skills route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-skills-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it("runtime=1 时返回包含 workspace skills 的运行时视图，默认仍是 agent 全局技能列表", async () => {
    const agentId = "hana";
    const agentDir = path.join(tempRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Hana\n", "utf-8");

    const { createSkillsRoute } = await import("../server/routes/skills.js");
    const app = new Hono();

    const getAllSkills = vi.fn(() => [{ name: "global-skill", enabled: true }]);
    const getRuntimeSkills = vi.fn(() => [
      { name: "global-skill", enabled: true },
      { name: "workspace-skill", enabled: true, managedBy: "workspace" },
    ]);

    const engine = {
      agentsDir: tempRoot,
      getAllSkills,
      getRuntimeSkills,
    };

    app.route("/api", createSkillsRoute(engine));

    const defaultRes = await app.request(`/api/skills?agentId=${agentId}`);
    expect(defaultRes.status).toBe(200);
    expect(await defaultRes.json()).toEqual({
      skills: [{ name: "global-skill", enabled: true }],
    });
    expect(getAllSkills).toHaveBeenCalledWith(agentId);
    expect(getRuntimeSkills).not.toHaveBeenCalled();

    const runtimeRes = await app.request(`/api/skills?agentId=${agentId}&runtime=1`);
    expect(runtimeRes.status).toBe(200);
    expect(await runtimeRes.json()).toEqual({
      skills: [
        { name: "global-skill", enabled: true },
        { name: "workspace-skill", enabled: true, managedBy: "workspace" },
      ],
    });
    expect(getRuntimeSkills).toHaveBeenCalledWith(agentId);
  });
});
