/**
 * Public API for the operation-based streaming field parser.
 *
 * Combines the tokenizer, stack machine, handlers, field diff, and schema validation
 * into a single cohesive parser. Per-chunk rollback uses tokenizer, machine, and
 * field differ snapshots taken before each chunk.
 */

import { type FieldDiffEvent, FieldDiffer } from "./field-diff.ts";
import { type HandlerContext, handleToken } from "./handlers.ts";
import { type MachineSnapshot, StackMachine } from "./machine.ts";
import { JsonTokenizer } from "./tokenizer.ts";
import {
	type StreamingSchemaField,
	type ValidationState,
	validatePartialAgainstSchema,
} from "./typebox-schema-adapter.ts";

export interface StreamingFieldEvent extends FieldDiffEvent {}

export interface ParserSnapshot {
	tokenizer: ReturnType<JsonTokenizer["snapshot"]>;
	machine: MachineSnapshot;
	fieldDiffer: ReturnType<FieldDiffer["snapshot"]>;
}

export class StreamingFieldParser {
	private readonly tokenizer: JsonTokenizer;
	private readonly machine = new StackMachine();
	private readonly fieldDiffer = new FieldDiffer();
	private readonly schema?: StreamingSchemaField;
	private emittedTokens: Parameters<typeof handleToken>[0][] = [];

	private _partial: unknown = undefined;
	private _valid = true;
	private _validationIssue?: string;
	private _fieldPath?: string;

	constructor(schema?: StreamingSchemaField) {
		this.schema = schema;
		this.tokenizer = new JsonTokenizer((token) => {
			this.emittedTokens.push(token);
		});
	}

	push(chunk: string): StreamingFieldEvent[] {
		this._valid = true;
		this._validationIssue = undefined;
		this._fieldPath = undefined;
		const tokenizerSnap = this.tokenizer.snapshot();
		const machineSnap = this.machine.snapshot();
		const differSnap = this.fieldDiffer.snapshot();

		const ctx: HandlerContext = { pendingValue: undefined };

		let failed = false;

		try {
			this.emittedTokens = [];
			this.tokenizer.feed(chunk);
			ctx.pendingValue = this.tokenizer.pendingValue;
			for (const token of this.emittedTokens.filter((t) => t.type !== "eof")) {
				const ops = handleToken(token, this.machine.peek(), ctx);

				if (ops.length > 0) {
					this.machine.apply(ops);
					const partial = this.machine.buildPartial();
					if (this.schema) {
						const validation = validatePartialAgainstSchema(partial, this.schema);
						if (!validation.valid) {
							failed = true;
							this._valid = false;
							this._validationIssue = validation.issue;
							this._fieldPath = validation.fieldPath;
							break;
						}
					}
				}
			}

			if (failed) {
				this.tokenizer.restore(tokenizerSnap);
				this.machine.restore(machineSnap);
				this.fieldDiffer.restore(differSnap);
				return [];
			}

			// Validate the machine-built partial BEFORE injecting any in-progress
			// (pending) tokenizer value. Pending values are, by construction,
			// incomplete tokens and must never be held to the final-type contract
			// (e.g. a streaming "1.5e" for a number field is not yet a valid
			// number; only the complete "1.5e3" can be validated). This mirrors
			// the Effect-based Stack B parser, which marks partial scalars as
			// state: "incomplete" and validates them only on completion.
			this._partial = this.machine.buildPartial();
			if (this.schema) {
				const validation = validatePartialAgainstSchema(this._partial, this.schema);
				if (!validation.valid) {
					this.tokenizer.restore(tokenizerSnap);
					this.machine.restore(machineSnap);
					this.fieldDiffer.restore(differSnap);
					this._valid = false;
					this._validationIssue = validation.issue;
					this._fieldPath = validation.fieldPath;
					return [];
				}
			}

			// Include the pending (incomplete) value from the tokenizer in the
			// exposed partial for display/diffing only. It is intentionally
			// excluded from schema validation above.
			const pendingValue = this.tokenizer.pendingValue;
			if (pendingValue !== undefined) {
				const frame = this.machine.peek();
				if (frame?.type === "object" && frame.key !== undefined && !frame.expectingKey) {
					const partial = this._partial;
					if (typeof partial === "object" && partial !== null && !Array.isArray(partial)) {
						(partial as Record<string, unknown>)[frame.key] = pendingValue;
					}
				} else if (frame?.type === "array") {
					const partial = this._partial;
					if (Array.isArray(partial)) {
						partial.push(pendingValue);
					}
				}
			}
			return this.fieldDiffer.walkAndDiff(this._partial);
		} catch {
			this.tokenizer.restore(tokenizerSnap);
			this.machine.restore(machineSnap);
			this.fieldDiffer.restore(differSnap);
			this._valid = false;
			this._validationIssue = "Parse error during streaming";
			this._fieldPath = undefined;
			return [];
		}
	}

	end(): void {
		this.tokenizer.flush();
	}

	get partial(): unknown {
		return this._partial;
	}

	get valid(): boolean {
		return this._valid;
	}

	get validationIssue(): string | undefined {
		return this._validationIssue;
	}

	snapshot(): ParserSnapshot {
		return {
			tokenizer: this.tokenizer.snapshot(),
			machine: this.machine.snapshot(),
			fieldDiffer: this.fieldDiffer.snapshot(),
		};
	}

	restore(snap: ParserSnapshot): void {
		this.tokenizer.restore(snap.tokenizer);
		this.machine.restore(snap.machine);
		this.fieldDiffer.restore(snap.fieldDiffer);
		this._partial = this.machine.buildPartial();
		this._valid = true;
		this._validationIssue = undefined;
		this._fieldPath = undefined;
	}

	getValidationState(): ValidationState {
		return { valid: this._valid, issue: this._validationIssue, fieldPath: this._fieldPath };
	}
}
