import { describe, expect, it } from "vitest";
import { parseSkillSections } from "../src/skills.ts";

// Regression coverage for the alpha22 skill-preamble parity gap:
// piki previously dropped text before the first `<!-- @... -->` marker.
// mag's `splitSections` folds that preamble into the "shared" section.
describe("parseSkillSections alpha22 parity", () => {
	it("folds preamble before first marker into shared (mag parity)", () => {
		const body = ["Intro text before any marker.", "<!-- @worker -->", "Worker-only content."].join("\n");
		const sections = parseSkillSections(body);
		expect(sections).toEqual([
			{ name: "shared", content: "Intro text before any marker." },
			{ name: "worker", content: "Worker-only content." },
		]);
	});

	it("joins preamble with an explicit shared marker via blank line", () => {
		const body = ["Preamble.", "<!-- @shared -->", "Explicit shared body."].join("\n");
		const sections = parseSkillSections(body);
		expect(sections).toEqual([{ name: "shared", content: "Preamble.\n\nExplicit shared body." }]);
	});

	it("returns single shared section when no markers present", () => {
		const body = "Just a plain skill body.";
		expect(parseSkillSections(body)).toEqual([{ name: "shared", content: "Just a plain skill body." }]);
	});

	it("drops empty preamble when body starts with a marker", () => {
		const body = ["<!-- @lead -->", "Lead content.", "<!-- @worker -->", "Worker content."].join("\n");
		expect(parseSkillSections(body)).toEqual([
			{ name: "lead", content: "Lead content." },
			{ name: "worker", content: "Worker content." },
		]);
	});

	it("supports all four mag section markers (shared/lead/worker/handoff)", () => {
		// mag MARKER_RE = /^<!--\s*@(shared|lead|worker|handoff)\s*-->$/
		const body = [
			"<!-- @shared -->",
			"Shared.",
			"<!-- @lead -->",
			"Lead.",
			"<!-- @worker -->",
			"Worker.",
			"<!-- @handoff -->",
			"Handoff.",
		].join("\n");
		const sections = parseSkillSections(body);
		expect(sections.map((s) => s.name)).toEqual(["shared", "lead", "worker", "handoff"]);
	});

	it("collapses consecutive same-name markers (mag joins with blank line)", () => {
		const body = ["<!-- @worker -->", "A.", "<!-- @worker -->", "B."].join("\n");
		const sections = parseSkillSections(body);
		expect(sections).toEqual([{ name: "worker", content: "A.\n\nB." }]);
	});
});
