// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

import type { ToolCallRecord } from './tools/types'

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** Sampling temperature from the active agent version. Undefined for
   *  legacy configs (provider default). OpenAI reasoning-style models
   *  ignore it. */
  temperature?: number
  /** Output cap from the agent version; falls back to MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number
  /** How many recent messages to feed the model (agent version). */
  contextMessageLimit?: number
  /** Hand the thread to a human when the provider fails or times out.
   *  Undefined → true (the safe default). */
  handoffOnFailure?: boolean
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** A tool the model asked to call (provider-neutral). */
export interface ToolCallRequest {
  id: string
  name: string
  args: Record<string, unknown>
}

/** Tool advertised to the model. `parameters` is a JSON schema object. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * One entry of a tool-calling transcript. Plain turns are `ChatMessage`s;
 * the two extra shapes carry the model's tool requests and our results.
 * Results are DATA from the CRM/knowledge base/webhooks, never prompt.
 */
export type ProviderMessage =
  | ChatMessage
  | { role: 'assistant'; content: string; toolCalls: ToolCallRequest[] }
  | {
      role: 'tool_results'
      results: { id: string; name: string; content: string }[]
    }

/** One model turn: text and/or tool requests. */
export interface ProviderTurn {
  text: string
  toolCalls: ToolCallRequest[]
  usage: AiUsage | null
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call (summed over tool rounds), or
   *  null when unavailable. */
  usage: AiUsage | null
  /** Tool calls made while producing this reply (empty without tools). */
  toolCalls: ToolCallRecord[]
  /** Reason given by the handoff_to_human tool, when it ended the turn. */
  handoffReason?: string
  /** Summary given by handoff_to_human (reason + summary), for the note. */
  handoffSummary?: string
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
