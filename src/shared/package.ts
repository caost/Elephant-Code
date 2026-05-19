import { publisher, name, version } from "../package.json"

// These ENV variables can be defined by ESBuild when building the extension
// in order to override the values in package.json. This allows us to build
// different extension variants with the same package.json file.
// The build process still needs to emit a modified package.json for consumption
// by VSCode, but that build artifact is not used during the transpile step of
// the build, so we still need this override mechanism.
// `name` is the extension identifier (zoo-code) and is shared with the
// marketplace metadata. `displayName` is what shows up in logs / output
// channel / user-facing strings so we can re-brand the visible surface
// without changing the installed extension ID.
export const Package = {
	publisher,
	name: process.env.PKG_NAME || name,
	displayName: process.env.PKG_DISPLAY_NAME || "elephant-code",
	version: process.env.PKG_VERSION || version,
	outputChannel: process.env.PKG_OUTPUT_CHANNEL || "Elephant-Code",
	releaseChannel: process.env.PKG_RELEASE_CHANNEL || "stable",
	sha: process.env.PKG_SHA,
} as const
