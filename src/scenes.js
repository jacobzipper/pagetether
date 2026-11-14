// Scenes: probes with no formula.
//
// A scene is a small random document: a tree of empty boxes and a stylesheet.
// The page builds it, lets the browser lay it out, and reads back where every
// box ended up. That list of numbers, hashed, is the answer.
//
// The server never computes an answer. It holds a pool of scenes whose answers
// were measured in real browsers ahead of time (scripts/bake.js) and kept only
// where every browser agreed. So there is nothing in this repository that
// turns a scene into its answer: the only thing that does is an engine that
// resolves the CSS cascade and runs block, float, flex, grid and positioned
// layout the way the browsers do. See docs/DESIGN.md, "Scenes".
//
//   scene       { t: tree, c: css }
//   tree        ["tag.class.class", ...children]     the root is "div.r"
//   pool entry  { t, c, d }                          d = digest, 16 hex digits

import { fmix32 } from './core.js';

const TAGS = ['div', 'section', 'aside'];
const CLASSES = ['a', 'b', 'c', 'd', 'e', 'f'];
const MAX_NODES = 64;
const MAX_CSS = 8192;

// A scene's stylesheet may not contain strings, escapes or anything that
// fetches, so a scene cannot make the page load a resource.
const CSS_ALPHABET = /^[a-z0-9\s.,:;>+~*(){}%!@/-]*$/;
const CSS_FORBIDDEN = /url\(|@import|@font-face|@namespace/;
const NODE = /^(div|section|aside)((?:\.[a-z]){0,4})$/;

// --- Digest -----------------------------------------------------------------

const rol = (x, n) => (x << n) | (x >>> (32 - n));

/** 64 bits over a list of integers, as [hi, lo]. A fingerprint of a layout, not a cryptographic hash. */
export function sceneDigest(values) {
  let a = 0x9e3779b1;
  let b = 0x7f4a7c15;
  for (const value of values) {
    const k = value | 0;
    a = (Math.imul(rol(a ^ Math.imul(k, 0xcc9e2d51), 13), 5) + 0xe6546b64) | 0;
    b = Math.imul(rol((b + Math.imul(k ^ 0x1b873593, 0x27d4eb2f)) | 0, 17), 9) ^ (a >>> 7);
  }
  return [fmix32(a ^ values.length), fmix32((b + values.length) | 0)];
}

export const digestToHex = (d) => d.map((n) => n.toString(16).padStart(8, '0')).join('');

export function digestFromHex(str) {
  if (typeof str !== 'string' || !/^[0-9a-f]{16}$/.test(str)) throw new TypeError('bad scene digest');
  return [parseInt(str.slice(0, 8), 16), parseInt(str.slice(8), 16)];
}

// --- Validation -------------------------------------------------------------

function countNodes(node, depth = 0) {
  if (!Array.isArray(node) || typeof node[0] !== 'string' || !NODE.test(node[0]) || depth > 6) return NaN;
  let n = 1;
  for (let i = 1; i < node.length; i++) n += countNodes(node[i], depth + 1);
  return n;
}

/** True if `scene` is something the renderer is willing to build. */
export function validScene(scene) {
  if (!scene || typeof scene.c !== 'string' || scene.c.length > MAX_CSS) return false;
  if (!CSS_ALPHABET.test(scene.c) || CSS_FORBIDDEN.test(scene.c)) return false;
  const n = countNodes(scene.t);
  return n >= 1 && n <= MAX_NODES;
}

/** Check and normalise a pool: [{ t, c, d }] with d as hex, to entries carrying a parsed digest. */
export function loadPool(pool) {
  const list = Array.isArray(pool) ? pool : pool?.scenes;
  if (!Array.isArray(list)) throw new TypeError('a scene pool is an array of { t, c, d }');
  return list.map((entry) => {
    if (!validScene(entry)) throw new TypeError('bad scene in pool');
    return { t: entry.t, c: entry.c, digest: digestFromHex(entry.d) };
  });
}

// --- Rendering (page side) --------------------------------------------------

// The host sits outside the page's flow and outside its styles. `all` leaves
// direction alone, so that is reset by hand: a right-to-left page must get the
// same answer.
// Every declaration is !important, so a page rule such as `* { margin: 3px
// !important }` cannot reach it either.
const HOST_STYLE = [
  ['all', 'initial'],
  ['direction', 'ltr'],
  ['unicode-bidi', 'normal'],
  ['display', 'block'],
  ['position', 'fixed'],
  ['left', '0'],
  ['top', '0'],
  ['width', '0'],
  ['height', '0'],
  ['overflow', 'hidden'],
  ['visibility', 'hidden'],
  ['pointer-events', 'none'],
];

// Width of the box used to measure page magnification, in CSS pixels.
const RULER = 4096;

function build(doc, node, out) {
  const [tag, ...classes] = node[0].split('.');
  const el = doc.createElement(tag);
  if (classes.length > 0) el.className = classes.join(' ');
  out.push(el);
  for (let i = 1; i < node.length; i++) el.appendChild(build(doc, node[i], out));
  return el;
}

/**
 * Lay a scene out and read it back: x, y, width and height of every box, in
 * tree order, relative to the root.
 *
 * Nothing here needs inline styles or markup parsing, so it works under a
 * strict Content-Security-Policy and with Trusted Types.
 *
 * @param {{ t: any[], c: string }} scene
 * @param {{ document?: Document, raw?: boolean }} [opts]  `raw` keeps fractions (for baking)
 * @returns {number[]}
 */
export function measureScene(scene, { document: doc = globalThis.document, raw = false } = {}) {
  if (!validScene(scene)) throw new TypeError('bad scene');
  const host = doc.createElement('div');
  for (const [name, value] of HOST_STYLE) host.style.setProperty(name, value, 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const els = [];
  const root = build(doc, scene.t, els);
  shadow.appendChild(root);
  try {
    const sheet = new doc.defaultView.CSSStyleSheet();
    sheet.replaceSync(scene.c);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    // Browsers from before constructable stylesheets (Safari < 16.4).
    const style = doc.createElement('style');
    style.textContent = scene.c;
    shadow.appendChild(style);
  }
  // A page that magnifies its root element (zoom, or a transform) magnifies
  // every rectangle read below. A second box of a known, large width sits
  // beside the host and is read the same way, which gives the factor to divide
  // back out. (offsetWidth is no use for this: it is rounded to a whole pixel,
  // which is a 0.3% error on a 320 pixel box and moves answers by a pixel.)
  const ruler = doc.createElement('div');
  for (const [name, value] of HOST_STYLE) ruler.style.setProperty(name, value, 'important');
  ruler.style.setProperty('width', `${RULER}px`, 'important');
  doc.documentElement.appendChild(host);
  doc.documentElement.appendChild(ruler);
  try {
    const base = root.getBoundingClientRect();
    const span = ruler.getBoundingClientRect().width;
    const scale = span > 0 ? span / RULER : 1;
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      // A box that was not generated (display: none or contents) reports zeros
      // in viewport coordinates. Keep them zeros, wherever the root happens to be.
      if (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0) out.push(0, 0, 0, 0);
      else out.push((r.left - base.left) / scale, (r.top - base.top) / scale, r.width / scale, r.height / scale);
    }
    return raw ? out : out.map((v) => Math.round(v) | 0);
  } finally {
    host.remove();
    ruler.remove();
  }
}

/** The scene answerer a page hands to the noise program. */
export function domScenes(doc = globalThis.document) {
  return (scene) => sceneDigest(measureScene(scene, { document: doc }));
}

// --- Generation (bake side) -------------------------------------------------
//
// There is deliberately no evaluator to go with this. The generator only has
// to produce stylesheets that are valid and varied; real browsers supply the
// answers, and scenes they disagree on are thrown away at bake time.
//
// Everything used here has been in all three engines since March 2022
// (Chrome 99, Firefox 97, Safari 15.4). No text, no borders, no images and no
// viewport units: those are where honest browsers differ.

/**
 * Roll one random scene.
 * @param {() => number} rand32  source of uniform uint32 values
 */
export function generateScene(rand32) {
  const int = (n) => rand32() % n;
  const pick = (list) => list[int(list.length)];
  const chance = (p) => rand32() < p * 0x100000000;
  const px = (lo, hi) => `${4 * (lo + int(hi - lo + 1))}px`;
  const call = (list) => pick(list)();

  // -- the tree: a root, three or four sections, their children, a few grandchildren
  const node = (kids = []) => {
    const classes = new Set();
    if (chance(0.9)) classes.add(pick(CLASSES));
    if (chance(0.3)) classes.add(pick(CLASSES));
    return [[pick(TAGS), ...classes].join('.'), ...kids];
  };
  const sections = [];
  for (let s = 0, n = 3 + int(2); s < n; s++) {
    const kids = [];
    for (let k = 0, m = 2 + int(4); k < m; k++) {
      const grandkids = [];
      if (chance(0.25)) for (let g = 0, q = 1 + int(3); g < q; g++) grandkids.push(node());
      kids.push(node(grandkids));
    }
    sections.push(node(kids));
  }
  const tree = ['div.r', ...sections];

  // -- values
  const len = () =>
    call([
      () => px(2, 24),
      () => px(2, 24),
      () => `calc(var(--u) * ${1 + int(8)})`,
      () => `${pick([20, 25, 40, 50, 60, 75, 100])}%`,
      () => `calc(${pick([25, 50, 100])}% - ${px(1, 6)})`,
      () => `max(${px(4, 12)}, ${pick([25, 50])}%)`,
      () => `min(${px(8, 30)}, ${pick([50, 75, 100])}%)`,
      () => `clamp(${px(2, 8)}, ${pick([20, 25, 50])}%, ${px(10, 30)})`,
      () => `var(--w, ${px(4, 20)})`,
      () => `calc(var(--w, ${px(2, 10)}) + var(--u))`,
    ]);
  const gap = () => pick(['0', '4px', '8px', '12px', 'var(--g)']);
  const nth = () => pick(['2', '3', 'odd', 'even', '2n+1', '3n', 'n+2', '-n+2', '3n+1']);
  const align = () => pick(['stretch', 'flex-start', 'center', 'flex-end']);
  const place = () => pick(['stretch', 'start', 'center', 'end']);
  const transform = () =>
    call([
      () => `translate(${px(-6, 6)}, ${px(-6, 6)})`,
      () => `translate(${pick([50, 100, -50])}%, ${pick([0, 50, -100])}%)`,
      () => `scale(${pick(['2', '.5', '-1, 1', '1, 2'])})`,
      () => `rotate(${pick([90, 180, 270])}deg)`,
      () => `rotate(90deg) translate(${px(1, 6)}, 0)`,
    ]);

  // -- what the children of each kind of container may be given
  const kid = {
    flex: () =>
      call([
        () => `flex:${int(3)} ${int(2)} ${pick([px(4, 24), '0', 'auto', len()])}`,
        () => `width:${len()}`,
        () => `height:${px(2, 16)}`,
        () => `height:auto;align-self:${align()}`,
        () => `order:${int(4) - 1}`,
        () => `margin-left:auto`,
        () => `margin:${px(0, 3)} ${px(0, 4)}`,
        () => `min-width:${px(4, 16)}`,
        () => `max-width:${px(6, 20)}`,
        () => `flex-grow:${1 + int(3)}`,
        () => `flex-shrink:0;flex-basis:${len()}`,
      ]),
    grid: () =>
      call([
        () => `grid-column:span ${2 + int(2)}`,
        () => `grid-row:span 2`,
        () => `grid-column:${1 + int(3)} / ${pick(['-1', 'span 2', '4'])}`,
        () => `grid-column:1 / -1`,
        () => `justify-self:${place()};width:${len()}`,
        () => `align-self:${place()};height:${px(2, 8)}`,
        () => `margin:${px(0, 3)}`,
        () => `grid-row:${1 + int(2)};grid-column:${1 + int(3)}`,
      ]),
    block: () =>
      call([
        () => `height:${px(2, 14)}`,
        () => `width:${len()}`,
        () => `margin:${px(0, 4)} 0 ${px(0, 4)}`,
        () => `margin:0 auto;width:${len()}`,
        () => `margin-top:${px(1, 5)}`,
        () => `margin-bottom:${px(1, 5)}`,
        () => `float:${pick(['left', 'right'])};width:${px(6, 24)};height:${px(3, 12)}`,
        () => `clear:${pick(['both', 'left', 'right'])}`,
        () => `padding:${px(1, 4)}`,
        () => `margin-left:${len()}`,
      ]),
    abs: () =>
      call([
        () => `left:${px(0, 20)};top:${px(0, 10)};width:${len()};height:${px(2, 12)}`,
        () => `inset:${px(0, 4)} ${px(0, 10)} ${px(0, 4)} ${px(0, 10)}`,
        () => `right:${px(0, 12)};bottom:${px(0, 6)};width:${len()};height:${px(2, 10)}`,
        () => `left:${pick([10, 20, 25, 50])}%;width:${pick([20, 25, 50])}%;top:0;bottom:0`,
        () => `inset:0;margin:auto;width:${px(6, 20)};height:${px(3, 10)}`,
        () => `left:${px(0, 8)};right:${px(0, 8)};top:${pick([25, 50])}%;height:${px(2, 8)}`,
        () => `left:50%;top:50%;width:${px(6, 16)};height:${px(4, 10)};transform:translate(-50%, -50%)`,
      ]),
  };

  // -- what any box may be given by a class rule
  const any = () =>
    call([
      () => `width:${len()}`,
      () => `height:${px(2, 20)}`,
      () => `min-width:${len()}`,
      () => `max-width:${len()}`,
      () => `min-height:${px(2, 12)}`,
      () => `max-height:${px(4, 16)}`,
      () => `margin:${px(0, 4)}`,
      () => `margin-left:${pick(['auto', px(1, 8), 'var(--g)'])}`,
      () => `margin-top:${px(1, 6)}`,
      () => `padding:${px(1, 4)} ${px(0, 4)}`,
      () => `box-sizing:${pick(['border-box', 'content-box'])}`,
      () => `flex-grow:${int(4)}`,
      () => `flex-shrink:${int(3)}`,
      () => `flex-basis:${len()}`,
      () => `order:${int(5) - 2}`,
      () => `align-self:${align()}`,
      () => `justify-self:${place()}`,
      () => `grid-column:${pick(['span 2', '1 / -1', '2', 'auto'])}`,
      () => `grid-row:span 2`,
      () => `position:relative;left:${px(-6, 6)};top:${px(-4, 4)}`,
      () => `transform:${transform()}`,
      () => `transform-origin:${pick(['0 0', '100% 100%', 'center', '0 100%'])}`,
      () => `aspect-ratio:${pick(['1', '2 / 1', '1 / 2', '4 / 3'])};height:auto`,
      () => `--u:${pick([4, 6, 8, 10, 12])}px`,
      () => `--w:${px(3, 16)}`,
      () => `--g:${pick([0, 4, 8, 16])}px`,
      () => `float:${pick(['left', 'right', 'none'])}`,
      () => `display:${pick(['none', 'contents', 'block', 'flex', 'grid'])}`,
    ]);

  const rules = [];
  const u = pick([4, 6, 8, 10, 12]);
  const width = 240 + 60 * int(9);
  const rootLayout = call([
    () => '',
    () => '',
    () => `display:flex;flex-wrap:wrap;align-items:flex-start;gap:${gap()};`,
    () => `display:grid;grid-template-columns:${pick(['1fr 1fr', '2fr 1fr', '1fr 120px'])};gap:${gap()};align-items:start;`,
    () => `display:flex;flex-direction:column;align-items:${pick(['stretch', 'flex-start', 'flex-end'])};gap:${gap()};`,
  ]);
  rules.push(`.r{position:relative;width:${width}px;--u:${u}px;--g:${pick([4, 8, 12])}px;${rootLayout}}`);

  sections.forEach((section, index) => {
    const S = `.r>:nth-child(${index + 1})`;
    const kind = pick(['flex', 'flex', 'grid', 'grid', 'block', 'block', 'abs']);
    const sized = `width:${pick(['100%', '100%', '75%', '50%', px(30, 90), 'auto'])};`;
    if (kind === 'flex') {
      const column = chance(0.25);
      rules.push(
        `${S}{display:flex;flex-direction:${column ? pick(['column', 'column-reverse']) : pick(['row', 'row', 'row-reverse'])};` +
          `flex-wrap:${pick(['nowrap', 'wrap', 'wrap', 'wrap-reverse'])};gap:${gap()};` +
          `justify-content:${pick(['flex-start', 'center', 'flex-end', 'space-between', 'space-evenly'])};` +
          `align-items:${align()};align-content:${pick(['flex-start', 'center', 'stretch', 'space-between'])};` +
          `${sized}${column || chance(0.4) ? `height:${px(12, 40)};` : ''}padding:${pick(['0', '4px', '8px', '4px 8px'])}}`,
      );
      rules.push(`${S}>*{flex:${int(3)} ${int(2)} ${px(6, 30)};height:${px(3, 12)}}`);
    } else if (kind === 'grid') {
      rules.push(
        `${S}{display:grid;grid-template-columns:${pick([
          'repeat(3, 1fr)',
          'repeat(4, 1fr)',
          '40px 1fr 2fr',
          '1fr 80px 1fr',
          'minmax(40px, 1fr) 2fr',
          'repeat(2, minmax(0, 1fr)) 60px',
          'repeat(3, calc(var(--u) * 6))',
        ])};grid-auto-rows:${pick(['16px', '24px', '32px', 'minmax(20px, auto)'])};gap:${gap()};` +
          `grid-auto-flow:${pick(['row', 'row', 'row dense'])};justify-items:${place()};align-items:${place()};` +
          `${sized}padding:${pick(['0', '4px', '8px'])}}`,
      );
      rules.push(`${S}>*{min-width:${px(2, 8)};min-height:${px(2, 6)}}`);
    } else if (kind === 'block') {
      rules.push(`${S}{display:${pick(['block', 'flow-root'])};${sized}padding:${pick(['0', '0', '4px', '8px 4px'])}}`);
      rules.push(`${S}>*{height:${px(2, 10)};margin:${px(0, 3)} 0}`);
    } else {
      rules.push(`${S}{position:relative;${sized}height:${px(12, 30)}}`);
      rules.push(`${S}>*{position:absolute;${kid.abs()}}`);
    }
    for (let i = 0, n = 2 + int(3); i < n; i++) {
      rules.push(`${S}>${pick([`:nth-child(${nth()})`, `:nth-child(${nth()})`, ':last-child', ':first-child', `:nth-last-child(${1 + int(2)})`])}{${kid[kind]()}}`);
    }
    section.slice(1).forEach((child, at) => {
      if (child.length === 1) return;
      const K = `${S}>:nth-child(${at + 1})`;
      if (chance(0.5)) {
        rules.push(`${K}{display:flex;flex-wrap:${pick(['nowrap', 'wrap'])};gap:${gap()};align-items:${align()};min-height:${px(3, 8)}}`);
        rules.push(`${K}>*{flex:${int(2)} ${int(2)} ${px(3, 10)};min-height:${px(1, 4)}}`);
      } else if (chance(0.5)) {
        rules.push(`${K}{display:grid;grid-template-columns:${pick(['1fr 1fr', '1fr 2fr', 'repeat(3, 1fr)'])};gap:${gap()}}`);
        rules.push(`${K}>*{height:${px(1, 5)}}`);
      } else {
        rules.push(`${K}>*{height:${px(1, 5)};margin:${px(0, 2)} ${px(0, 4)}}`);
      }
    });
  });

  // -- class rules: these collide with the rules above and with each other, so
  //    the cascade (specificity, order, importance, layers) decides the layout
  const cls = () => `.${pick(CLASSES)}`;
  const selector = () =>
    call([
      () => cls(),
      () => cls(),
      () => `${cls()}${cls()}`,
      () => `${pick(TAGS)}${cls()}`,
      () => `${cls()}>${cls()}`,
      () => `${cls()} ${cls()}`,
      () => `${cls()}+${cls()}`,
      () => `${cls()}~${pick(TAGS)}`,
      () => `${cls()}:nth-child(${nth()})`,
      () => `${cls()}:not(${cls()})`,
      () => `:is(${cls()}, ${cls()})>${pick(TAGS)}`,
      () => `:where(${cls()}) ${cls()}`,
      () => `${cls()}:${pick(['first-child', 'last-child', 'only-child', 'empty', 'not(:empty)', 'not(:last-child)'])}`,
      () => `${pick(TAGS)}:nth-of-type(${nth()})`,
      () => `:is(section, aside)${cls()}`,
      () => `>*>:nth-child(${nth()})`,
      () => `>:not(:first-child)>${pick([':last-child', cls(), pick(TAGS)])}`,
      () => `>*>*>${pick(['*', cls()])}`,
    ]);
  const layers = chance(0.5) ? ['p', 'q'] : ['q', 'p'];
  const wrapped = [];
  for (let i = 0, n = 6 + int(6); i < n; i++) {
    const decls = [];
    for (let k = 0, m = 1 + int(3); k < m; k++) decls.push(any() + (chance(0.15) ? '!important' : ''));
    const rule = `.r ${selector()}{${decls.join(';')}}`;
    wrapped.push(
      call([
        () => rule,
        () => rule,
        () => rule,
        () => `@layer ${pick(layers)}{${rule}}`,
        () => `@layer ${pick(layers)}{${rule}}`,
        () => `@supports ${pick(['(display:grid)', '(display:nonsense)', 'not (display:nonsense)'])}{${rule}}`,
        () => `@media ${pick(['(min-width:0px)', 'not all'])}{${rule}}`,
      ]),
    );
  }

  const css = [`@layer ${layers.join(',')};`, ...rules, ...wrapped].join('\n');
  return { t: tree, c: css };
}
