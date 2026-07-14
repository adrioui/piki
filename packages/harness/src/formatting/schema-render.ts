import type { Schema } from "effect";
import { Option, SchemaAST } from "effect";

/** Unwrap Transformation and Refinement wrappers to reach the core AST node. */
function unwrapAst(ast: SchemaAST.AST): SchemaAST.AST {
	if (ast._tag === "Transformation") return unwrapAst(ast.from);
	if (ast._tag === "Refinement") return unwrapAst(ast.from);
	return ast;
}

/** Unwrap to a TypeLiteral, traversing through Transformation/Refinement. */
function unwrapToTypeLiteral(ast: SchemaAST.AST): SchemaAST.TypeLiteral | null {
	if (ast._tag === "TypeLiteral") return ast;
	if (ast._tag === "Transformation") {
		const from = unwrapToTypeLiteral(ast.from);
		if (from) return from;
		return unwrapToTypeLiteral(ast.to);
	}
	if (ast._tag === "Refinement") return unwrapToTypeLiteral(ast.from);
	return null;
}

/** Get the identifier annotation from an AST node. */
function getIdentifier(ast: SchemaAST.AST): string | undefined {
	const id = SchemaAST.getIdentifierAnnotation(ast);
	return Option.isSome(id) ? id.value : undefined;
}

/** Walk the AST to find a description annotation. */
function walkForDescription(a: SchemaAST.AST, depth = 0): string | undefined {
	if (depth > 5) return;
	const d = SchemaAST.getDescriptionAnnotation(a);
	if (Option.isSome(d)) return d.value;
	if (a._tag === "Transformation") {
		const from = walkForDescription(a.from, depth + 1);
		if (from) return from;
		return walkForDescription(a.to, depth + 1);
	}
	if (a._tag === "Union") {
		for (const t of a.types) {
			const r = walkForDescription(t, depth + 1);
			if (r) return r;
		}
	}
	if (a._tag === "Refinement") return walkForDescription(a.from, depth + 1);
	return undefined;
}

/** Filter out auto-generated noise descriptions. */
function isNoiseDescription(desc: string | undefined): boolean {
	if (!desc) return true;
	return /^a (string|number|boolean|unknown|void|never|object|array)/.test(desc);
}

/** Get the default value annotation from an AST node. */
function getDefaultValue(node: SchemaAST.AST): unknown {
	const annotation = SchemaAST.getDefaultAnnotation(node);
	if (Option.isSome(annotation)) {
		const thunk = annotation.value as () => unknown;
		return thunk();
	}
	return undefined;
}

/** Extract defaults from a TypeLiteralTransformation's property signature transforms. */
function extractDefaultsFromTransformation(ast: SchemaAST.AST): Map<string, unknown> {
	const defaults = new Map<string, unknown>();
	if (ast._tag !== "Transformation") return defaults;
	if (ast.transformation._tag !== "TypeLiteralTransformation") return defaults;
	for (const pst of ast.transformation.propertySignatureTransformations) {
		const propName = String(pst.from);
		try {
			const result = pst.decode(Option.none());
			if (Option.isSome(result)) {
				defaults.set(propName, result.value);
			}
		} catch {
			// ignore decode failures
		}
	}
	return defaults;
}

/** Convert an AST node to a human-readable type string. */
function typeToString(ast: SchemaAST.AST, isOptional = false, depth = 0): string {
	const unwrapped = unwrapAst(ast);
	const identifier = getIdentifier(ast) || getIdentifier(unwrapped);

	if (identifier) {
		const nameMap: Record<string, string> = {
			ToolImage: "image",
		};
		return nameMap[identifier] ?? identifier;
	}

	switch (unwrapped._tag) {
		case "StringKeyword":
			return "string";
		case "NumberKeyword":
			return "number";
		case "BooleanKeyword":
			return "boolean";
		case "VoidKeyword":
			return "void";
		case "NeverKeyword":
			return "never";
		case "UnknownKeyword":
			return "unknown";
		case "AnyKeyword":
			return "any";
		case "UndefinedKeyword":
			return "undefined";
		case "Literal":
			return JSON.stringify(unwrapped.literal);
		case "Union": {
			const nonUndefined = unwrapped.types.filter((t) => unwrapAst(t)._tag !== "UndefinedKeyword");
			if (nonUndefined.length === 1 && isOptional) {
				return typeToString(nonUndefined[0]!, false, depth);
			}
			const allStringLit = nonUndefined.every((t) => {
				const u = unwrapAst(t);
				return u._tag === "Literal" && typeof u.literal === "string";
			});
			if (allStringLit) {
				return nonUndefined
					.map((t) => {
						const lit = unwrapAst(t) as SchemaAST.Literal;
						return JSON.stringify(lit.literal);
					})
					.join(" | ");
			}
			return nonUndefined.map((t) => typeToString(t, false, depth)).join(" | ");
		}
		case "TypeLiteral": {
			if (depth > 0) {
				const props = unwrapped.propertySignatures.map((p) => {
					const opt = p.isOptional ? "?" : "";
					return `${String(p.name)}${opt}: ${typeToString(p.type, p.isOptional, depth + 1)}`;
				});
				return `{ ${props.join(", ")} }`;
			}
			const topLevelProps = unwrapped.propertySignatures.map((p) => {
				const opt = p.isOptional ? "?" : "";
				return ` ${String(p.name)}${opt}: ${typeToString(p.type, p.isOptional, 1)}`;
			});
			return `{\n${topLevelProps.join("\n")}\n}`;
		}
		case "TupleType": {
			if (unwrapped.elements.length === 0 && unwrapped.rest.length > 0) {
				return `${typeToString(unwrapped.rest[0]!.type, false, depth)}[]`;
			}
			const elements = unwrapped.elements.map((e) => typeToString(e.type, false, depth));
			const rest = unwrapped.rest.length > 0 ? [`...${typeToString(unwrapped.rest[0]!.type, false, depth)}[]`] : [];
			return `[${[...elements, ...rest].join(", ")}]`;
		}
		case "Declaration": {
			const declId = getIdentifier(unwrapped);
			if (declId === "Array" || declId === "ReadonlyArray") {
				if (unwrapped.typeParameters.length > 0) {
					return `${typeToString(unwrapped.typeParameters[0]!, false, depth)}[]`;
				}
				return "unknown[]";
			}
			if (declId === "Record" || declId === "ReadonlyMap") {
				if (unwrapped.typeParameters.length >= 2) {
					return `Record<${typeToString(unwrapped.typeParameters[0]!, false, depth)}, ${typeToString(unwrapped.typeParameters[1]!, false, depth)}>`;
				}
				return "Record<string, unknown>";
			}
			if (declId) {
				const typeArgs = unwrapped.typeParameters.map((p) => typeToString(p, false, depth));
				return typeArgs.length > 0 ? `${declId}<${typeArgs.join(", ")}>` : declId;
			}
			return "unknown";
		}
		case "Enums":
			return unwrapped.enums.map(([, v]) => JSON.stringify(v)).join(" | ");
		case "Suspend":
			return typeToString(unwrapped.f(), isOptional, depth);
		default:
			return "unknown";
	}
}

/** Extract parameter metadata from an Effect Schema. */
interface SchemaParam {
	name: string;
	optional: boolean;
	type: string;
	description: string | undefined;
	defaultValue: unknown;
}

function extractParams(schema: Schema.Schema<unknown>): SchemaParam[] {
	const transformDefaults = extractDefaultsFromTransformation(schema.ast);
	const inputAst = unwrapToTypeLiteral(schema.ast);
	if (!inputAst) return [];

	const fromDescriptions = new Map<string, string>();
	const topAst = schema.ast;
	if (topAst._tag === "Transformation" && topAst.from._tag === "TypeLiteral") {
		for (const p of topAst.from.propertySignatures) {
			const desc = walkForDescription(p.type);
			if (desc && !isNoiseDescription(desc)) {
				fromDescriptions.set(String(p.name), desc);
			}
		}
	}

	return inputAst.propertySignatures.map((p) => {
		const name = String(p.name);
		const optional = p.isOptional;
		const type = typeToString(p.type, optional, 1);
		const desc = walkForDescription(p.type);
		const propDesc = !desc ? Option.getOrUndefined(SchemaAST.getDescriptionAnnotation(p.type)) : undefined;
		const description = desc || (isNoiseDescription(propDesc) ? undefined : propDesc) || fromDescriptions.get(name);
		const defaultValue = getDefaultValue(p.type) || transformDefaults.get(name);
		return { name, optional, type, description, defaultValue };
	});
}

/**
 * Render expected parameters from an input schema as human-readable text.
 * Matches capture L76967-77029.
 */
export function renderExpectedParams(inputSchema: Schema.Schema<unknown>): string {
	const params = extractParams(inputSchema);
	if (params.length === 0) {
		return "Expected parameters: (none)";
	}
	const lines = params.map((p) => {
		const opt = p.optional ? "?" : "";
		let line = ` ${p.name}${opt}: ${p.type}`;
		const commentParts: string[] = [];
		if (p.description) commentParts.push(p.description);
		if (p.defaultValue !== undefined) commentParts.push(`default: ${JSON.stringify(p.defaultValue)}`);
		if (commentParts.length > 0) {
			line += ` // ${commentParts.join(" — ")}`;
		}
		return line;
	});
	return `Expected parameters:\n${lines.join("\n")}`;
}
