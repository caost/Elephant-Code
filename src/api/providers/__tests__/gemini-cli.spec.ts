// npx vitest run api/providers/__tests__/gemini-cli.spec.ts

import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: undefined },
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vi.fn(),
		},
	},
}))

const spawnMock = vi.fn()
vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}))

import { GeminiCliHandler } from "../gemini-cli"
import type { ApiHandlerOptions } from "../../../shared/api"

/**
 * Build a fake child process whose stdout streams the provided stream-json
 * lines, then closes with the given exit code.
 */
function fakeChild(stdoutLines: string[], exitCode = 0, stderrText = "") {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough
		stderr: PassThrough
		killed: boolean
		kill: (sig?: string) => boolean
	}
	child.stdout = new PassThrough()
	child.stderr = new PassThrough()
	child.killed = false
	child.kill = () => {
		child.killed = true
		return true
	}

	queueMicrotask(() => {
		for (const line of stdoutLines) {
			child.stdout.write(`${line}\n`)
		}
		if (stderrText) child.stderr.write(stderrText)
		child.stdout.end()
		child.stderr.end()
		setImmediate(() => child.emit("close", exitCode))
	})

	return child
}

describe("GeminiCliHandler (subprocess)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("getModel", () => {
		it("uses configured model id", () => {
			const h = new GeminiCliHandler({ apiModelId: "gemini-2.5-flash" } as ApiHandlerOptions)
			expect(h.getModel().id).toBe("gemini-2.5-flash")
		})

		it("falls back to default for unknown id", () => {
			const h = new GeminiCliHandler({ apiModelId: "bogus" } as unknown as ApiHandlerOptions)
			expect(h.getModel().id).toBe("gemini-2.5-pro")
		})
	})

	describe("createMessage", () => {
		it("spawns gemini with plan approval and stream-json output", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({ type: "init", model: "gemini-2.5-pro" }),
					JSON.stringify({ type: "message", role: "assistant", content: "Hi" }),
					JSON.stringify({ type: "result", status: "ok", stats: { input_tokens: 4, output_tokens: 1 } }),
				]),
			)

			const handler = new GeminiCliHandler({ apiModelId: "gemini-2.5-pro" } as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) {
				chunks.push(c)
			}

			expect(spawnMock).toHaveBeenCalledTimes(1)
			const [, args] = spawnMock.mock.calls[0]
			expect(args).toContain("--approval-mode")
			expect(args).toContain("yolo")
			expect(args).toContain("--output-format")
			expect(args).toContain("stream-json")
			expect(args).toContain("--model")
			expect(args).toContain("gemini-2.5-pro")

			expect(
				chunks
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join(""),
			).toBe("Hi")
			const usage = chunks.find((c) => c.type === "usage")
			expect(usage).toMatchObject({ inputTokens: 4, outputTokens: 1 })
		})

		it("appends each assistant message event as a delta (tunaFlow-compatible)", async () => {
			// Use longer chunks so the tail-buffer (held back to detect the
			// `<task_summary>` tag) doesn't coalesce them into a single emit.
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({ type: "message", role: "assistant", content: "Hello there friend " }),
					JSON.stringify({ type: "message", role: "assistant", content: "this is a longer answer " }),
					JSON.stringify({ type: "message", role: "assistant", content: "with multiple deltas." }),
					JSON.stringify({ type: "result", status: "ok", stats: {} }),
				]),
			)

			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const text: string[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				if (c.type === "text") text.push(c.text)
			}
			expect(text.join("")).toBe("Hello there friend this is a longer answer with multiple deltas.")
			// At least 2 separate yields (incremental streaming, not one big chunk).
			expect(text.length).toBeGreaterThanOrEqual(2)
		})

		it("surfaces gemini's internal tools as reasoning while keeping the text bubble intact", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({ type: "message", role: "assistant", content: "Looking at the file. " }),
					JSON.stringify({
						type: "tool_use",
						tool_name: "read_file",
						parameters: { path: "src/a.ts" },
					}),
					JSON.stringify({ type: "tool_result", tool_id: "read_file", output: "file contents" }),
					JSON.stringify({ type: "message", role: "assistant", content: "Done reading." }),
					JSON.stringify({ type: "result", status: "ok", stats: {} }),
				]),
			)

			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				chunks.push(c)
			}
			// Tool events are visible to the user as reasoning (so the UI shows
			// progress while gemini is busy executing them).
			const reasoning = chunks.filter((c) => c.type === "reasoning")
			expect(reasoning.length).toBeGreaterThanOrEqual(2)
			expect(reasoning.some((c) => c.text.includes("read_file"))).toBe(true)
			expect(reasoning.some((c) => c.text.includes("file contents"))).toBe(true)
			// Tool events do NOT become tool_call_partial — those are reserved
			// for our terminating attempt_completion.
			const partials = chunks.filter((c) => c.type === "tool_call_partial")
			expect(partials.every((c) => c.id === "attempt_completion-0")).toBe(true)
			// Text deltas still accumulate into the same logical answer.
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			expect(text).toBe("Looking at the file. Done reading.")
		})

		it("uses <task_summary> for attempt_completion result and strips it from visible text", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({
						type: "message",
						role: "assistant",
						content: "Here is the detailed answer the user asked for with lots of explanation. ",
					}),
					JSON.stringify({
						type: "message",
						role: "assistant",
						content: "\n\n<task_summary>\nResponded with a detailed explanation.\n</task_summary>",
					}),
					JSON.stringify({ type: "result", status: "ok", stats: {} }),
				]),
			)
			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				chunks.push(c)
			}
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			// The visible text must not contain the summary tag or its body.
			expect(text).not.toContain("<task_summary")
			expect(text).not.toContain("Responded with")
			expect(text).toContain("Here is the detailed answer")
			// attempt_completion result is the summary body, not the full text.
			const partials = chunks.filter((c) => c.type === "tool_call_partial" && c.arguments)
			expect(partials).toHaveLength(1)
			const args = JSON.parse(partials[0].arguments)
			expect(args.result).toBe("Responded with a detailed explanation.")
		})

		it("falls back to first non-empty line for attempt_completion when summary tag missing", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({
						type: "message",
						role: "assistant",
						content: "First line of the answer.\nSome other content here.",
					}),
					JSON.stringify({ type: "result", status: "ok", stats: {} }),
				]),
			)
			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				chunks.push(c)
			}
			const partials = chunks.filter((c) => c.type === "tool_call_partial" && c.arguments)
			const args = JSON.parse(partials[0].arguments)
			expect(args.result).toBe("First line of the answer.")
		})

		it("emits attempt_completion at the end so the agent loop terminates", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({ type: "message", role: "assistant", content: "Done." }),
					JSON.stringify({ type: "result", status: "ok", stats: {} }),
				]),
			)
			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "hi" }])) {
				chunks.push(c)
			}
			const partials = chunks.filter((c) => c.type === "tool_call_partial")
			expect(partials).toHaveLength(2)
			expect(partials[0].name).toBe("attempt_completion")
			expect(partials[1].arguments).toBe('{"result":"Done."}')
		})

		it("includes mode roleDefinition and custom instructions but drops tool/rules boilerplate", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([JSON.stringify({ type: "result", status: "ok", stats: {} })]))
			const systemPrompt = [
				"You are a focused code reviewer with Rust expertise.",
				"",
				"====",
				"",
				"MARKDOWN RULES",
				"",
				"ALL responses MUST show ANY `language construct`…",
				"",
				"====",
				"",
				"TOOL USE",
				"",
				"You have access to a set of tools…",
				"",
				"====",
				"",
				"USER'S CUSTOM INSTRUCTIONS",
				"",
				"The following additional instructions are provided by the user, and should be followed to the best of your ability.",
				"",
				"Always cite line numbers. Prefer single-purpose functions.",
				"",
			].join("\n")

			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const gen = handler.createMessage(systemPrompt, [{ role: "user", content: "review me" }])
			for await (const _ of gen) void _

			const args = spawnMock.mock.calls[0][1] as string[]
			const prompt = args[args.indexOf("-p") + 1]
			expect(prompt).toContain("focused code reviewer with Rust")
			expect(prompt).toContain("Always cite line numbers")
			expect(prompt).toContain("review me")
			// Tool boilerplate must NOT leak through
			expect(prompt).not.toContain("MARKDOWN RULES")
			expect(prompt).not.toContain("TOOL USE")
			expect(prompt).not.toContain("====")
		})

		it("uses --session-id on first turn and --resume on follow-ups for the same task", async () => {
			spawnMock
				.mockReturnValueOnce(fakeChild([JSON.stringify({ type: "result", status: "ok", stats: {} })]))
				.mockReturnValueOnce(fakeChild([JSON.stringify({ type: "result", status: "ok", stats: {} })]))
			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const meta = { taskId: "task-1" } as any

			const first = handler.createMessage("", [{ role: "user", content: "hi" }], meta)
			for await (const _ of first) void _
			const firstArgs = spawnMock.mock.calls[0][1] as string[]
			expect(firstArgs).toContain("--session-id")
			expect(firstArgs).not.toContain("--resume")
			const firstSession = firstArgs[firstArgs.indexOf("--session-id") + 1]
			expect(firstSession).toMatch(/^[0-9a-f-]{36}$/)

			const second = handler.createMessage("", [{ role: "user", content: "again" }], meta)
			for await (const _ of second) void _
			const secondArgs = spawnMock.mock.calls[1][1] as string[]
			expect(secondArgs).toContain("--resume")
			expect(secondArgs).not.toContain("--session-id")
			const secondSession = secondArgs[secondArgs.indexOf("--resume") + 1]
			expect(secondSession).toBe(firstSession)
		})

		it("starts a fresh session for a different taskId", async () => {
			spawnMock
				.mockReturnValueOnce(fakeChild([JSON.stringify({ type: "result", status: "ok", stats: {} })]))
				.mockReturnValueOnce(fakeChild([JSON.stringify({ type: "result", status: "ok", stats: {} })]))
			const handler = new GeminiCliHandler({} as ApiHandlerOptions)

			const a = handler.createMessage("", [{ role: "user", content: "a" }], { taskId: "task-A" } as any)
			for await (const _ of a) void _
			const b = handler.createMessage("", [{ role: "user", content: "b" }], { taskId: "task-B" } as any)
			for await (const _ of b) void _

			const aArgs = spawnMock.mock.calls[0][1] as string[]
			const bArgs = spawnMock.mock.calls[1][1] as string[]
			expect(aArgs).toContain("--session-id")
			expect(bArgs).toContain("--session-id")
			expect(aArgs[aArgs.indexOf("--session-id") + 1]).not.toBe(bArgs[bArgs.indexOf("--session-id") + 1])
		})

		it("unwraps zoo-code's <user_message> tag and trims the environment_details block", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([JSON.stringify({ type: "result", status: "ok", stats: {} })]))
			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const gen = handler.createMessage("", [
				{
					role: "user",
					content: [
						{ type: "text", text: "<user_message>\n이 프로젝트 구조를 설명해줘\n</user_message>" },
						{
							type: "text",
							text: "<environment_details>\n# VSCode Visible Files\nfoo.ts\n\n# Current Working Directory (/Users/me/proj) Files\nbar.ts\nbaz.ts\n</environment_details>",
						},
					],
				},
			])
			for await (const _ of gen) void _
			const args = spawnMock.mock.calls[0][1] as string[]
			const prompt = args[args.indexOf("-p") + 1]
			expect(prompt).toContain("이 프로젝트 구조를 설명해줘")
			expect(prompt).not.toContain("<user_message>")
			expect(prompt).not.toContain("<environment_details>")
			expect(prompt).not.toContain("# VSCode Visible Files")
			expect(prompt).not.toContain("bar.ts")
		})

		it("sends only the latest user-typed text from message history (skips assistant + tool_result-only turns)", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([JSON.stringify({ type: "result", status: "ok", stats: {} })]))
			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const gen = handler.createMessage("", [
				{ role: "user", content: "original question" },
				{ role: "assistant", content: "first answer" },
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "x", content: "fake history" } as any],
				},
				{ role: "user", content: "follow up question" },
			])
			for await (const _ of gen) void _
			const args = spawnMock.mock.calls[0][1] as string[]
			const prompt = args[args.indexOf("-p") + 1]
			expect(prompt).toContain("follow up question")
			expect(prompt).not.toContain("original question")
			expect(prompt).not.toContain("first answer")
			expect(prompt).not.toContain("fake history")
		})

		it("throws a friendly error when result indicates failure", async () => {
			const child = fakeChild([JSON.stringify({ type: "result", status: "error" })], 1, "rate limit 429\n")
			spawnMock.mockReturnValueOnce(child)

			const handler = new GeminiCliHandler({} as ApiHandlerOptions)
			const gen = handler.createMessage("", [{ role: "user", content: "x" }])
			await expect(async () => {
				for await (const _ of gen) {
					void _
				}
			}).rejects.toThrow(/rate limit/)
		})
	})
})
