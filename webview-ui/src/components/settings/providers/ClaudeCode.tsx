import React from "react"
import { VSCodeTextField, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings } from "@roo-code/types"

interface ClaudeCodeProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const ClaudeCode: React.FC<ClaudeCodeProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const handleBinaryPathInput = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("claudeCodeBinaryPath", element.value)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="rounded border border-vscode-inputValidation-warningBorder/40 bg-vscode-inputValidation-warningBackground/20 p-2 text-xs text-vscode-descriptionForeground">
				<strong>Auto-approve mode.</strong> This provider runs the local <code>claude</code> CLI with{" "}
				<code>--dangerously-skip-permissions</code>, which auto-approves any tool the CLI decides to invoke —
				including file edits and shell commands. Review changes via Source Control before committing. Disable or
				switch providers for sensitive workspaces.
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.claudeCodeBinaryPath || ""}
					className="w-full mt-1"
					type="text"
					onInput={handleBinaryPathInput}
					placeholder="(auto-detected from PATH)">
					claude Binary Path
				</VSCodeTextField>
				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					Optional. Leave empty to auto-detect the <code>claude</code> command from PATH, common Unix
					locations, and nvm/fnm node version directories.
				</p>
			</div>

			<div className="text-xs text-vscode-descriptionForeground mt-2">
				Authentication is delegated to the CLI — your Claude subscription is reused, no API key needed.
				<br />
				To get started:
				<br />
				1. Install Claude Code from&nbsp;
				<VSCodeLink href="https://claude.com/claude-code" className="text-xs">
					claude.com/claude-code
				</VSCodeLink>
				<br />
				2. Run&nbsp;<code>claude</code>&nbsp;once in a terminal and complete the OAuth login
				<br />
				3. Pick a model below (<code>sonnet</code> is a safe default) and start chatting
			</div>
		</div>
	)
}
