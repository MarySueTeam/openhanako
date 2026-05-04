import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.js";
import { setMediaLocalRoots } from "../lib/bridge/media-utils.js";
import { TELEGRAM_MEDIA_CAPABILITIES } from "../lib/bridge/telegram-adapter.js";
import { FEISHU_MEDIA_CAPABILITIES } from "../lib/bridge/feishu-adapter.js";
import { QQ_MEDIA_CAPABILITIES } from "../lib/bridge/qq-adapter.js";

describe("MediaDeliveryService", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTempFile(name, content = "hello") {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-media-delivery-"));
    setMediaLocalRoots([tmpDir]);
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function makeService(sessionFile, extra = {}) {
    return new MediaDeliveryService({
      engine: {
        getSessionFile: vi.fn((id) => id === sessionFile?.id ? sessionFile : null),
      },
      ...extra,
    });
  }

  it("delivers Telegram-like session files through buffer upload", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const service = makeService({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: TELEGRAM_MEDIA_CAPABILITIES,
      sendMediaBuffer: vi.fn(async () => {}),
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "telegram",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
    expect(adapter.sendMediaBuffer.mock.calls[0][0]).toBe("chat-1");
    expect(Buffer.isBuffer(adapter.sendMediaBuffer.mock.calls[0][1])).toBe(true);
    expect(adapter.sendMediaBuffer.mock.calls[0][2]).toEqual({
      mime: "image/png",
      filename: "image.png",
    });
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("delivers Feishu-like documents through buffer upload", async () => {
    const filePath = makeTempFile("note.txt", "ok");
    const service = makeService({
      id: "sf_doc",
      filePath,
      realPath: filePath,
      filename: "note.txt",
      mime: "text/plain",
      kind: "document",
    });
    const adapter = {
      mediaCapabilities: FEISHU_MEDIA_CAPABILITIES,
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "feishu",
      mediaItem: { type: "session_file", fileId: "sf_doc" },
    });

    expect(adapter.sendMediaBuffer).toHaveBeenCalledWith(
      "chat-1",
      expect.any(Buffer),
      { mime: "text/plain", filename: "note.txt" },
    );
  });

  it("resolves session files with sessionPath so persisted sidecars can be hydrated", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const getSessionFile = vi.fn((id, options) => {
      if (id !== "sf_image" || options?.sessionPath !== "/sessions/main.jsonl") return null;
      return {
        id: "sf_image",
        sessionPath: "/sessions/main.jsonl",
        filePath,
        realPath: filePath,
        filename: "image.png",
        mime: "image/png",
        kind: "image",
      };
    });
    const service = new MediaDeliveryService({ engine: { getSessionFile } });
    const adapter = {
      mediaCapabilities: TELEGRAM_MEDIA_CAPABILITIES,
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "telegram",
      mediaItem: { type: "session_file", fileId: "sf_image", sessionPath: "/sessions/main.jsonl" },
    });

    expect(getSessionFile).toHaveBeenCalledWith("sf_image", { sessionPath: "/sessions/main.jsonl" });
    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
  });

  it("delivers QQ images through public URL with original file metadata", async () => {
    const service = makeService({
      id: "sf_image",
      filename: "image.png",
      mime: "image/png",
      kind: "image",
      size: 4,
      publicUrl: "https://cdn.example.com/image.png",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(adapter.sendMedia).toHaveBeenCalledWith("chat-1", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      size: 4,
    });
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("delivers QQ documents through public URL for C2C-capable adapters", async () => {
    const service = makeService({
      id: "sf_doc",
      filename: "note.txt",
      mime: "text/plain",
      kind: "document",
      size: 2,
      publicUrl: "https://cdn.example.com/note.txt",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_doc" },
    });

    expect(adapter.sendMedia).toHaveBeenCalledWith("chat-1", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      size: 2,
    });
  });

  it("passes bridge target scope metadata to URL-only adapters", async () => {
    const service = makeService({
      id: "sf_image",
      filename: "image.png",
      mime: "image/png",
      kind: "image",
      publicUrl: "https://cdn.example.com/image.png",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "group-openid",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
      isGroup: true,
    });

    expect(adapter.sendMedia).toHaveBeenCalledWith("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
      targetScope: "group",
    });
  });

  it("rejects QQ local images without public URL", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const service = makeService({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await expect(service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    })).rejects.toThrow(/bridge_media_public_base_url/);
    expect(adapter.sendMedia).not.toHaveBeenCalled();
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("publishes QQ local images before sending them as public URLs", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const mediaPublisher = {
      setBaseUrl: vi.fn(),
      publish: vi.fn(() => ({
        publicUrl: "https://hana.example.com/api/bridge/media/token_123",
        expiresAt: 61_000,
      })),
    };
    const service = makeService({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    }, { mediaPublisher });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(mediaPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      id: "sf_image",
      realPath: filePath,
    }));
    expect(mediaPublisher.setBaseUrl).toHaveBeenCalledOnce();
    expect(adapter.sendMedia).toHaveBeenCalledWith(
      "chat-1",
      "https://hana.example.com/api/bridge/media/token_123",
      {
        kind: "image",
        mime: "image/png",
        filename: "image.png",
      },
    );
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("refreshes the publisher base URL from preferences before publishing local files", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const mediaPublisher = {
      setBaseUrl: vi.fn(),
      publish: vi.fn(() => ({
        publicUrl: "https://new.example.com/api/bridge/media/token_123",
        expiresAt: 61_000,
      })),
    };
    const sessionFile = {
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    };
    const service = new MediaDeliveryService({
      engine: {
        getBridgeMediaPublicBaseUrl: vi.fn(() => "https://new.example.com"),
        getSessionFile: vi.fn((id) => id === "sf_image" ? sessionFile : null),
      },
      mediaPublisher,
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(mediaPublisher.setBaseUrl).toHaveBeenCalledWith("https://new.example.com");
    expect(adapter.sendMedia).toHaveBeenCalledWith(
      "chat-1",
      "https://new.example.com/api/bridge/media/token_123",
      expect.objectContaining({ filename: "image.png" }),
    );
  });
});
