"use client";

/**
 * RECALL CARDS (music-study fork): spaced repetition by self-grading. The
 * front shows an idea's name; the learner recalls it, reveals the
 * statement and grades their recall. Each grade is posted to
 * /api/review/cards and folded by FSRS-6 with the practice evidence, so the
 * idea's next due date moves with it. Keys: Space/Enter reveals, 1–4
 * grade, Esc leaves. Unlike the Flashcards core plugin (model-written
 * question/answer cues in decks), these cards are the graph's ideas
 * themselves and cost no model calls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CardGrade, ReviewItem } from "@/src/core";
import { REVIEW_CHANGED_EVENT } from "@/components/review-payload-hook";

export const CARD_GRADES: readonly { grade: CardGrade; label: string; hint: string }[] = [
	{ grade: 1, label: "Again", hint: "Forgot it" },
	{ grade: 2, label: "Hard", hint: "Recalled with effort" },
	{ grade: 3, label: "Good", hint: "Recalled" },
	{ grade: 4, label: "Easy", hint: "Instant" },
];

export async function postCardGrade(nodeId: string, grade: CardGrade, session: string, post: typeof fetch = fetch): Promise<void> {
	const res = await post("/api/review/cards", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ nodeId, grade, session }),
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? `Could not save the grade (${res.status})`);
	}
	if (typeof window !== "undefined") window.dispatchEvent(new Event(REVIEW_CHANGED_EVENT));
}

/** The pure card face: props in, markup out. */
export function CardFace({
	item,
	position,
	total,
	revealed,
	busy,
	error,
	onReveal,
	onGrade,
}: {
	item: ReviewItem;
	position: number;
	total: number;
	revealed: boolean;
	busy: boolean;
	error: string | null;
	onReveal: () => void;
	onGrade: (grade: CardGrade) => void;
}) {
	return (
		<div data-testid="review-card" className="flex flex-col gap-6">
			<p className="text-xs uppercase tracking-widest text-muted-foreground/70">
				Card {position} of {total}{item.reps === 0 ? " · new" : ""}
			</p>
			<div className="rounded-xl border border-border bg-card/60 p-6 shadow-sm">
				<p className="text-xs text-muted-foreground">Recall what this idea says, then reveal it.</p>
				<h2 data-testid="review-card-front" className="mt-2 text-lg font-medium">{item.name}</h2>
				{revealed && (
					<p data-testid="review-card-back" className="mt-4 whitespace-pre-wrap border-t border-border/60 pt-4 text-sm leading-relaxed">
						{item.statement}
					</p>
				)}
			</div>
			{revealed ? (
				<div className="grid grid-cols-4 gap-2" role="group" aria-label="How well did you recall it?">
					{CARD_GRADES.map(({ grade, label, hint }) => (
						<button
							key={grade}
							type="button"
							data-testid={`review-grade-${grade}`}
							disabled={busy}
							onClick={() => onGrade(grade)}
							title={`${hint} (${grade})`}
							className="flex flex-col items-center rounded-md border border-border px-2 py-2 text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
						>
							<span className="font-medium">{label}</span>
							<span className="text-[10px] text-muted-foreground">{grade}</span>
						</button>
					))}
				</div>
			) : (
				<button
					type="button"
					data-testid="review-reveal"
					onClick={onReveal}
					className="rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
				>
					Show answer <span className="text-xs text-muted-foreground">(Space)</span>
				</button>
			)}
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

export function ReviewCards({ items, onExit }: { items: readonly ReviewItem[]; onExit: () => void }) {
	const [deck] = useState(() => [...items]);
	const [index, setIndex] = useState(0);
	const [revealed, setRevealed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const session = useRef(`cards-${Date.now()}`).current;
	const card = deck[index];

	const grade = useCallback(async (value: CardGrade) => {
		if (!card || busy) return;
		setBusy(true);
		setError(null);
		try {
			await postCardGrade(card.id, value, session);
			setIndex((i) => i + 1);
			setRevealed(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [busy, card, session]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
			if (event.key === "Escape") { onExit(); return; }
			if (!card) return;
			if (!revealed && (event.key === " " || event.key === "Enter")) {
				event.preventDefault();
				setRevealed(true);
			} else if (revealed && /^[1-4]$/.test(event.key)) {
				event.preventDefault();
				void grade(Number(event.key) as CardGrade);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [card, revealed, grade, onExit]);

	if (!card) {
		return (
			<div data-testid="review-cards-done" className="flex flex-col items-start gap-4">
				<p className="text-sm">Done. {deck.length} {deck.length === 1 ? "card" : "cards"} reviewed; each one is rescheduled by how well you recalled it.</p>
				<button type="button" onClick={onExit} className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground">
					Back to Review
				</button>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<button type="button" onClick={onExit} className="self-start text-xs text-muted-foreground hover:text-foreground">
				← Back to Review (Esc)
			</button>
			<CardFace
				item={card}
				position={index + 1}
				total={deck.length}
				revealed={revealed}
				busy={busy}
				error={error}
				onReveal={() => setRevealed(true)}
				onGrade={(value) => void grade(value)}
			/>
		</div>
	);
}
