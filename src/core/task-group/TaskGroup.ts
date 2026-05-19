import { randomUUID } from "node:crypto"

import type { ClineMessage } from "@roo-code/types"

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

	constructor({ groupId, providerProfileIds, tasks }: TaskGroupOptions) {
		if (tasks.length === 0) throw new Error("TaskGroup requires at least one Task")
		if (tasks.length !== providerProfileIds.length) {
			throw new Error("TaskGroup: tasks.length must match providerProfileIds.length")
		}
		this.groupId = groupId ?? `group_${randomUUID()}`
		this.providerProfileIds = [...providerProfileIds]
		this.tasks = [...tasks]
	}

	/**
	 * The "primary" Task. Single-task code paths that rely on
	 * `ClineProvider.getCurrentTask()` returning *something* (commands like
	 * "Cancel current task", state initial postState, etc.) fall through to
	 * this. Defined as the first selected provider so the user's selection
	 * order is meaningful.
	 */
	get primary(): Task {
		return this.tasks[0]
	}

	/**
	 * Cancel every member Task. Used when the user hits the global Cancel
	 * button while the group is active. Per-card cancel buttons (PR 4) will
	 * call `task.abortTask()` on the individual Task instead.
	 */
	async abortAll(): Promise<void> {
		await Promise.all(this.tasks.map((t) => t.abortTask()))
	}

	/**
	 * Merge `clineMessages` from every member Task into a single, sorted
	 * timeline, stamping each row with the group's id and the producing
	 * provider's id so the webview can render one card per provider via
	 * `CompareCardStack` (PR 4). The underlying ClineMessage objects are not
	 * mutated — we return a shallow-copied, tagged view. Sort key is
	 * primarily `ts`, with a stable secondary sort by selection order so
	 * same-millisecond rows from different providers stay in a predictable
	 * visual order.
	 */
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
	 * True once every member Task has reached a terminal state for the
	 * current turn (completed, errored, aborted). PR 4 will use this to
	 * trigger `synthesizeCompareSummary()`.
	 */
	allTasksIdle(): boolean {
		return this.tasks.every((t) => t.isStreaming === false && t.isInitialized === true)
	}
}
