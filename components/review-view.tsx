"use client";

/**
 * THE REVIEW PAGE (docs/review-plan.md §4.4): the propositions whose
 * recall is due, folded by FSRS-6 on the server. The learner picks which
 * to review (default: the most overdue, up to the session size) and Start
 * review opens an ordinary PRACTICE session seeded with them — no new
 * question type; its conclude calls become the next review events. The
 * body is pure (props in, markup out) so the render suite pins it
 * statically.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { startDraftSession } from "@/components/new-session";
import { ReviewCards } from "@/components/review-cards";
import { useReviewPayload } from "@/components/review-payload-hook";
import { TopBar } from "@/components/top-bar";
import { NEW_CARDS_PER_DAY, REVIEW_SESSION_MAX, type ReviewItem, type ReviewPayload, type ReviewReminderSettings } from "@/src/core";

const buttonClass = "rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** The daily reminder row (music-study fork). Pure. */
export function ReminderRow({ settings, onChange }: { settings: ReviewReminderSettings; onChange: (next: Partial<ReviewReminderSettings>) => void }) {
	return (
		<section aria-label="Reminder" data-testid="review-reminder" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<label className="flex items-center gap-2">
				<input
					type="checkbox"
					checked={settings.enabled}
					onChange={(event) => onChange({ enabled: event.target.checked })}
					className="size-3.5 accent-foreground"
				/>
				Remind me daily when something is due, from
			</label>
			<select
				aria-label="Reminder hour"
				value={settings.hour}
				disabled={!settings.enabled}
				onChange={(event) => onChange({ hour: Number(event.target.value) })}
				className="rounded border border-border bg-transparent px-1 py-0.5 disabled:opacity-50"
			>
				{Array.from({ length: 24 }, (_, hour) => (
					<option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
				))}
			</select>
			<span>(a system notification from the desktop app)</span>
		</section>
	);
}

const DAY = 86_400_000;

/** "overdue 3d" / "due today" / "in 5d" — day granularity, measured
 *  against the SERVER clock the payload carries. */
export function formatDue(dueAt: number, now: number): string {
	const diff = dueAt - now;
	if (diff <= 0) {
		const days = Math.floor(-diff / DAY);
		return days === 0 ? "due today" : `overdue ${days}d`;
	}
	return `in ${Math.ceil(diff / DAY)}d`;
}

/** The session's title and first message (owner, 2026-10-23). */
export function reviewSessionText(items: readonly Pick<ReviewItem, "name">[]): string {
	return `Review: ${items.map((i) => i.name).join(", ")}`;
}

/** The default selection: the most overdue first, up to the session size. */
export function defaultSelection(payload: ReviewPayload): Set<string> {
	return new Set(payload.due.slice(0, payload.sessionSize).map((i) => i.id));
}

/** Toggle one id; adding past REVIEW_SESSION_MAX is refused (the server
 *  would silently drop the surplus). */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(selected);
	if (next.has(id)) next.delete(id);
	else if (next.size < REVIEW_SESSION_MAX) next.add(id);
	return next;
}

/** The learner's picks, kept to what is still due (a refresh can retire
 *  some); null = untouched, so the default selection applies. */
export function effectiveSelection(payload: ReviewPayload | null, picked: ReadonlySet<string> | null): Set<string> {
	if (!payload) return new Set();
	if (picked === null) return defaultSelection(payload);
	const stillDue = new Set(payload.due.map((i) => i.id));
	return new Set(Array.from(picked).filter((id) => stillDue.has(id)));
}

function ItemRow({
	item,
	now,
	selection,
}: {
	item: ReviewItem;
	now: number;
	/** Present on due rows only; upcoming rows are not selectable. */
	selection?: { checked: boolean; onToggle: (id: string) => void };
}) {
	return (
		<li data-testid={`review-item-${item.id}`} className="flex items-start gap-3 py-2">
			{selection && (
				<input
					type="checkbox"
					checked={selection.checked}
					onChange={() => selection.onToggle(item.id)}
					aria-label={`Review ${item.name}`}
					className="mt-1 size-3.5 shrink-0 accent-foreground"
				/>
			)}
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm">{item.name}</p>
				<p className="line-clamp-2 text-xs text-muted-foreground">{item.statement}</p>
			</div>
			<span className="shrink-0 text-xs text-muted-foreground">
				{item.verifying && (
					<span data-testid={`review-verifying-${item.id}`} className="mr-2 text-foreground">
						re-check
					</span>
				)}
				{formatDue(item.dueAt, now)}
			</span>
		</li>
	);
}

/** The pure body. */
export function ReviewBody({
	payload,
	selected,
	busy,
	onToggle,
	onStart,
	onCards,
	reminder,
	onReminderChange,
	flashcardsDue = 0,
}: {
	payload: ReviewPayload | null;
	selected: ReadonlySet<string>;
	busy: boolean;
	onToggle: (id: string) => void;
	onStart: () => void;
	/** Recall cards (music-study fork): open a self-graded card run over these items. */
	onCards?: (items: ReviewItem[]) => void;
	reminder?: ReviewReminderSettings | null;
	onReminderChange?: (next: Partial<ReviewReminderSettings>) => void;
	/** Cards the Flashcards core plugin has ready (its own FSRS schedule). */
	flashcardsDue?: number;
}) {
	if (payload === null) {
		return <p className="text-sm text-muted-foreground">Loading…</p>;
	}
	const { due, upcoming, now } = payload;
	const fresh = payload.fresh ?? [];
	const selectedDue = due.filter((item) => selected.has(item.id));
	return (
		<div data-testid="review-body" className="flex flex-col gap-8">
			<section aria-label="Due now">
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">Due now · {due.length}</h2>
					{due.length > 0 && (
						<div className="flex items-center gap-2">
							{onCards && (
								<button
									type="button"
									data-testid="review-cards"
									disabled={busy || selectedDue.length === 0}
									onClick={() => onCards(selectedDue)}
									className={buttonClass}
								>
									Recall cards ({selectedDue.length})
								</button>
							)}
							<button
								type="button"
								data-testid="review-start"
								disabled={busy || selected.size === 0}
								onClick={onStart}
								className={buttonClass}
							>
								Start review ({selected.size})
							</button>
						</div>
					)}
				</div>
				{due.length === 0 ? (
					<p data-testid="review-empty" className="mt-3 text-sm text-muted-foreground">
						Nothing is due. Ideas you practice or learn as recall cards return here when recall is due.
					</p>
				) : (
					<ul className="mt-2 divide-y divide-border/50">
						{due.map((item) => (
							<ItemRow key={item.id} item={item} now={now} selection={{ checked: selected.has(item.id), onToggle }} />
						))}
					</ul>
				)}
			</section>
			{fresh.length > 0 && (
				<section aria-label="New cards">
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">New ideas today · {fresh.length}</h2>
						{onCards && (
							<button type="button" data-testid="review-learn-new" disabled={busy} onClick={() => onCards(fresh)} className={buttonClass}>
								Learn as recall cards
							</button>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">Up to {NEW_CARDS_PER_DAY} ideas a day from your graph that you have not reviewed yet.</p>
					<ul className="mt-2 divide-y divide-border/50">
						{fresh.map((item) => (
							<li key={item.id} data-testid={`review-new-${item.id}`} className="py-2">
								<p className="truncate text-sm">{item.name}</p>
								<p className="line-clamp-2 text-xs text-muted-foreground">{item.statement}</p>
							</li>
						))}
					</ul>
				</section>
			)}
			{upcoming.length > 0 && (
				<section aria-label="Upcoming">
					<h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">Upcoming · {upcoming.length}</h2>
					<ul className="mt-2 divide-y divide-border/50">
						{upcoming.map((item) => (
							<ItemRow key={item.id} item={item} now={now} />
						))}
					</ul>
				</section>
			)}
			{flashcardsDue > 0 && (
				<p data-testid="review-flashcards-plugin" className="text-xs text-muted-foreground">
					{flashcardsDue === 1 ? "1 card is" : `${flashcardsDue} cards are`} also ready in the Flashcards plugin (sidebar).
				</p>
			)}
			{reminder && onReminderChange && <ReminderRow settings={reminder} onChange={onReminderChange} />}
		</div>
	);
}

/** The reminder setting, read once and written through (music-study fork). */
function useReminderSettings(): [ReviewReminderSettings | null, (next: Partial<ReviewReminderSettings>) => void, number] {
	const [settings, setSettings] = useState<ReviewReminderSettings | null>(null);
	const [flashcardsDue, setFlashcardsDue] = useState(0);
	useEffect(() => {
		let live = true;
		fetch("/api/review/reminders", { cache: "no-store" })
			.then((res) => (res.ok ? res.json() : null))
			.then((data: (ReviewReminderSettings & { flashcardsDue?: number }) | null) => {
				if (!live || !data) return;
				setSettings({ enabled: data.enabled, hour: data.hour });
				setFlashcardsDue(data.flashcardsDue ?? 0);
			})
			.catch(() => {});
		return () => { live = false; };
	}, []);
	const update = (next: Partial<ReviewReminderSettings>) => {
		setSettings((current) => (current ? { ...current, ...next } : current));
		void fetch("/api/review/reminders", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })
			.then((res) => (res.ok ? res.json() : null))
			.then((data: ReviewReminderSettings | null) => { if (data) setSettings(data); })
			.catch(() => {});
	};
	return [settings, update, flashcardsDue];
}

export function ReviewView() {
	const router = useRouter();
	const payload = useReviewPayload();
	const [picked, setPicked] = useState<Set<string> | null>(null);
	const [busy, setBusy] = useState(false);
	const [cards, setCards] = useState<ReviewItem[] | null>(null);
	const [reminder, setReminder, flashcardsDue] = useReminderSettings();
	const selected = effectiveSelection(payload, picked);

	const start = async () => {
		const picks = (payload?.due ?? [])
			.filter((i) => selected.has(i.id))
			.map(({ id, name, statement }) => ({ id, name, statement }));
		if (picks.length === 0) return;
		setBusy(true);
		try {
			const url = await startDraftSession(reviewSessionText(picks), fetch, "practice", picks);
			if (url) router.push(url);
			else setBusy(false);
		} catch {
			setBusy(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Review</span>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-2xl px-4 py-8">
					{cards ? (
						<ReviewCards items={cards} onExit={() => { setCards(null); setPicked(null); }} />
					) : (
						<ReviewBody
							payload={payload}
							selected={selected}
							busy={busy}
							onToggle={(id) => setPicked(toggleSelection(selected, id))}
							onStart={() => void start()}
							onCards={(items) => setCards(items)}
							reminder={reminder}
							onReminderChange={setReminder}
							flashcardsDue={flashcardsDue}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
