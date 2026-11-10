"use client";

/**
 * Dictation engine choice (music-study fork): Deepgram (cloud, needs a key)
 * or Handy (local app, no key). "auto" keeps Deepgram when a key exists and
 * falls back to Handy when it does not. Window-local preference
 * (localStorage): it only decides which button behavior the renderer runs,
 * and the server's settings record stays the upstream shape.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsRow } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";

export type DictationEngine = "auto" | "deepgram" | "handy";
const STORAGE_KEY = "lh.dictation.engine";
const ENGINES: readonly { value: DictationEngine; label: string }[] = [
	{ value: "auto", label: "Auto (Deepgram, else Handy)" },
	{ value: "deepgram", label: "Deepgram" },
	{ value: "handy", label: "Handy (local)" },
];

const listeners = new Set<() => void>();

export function getDictationEngine(): DictationEngine {
	if (typeof window === "undefined") return "auto";
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		return raw === "deepgram" || raw === "handy" ? raw : "auto";
	} catch {
		return "auto";
	}
}

export function setDictationEngine(engine: DictationEngine): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, engine);
	} catch {}
	for (const listener of listeners) listener();
}

export function useDictationEngine(): DictationEngine {
	return useSyncExternalStore(
		(listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getDictationEngine,
		() => "auto",
	);
}

/** Whether a Handy binary exists on this machine (server-side lookup). */
export async function fetchHandyInstalled(): Promise<boolean> {
	try {
		const res = await fetch("/api/stt/handy", { cache: "no-store" });
		if (!res.ok) return false;
		return ((await res.json()) as { installed?: unknown }).installed === true;
	} catch {
		return false;
	}
}

export function DictationEngineSetting() {
	const engine = useDictationEngine();
	const active = useDictationActive();
	const [handy, setHandy] = useState<boolean | null>(null);
	useEffect(() => { void fetchHandyInstalled().then(setHandy); }, []);
	const hint = handy === null ? "Checking for Handy…"
		: handy ? "Handy found on this computer."
		: <>Handy not found. Install it from <a href="https://handy.computer" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">handy.computer</a>, or set LH_HANDY_PATH.</>;
	return <SettingsRow label="Engine" hint={hint} testid="row-dictation-engine" dimmed={active}>
		<select
			data-testid="dictation-engine"
			aria-label="Dictation engine"
			value={engine}
			disabled={active}
			onChange={(event) => setDictationEngine(event.target.value as DictationEngine)}
			className="h-7 max-w-[65%] rounded-md border border-border bg-card px-2 text-xs text-card-foreground"
		>
			{ENGINES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
		</select>
	</SettingsRow>;
}
