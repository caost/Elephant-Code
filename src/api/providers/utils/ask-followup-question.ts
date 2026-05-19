/**
 * Helpers for the CLI providers (claude-code, gemini-cli) that wrap a
 * subscription-based binary instead of an HTTP API. Those providers do not
 * speak native tool-calling, so we ask the model to emit an
 * `<ask_followup_question>` XML block when it needs a clickable
 * decision-prompt from the user. The provider scans the stream for the block
 * and converts it into a single `tool_call` chunk that Roo's existing native
 * tool-call infrastructure can route to the AskFollowupQuestionTool. The
 * model sees this XML form in the prompt; the user sees Roo's standard
 * "has a question" card.
 *
 * Schema mirrors AskFollowupQuestionTool's params (question + follow_up[]).
 */
export const ASK_QUESTION_OPEN = "<ask_followup_question>"
export const ASK_QUESTION_CLOSE = "</ask_followup_question>"

export interface AskFollowupQuestionPayload {
	question: string
	follow_up: Array<{ text: string }>
}

/**
 * Parse the body sitting between `<ask_followup_question>` and
 * `</ask_followup_question>`. Returns null if the required `<question>` is
 * missing or empty — callers should fall back to emitting the raw text in
 * that case so a malformed block does not silently vanish.
 */
export function parseAskFollowupQuestionBlock(inner: string): AskFollowupQuestionPayload | null {
	const questionMatch = inner.match(/<question>([\s\S]*?)<\/question>/)
	if (!questionMatch) return null
	const question = questionMatch[1].trim()
	if (!question) return null

	const followUp: Array<{ text: string }> = []
	const followUpMatch = inner.match(/<follow_up>([\s\S]*?)<\/follow_up>/)
	if (followUpMatch) {
		for (const m of followUpMatch[1].matchAll(/<suggest>([\s\S]*?)<\/suggest>/g)) {
			const text = m[1].trim()
			if (text) followUp.push({ text })
		}
	}

	return { question, follow_up: followUp }
}

/**
 * The prompt block we inject into the CLI provider's formatPrompt so the
 * model knows both how to wrap final answers AND how to ask the user for a
 * decision when one is needed. Kept here so the two providers stay in sync.
 */
export const RESPONSE_FORMAT_BLOCK =
	"RESPONSE FORMAT:\n" +
	"End your response with EXACTLY ONE of (a) a final result block OR (b) a " +
	"follow-up question block — never both, never neither.\n\n" +
	"(a) When the task is complete, append on its own line:\n" +
	"<task_summary>\n<your concise final result here, 1–2 sentences>\n</task_summary>\n\n" +
	"(b) When you NEED a decision or clarification from the user before you can " +
	"finish, append on its own line:\n" +
	"<ask_followup_question>\n" +
	"<question>your question to the user</question>\n" +
	"<follow_up>\n" +
	"<suggest>short, specific option 1</suggest>\n" +
	"<suggest>short, specific option 2</suggest>\n" +
	"</follow_up>\n" +
	"</ask_followup_question>\n\n" +
	"Use (b) sparingly — only when the user's answer changes what you would do " +
	"next. Provide 2–4 short, actionable suggestions ordered by likely preference. " +
	"Do NOT emit both blocks; do NOT emit either block more than once."
