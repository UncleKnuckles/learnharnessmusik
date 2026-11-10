/**
 * Handy (https://handy.computer) as a keyless dictation engine.
 *
 * Handy is a local, offline speech-to-text desktop app: it records while its
 * shortcut is active, transcribes with Whisper/Parakeet on the device, and
 * pastes the text into whatever field has focus. A running instance also
 * accepts control flags from a second invocation of its binary
 * (`--toggle-transcription`, `--cancel`), which is all LearnHarness uses:
 * the composer keeps focus, LearnHarness toggles Handy, and Handy pastes the
 * transcript into the composer. No audio or text passes through this server.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HandyAction = "toggle" | "cancel";

const HANDY_FLAGS: Record<HandyAction, string> = {
	toggle: "--toggle-transcription",
	cancel: "--cancel",
};

type HandyLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	exists: (filePath: string) => boolean;
};

/** Candidate binaries in lookup order. LH_HANDY_PATH always wins. */
export function handyCandidates({ env, platform, homeDir }: Omit<HandyLookup, "exists">): string[] {
	const override = env.LH_HANDY_PATH?.trim();
	const paths = platform === "win32" ? path.win32 : path.posix;
	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA ?? paths.join(homeDir, "AppData", "Local");
		const programFiles = [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"]].filter((dir): dir is string => Boolean(dir));
		const installDirs = [
			paths.join(localAppData, "Handy"),
			paths.join(localAppData, "Programs", "Handy"),
			...programFiles.map((dir) => paths.join(dir, "Handy")),
		];
		return [
			...(override ? [override] : []),
			...[...installDirs, ...pathDirs].flatMap((dir) => [paths.join(dir, "handy.exe"), paths.join(dir, "Handy.exe")]),
		];
	}
	if (platform === "darwin") {
		return [
			...(override ? [override] : []),
			"/Applications/Handy.app/Contents/MacOS/Handy",
			paths.join(homeDir, "Applications", "Handy.app", "Contents", "MacOS", "Handy"),
			"/Applications/Handy.app/Contents/MacOS/handy",
			...pathDirs.map((dir) => paths.join(dir, "handy")),
		];
	}
	return [
		...(override ? [override] : []),
		...pathDirs.map((dir) => paths.join(dir, "handy")),
		"/usr/bin/handy",
		"/usr/local/bin/handy",
		paths.join(homeDir, ".local", "bin", "handy"),
	];
}

export function resolveHandyBinary(lookup: HandyLookup): string | null {
	return handyCandidates(lookup).find((candidate) => lookup.exists(candidate)) ?? null;
}

function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getHandyBinary(): string | null {
	return resolveHandyBinary({ env: process.env, platform: process.platform, homeDir: os.homedir(), exists: isFile });
}

export interface HandyStatus {
	installed: boolean;
}

/** Never exposes the absolute path to the renderer. */
export function handyStatus(): HandyStatus {
	return { installed: getHandyBinary() !== null };
}

export class HandyNotFoundError extends Error {
	constructor() {
		super("Handy is not installed. Install it from handy.computer, or set LH_HANDY_PATH to its binary.");
	}
}

/** Send one control flag to the running Handy instance (Handy starts itself
 *  if it was not running). Resolves once the control process has exited. */
export function runHandy(action: HandyAction, binary: string | null = getHandyBinary()): Promise<void> {
	if (!binary) return Promise.reject(new HandyNotFoundError());
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [HANDY_FLAGS[action]], { stdio: "ignore", windowsHide: true, detached: false });
		// A first launch keeps running as the Handy instance itself; do not
		// wait on it beyond a short grace period.
		const grace = setTimeout(() => { child.unref(); resolve(); }, 1500);
		child.once("error", (error) => { clearTimeout(grace); reject(error); });
		child.once("exit", () => { clearTimeout(grace); resolve(); });
	});
}
