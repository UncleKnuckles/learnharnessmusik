import { nodeTranslationsView } from "@/src/server";

/**
 * Russian node names and statements (music-study fork): returns the saved
 * entries and starts a background translation run when nodes are waiting.
 * See src/server/graph-translations.ts.
 */
export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(nodeTranslationsView(), { headers: { "Cache-Control": "no-store" } });
}
