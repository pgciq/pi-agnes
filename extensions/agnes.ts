// Agnes AI provider (OpenAI-compatible) — https://agnes-ai.com
// Docs: https://agnes-ai.com/zh-Hans/docs/overview
// Auth: AGNES_API_KEY env var (user-level Windows env var)
//
// Model discovery: registers a fast seed list on startup, then refreshes
// from /v1/models in the background.  Discovered models are persisted to disk
// and re-used on subsequent starts when the API is unreachable.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  openAICompletionsApi,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function detectLimits(id) {
  if (id.startsWith("agnes-2.5")) return { contextWindow: 1048576, maxTokens: 65536 };
  if (id.startsWith("agnes-2.0")) return { contextWindow: 1048576, maxTokens: 32768 };
  // Sensible defaults for unknown models
  return { contextWindow: 131072, maxTokens: 32768 };
}

const IMAGE_MODELS = new Set(["agnes-image-2.0-flash", "agnes-image-2.1-flash"]);

function convertModel(model) {
  const id = model.id;
  const imageModel = IMAGE_MODELS.has(id);
  return {
    id,
    name: model.id || id,
    reasoning: false,
    input: imageModel ? ["text", "image"] : ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...detectLimits(id),
    agnesImageModel: imageModel,
  };
}

// ---------------------------------------------------------------------------
// Seed models (available immediately on startup)
// ---------------------------------------------------------------------------

const AGNES_SEED = [
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "agnes-2.5-pro-alpha",
  "agnes-2.0-flash",
];

// ---------------------------------------------------------------------------
// Dynamic model fetch (shared by startup & refreshModels)
// ---------------------------------------------------------------------------

async function fetchModels(baseUrl, apiKey, signal) {
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/models`, { headers, redirect: "follow", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const payload = await res.json();
  // OpenAI /v1/models returns { data: [{ id, ... }] }
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return data
    .filter((m) => m && m.id)
    .map(convertModel);
}

// ---------------------------------------------------------------------------
// Agnes image generation API
// ---------------------------------------------------------------------------

function latestUser(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  return [...messages].reverse().find((message) => message?.role === "user");
}

function imageRequestContent(context) {
  const user = latestUser(context);
  if (!user) return { prompt: "", images: [] };
  if (typeof user.content === "string") return { prompt: user.content, images: [] };
  return {
    prompt: user.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n"),
    images: user.content.filter((part) => part?.type === "image"),
  };
}

async function saveImage(image, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-images");
  await mkdir(directory, { recursive: true });
  const mime = image?.mime_type ?? "image/png";
  const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  const filePath = join(directory, `${modelId}-${Date.now()}.${extension}`);
  if (image?.b64_json) await writeFile(filePath, Buffer.from(image.b64_json, "base64"));
  else if (image?.url) {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`Unable to download image: HTTP ${response.status}`);
    await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  } else throw new Error("Agnes image API returned no url or b64_json");
  return filePath;
}

function streamAgnesImage(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const output = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending", timestamp: Date.now(),
  };
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const { prompt, images } = imageRequestContent(context);
      if (!prompt) throw new Error("Image generation requires a text prompt");
      const body = {
        model: model.id,
        prompt,
        ...(images.length ? { image: images.map((image) => `data:${image.mimeType};base64,${image.data}`) } : {}),
        extra_body: { response_format: "url" },
      };
      const baseUrl = model.baseUrl ?? (model.provider === "agnes-cn" ? "https://api.agnes-ai.cn/v1" : "https://apihub.agnes-ai.com/v1");
      const response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env[model.provider === "agnes-cn" ? "AGNES_CN_API_KEY" : "AGNES_API_KEY"] ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: options?.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? `Agnes image API HTTP ${response.status}`);
      const image = payload?.data?.[0];
      if (!image) throw new Error("Agnes image API returned no image data");
      const filePath = await saveImage(image, model.id);
      const text = image.url
        ? `![Generated image](${image.url})\n\nSaved local copy: ${filePath}\n\nImage URL may expire according to Agnes retention policy.`
        : `Generated image saved to: ${filePath}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function streamAgnes(model, context, options) {
  if (model.agnesImageModel || IMAGE_MODELS.has(model.id)) return streamAgnesImage(model, context, options);
  return openAICompletionsApi().streamSimple(model, context, options);
}

// ---------------------------------------------------------------------------
// Extension entry point (synchronous — no network on startup)
// ---------------------------------------------------------------------------

export default function (pi) {
  const providers = [
    { id: "agnes", name: "Agnes AI", baseUrl: "https://apihub.agnes-ai.com/v1", apiKeyEnv: "AGNES_API_KEY" },
    { id: "agnes-cn", name: "Agnes AI (CN)", baseUrl: "https://api.agnes-ai.cn/v1", apiKeyEnv: "AGNES_CN_API_KEY" },
  ];

  for (const p of providers) {
    const baseUrl = p.baseUrl;
    const apiKeyEnv = p.apiKeyEnv;
    // Let /login provide the key when the environment variable is absent.
    // A literal placeholder would make pi consider the provider configured,
    // while still sending an invalid key during model refresh.
    const apiKeyRef = process.env[apiKeyEnv] ? `$${apiKeyEnv}` : undefined;

    pi.registerProvider(p.id, {
      name: p.name,
      baseUrl,
      ...(apiKeyRef ? { apiKey: apiKeyRef } : {}),
      api: "openai-completions",
      streamSimple: streamAgnes,
      models: AGNES_SEED.map((id) => convertModel({ id })),

      async refreshModels({ signal, stored, publish, allowNetwork, credential }) {
        // `stored` is a catalog entry ({ models: [...] }), not the model list
        // itself. Returning it directly makes pi reject the refresh result.
        const cachedModels = Array.isArray(stored?.models) ? stored.models : undefined;

        // Pi runs a cache-only refresh during startup and passes the resolved
        // credential (from env or /login) to the network refresh. Do not fetch
        // from process.env here: that would ignore keys entered via /login.
        if (!allowNetwork || signal.aborted) return cachedModels;

        const apiKey = credential?.type === "api_key"
          ? credential.key
          : process.env[apiKeyEnv];

        let models;
        try {
          models = await fetchModels(baseUrl, apiKey, signal);
        } catch (error) {
          // Keep the last valid catalog on transient network/auth failures.
          // Re-throw only when there is no cache, so pi can report the error
          // without replacing the seed models with an invalid value.
          if (cachedModels) return cachedModels;
          throw error;
        }

        if (models.length > 0) {
          // Persist the catalog so it survives restarts & offline starts.
          await publish({ persist: { provider: p.id, models } });
          return models;
        }

        // No models returned — keep whatever we have.
        return cachedModels;
      },
    });
  }
}
