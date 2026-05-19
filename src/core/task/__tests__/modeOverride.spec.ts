import { describe, it, expect } from "vitest"

import type { ModeConfig } from "@roo-code/types"

import { Task } from "../Task"

/**
 * Verify Task.getEffectiveCustomModes — the single-knob helper TaskGroup
 * uses to inject a read-only shadow ModeConfig in front of the persisted
 * customModes array. Both SYSTEM_PROMPT and validateToolUse resolve a mode
 * via `getModeBySlug(slug, customModes)`; injecting an override with the
 * same slug at the head of the array gives both the read-only effective
 * mode for the lifetime of the Task without mutating disk state.
 */

function makeFakeTask(modeOverride?: ModeConfig): Task {
	// We do not call the real constructor — it would try to spin up files,
	// MCP, telemetry, etc. The helper only touches `this.modeOverride`, so
	// we can stub Task with the minimum needed.
	const t = Object.create(Task.prototype)
	;(t as any).modeOverride = modeOverride
	return t as Task
}

describe("Task.getEffectiveCustomModes", () => {
	it("returns the input unchanged when no modeOverride is set", () => {
		const customModes: ModeConfig[] = [
			{ slug: "myCustom", name: "My Custom", roleDefinition: "x", groups: ["read"] },
		]
		const task = makeFakeTask(undefined)
		expect(task.getEffectiveCustomModes(customModes)).toBe(customModes)
		expect(task.getEffectiveCustomModes(undefined)).toBeUndefined()
	})

	it("places the override at the head so getModeBySlug picks it up first", () => {
		const override: ModeConfig = {
			slug: "code",
			name: "Code",
			roleDefinition: "code role",
			groups: ["read"], // read-only shadow of built-in "code"
		}
		const customModes: ModeConfig[] = [
			{ slug: "otherCustom", name: "Other", roleDefinition: "y", groups: ["read", "edit"] },
		]
		const task = makeFakeTask(override)
		const result = task.getEffectiveCustomModes(customModes)!
		expect(result[0]).toBe(override)
		expect(result.map((m) => m.slug)).toEqual(["code", "otherCustom"])
	})

	it("strips a pre-existing custom mode with the same slug so the override wins cleanly", () => {
		const override: ModeConfig = {
			slug: "code",
			name: "Code",
			roleDefinition: "shadow",
			groups: ["read"],
		}
		const customModes: ModeConfig[] = [
			{ slug: "code", name: "User's Code Override", roleDefinition: "user", groups: ["read", "edit"] },
			{ slug: "ask", name: "Ask", roleDefinition: "ask", groups: ["read"] },
		]
		const task = makeFakeTask(override)
		const result = task.getEffectiveCustomModes(customModes)!
		expect(result).toHaveLength(2)
		expect(result[0]).toBe(override)
		expect(result.find((m) => m.slug === "code")?.groups).toEqual(["read"])
	})

	it("handles undefined customModes (legacy case)", () => {
		const override: ModeConfig = {
			slug: "code",
			name: "Code",
			roleDefinition: "shadow",
			groups: ["read"],
		}
		const task = makeFakeTask(override)
		const result = task.getEffectiveCustomModes(undefined)!
		expect(result).toEqual([override])
	})
})
