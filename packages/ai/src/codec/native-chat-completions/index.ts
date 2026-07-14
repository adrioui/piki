/**
 * Native chat completions codec aggregation.
 */

import { decode } from "./decode.ts";
import { encodePrompt } from "./encode.ts";

export const nativeChatCompletionsCodec = {
	id: "native-chat-completions",
	encodePrompt,
	decode,
};
