"use client";

/**
 * Dictation engine choice (music-study fork): Deepgram (cloud, needs a key),
 * Gemini (records here, transcribes with the Google key when you press
 * Stop) or Handy (local app, no key). "auto" keeps Deepgram when a key
 * exists, then Gemini when a Google key exists, then Handy. Window-local
 * preference (localStorage): it only decides which button behavior the
 * renderer runs, and the server's settings record stays the upstream shape.
 *
 * Every transcript that passes through LearnHarness (Deepgram and Gemini)
 * is also kept in a short local history, shown under Settings → Keys →
 * Dictation, so a dictation is never lost even if its input was cleared.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { CopyIcon, Trash2Icon } from "lucide-react";
import { SettingsRow } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";

export type DictationEngine = "auto" | "deepgram" | "gemini" | "handy";
const STORAGE_KEY = "lh.dictation.engine";
const ENGINES: readonly { value: DictationEngine; label: string }[] = [
	{ value: "auto", label: "Auto (Deepgram, else Gemini, else Handy)" },
	{ value: "deepgram", label: "Deepgram" },
	{ value: "gemini", label: "Gemini (Google key)" },
	{ value: "handy", label: "Handy (local)" },
];

const listeners = new Set<() => void>();

export function isDictationEngine(value: unknown): value is DictationEngine {
	return ENGINES.some((engine) => engine.value === value);
}

export function getDictationEngine(): DictationEngine {
	if (typeof window === "undefined") return "auto";
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		return isDictationEngine(raw) ? raw : "auto";
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

/** Whether a Google key (GEMINI_API_KEY) is saved, so Gemini dictation can run. */
export async function fetchGeminiConfigured(): Promise<boolean> {
	try {
		const res = await fetch("/api/stt/gemini", { cache: "no-store" });
		if (!res.ok) return false;
		return ((await res.json()) as { configured?: unknown }).configured === true;
	} catch {
		return false;
	}
}

/* ── Dictation history ─────────────────────────────────────────────────── */

export type DictationHistoryEntry = { text: string; at: number; engine: string };
const HISTORY_KEY = "lh.dictation.history";
export const DICTATION_HISTORY_LIMIT = 30;
const historyListeners = new Set<() => void>();
let historyCache: { raw: string | null; entries: DictationHistoryEntry[] } = { raw: null, entries: [] };

export function parseDictationHistory(raw: string | null): DictationHistoryEntry[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is DictationHistoryEntry =>
			Boolean(entry) && typeof entry.text === "string" && typeof entry.at === "number" && typeof entry.engine === "string",
		).slice(0, DICTATION_HISTORY_LIMIT);
	} catch {
		return [];
	}
}

export function getDictationHistory(): DictationHistoryEntry[] {
	if (typeof window === "undefined") return [];
	let raw: string | null = null;
	try {
		raw = window.localStorage.getItem(HISTORY_KEY);
	} catch {}
	if (raw !== historyCache.raw) historyCache = { raw, entries: parseDictationHistory(raw) };
	return historyCache.entries;
}

function writeHistory(entries: DictationHistoryEntry[]): void {
	try {
		window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, DICTATION_HISTORY_LIMIT)));
	} catch {}
	for (const listener of historyListeners) listener();
}

/** Keep one finished transcript (newest first). Empty text is ignored. */
export function recordDictation(text: string, engine: string, at = Date.now()): void {
	const trimmed = text.trim();
	if (!trimmed || typeof window === "undefined") return;
	writeHistory([{ text: trimmed, at, engine }, ...getDictationHistory()]);
}

export function clearDictationHistory(): void {
	writeHistory([]);
}

export function removeDictation(at: number): void {
	writeHistory(getDictationHistory().filter((entry) => entry.at !== at));
}

export function useDictationHistory(): DictationHistoryEntry[] {
	return useSyncExternalStore(
		(listener) => { historyListeners.add(listener); return () => { historyListeners.delete(listener); }; },
		getDictationHistory,
		() => [],
	);
}

function formatWhen(at: number): string {
	const date = new Date(at);
	const today = new Date();
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return date.toDateString() === today.toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}

const ENGINE_NAMES: Record<string, string> = { deepgram: "Deepgram", gemini: "Gemini", handy: "Handy" };

export function DictationHistory() {
	const entries = useDictationHistory();
	const [copied, setCopied] = useState<number | null>(null);
	const copy = (entry: DictationHistoryEntry) => {
		void navigator.clipboard?.writeText(entry.text).then(() => {
			setCopied(entry.at);
			setTimeout(() => setCopied((current) => current === entry.at ? null : current), 1500);
		}).catch(() => {});
	};
	return <div data-testid="dictation-history" className="py-1">
		<div className="flex items-center justify-between gap-4">
			<span className="font-prose text-(length:--lh-prose-size)">Recent dictations</span>
			{entries.length > 0 && <button type="button" onClick={clearDictationHistory} data-testid="dictation-history-clear"
				className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Clear</button>}
		</div>
		{entries.length === 0
			? <p className="text-xs text-muted-foreground/70">Nothing dictated yet. Every transcript is kept here as well as in the input.</p>
			: <ul className="mt-1 flex max-h-60 flex-col gap-1 overflow-y-auto">
				{entries.map((entry) => <li key={entry.at} className="group flex items-start gap-2 rounded-md border border-border/50 bg-card/50 px-2 py-1.5">
					<span className="min-w-0 flex-1">
						<span className="block text-[11px] text-muted-foreground/70">{formatWhen(entry.at)} · {ENGINE_NAMES[entry.engine] ?? entry.engine}</span>
						<span data-no-translate className="block whitespace-pre-wrap break-words text-xs text-foreground">{entry.text}</span>
					</span>
					<button type="button" onClick={() => copy(entry)} aria-label="Copy dictation" title={copied === entry.at ? "Copied" : "Copy"}
						className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
						<CopyIcon className="size-3.5" />
					</button>
					<button type="button" onClick={() => removeDictation(entry.at)} aria-label="Remove dictation" title="Remove"
						className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100">
						<Trash2Icon className="size-3.5" />
					</button>
				</li>)}
			</ul>}
	</div>;
}

export function DictationEngineSetting() {
	const engine = useDictationEngine();
	const active = useDictationActive();
	const [handy, setHandy] = useState<boolean | null>(null);
	const [gemini, setGemini] = useState<boolean | null>(null);
	useEffect(() => {
		void fetchHandyInstalled().then(setHandy);
		void fetchGeminiConfigured().then(setGemini);
	}, []);
	const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{text}</a>;
	const hint = engine === "gemini"
		? gemini === null ? "Checking for a Google key…"
			: gemini ? "Records while you speak. When you press Stop, Gemini transcribes it and the text goes into the input. Nothing is sent to a Gemini chat."
			: <>Needs a Google key: create one free at {link("https://aistudio.google.com/apikey", "aistudio.google.com")} and add it under Model API keys → Google.</>
		: handy === null ? "Checking for Handy…"
		: handy ? "Handy found on this computer."
		: <>Handy not found. Install it from {link("https://handy.computer", "handy.computer")}, or set LH_HANDY_PATH.</>;
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
