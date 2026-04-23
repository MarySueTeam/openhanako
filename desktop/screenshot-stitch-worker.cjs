const fs = require("fs");
const { app, nativeImage } = require("electron");

const MAX_SCREENSHOT_STITCH_RAW_BYTES = 512 * 1024 * 1024;

function formatMiB(bytes) {
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

function stitchScreenshotSegments({
  segmentPaths,
  outputPath,
  actualWidth,
  actualTotalHeight,
  maxRawBytes = MAX_SCREENSHOT_STITCH_RAW_BYTES,
}) {
  if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) {
    throw new Error("segmentPaths is required");
  }
  if (!outputPath) {
    throw new Error("outputPath is required");
  }
  if (!Number.isInteger(actualWidth) || actualWidth <= 0) {
    throw new Error("actualWidth must be a positive integer");
  }
  if (!Number.isInteger(actualTotalHeight) || actualTotalHeight <= 0) {
    throw new Error("actualTotalHeight must be a positive integer");
  }

  const rawBytes = actualWidth * actualTotalHeight * 4;
  if (!Number.isSafeInteger(rawBytes)) {
    throw new Error("screenshot bitmap size overflow");
  }
  if (rawBytes > maxRawBytes) {
    throw new Error(
      `screenshot is too large to stitch safely (${formatMiB(rawBytes)} raw > ${formatMiB(maxRawBytes)} limit)`
    );
  }

  const fullBitmap = Buffer.alloc(rawBytes);
  let yOffset = 0;

  for (const segPath of segmentPaths) {
    const seg = nativeImage.createFromBuffer(fs.readFileSync(segPath));
    if (seg.isEmpty()) {
      throw new Error(`failed to decode screenshot segment: ${segPath}`);
    }
    const bitmap = seg.toBitmap();
    const size = seg.getSize();
    if (size.width !== actualWidth) {
      throw new Error(`segment width mismatch: expected ${actualWidth}, got ${size.width}`);
    }
    if (yOffset + size.height > actualTotalHeight) {
      throw new Error("segment stack exceeds target height");
    }

    const partRowBytes = size.width * 4;
    for (let row = 0; row < size.height; row++) {
      bitmap.copy(
        fullBitmap,
        (yOffset + row) * actualWidth * 4,
        row * partRowBytes,
        row * partRowBytes + partRowBytes
      );
    }
    yOffset += size.height;
  }

  if (yOffset !== actualTotalHeight) {
    throw new Error(`segment stack height mismatch: expected ${actualTotalHeight}, got ${yOffset}`);
  }

  const image = nativeImage.createFromBitmap(fullBitmap, {
    width: actualWidth,
    height: actualTotalHeight,
  });
  fs.writeFileSync(outputPath, image.toPNG());
}

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error("worker payload is required");
  const payload = JSON.parse(raw);
  stitchScreenshotSegments(payload);
  process.stdout.write(JSON.stringify({ ok: true, outputPath: payload.outputPath }));
}

if (require.main === module) {
  app.whenReady()
    .then(main)
    .then(() => process.exit(0))
    .catch((err) => {
      const message = err?.message || String(err);
      process.stderr.write(message);
      process.exit(1);
    });
}

module.exports = {
  MAX_SCREENSHOT_STITCH_RAW_BYTES,
  stitchScreenshotSegments,
};
