import type { ModelInfo } from "../model.js"

// Models served by the local `claude` CLI (Claude Code subscription).
// Authenticated by the CLI itself — no API key required.
// IDs use Anthropic's stable aliases so they auto-resolve to the latest
// underlying model version without us having to chase exact build numbers.
export type ClaudeCodeModelId = keyof typeof claudeCodeModels

export const claudeCodeDefaultModelId: ClaudeCodeModelId = "sonnet"

export const claudeCodeModels = {
	sonnet: {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		description: "Claude Sonnet (latest) via Claude Code CLI. Balanced reasoning, coding, and speed.",
	},
	opus: {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		description: "Claude Opus (latest) via Claude Code CLI. Highest-capability tier.",
	},
	haiku: {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		description: "Claude Haiku (latest) via Claude Code CLI. Fast and cheap for short tasks.",
	},
} as const satisfies Record<string, ModelInfo>
