import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import * as os from "os"
import * as path from "path"
import * as readline from "node:readline"

import type { Anthropic } from "@anthropic-ai/sdk"

import {
	type ModelInfo,
	type ClaudeCodeModelId,
	claudeCodeDefaultModelId,
	claudeCodeModels,
	ApiProviderError,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerOptions } from "../../shared/api"
import { getWorkspacePath } from "../../utils/path"

import type { ApiStream } from "../transform/stream"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"

type ClaudeCodeHandlerOptions = ApiHandlerOptions & {
	claudeCodeBinaryPath?: string
}

// ─── Stream-json shapes ──────────────────────────────────────────────────────
//
// Reference: tunaFlow `src-tauri/src/agents/claude.rs:25-148`. We only consume
// the fields we actually need; unknown lines are skipped gracefully.

interface ClaudeStreamUsage {
	input_tokens?: number
	output_tokens?: number
	cache_creation_input_tokens?: number
	cache_read_input_tokens?: number
}

interface ClaudeContentBlock {
	type: string
	text?: string
	thinking?: string
	// tool_use fields
	name?: string
	input?: unknown
}

interface ClaudeAssistantMessage {
	content?: ClaudeContentBlock[]
}

interface ClaudeStreamEvent {
	type: string
	index?: number
	delta?: {
		type: string
		text?: string
		thinking?: string
		partial_json?: string
	}
	content_block?: {
		type: string
		name?: string
		input?: unknown
	}
}

interface ClaudeStreamLine {
	type: string
	// assistant event
	message?: ClaudeAssistantMessage
	// stream_event (--include-partial-messages)
	event?: ClaudeStreamEvent
	// result event
	result?: string
	is_error?: boolean
	total_cost_usd?: number
	cost_usd?: number
	total_input_tokens?: number
	total_output_tokens?: number
	usage?: ClaudeStreamUsage
	session_id?: string
}

/**
 * Provider that drives the local `claude` CLI (Claude Code) as a subprocess —
 * same pattern as `GeminiCliHandler`. The CLI handles auth, rate limiting,
 * and tool execution; we only feed it a prompt and stream its output back as
 * ApiStream chunks.
 *
 * Permissions are bypassed (`--dangerously-skip-permissions`) so the CLI can
 * auto-approve tool calls in non-interactive mode — matches tunaFlow's
 * behavior. Review changes through Source Control before committing.
 */
export class ClaudeCodeHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ClaudeCodeHandlerOptions
	private readonly providerName = "Claude Code"

	/**
	 * Maps a zoo-code taskId to the claude CLI session UUID we created for it.
	 * Claude stores session history on disk under its session id, so on every
	 * follow-up turn we pass `--resume <uuid>` instead of `--session-id <uuid>`,
	 * giving the CLI full prior-turn context without us re-sending the
	 * accumulated history in the prompt. New taskId → new session.
	 */
	private readonly sessionByTask = new Map<string, string>()

	constructor(options: ClaudeCodeHandlerOptions) {
		super()
		this.options = options
	}

	override getModel(): { id: ClaudeCodeModelId; info: ModelInfo } {
		const requested = this.options.apiModelId as ClaudeCodeModelId | undefined
		const id = requested && requested in claudeCodeModels ? requested : claudeCodeDefaultModelId
		return { id, info: claudeCodeModels[id] }
	}

	async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model } = this.getModel()
		const prompt = this.formatPrompt(systemPrompt, messages)
		const cwd = resolveWorkspaceCwd()
		const binary = resolveClaudeBinary(this.options.claudeCodeBinaryPath)

		// Stable session per zoo-code task so claude carries conversation
		// history across createMessage calls. First turn: --session-id (start
		// a new session under our UUID). Subsequent turns: --resume.
		const taskId = metadata?.taskId ?? "default"
		const existingSession = this.sessionByTask.get(taskId)
		const sessionId = existingSession ?? randomUUID()
		const isFirstTurn = !existingSession
		if (isFirstTurn) {
			this.sessionByTask.set(taskId, sessionId)
		}

		const args: string[] = [
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose", // required by claude CLI for stream-json
			// Without this flag, --print mode buffers the entire response and
			// only emits one `assistant` event at the end. With it, claude
			// emits partial chunks as the model generates them, matching what
			// the user sees in interactive mode.
			"--include-partial-messages",
			// Auto-approve tool use in non-interactive mode (same trade-off
			// as gemini-cli's --approval-mode yolo).
			"--dangerously-skip-permissions",
			"--model",
			model,
		]
		if (isFirstTurn) {
			args.push("--session-id", sessionId)
		} else {
			args.push("--resume", sessionId)
		}

		const safeArgsForLog = args.map((a) => (a === prompt ? `<prompt:${prompt.length}chars>` : a))
		console.log(`[claude-code] spawn: ${binary} ${safeArgsForLog.join(" ")} (cwd=${cwd})`)

		const child = spawn(binary, args, {
			cwd,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		})

		let stderrBuf = ""
		let stdoutBuf = ""
		child.stderr.on("data", (d: Buffer) => {
			const chunk = d.toString()
			stderrBuf += chunk
			const meaningful = stripBenignStderr(chunk)
			if (meaningful) {
				console.log(`[claude-code] stderr: ${meaningful}`)
			}
		})

		const exitPromise = new Promise<number>((resolve, reject) => {
			child.on("error", reject)
			child.on("close", (code) => resolve(code ?? 0))
		})

		const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })

		let accumulatedText = ""
		let totalInput = 0
		let totalOutput = 0
		let cacheReadTokens = 0
		let gotResult = false
		let resultText = ""
		// When `--include-partial-messages` streams deltas via `stream_event`,
		// claude later emits a redundant aggregate `assistant` event containing
		// the full text. Flip this once we see any delta so we know to ignore
		// the aggregate and avoid double-emitting the response.
		let receivedDeltaStream = false
		// Tail-buffer the visible text so the `<task_summary>` opening tag never
		// reaches the user mid-stream, then split body vs summary once detected.
		let textBuffer = ""
		let summaryStarted = false
		let summaryBuffer = ""
		const SUMMARY_OPEN = "<task_summary>"
		const SUMMARY_CLOSE = "</task_summary>"
		const TAIL_HOLD = SUMMARY_OPEN.length

		const flushTextSafe = function* (final: boolean): Generator<{ type: "text"; text: string }> {
			if (summaryStarted) return
			if (final) {
				if (textBuffer) {
					yield { type: "text", text: textBuffer }
					textBuffer = ""
				}
				return
			}
			if (textBuffer.length > TAIL_HOLD) {
				const flush = textBuffer.slice(0, textBuffer.length - TAIL_HOLD)
				textBuffer = textBuffer.slice(textBuffer.length - TAIL_HOLD)
				if (flush) yield { type: "text", text: flush }
			}
		}

		try {
			for await (const raw of rl) {
				stdoutBuf += raw + "\n"
				const line = raw.trim()
				if (!line) continue

				let parsed: ClaudeStreamLine
				try {
					parsed = JSON.parse(line) as ClaudeStreamLine
				} catch {
					console.log(`[claude-code] non-json stdout: ${line.slice(0, 200)}`)
					continue
				}
				console.log(`[claude-code] event: ${parsed.type}`)

				// Local helper: route a chunk of assistant text into either the
				// visible text stream or the deferred summary, applying tail-buffer
				// holding and <task_summary> detection. Reused for both partial
				// stream_event deltas and the aggregate assistant event fallback.
				function* routeAssistantText(delta: string): Generator<{ type: "text"; text: string }> {
					accumulatedText += delta
					if (summaryStarted) {
						summaryBuffer += delta
						return
					}
					textBuffer += delta
					const openIdx = textBuffer.indexOf(SUMMARY_OPEN)
					if (openIdx >= 0) {
						const before = textBuffer.slice(0, openIdx)
						if (before) yield { type: "text", text: before }
						summaryBuffer = textBuffer.slice(openIdx + SUMMARY_OPEN.length)
						textBuffer = ""
						summaryStarted = true
					} else {
						yield* flushTextSafe(false)
					}
				}

				switch (parsed.type) {
					case "system":
						// Initialization message — nothing user-visible to emit.
						break
					case "stream_event": {
						// With `--include-partial-messages`, claude emits incremental
						// content via `stream_event { event: { type: "content_block_delta", delta: { text } } }`.
						// We surface these as ApiStream text chunks so the UI shows
						// token-by-token streaming. The redundant aggregate `assistant`
						// event that follows is suppressed via `receivedDeltaStream`.
						const ev = parsed.event
						if (!ev) break
						if (ev.type === "content_block_start") {
							const blk = ev.content_block
							if (blk?.type === "tool_use" && blk.name) {
								const argStr =
									typeof blk.input === "string" ? blk.input : JSON.stringify(blk.input ?? {})
								const argSummary = argStr.length > 120 ? argStr.slice(0, 120) + "…" : argStr
								yield { type: "reasoning", text: `→ ${blk.name}(${argSummary})\n` }
							}
						} else if (ev.type === "content_block_delta" && ev.delta) {
							if (ev.delta.type === "text_delta" && ev.delta.text) {
								receivedDeltaStream = true
								yield* routeAssistantText(ev.delta.text)
							} else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
								receivedDeltaStream = true
								yield { type: "reasoning", text: ev.delta.thinking }
							}
						}
						break
					}
					case "assistant": {
						// If we already streamed text via stream_event deltas, the
						// aggregate `assistant` event carries the same text again —
						// skip it to avoid doubling the response.
						if (receivedDeltaStream) break
						const blocks = parsed.message?.content ?? []
						for (const block of blocks) {
							if (block.type === "text" && block.text) {
								yield* routeAssistantText(block.text)
							} else if (block.type === "thinking" && block.thinking) {
								yield { type: "reasoning", text: block.thinking }
							} else if (block.type === "tool_use" && block.name) {
								const argStr =
									typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {})
								const argSummary = argStr.length > 120 ? argStr.slice(0, 120) + "…" : argStr
								yield { type: "reasoning", text: `→ ${block.name}(${argSummary})\n` }
							}
						}
						break
					}
					case "result": {
						gotResult = true
						resultText = parsed.result ?? ""
						totalInput = parsed.total_input_tokens ?? parsed.usage?.input_tokens ?? totalInput
						totalOutput = parsed.total_output_tokens ?? parsed.usage?.output_tokens ?? totalOutput
						cacheReadTokens = parsed.usage?.cache_read_input_tokens ?? cacheReadTokens
						if (parsed.is_error) {
							const detail =
								stripBenignStderr(stderrBuf) ||
								parsed.result ||
								"claude reported an error result with no diagnostic output."
							if (!accumulatedText.trim()) {
								throw new Error(detail)
							}
						}
						break
					}
					default:
						break
				}
			}

			const exitCode = await exitPromise
			console.log(
				`[claude-code] child closed exit=${exitCode} gotResult=${gotResult} stderrLen=${stderrBuf.length} stdoutLen=${stdoutBuf.length}`,
			)
			const meaningfulStderr = stripBenignStderr(stderrBuf)
			if (exitCode !== 0 && !gotResult) {
				const detail = meaningfulStderr || stdoutBuf.trim().slice(-500) || `exit code ${exitCode}`
				throw new Error(`claude CLI failed (exit ${exitCode}): ${detail}`)
			}
			if (!gotResult && accumulatedText.length === 0) {
				const detail =
					meaningfulStderr ||
					stdoutBuf.trim().slice(-500) ||
					"claude CLI exited cleanly but produced no response. The prompt may have been filtered, or the CLI is missing auth/network."
				throw new Error(`claude CLI produced no result: ${detail}`)
			}

			// Flush any text still held back in the tail buffer.
			if (!summaryStarted) {
				yield* flushTextSafe(true)
			}

			// Pick the completion summary: prefer gemini-style <task_summary>
			// block, then claude's own `result.result` text, then the first
			// non-empty line of the streamed body.
			let completionResult = ""
			if (summaryStarted) {
				const closeIdx = summaryBuffer.indexOf(SUMMARY_CLOSE)
				completionResult = (closeIdx >= 0 ? summaryBuffer.slice(0, closeIdx) : summaryBuffer).trim()
			}
			if (!completionResult && resultText.trim()) {
				completionResult = resultText.trim()
			}
			if (!completionResult) {
				const firstLine = accumulatedText
					.split(/\n+/)
					.map((l) => l.trim())
					.find((l) => l && !l.startsWith("<task_summary"))
				completionResult = firstLine ?? accumulatedText.slice(0, 200)
			}

			if (accumulatedText.trim() || resultText.trim()) {
				const callId = "attempt_completion-0"
				yield {
					type: "tool_call_partial",
					index: 0,
					id: callId,
					name: "attempt_completion",
					arguments: undefined,
				}
				yield {
					type: "tool_call_partial",
					index: 0,
					id: callId,
					name: undefined,
					arguments: JSON.stringify({ result: completionResult }),
				}
			}

			yield {
				type: "usage",
				inputTokens: totalInput,
				outputTokens: totalOutput,
				cacheReadTokens: cacheReadTokens || undefined,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.log(`[claude-code] error: ${message}`)
			const meaningfulStderr = stripBenignStderr(stderrBuf)
			if (meaningfulStderr) console.log(`[claude-code] final stderr: ${meaningfulStderr}`)
			const friendly = this.classifyError(message, stderrBuf)
			const apiError = new ApiProviderError(friendly, this.providerName, model, "createMessage")
			TelemetryService.instance.captureException(apiError)
			try {
				if (!child.killed) child.kill("SIGTERM")
			} catch {
				/* ignore */
			}
			throw new Error(friendly)
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		const chunks: string[] = []
		for await (const chunk of this.createMessage("", [{ role: "user", content: prompt }])) {
			if (chunk.type === "text") chunks.push(chunk.text)
		}
		return chunks.join("")
	}

	/**
	 * Compose the prompt sent to the CLI. Same approach as GeminiCliHandler:
	 * strip zoo-code's tool/protocol boilerplate (the CLI brings its own
	 * tools and agent loop) but keep what the user configured in Modes —
	 * roleDefinition and CUSTOM INSTRUCTIONS body. Append a <task_summary>
	 * instruction so we can lift a concise final result into the completion
	 * card.
	 */
	private formatPrompt(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): string {
		const userText = (() => {
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i]
				if (m.role !== "user") continue
				const text = extractHumanText(m)
				if (text) return text
			}
			return ""
		})()

		const { roleDefinition, customInstructions } = extractModeInstructions(systemPrompt)

		const parts: string[] = []
		if (roleDefinition) parts.push(roleDefinition)
		if (customInstructions) parts.push(`USER'S CUSTOM INSTRUCTIONS:\n${customInstructions}`)
		parts.push(
			"FINAL RESULT BLOCK:\n" +
				"After your main answer, on its own line, append a concise final " +
				"result message (1–2 sentences) describing what you accomplished. " +
				"Formulate it so it is final and does not require further input — " +
				"do not end with questions or offers for further assistance. " +
				"Wrap it EXACTLY in:\n" +
				"<task_summary>\n<your concise final result here>\n</task_summary>\n\n" +
				"Use this tag only once and do not omit it.",
		)
		if (userText) parts.push(`USER'S REQUEST:\n${userText}`)
		return parts.join("\n\n")
	}

	private classifyError(message: string, stderr: string): string {
		const haystack = `${message}\n${stderr}`.toLowerCase()
		if (haystack.includes("enoent") || haystack.includes("command not found")) {
			return (
				`Could not find the 'claude' CLI. Install it from ` +
				`https://claude.com/claude-code and run \`claude\` once to authenticate, ` +
				`or set the binary path in settings.`
			)
		}
		if (haystack.includes("login") || haystack.includes("not authenticated") || haystack.includes("401")) {
			return `Claude Code authentication required. Run \`claude\` once in a terminal to log in.`
		}
		if (haystack.includes("rate limit") || haystack.includes("429") || haystack.includes("quota")) {
			return `Claude Code hit a rate limit. Wait a few minutes, or check your subscription tier.`
		}
		if (haystack.includes("session not found") || haystack.includes("out of extra usage")) {
			return `Claude Code session was rejected (stale or expired). Try again to start a fresh session.`
		}
		return message
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Filter benign chatter from claude CLI stderr (login prompts hint, OS-specific
 * notices) so the user-visible error card stays focused on real failures.
 * Mirror of stripBenignStderr in gemini-cli.ts.
 */
function stripBenignStderr(stderr: string): string {
	const useful = stderr
		.split("\n")
		.filter((line) => {
			const t = line.trim()
			if (!t) return false
			if (t.startsWith("Warning: True color")) return false
			if (t.startsWith("Ripgrep is not available")) return false
			if (t.startsWith("(node:")) return false // node deprecation warnings
			return true
		})
		.join("\n")
		.trim()
	return useful
}

/**
 * Pull the user-configured slices out of zoo-code's monolithic system prompt.
 * Identical contract to the helper in gemini-cli.ts so the two providers
 * behave consistently. Markers match
 * `src/core/prompts/system.ts` and
 * `src/core/prompts/sections/custom-instructions.ts:507`.
 */
function extractModeInstructions(systemPrompt: string): {
	roleDefinition: string
	customInstructions: string
} {
	if (!systemPrompt || !systemPrompt.trim()) {
		return { roleDefinition: "", customInstructions: "" }
	}
	const sections = systemPrompt.split(/\n=+\n/)
	const roleDefinition = (sections[0] ?? "").trim()
	let customInstructions = ""
	for (const section of sections) {
		const trimmed = section.trim()
		if (trimmed.startsWith("USER'S CUSTOM INSTRUCTIONS")) {
			customInstructions = trimmed
				.replace(/^USER'S CUSTOM INSTRUCTIONS\s*\n+/, "")
				.replace(/^The following additional instructions are provided by the user.*?\n+/, "")
				.trim()
			break
		}
	}
	return { roleDefinition, customInstructions }
}

function extractHumanText(m: Anthropic.Messages.MessageParam): string {
	const rawText =
		typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.map(extractBlockText).filter(Boolean).join("\n")
				: ""
	return cleanZooCodeUserText(rawText)
}

// User responses to tool asks (approve+feedback, deny+reason, attempt_completion
// feedback) land in history as `tool_result` blocks whose `content` carries the
// actual user words. Treating only `text` blocks here used to drop those, so
// the prompt fell back to an older user turn and the CLI replayed its prior
// answer. Pull text out of tool_result content too.
function extractBlockText(b: Anthropic.Messages.ContentBlockParam): string {
	if (b.type === "text") return b.text
	if (b.type === "tool_result") {
		const c = b.content
		if (typeof c === "string") return c
		if (Array.isArray(c)) {
			return c
				.filter((inner): inner is Anthropic.TextBlockParam => inner.type === "text")
				.map((inner) => inner.text)
				.join("\n")
		}
	}
	return ""
}

/**
 * Strip zoo-code's wrapping XML so the underlying CLI sees just what the user
 * actually typed. zoo-code's startTask emits the prompt as
 * `<user_message>\n…\n</user_message>` (Task.ts:1977-1981) and later appends
 * a separate `<environment_details>` text block. Claude and Gemini both treat
 * unfamiliar XML tags as metadata, so leaving them in makes the model reply
 * with "no user request was attached." We surface the inner prompt text and
 * collapse the environment block into a single line about cwd.
 */
function cleanZooCodeUserText(raw: string): string {
	let text = raw

	// Pull whatever sits inside the first `<user_message>` block — that is the
	// literal text the user typed. Drop the surrounding tag so the model treats
	// it as conversation, not metadata.
	const userMessageMatch = text.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)
	let userMessage: string | undefined
	if (userMessageMatch) {
		userMessage = userMessageMatch[1].trim()
		text = text.replace(userMessageMatch[0], "").trim()
	}

	// Replace `<environment_details>` block with a compact summary so the model
	// has cwd/OS context without being drowned by file lists or visible-tab
	// dumps that zoo-code includes for agentic providers.
	const envMatch = text.match(/<environment_details>([\s\S]*?)<\/environment_details>/)
	let envSummary = ""
	if (envMatch) {
		const cwdLine = envMatch[1].match(/Current Working Directory[^\n]*/)?.[0] ?? ""
		envSummary = cwdLine.trim()
		text = text.replace(envMatch[0], "").trim()
	}

	const parts: string[] = []
	if (userMessage) parts.push(userMessage)
	if (text) parts.push(text)
	if (envSummary) parts.push(`(${envSummary})`)
	return parts.join("\n\n").trim()
}

/**
 * Locate the `claude` binary. Searches an explicit user-configured path, then
 * PATH, then well-known Unix and nvm/fnm locations. Falls back to bare
 * `claude` (lets the OS shell resolve it).
 */
function resolveClaudeBinary(override?: string): string {
	if (override?.trim()) {
		const expanded = expandHome(override.trim())
		if (existsSync(expanded)) return expanded
	}

	if (process.platform !== "win32") {
		const home = os.homedir()
		const candidates: string[] = []

		const nvmBase = path.join(home, ".nvm/versions/node")
		const fnmBase = path.join(home, ".local/share/fnm/node-versions")
		for (const base of [nvmBase, fnmBase]) {
			const versions = safeReaddirSync(base)
			versions.sort()
			for (const v of versions.reverse()) {
				const p =
					base === fnmBase ? path.join(base, v, "installation/bin/claude") : path.join(base, v, "bin/claude")
				candidates.push(p)
			}
		}

		candidates.push(
			path.join(home, ".local/bin/claude"),
			"/opt/homebrew/bin/claude",
			"/usr/local/bin/claude",
			"/usr/bin/claude",
			path.join(home, ".npm-global/bin/claude"),
		)

		for (const c of candidates) {
			if (existsSync(c)) return c
		}
	}

	return "claude"
}

function safeReaddirSync(dir: string): string[] {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
	return path.resolve(p)
}

function resolveWorkspaceCwd(): string {
	try {
		const ws = getWorkspacePath()
		if (ws && ws !== "") return ws
	} catch {
		// utils/path may be unavailable in some unit-test contexts; fall through.
	}
	const cwd = process.cwd()
	if (cwd === "/" || cwd === "") return os.homedir()
	return cwd
}
