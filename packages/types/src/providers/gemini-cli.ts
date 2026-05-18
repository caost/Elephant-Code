import type { ModelInfo } from "../model.js"

// Models served via Google Code Assist API (cloudcode-pa.googleapis.com).
// Authenticated with the user's Gemini CLI OAuth credentials — no API key,
// no per-token billing (subject to free-tier / paid-tier quotas).
export type GeminiCliModelId = keyof typeof geminiCliModels

export const geminiCliDefaultModelId: GeminiCliModelId = "gemini-2.5-pro"

export const geminiCliModels = {
	"gemini-2.5-pro": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		description: "Gemini 2.5 Pro via Code Assist (Gemini CLI subscription, no API key).",
	},
	"gemini-2.5-flash": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		description: "Gemini 2.5 Flash via Code Assist (Gemini CLI subscription, no API key).",
	},
	"gemini-2.5-flash-lite": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		description: "Gemini 2.5 Flash Lite via Code Assist (most generous rate limits).",
	},
} as const satisfies Record<string, ModelInfo>
