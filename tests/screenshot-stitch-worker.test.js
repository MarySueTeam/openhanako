import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PNG } from "pngjs";

vi.mock("electron", () => {
  function imageFromPngBuffer(buffer) {
    const parsed = PNG.sync.read(buffer);
    return {
      isEmpty: () => false,
      toBitmap: () => Buffer.from(parsed.data),
      getSize: () => ({ width: parsed.width, height: parsed.height }),
      toPNG: () => Buffer.from(buffer),
    };
  }

  return {
    app: {
      whenReady: () => Promise.resolve(),
      exit: vi.fn(),
    },
    nativeImage: {
      createFromBuffer(buffer) {
        return imageFromPngBuffer(buffer);
      },
      createFromBitmap(bitmap, { width, height }) {
        const png = new PNG({ width, height });
        png.data = Buffer.from(bitmap);
        return {
          toPNG: () => PNG.sync.write(png),
        };
      },
    },
  };
});

function writeSolidPng(filePath, { width, height, rgba }) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

describe("screenshot-stitch-worker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("把多个分段 PNG 按顺序拼成单张图", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ss-worker-"));
    try {
      const seg1 = path.join(tmpDir, "seg-1.png");
      const seg2 = path.join(tmpDir, "seg-2.png");
      const outputPath = path.join(tmpDir, "out.png");
      writeSolidPng(seg1, { width: 2, height: 1, rgba: [255, 0, 0, 255] });
      writeSolidPng(seg2, { width: 2, height: 1, rgba: [0, 0, 255, 255] });

      const { stitchScreenshotSegments } = await import("../desktop/screenshot-stitch-worker.cjs");
      stitchScreenshotSegments({
        segmentPaths: [seg1, seg2],
        outputPath,
        actualWidth: 2,
        actualTotalHeight: 2,
      });

      const stitched = PNG.sync.read(fs.readFileSync(outputPath));
      expect(stitched.width).toBe(2);
      expect(stitched.height).toBe(2);
      expect([...stitched.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
      expect([...stitched.data.slice((stitched.width << 2), (stitched.width << 2) + 4)]).toEqual([0, 0, 255, 255]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("超过原始 bitmap 预算时返回明确错误", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ss-worker-"));
    try {
      const seg = path.join(tmpDir, "seg-1.png");
      const outputPath = path.join(tmpDir, "out.png");
      writeSolidPng(seg, { width: 1, height: 1, rgba: [255, 255, 255, 255] });

      const { stitchScreenshotSegments } = await import("../desktop/screenshot-stitch-worker.cjs");
      expect(() => stitchScreenshotSegments({
        segmentPaths: [seg],
        outputPath,
        actualWidth: 1,
        actualTotalHeight: 1,
        maxRawBytes: 1,
      })).toThrow(/too large to stitch safely/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
