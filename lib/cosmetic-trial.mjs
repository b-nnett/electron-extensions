// A single, explicitly selected element in an already connected page only.
// This does not launch/discover apps, establish endpoint ownership, inspect
// account data, execute JavaScript, prove interaction, or verify bundle signing.
// The caller must do those applicable checks separately. No reload/reapplication
// is attempted. A nonzero box does not prove the element is onscreen/unobscured.
// Dynamic pages and long CSS transitions can make appearance checks inconclusive.

const GREEN = Object.freeze({
  background: 'rgb(22, 163, 74)',
  color: 'rgb(255, 255, 255)',
  backgroundImage: 'none'
});
const sameAppearance = (a, b) => Object.keys(GREEN).every(key => a[key] === b[key]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class CosmeticTrial {
  #cdp;
  #selector;
  #sheet = null;
  #original = null;
  #disposed = false;
  #queue = Promise.resolve();

  constructor(cdp, selector) {
    if (!cdp || typeof cdp.call !== 'function') throw new TypeError('An already connected CDP client is required.');
    if (typeof selector !== 'string' || !selector.trim() || selector.length > 2048 ||
        /[{};\x00-\x1f\x7f]/.test(selector) || selector.includes('/*') || selector.includes('*/')) {
      throw new TypeError('Supply one bounded CSS selector without rule delimiters or comments.');
    }
    this.#cdp = cdp;
    this.#selector = selector.trim();
  }

  #enqueue(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  #requireReady() {
    if (this.#disposed) throw new Error('Cosmetic trial is disposed.');
    if (!this.#original) throw new Error('Initialize the cosmetic trial first.');
  }

  async #read() {
    const { root } = await this.#cdp.call('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await this.#cdp.call('DOM.querySelectorAll', {
      nodeId: root.nodeId, selector: this.#selector
    });
    if (nodeIds.length !== 1) throw new Error('The supplied selector must match exactly one element.');
    const [{ computedStyle }, { model }] = await Promise.all([
      this.#cdp.call('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] }),
      this.#cdp.call('DOM.getBoxModel', { nodeId: nodeIds[0] })
    ]);
    if (!model || !Number.isFinite(model.width) || !Number.isFinite(model.height) ||
        model.width <= 0 || model.height <= 0) {
      throw new Error('The selected element has no nonzero layout box.');
    }
    const values = Object.fromEntries(computedStyle.map(({ name, value }) => [name, value]));
    const snapshot = {
      background: values['background-color'],
      color: values.color,
      backgroundImage: values['background-image'],
      box: Object.freeze({ width: model.width, height: model.height })
    };
    if (Object.keys(GREEN).some(key => typeof snapshot[key] !== 'string')) {
      throw new Error('The selected element did not expose the required computed colors.');
    }
    return Object.freeze(snapshot);
  }

  async #observe(expected) {
    const deadline = Date.now() + 1000;
    let snapshot;
    do {
      snapshot = await this.#read();
      if (sameAppearance(snapshot, expected) || Date.now() >= deadline) return snapshot;
      await delay(100);
    } while (true);
  }

  async #clear() {
    if (this.#sheet !== null) {
      await this.#cdp.call('CSS.setStyleSheetText', { styleSheetId: this.#sheet, text: '' });
    }
  }

  init() {
    return this.#enqueue(async () => {
      if (this.#disposed) throw new Error('Cosmetic trial is disposed.');
      if (this.#original) return this.#original;
      await this.#cdp.call('Page.enable');
      await this.#cdp.call('DOM.enable');
      await this.#cdp.call('CSS.enable');
      this.#original = await this.#read();
      return this.#original;
    });
  }

  inspect() {
    return this.#enqueue(() => { this.#requireReady(); return this.#read(); });
  }

  apply() {
    return this.#enqueue(async () => {
      this.#requireReady();
      try {
        // Recheck the selector before creating or writing our own stylesheet.
        await this.#read();
        if (this.#sheet === null) {
          const { frameTree } = await this.#cdp.call('Page.getFrameTree');
          const { styleSheetId } = await this.#cdp.call('CSS.createStyleSheet', {
            frameId: frameTree.frame.id, force: true
          });
          this.#sheet = styleSheetId;
        }
        await this.#cdp.call('CSS.setStyleSheetText', {
          styleSheetId: this.#sheet,
          text: `${this.#selector} { background-color: ${GREEN.background} !important; color: ${GREEN.color} !important; background-image: none !important; }`
        });
        const applied = await this.#observe(GREEN);
        return { original: this.#original, applied, matchesExpected: sameAppearance(applied, GREEN) };
      } catch (error) {
        try { await this.#clear(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Cosmetic trial failed and its stylesheet could not be cleared.');
        }
        throw error;
      }
    });
  }

  remove() {
    return this.#enqueue(async () => {
      this.#requireReady();
      await this.#clear();
      const restored = await this.#observe(this.#original);
      return { original: this.#original, restored, matchesOriginal: sameAppearance(restored, this.#original) };
    });
  }

  dispose() {
    return this.#enqueue(async () => {
      if (this.#disposed) return;
      // Do not close a borrowed CDP connection or disable its shared domains.
      // If clearing fails, report it and permit a later cleanup attempt.
      await this.#clear();
      this.#disposed = true;
    });
  }
}
