// Visual QA - configuration and execution bounds.

export const MODES = ["off", "changed", "full"];

export const DEFAULT_BOUNDS = {
  max_states: 40,
  max_depth: 6,
  max_actions_per_state: 6,
  max_total_actions: 160,
  // Coherent with the other bounds: 40 states x 6 actions x ~3s/action plus
  // scan overhead lands near 15 minutes. The previous 180s default could not
  // cover even a fraction of max_states, so real runs always ended
  // COVERAGE_INCOMPLETE by wall clock, not by graph size.
  max_runtime_ms: 900_000,
  max_agent_calls: 0, // deterministic slice: agents opt-in only
  max_retries_per_action: 2,
};

export const DEFAULT_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];

// Side-effect policy. Destructive actions are refused unless the environment is
// explicitly declared isolated in config - never inferred.
export const RISK = {
  SAFE: "SAFE",
  MUTATING: "MUTATING",
  DESTRUCTIVE: "DESTRUCTIVE",
};

const DESTRUCTIVE_RE =
  /\b(delete|remove|destroy|purge|wipe|drop|deactivate|cancel subscription|unsubscribe|pay|purchase|checkout|buy|order now|send email|invite|logout|log out|sign out|reset|clear all|loesch|lösch|kündig|deaktiv|bezahl|kaufen)\b/i;
const MUTATING_RE =
  /\b(save|create|submit|add|update|upload|publish|apply|confirm|register|sign up|speicher|anleg|erstell|senden|absenden|bestaetig|bestätig)\b/i;

export function classifyRisk(label = "", tag = "", type = "") {
  const text = String(label).trim();
  if (DESTRUCTIVE_RE.test(text)) return RISK.DESTRUCTIVE;
  if (MUTATING_RE.test(text)) return RISK.MUTATING;
  // A submit control posts its form even under an innocent label.
  if (String(type).toLowerCase() === "submit") return RISK.MUTATING;
  if (tag === "a" || tag === "link") return RISK.SAFE;
  return RISK.SAFE;
}

export const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization|api-key|password|passphrase|secret)$/i;
const SECRET_VALUE =
  /(bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,})/gi;

/** Redact secrets from any structure before it reaches evidence on disk. */
export function redact(value) {
  if (value == null) return value;
  if (typeof value === "string")
    return value.replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      SECRET_KEYS.lastIndex = 0;
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

export function resolveConfig(input = {}) {
  // The mode is a contract, not a hint: an unknown value must block the run
  // instead of silently degrading to a full walk.
  const mode = input.mode === undefined || input.mode === null ? "full" : input.mode;
  if (!MODES.includes(mode))
    throw new Error(
      `Unknown mode "${mode}"; expected one of: ${MODES.join(", ")}`,
    );
  // "changed" only ever walks an explicitly declared target source.
  const changedTargets = Array.isArray(input.changedTargets)
    ? input.changedTargets.map((target) => String(target)).filter(Boolean)
    : [];
  if (mode === "changed" && changedTargets.length === 0)
    throw new Error(
      'mode "changed" requires an explicit changed-target source (changedTargets)',
    );
  return {
    mode,
    baseUrl: input.baseUrl,
    outDir: input.outDir || ".qa",
    bounds: { ...DEFAULT_BOUNDS, ...(input.bounds || {}) },
    viewports:
      Array.isArray(input.viewports) && input.viewports.length
        ? input.viewports
        : DEFAULT_VIEWPORTS,
    // Only an explicit declaration unlocks mutating/destructive actions.
    isolatedEnvironment: input.isolatedEnvironment === true,
    allowMutating:
      input.isolatedEnvironment === true && input.allowMutating !== false,
    allowDestructive:
      input.isolatedEnvironment === true && input.allowDestructive === true,
    intent: input.intent || null,
    baselineDir: input.baselineDir || null,
    changedTargets,
    autofix: input.autofix === "verified" ? "verified" : false,
    // Where fixable document-level defects (title, lang) are applied.
    // Without a fixDir the fix stage only plans, never edits.
    fixDir: input.fixDir || null,
    slopChecks: input.slopChecks !== false,
    securityChecks: input.securityChecks !== false,
    // Parsed intents are supplied by the run pipeline (see intent.mjs);
    // explore only verifies them against computed styles, it never parses
    // raw instruction strings itself.
    intentChecks: Array.isArray(input.intentChecks) ? input.intentChecks : [],
    trace: input.trace !== false,
    stable_frames: Number.isInteger(input.stable_frames)
      ? input.stable_frames
      : 2,
    stable_gap_ms: Number.isInteger(input.stable_gap_ms)
      ? input.stable_gap_ms
      : 30,
    navigation_timeout_ms: Number.isInteger(input.navigation_timeout_ms)
      ? input.navigation_timeout_ms
      : 15_000,
  };
}
