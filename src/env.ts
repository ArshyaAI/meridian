/**
 * Environment variable resolution with backward-compatible aliases.
 *
 * New MERIDIAN_* names take precedence over legacy CLAUDE_PROXY_* names.
 * Both are supported indefinitely to avoid breaking existing deployments.
 */

/**
 * Resolve an env var with MERIDIAN_ prefix, falling back to CLAUDE_PROXY_ prefix.
 * Returns undefined if neither is set.
 */
export function env(suffix: string): string | undefined {
  return process.env[`MERIDIAN_${suffix}`] ?? process.env[`CLAUDE_PROXY_${suffix}`]
}

/**
 * Resolve an env var with a default value.
 */
export function envOr(suffix: string, defaultValue: string): string {
  return env(suffix) ?? defaultValue
}

/**
 * Resolve a boolean env var (truthy = "1", "true", "yes").
 */
export function envBool(suffix: string): boolean {
  const val = env(suffix)
  return val === "1" || val === "true" || val === "yes"
}

/**
 * Resolve an integer env var with a default.
 */
export function envInt(suffix: string, defaultValue: number): number {
  const val = env(suffix)
  if (!val) return defaultValue
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}
