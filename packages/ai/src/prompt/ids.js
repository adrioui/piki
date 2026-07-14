/**
 * Tool call ID generator.
 * 1:1 with capture's prompt/ids.ts.
 */
import { init } from "@paralleldrive/cuid2";
export const createToolCallId = (() => {
    const fn = init({ length: 8 });
    return () => fn();
})();
//# sourceMappingURL=ids.js.map