// Agnes AI provider (OpenAI-compatible) — https://agnes-ai.com
// Docs: https://agnes-ai.com/zh-Hans/docs/overview
// Auth: AGNES_API_KEY env var (user-level Windows env var)
//
// Model discovery: registers a fast seed list on startup, then refreshes
// from /v1/models in the background.  Discovered models are persisted to disk
// and re-used on subsequent starts when the API is unreachable.

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function detectLimits(id) {
  if (id.startsWith("agnes-2.5")) return { contextWindow: 1048576, maxTokens: 65536 };
  if (id.startsWith("agnes-2.0")) return { contextWindow: 1048576, maxTokens: 32768 };
  // Sensible defaults for unknown models
  return { contextWindow: 131072, maxTokens: 32768 };
}

function convertModel(model) {
  const id = model.id;
  return {
    id,
    name: model.id || id,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...detectLimits(id),
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
