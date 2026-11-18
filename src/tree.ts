/** Port of pinned amath RawTree and Renester; no grammar rules live here. */
export interface Slice { readonly text: string; readonly offset: number }
export type Tree = null | string | Slice | Tree[] | { [capture: string]: Tree };
type RecordTree = { [capture: string]: Tree };
export type Wrappers = Readonly<Record<string, string>>;
const slice = (x: unknown): x is Slice => !!x && typeof x === 'object' && 'text' in x && 'offset' in x;
const hash = (x: Tree): x is RecordTree => x !== null && typeof x === 'object' && !Array.isArray(x) && !slice(x);
const text = (x: Tree): x is string | Slice => typeof x === 'string' || slice(x);
const content = (x: Tree): string => x === null ? '' : slice(x) ? x.text : String(x);

function join(values: Tree[]): Tree {
  const first = values.find(slice);
  const value = values.map(content).join('');
  return first ? { text: value, offset: first.offset } : value;
}
function merge(a: Tree, b: Tree): Tree {
  if (hash(a) && hash(b)) return { ...a, ...b };
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (slice(a) && slice(b)) return { text: a.text + b.text, offset: a.offset };
  if (text(a) && text(b)) return slice(b) ? b : a;
  if (text(a)) return b;
  if (text(b)) return a;
  if (Array.isArray(a) && hash(b)) return [...a, b];
  if (hash(a) && Array.isArray(b)) return [a, ...b];
  throw new TypeError('unsupported sequence shape in pinned amath grammar');
}
function fold(parts: Tree[]): Tree {
  const values = parts.filter(x => x !== null);
  return values.length ? values.slice(1).reduce(merge, values[0]) : '';
}
function repetition(values: Tree[]): Tree {
  if (values.some(hash)) return values.filter(hash);
  if (values.some(Array.isArray)) return values.flatMap(x => Array.isArray(x) ? x : []);
  return values.length ? join(values) : [];
}
/** Decode the PARG v2 shape while retaining every source byte offset. */
export function decodeShape(value: unknown, input: string): Tree {
  const bytes = new TextEncoder().encode(input);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  function walk(node: unknown): Tree {
    if (node == null) return null;
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object') throw new TypeError('unexpected PARG tree scalar');
    const object = node as Record<string, unknown>;
    if (typeof object.offset === 'number' && typeof object.length === 'number') {
      return { text: typeof object.value === 'string' ? object.value : decoder.decode(bytes.subarray(object.offset, object.offset + object.length)), offset: object.offset };
    }
    if (typeof object.tag === 'string' && Array.isArray(object.items)) {
      const items = object.items.map(walk);
      switch (object.tag.replace(/^:/, '')) {
        case 'sequence': return fold(items);
        case 'repetition': return items;
        case 'maybe': return items.length ? items[0] : null;
        default: throw new TypeError(`unsupported PARG shape tag ${object.tag}`);
      }
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, walk(child)]));
  }
  return walk(value);
}
function unwrap(value: Tree, wrappers: Wrappers): Tree {
  if (Array.isArray(value)) return repetition(value.map(x => unwrap(x, wrappers)));
  if (!hash(value)) return value;
  if (!Object.keys(value).some(k => Object.hasOwn(wrappers, k))) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v, wrappers)]));
  }
  const parts: Tree[] = [];
  let run: RecordTree | null = null;
  let onlyNil = true;
  for (const [key, child] of Object.entries(value)) {
    const kind = Object.hasOwn(wrappers, key) ? wrappers[key] : undefined;
    const unwrapped = unwrap(child, wrappers);
    if (!kind) { onlyNil = false; (run ??= {})[key] = unwrapped; continue; }
    if (run) { parts.push(run); run = null; }
    onlyNil &&= kind === 'nil';
    switch (kind) {
      case 'text': parts.push(unwrapped === null || Array.isArray(unwrapped) && !unwrapped.length ? '' : unwrapped); break;
      case 'empty': parts.push(''); break;
      case 'empty_list': parts.push([]); break;
      case 'list': parts.push(Array.isArray(unwrapped) && !unwrapped.length ? '' : unwrapped); break;
      case 'nil': parts.push(null); break;
      default: throw new TypeError(`unknown wrapper kind ${kind}`);
    }
  }
  if (run) parts.push(run);
  return onlyNil ? null : fold(parts);
}
function renest(tree: Tree): Tree {
  const done: Tree[] = [];
  const todo: [Tree, boolean][] = [[tree, false]];
  while (todo.length) {
    const [node, ready] = todo.pop()!;
    if (!hash(node) && !Array.isArray(node)) { done.push(node); continue; }
    const children = Array.isArray(node) ? node : Object.values(node);
    if (!ready) { todo.push([node, true]); for (let i = children.length - 1; i >= 0; i--) todo.push([children[i], false]); continue; }
    const values = done.splice(done.length - children.length, children.length);
    if (Array.isArray(node)) { done.push(values); continue; }
    if (!Object.hasOwn(node, 'amath_chain')) { done.push(Object.fromEntries(Object.keys(node).map((k, i) => [k, values[i]]))); continue; }
    const items = values[0];
    if (!Array.isArray(items)) throw new TypeError('amath_chain must be a list');
    const last = items.at(-1);
    let nested: Tree = last && hash(last) && Object.hasOwn(last, 'amath_end') ? last.amath_end : '';
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (!hash(item)) throw new TypeError('amath_chain item must be a capture');
      for (const [key, part] of Object.entries(item)) {
        const level = key === 'amath_step' ? 'expr' : key === 'amath_lr' ? 'left_right' : null;
        if (level) nested = { [level]: fold([part, nested]) };
      }
    }
    done.push(hash(nested) ? Object.values(nested)[0] : nested);
  }
  return done[0];
}
export function legacyTree(shape: unknown, input: string, wrappers: Wrappers): Tree {
  const decoded = decodeShape(shape, input);
  const root = hash(decoded) && Object.keys(decoded).length === 1 && Object.hasOwn(decoded, 'root') ? decoded.root : decoded;
  return renest(unwrap(root, wrappers));
}
