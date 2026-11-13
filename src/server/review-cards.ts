/**
 * Flashcards and reminders for spaced repetition (music-study fork).
 *
 * The Review page (core/review.ts) derives FSRS schedules from practice
 * sessions. Flashcards add a second evidence stream: the learner sees an
 * idea's name, recalls it, reveals the statement and grades themselves
 * (Again / Hard / Good / Easy). Each grade is one line in
 * data/review/cards.jsonl and joins the practice events on every read, so
 * the schedule stays derived and a deleted idea simply drops out.
 *
 * The daily reminder setting lives beside it in data/review/reminders.json;
 * the desktop shell reads it to decide when to show a system notification.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { getGraph } from "../core/graph.ts";
import type { ReviewEvent } from "../core/review-events.ts";
import { DEFAULT_REVIEW_REMINDER, type CardGrade, type ReviewReminderSettings } from "../core/review-payload.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { stores } from "./stores.ts";

const REVIEW_DIR = () => path.join(PATHS.data, "review");
const CARDS_FILE = () => path.join(REVIEW_DIR(), "cards.jsonl");
const REMINDERS_FILE = () => path.join(REVIEW_DIR(), "reminders.json");

export class CardGradeError extends Error {}

interface CardLine {
	nodeId: string;
	at: number;
	grade: CardGrade;
	session: string;
}

function isGrade(value: unknown): value is CardGrade {
	return value === 1 || value === 2 || value === 3 || value === 4;
}

/** A card grade as a review event; the outcome mirrors the grade for readers that ignore selfGrade. */
export function cardEvent(line: CardLine): ReviewEvent {
	return {
		nodeId: line.nodeId,
		at: line.at,
		outcome: line.grade === 1 ? "surrendered" : line.grade === 2 ? "solvedWithHints" : "solved",
		rung: null,
		missClass: null,
		session: line.session,
		selfGrade: line.grade,
	};
}

/** Every recorded flashcard grade, oldest first. Malformed lines are skipped. */
export function readCardEvents(file: string = CARDS_FILE()): ReviewEvent[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const events: ReviewEvent[] = [];
	for (const text of raw.split("\n")) {
		if (!text.trim()) continue;
		try {
			const line = JSON.parse(text) as Partial<CardLine>;
			if (typeof line.nodeId === "string" && typeof line.at === "number" && Number.isFinite(line.at)
				&& isGrade(line.grade) && typeof line.session === "string") {
				events.push(cardEvent(line as CardLine));
			}
		} catch {
			// a torn last line from a crash; the rest still counts
		}
	}
	return events;
}

/** Validate and append one flashcard grade. Throws CardGradeError on bad input. */
export function recordCardGrade(input: { nodeId?: unknown; grade?: unknown; session?: unknown }, now: number = Date.now()): CardLine {
	const { nodeId, grade, session } = input;
	if (typeof nodeId !== "string" || !nodeId) throw new CardGradeError("nodeId is required");
	if (!isGrade(grade)) throw new CardGradeError("grade must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy)");
	const sitting = typeof session === "string" && /^cards-[\w-]{1,64}$/.test(session) ? session : `cards-${now}`;
	if (!getGraph(stores.graphStore).nodes.some((node) => node.id === nodeId)) throw new CardGradeError("This idea is no longer in the graph.");
	const line: CardLine = { nodeId, at: now, grade, session: sitting };
	fs.mkdirSync(REVIEW_DIR(), { recursive: true });
	fs.appendFileSync(CARDS_FILE(), `${JSON.stringify(line)}\n`);
	return line;
}

/**
 * How many cards the Flashcards core plugin (upstream LearnHarness) has
 * ready for review now, read from its own record so the daily reminder can
 * mention them. New, never-studied cards are not counted. Any read or shape
 * problem counts as 0: the plugin owns that file and may change it.
 */
export function flashcardsPluginDue(now: number = Date.now(), file: string = path.join(PATHS.data, "core-plugin-data", "flashcards", "flashcards.json")): number {
	try {
		const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
			settings?: { dayStart?: number };
			propositions?: Record<string, { cues?: { deleted?: boolean }[]; schedule?: { state?: number; due?: number; dueDay?: string } }>;
		};
		const startHour = Number.isInteger(state.settings?.dayStart) ? state.settings!.dayStart! : 4;
		const start = new Date(now);
		if (start.getHours() < startHour) start.setDate(start.getDate() - 1);
		const pad = (n: number) => String(n).padStart(2, "0");
		const today = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
		let due = 0;
		for (const p of Object.values(state.propositions ?? {})) {
			const schedule = p?.schedule;
			if (!schedule || !schedule.state || !(p.cues ?? []).some((cue) => !cue.deleted)) continue;
			const ready = schedule.state === 2 && typeof schedule.dueDay === "string" ? today >= schedule.dueDay : typeof schedule.due === "number" && schedule.due <= now;
			if (ready) due++;
		}
		return due;
	} catch {
		return 0;
	}
}

export function readReminderSettings(file: string = REMINDERS_FILE()): ReviewReminderSettings {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReviewReminderSettings>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_REVIEW_REMINDER.enabled,
			hour: Number.isInteger(raw.hour) && raw.hour! >= 0 && raw.hour! <= 23 ? raw.hour! : DEFAULT_REVIEW_REMINDER.hour,
		};
	} catch {
		return { ...DEFAULT_REVIEW_REMINDER };
	}
}

export function writeReminderSettings(input: { enabled?: unknown; hour?: unknown }): ReviewReminderSettings {
	const current = readReminderSettings();
	const next: ReviewReminderSettings = {
		enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
		hour: Number.isInteger(input.hour) && (input.hour as number) >= 0 && (input.hour as number) <= 23 ? input.hour as number : current.hour,
	};
	fs.mkdirSync(REVIEW_DIR(), { recursive: true });
	writeFileAtomicSync(REMINDERS_FILE(), JSON.stringify(next, null, "\t"));
	return next;
}
