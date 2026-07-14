/**
 * Handler resolver for incremental JSON parser.
 */

import { arrayHandler } from "./handlers/array.ts";
import { objectHandler } from "./handlers/object.ts";
import { rootHandler } from "./handlers/root.ts";
import type { Frame } from "./machine.ts";
import type { BoundHandler } from "./types.ts";
import { bindHandler } from "./types.ts";

export function resolveHandler(frame: Frame): BoundHandler {
	switch (frame.type) {
		case "root":
			return bindHandler(rootHandler, frame);
		case "object":
			return bindHandler(objectHandler, frame);
		case "array":
			return bindHandler(arrayHandler, frame);
	}
}
