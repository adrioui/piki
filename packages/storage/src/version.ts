import { Context, Layer } from "effect";

export interface Version {
	getVersion: () => string;
}

export const VersionTag = Context.GenericTag<Version>("@piki/Version");

export function VersionLive(version: string) {
	return Layer.succeed(VersionTag, VersionTag.of({ getVersion: () => version }));
}
