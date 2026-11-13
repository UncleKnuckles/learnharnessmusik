"use client";

/**
 * Interface language (music-study fork): a runtime translation layer that
 * keeps the English source untouched, so upstream merges stay conflict-free.
 *
 * When Russian is on, a MutationObserver rewrites UI text nodes and the
 * placeholder/title attributes whose whole text is a known UI string
 * (components/i18n/ru.ts). It changes values in place only, so React keeps
 * owning the nodes: when React writes new English text, the observer sees
 * the mutation and translates it again.
 *
 * Never translated: lesson prose (.lh-prose), code, editable fields, the
 * learner's input, and anything inside [data-no-translate]. Switching back
 * to English reloads the window, which restores every original string.
 */
import { useEffect, useSyncExternalStore } from "react";
import { SettingsRow } from "@/components/settings/controls";
import { translateText } from "@/components/i18n/ru";

export type UiLanguage = "en" | "ru";
const STORAGE_KEY = "lh.language";
const listeners = new Set<() => void>();

export function getUiLanguage(): UiLanguage {
	if (typeof window === "undefined") return "en";
	try {
		return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "ru";
	} catch {
		return "en";
	}
}

export function setUiLanguage(language: UiLanguage): void {
	const previous = getUiLanguage();
	try {
		window.localStorage.setItem(STORAGE_KEY, language);
	} catch {}
	for (const listener of listeners) listener();
	window.dispatchEvent(new CustomEvent(UI_LANGUAGE_EVENT, { detail: language }));
	// English is the source text: a reload is the only clean way back.
	if (previous === "ru" && language === "en") window.location.reload();
}

export const UI_LANGUAGE_EVENT = "lh:ui-language";

export function useUiLanguage(): UiLanguage {
	return useSyncExternalStore(
		(listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getUiLanguage,
		() => "en",
	);
}

const SKIP_SELECTOR = [
	"[data-no-translate]", ".lh-prose", "code", "pre", "kbd", "samp", "textarea", "script", "style",
	"[contenteditable='true']", "[contenteditable='']", "[contenteditable='plaintext-only']", ".katex", "svg text",
	"[data-file-path-input]",
].join(",");
const ATTRIBUTES = ["placeholder", "title", "data-placeholder", "aria-placeholder"] as const;
/** Placeholders are never the learner's text, so they translate even on
 *  editable fields (the composer is a contenteditable with data-placeholder). */
const PLACEHOLDERS = ["placeholder", "data-placeholder", "aria-placeholder"] as const;

function skipped(el: Element | null): boolean {
	return !el || el.closest(SKIP_SELECTOR) !== null;
}

/** Translate a string, keeping its leading/trailing whitespace. */
export function translateWithSpacing(value: string): string | null {
	const core = value.replace(/\s+/g, " ").trim();
	if (core.length < 2 || !/[A-Za-z]/.test(core)) return null;
	const translated = translateText(core);
	if (translated === null || translated === core) return null;
	const lead = /^\s/.test(value) ? " " : "";
	const trail = /\s$/.test(value) ? " " : "";
	return lead + translated + trail;
}

function translateTextNode(node: Text): void {
	const value = node.nodeValue;
	if (!value) return;
	const next = translateWithSpacing(value);
	if (next === null || skipped(node.parentElement)) return;
	node.nodeValue = next;
}

function translateAttributes(el: Element, names: readonly string[] = ATTRIBUTES): void {
	for (const name of names) {
		const value = el.getAttribute(name);
		if (!value) continue;
		const next = translateWithSpacing(value);
		if (next !== null && !el.closest("[data-no-translate]")) el.setAttribute(name, next);
	}
}

function translateTree(root: Node): void {
	if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root as Text); return; }
	if (!(root instanceof Element) && !(root instanceof DocumentFragment)) return;
	if (root instanceof Element) {
		if (root.matches(SKIP_SELECTOR)) { translateAttributes(root, PLACEHOLDERS); return; }
		translateAttributes(root);
	}
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => {
			if (!(node instanceof Element) || !node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
			translateAttributes(node, PLACEHOLDERS);
			return NodeFilter.FILTER_REJECT;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text);
		else translateAttributes(node as Element);
	}
}

/** Start translating the document; returns the stop function. */
export function startTranslating(target: Element = document.body): () => void {
	translateTree(target);
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			if (record.type === "characterData") translateTextNode(record.target as Text);
			else if (record.type === "attributes") {
				const el = record.target as Element;
				translateAttributes(el, el.matches(SKIP_SELECTOR) ? PLACEHOLDERS : ATTRIBUTES);
			}
			else for (const node of record.addedNodes) translateTree(node);
		}
	});
	observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRIBUTES] });
	return () => observer.disconnect();
}

/** Mounted once in the root layout. */
export function UiTranslator() {
	const language = useUiLanguage();
	useEffect(() => {
		document.documentElement.lang = language;
		if (language !== "ru") return;
		// After hydration: React must first match its own server HTML.
		let stop: (() => void) | null = null;
		const id = window.setTimeout(() => { stop = startTranslating(); }, 0);
		return () => { window.clearTimeout(id); stop?.(); };
	}, [language]);
	return null;
}

export function UiLanguageSetting() {
	const language = useUiLanguage();
	return <SettingsRow label="Interface language" hint="Lesson text and your own notes stay unchanged. Node names are shown in Russian once translated." testid="row-ui-language">
		<select
			data-testid="ui-language"
			data-no-translate
			aria-label="Interface language"
			value={language}
			onChange={(event) => setUiLanguage(event.target.value === "ru" ? "ru" : "en")}
			className="h-7 max-w-[65%] rounded-md border border-border bg-card px-2 text-xs text-card-foreground"
		>
			<option value="en">English</option>
			<option value="ru">Русский</option>
		</select>
	</SettingsRow>;
}
