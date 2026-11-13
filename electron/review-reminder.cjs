"use strict";

/**
 * Daily review reminder (music-study fork). While the desktop app runs, the
 * main process asks the local server every few minutes how many ideas are
 * due (GET /api/review/reminders) and, once per local day at or after the
 * chosen hour, shows a system notification. Clicking it opens the Review
 * page. The day of the last notification is kept in userData so a restart
 * does not repeat it.
 */

const fs = require("node:fs");
const path = require("node:path");

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** "2026-11-13" in local time. */
function localDayKey(date) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Pure decision: notify when enabled, something is due, the hour has come, and not yet today. */
function shouldNotify(status, now, lastNotifiedDay) {
	if (!status || status.enabled !== true) return false;
	if (!(Number(status.due) > 0)) return false;
	const hour = Number.isInteger(status.hour) ? status.hour : 9;
	if (now.getHours() < hour) return false;
	return lastNotifiedDay !== localDayKey(now);
}

function reminderText(due) {
	return {
		title: "Time to review",
		body: due === 1 ? "1 item is due for review in LearnHarness." : `${due} items are due for review in LearnHarness.`,
	};
}

function readState(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof raw?.lastNotifiedDay === "string" ? raw.lastNotifiedDay : null;
	} catch {
		return null;
	}
}

function writeState(file, day) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ lastNotifiedDay: day }));
	} catch { /* a lost marker only means one repeat notification */ }
}

/**
 * Start the reminder loop. `deps`: { url, secret, stateFile, Notification,
 * openReview, log, fetch? }. Returns a stop function.
 */
function startReviewReminders(deps) {
	const doFetch = deps.fetch ?? fetch;
	let stopped = false;
	const check = async () => {
		if (stopped || !deps.Notification?.isSupported?.()) return;
		try {
			const headers = deps.secret ? { "x-learnharness-desktop": deps.secret } : {};
			const res = await doFetch(new URL("/api/review/reminders", deps.url), { headers });
			if (!res.ok) return;
			const status = await res.json();
			const now = new Date();
			if (!shouldNotify(status, now, readState(deps.stateFile))) return;
			writeState(deps.stateFile, localDayKey(now));
			const notification = new deps.Notification(reminderText(Number(status.due)));
			notification.on("click", () => deps.openReview());
			notification.show();
			deps.log?.(`review reminder shown: ${status.due} due`);
		} catch (error) {
			deps.log?.(`review reminder check failed: ${error?.message ?? error}`);
		}
	};
	// Unref'd: the reminder never keeps the process alive on its own.
	const first = setTimeout(check, 30 * 1000);
	const timer = setInterval(check, CHECK_INTERVAL_MS);
	first.unref?.();
	timer.unref?.();
	return () => {
		stopped = true;
		clearTimeout(first);
		clearInterval(timer);
	};
}

module.exports = { shouldNotify, localDayKey, reminderText, startReviewReminders, CHECK_INTERVAL_MS };
