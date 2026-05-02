/**
 * Per-block content sanitizer for orchestration wrapper leakage.
 *
 * Agent harnesses (OpenCode, Droid, ForgeCode, oh-my-opencode, etc.) inject
 * internal markup into message content — `<system-reminder>`, `<env>`,
 * `<task_metadata>`, and similar tags. When the proxy flattens messages into
 * a text prompt for the Agent SDK, these tags become model-visible text that
 * can confuse the model or cause it to echo them back ("talking to itself").
 *
 * This module strips known orchestration tags from **individual text blocks**
 * before flattening — not from the final concatenated string. Operating
 * per-block eliminates the cross-message regex risk that makes full-string
 * sanitization fragile.
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 *
 * Fixes: https://github.com/rynfar/meridian/issues/167
 */

// ---------------------------------------------------------------------------
// Exact tag names known to be orchestration-only.
// These are NOT prefix patterns — each entry is a specific tag name that
// harnesses inject and that never appears in legitimate user content.
// ---------------------------------------------------------------------------

// Tags stripped unconditionally (every adapter).
// `system-reminder` is NOT here — it is overloaded: Droid uses it to leak CWD
// (should strip), but OpenCode's oh-my-opencode harness uses it to surface
// background-task IDs and other orchestration state the model MUST see. So it
// is only stripped when the caller opts in via { stripSystemReminder: true }.
const ORCHESTRATION_TAGS = [
  // OpenCode / Crush: environment context blocks
  "env",
  // ForgeCode: system info wrapper and children
  "system_information",
  "current_working_directory",
  "operating_system",
  "default_shell",
  "home_directory",
  // OpenCode: task/tool/skill orchestration
  "task_metadata",
  "tool_exec",
  "tool_output",
  "skill_content",
  "skill_files",
  // OpenCode: context injection blocks
  "directories",
  "available_skills",
  // Leaked thinking tags (NOT the structured content block type —
  // these are raw XML tags that appear in text content on replay)
  "thinking",
]

// Build regex for paired tags: <tagname ...>...</tagname>
// Each tag gets its own regex to avoid cross-tag matching.
const PAIRED_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
)

// Self-closing variants: <tagname ... />
const SELF_CLOSING_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*\\/>`, "gi")
)

// Non-XML orchestration markers (unique, branded — zero false-positive risk)
const NON_XML_PATTERNS: RegExp[] = [
  // oh-my-opencode internal markers
  /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/gi,
  /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE[^\]]*\]/gi,
  // Background task markers
  /⚙\s*background_output\s*\[task_id=[^\]]*\]\n?/g,
  // Meridian's own file change summary leaking back into conversation
  /\n?---\nFiles changed:[^\n]*(?:\n(?:  [-•*] [^\n]*))*\n?/g,
]

const ALL_PATTERNS = [
  ...PAIRED_TAG_PATTERNS,
  ...SELF_CLOSING_TAG_PATTERNS,
  ...NON_XML_PATTERNS,
]

// Opt-in: only used when the adapter reports that it leaks CWD/env through
// `<system-reminder>` blocks (Droid). Other adapters must preserve these
// blocks — they carry model-visible harness state (see ORCHESTRATION_TAGS).
const SYSTEM_REMINDER_PATTERNS: RegExp[] = [
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<system-reminder\b[^>]*\/>/gi,
]

export interface SanitizeOptions {
  /** Strip `<system-reminder>` blocks. Enable for adapters (Droid) that leak
   *  CWD/env through this tag. */
  stripSystemReminder?: boolean
}

/**
 * Strip orchestration wrappers from a single text string.
 *
 * Designed to be called on individual content blocks (not concatenated
 * prompt strings) to eliminate cross-block regex matching risk.
 */
export function sanitizeTextContent(text: string, opts: SanitizeOptions = {}): string {
  let result = text
  const patterns = opts.stripSystemReminder
    ? [...ALL_PATTERNS, ...SYSTEM_REMINDER_PATTERNS]
    : ALL_PATTERNS
  for (const pattern of patterns) {
    // Reset lastIndex for stateful regexes (those with 'g' flag)
    pattern.lastIndex = 0
    result = result.replace(pattern, "")
  }
  // Collapse runs of 3+ newlines into 2 (avoids large gaps where tags were)
  result = result.replace(/\n{3,}/g, "\n\n")
  return result.trim()
}

// ---------------------------------------------------------------------------
// FORK PATCHES: Vendor-string scrub + nuclear system-prompt strip
// ArshyaAI/meridian fork-only. Kept env-gated so upstream behavior remains
// unchanged unless an operator explicitly enables the OpenClaw compatibility
// path in staging/production.
// ---------------------------------------------------------------------------

export type VendorScrubTarget = "openclaw"

const REPLACEMENT = "AgentSystem"
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

export function getVendorScrubFromEnv(): VendorScrubTarget | undefined {
  const raw = process.env.MERIDIAN_SCRUB_VENDOR
  if (raw === "openclaw") return raw
  return undefined
}

export function scrubVendorReferences(
  text: string,
  vendor: VendorScrubTarget = "openclaw"
): string {
  if (!text) return text
  if (vendor !== "openclaw") return text

  return text.replace(/openclaw/gi, (match) => {
    if (match === match.toUpperCase()) return REPLACEMENT.toUpperCase()
    if (match[0] === match[0]?.toUpperCase()) return REPLACEMENT
    return REPLACEMENT.toLowerCase()
  })
}

export function maybeScrubSystemContext(systemContext: string): string {
  const vendor = getVendorScrubFromEnv()
  if (!vendor) return systemContext
  const scrubbed = scrubVendorReferences(systemContext, vendor)
  if (scrubbed !== systemContext) {
    const delta = systemContext.length - scrubbed.length
    console.error(
      `[sanitize] scrubbed systemContext vendor="${vendor}" input_len=${systemContext.length} delta=${delta}`
    )
  }
  return scrubbed
}

export function scrubVendorReferencesDeep<T>(
  value: T,
  vendor: VendorScrubTarget = "openclaw"
): T {
  if (typeof value === "string") {
    return scrubVendorReferences(value, vendor) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubVendorReferencesDeep(v, vendor)) as unknown as T
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubVendorReferencesDeep(v, vendor)
    }
    return out as unknown as T
  }
  return value
}

export function scrubMessagesSelective(
  messages: unknown[],
  vendor: VendorScrubTarget = "openclaw"
): unknown[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg
    const m = msg as Record<string, unknown>
    const content = m["content"]

    if (typeof content === "string") {
      return { ...m, content: scrubVendorReferences(content, vendor) }
    }

    if (Array.isArray(content)) {
      const scrubbed = content.map((block) => {
        if (!block || typeof block !== "object") {
          return typeof block === "string"
            ? scrubVendorReferences(block, vendor)
            : block
        }
        const b = block as Record<string, unknown>
        const blockType = b["type"]

        if (
          blockType === "tool_use" ||
          blockType === "tool_result" ||
          blockType === "redacted_thinking"
        ) {
          return block
        }

        if (blockType === "text" && typeof b["text"] === "string") {
          return {
            ...b,
            text: scrubVendorReferences(b["text"] as string, vendor),
          }
        }

        if (blockType === "thinking" && typeof b["thinking"] === "string") {
          return {
            ...b,
            thinking: scrubVendorReferences(b["thinking"] as string, vendor),
          }
        }

        return scrubVendorReferencesDeep(block, vendor)
      })
      return { ...m, content: scrubbed }
    }

    return msg
  })
}

export function maybeScrubRequestBody<T extends Record<string, unknown>>(
  body: T
): T {
  const vendor = getVendorScrubFromEnv()
  if (!vendor) return body

  const sys = body["system"]
  const msgs = body["messages"]
  const tools = body["tools"]
  const before =
    (typeof sys === "string" ? sys.length : JSON.stringify(sys ?? "").length) +
    JSON.stringify(msgs ?? "").length +
    JSON.stringify(tools ?? "").length

  const scrubbed = { ...body } as Record<string, unknown>
  if (sys !== undefined) {
    scrubbed["system"] = scrubVendorReferencesDeep(sys, vendor)
  }
  if (tools !== undefined) {
    scrubbed["tools"] = scrubVendorReferencesDeep(tools, vendor)
  }
  if (Array.isArray(msgs)) {
    scrubbed["messages"] = scrubMessagesSelective(msgs, vendor)
  }

  const s = scrubbed["system"]
  const m = scrubbed["messages"]
  const t = scrubbed["tools"]
  const after =
    (typeof s === "string" ? s.length : JSON.stringify(s ?? "").length) +
    JSON.stringify(m ?? "").length +
    JSON.stringify(t ?? "").length
  if (after !== before) {
    const delta = before - after
    console.error(
      `[sanitize] scrubbed request body vendor="${vendor}" before=${before} delta=${delta}`
    )
  }
  return scrubbed as T
}

export function unscrubVendorReferences(
  text: string,
  vendor: VendorScrubTarget = "openclaw"
): string {
  if (!text) return text
  if (vendor !== "openclaw") return text

  return text.replace(/agentsystem/gi, (match) => {
    if (match === match.toUpperCase()) return "OPENCLAW"
    if (match[0] === match[0]?.toUpperCase()) return "OpenClaw"
    return "openclaw"
  })
}

export function getBidirectionalScrubFromEnv(): boolean {
  if (!getVendorScrubFromEnv()) return false
  const raw = process.env.MERIDIAN_SCRUB_BIDIRECTIONAL
  return raw === "1" || raw === "true"
}

export function maybeUnscrubMessageBody<T extends Record<string, unknown>>(
  body: T
): T {
  if (!getBidirectionalScrubFromEnv()) return body
  let rewrites = 0

  const content = body["content"]
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>
        if (typeof b["text"] === "string") {
          const before = b["text"] as string
          const after = unscrubVendorReferences(before)
          if (after !== before) {
            b["text"] = after
            rewrites += before.length - after.length
          }
        }
        if (b["input"] && typeof b["input"] === "object") {
          const input = b["input"] as Record<string, unknown>
          for (const k of Object.keys(input)) {
            const v = input[k]
            if (typeof v === "string") {
              const after = unscrubVendorReferences(v)
              if (after !== v) {
                input[k] = after
                rewrites += v.length - after.length
              }
            }
          }
        }
      }
    }
  }

  if (rewrites !== 0) {
    console.error(`[sanitize] unscrubbed response body delta=${rewrites}`)
  }
  return body
}

export function maybeUnscrubStreamEvent<T>(event: T): T {
  if (!getBidirectionalScrubFromEnv()) return event
  if (!event || typeof event !== "object") return event

  const e = event as unknown as Record<string, unknown>

  if (e["type"] === "content_block_delta") {
    const delta = e["delta"]
    if (delta && typeof delta === "object") {
      const d = delta as Record<string, unknown>
      if (typeof d["text"] === "string") {
        d["text"] = unscrubVendorReferences(d["text"] as string)
      }
      if (typeof d["partial_json"] === "string") {
        d["partial_json"] = unscrubVendorReferences(d["partial_json"] as string)
      }
    }
  }

  if (e["type"] === "content_block_start") {
    const cb = e["content_block"]
    if (cb && typeof cb === "object") {
      const c = cb as Record<string, unknown>
      if (typeof c["text"] === "string") {
        c["text"] = unscrubVendorReferences(c["text"] as string)
      }
    }
  }

  if (e["type"] === "message_start") {
    const msg = e["message"]
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>
      const content = m["content"]
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>
            if (typeof b["text"] === "string") {
              b["text"] = unscrubVendorReferences(b["text"] as string)
            }
          }
        }
      }
    }
  }

  return event
}

export function getStripAgentPromptFromEnv(): boolean {
  if (!getVendorScrubFromEnv()) return false
  const raw = process.env.MERIDIAN_STRIP_AGENT_PROMPT
  return raw === "1" || raw === "true"
}

export function maybeStripAgentRequestBody<T extends Record<string, unknown>>(
  body: T
): T {
  if (!getStripAgentPromptFromEnv()) return body

  const b = body as Record<string, unknown>
  const system = b["system"]

  if (typeof system === "string" && system.length > 0) {
    b["system"] = CLAUDE_CODE_IDENTITY
    console.error(
      `[sanitize] stripped body.system (string) len=${system.length} -> ${CLAUDE_CODE_IDENTITY.length}`
    )
  } else if (Array.isArray(system) && system.length > 0) {
    const origLen = JSON.stringify(system).length
    b["system"] = [{ type: "text", text: CLAUDE_CODE_IDENTITY }]
    console.error(
      `[sanitize] stripped body.system (array) blocks=${system.length} len=${origLen} -> ~${CLAUDE_CODE_IDENTITY.length + 20}`
    )
  }

  if ("tool_choice" in b) {
    delete b["tool_choice"]
    console.error(`[sanitize] stripped body.tool_choice`)
  }

  return body
}

export function maybeStripAgentSystemContext(systemContext: string): string {
  if (!getStripAgentPromptFromEnv()) return systemContext
  if (!systemContext) return systemContext
  console.error(
    `[sanitize] stripped systemContext len=${systemContext.length} -> ${CLAUDE_CODE_IDENTITY.length}`
  )
  return CLAUDE_CODE_IDENTITY
}
