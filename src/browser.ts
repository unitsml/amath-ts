import { legacyTree, type Tree, type Wrappers } from './tree.js';
import { DIGESTS } from './pins.js';
import { CATALOG } from './catalog.js';
import { decodeAmathModelDocument } from './generated/json/codecs.js';
import type { AmathModelDocument } from './generated/models.js';
export * as Model from './generated/index.js';
export * as modelJson from './generated/json/index.js';
export { SOURCE_COMMIT } from './pins.js';

export type Decimal = '.' | ',' | '٫';
export interface Options { decimal?: Decimal; engine?: 'auto' | 'wasm' | 'native' | 'ruby'; dialect?: 'legacy' | 'pma' }
export interface Runtime {
  parseShape(input: string): unknown;
  parseShapeWithCompatibility(input: string, compatibility: "strict" | "parslet"): { ok: boolean; shape?: unknown; error?: { offset?: number; ranked?: unknown } };
  applyBindingsArtifact(bindings: string, shape: unknown): Record<string, unknown>;
  parseShapeRecovering?(input: string): { ok: boolean; error?: { offset?: number; message?: string } };
}
export type RuntimeFactory = (artifact: string, entry: string) => Runtime | Promise<Runtime>;
export interface ArtifactBundle { artifact: string; bindings: string; wrappers: string }
export class ArtifactError extends Error { override name = 'ArtifactError'; }
export class EngineUnavailable extends Error { override name = 'EngineUnavailable'; }
export class NotInitializedError extends Error { override name = 'NotInitializedError'; }
export class ParseError extends Error {
  override name = 'ParseError';
  readonly category: string | null = null;
  readonly charOffset: number | null;
  constructor(message: string, readonly input: string, readonly byteOffset: number | null) {
    super(message);
    this.charOffset = byteOffset === null ? null : [...new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(input).subarray(0, byteOffset))].length;
  }
}
export class NestingTooDeep extends ParseError { override name = 'NestingTooDeep'; }

// The initialized SDK exports these typed errors from both Node and browser
// entries. Preserve the same object and metadata across this loader-neutral API.
function isTypedResourceLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const resource = error as { name?: unknown; category?: unknown; depth?: unknown; maxDepth?: unknown };
  return Number.isSafeInteger(resource.depth) && Number.isSafeInteger(resource.maxDepth)
    && (resource.name === 'CallDepthLimitExceeded' && resource.category === 'call_depth_limit'
      || resource.name === 'RecursionLimitExceeded' && resource.category === 'recursion_limit'
      || resource.name === 'ShapeDepthLimitExceeded' && resource.category === 'shape_depth_limit');
}

function isWasmTrap(error: unknown): boolean {
  return typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError;
}

const entries = { '.': 'dot', ',': 'comma', '٫': 'arabic' } as const;
/** Initialized, synchronous WASM parser. No preprocessing or alternate parser. */
export class Parser {
  readonly capabilities = Object.freeze({ engine: 'wasm', rubyFallback: false, diagnostics: 'parslet-causal-with-strict-fallback' as const, dialects: ['legacy'] as const });
  constructor(private readonly runtimes: ReadonlyMap<Decimal, Runtime>, private readonly bindings: string, private readonly wrappers: Wrappers) {}
  private run(input: string, options: Options = {}): { runtime: Runtime; shape: unknown; decimal: Decimal } {
    if (typeof input !== 'string') throw new TypeError('input must be a string');
    // TextEncoder replaces unpaired surrogates; accepting them would parse different bytes.
    if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(input)) !== input) throw new TypeError('input must contain valid Unicode scalar values');
    const decimal = options.decimal ?? '.';
    if (!Object.hasOwn(entries, decimal)) throw new RangeError(`unsupported decimal marker ${JSON.stringify(decimal)}`);
    if (options.dialect !== undefined && options.dialect !== 'legacy') throw new EngineUnavailable('pma is not part of this baseline runtime');
    if (options.engine === 'ruby') throw new EngineUnavailable('the Ruby interpreter is not available in the WASM runtime');
    if (options.engine !== undefined && !['auto', 'wasm', 'native'].includes(options.engine)) throw new RangeError('unknown engine');
    const runtime = this.runtimes.get(decimal)!;
    try { return { runtime, shape: runtime.parseShape(input), decimal }; }
    catch (error) {
      if (isTypedResourceLimit(error)) throw error;
      if (isWasmTrap(error)) throw error;
      const message = String(error);
      // Expected-token lists may contain names such as 'substack'. Only
      // runtime stack exhaustion is a resource refusal.
      const stackExhausted = error instanceof RangeError && /^Maximum call stack size exceeded$/i.test(error.message)
        || error instanceof Error && error.name === 'InternalError' && /^too much recursion$/i.test(error.message);
      if (stackExhausted) throw new NestingTooDeep(message, input, null);
      let offset: number | null = null;
      // Amath::ErrorPosition reparses only refusals with the causal Tree
      // policy. Diagnostic acceptance or an untyped failure uses the primary
      // deepest cause; typed SDK resources propagate without a syntax fallback.
      try {
        const causal = runtime.parseShapeWithCompatibility(input, 'parslet');
        if (!causal.ok && Number.isInteger(causal.error?.offset)) offset = causal.error!.offset!;
      } catch (diagnostic) {
        if (isTypedResourceLimit(diagnostic) || isWasmTrap(diagnostic)) throw diagnostic;
        // An untyped diagnostic refusal has no causal position.
      }
      if (offset === null) {
        try {
          const report = runtime.parseShapeRecovering?.(input);
          if (report && !report.ok && Number.isInteger(report.error?.offset)) offset = report.error!.offset!;
        } catch (recovery) {
          if (isTypedResourceLimit(recovery) || isWasmTrap(recovery)) throw recovery;
          // Preserve the primary refusal when recovery is unavailable.
        }
      }
      throw new ParseError(message, input, offset);
    }
  }
  /** Legacy capture tree, matching amath's RawTree.legacy/Renester boundary. */
  parseTree(input: string, options: Options = {}): Tree {
    const { shape } = this.run(input, options);
    return legacyTree(shape, input, this.wrappers);
  }
  /** PARG's normalized shape, before the legacy wrapper/chain adapter. */
  parseShape(input: string, options: Options = {}): unknown { return this.run(input, options).shape; }
  /** Declared TS bindings, before generated LML model construction. */
  parseBindings(input: string, options: Options = {}): { expression: unknown; decimal: Decimal } {
    const { runtime, shape, decimal } = this.run(input, options);
    if (!input.length) return { expression: null, decimal };
    const bound = runtime.applyBindingsArtifact(this.bindings, shape);
    return { expression: bound.expression, decimal };
  }
  /** Construct the generated LML class graph with stage catalog semantics. */
  parse(input: string, options: Options = {}): AmathModelDocument {
    const document = this.parseBindings(input, options);
    const pending: unknown[] = [document.expression];
    while (pending.length) {
      const node = pending.pop();
      if (Array.isArray(node)) { pending.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      const object = node as Record<string, unknown>;
      if (typeof object.spelling === 'string') {
        const spelling = object.spelling;
        let record = Object.hasOwn(CATALOG, spelling) ? CATALOG[spelling] : undefined;
        if (!record) {
          const stripped = spelling.replace(/^[\x00\t\n\v\f\r ]+|[\x00\t\n\v\f\r ]+$/g, '');
          if (stripped !== spelling && Object.hasOwn(CATALOG, stripped)) {
            const found = CATALOG[stripped];
            record = found.padded ?? found;
          }
        }
        object.value = record?.value ?? spelling;
        object.kind = record?.kind ?? 'unlisted';
      }
      pending.push(...Object.values(object));
    }
    return decodeAmathModelDocument(document);
  }
}

/** Browser callers provide the initialized upstream WASM factory explicitly. */
export async function createParser(bundle: ArtifactBundle, factory: RuntimeFactory): Promise<Parser> {
  let wrappers: Wrappers;
  try {
    for (const key of Object.keys(DIGESTS) as (keyof ArtifactBundle)[]) {
      const bytes = new TextEncoder().encode(bundle[key]);
      const actual = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (actual !== DIGESTS[key]) throw new Error(`${key} differs from the pinned amath source`);
    }
    const artifact = JSON.parse(bundle.artifact) as Record<string, unknown>;
    const bindings = JSON.parse(bundle.bindings) as Record<string, unknown>;
    if (bindings.target !== 'ts' || bindings.artifact_kind !== 'parg-bindings') throw new Error('expected TS bindings');
    if (artifact.source_hash !== bindings.grammar_source_hash) throw new Error('grammar/bindings source hash mismatch');
    wrappers = JSON.parse(bundle.wrappers).wrappers as Wrappers;
    if (!wrappers || typeof wrappers !== 'object') throw new Error('missing wrapper declarations');
  } catch (error) { throw new ArtifactError(`invalid artifact bundle: ${String(error)}`); }
  const runtimes = new Map<Decimal, Runtime>();
  for (const decimal of Object.keys(entries) as Decimal[]) {
    const runtime = await factory(bundle.artifact, entries[decimal]);
    if (typeof runtime.parseShapeWithCompatibility !== 'function') throw new EngineUnavailable('the runtime lacks causal diagnostic compatibility');
    runtimes.set(decimal, runtime);
  }
  return new Parser(runtimes, bundle.bindings, Object.freeze({ ...wrappers }));
}
export type { Tree, Slice } from './tree.js';
