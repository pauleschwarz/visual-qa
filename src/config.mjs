// Visual QA - configuration and execution bounds.

export const MODES = ["off", "changed", "full"];

export const DEFAULT_BOUNDS = {
  max_states: 40,
  max_depth: 6,
  max_actions_per_state: 8,
  max_total_actions: 160,
  max_runtime_ms: 180_000,
  max_agent_calls: 0, // deterministic slice: agents opt-in only
  max_retries_per_action: 2,
};

export const DEFAULT_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];

// Side-effect policy. Destructive actions are refused unless the environment is
// explicitly declared isolated in config - never inferred.
export const RISK = { SAFE: "SAFE", MUTATING: "MUTATING", DESTRUCTIVE: "DESTRUCTIVE" };

const DESTRUCTIVE_RE =
  /\b(delete|remove|destroy|purge|wipe|drop|deactivate|cancel subscription|unsubscribe|pay|purchase|checkout|buy|order now|send email|invite|logout|log out|sign out|reset|clear all|loesch|lösch|kündig|deaktiv|bezahl|kaufen)\b/i;
const MUTATING_RE =
  /\b(save|create|submit|add|update|upload|publish|apply|confirm|register|sign up|speicher|anleg|erstell|senden|absenden|bestaetig|bestätig)\b/i;

export function classifyRisk(label = "", tag = "") {
  const text = String(label).trim();
  if (DESTRUCTIVE_RE.test(text)) return RISK.DESTRUCTIVE;
  if (MUTATING_RE.test(text)) return RISK.MUTATING;
  if (tag === "a" || tag === "link") return RISK.SAFE;
  return RISK.SAFE;
}

export const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization|api-key)$/i;
const SECRET_VALUE =
  /(bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,})/gi;

/** Redact secrets from any structure before it reaches evidence on disk. */
export function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

export function resolveConfig(input = {}) {
  const mode = MODES.includes(input.mode) ? input.mode : "full";
  return {
    mode,
    baseUrl: input.baseUrl,
    outDir: input.outDir || ".qa",
    bounds: { ...DEFAULT_BOUNDS, ...(input.bounds || {}) },
    viewports: input.viewports || DEFAULT_VIEWPORTS,
    // Only an explicit declaration unlocks mutating/destructive actions.
    isolatedEnvironment: input.isolatedEnvironment === true,
    allowMutating: input.isolatedEnvironment === true && input.allowMutating !== false,
    allowDestructive: input.isolatedEnvironment === true && input.allowDestructive === true,
    intent: input.intent || null,
    baselineDir: input.baselineDir || null,
    autofix: input.autofix === "verified" ? "verified" : false,
    trace: input.trace !== false,
  };
}
