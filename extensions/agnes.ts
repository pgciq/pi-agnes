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

async function fetchModels(baseUrl, apiKeyEnv, signal) {
  const apiKey = process.env[apiKeyEnv];
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
    // If env var is set, use $VAR reference so pi picks it up; otherwise
    // use a placeholder so the provider still shows in --list-models and
    // the user gets a clear auth error instead of a silent skip.
    const apiKeyRef = process.env[apiKeyEnv] ? `$${apiKeyEnv}` : "<missing>";
    if (!process.env[apiKeyEnv]) {
      console.error(`[pi-agnes] ${p.name}: ${apiKeyEnv} is not set. Provider will be listed but API calls will fail until the env var is configured.`);
    }

    pi.registerProvider(p.id, {
      name: p.name,
      baseUrl,
      apiKey: apiKeyRef,
      api: "openai-completions",
      models: AGNES_SEED.map((id) => convertModel({ id })),

      async refreshModels({ signal, stored, publish }) {
        let models;
        try {
          models = await fetchModels(baseUrl, apiKeyEnv, signal);
        } catch (error) {
          // If we have a cached catalog from a previous refresh, use it
          if (stored) return stored;
          // Otherwise keep the seed list (caller still has it)
          throw error;
        }

        if (models.length > 0) {
          // Persist the catalog so it survives restarts & offline starts
          publish({ persist: { provider: p.id, models } });
          return models;
        }

        // No models returned — keep whatever we have
        return stored ?? undefined;
      },
    });
  }
}
