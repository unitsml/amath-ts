# amath-ts

AsciiMath on the pinned amath PARG artifact and Parsanol WASM runtime.

```ts
import { initialize } from '@plurimath/amath-ts';
const parser = await initialize();
const model = parser.parse('alpha + 1.5');
const tree = parser.parseTree('x^2');
```

Parsing is synchronous after initialization. `parse` returns upstream-generated
LML model classes; `parseTree` returns the legacy capture tree, including wrapper
removal and expression renesting. Slice leaves are `{text, offset}`, with UTF-8
byte offsets. No preprocessing occurs in the stage. Decimal markers are `.`,
`,` and `٫`; source number text is retained.

`artifacts/manifest.json` pins the Ruby source and every vendored artifact.
`model/codegen-provenance.json` pins the upstream generator and generated files.
The generated model/codec sources consume an open upstream LML candidate; no
unpublished private package is presented as a registry dependency.

The default entry uses Node's Parsanol package. `./browser` exports `createParser`
for a caller-provided, initialized compatible WASM factory and the pinned artifact
bundle. It does not import Node builtins; the pinned SDK supplies its own browser
runtime. The Ruby interpreter fallback and pma dialect are explicitly unavailable
in this baseline. Refusal diagnostics use the Ruby-compatible policy below;
full diagnostic corpus qualification remains separate.

Run `npm ci`, `npm run build`, and `npm test`. CI checks 160 legacy trees,
10 offset-aware rows and 10 typed-model rows on Node 22/24 across three OSes.

CI also replays plurimath-testsuite asciimath generation 5, the generation the
Ruby amath gem replays, at the commit pinned in `scripts/corpus-pin.json`.
`npm run test:corpus -- <testsuite checkout>` checks the generation's snapshot
digest, provenance and payload checksums, then runs every raw-tree and
typed-model row through the packed package and compares the result with the
row's expected value. Rows replaced by an `-r2` sibling are skipped, as in
the Ruby replay. The legacy-oracle payloads hold Plurimath end-to-end output,
not an amath boundary, so they are counted and not run.
The package remains private; publication is a separate decision.

Refusal positions follow Ruby Amath's policy: strict parsing supplies successful shapes; only a refusal triggers the engine's Parslet-compatible causal diagnostic selector. If that diagnostic reparse accepts or has an untyped failure, the original strict engine's deepest failure is used. Typed SDK `CallDepthLimitExceeded`, `RecursionLimitExceeded` and `ShapeDepthLimitExceeded` errors propagate unchanged before any syntax fallback, preserving their `category`, `depth` and `maxDepth` metadata. Generic WebAssembly traps also retain their identity and are never retried as syntax diagnostics. This is one WASM engine with an explicit reporter policy. It does not invoke a legacy parser or switch successful binding shapes. The runtime is the published `parsanol` npm package, pinned to an exact version. Browser factories must supply `parseShapeWithCompatibility` too.
