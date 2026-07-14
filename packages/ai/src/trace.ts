/**
 * Trace listener context tag.
 */

import { Context } from "effect";

export interface TraceListenerShape {
	onTrace(trace: unknown): void;
}

export class TraceListener extends Context.Tag("TraceListener")<TraceListener, TraceListenerShape>() {}
