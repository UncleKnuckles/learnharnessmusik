/**
 * Music-study fork: flashcards, new cards and the daily reminder on top of
 * MasteryHarness's FSRS-6 Review.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldReviews, freshNodeIds, gradeOf } from "../src/core/review.ts";
import type { ReviewEvent } from "../src/core/review-events.ts";
import { cardEvent, flashcardsPluginDue, readCardEvents } from "../src/server/review-cards.ts";

const require = (await import("node:module")).createRequire(import.meta.url);
const { shouldNotify, localDayKey, reminderText } = require("../electron/review-reminder.cjs") as {
	shouldNotify: (status: unknown, now: Date, last: string | null) => boolean;
	localDayKey: (d: Date) => string;
	reminderText: (due: number) => { title: string; body: string };
};

const DAY = 86_400_000;
const T0 = new Date(2026, 10, 1, 12).getTime();

function card(nodeId: string, at: number, grade: 1 | 2 | 3 | 4, session = "cards-a"): ReviewEvent {
	return cardEvent({ nodeId, at, grade, session });
}

describe("flashcard grades", () => {
	it("use the learner's grade as given, Easy included", () => {
		assert.equal(gradeOf(card("n1", T0, 4)), 4);
		assert.equal(gradeOf(card("n1", T0, 1)), 1);
	});
	it("schedule an idea: Easy pushes it further out than Again", () => {
		const live = new Set(["easy", "again"]);
		const [first, second] = foldReviews([card("easy", T0, 4), card("again", T0, 1)], live);
		assert.equal(first!.nodeId, "again");
		assert.equal(second!.nodeId, "easy");
		assert.ok(second!.dueAt - T0 > 2 * DAY);
	});
	it("fold with practice events in time order", () => {
		const practice: ReviewEvent = { nodeId: "n1", at: T0, outcome: "solved", rung: null, missClass: null, session: "chat1" };
		const [review] = foldReviews([card("n1", T0 + 5 * DAY, 3), practice], new Set(["n1"]));
		assert.equal(review!.reps, 2);
	});
});

describe("new cards", () => {
	it("offer ideas without evidence, in graph order, up to the daily allowance", () => {
		assert.deepEqual(freshNodeIds(["a", "b", "c", "d"], [card("b", T0 - 3 * DAY, 3)], T0, 2), ["a", "c"]);
	});
	it("count ideas first graded today against the allowance", () => {
		assert.deepEqual(freshNodeIds(["a", "b", "c"], [card("a", T0 - 60_000, 3)], T0, 2), ["b"]);
		assert.deepEqual(freshNodeIds(["a", "b", "c"], [card("a", T0 - 60_000, 3), card("b", T0 - 30_000, 3)], T0, 2), []);
	});
});

describe("card storage", () => {
	it("reads valid lines and skips torn or malformed ones", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cards-"));
		const file = path.join(dir, "cards.jsonl");
		fs.writeFileSync(file, [
			JSON.stringify({ nodeId: "n1", at: T0, grade: 3, session: "cards-1" }),
			JSON.stringify({ nodeId: "n2", at: T0, grade: 7, session: "cards-1" }),
			"{\"nodeId\":\"n3\",",
		].join("\n"));
		const events = readCardEvents(file);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.selfGrade, 3);
		assert.deepEqual(readCardEvents(path.join(dir, "missing.jsonl")), []);
	});
});

describe("Flashcards plugin due count", () => {
	it("counts studied cards that are ready, skips new and deleted ones, and survives a missing file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fc-"));
		const file = path.join(dir, "flashcards.json");
		const now = new Date(2026, 10, 13, 10).getTime();
		fs.writeFileSync(file, JSON.stringify({
			settings: { dayStart: 4 },
			propositions: {
				a: { cues: [{}], schedule: { state: 2, dueDay: "2026-11-13", due: now + DAY } },
				b: { cues: [{}], schedule: { state: 2, dueDay: "2026-11-14", due: now } },
				c: { cues: [{}], schedule: { state: 1, due: now - 60_000 } },
				d: { cues: [{}], schedule: { state: 0, due: now - DAY } },
				e: { cues: [{ deleted: true }], schedule: { state: 1, due: now - DAY } },
			},
		}));
		assert.equal(flashcardsPluginDue(now, file), 2);
		assert.equal(flashcardsPluginDue(now, path.join(dir, "missing.json")), 0);
	});
});

describe("daily reminder", () => {
	const morning = new Date(2026, 10, 13, 10);
	it("notifies once a day, from the chosen hour, when something is due", () => {
		assert.equal(shouldNotify({ enabled: true, hour: 9, due: 3 }, morning, null), true);
		assert.equal(shouldNotify({ enabled: true, hour: 9, due: 3 }, morning, localDayKey(morning)), false);
		assert.equal(shouldNotify({ enabled: true, hour: 11, due: 3 }, morning, null), false);
		assert.equal(shouldNotify({ enabled: true, hour: 9, due: 0 }, morning, null), false);
		assert.equal(shouldNotify({ enabled: false, hour: 9, due: 3 }, morning, null), false);
	});
	it("says how many ideas are due", () => {
		assert.match(reminderText(1).body, /^1 item is due/);
		assert.match(reminderText(5).body, /^5 items are due/);
	});
});
