import { useMemo, type ReactNode } from "react"

import type { ClineMessage } from "@roo-code/types"

/**
 * Renders a multi-provider compare run as a vertical stack of cards — one per
 * provider profile id seen in the merged message stream. Each card shows that
 * provider's row sequence (reusing the parent's renderRow callback so we keep
 * the existing ChatRow styling). The optional summary message, if present, is
 * rendered as a separate full-width card below the stack.
 *
 * Activated by `ChatView` whenever any visible message carries a `groupId` —
 * outside of compare runs, the normal Virtuoso-backed list still owns the
 * rendering path.
 */
interface CompareCardStackProps {
	messages: ClineMessage[]
	listApiConfigMeta?: Array<{ id: string; name: string }>
	/** Render a single ClineMessage row. Caller controls per-row props (expand,
	 *  streaming, etc.) so we don't recreate the whole row API here. */
	renderRow: (message: ClineMessage, opts: { isLast: boolean }) => ReactNode
}

export const CompareCardStack = ({ messages, listApiConfigMeta, renderRow }: CompareCardStackProps) => {
	// `compare_summary` rows live below the stack; everything else slots into
	// per-provider cards.
	const { perProvider, summaryRows, providerOrder } = useMemo(() => {
		const summaryRows: ClineMessage[] = []
		const perProvider = new Map<string, ClineMessage[]>()
		const order: string[] = []
		for (const m of messages) {
			if (m.say === "compare_summary") {
				summaryRows.push(m)
				continue
			}
			const pid = m.providerProfileId ?? "__unknown"
			if (!perProvider.has(pid)) {
				perProvider.set(pid, [])
				order.push(pid)
			}
			perProvider.get(pid)!.push(m)
		}
		return { perProvider, summaryRows, providerOrder: order }
	}, [messages])

	const displayName = (pid: string) => listApiConfigMeta?.find((c) => c.id === pid)?.name ?? pid

	return (
		<div className="flex flex-col gap-3 px-3 py-2" data-testid="compare-card-stack">
			{providerOrder.map((pid) => {
				const rows = perProvider.get(pid) ?? []
				return (
					<div
						key={pid}
						className="border border-vscode-panel-border rounded-md overflow-hidden bg-vscode-editor-background"
						data-testid={`compare-card-${pid}`}>
						<div className="px-3 py-1.5 text-xs font-semibold border-b border-vscode-panel-border bg-vscode-titleBar-activeBackground text-vscode-titleBar-activeForeground">
							{displayName(pid)}
						</div>
						<div className="flex flex-col">
							{rows.map((row, i) => (
								<div key={`${row.ts}-${i}`}>{renderRow(row, { isLast: i === rows.length - 1 })}</div>
							))}
						</div>
					</div>
				)
			})}
			{summaryRows.map((row) => (
				<div
					key={`summary-${row.ts}`}
					className="border border-vscode-focusBorder rounded-md overflow-hidden bg-vscode-editor-background"
					data-testid="compare-summary-card">
					<div className="px-3 py-1.5 text-xs font-semibold border-b border-vscode-focusBorder text-vscode-focusBorder">
						📊 Compare summary
					</div>
					<div className="flex flex-col">{renderRow(row, { isLast: true })}</div>
				</div>
			))}
		</div>
	)
}
