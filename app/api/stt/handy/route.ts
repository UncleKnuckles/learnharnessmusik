/**
 * Handy dictation control (keyless alternative to Deepgram).
 *   GET  → { installed } — whether a Handy binary was found on this machine.
 *   POST { action: "toggle" | "cancel" } → forwards the matching CLI flag to
 *        the running Handy instance, which pastes its transcript into the
 *        focused field. See src/server/handy.ts.
 */
import { HandyNotFoundError, handyStatus, runHandy, type HandyAction } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(handyStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	let action: unknown;
	try {
		action = ((await request.json()) as { action?: unknown }).action;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (action !== "toggle" && action !== "cancel") {
		return Response.json({ error: 'action must be "toggle" or "cancel"' }, { status: 400 });
	}
	try {
		await runHandy(action as HandyAction);
		return Response.json({ ok: true });
	} catch (error) {
		if (error instanceof HandyNotFoundError) return Response.json({ error: error.message }, { status: 404 });
		return Response.json({ error: `Handy did not start: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 });
	}
}
