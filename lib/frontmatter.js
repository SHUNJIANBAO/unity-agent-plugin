/**
 * Frontmatter reader for skill files.
 *
 * DSH's own filesystem provider parses `SKILL.md` fronts with a real YAML
 * parser. This plugin ships no runtime dependency, so it carries a small
 * reader for the subset Unity's skills use: top-level `key: value` scalars,
 * `|`/`>` block scalars, flow sequences (`[a, b]`), nested mappings (two
 * levels, e.g. `required_packages`) and block sequences (`- item`).
 *
 * The reader is deliberately lenient about lines it cannot classify (it skips
 * them) and strict about the two fields that decide whether a skill exists at
 * all: `name` and `description`. Callers validate those and report what they
 * rejected rather than dropping a skill silently.
 *
 * `test/frontmatter.test.mjs` compares this reader against `js-yaml` for every
 * bundled `skills/*​/SKILL.md` plus a fixture set, so drift from real YAML
 * semantics shows up as a test failure rather than as a wrong skill menu.
 *
 * @module lib/frontmatter
 */

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parse the leading `---` block of a skill file.
 *
 * @param {string} raw - the whole file text.
 * @returns {{ data: Record<string, unknown>, body: string } | null} the parsed
 *   mapping and the body after the closing fence, or `null` when the file has
 *   no frontmatter fence or the fence does not hold a mapping.
 */
export function parseFrontmatter(raw) {
	// A leading BOM is not content: the kernel's YAML reader accepts a file that
	// starts with one, so this reader must too.
	const text = String(raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const opening = /^---[ \t]*\n/.exec(text);
	if (opening === null) {
		return text.replace(/[ \t]+$/, "") === "---" ? { data: {}, body: "" } : null;
	}
	const lines = text.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trimEnd() === "---") {
			close = i;
			break;
		}
	}
	if (close < 0) return null;
	const data = parseMappingFrom(lines.slice(1, close));
	if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
	return { data, body: lines.slice(close + 1).join("\n") };
}

/**
 * Return whether a string is a valid kebab-case DSH skill name.
 *
 * @param {string} name - candidate name.
 * @returns {boolean} whether the registry would accept it.
 */
export function isSkillName(name) {
	return typeof name === "string" && NAME_PATTERN.test(name);
}

/** One parsed source line. Blank lines keep `indent: Infinity` so comparisons work. */
function toRows(raw) {
	return raw.map((line) => {
		const withoutTrailing = line.replace(/[ \t]+$/, "");
		if (withoutTrailing.trim() === "") return { blank: true, indent: Infinity, raw: "", text: "" };
		const indent = withoutTrailing.length - withoutTrailing.replace(/^ +/, "").length;
		return { blank: false, indent, raw: withoutTrailing, text: withoutTrailing.slice(indent) };
	});
}

function skipBlank(state) {
	while (state.i < state.rows.length && state.rows[state.i].blank) state.i += 1;
}

function peek(state) {
	return state.i < state.rows.length ? state.rows[state.i] : undefined;
}

function isSequenceItem(text) {
	return text === "-" || text.startsWith("- ");
}

function parseMappingFrom(rows) {
	const state = { rows: toRows(rows), i: 0 };
	return parseNode(state, 0);
}

function parseNode(state, indent) {
	skipBlank(state);
	const line = peek(state);
	if (line === undefined || line.indent < indent) return null;
	if (isSequenceItem(line.text)) return parseSequence(state, line.indent);
	return parseMapping(state, line.indent);
}

/** Parse a nested block introduced by an empty `key:` value. */
function parseChildBlock(state, parentIndent) {
	const saved = state.i;
	skipBlank(state);
	const line = peek(state);
	if (line === undefined) {
		state.i = saved;
		return null;
	}
	if (line.indent > parentIndent) return parseNode(state, line.indent);
	// YAML lets a sequence sit at its key's own indentation (`items:` followed by
	// a dash at column 0), which is common in hand-written frontmatter.
	if (line.indent === parentIndent && isSequenceItem(line.text)) return parseSequence(state, line.indent);
	state.i = saved;
	return null;
}

function parseMapping(state, indent) {
	const out = {};
	for (;;) {
		skipBlank(state);
		const line = peek(state);
		if (line === undefined) break;
		if (line.indent < indent) break;
		// A deeper line where a sibling key was expected is malformed for this
		// reader; skip it instead of failing the whole document.
		if (line.indent > indent) {
			state.i += 1;
			continue;
		}
		const match = matchKey(line.text);
		if (match === null) {
			state.i += 1;
			continue;
		}
		const key = unquoteKey(match[0]);
		const rest = match[1];
		state.i += 1;
		if (rest.trim() === "") {
			out[key] = parseChildBlock(state, indent);
			continue;
		}
		const indicator = rest.trim();
		if (isBlockScalarIndicator(indicator)) {
			out[key] = readBlockScalar(state, indent, indicator);
			continue;
		}
		const rawValue = stripComment(rest).trim();
		out[key] = foldPlainContinuation(state, indent, rawValue, parseScalar(rawValue));
	}
	return out;
}

/**
 * A YAML plain scalar may continue on more-indented following lines, folded with
 * a space (a blank line becomes a line break). Without this, a description
 * written as `description: first` + an indented `second` line would be read as
 * `first` and the rest silently dropped.
 */
function foldPlainContinuation(state, keyIndent, rawValue, value) {
	if (typeof value !== "string" || rawValue === "") return value;
	const first = rawValue[0];
	// Only plain scalars fold; quoted, flow and block forms are complete already.
	if (first === '"' || first === "'" || first === "[" || first === "{" || first === "|" || first === ">") return value;
	const lines = [value];
	let consumed = false;
	for (;;) {
		const saved = state.i;
		let blanks = 0;
		while (state.i < state.rows.length && state.rows[state.i].blank) {
			blanks += 1;
			state.i += 1;
		}
		const line = state.i < state.rows.length ? state.rows[state.i] : undefined;
		if (line === undefined || line.indent <= keyIndent || matchKey(line.text) !== null) {
			state.i = saved;
			break;
		}
		for (let index = 0; index < blanks; index += 1) lines.push("");
		lines.push(line.text);
		consumed = true;
		state.i += 1;
	}
	return consumed ? foldLines(lines) : value;
}

function parseSequence(state, indent) {
	const out = [];
	for (;;) {
		skipBlank(state);
		const line = peek(state);
		if (line === undefined || line.indent !== indent || !isSequenceItem(line.text)) break;
		const rest = line.text === "-" ? "" : line.text.slice(2);
		state.i += 1;
		if (rest.trim() === "") {
			out.push(parseChildBlock(state, indent));
			continue;
		}
		const match = matchKey(rest);
		if (match !== null && !isBlockScalarIndicator(rest.trim())) {
			const entry = {};
			entry[unquoteKey(match[0])] = parseScalar(stripComment(match[1]).trim());
			// Remaining keys of the same item are indented past the dash.
			Object.assign(entry, parseMapping(state, indent + 2 + leadingSpaces(rest)));
			out.push(entry);
			continue;
		}
		out.push(parseScalar(stripComment(rest).trim()));
	}
	return out;
}

function leadingSpaces(text) {
	return text.length - text.replace(/^ +/, "").length;
}

function isBlockScalarIndicator(value) {
	return /^[|>][-+]?\d*$/.test(value);
}

/**
 * Read a `|`/`>` block scalar whose content is indented past its key.
 *
 * Chomping follows the indicator: `-` strips every trailing line break, no
 * indicator clips to exactly one, `+` keeps them.
 */
function readBlockScalar(state, parentIndent, indicator) {
	const style = indicator[0];
	const chomp = indicator.includes("-") ? "-" : indicator.includes("+") ? "+" : "";
	// An explicit indentation indicator (`|2`, `>-4`) fixes the content column
	// relative to the key's own indentation.
	const explicit = /^[|>][-+]?(\d+)$/.exec(indicator);
	const fixedIndent = explicit === null ? undefined : parentIndent + Number(explicit[1]);
	const collected = [];
	let trailingBlanks = 0;
	let baseIndent = fixedIndent ?? null;
	while (state.i < state.rows.length) {
		const line = state.rows[state.i];
		if (line.blank) {
			collected.push("");
			state.i += 1;
			continue;
		}
		if (line.indent <= parentIndent) break;
		if (baseIndent === null) baseIndent = line.indent;
		collected.push(line.raw.slice(Math.min(baseIndent, line.indent)));
		state.i += 1;
	}
	while (collected.length > 0 && collected[collected.length - 1] === "") {
		collected.pop();
		trailingBlanks += 1;
	}
	let text = style === "|" ? collected.join("\n") : foldLines(collected);
	if (chomp === "-") return text;
	if (chomp === "+") return `${text}${"\n".repeat(Math.max(1, trailingBlanks))}`;
	return `${text}\n`;
}

/** YAML folded style: a single break becomes a space, a break after a blank line stays a break. */
function foldLines(lines) {
	let out = "";
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (i === 0) {
			out = line;
			continue;
		}
		if (line === "") out += "\n";
		else if (lines[i - 1] === "") out += line;
		else out += ` ${line}`;
	}
	return out;
}

/** Find `key:` outside quotes; the separator must be followed by a space or end the line. */
function matchKey(text) {
	let quote = null;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (quote !== null) {
			if (quote === '"' && char === "\\") {
				i += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ":" && (i + 1 === text.length || text[i + 1] === " " || text[i + 1] === "\t")) {
			return [text.slice(0, i), text.slice(i + 1)];
		}
	}
	return null;
}

/** Drop a trailing `# comment` that is not inside quotes. */
function stripComment(text) {
	let out = "";
	let quote = null;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (quote !== null) {
			if (quote === '"' && char === "\\") {
				out += char + (text[i + 1] ?? "");
				i += 1;
				continue;
			}
			out += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			out += char;
			continue;
		}
		if (char === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) break;
		out += char;
	}
	return out;
}

function unquoteKey(key) {
	const trimmed = key.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return unescapeDoubleQuoted(trimmed.slice(1, -1));
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	return trimmed;
}

function parseScalar(value) {
	const text = value.trim();
	if (text === "") return null;
	if (text.startsWith("[") && text.endsWith("]")) return parseFlowSequence(text.slice(1, -1));
	if (text.startsWith("{") && text.endsWith("}")) return parseFlowMapping(text.slice(1, -1));
	if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
		return unescapeDoubleQuoted(text.slice(1, -1));
	}
	if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
		return text.slice(1, -1).replace(/''/g, "'");
	}
	if (/^(?:true|True|TRUE)$/.test(text)) return true;
	if (/^(?:false|False|FALSE)$/.test(text)) return false;
	if (/^(?:null|Null|NULL|~)$/.test(text)) return null;
	if (/^[+-]?(?:0|[1-9][0-9]*)$/.test(text)) return Number(text);
	if (/^[+-]?(?:[0-9]*\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][+-]?[0-9]+)?$/.test(text)) return Number(text);
	return text;
}

function unescapeDoubleQuoted(text) {
	return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (whole, code) => {
		if (code[0] === "u") return String.fromCharCode(Number.parseInt(code.slice(1), 16));
		if (code[0] === "x") return String.fromCharCode(Number.parseInt(code.slice(1), 16));
		switch (code) {
			case "n": return "\n";
			case "t": return "\t";
			case "r": return "\r";
			case "0": return "\0";
			case '"': return '"';
			case "\\": return "\\";
			case "/": return "/";
			default: return whole;
		}
	});
}

/** Split one flow collection body on its top-level commas. */
function splitFlow(body) {
	const parts = [];
	let current = "";
	let depth = 0;
	let quote = null;
	for (let i = 0; i < body.length; i += 1) {
		const char = body[i];
		if (quote !== null) {
			current += char;
			if (quote === '"' && char === "\\") {
				current += body[i + 1] ?? "";
				i += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "[" || char === "{") depth += 1;
		if (char === "]" || char === "}") depth -= 1;
		if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim() !== "") parts.push(current);
	return parts;
}

function parseFlowSequence(body) {
	return splitFlow(body).map((part) => parseScalar(part.trim()));
}

function parseFlowMapping(body) {
	const out = {};
	for (const part of splitFlow(body)) {
		const match = matchKey(part.trim());
		if (match === null) continue;
		out[unquoteKey(match[0])] = parseScalar(match[1].trim());
	}
	return out;
}
