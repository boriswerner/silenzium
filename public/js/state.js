/**
 * Zentraler Zustand. UI-Teile (heute: Übersicht, Tabellen; später: Timeline, ElevenLabs-Panel)
 * abonnieren Änderungen bestimmter Schlüssel, statt sich gegenseitig direkt aufzurufen.
 */
export class Store extends EventTarget {
  #state;

  constructor(initial) {
    super();
    this.#state = initial;
  }

  get state() {
    return this.#state;
  }

  update(patch) {
    this.#state = { ...this.#state, ...patch };
    this.dispatchEvent(new CustomEvent('change', { detail: { keys: Object.keys(patch) } }));
  }

  /** Ruft fn(state) auf, wenn sich einer der Schlüssel ändert. */
  on(keys, fn) {
    this.addEventListener('change', (e) => {
      if (e.detail.keys.some((k) => keys.includes(k))) fn(this.#state);
    });
  }
}
