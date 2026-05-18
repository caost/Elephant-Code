// npx vitest run api/providers/__tests__/claude-code.spec.ts

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

import { ClaudeCodeHandler } from "../claude-code"
import type { ApiHandlerOptions } from "../../../shared/api"

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

const assistantText = (text: string) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "text", text }] },
	})
const assistantThinking = (thinking: string) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "thinking", thinking }] },
	})
const assistantToolUse = (name: string, input: unknown) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "tool_use", name, input }] },
	})
const resultEvent = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		type: "result",
		result: "ok",
		is_error: false,
		total_input_tokens: 0,
		total_output_tokens: 0,
		session_id: "fake-session",
		...overrides,
	})

describe("ClaudeCodeHandler (subprocess)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("getModel", () => {
		it("uses configured model id", () => {
			const h = new ClaudeCodeHandler({ apiModelId: "opus" } as ApiHandlerOptions)
			expect(h.getModel().id).toBe("opus")
		})

		it("falls back to sonnet for unknown id", () => {
			const h = new ClaudeCodeHandler({ apiModelId: "bogus" } as unknown as ApiHandlerOptions)
			expect(h.getModel().id).toBe("sonnet")
		})
	})

	describe("createMessage", () => {
		it("spawns claude with -p, stream-json, --verbose, and --dangerously-skip-permissions", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({ type: "system" }),
					assistantText("Hello"),
					resultEvent({ total_input_tokens: 4, total_output_tokens: 1 }),
				]),
			)
			const handler = new ClaudeCodeHandler({ apiModelId: "sonnet" } as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) {
				chunks.push(c)
			}

			expect(spawnMock).toHaveBeenCalledTimes(1)
			const [, args] = spawnMock.mock.calls[0]
			expect(args).toContain("-p")
			expect(args).toContain("--output-format")
			expect(args).toContain("stream-json")
			expect(args).toContain("--verbose")
			expect(args).toContain("--dangerously-skip-permissions")
			expect(args).toContain("--model")
			expect(args).toContain("sonnet")

			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			expect(text).toBe("Hello")
			const usage = chunks.find((c) => c.type === "usage")
			expect(usage).toMatchObject({ inputTokens: 4, outputTokens: 1 })
		})

		it("uses --session-id on first turn and --resume on follow-ups for same task", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([resultEvent()])).mockReturnValueOnce(fakeChild([resultEvent()]))
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
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
			expect(secondArgs[secondArgs.indexOf("--resume") + 1]).toBe(firstSession)
		})

		it("starts a fresh session for a different taskId", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([resultEvent()])).mockReturnValueOnce(fakeChild([resultEvent()]))
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)

			const a = handler.createMessage("", [{ role: "user", content: "a" }], { taskId: "A" } as any)
			for await (const _ of a) void _
			const b = handler.createMessage("", [{ role: "user", content: "b" }], { taskId: "B" } as any)
			for await (const _ of b) void _

			const aArgs = spawnMock.mock.calls[0][1] as string[]
			const bArgs = spawnMock.mock.calls[1][1] as string[]
			expect(aArgs).toContain("--session-id")
			expect(bArgs).toContain("--session-id")
			expect(aArgs[aArgs.indexOf("--session-id") + 1]).not.toBe(bArgs[bArgs.indexOf("--session-id") + 1])
		})

		it("surfaces thinking blocks as reasoning and tool_use as reasoning, never as tool_call_partial", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					assistantThinking("Thinking about the request..."),
					assistantToolUse("Read", { path: "src/a.ts" }),
					assistantText("Final answer."),
					resultEvent(),
				]),
			)
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				chunks.push(c)
			}
			const reasoning = chunks.filter((c) => c.type === "reasoning")
			expect(reasoning.some((c) => c.text.includes("Thinking about"))).toBe(true)
			expect(reasoning.some((c) => c.text.includes("Read"))).toBe(true)
			// Only synthesised attempt_completion may use tool_call_partial.
			const partials = chunks.filter((c) => c.type === "tool_call_partial")
			expect(partials.every((c) => c.id === "attempt_completion-0")).toBe(true)
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			expect(text).toBe("Final answer.")
		})

		it("uses <task_summary> for attempt_completion and strips it from visible text", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					assistantText("Here is the detailed answer with lots of explanation. "),
					assistantText("\n\n<task_summary>\nResponded with a detailed explanation.\n</task_summary>"),
					resultEvent(),
				]),
			)
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				chunks.push(c)
			}
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			expect(text).not.toContain("<task_summary")
			expect(text).not.toContain("Responded with")
			expect(text).toContain("Here is the detailed answer")
			const partials = chunks.filter((c) => c.type === "tool_call_partial" && c.arguments)
			expect(partials).toHaveLength(1)
			const args = JSON.parse(partials[0].arguments)
			expect(args.result).toBe("Responded with a detailed explanation.")
		})

		it("falls back to result.result for attempt_completion when summary tag missing", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					assistantText("Streamed body content."),
					resultEvent({ result: "Final concise summary from claude." }),
				]),
			)
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				chunks.push(c)
			}
			const partials = chunks.filter((c) => c.type === "tool_call_partial" && c.arguments)
			const args = JSON.parse(partials[0].arguments)
			expect(args.result).toBe("Final concise summary from claude.")
		})

		it("streams partial text via stream_event content_block_delta and ignores the redundant assistant aggregate", async () => {
			// Realistic claude `--include-partial-messages` event sequence: several
			// content_block_delta chunks, then a single aggregate `assistant` event
			// that repeats the full text. We must surface the deltas as separate
			// text chunks and drop the aggregate so the response is not doubled.
			// Use chunks > TAIL_HOLD (14 chars) so the tail buffer flushes each
			// delta separately instead of coalescing them into one emit.
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({
						type: "stream_event",
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "Hello there friend " },
						},
					}),
					JSON.stringify({
						type: "stream_event",
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "this is a longer answer " },
						},
					}),
					JSON.stringify({
						type: "stream_event",
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "with multiple deltas." },
						},
					}),
					JSON.stringify({
						type: "assistant",
						message: {
							content: [
								{
									type: "text",
									text: "Hello there friend this is a longer answer with multiple deltas.",
								},
							],
						},
					}),
					resultEvent(),
				]),
			)
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const text: string[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				if (c.type === "text") text.push(c.text)
			}
			expect(text.join("")).toBe("Hello there friend this is a longer answer with multiple deltas.")
			// Multiple separate text emits — confirms streaming path AND that
			// the aggregate assistant event is suppressed (otherwise the body
			// would be duplicated).
			expect(text.length).toBeGreaterThanOrEqual(2)
		})

		it("falls back to the aggregate assistant event when no stream_event deltas were received", async () => {
			// Older CLI versions / `--include-partial-messages` not effective:
			// we should still surface text from the aggregate assistant event.
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({
						type: "assistant",
						message: { content: [{ type: "text", text: "Full answer." }] },
					}),
					resultEvent(),
				]),
			)
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const text: string[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				if (c.type === "text") text.push(c.text)
			}
			expect(text.join("")).toBe("Full answer.")
		})

		it("surfaces thinking_delta from stream_event as reasoning", async () => {
			spawnMock.mockReturnValueOnce(
				fakeChild([
					JSON.stringify({
						type: "stream_event",
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "thinking_delta", thinking: "Considering options..." },
						},
					}),
					JSON.stringify({
						type: "stream_event",
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "Answer." },
						},
					}),
					resultEvent(),
				]),
			)
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const chunks: any[] = []
			for await (const c of handler.createMessage("", [{ role: "user", content: "x" }])) {
				chunks.push(c)
			}
			const reasoning = chunks.filter((c) => c.type === "reasoning")
			expect(reasoning.some((c) => c.text.includes("Considering options"))).toBe(true)
		})

		it("unwraps zoo-code's <user_message> tag and trims the environment_details block", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([resultEvent()]))
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
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
			// The actual user request must appear unwrapped.
			expect(prompt).toContain("이 프로젝트 구조를 설명해줘")
			// Wrapper tags must not leak through to the CLI.
			expect(prompt).not.toContain("<user_message>")
			expect(prompt).not.toContain("<environment_details>")
			// Should NOT carry the raw env_details listing.
			expect(prompt).not.toContain("# VSCode Visible Files")
			expect(prompt).not.toContain("bar.ts")
		})

		it("sends only the latest user-typed text from message history", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([resultEvent()]))
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
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

		it("extracts user decision text from a trailing tool_result-only message", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([resultEvent()]))
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const gen = handler.createMessage("", [
				{ role: "user", content: "do the thing" },
				{ role: "assistant", content: "first answer awaiting approval" },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "abc",
							content: "no, use the other approach instead",
						} as any,
					],
				},
			])
			for await (const _ of gen) void _
			const args = spawnMock.mock.calls[0][1] as string[]
			const prompt = args[args.indexOf("-p") + 1]
			expect(prompt).toContain("no, use the other approach instead")
			expect(prompt).not.toContain("do the thing")
		})

		it("extracts user decision text from tool_result whose content is a text-block array", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([resultEvent()]))
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const gen = handler.createMessage("", [
				{ role: "user", content: "initial request" },
				{ role: "assistant", content: "draft response" },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "xyz",
							content: [{ type: "text", text: "rewrite to be terser" }],
						} as any,
					],
				},
			])
			for await (const _ of gen) void _
			const args = spawnMock.mock.calls[0][1] as string[]
			const prompt = args[args.indexOf("-p") + 1]
			expect(prompt).toContain("rewrite to be terser")
			expect(prompt).not.toContain("initial request")
		})

		it("includes mode roleDefinition and custom instructions but drops tool boilerplate", async () => {
			spawnMock.mockReturnValueOnce(fakeChild([resultEvent()]))
			const systemPrompt = [
				"You are a focused code reviewer with Rust expertise.",
				"",
				"====",
				"",
				"MARKDOWN RULES",
				"",
				"…",
				"",
				"====",
				"",
				"TOOL USE",
				"",
				"…",
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
			const handler = new ClaudeCodeHandler({} as ApiHandlerOptions)
			const gen = handler.createMessage(systemPrompt, [{ role: "user", content: "review me" }])
			for await (const _ of gen) void _
			const args = spawnMock.mock.calls[0][1] as string[]
			const prompt = args[args.indexOf("-p") + 1]
			expect(prompt).toContain("focused code reviewer with Rust")
			expect(prompt).toContain("Always cite line numbers")
			expect(prompt).toContain("review me")
			expect(prompt).not.toContain("MARKDOWN RULES")
			expect(prompt).not.toContain("TOOL USE")
		})
	})
})
