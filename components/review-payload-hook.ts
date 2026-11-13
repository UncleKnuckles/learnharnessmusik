"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ReviewPayload } from "@/src/core";

/**
 * The live review payload (GET /api/review) for any surface — the Review
 * page and the sidebar's due badge share it. Null until the first answer
 * (and after a transient failure with nothing cached). Refetches ride the
 * push channel, never a poll: a turn settling is when a practice problem
 * concludes (new evidence), chats-changed covers create/delete (a deleted
 * session drops its evidence), and a resync is immediate. Announced
 * fetches share the 250ms trailing debounce the sidebar uses.
 */
/** Window event fired after a recall-card grade is saved (music-study fork). */
export const REVIEW_CHANGED_EVENT = "lh:review-changed";

export function useReviewPayload(): ReviewPayload | null {
	const [payload, setPayload] = useState<ReviewPayload | null>(null);
	const inFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		try {
			const res = await fetch("/api/review", { cache: "no-store" });
			if (res.ok) setPayload((await res.json()) as ReviewPayload);
		} catch {
			// a transient failure keeps the last snapshot
		} finally {
			inFlightRef.current = false;
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleRefresh = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("turn-settled", scheduleRefresh);
	useServerEvent("chats-changed", scheduleRefresh);
	// Recall-card grades (music-study fork) are announced in-window, not on the server bus.
	useEffect(() => {
		window.addEventListener(REVIEW_CHANGED_EVENT, scheduleRefresh);
		return () => window.removeEventListener(REVIEW_CHANGED_EVENT, scheduleRefresh);
	});
	useServerResync(() => void refresh());
	useEffect(
		() => () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	return payload;
}
