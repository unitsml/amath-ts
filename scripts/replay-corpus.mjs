// Replays the pinned plurimath-testsuite asciimath stage generation through
// this package.
//
//   node scripts/replay-corpus.mjs <testsuite-checkout> [--pin FILE]
//     [--report FILE] [--executed FILE]
//
// --pin names a pin file in scripts/ (default corpus-pin.json). Before any row
// runs, the generation's files must hash to the pinned snapshot digest and
// provenance, and each payload to its recorded size and SHA-256.
//
// raw-tree rows go through parseTree and typed-model rows through parse. Each
// result is written in the row's canonical form (the one amath's
// scripts/generate_stage_cases.rb writes) and its JSON bytes must equal the
// expected value's. Supersession is append-only: a row whose id has an -r2
// sibling is kept for history and only the sibling runs, as in amath's
// scripts/replay_corpus.rb. Payloads without a boundary (the legacy-oracle
// Plurimath end-to-end outputs, not an amath boundary) are counted and not run. The run must
// execute exactly the pinned row IDs of each boundary, and any failing row
// fails the replay. AMATH_TS_DIST replays an installed package's dist (for
// example the packed tarball installed into a clean consumer) instead of the
// build tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pin: { type: "string", default: "corpus-pin.json" },
    report: { type: "string" },
    executed: { type: "string" },
  },
});
const root = positionals[0];
if (!root) throw new Error("Pass the pinned plurimath-testsuite checkout path");

const dist = resolve(process.env.AMATH_TS_DIST ?? resolve(here, "../dist"));
const { initialize, Model } = await import(pathToFileURL(resolve(dist, "index.js")).href);
const pin = JSON.parse(readFileSync(resolve(here, args.pin), "utf8"));
const generation = resolve(root, pin.path);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Same digest as the testsuite's validate-stages.rb: sha256 over
// "<sha256>  <path>\n" for every file of the generation, paths relative to the
// generation directory and ordered by their bytes.
function files(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return files(path, base);
    assert.ok(entry.isFile(), `unexpected entry ${path}`);
    return [relative(base, path).split("\\").join("/")];
  });
}
const listed = files(generation).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const digest = "sha256:" + sha(listed.map((path) => `${sha(readFileSync(resolve(generation, path)))}  ${path}\n`).join(""));
assert.equal(digest, pin.snapshot_digest, "pinned generation snapshot digest changed");

const provenanceBytes = readFileSync(resolve(generation, "provenance.yaml"));
assert.equal(sha(provenanceBytes), pin.provenance_sha256, "pinned corpus provenance changed");
const provenance = parse(provenanceBytes.toString("utf8"));
assert.equal(provenance.language, pin.language);
assert.equal(Number(provenance.generation), pin.generation);
assert.deepEqual(
  provenance.payloads.map((p) => p.path).concat("provenance.yaml").sort(),
  listed.slice().sort(),
  "generation files differ from the payloads provenance lists",
);

// A parse tree in the stage payloads' tagged form: hash keys as symbols in
// key order, slices with byte and character offsets into the input.
function canonical(value, input) {
  if (value === null) return { nil: true };
  if (typeof value === "string") return { str: value };
  if (Array.isArray(value)) return { array: value.map((v) => canonical(v, input)) };
  if (Object.hasOwn(value, "text") && Object.hasOwn(value, "offset")) {
    const prefix = new TextDecoder().decode(new TextEncoder().encode(input).subarray(0, value.offset));
    return { slice: value.text, byte_offset: value.offset, char_offset: [...prefix].length };
  }
  return { hash: Object.keys(value).sort().map((k) => [{ sym: k }, canonical(value[k], input)]) };
}
// Payload hashes keep the producer's insertion order; compare in key order.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  if (value.hash) {
    const entries = value.hash.map(([k, v]) => [k, sorted(v)]);
    return { hash: entries.sort(([a], [b]) => (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0)) };
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sorted(v)]));
}
// The Ruby model wire ({node, fields}, absent and nil fields left out).
function modelTree(value) {
  if (Array.isArray(value)) return { array: value.map(modelTree) };
  if (typeof value === "string") return { str: value };
  if (value === null) return { nil: true };
  const id = value.constructor.modelId;
  assert.equal(typeof id, "string", "every model is generated from LML");
  return {
    node: id.split("@")[0],
    fields: value.constructor.memberNames
      .filter((k) => value[k] !== Model.ABSENT && value[k] !== null)
      .map((k) => [k, modelTree(value[k])]),
  };
}
function same(kind, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  let i = 0;
  while (a[i] === e[i]) i++;
  throw new Error(`${kind} differs at ${i}: actual …${a.slice(Math.max(0, i - 120), i + 200)} expected …${e.slice(Math.max(0, i - 120), i + 200)}`);
}
function refused(row, run) {
  let error;
  try { run(); } catch (e) { error = e; }
  assert.ok(error, "expected parse refusal");
  assert.equal(error.name, "ParseError", String(error));
  assert.equal(error.byteOffset, row.expected.refusal.byte_offset);
}
function rawRow(row) {
  const input = row.input.str;
  if (row.expected.refusal) return refused(row, () => parser.parseTree(input, row.options));
  // Amath has no preprocessing: the preprocessed text is the input.
  assert.equal(row.expected.preprocessed.str, input, "preprocessed text");
  same("tree", sorted(canonical(parser.parseTree(input, row.options), input)), sorted(row.expected.tree));
}
function typedRow(row) {
  const input = row.input.str;
  if (row.expected.refusal) return refused(row, () => parser.parse(input, row.options));
  same("model", modelTree(parser.parse(input, row.options)), row.expected.tree);
}
// The ids superseded by an -r2 sibling (a typed-model row's sibling keeps its
// .model suffix after -r2).
const SIBLING = /-r2(\.model)?$/;
function superseded(rows) {
  return new Set(rows.map((r) => r.id).filter((id) => SIBLING.test(id)).map((id) => id.replace(SIBLING, "$1")));
}

const parser = await initialize();
const failures = [];
const ids = {};
const supersededIds = {};
const legacy = [];
const timings = [];
for (const payload of provenance.payloads) {
  const path = resolve(generation, payload.path);
  const rel = relative(generation, path);
  assert.ok(!rel.startsWith("..") && !isAbsolute(rel), "payload escapes generation");
  const bytes = readFileSync(path);
  assert.equal(bytes.length, payload.bytes, `${payload.path}: size`);
  assert.equal(sha(bytes), payload.sha256, `${payload.path}: checksum`);
  const doc = parse(bytes.toString("utf8"), { maxAliasCount: -1 });
  const boundary = doc.boundary;
  if (boundary === undefined) {
    legacy.push(payload.path);
    continue;
  }
  assert.ok(boundary in pin.boundaries, `${payload.path}: boundary ${boundary} is not pinned`);
  const dead = superseded(doc.cases);
  for (const row of doc.cases) {
    if (dead.has(row.id)) {
      (supersededIds[boundary] ??= []).push(row.id);
      continue;
    }
    (ids[boundary] ??= []).push(row.id);
    const started = performance.now();
    try {
      if (boundary === "typed-model") typedRow(row);
      else rawRow(row);
    } catch (e) {
      failures.push({ id: row.id, boundary, input: row.input.str, error: String(e).slice(0, 900) });
    } finally {
      timings.push([row.id, Math.round(performance.now() - started)]);
    }
  }
}
// The run must execute exactly the pinned row IDs of each boundary.
for (const [boundary, expected] of Object.entries(pin.boundaries)) {
  const executed = ids[boundary] ?? [];
  assert.equal(new Set(executed).size, executed.length, `${boundary}: duplicate row id`);
  assert.equal(executed.length, expected.rows, `${boundary}: executed row count`);
  assert.equal(sha(Buffer.from(executed.join("\n"), "utf8")), expected.ids_sha256, `${boundary}: executed row IDs`);
}
assert.equal(legacy.length, pin.legacy_payloads_not_run, "legacy-oracle payload count");
timings.sort((a, b) => b[1] - a[1]);
const report = {
  language: pin.language,
  generation: pin.generation,
  revision: pin.revision,
  snapshot_digest: digest,
  dist,
  executed: Object.fromEntries(Object.entries(ids).map(([b, v]) => [b, v.length])),
  superseded: supersededIds,
  legacy_payloads_not_run: legacy,
  failed: failures.length,
  failed_ids: failures.map((f) => f.id),
  failures,
  slowest_ms: timings.slice(0, 10),
};
if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 1));
if (args.executed) writeFileSync(args.executed, Object.values(ids).flat().join("\n") + "\n");
console.log(JSON.stringify({ ...report, legacy_payloads_not_run: legacy.length, failures: failures.slice(0, 20) }));
process.exitCode = failures.length ? 1 : 0;
