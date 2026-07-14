import { Context, Layer } from "effect";
import type { RoleHost } from "../role.ts";

export interface RoleHostTagShape {
	readonly host: RoleHost;
}

export const RoleHostTag = Context.GenericTag<RoleHostTagShape>("RoleHostTag");

export function makeRoleHostLayer(host: RoleHost) {
	return Layer.succeed(RoleHostTag, { host });
}
