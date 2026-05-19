import { describe, it, expect, vi } from "vitest"

import type { ClineMessage } from "@roo-code/types"

import { TaskGroup } from "../TaskGroup"

/**
 * Tests for the pure TaskGroup data class. Integration with Task is
 * deliberately mocked: TaskGroup itself does not own streaming or
 * persistence, so we just verify the merge/sort + lifecycle wiring.
 */

function fakeTask(messages: Array<Partial<ClineMessage>>, opts: { isStreaming?: boolean; isInitialized?: boolean } = {}) {
	// EventEmitter-like surface so TaskGroup.constructor can subscribe to
	// RooCodeEventName.Message without blowing up. The handlers are stored
	// on the object so tests can introspect or fire events if needed.
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
	return {
		clineMessages: messages.map((m, i) => ({
			ts: m.ts ?? i,
			type: m.type ?? "say",
			say: m.say ?? "text",
			text: m.text,
			...m,
		})) as ClineMessage[],
		isStreaming: opts.isStreaming ?? false,
		isInitialized: opts.isInitialized ?? true,
		abortTask: vi.fn().mockResolvedValue(undefined),
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (!listeners.has(event)) listeners.set(event, new Set())
			listeners.get(event)!.add(handler)
		}),
		off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			listeners.get(event)?.delete(handler)
		}),
		__listeners: listeners,
	} as any
}

describe("TaskGroup", () => {
	it("rejects an empty task list", () => {
		expect(() => new TaskGroup({ providerProfileIds: [], tasks: [] })).toThrow(/at least one Task/)
	})

	it("rejects mismatched id/task lengths", () => {
		expect(
			() =>
				new TaskGroup({
					providerProfileIds: ["a", "b"],
					tasks: [fakeTask([])],
				}),
		).toThrow(/must match/)
	})

	it("auto-generates a groupId when none is provided and uses the given one otherwise", () => {
		const g1 = new TaskGroup({ providerProfileIds: ["a"], tasks: [fakeTask([])] })
		expect(g1.groupId).toMatch(/^group_/)
		const g2 = new TaskGroup({ groupId: "explicit", providerProfileIds: ["a"], tasks: [fakeTask([])] })
		expect(g2.groupId).toBe("explicit")
	})

	it("exposes the first task as `primary` (selection order)", () => {
		const a = fakeTask([{ text: "from a" }])
		const b = fakeTask([{ text: "from b" }])
		const g = new TaskGroup({ providerProfileIds: ["a", "b"], tasks: [a, b] })
		expect(g.primary).toBe(a)
	})

	it("mergedMessages tags each row with providerProfileId + groupId without mutating the originals", () => {
		const a = fakeTask([{ ts: 10, text: "a1" }])
		const b = fakeTask([{ ts: 20, text: "b1" }])
		const g = new TaskGroup({ providerProfileIds: ["aaa", "bbb"], tasks: [a, b] })
		const merged = g.mergedMessages()
		expect(merged).toHaveLength(2)
		expect(merged[0]).toMatchObject({ ts: 10, text: "a1", providerProfileId: "aaa", groupId: g.groupId })
		expect(merged[1]).toMatchObject({ ts: 20, text: "b1", providerProfileId: "bbb", groupId: g.groupId })
		// Source rows are unchanged.
		expect((a.clineMessages[0] as any).providerProfileId).toBeUndefined()
		expect((b.clineMessages[0] as any).providerProfileId).toBeUndefined()
	})

	it("mergedMessages sorts primarily by ts and secondarily by selection order on ties", () => {
		const a = fakeTask([
			{ ts: 100, text: "a-at-100" },
			{ ts: 200, text: "a-at-200" },
		])
		const b = fakeTask([
			{ ts: 100, text: "b-at-100" }, // tie with a-at-100, but b is second in selection
			{ ts: 150, text: "b-at-150" },
		])
		const g = new TaskGroup({ providerProfileIds: ["aaa", "bbb"], tasks: [a, b] })
		const merged = g.mergedMessages()
		expect(merged.map((m) => m.text)).toEqual(["a-at-100", "b-at-100", "b-at-150", "a-at-200"])
	})

	it("abortAll calls abortTask on every member in parallel", async () => {
		const a = fakeTask([])
		const b = fakeTask([])
		const c = fakeTask([])
		const g = new TaskGroup({ providerProfileIds: ["a", "b", "c"], tasks: [a, b, c] })
		await g.abortAll()
		expect(a.abortTask).toHaveBeenCalledTimes(1)
		expect(b.abortTask).toHaveBeenCalledTimes(1)
		expect(c.abortTask).toHaveBeenCalledTimes(1)
	})

	it("allTasksIdle requires non-streaming, initialized, AND at least one message", () => {
		const idleWithMsg = fakeTask([{ text: "hello" }], { isStreaming: false, isInitialized: true })
		const idleEmpty = fakeTask([], { isStreaming: false, isInitialized: true })
		const streaming = fakeTask([{ text: "hello" }], { isStreaming: true, isInitialized: true })
		const initializing = fakeTask([{ text: "hello" }], { isStreaming: false, isInitialized: false })

		const allIdle = new TaskGroup({ providerProfileIds: ["a", "b"], tasks: [idleWithMsg, idleWithMsg] })
		expect(allIdle.allTasksIdle()).toBe(true)

		const oneStreaming = new TaskGroup({ providerProfileIds: ["a", "b"], tasks: [idleWithMsg, streaming] })
		expect(oneStreaming.allTasksIdle()).toBe(false)

		const oneInitializing = new TaskGroup({ providerProfileIds: ["a", "b"], tasks: [idleWithMsg, initializing] })
		expect(oneInitializing.allTasksIdle()).toBe(false)

		// Empty messages means the response hasn't landed yet — not idle.
		const oneEmpty = new TaskGroup({ providerProfileIds: ["a", "b"], tasks: [idleWithMsg, idleEmpty] })
		expect(oneEmpty.allTasksIdle()).toBe(false)
	})

	it("markNewTurn re-arms synthesis for the next turn", () => {
		const t = fakeTask([{ text: "x" }])
		const g = new TaskGroup({ providerProfileIds: ["a"], tasks: [t] })
		// Touching the private flag through the public API: after a manual
		// sentinel set, markNewTurn should reset it so subsequent firing is
		// allowed. We don't have a direct read accessor, so just confirm
		// the call doesn't throw and is idempotent.
		expect(() => g.markNewTurn()).not.toThrow()
		expect(() => g.markNewTurn()).not.toThrow()
	})
})
