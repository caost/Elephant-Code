import React from "react"
import { VSCodeTextField, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings } from "@roo-code/types"

interface GeminiCliProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const GeminiCli: React.FC<GeminiCliProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const handleBinaryPathInput = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("geminiCliBinaryPath", element.value)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="rounded border border-vscode-inputValidation-warningBorder/40 bg-vscode-inputValidation-warningBackground/20 p-2 text-xs text-vscode-descriptionForeground">
				<strong>Auto-approve mode (YOLO).</strong> This provider runs the local <code>gemini</code> CLI with{" "}
				<code>--approval-mode yolo</code>, which auto-approves any tool the CLI decides to invoke — including
				file edits and shell commands. Review changes via Source Control before committing. Disable or switch
				providers for sensitive workspaces.
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.geminiCliBinaryPath || ""}
					className="w-full mt-1"
					type="text"
					onInput={handleBinaryPathInput}
					placeholder="(auto-detected from PATH)">
					gemini Binary Path
				</VSCodeTextField>
				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					Optional. Leave empty to auto-detect the <code>gemini</code> command from PATH, common Unix
					locations, and nvm/fnm node version directories.
				</p>
			</div>

			<div className="text-xs text-vscode-descriptionForeground mt-2">
				Authentication is delegated to the CLI — no API key is needed.
				<br />
				To get started:
				<br />
				1. Install:&nbsp;<code>npm install -g @google/gemini-cli</code>
				<br />
				2. Run&nbsp;<code>gemini</code>&nbsp;once and complete the OAuth login
				<br />
				3. Pick a model below and start chatting
				<br />
				<VSCodeLink href="https://github.com/google-gemini/gemini-cli" className="text-xs">
					View Gemini CLI on GitHub →
				</VSCodeLink>
			</div>
		</div>
	)
}
