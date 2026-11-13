/**
 * Gemini dictation (music-study fork).
 *   GET  → { configured } — whether a Google key (GEMINI_API_KEY) is set.
 *   POST <audio/wav body> → { text, model, seconds } — transcribes the
 *        recording with the official Gemini API. The optional
 *        `x-lh-dictation-language` header carries the dictation language.
 * See src/server/gemini-stt.ts.
 */
import { GeminiSttError, geminiConfigured, transcribeWithGemini } from "@/src/server";

export const dynamic = "force-dynamic";
/** 30 minutes of 16 kHz mono PCM is ≈ 58 MB. */
const MAX_BYTES = 64 * 1024 * 1024;

export async function GET() {
	return Response.json({ configured: geminiConfigured() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_BYTES) return Response.json({ error: "Recording is too long for one transcription (30 minutes max)" }, { status: 413 });
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await request.arrayBuffer());
	} catch {
		return Response.json({ error: "Could not read the recording" }, { status: 400 });
	}
	if (bytes.byteLength > MAX_BYTES) return Response.json({ error: "Recording is too long for one transcription (30 minutes max)" }, { status: 413 });
	const language = request.headers.get("x-lh-dictation-language")?.slice(0, 32) || undefined;
	try {
		const result = await transcribeWithGemini(bytes, { language, signal: request.signal });
		return Response.json(result);
	} catch (error) {
		if (error instanceof GeminiSttError) return Response.json({ error: error.message }, { status: error.status });
		return Response.json({ error: `Gemini transcription failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 });
	}
}
