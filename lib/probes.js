// Example probes. A probe is a question whose answer needs a real page: the
// client computes it from the live environment, the server knows what a
// genuine browser would say. The answer is mixed into the next epoch key.
//
// These two ask the layout engine to size a box. They are ILLUSTRATIVE: the
// answers are public, so anyone who reads this file can fake them. They show
// the mechanism and stop a naive port (Node, jsdom: no layout engine). A real
// deployment brings its own probes and calibrates them against real traffic
// before enforcing. See docs/DESIGN.md, "Layer 2".

function measure(css) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;visibility:hidden;left:-9999px;top:0;margin:0;border:0;' +
    'box-sizing:content-box;min-width:0;max-width:none;' +
    css;
  document.documentElement.appendChild(el);
  const width = el.offsetWidth;
  el.remove();
  return width;
}

const boxArgs = (arg) => ({ w: 40 + (arg & 0xff), pad: (arg >>> 8) & 0x1f });
const calcArgs = (arg) => ({ a: 3 + (arg & 0x3f), k: 2 + ((arg >>> 6) & 7), b: (arg >>> 9) & 0x7f });

/** Client side: needs a DOM with a layout engine. */
export const domProbes = {
  box(arg) {
    const { w, pad } = boxArgs(arg);
    return measure(`width:${w}px;padding:0 ${pad}px`);
  },
  calc(arg) {
    const { a, k, b } = calcArgs(arg);
    return measure(`padding:0;width:calc(${a}px * ${k} + ${b}px)`);
  },
};

/** Server side: what a real layout engine returns for the same arguments. */
export const domOracles = {
  box(arg) {
    const { w, pad } = boxArgs(arg);
    return w + 2 * pad;
  },
  calc(arg) {
    const { a, k, b } = calcArgs(arg);
    return a * k + b;
  },
};
