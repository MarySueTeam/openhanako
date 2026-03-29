// plugins/image-gen/adapters/volcengine.js

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const volcengineAdapter = {
  /**
   * @param {{ prompt: string, modelId: string, apiKey: string, baseUrl: string, size?: string, format?: string, quality?: string, providerDefaults?: object }} opts
   */
  async generate({ prompt, modelId, apiKey, baseUrl, size, format, quality, aspectRatio, image, providerDefaults }) {
    const outputFormat = format || providerDefaults?.format || "png";
    const body = {
      model: modelId,
      prompt,
      response_format: "b64_json",
      output_format: outputFormat,
    };

    // 火山引擎 size 字段支持两种格式：
    // 1. 比例字符串（"16:9"）+ quality 传分辨率档位（"2K"/"4K"）
    // 2. 精确像素（"2848x1600"）
    // 当有 aspect_ratio 时用方式 1，否则用 size 原值
    const effectiveRatio = aspectRatio || providerDefaults?.aspect_ratio;
    if (effectiveRatio) {
      body.size = effectiveRatio;
      // 分辨率档位通过 quality 字段传递
      const resolution = size || providerDefaults?.size;
      if (resolution) body.quality = resolution;
    } else if (size || providerDefaults?.size) {
      body.size = size || providerDefaults.size;
    }
    if (image) body.image = Array.isArray(image) ? image : [image];

    // Apply provider-specific defaults (watermark defaults to false)
    body.watermark = providerDefaults?.watermark ?? false;
    if (providerDefaults) {
      if (providerDefaults.guidance_scale !== undefined) body.guidance_scale = providerDefaults.guidance_scale;
      if (providerDefaults.seed !== undefined) body.seed = providerDefaults.seed;
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const images = data.data || [];
    if (images.length === 0) {
      throw new Error("API returned no images");
    }

    const mimeType = FORMAT_TO_MIME[outputFormat] || "image/png";

    return {
      images: images.map((img, i) => ({
        buffer: Buffer.from(img.b64_json, "base64"),
        mimeType,
        fileName: `image-${i + 1}.${outputFormat}`,
      })),
    };
  },
};
