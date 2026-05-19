// pnpm --filter @roo-code/types test src/__tests__/multi-provider-schema.spec.ts
//
// Round-trip Zod tests for the three optional fields added in PR 1 of the
// multi-provider compare feature. Each test parses, then re-parses the parsed
// output, to assert the field shape survives serialization and that absence
// of the field is still a valid (back-compat) document.

import { describe, it, expect } from "vitest"

import { modeConfigSchema } from "../mode.js"
import { clineMessageSchema } from "../message.js"
import { globalSettingsSchema } from "../global-settings.js"

describe("modeConfigSchema.enableMultipleProviders", () => {
	it("accepts a mode with enableMultipleProviders: true and round-trips", () => {
		const input = {
			slug: "compare",
			name: "Compare",
			roleDefinition: "You are a comparison helper.",
			groups: ["read"],
			enableMultipleProviders: true,
		}
		const parsed = modeConfigSchema.parse(input)
		expect(parsed.enableMultipleProviders).toBe(true)
		// Re-parse to confirm the output is itself a valid input.
		expect(modeConfigSchema.parse(parsed)).toEqual(parsed)
	})

	it("treats the field as optional (back-compat for existing modes)", () => {
		const input = {
			slug: "code",
			name: "Code",
			roleDefinition: "You write code.",
			groups: ["read", "edit"],
		}
		const parsed = modeConfigSchema.parse(input)
		expect(parsed.enableMultipleProviders).toBeUndefined()
	})

	it("rejects non-boolean values", () => {
		const input = {
			slug: "x",
			name: "x",
			roleDefinition: "x",
			groups: ["read"],
			enableMultipleProviders: "yes",
		}
		expect(() => modeConfigSchema.parse(input)).toThrow()
	})
})

describe("clineMessageSchema multi-provider tagging", () => {
	it("accepts providerProfileId + groupId and round-trips", () => {
		const input = {
			ts: 1_700_000_000_000,
			type: "say" as const,
			say: "text" as const,
			text: "hello",
			providerProfileId: "anthropic-default",
			groupId: "group-abc",
		}
		const parsed = clineMessageSchema.parse(input)
		expect(parsed.providerProfileId).toBe("anthropic-default")
		expect(parsed.groupId).toBe("group-abc")
		expect(clineMessageSchema.parse(parsed)).toEqual(parsed)
	})

	it("leaves both fields undefined for legacy single-provider messages", () => {
		const input = { ts: 1, type: "say" as const, say: "text" as const, text: "hi" }
		const parsed = clineMessageSchema.parse(input)
		expect(parsed.providerProfileId).toBeUndefined()
		expect(parsed.groupId).toBeUndefined()
	})
})

describe("globalSettingsSchema.selectedApiConfigIds", () => {
	it("accepts an array of provider ids and round-trips", () => {
		const input = { selectedApiConfigIds: ["id-1", "id-2", "id-3"] }
		const parsed = globalSettingsSchema.parse(input)
		expect(parsed.selectedApiConfigIds).toEqual(["id-1", "id-2", "id-3"])
		expect(globalSettingsSchema.parse(parsed)).toEqual(parsed)
	})

	it("treats the field as optional", () => {
		const parsed = globalSettingsSchema.parse({})
		expect(parsed.selectedApiConfigIds).toBeUndefined()
	})

	it("rejects non-string entries", () => {
		expect(() => globalSettingsSchema.parse({ selectedApiConfigIds: ["a", 42] })).toThrow()
	})
})
