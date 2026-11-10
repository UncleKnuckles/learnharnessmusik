export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";

export const CLAUDE_CODE_API = "claude-code-cli";

export enum ClaudeCodeError {
	CliNotFound = "claude CLI not found",
	NotSignedIn = "Claude Code is not signed in. Open a terminal, run `claude`, sign in with /login, then restart LearnHarness. Or pick an API-key model in Settings → Models.",
}
