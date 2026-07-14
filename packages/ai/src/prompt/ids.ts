/**
 * Tool call ID generator.
 */

import { init } from "@paralleldrive/cuid2";

export const createToolCallId = (() => {
	const fn = init({ length: 8 });
	return () => fn();
})();
