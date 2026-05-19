import { randomUUID } from "node:crypto"

import { type ClineMessage, RooCodeEventName } from "@roo-code/types"

import type { Task } from "../task/Task"

/**
 * Lightweight coordinator over N parallel `Task` instances that share the
 * same user prompt but each talk to their own provider. Used when the active
 * mode has `enableMultipleProviders: true` and the chat picker contains > 1
 * provider profile id. Each member Task keeps its own `apiConversationHistory`,
 * `clineMessages`, and `api` — they never see each other's outputs. The
 * group is mutually exclusive with the legacy `clineStack`: at most one of
 * them is "live" on a `ClineProvider` at a time. See
 * ~/.claude/plans/modes-providers-mutiple-smooth-pretzel.md for the wider
 * design.
 *
 * After every member Task reaches an idle (non-streaming) state for the
 * current turn, the group fires `synthesizeCompareSummary()` exactly once,
 * which uses the default (first selected) provider's `completePrompt` to
 * produce a unified "공통점/차이점/추천" card rendered at the bottom of the
 * stack. The summary is emitted as a `compare_summary` ClineMessage on the
 * primary Task so it flows through the standard webview push path.
 */
export interface TaskGroupOptions {
	groupId?: string
	providerProfileIds: string[]
	tasks: Task[]
}

export class TaskGroup {
	readonly groupId: string
	readonly providerProfileIds: readonly string[]
	readonly tasks: readonly Task[]

	private synthesisInProgress = false
	private synthesisFiredThisTurn = false
	private aborted = false
	private readonly listenerUnsubs: Array<() => void> = []

	constructor({ groupId, providerProfileIds, tasks }: TaskGroupOptions) {
		if (tasks.length === 0) throw new Error("TaskGroup requires at least one Task")
		if (tasks.length !== providerProfileIds.length) {
			throw new Error("TaskGroup: tasks.length must match providerProfileIds.length")
		}
		this.groupId = groupId ?? `group_${randomUUID()}`
		this.providerProfileIds = [...providerProfileIds]
		this.tasks = [...tasks]

		// Wire the synthesis trigger to every member's message events. After
		// each event we check whether the whole group has settled and, if so,
		// fan out exactly one synthesis call.
		for (const task of this.tasks) {
			const onMessage = () => this.maybeFireSynthesis()
			task.on(RooCodeEventName.Message, onMessage)
			this.listenerUnsubs.push(() => task.off(RooCodeEventName.Message, onMessage))
		}
	}

	get primary(): Task {
		return this.tasks[0]
	}

	async abortAll(): Promise<void> {
		this.aborted = true
		this.detachListeners()
		await Promise.all(this.tasks.map((t) => t.abortTask()))
	}

	/**
	 * Reset synthesis state. Called by the host before fanning out a follow-
	 * up user message so the post-hook re-arms for the new turn.
	 */
	markNewTurn(): void {
		this.synthesisFiredThisTurn = false
	}

	mergedMessages(): ClineMessage[] {
		const tagged: Array<ClineMessage & { providerProfileId: string; groupId: string }> = []
		for (let i = 0; i < this.tasks.length; i++) {
			const task = this.tasks[i]
			const providerProfileId = this.providerProfileIds[i]
			for (const msg of task.clineMessages) {
				tagged.push({ ...msg, providerProfileId, groupId: this.groupId })
			}
		}
		const orderIndex = (id: string) => this.providerProfileIds.indexOf(id)
		tagged.sort((a, b) => {
			if (a.ts !== b.ts) return a.ts - b.ts
			return orderIndex(a.providerProfileId) - orderIndex(b.providerProfileId)
		})
		return tagged
	}

	/**
	 * True once every member Task has reached an idle (not streaming, fully
	 * initialized) state for the current turn AND has at least one message
	 * in its own clineMessages buffer (so we don't fire synthesis before the
	 * first response chunk has even landed).
	 */
	allTasksIdle(): boolean {
		return this.tasks.every(
			(t) => t.isStreaming === false && t.isInitialized === true && t.clineMessages.length > 0,
		)
	}

	private detachListeners(): void {
		for (const off of this.listenerUnsubs) {
			try {
				off()
			} catch {
				// best-effort
			}
		}
		this.listenerUnsubs.length = 0
	}

	private maybeFireSynthesis(): void {
		if (this.aborted || this.synthesisInProgress || this.synthesisFiredThisTurn) return
		if (!this.allTasksIdle()) return
		// Avoid firing during a partial-stream gap: require every member's
		// most recent message to be non-partial.
		const anyPartial = this.tasks.some((t) => t.clineMessages.at(-1)?.partial === true)
		if (anyPartial) return

		this.synthesisInProgress = true
		void this.synthesizeCompareSummary()
			.catch((err) => {
				console.warn(`[TaskGroup ${this.groupId}] synthesis failed`, err)
			})
			.finally(() => {
				this.synthesisInProgress = false
				this.synthesisFiredThisTurn = true
			})
	}

	/**
	 * Lift each member Task's most recent `<task_summary>...</task_summary>`
	 * body (or, if absent, its trailing assistant text) and feed them to the
	 * default provider's `completePrompt`. The result is emitted as a single
	 * `compare_summary` ClineMessage on the primary Task — which already
	 * carries `groupId` + `providerProfileId`, so the webview's
	 * CompareCardStack renders it as the final card.
	 */
	private async synthesizeCompareSummary(): Promise<void> {
		const userRequest = this.extractUserRequest()
		const perProvider = this.tasks.map((task, i) => ({
			pid: this.providerProfileIds[i],
			text: this.extractLatestAssistantSummary(task),
		}))

		// If too few providers actually produced a usable response, skip.
		const usable = perProvider.filter((p) => p.text.trim().length > 0)
		if (usable.length < 2) return

		const synthesisPrompt = this.buildSynthesisPrompt(userRequest, usable)

		// Not every ApiHandler implements `completePrompt` (it lives on the
		// `SingleCompletionHandler` interface). When the primary provider
		// doesn't support it (e.g., some edge providers), skip silently —
		// the per-card task_summaries still convey the comparison.
		const handler = this.primary.api as unknown as {
			completePrompt?: (prompt: string) => Promise<string>
		}
		if (typeof handler.completePrompt !== "function") return
		try {
			const out = await handler.completePrompt(synthesisPrompt)
			if (!out || !out.trim()) return
			// Bypass partials — emit the full summary as a single non-partial row.
			await this.primary.say("compare_summary", out.trim())
		} catch (err) {
			console.warn(`[TaskGroup ${this.groupId}] completePrompt failed`, err)
		}
	}

	private extractUserRequest(): string {
		// Each member Task received the same user prompt; pull from primary.
		const firstSay = this.primary.clineMessages.find(
			(m) => m.type === "say" && m.say === "text" && !m.partial && m.text,
		)
		return firstSay?.text ?? ""
	}

	private extractLatestAssistantSummary(task: Task): string {
		// Prefer the body of the latest `<task_summary>...</task_summary>` we
		// asked the model to wrap its final result in (see CLI providers).
		// Fall back to the last non-partial assistant `say:text` row.
		for (let i = task.clineMessages.length - 1; i >= 0; i--) {
			const m = task.clineMessages[i]
			if (!m.text || m.partial) continue
			const match = m.text.match(/<task_summary>\s*([\s\S]*?)\s*<\/task_summary>/)
			if (match) return match[1].trim()
		}
		// Fallback: latest non-partial text-typed assistant row.
		for (let i = task.clineMessages.length - 1; i >= 0; i--) {
			const m = task.clineMessages[i]
			if (m.partial || !m.text) continue
			if (m.type === "say" && (m.say === "text" || m.say === "completion_result")) return m.text.trim()
		}
		return ""
	}

	private buildSynthesisPrompt(userRequest: string, perProvider: Array<{ pid: string; text: string }>): string {
		const numbered = perProvider
			.map((p, i) => `- (${i + 1}) ${p.pid}:\n${p.text}`)
			.join("\n\n")
		return [
			"You are summarizing multiple AI responses to the same user request for a side-by-side comparison card.",
			"",
			"User's request:",
			userRequest || "(not captured)",
			"",
			`Responses from ${perProvider.length} providers:`,
			numbered,
			"",
			"Write a compact compare summary in the user's request language. Use exactly three labelled sections, each with 2–4 short bullets:",
			"- 공통점 / Shared:",
			"- 차이점 / Differences:",
			"- 추천 / Recommendation:",
			"Do NOT restate the full responses. Do NOT use code blocks. Keep it under ~200 words total.",
		].join("\n")
	}
}
