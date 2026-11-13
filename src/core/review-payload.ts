/**
 * THE REVIEW PAYLOAD (GET /api/review, docs/review-plan.md §4.4): the
 * browser-safe wire shape the Review page reads. Types + constants only —
 * the scheduler itself (core/review.ts, ts-fsrs) stays server-side.
 */

/** How many due propositions a review session carries by default (owner,
 *  2026-10-23); the page lets the learner adjust the selection. */
export const REVIEW_SESSION_SIZE = 8;

/** The most propositions one session can carry — mirrors the `.slice(0, 64)`
 *  on the picks in POST /api/chats, so the page never silently loses a pick. */
export const REVIEW_SESSION_MAX = 64;

/** Music-study fork: how many never-reviewed propositions the flashcards
 *  offer per day as new cards. */
export const NEW_CARDS_PER_DAY = 10;

/** Flashcard self-grades, FSRS order: Again, Hard, Good, Easy. */
export type CardGrade = 1 | 2 | 3 | 4;

/** Daily review reminder (music-study fork): the desktop app shows a system
 *  notification once a day, at or after `hour` local time, when anything is due. */
export interface ReviewReminderSettings {
	enabled: boolean;
	/** 0–23, local time. */
	hour: number;
}
export const DEFAULT_REVIEW_REMINDER: ReviewReminderSettings = { enabled: true, hour: 9 };

/** One proposition on the Review page. Times are epoch ms. */
export interface ReviewItem {
	id: string;
	name: string;
	statement: string;
	/** When recall probability is predicted to reach the target. */
	dueAt: number;
	/** Days for recall probability to fall to the target. */
	stability: number;
	reps: number;
	lapses: number;
	/** A first failure on a well-established node awaits a second look
	 *  (docs/review-plan.md §13): the page marks the row. */
	verifying: boolean;
}

export interface ReviewPayload {
	/** Server clock at derivation (epoch ms) — the page measures "overdue by"
	 *  against it, not its own clock. */
	now: number;
	/** dueAt ≤ now, most overdue first. */
	due: ReviewItem[];
	/** Not yet due, soonest first. */
	upcoming: ReviewItem[];
	/** Music-study fork: never-reviewed propositions offered as new
	 *  flashcards today (at most NEW_CARDS_PER_DAY, graph order). */
	fresh: ReviewItem[];
	/** The default selection size for "Start review". */
	sessionSize: number;
}
