"use client";

/**
 * Russian node names in the graph view (music-study fork).
 *
 * GET /api/graph/translations returns the saved Russian entries and starts
 * a background translation run for nodes that have none yet. While a run
 * is going, this hook polls so new names appear as batches finish.
 *
 * The graph view swaps names and statements in place on its snapshot (no
 * new snapshot object, so the layout never rebuilds) and keeps the
 * originals as extra aliases, which makes search match both languages.
 */
import { useEffect, useRef, useState } from "react";
import type { GraphNode } from "@/src/core";

export type NodeTranslation = { name: string; statement: string };
export type NodeTranslations = Record<string, NodeTranslation>;
type View = { translations?: NodeTranslations; pending?: number; running?: boolean; error?: string | null };

const POLL_MS = 6000;

export function useNodeTranslations(enabled: boolean, refreshKey: unknown): { translations: NodeTranslations; pending: number; error: string | null } {
	const [state, setState] = useState<{ translations: NodeTranslations; pending: number; error: string | null }>({ translations: {}, pending: 0, error: null });
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const load = () => {
			fetch("/api/graph/translations", { cache: "no-store" })
				.then((res) => res.ok ? res.json() as Promise<View> : null)
				.then((view) => {
					if (!live || !view) return;
					setState({ translations: view.translations ?? {}, pending: view.pending ?? 0, error: view.error ?? null });
					if (view.running && (view.pending ?? 0) > 0) timer.current = setTimeout(load, POLL_MS);
				})
				.catch(() => {});
		};
		load();
		return () => {
			live = false;
			if (timer.current) clearTimeout(timer.current);
		};
	}, [enabled, refreshKey]);
	return state;
}

export type Originals = Map<string, NodeTranslation>;

/**
 * Apply translations IN PLACE to node lists (canvas nodes and stored
 * propositions). Returns the ids whose name changed. `originals` keeps the
 * canonical text per id; it is filled on first sight, so repeated calls are
 * idempotent and a refetched snapshot (fresh objects) localizes again.
 */
export function localizeNodes(
	lists: ReadonlyArray<GraphNode[] | undefined>,
	translations: NodeTranslations,
	originals: Originals,
): Map<string, string> {
	const renamed = new Map<string, string>();
	for (const list of lists) {
		for (const node of list ?? []) {
			const t = translations[node.id];
			if (!t) continue;
			let original = originals.get(node.id);
			if (!original || (node.name !== original.name && node.name !== t.name)) {
				// First sight, or the canonical text changed since.
				original = { name: node.name, statement: node.statement };
				originals.set(node.id, original);
			}
			if (node.name === t.name && node.statement === t.statement) continue;
			if (node.name !== t.name) renamed.set(node.id, t.name);
			node.name = t.name;
			node.statement = t.statement || node.statement;
			const aliases = node.aliases ?? [];
			const extra = [original.name, original.statement].filter((text) => text && !aliases.includes(text));
			if (extra.length) node.aliases = [...aliases, ...extra];
		}
	}
	return renamed;
}

type NamedItem = { id: string; name: string; statement: string };

/** A copy of a review payload with Russian names and statements. */
export function localizeReviewPayload<P extends { due: NamedItem[]; upcoming: NamedItem[]; fresh?: NamedItem[] }>(payload: P | null, translations: NodeTranslations): P | null {
	if (!payload || Object.keys(translations).length === 0) return payload;
	const swap = <T extends NamedItem>(items: T[]): T[] => items.map((item) => {
		const t = translations[item.id];
		return t ? { ...item, name: t.name, statement: t.statement || item.statement } : item;
	});
	return { ...payload, due: swap(payload.due), upcoming: swap(payload.upcoming), ...(payload.fresh ? { fresh: swap(payload.fresh) } : {}) };
}
