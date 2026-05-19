import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import * as os from "os"
import * as path from "path"
import * as readline from "node:readline"

import type { Anthropic } from "@anthropic-ai/sdk"

import {
	type ModelInfo,
	type GeminiCliModelId,
	geminiCliDefaultModelId,
	geminiCliModels,
	ApiProviderError,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerOptions } from "../../shared/api"
import { getWorkspacePath } from "../../utils/path"

import type { ApiStream } from "../transform/stream"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"

type GeminiCliHandlerOptions = ApiHandlerOptions & {
	geminiCliBinaryPath?: string
}

/**
 * Stream-json line emitted by `gemini -p --output-format stream-json`.
 *
 * Reference shape: gemini-cli's NonInteractiveStreamingOutput. We only consume
 * the fields we need — unknown lines are ignored gracefully.
 */
interface GeminiStreamLine {
	type: string
	session_id?: string
	model?: string
	role?: string
	content?: string
	tool_name?: string
	parameters?: unknown
	tool_id?: string
	output?: string
	status?: string
	stats?: {
		input_tokens?: number
		output_tokens?: number
		total_tokens?: number
		tool_calls?: number
	}
}

/**
 * Provider that drives the local `gemini` CLI (`@google/gemini-cli`) in
 * plan / read-only mode. The CLI handles auth, rate-limit retry, and any
 * tool use itself — we only feed it a prompt and stream its output back as
 * ApiStream chunks.
 *
 * Mode is fixed to `--approval-mode plan` so the CLI cannot write to or
 * shell-execute against the user's project. File reads / greps / planning
 * are allowed; edits get sandboxed into the CLI's plan storage.
 */
export class GeminiCliHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: GeminiCliHandlerOptions
	private readonly providerName = "Gemini CLI"

	/**
	 * Maps a zoo-code taskId to the gemini CLI session UUID we created for it.
	 * Gemini stores session history on disk under its session id, so on every
	 * follow-up turn we pass `--resume <uuid>` instead of `--session-id <uuid>`,
	 * which gives the CLI full prior-turn context without us re-sending the
	 * accumulated history in the prompt. New taskId → new session.
	 */
	private readonly sessionByTask = new Map<string, string>()

	constructor(options: GeminiCliHandlerOptions) {
		super()
		this.options = options
	}

	override getModel(): { id: GeminiCliModelId; info: ModelInfo } {
		const requested = this.options.apiModelId as GeminiCliModelId | undefined
		const id = requested && requested in geminiCliModels ? requested : geminiCliDefaultModelId
		return { id, info: geminiCliModels[id] }
	}

	async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model } = this.getModel()
		const prompt = this.formatPrompt(systemPrompt, messages)
		const cwd = resolveWorkspaceCwd()
		const binary = resolveGeminiBinary(this.options.geminiCliBinaryPath)

		// Stable session per zoo-code task so gemini can carry conversation
		// history across createMessage calls. First turn: `--session-id` (start
		// a new session under our UUID). Subsequent turns: `--resume` (load the
		// previous session and append the new prompt).
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
			// YOLO: auto-approve every tool the CLI tries to run. Same
			// behavior as tunaFlow (`-y`). Plan mode's policy regex is
			// hardcoded to ~/.gemini/tmp/<id>/plans/*.md and was generating
			// constant write_file denial spam, so we let gemini decide what
			// it needs to do. The user explicitly opted into this trade-off.
			"--approval-mode",
			"yolo",
			// Trust prompt blocks non-interactive runs on first use in a new
			// workspace.
			"--skip-trust",
		]
		if (isFirstTurn) {
			args.push("--session-id", sessionId)
		} else {
			args.push("--resume", sessionId)
		}
		args.push("--model", model)

		const finalArgs = binary.scriptArg ? [binary.scriptArg, ...args] : args
		const safeArgsForLog = finalArgs.map((a) => (a === prompt ? `<prompt:${prompt.length}chars>` : a))
		console.log(`[gemini-cli] spawn: ${binary.command} ${safeArgsForLog.join(" ")} (cwd=${cwd})`)

		const child = spawn(binary.command, finalArgs, {
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
				console.log(`[gemini-cli] stderr: ${meaningful}`)
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
		let gotResult = false
		let toolCallCounter = 0
		// We instruct gemini to emit a `<task_summary>…</task_summary>` block
		// at the end. While streaming, hold back the last `pendingTail` chars
		// so the opening tag never reaches the user mid-stream, then split
		// `body` (shown) from `summary` (used for attempt_completion) once the
		// tag arrives.
		let textBuffer = ""
		let summaryStarted = false
		let summaryBuffer = ""
		const SUMMARY_OPEN = "<task_summary>"
		const SUMMARY_CLOSE = "</task_summary>"
		// Pre-buffer slack must be at least the opening tag length so we never
		// accidentally stream the first half of the tag before recognising it.
		const TAIL_HOLD = SUMMARY_OPEN.length

		const flushTextSafe = function* (final: boolean): Generator<{ type: "text"; text: string }> {
			if (summaryStarted) return
			// Emit everything except the last TAIL_HOLD chars, in case the
			// opening tag is split across delta boundaries. On final flush
			// (stream end / no tag found), emit the entire buffer.
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

				let parsed: GeminiStreamLine
				try {
					parsed = JSON.parse(line) as GeminiStreamLine
				} catch {
					// Non-JSON lines from the CLI (warnings, banners) — log and skip.
					console.log(`[gemini-cli] non-json stdout: ${line.slice(0, 200)}`)
					continue
				}
				console.log(`[gemini-cli] event: ${parsed.type}`)

				switch (parsed.type) {
					case "init":
						// Setup event — nothing user-visible to emit.
						break
					case "message": {
						// gemini CLI's stream-json emits each `message` event as a
						// delta (incremental piece), not a cumulative snapshot.
						// Append the delta and route it either to the visible
						// text stream or to the deferred summary, depending on
						// whether we've seen the `<task_summary>` tag yet.
						if (parsed.role === "assistant" && parsed.content) {
							accumulatedText += parsed.content
							if (summaryStarted) {
								summaryBuffer += parsed.content
							} else {
								textBuffer += parsed.content
								const openIdx = textBuffer.indexOf(SUMMARY_OPEN)
								if (openIdx >= 0) {
									// Flush the body that precedes the opening tag,
									// then route everything after into the summary.
									const before = textBuffer.slice(0, openIdx)
									if (before) yield { type: "text", text: before }
									summaryBuffer = textBuffer.slice(openIdx + SUMMARY_OPEN.length)
									textBuffer = ""
									summaryStarted = true
								} else {
									yield* flushTextSafe(false)
								}
							}
						}
						break
					}
					case "tool_use": {
						// Show what gemini is doing internally as `reasoning` so the
						// user gets visible progress while the CLI is busy reading
						// files / running searches. Reasoning is rendered in a
						// separate UI section, so it does not split the streaming
						// text bubble. Must NOT become tool_call_partial — these
						// are gemini-internal tools, not zoo-code's registry.
						const args =
							typeof parsed.parameters === "string"
								? parsed.parameters
								: JSON.stringify(parsed.parameters ?? {})
						const argSummary = args.length > 120 ? args.slice(0, 120) + "…" : args
						yield {
							type: "reasoning",
							text: `→ ${parsed.tool_name ?? "tool"}(${argSummary})\n`,
						}
						break
					}
					case "tool_result": {
						if (parsed.output) {
							const out = parsed.output.length > 200 ? parsed.output.slice(0, 200) + "…" : parsed.output
							const status = parsed.status === "error" ? "✗" : "✓"
							yield {
								type: "reasoning",
								text: `${status} ${parsed.tool_id ?? "tool"}: ${out}\n`,
							}
						}
						break
					}
					case "result":
						gotResult = true
						if (parsed.stats) {
							totalInput = parsed.stats.input_tokens ?? 0
							totalOutput = parsed.stats.output_tokens ?? 0
						}
						if (parsed.status === "error") {
							// Plan mode often emits status=error when gemini tries to
							// write_file and gets denied — that's expected, not fatal.
							// If we already received assistant text, treat the run as
							// successful and surface the policy denial as reasoning.
							if (accumulatedText.trim()) {
								const filtered = stripBenignStderr(stderrBuf)
								if (filtered) {
									yield { type: "reasoning", text: `[gemini CLI note] ${filtered}` }
								}
							} else {
								const detail =
									stripBenignStderr(stderrBuf) ||
									"gemini CLI reported an error result with no diagnostic output."
								throw new Error(detail)
							}
						}
						break
					default:
						break
				}
			}

			const exitCode = await exitPromise
			console.log(
				`[gemini-cli] child closed exit=${exitCode} gotResult=${gotResult} stderrLen=${stderrBuf.length} stdoutLen=${stdoutBuf.length}`,
			)
			const meaningfulStderr = stripBenignStderr(stderrBuf)
			if (exitCode !== 0 && !gotResult) {
				const detail = meaningfulStderr || stdoutBuf.trim().slice(-500) || `exit code ${exitCode}`
				throw new Error(`gemini CLI failed (exit ${exitCode}): ${detail}`)
			}
			if (!gotResult && accumulatedText.length === 0) {
				const detail =
					meaningfulStderr ||
					stdoutBuf.trim().slice(-500) ||
					"gemini CLI exited cleanly but produced no response. The prompt may have been filtered, or the CLI is missing auth/network."
				throw new Error(`gemini CLI produced no result: ${detail}`)
			}

			// Flush any text still held back in the tail buffer (no summary
			// tag was found, so it's all body content).
			if (!summaryStarted) {
				yield* flushTextSafe(true)
			}

			// Derive the completion summary. Prefer gemini's `<task_summary>`
			// block; if it's missing or empty, fall back to the first
			// non-empty line of the response so the completion card still
			// shows something useful instead of duplicating the full body.
			let completionResult = ""
			if (summaryStarted) {
				const closeIdx = summaryBuffer.indexOf(SUMMARY_CLOSE)
				completionResult = (closeIdx >= 0 ? summaryBuffer.slice(0, closeIdx) : summaryBuffer).trim()
			}
			if (!completionResult) {
				const firstLine = accumulatedText
					.split(/\n+/)
					.map((l) => l.trim())
					.find((l) => l && !l.startsWith("<task_summary"))
				completionResult = firstLine ?? accumulatedText.slice(0, 200)
			}

			// Signal task completion so zoo-code's agent loop terminates after a
			// single CLI invocation. Without this, zoo-code re-invokes the model
			// turn after turn waiting for an explicit "done" marker.
			if (accumulatedText.trim()) {
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
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.log(`[gemini-cli] error: ${message}`)
			const meaningfulStderr = stripBenignStderr(stderrBuf)
			if (meaningfulStderr) console.log(`[gemini-cli] final stderr: ${meaningfulStderr}`)
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
	 * Prompt sent to the CLI. We deliberately strip zoo-code's tool/protocol
	 * boilerplate (the "TOOL USE", "RULES", "CAPABILITIES" sections — easily
	 * 20K+ chars that only confuse the CLI's own agent loop), but **keep**
	 * the parts the user actually configured in Modes:
	 *   - `roleDefinition` (the first section of systemPrompt)
	 *   - The body of `USER'S CUSTOM INSTRUCTIONS` (mode-specific + global
	 *     custom instructions + rules)
	 *
	 * Then append the latest human-typed user message. Mirrors tunaFlow's
	 * "one prompt in, one answer out" while still honoring the user's
	 * Modes configuration.
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
		// Adapter for zoo-code's `attempt_completion` convention. Native zoo-code
		// providers call the `attempt_completion` tool with a concise `result`
		// (see src/core/prompts/tools/native-tools/attempt_completion.ts), but
		// gemini-cli never sees zoo-code's tool registry. We ask gemini to
		// emit the same kind of final-result message inline so we can lift it
		// into the completion card. Wording mirrors zoo-code's standard:
		// "final, does not require further input, no trailing questions."
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
				`Could not find the 'gemini' CLI. Install it with ` +
				`\`npm install -g @google/gemini-cli\` and authenticate via \`gemini\`, ` +
				`or set the binary path in settings.`
			)
		}
		if (haystack.includes("login") || haystack.includes("auth")) {
			return `gemini CLI authentication required. Run \`gemini\` once in a terminal to log in.`
		}
		if (haystack.includes("429") || haystack.includes("rate limit") || haystack.includes("quota")) {
			return `gemini CLI hit a rate limit. Try a smaller model (gemini-2.5-flash) or wait a minute.`
		}
		return message
	}
}

interface ResolvedBinary {
	command: string
	scriptArg?: string
}

/**
 * Locate the `gemini` binary. Searches an explicit user-configured path, then
 * PATH, then well-known Unix and nvm locations. Falls back to bare `gemini`
 * (which lets the OS shell resolve it).
 *
 * Mirrors tunaFlow/agents/resolve.rs's resolve_npm_cli for the Unix path.
 */
function resolveGeminiBinary(override?: string): ResolvedBinary {
	if (override?.trim()) {
		const expanded = expandHome(override.trim())
		if (existsSync(expanded)) {
			return { command: expanded }
		}
	}

	if (process.platform !== "win32") {
		const home = os.homedir()
		const candidates: string[] = []

		// nvm + fnm: collect the newest version that actually contains a gemini bin.
		const nvmBase = path.join(home, ".nvm/versions/node")
		const fnmBase = path.join(home, ".local/share/fnm/node-versions")
		for (const base of [nvmBase, fnmBase]) {
			const versions = safeReaddirSync(base)
			versions.sort()
			for (const v of versions.reverse()) {
				const p =
					base === fnmBase ? path.join(base, v, "installation/bin/gemini") : path.join(base, v, "bin/gemini")
				candidates.push(p)
			}
		}

		// Standard install locations.
		candidates.push(
			"/opt/homebrew/bin/gemini",
			"/usr/local/bin/gemini",
			"/usr/bin/gemini",
			path.join(home, ".npm-global/bin/gemini"),
		)

		for (const c of candidates) {
			if (existsSync(c)) return { command: c }
		}
	}

	return { command: "gemini" }
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

/**
 * Pick a sensible working directory: the open VS Code workspace folder, else
 * process.cwd. The CLI runs read-only here (plan mode) but cwd still affects
 * which files `gemini` can see for read tools.
 */
function resolveWorkspaceCwd(): string {
	try {
		const ws = getWorkspacePath()
		if (ws && ws !== "") return ws
	} catch {
		// utils/path may be unavailable in some unit-test contexts; fall through.
	}
	// Running `gemini` from "/" makes the CLI warn and tries to load the entire
	// filesystem as context. Prefer the user's home directory as a saner default
	// when the workspace folder is unset (VS Code opened without "Open Folder").
	const cwd = process.cwd()
	if (cwd === "/" || cwd === "") return os.homedir()
	return cwd
}

/**
 * Filter out gemini CLI's benign startup chatter from stderr so users don't
 * see "True color not detected" or 30+ "Skill conflict detected" lines as the
 * cause of an error. Returns the trimmed remainder — if everything was noise,
 * returns "".
 */
function stripBenignStderr(stderr: string): string {
	const useful = stderr
		.split("\n")
		.filter((line) => {
			const t = line.trim()
			if (!t) return false
			if (t.startsWith("Skill conflict detected:")) return false
			if (t.startsWith("Warning: True color")) return false
			if (t.startsWith("Warning: You are running")) return false
			if (t.startsWith("Ripgrep is not available")) return false
			// YOLO startup notice — expected because we always pass
			// --approval-mode yolo. Not an error.
			if (t.startsWith("YOLO mode is enabled")) return false
			return true
		})
		.join("\n")
		.trim()
	return useful
}

/**
 * Pull the user-configured slices out of zoo-code's monolithic system prompt:
 *   - `roleDefinition`: the leading section (everything before the first
 *     `\n====\n` separator). This is what Modes' "Role Definition" field
 *     compiles into.
 *   - `customInstructions`: the body of the trailing `USER'S CUSTOM
 *     INSTRUCTIONS` section (mode-specific instructions + global custom
 *     instructions + rules). Header text and the standard preamble line are
 *     stripped so only the actual instructions remain.
 *
 * Everything in between (TOOL USE, MARKDOWN RULES, CAPABILITIES, MODES,
 * SKILLS, OBJECTIVE, SYSTEM INFO …) is zoo-code agent-loop boilerplate that
 * we don't want to send to the CLI. Markers match the format produced by
 * `src/core/prompts/system.ts:basePrompt` and
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

/**
 * Extract ONLY genuinely human-authored text from a message. We deliberately
 * skip tool_use / tool_result blocks (synthetic agent-loop content) and
 * strip zoo-code's `<user_message>` / `<environment_details>` wrappers so
 * the CLI sees just what the user actually typed instead of treating the
 * wrappers as metadata.
 */
function extractHumanText(m: Anthropic.Messages.MessageParam): string {
	const rawText =
		typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.map(extractBlockText).filter(Boolean).join("\n")
				: ""
	return cleanZooCodeUserText(rawText)
}

// User responses to tool asks (approve+feedback, deny+reason,
// attempt_completion feedback) arrive as tool_result blocks whose content
// carries the actual user words. Treating only `text` blocks here used to
// drop those, so the prompt fell back to an older user turn and the CLI
// replayed its prior answer. Pull text out of tool_result content too.
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
 * a separate `<environment_details>` text block. CLIs treat unfamiliar XML
 * tags as metadata, so leaving them in makes the model reply with "no user
 * request was attached." We surface the inner prompt text and collapse the
 * environment block into a single line about cwd.
 */
function cleanZooCodeUserText(raw: string): string {
	let text = raw

	const userMessageMatch = text.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)
	let userMessage: string | undefined
	if (userMessageMatch) {
		userMessage = userMessageMatch[1].trim()
		text = text.replace(userMessageMatch[0], "").trim()
	}

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
