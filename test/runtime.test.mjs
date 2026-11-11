import test from 'node:test';
import assert from 'node:assert/strict';
import { CallDepthLimitExceeded } from 'parsanol';
import { readFile } from 'node:fs/promises';
import { initialize, parseTree, NotInitializedError, EngineUnavailable, Model, modelJson, Parser, ParseError, NestingTooDeep } from '../dist/index.js';

assert.throws(() => parseTree('x'), NotInitializedError);
const parser = await initialize();
const read = async name => JSON.parse(await readFile(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'text') && Object.hasOwn(value, 'offset')) return value.text;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
}
function canonical(value, input) {
  if (value === null) return { nil: true };
  if (typeof value === 'string') return { str: value };
  if (Array.isArray(value)) return { array: value.map(v => canonical(v, input)) };
  if (Object.hasOwn(value, 'text') && Object.hasOwn(value, 'offset')) {
    const prefix = new TextDecoder().decode(new TextEncoder().encode(input).subarray(0, value.offset));
    return { slice: value.text, byte_offset: value.offset, char_offset: [...prefix].length };
  }
  return { hash: Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [{ sym: k }, canonical(v, input)]) };
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  if (value.hash) return { hash: value.hash.map(([k, v]) => [k, sorted(v)]).sort(([a], [b]) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sorted(v)]));
}
const legacy = await read('legacy');
assert.equal(legacy.cases.length, 160, 'fixed expected legacy case count');
for (const row of legacy.cases) test(`legacy capture tree: ${row.id}`, () => assert.deepEqual(plain(parser.parseTree(row.input)), row.tree));
const raw = await read('asciimath');
assert.equal(raw.cases.length, 10, 'fixed expected offset-aware raw case count');
for (const row of raw.cases) test(`offset-aware tree: ${row.id}`, () => {
  const input = row.input.str;
  if (row.expected.refusal) {
    assert.throws(() => parser.parseTree(input, row.options), error => error.name === 'ParseError' && error.byteOffset === row.expected.refusal.byte_offset);
  } else assert.deepEqual(sorted(canonical(parser.parseTree(input, row.options), input)), sorted(row.expected.tree));
});
function modelTree(value) {
  if (Array.isArray(value)) return { array: value.map(modelTree) };
  if (typeof value === 'string') return { str: value };
  if (value === null) return { nil: true };
  const id = value.constructor.modelId;
  assert.equal(typeof id, 'string', 'every model is generated from LML');
  return { node: id.split('@')[0], fields: value.constructor.memberNames.filter(k => value[k] !== Model.ABSENT && value[k] !== null).map(k => [k, modelTree(value[k])]) };
}
const typed = await read('typed');
assert.equal(typed.cases.length, 10, 'fixed expected typed-model case count');
for (const row of typed.cases) test(`typed model: ${row.id}`, () => assert.deepEqual(modelTree(parser.parse(row.input.str, row.options)), row.expected.tree));
test('decimal markers retain source text', () => {
  for (const [decimal, input] of [['.', '1.5'], [',', '1,5'], ['٫', '1٫5']]) {
    assert.equal(parser.parse(input, { decimal }).decimal, decimal);
    assert.ok(JSON.stringify(plain(parser.parseTree(input, { decimal }))).includes(input));
  }
});
test('typed models and JSON codecs come from the upstream generator', () => {
  const model = parser.parse('alpha');
  assert.ok(model instanceof Model.AmathModelDocument);
  const symbol = model.expression.expr.amath_chain[0].amath_step.sequence.symbol;
  assert.equal(symbol.value, 'α');
  assert.equal(symbol.kind, 'symbol');
  const codec = modelJson.CODECS['Amath::Model::Document@default'];
  // JSON render policies may omit empty grammar-normalization captures.
  // Typed parse equality is checked separately against the pinned corpus.
  const decoded = codec.decode(codec.encode(model));
  assert.ok(decoded instanceof Model.AmathModelDocument);
  assert.equal(decoded.expression.expr.amath_chain[0].amath_step.sequence.symbol.value, 'α');
  assert.equal(decoded.expression.expr.amath_chain[0].amath_step.sequence.symbol.kind, 'symbol');
});
test('unsupported engines and dialects fail explicitly', () => {
  assert.throws(() => parser.parseTree('x', { engine: 'ruby' }), EngineUnavailable);
  assert.throws(() => parser.parseTree('x', { dialect: 'pma' }), EngineUnavailable);
  assert.throws(() => parser.parseTree('x', { decimal: ';' }), RangeError);
  assert.throws(() => parser.parseTree('\ud800'), TypeError);
});

test('causal refusal matches Ruby byte and character offsets', () => {
  for (const [input, byte, char] of [['a/', 1, 1], ['α a/', 4, 3]]) assert.throws(() => parser.parseTree(input), error => error.name === 'ParseError' && error.byteOffset === byte && error.charOffset === char);
});
test('expected token names do not turn parse errors into depth errors', () => {
  const runtime = { parseShape() { throw "Parse failed: expected substack, recursion, nesting"; }, parseShapeWithCompatibility() { return { ok: false, error: { offset: 1 } }; } };
  const boundary = new Parser(new Map([['.', runtime]]), '{}', {});
  assert.throws(() => boundary.parseTree('x?'), error => error instanceof ParseError && !(error instanceof NestingTooDeep) && error.byteOffset === 1);
});
test('actual typed stack exhaustion remains a depth refusal', () => {
  let recovered = false;
  const runtime = { parseShape() { throw new RangeError('Maximum call stack size exceeded'); }, parseShapeRecovering() { recovered = true; throw new Error('must not reenter exhausted runtime'); } };
  const boundary = new Parser(new Map([['.', runtime]]), '{}', {});
  assert.throws(() => boundary.parseTree('x'), NestingTooDeep);
  assert.equal(recovered, false);
});

test('causal diagnostics never replace strict successful shapes', () => {
  let diagnostics = 0;
  const shape = { strict: true };
  const runtime = { parseShape() { return shape; }, parseShapeWithCompatibility() { diagnostics++; throw new Error('unexpected reparse'); } };
  const boundary = new Parser(new Map([['.', runtime]]), '{}', {});
  assert.equal(boundary.parseShape('x'), shape);
  assert.equal(diagnostics, 0);
});
test('causal diagnostics fall back when their reparse accepts or exhausts resources', () => {
  for (const diagnostic of [() => ({ok: true, shape: null}), () => { throw new RangeError('Maximum call stack size exceeded'); }]) {
    const calls = [];
    const runtime = { parseShape() { calls.push('strict'); throw 'original strict refusal'; }, parseShapeWithCompatibility(input, mode) { calls.push(mode); return diagnostic(); }, parseShapeRecovering() { calls.push('deepest'); return {ok: false, error: {offset: 2}}; } };
    const boundary = new Parser(new Map([['.', runtime]]), '{}', {});
    assert.throws(() => boundary.parseShape('a/'), error => error.name === 'ParseError' && error.byteOffset === 2);
    assert.deepEqual(calls, ['strict', 'parslet', 'deepest']);
  }
});


test('typed SDK resources retain identity and metadata before diagnostic fallback', () => {
  for (const [name, category, depth, maxDepth] of [
    ['CallDepthLimitExceeded', 'call_depth_limit', 1025, 1024],
    ['RecursionLimitExceeded', 'recursion_limit', 1001, 1000],
    ['ShapeDepthLimitExceeded', 'shape_depth_limit', 513, 512],
  ]) {
    for (const phase of ['primary', 'causal', 'recovery']) {
      const resource = Object.assign(new Error('explicit runtime resource limit'), {name, category, depth, maxDepth});
      const calls = [];
      const runtime = {
        parseShape() { calls.push('primary'); if (phase === 'primary') throw resource; throw 'strict syntax refusal'; },
        parseShapeWithCompatibility() { calls.push('causal'); if (phase === 'causal') throw resource; return {ok:true,shape:null}; },
        parseShapeRecovering() { calls.push('recovery'); throw resource; },
      };
      const boundary = new Parser(new Map([['.', runtime]]), '{}', {});
      assert.throws(() => boundary.parseTree('x'), error => error === resource && error.category === category && error.depth === depth && error.maxDepth === maxDepth);
      assert.deepEqual(calls, phase === 'primary' ? ['primary'] : phase === 'causal' ? ['primary', 'causal'] : ['primary', 'causal', 'recovery']);
    }
  }
});


test('current WASM typed depth failures preserve metadata and parser reuse', () => {
  const nested = count => '('.repeat(count) + 'x' + ')'.repeat(count);
  for (const method of ['parseShape', 'parseTree', 'parseBindings', 'parse']) {
    assert.doesNotThrow(() => parser[method](nested(64)), `${method} accepts depth64`);
    for (const depth of [128, 256]) {
      assert.throws(() => parser[method](nested(depth)), error => error instanceof CallDepthLimitExceeded
        && error.name === 'CallDepthLimitExceeded' && error.category === 'call_depth_limit'
        && error.maxDepth === 1024 && error.depth === 1025);
      assert.doesNotThrow(() => parser[method]('x'), `${method} remains usable after depth${depth}`);
    }
  }
});


test('generic WASM traps retain identity without syntax diagnostics', () => {
  for (const message of ['memory access out of bounds', 'stack overflow']) {
    for (const phase of ['primary', 'causal', 'recovery']) {
      const trap = new WebAssembly.RuntimeError(message);
      const calls = [];
      const runtime = {
        parseShape() {calls.push('primary');if (phase === 'primary') throw trap;throw 'strict syntax refusal';},
        parseShapeWithCompatibility() {calls.push('causal');if (phase === 'causal') throw trap;return {ok:true,shape:null};},
        parseShapeRecovering() {calls.push('recovery');throw trap;},
      };
      const boundary = new Parser(new Map([['.', runtime]]), '{}', {});
      assert.throws(() => boundary.parseTree('x'), error => error === trap);
      assert.deepEqual(calls, phase === 'primary' ? ['primary'] : phase === 'causal' ? ['primary', 'causal'] : ['primary', 'causal', 'recovery']);
    }
  }
});
