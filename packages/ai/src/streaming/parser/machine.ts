/**
 * Stack machine for incremental JSON parsing.
 */

export type Frame =
	| { type: "root"; value: ParsedValue | undefined }
	| {
			type: "object";
			keys: string[];
			values: ParsedValue[];
			phase: "expectKey" | "expectColon" | "expectValue" | "afterValue";
	  }
	| { type: "array"; items: ParsedValue[]; phase: "expectValue" | "afterValue" };

export type Op =
	| { type: "push"; frame: Frame }
	| { type: "pop" }
	| { type: "replace"; frame: Frame }
	| { type: "emit"; event: { _tag: "value"; value: ParsedValue } };

export type ParsedValue =
	| { _tag: "string"; value: string; state: "complete" | "incomplete" }
	| { _tag: "number"; value: string; state: "complete" | "incomplete" }
	| { _tag: "boolean"; value: boolean; state: "complete" }
	| { _tag: "null"; state: "complete" }
	| { _tag: "object"; entries: Array<[string, ParsedValue]>; state: "complete" | "incomplete" }
	| { _tag: "array"; items: ParsedValue[]; state: "complete" | "incomplete" };

export function createStackMachine(initialFrame: Frame, emit: (event: { _tag: "value"; value: ParsedValue }) => void) {
	const stack: Frame[] = [initialFrame];
	return {
		apply(ops: Op[]) {
			for (const op of ops) {
				switch (op.type) {
					case "push":
						stack.push(op.frame);
						break;
					case "pop":
						if (stack.length > 1) stack.pop();
						break;
					case "replace":
						if (stack.length > 0) stack[stack.length - 1] = op.frame;
						break;
					case "emit":
						emit(op.event);
						break;
				}
			}
		},
		peek: (): Frame | undefined => stack[stack.length - 1],
		get stack(): Frame[] {
			return stack;
		},
	};
}
