/** The parts of word-extractor (CommonJS, untyped) that word-markdown.ts uses. */
declare module "word-extractor" {
	interface TextOptions {
		filterUnicode?: boolean;
	}
	interface WordDocument {
		getBody(options?: TextOptions): string;
		getFootnotes(options?: TextOptions): string;
		getEndnotes(options?: TextOptions): string;
		getTextboxes(options?: TextOptions & { includeBody?: boolean; includeHeadersAndFooters?: boolean }): string;
	}
	class WordExtractor {
		extract(source: string | Buffer): Promise<WordDocument>;
	}
	export = WordExtractor;
}
