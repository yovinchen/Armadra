/**
 * Enough YAML to read a GitHub Actions workflow.
 *
 * The alternative was a dependency, and a repository check that only runs when
 * `node_modules` is installed is a check that stops running. Workflow files are
 * a narrow, well-behaved subset: block mappings, block sequences, plain and
 * quoted scalars, block scalars (`|`, `>`), flow sequences of scalars, and
 * comments. Anything outside that subset is refused by name rather than parsed
 * approximately — a parser that quietly mis-reads a workflow would validate a
 * file that does not exist.
 */

const INDENT = /^(\s*)(.*)$/;

class YamlError extends Error {}

/** Parse a YAML document into plain objects, arrays and scalars. */
export function parseYaml(text) {
  const lines = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.includes("\t"))
      throw new YamlError(`line ${index + 1}: tabs are not YAML indentation`);
    const [, indent, rest] = INDENT.exec(raw);
    lines.push({ number: index + 1, indent: indent.length, raw, text: rest });
  });
  const reader = { lines, at: 0 };
  skipBlank(reader);
  if (reader.at >= lines.length) return null;
  const value = parseBlock(reader, lines[reader.at].indent);
  skipBlank(reader);
  if (reader.at < lines.length)
    throw new YamlError(
      `line ${lines[reader.at].number}: unexpected content after the document`,
    );
  return value;
}

function skipBlank(reader) {
  while (reader.at < reader.lines.length) {
    const line = reader.lines[reader.at];
    if (line.text.trim() === "" || line.text.trimStart().startsWith("#"))
      reader.at += 1;
    else break;
  }
}

/**
 * Parse whatever block starts at or beyond `minimum`. The block's own indent
 * is the first line's, not the caller's guess: YAML lets a nested block sit at
 * any column deeper than its parent, and workflows use both two and four.
 */
function parseBlock(reader, minimum) {
  skipBlank(reader);
  if (reader.at >= reader.lines.length) return null;
  const line = reader.lines[reader.at];
  if (line.indent < minimum) return null;
  return line.text.startsWith("- ") || line.text === "-"
    ? parseSequence(reader, line.indent)
    : parseMapping(reader, line.indent);
}

function parseSequence(reader, indent) {
  const items = [];
  for (;;) {
    skipBlank(reader);
    if (reader.at >= reader.lines.length) break;
    const line = reader.lines[reader.at];
    if (
      line.indent !== indent ||
      !(line.text === "-" || line.text.startsWith("- "))
    )
      break;
    const inline = line.text === "-" ? "" : line.text.slice(2);
    reader.at += 1;
    if (inline.trim() === "") {
      items.push(parseBlock(reader, indent + 2) ?? null);
      continue;
    }
    // "- key: value" opens a mapping whose first key sits on the dash line.
    if (isMappingStart(inline)) {
      const nested = { lines: reader.lines, at: reader.at };
      const first = parseInlineMapping(inline, line.number, indent + 2, reader);
      const rest = parseMappingBody(reader, indent + 2, first);
      reader.at = Math.max(reader.at, nested.at);
      items.push(rest);
      continue;
    }
    items.push(scalar(inline, line.number));
  }
  return items;
}

function isMappingStart(text) {
  return splitKey(text) !== null;
}

/** Split "key: value" without cutting inside a quoted scalar. */
function splitKey(text) {
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && index > 0 && text[index - 1] === " ") return null;
    if (
      char === ":" &&
      (index + 1 === text.length || text[index + 1] === " ")
    ) {
      return { key: text.slice(0, index), value: text.slice(index + 1).trim() };
    }
  }
  return null;
}

function parseInlineMapping(text, number, indent, reader) {
  const split = splitKey(text);
  if (!split) throw new YamlError(`line ${number}: expected a mapping`);
  const result = {};
  assign(result, split, number, indent, reader);
  return result;
}

function parseMapping(reader, indent) {
  return parseMappingBody(reader, indent, {});
}

function parseMappingBody(reader, indent, result) {
  for (;;) {
    skipBlank(reader);
    if (reader.at >= reader.lines.length) break;
    const line = reader.lines[reader.at];
    if (line.indent !== indent) {
      if (line.indent < indent) break;
      throw new YamlError(`line ${line.number}: unexpected indentation`);
    }
    const split = splitKey(line.text);
    if (!split) break;
    reader.at += 1;
    assign(result, split, line.number, indent, reader);
  }
  return result;
}

function assign(result, split, number, indent, reader) {
  const key = unquote(split.key.trim());
  if (Object.hasOwn(result, key))
    throw new YamlError(`line ${number}: duplicate key ${key}`);
  if (
    split.value === "|" ||
    split.value === ">" ||
    split.value === "|-" ||
    split.value === ">-"
  ) {
    result[key] = blockScalar(reader, indent, split.value.startsWith(">"));
    return;
  }
  if (split.value === "") {
    result[key] = parseBlock(reader, indent + 1) ?? null;
    return;
  }
  result[key] = scalar(split.value, number);
}

function blockScalar(reader, indent, folded) {
  const collected = [];
  let scalarIndent = null;
  while (reader.at < reader.lines.length) {
    const line = reader.lines[reader.at];
    if (line.text.trim() === "") {
      collected.push("");
      reader.at += 1;
      continue;
    }
    if (line.indent <= indent) break;
    scalarIndent ??= line.indent;
    collected.push(line.raw.slice(scalarIndent));
    reader.at += 1;
  }
  while (collected.length > 0 && collected.at(-1) === "") collected.pop();
  return collected.join(folded ? " " : "\n");
}

function scalar(text, number) {
  const trimmed = stripComment(text).trim();
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]"))
      throw new YamlError(`line ${number}: unclosed flow sequence`);
    const inner = trimmed.slice(1, -1).trim();
    return inner === ""
      ? []
      : inner.split(",").map((item) => scalar(item, number));
  }
  if (trimmed.startsWith("{"))
    throw new YamlError(
      `line ${number}: flow mappings are not supported in workflows here`,
    );
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return unquote(trimmed);
}

function stripComment(text) {
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || text[index - 1] === " "))
      return text.slice(0, index);
  }
  return text;
}

function unquote(text) {
  if (text.length >= 2 && text[0] === '"' && text.at(-1) === '"')
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
  if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'")
    return text.slice(1, -1).replace(/''/g, "'");
  return text;
}
