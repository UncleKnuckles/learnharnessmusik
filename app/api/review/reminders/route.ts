/**
 * GET/PUT /api/review/reminders — the daily review reminder (music-study
 * fork). GET also reports what is due (Review ideas plus Flashcards plugin
 * cards), so the desktop shell can decide on a notification with one request.
 */
import { flashcardsPluginDue, readReminderSettings, reviewView, writeReminderSettings } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const payload = reviewView();
	const flashcards = flashcardsPluginDue();
	return Response.json({ ...readReminderSettings(), due: payload.due.length + flashcards, reviewDue: payload.due.length, flashcardsDue: flashcards, fresh: payload.fresh.length });
}

export async function PUT(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const settings = writeReminderSettings((body ?? {}) as Record<string, unknown>);
	return Response.json(settings);
}
