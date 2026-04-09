import { describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../lib/browser/browser-manager.js";

describe("BrowserManager URL tracking", () => {
  it.each([
    ["scroll", (manager) => manager.scroll("down", 2)],
    ["select", (manager) => manager.select(7, "next")],
    ["pressKey", (manager) => manager.pressKey("Enter")],
    ["wait", (manager) => manager.wait({ timeout: 100 })],
  ])("%s updates currentUrl from browser command results", async (_name, action) => {
    const manager = new BrowserManager();
    manager._url = "https://before.example.com";
    manager._sendCmd = vi.fn().mockResolvedValue({
      currentUrl: "https://after.example.com",
      text: "snapshot",
    });

    const text = await action(manager);

    expect(text).toBe("snapshot");
    expect(manager.currentUrl).toBe("https://after.example.com");
  });
});

describe("BrowserManager explicit sessionPath", () => {
  it("launch() with explicit sessionPath uses it", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    await manager.launch("/sessions/explicit-session.json");

    expect(manager._sessionPath).toBe("/sessions/explicit-session.json");
    expect(manager._running).toBe(true);
    // The sendCmd should have been called with the explicit sessionPath
    expect(manager._sendCmd).toHaveBeenCalledWith("launch", {
      sessionPath: "/sessions/explicit-session.json",
      headless: false,
    });
  });

  it("launch() without explicit sessionPath falls back to _sessionPath", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    manager._sessionPath = "/sessions/fallback-session.json";

    await manager.launch();

    expect(manager._sessionPath).toBe("/sessions/fallback-session.json");
    expect(manager._sendCmd).toHaveBeenCalledWith("launch", {
      sessionPath: "/sessions/fallback-session.json",
      headless: false,
    });
  });

  it("navigate() with explicit sessionPath uses it for cold save", async () => {
    const manager = new BrowserManager();
    manager._running = true;
    manager._sessionPath = "/sessions/launch-session.json";
    manager._sendCmd = vi.fn().mockResolvedValue({
      url: "https://example.com/page",
      title: "Page",
      snapshot: "...",
    });
    manager._saveColdUrl = vi.fn();

    await manager.navigate("https://example.com/page", "/sessions/nav-session.json");

    // Explicit param takes priority over _sessionPath
    expect(manager._saveColdUrl).toHaveBeenCalledWith(
      "/sessions/nav-session.json",
      "https://example.com/page",
    );
  });

  it("navigate() without explicit sessionPath uses _sessionPath from launch()", async () => {
    const manager = new BrowserManager();
    manager._running = true;
    manager._sessionPath = "/sessions/launch-session.json";
    manager._sendCmd = vi.fn().mockResolvedValue({
      url: "https://example.com/page",
      title: "Page",
      snapshot: "...",
    });
    manager._saveColdUrl = vi.fn();

    await manager.navigate("https://example.com/page");

    // Falls back to _sessionPath set during launch (no resolver fallback)
    expect(manager._saveColdUrl).toHaveBeenCalledWith(
      "/sessions/launch-session.json",
      "https://example.com/page",
    );
  });

  it("close() clears _sessionPath and uses it for cleanup", async () => {
    const manager = new BrowserManager();
    manager._running = true;
    manager._sessionPath = "/sessions/active-session.json";
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._removeColdUrl = vi.fn();

    await manager.close();

    // Should use _sessionPath for cleanup
    expect(manager._removeColdUrl).toHaveBeenCalledWith("/sessions/active-session.json");
    expect(manager._sessionPath).toBeNull();
    expect(manager._running).toBe(false);
  });

  it("getBrowserSessions() prefers _sessionPath over resolver", () => {
    const manager = new BrowserManager();
    manager._running = true;
    manager._url = "https://example.com";
    manager._sessionPath = "/sessions/bound-session.json";
    manager._loadColdState = vi.fn().mockReturnValue({});

    const sessions = manager.getBrowserSessions();

    expect(sessions).toEqual({
      "/sessions/bound-session.json": "https://example.com",
    });
  });
});
