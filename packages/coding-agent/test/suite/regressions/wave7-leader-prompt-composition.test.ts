/**
 * Wave-7 audit: leader prompt composition vs Magnitude alpha22.
 *
 * Read-only behavioral checks. Uses no real provider, no ~/.piki access.
 * Asserts the rendered leader body resolves all template placeholders and
 * documents (via explicit expectations) where piki diverges from mag's
 * actual composition.
 */

import { describe, expect, it } from "vitest";
import { renderLeaderSystemPrompt } from "../../../../roles/src/prompts/shared/worker-base.ts";

function renderLeader(): string {
	return renderLeaderSystemPrompt({ skills: "## Available skills\n(none)" });
}

describe("leader system prompt composition", () => {
	it("resolves all template placeholders (no literal {{...}} tokens leak)", () => {
		const out = renderLeader();
		expect(out).not.toContain("{{CHECKPOINT_SECTION}}");
		expect(out).not.toContain("{{THINKING_LIMIT}}");
		expect(out).not.toContain("{{THINKING_SHARED}}");
		expect(out).not.toContain("{{SKILLS_SECTION}}");
		expect(out).not.toContain("{{AGENT_COMMON}}");
		expect(out).not.toContain("{{WORKER_BASE}}");
	});

	it("applies the default 20000-char thinking backstop", () => {
		const out = renderLeader();
		expect(out).toContain("strictly limited to 20000 characters");
	});

	it("fragment-count wording diverges from mag's literal 'N fragments where N is ... (7)'", () => {
		// mag's leader text literally reads:
		//   "Your thinking block is limited to N fragments where N is the
		//    total number of available fragements (7) ..."
		// (the 'N' is never substituted in mag — a known mag quirk).
		// piki rewords it to a hardcoded count. The COUNT must stay 7 to
		// match mag's stated 7; the wording is an editorial divergence.
		const out = renderLeader();
		expect(out).toContain("limited to 7 fragments");
		// piki no longer carries mag's quirky 'N fragments where N is' phrasing.
		expect(out).not.toContain("N fragments where N is the total number");
	});

	it("skills section instructs activation via the skill tool (mag-parity markdown)", () => {
		// mag injects: "## Available skills\n\n... - **name** (`key`) — desc"
		// and instructs activation via the `skill` tool, e.g.
		// "They can be "activated" with your skill tool."
		// piki matches mag: the leader body renders markdown and refers to the
		// `skill` tool (not the read tool). The injected `skills` content below
		// is echoed verbatim into the prompt; the assertion verifies piki's own
		// wording matches mag.
		const out = renderLeaderSystemPrompt({
			skills: "<available_skills>\n  <skill>\n    <name>foo</name>\n  </skill>\n</available_skills>",
		});
		expect(out).toContain("<available_skills>");
		// piki matches mag: the leader body instructs activation via the `skill`
		// tool (quoted "activated" with your skill tool), in mag-parity markdown.
		expect(out).toContain(`"activated" with your skill tool`);
	});
});
