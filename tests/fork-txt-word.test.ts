/**
 * Music-study fork: text files in any common encoding, and Word documents
 * (.docx, .doc, .rtf) as Markdown — for graph import, lesson materials, the
 * agent's read tool and the plugins' document converter.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeCodePage, decodeTextBytes } from "../src/core/text-decode.ts";
import { docxToMarkdown, rtfToText, WORD_FILE, WordError, wordRefusal, wordToMarkdown } from "../src/agent/subagents/word-markdown.ts";
import { createPluginDocumentConverter } from "../src/server/plugin-documents.ts";
import { createReadTool } from "../src/agent/tools/read.ts";
import { materialKindFor, materialBlock, MATERIAL_ACCEPT } from "../src/core/materials.ts";
import { IMPORT_ACCEPT, IMPORT_EXTENSIONS } from "../lib/notes-import-limits.ts";
import { translateText } from "../components/i18n/ru.ts";
import { docx, p } from "./helpers/docx.ts";

const SAMPLE_DOC = path.join(import.meta.dirname, "fixtures", "word", "sample.doc");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-txt-word-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cp1251 = (text: string) => new Uint8Array([...text].map((ch) => {
	const code = ch.charCodeAt(0);
	if (code < 0x80) return code;
	if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
	if (ch === "ё") return 0xb8;
	if (ch === "Ё") return 0xa8;
	throw new Error(`not in the test table: ${ch}`);
}));

describe("text in any common encoding", () => {
	const text = "Период (Periode): Vordersatz и Nachsatz — ёлка";

	it("reads UTF-8 with and without a mark", () => {
		assert.deepEqual(decodeTextBytes(Buffer.from(text)), { text, encoding: "utf-8" });
		assert.deepEqual(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text)])), { text, encoding: "utf-8" });
	});

	it("reads Notepad's UTF-16 (both byte orders) and UTF-16 without a mark", () => {
		const le = Buffer.from(text, "utf16le");
		const be = Buffer.from(le).swap16();
		assert.deepEqual(decodeTextBytes(new Uint8Array([0xff, 0xfe, ...le])), { text, encoding: "utf-16le" });
		assert.deepEqual(decodeTextBytes(new Uint8Array([0xfe, 0xff, ...be])), { text, encoding: "utf-16be" });
		const latin = "Satz und Periode, Takt 1-8";
		assert.deepEqual(decodeTextBytes(Buffer.from(latin, "utf16le")), { text: latin, encoding: "utf-16le" });
		assert.deepEqual(decodeTextBytes(Buffer.from(latin, "utf16le").swap16()), { text: latin, encoding: "utf-16be" });
	});

	it("reads Russian Windows-1251 and German Windows-1252", () => {
		assert.deepEqual(decodeTextBytes(cp1251("Период из двух предложений. Ёлка.")), { text: "Период из двух предложений. Ёлка.", encoding: "windows-1251" });
		const german = new Uint8Array([...Buffer.from("Die Periode hat zw", "latin1"), 0xf6, ...Buffer.from("lf Takte, Gr", "latin1"), 0xfc, 0xdf, 0x65]);
		assert.deepEqual(decodeTextBytes(german), { text: "Die Periode hat zwölf Takte, Grüße", encoding: "windows-1252" });
		const short = new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x20, 0x61, 0x75, 0x73, 0x20, 0x4b, 0xf6, 0x6c, 0x6e]);
		assert.deepEqual(decodeTextBytes(short), { text: "Grüße aus Köln", encoding: "windows-1252" }, "a few umlauts are not Cyrillic");
		assert.deepEqual(decodeTextBytes(cp1251("Период (Periode), Satz")), { text: "Период (Periode), Satz", encoding: "windows-1251" });
	});

	it("its code page tables match the platform's decoder byte for byte", { skip: !hasCodePages() }, () => {
		const all = new Uint8Array(256).map((_, i) => i);
		for (const encoding of ["windows-1251", "windows-1252"] as const) {
			assert.equal(decodeCodePage(all, encoding), new TextDecoder(encoding).decode(all), encoding);
		}
	});

	it("still refuses binary bytes", () => {
		const bytes = new Uint8Array(8193).fill(0x61);
		bytes[100] = 0;
		assert.equal(decodeTextBytes(bytes), null);
		assert.equal(decodeTextBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), null);
	});
});

function hasCodePages(): boolean {
	try { new TextDecoder("windows-1251"); return true; } catch { return false; }
}

describe("a .docx as Markdown", () => {
	it("keeps headings (style name, outline level), bold and italic, and merges runs", () => {
		const out = docxToMarkdown(docx({
			body: [
				p(["Форма ", ["и", "b"], " жанр"], { style: "1" }),
				p(["Satz"], { style: "Heading2" }),
				p(["Deep section"], { style: "Custom" }),
				p(["The ", ["Vorder", "b"], ["satz", "b"], " opens; the ", ["Nachsatz ", "i"], "closes. ", ["Both", "bi"], "."]),
			].join(""),
		}));
		assert.equal(out.markdown, "# Форма и жанр\n\n## Satz\n\n### Deep section\n\nThe **Vordersatz** opens; the *Nachsatz* closes. ***Both***.");
		assert.equal(out.format, "docx");
	});

	it("writes bullet and numbered lists with their levels, from the paragraph or its style", () => {
		const out = docxToMarkdown(docx({
			body: [
				p(["Tonika"], { numId: 1 }),
				p(["T6"], { numId: 1, ilvl: 1 }),
				p(["Dominante"], { style: "ListBullet" }),
				p(["Erster Schritt"], { numId: 2 }),
				p(["Zweiter Schritt"], { numId: 2 }),
				p(["wörtlich"], { numId: 1, ilvl: 1 }),
				p(["Dritter Schritt"], { numId: 2 }),
				p(["After."]),
			].join(""),
		}));
		assert.equal(out.markdown, "- Tonika\n    - T6\n- Dominante\n\n1. Erster Schritt\n1. Zweiter Schritt\n    - wörtlich\n1. Dritter Schritt\n\nAfter.");
	});

	it("writes formulas as linear text", () => {
		const math = "<m:oMath><m:sSup><m:e><m:r><m:t>a</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>+</m:t></m:r><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>n+1</m:t></m:r></m:den></m:f></m:oMath>";
		assert.equal(docxToMarkdown(docx({ body: `<w:p><w:r><w:t xml:space="preserve">Formel: </w:t></w:r>${math}</w:p>` })).markdown, "Formel: $a^2+1/(n+1)$");
	});

	it("writes tables, with merged cells and escaped pipes; a one-cell table reads as text", () => {
		const cell = (text: string, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${p([text])}</w:tc>`;
		const out = docxToMarkdown(docx({
			body: `<w:tbl><w:tr>${cell("Функция")}${cell("Символ")}${cell("Ступень")}</w:tr>`
				+ `<w:tr>${cell("Доминанта | V", '<w:gridSpan w:val="2"/>')}${cell("V")}</w:tr></w:tbl>`
				+ `<w:tbl><w:tr>${cell("A boxed note.")}</w:tr></w:tbl>`,
		}));
		assert.equal(out.markdown, "| Функция | Символ | Ступень |\n| --- | --- | --- |\n| Доминанта \\| V |  | V |\n\nA boxed note.");
	});

	it("keeps links, footnotes and text boxes; marks pictures; skips the table of contents, deletions and hidden text", () => {
		const out = docxToMarkdown(docx({
			rels: '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/satz" TargetMode="External"/>',
			body: [
				p(["Contents 1"], { style: "TOC1" }),
				'<w:p><w:r><w:t>See </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>the Satz page</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>',
				'<w:p><w:r><w:t>Kept</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r><w:ins><w:r><w:t> and inserted</w:t></w:r></w:ins></w:p>',
				'<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Beethoven, op. 2 no. 1, bars 1-8"/></wp:inline></w:drawing></w:r></w:p>',
				'<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>Text in a box</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Text in a box</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>',
			].join(""),
			footnotes: '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Ratz, Einführung.</w:t></w:r></w:p></w:footnote>',
		}));
		assert.equal(out.markdown, "See [the Satz page](https://example.org/satz).[^2]\n\nKept and inserted\n\n[figure: Beethoven, op. 2 no. 1, bars 1-8]\n\nText in a box\n\n[^2]: Ratz, Einführung.");
		assert.equal(out.figures, 1);
	});

	it("reads a document with no styles part", () => {
		assert.equal(docxToMarkdown(docx({ bare: true, body: p(["Plain"]) })).markdown, "Plain");
	});

	it("refuses broken, empty, oversized and password-protected files with a reason", async () => {
		const reason = (r: WordError["reason"]) => (e: unknown) => e instanceof WordError && e.reason === r;
		assert.throws(() => docxToMarkdown(new TextEncoder().encode("PK\u0003\u0004 nope")), reason("unreadable"));
		assert.throws(() => docxToMarkdown(docx({ body: p([" "]) })), reason("empty"));
		assert.throws(() => docxToMarkdown(docx({ body: p(["x".repeat(5000)]) }), 1000), reason("too-large"));
		const encrypted = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Buffer.from("EncryptedPackage", "utf16le")]);
		await assert.rejects(wordToMarkdown(encrypted), reason("encrypted"));
		assert.equal(wordRefusal(new WordError("encrypted", "x")), "This Word document is password-protected. Save it without a password and try again.");
		assert.equal(wordRefusal(new Error("x"), "a.doc"), "a.doc is not a readable Word document.");
	});
});

describe("an old .doc and RTF", () => {
	it("reads a Word 97–2003 .doc paragraph by paragraph, dashes intact", async () => {
		const out = await wordToMarkdown(new Uint8Array(fs.readFileSync(SAMPLE_DOC)));
		assert.equal(out.format, "doc");
		assert.match(out.markdown, /^Период\n\nПериод — это законченное построение из двух предложений\.\n\nSatz und Periode\n\nVordersatz\n\n/);
		assert.match(out.markdown, /Конец\.$/);
	});

	it("reads RTF in a Cyrillic code page, by \\ansicpg or by the font's \\fcharset, and \\u escapes", () => {
		const rtf = (body: string) => new TextEncoder().encode(body);
		assert.equal(rtfToText(rtf("{\\rtf1\\ansi\\ansicpg1251{\\fonttbl{\\f0\\fnil Times;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Writer;}\\f0 \\'cf\\'e5\\'f0\\'e8\\'ee\\'e4\\par Satz}")), "Период\n\nSatz");
		assert.equal(rtfToText(rtf("{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\froman\\fcharset204 Times;}{\\f1\\fswiss\\fcharset0 Arial;}}\\f0\\'d2\\'ee\\'ed\\'e8\\'ea\\'e0 \\f1 Gr\\'fc\\'dfe\\par}")), "Тоника Grüße");
		assert.equal(rtfToText(rtf("{\\rtf1\\uc1 \\u1044?\\u1086?\\u1084? D7{\\*\\fldinst HYPERLINK x}{\\fldrslt link}\\par}")), "Дом D7link");
		assert.equal(rtfToText(rtf("{\\rtf1 {\\pict\\pngblip 89504e47}\\trowd A\\cell B\\cell\\row {\\listtext\\'b7\\tab}Item\\par}")), "A | B\n\n- Item");
	});

	it("takes RTF, plain text and web pages saved under a .doc name", async () => {
		assert.deepEqual(await wordToMarkdown(new TextEncoder().encode("{\\rtf1 Hello\\par}")), { markdown: "Hello", format: "rtf", figures: 0 });
		assert.equal((await wordToMarkdown(cp1251("Каденция"))).markdown, "Каденция");
		assert.equal((await wordToMarkdown(new TextEncoder().encode("<html><body><p>Kadenz</p></body></html>"))).markdown, "Kadenz");
	});
});

describe("where the app reads files", () => {
	it("graph import and lesson materials accept Word files", () => {
		for (const name of ["a.docx", "b.DOC", "c.rtf", "d.docm"]) {
			assert.ok(IMPORT_EXTENSIONS.test(name), name);
			assert.ok(WORD_FILE.test(name), name);
			assert.equal(materialKindFor(name), "word", name);
		}
		assert.equal(materialKindFor("blob", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "word");
		for (const ext of [".docx", ".doc", ".rtf"]) {
			assert.ok(IMPORT_ACCEPT.split(",").includes(ext));
			assert.ok(MATERIAL_ACCEPT.split(",").includes(ext));
		}
		assert.match(materialBlock({ id: "m", kind: "word", name: "a.docx", file: "source.md", bytes: 1, addedAt: "", status: "reading" }, "/x"), /kind="Word document \(converted to Markdown; pictures omitted\)"/);
	});

	it("the agent's read tool reads a .docx as Markdown and a Windows-1251 .txt as text", async () => {
		const word = path.join(tmp, "Formenlehre.docx");
		fs.writeFileSync(word, docx({ body: p(["Satz"], { style: "1" }) + p(["Vordersatz und Nachsatz."]) }));
		const ansi = path.join(tmp, "notes.txt");
		fs.writeFileSync(ansi, cp1251("Период и предложение"));
		const read = createReadTool();
		const text = async (file: string) => ((await read.execute("c1", { path: file })) as { content: { text: string }[] }).content.map((c) => c.text).join("");
		assert.equal(await text(word), "# Satz\n\nVordersatz und Nachsatz.");
		assert.equal(await text(ansi), "Период и предложение");
		const broken = path.join(tmp, "broken.docx");
		fs.writeFileSync(broken, "PK\u0003\u0004 nope");
		await assert.rejects(read.execute("c2", { path: broken }), /is not a readable Word document/);
	});

	it("the plugins' document converter takes Word files and non-UTF-8 text", async () => {
		const service = createPluginDocumentConverter();
		const upload = (content: Uint8Array, name: string) => {
			const form = new FormData();
			form.append("file", new File([content as Uint8Array<ArrayBuffer>], name));
			return new Request("http://plugin.local/documents", { method: "POST", body: form });
		};
		const signal = new AbortController().signal;
		const word = await service.convert(upload(docx({ body: p(["Satz"], { style: "1" }) }), "satz.docx"), signal);
		assert.deepEqual(word, { name: "satz.docx", markdown: "# Satz", notices: [] });
		const ansi = await service.convert(upload(cp1251("Период"), "notes.txt"), signal);
		assert.deepEqual(ansi, { name: "notes.txt", markdown: "Период", notices: ["Read as windows-1251 text."] });
		await assert.rejects(service.convert(upload(new TextEncoder().encode("PK\u0003\u0004 nope"), "broken.docx"), signal), /not a readable Word document/);
	});

	it("the Russian interface translates the new messages", () => {
		assert.equal(translateText("notes.docx: This is not a readable Word document."), "notes.docx: Этот файл не удалось прочитать как документ Word.");
		assert.equal(translateText("Skipped 2 files that aren't text, Markdown, Word, PDF, images, or audio (.xlsx, no extension)."), "Пропущено файлов: 2 — это не текст, Markdown, Word, PDF, изображения или аудио (.xlsx, без расширения).");
		assert.equal(translateText("Pictures left out: 3. Only the text was read."), "Картинки пропущены (3). Прочитан только текст.");
		assert.equal(translateText("PDF, EPUB, Word, text, Markdown, images, or a web link"), "PDF, EPUB, Word, текст, Markdown, изображения или ссылка");
		assert.equal(translateText("notes.md: something unknown"), "notes.md: something unknown");
	});
});
