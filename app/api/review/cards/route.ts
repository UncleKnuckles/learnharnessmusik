/**
 * POST /api/review/cards — record one flashcard self-grade (music-study
 * fork). Body: { nodeId, grade: 1|2|3|4, session? }. The grade joins the
 * practice evidence on the next GET /api/review.
 */
import { CardGradeError, recordCardGrade } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	try {
		const line = recordCardGrade((body ?? {}) as Record<string, unknown>);
		return Response.json({ ok: true, at: line.at, session: line.session });
	} catch (err) {
		if (err instanceof CardGradeError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}
