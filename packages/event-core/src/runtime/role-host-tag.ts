import { Context, Layer } from "effect";
import type { RoleHost } from "../role.ts";

export interface RoleHostTagShape {
	readonly host: RoleHost;
}

export class RoleHostTag extends Context.Service<RoleHostTag, RoleHostTagShape>()("RoleHostTag") {}

export function makeRoleHostLayer(host: RoleHost): Layer.Layer<RoleHostTag, never, never> {
	return Layer.succeed(RoleHostTag, { host });
}
