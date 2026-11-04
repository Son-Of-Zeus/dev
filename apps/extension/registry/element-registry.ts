import {
  toSafeSemanticElement,
  isVisible,
  type DiscoveredElement,
} from '../dom/semantic';

export type RegistryEntry = DiscoveredElement & {
  id: string;
};

export type SemanticElement = Omit<RegistryEntry, 'element'>;

export interface ElementRegistry {
  get(id: string): RegistryEntry | undefined;
  getLive(id: string): RegistryEntry | undefined;
  list(): RegistryEntry[];
  snapshot(): SemanticElement[];
  reconcile(next: DiscoveredElement[]): void;
  clear(): void;
}

export function createElementRegistry(): ElementRegistry {
  let idByElement = new WeakMap<HTMLElement, string>();
  let entries = new Map<string, RegistryEntry>();
  let nextId = 1;

  const getOrCreateId = (element: HTMLElement): string => {
    const existingId = idByElement.get(element);
    if (existingId) {
      return existingId;
    }

    const id = `el_${nextId}`;
    nextId += 1;
    idByElement.set(element, id);
    return id;
  };

  return {
    get(id) {
      return entries.get(id);
    },

    getLive(id) {
      const entry = entries.get(id);
      if (!entry?.element.isConnected || !isVisible(entry.element)) return undefined;
      return { ...entry, disabled: entry.disabled || entry.element.matches(':disabled') || entry.element.getAttribute('aria-disabled') === 'true' };
    },

    list() {
      return Array.from(entries.values());
    },

    snapshot() {
      return Array.from(entries.values()).map((entry) => ({
        id: entry.id,
        ...toSafeSemanticElement(entry),
      }));
    },

    reconcile(next) {
      const nextEntries = new Map<string, RegistryEntry>();
      const seenElements = new Set<HTMLElement>();

      for (const discovered of next) {
        if (seenElements.has(discovered.element)) {
          continue;
        }

        seenElements.add(discovered.element);
        const id = getOrCreateId(discovered.element);
        nextEntries.set(id, {
          id,
          ...discovered,
        });
      }

      entries = nextEntries;
    },

    clear() {
      entries = new Map();
      idByElement = new WeakMap();
    },
  };
}
