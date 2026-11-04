import { redactSensitiveText } from '../safety/safety';

export const CANDIDATE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[role]',
  '[tabindex]',
  '[contenteditable="true"]',
  '[onclick]',
].join(',');

const MAX_LABEL_LENGTH = 160;
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const SUPPORTED_SEMANTIC_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'tab',
  'interactive',
]);

export type ValidationState = 'unknown' | 'valid' | 'invalid';

export type DiscoveredElement = {
  role: string;
  label: string;
  section?: string;
  visible: boolean;
  inViewport: boolean;
  disabled: boolean;
  hasValue?: boolean;
  validationState?: ValidationState;
  element: HTMLElement;
};

export type SafeSemanticElement = Omit<DiscoveredElement, 'element'>;

export type PageEvidence = { kind: 'heading' | 'status' | 'alert' | 'text'; text: string };

export type SemanticPageSnapshot = {
  page: {
    title?: string;
    section?: string;
    status?: string;
    evidence?: PageEvidence[];
  };
  elements: SafeSemanticElement[];
};

export type Viewport = {
  width: number;
  height: number;
};

export type SemanticExtractionOptions = {
  viewport?: Viewport;
};

export type SemanticScannerOptions = SemanticExtractionOptions & {
  root?: ParentNode;
  debounceMs?: number;
};

export type SemanticScanner = {
  scan(): SemanticPageSnapshot;
  getDiscovered?(): DiscoveredElement[];
  start(): void;
  stop(): void;
  subscribe(listener: (snapshot: SemanticPageSnapshot) => void): () => void;
};

function getOwnerDocument(root: ParentNode): Document {
  if (root.nodeType === Node.DOCUMENT_NODE) {
    return root as Document;
  }

  return root.ownerDocument ?? document;
}

function getViewport(documentNode: Document, viewport?: Viewport): Viewport {
  if (viewport) {
    return viewport;
  }

  const windowNode = documentNode.defaultView;
  return {
    width: windowNode?.innerWidth ?? 0,
    height: windowNode?.innerHeight ?? 0,
  };
}

function normalizeLabel(value: string | null | undefined): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';

  if (normalized.length <= MAX_LABEL_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value));
}

export function composedParent(element: HTMLElement): HTMLElement | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host as HTMLElement : null;
}

export function isCompanionNode(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.localName === 'voice-companion-root' || current.dataset.voiceCompanionApp === 'true') return true;
    current = composedParent(current);
  }
  return false;
}

export function semanticRoots(root: ParentNode): ParentNode[] {
  const roots = [root];
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.shadowRoot && !isCompanionNode(element)) roots.push(...semanticRoots(element.shadowRoot));
  }
  return roots;
}

function safeText(element: Element | null | undefined): string | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  let ancestor: HTMLElement | null = element;
  while (ancestor) {
    if (ancestor.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return undefined;
    ancestor = composedParent(ancestor);
  }
  const read = (node: Node): string => {
    if (node instanceof HTMLElement && (node.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], script, style, noscript') || !isVisible(node) || isCompanionNode(node))) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    return Array.from(node.childNodes).map(read).join(' ');
  };
  return read(element);
}

function hasHiddenAncestor(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;

  while (current) {
    if (
      current.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      current.getAttribute('inert') !== null ||
      current.ownerDocument.defaultView?.getComputedStyle(current).display === 'none' ||
      current.ownerDocument.defaultView?.getComputedStyle(current).visibility === 'hidden' ||
      current.ownerDocument.defaultView?.getComputedStyle(current).opacity === '0'
    ) {
      return true;
    }

    current = composedParent(current);
  }

  return false;
}

export function isVisible(element: HTMLElement): boolean {
  if (hasHiddenAncestor(element)) {
    return false;
  }

  const windowNode = element.ownerDocument.defaultView;
  if (!windowNode) {
    return true;
  }

  const style = windowNode.getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    style.opacity !== '0'
  );
}

export function isInViewport(
  element: HTMLElement,
  viewport?: Viewport,
): boolean {
  if (!isVisible(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }

  const bounds = getViewport(element.ownerDocument, viewport);
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < bounds.height &&
    rect.left < bounds.width
  );
}

function inferRole(element: HTMLElement): string {
  const explicitRole = element.getAttribute('role')?.trim();
  if (explicitRole) {
    return explicitRole.split(/\s+/)[0] ?? 'interactive';
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === 'button') {
    return 'button';
  }
  if (tagName === 'a') {
    return 'link';
  }
  if (tagName === 'select') {
    return 'combobox';
  }
  if (tagName === 'textarea' || element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
    return 'textbox';
  }
  if (tagName === 'input') {
    const inputType = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (['button', 'image', 'reset', 'submit'].includes(inputType)) {
      return 'button';
    }
    if (inputType === 'checkbox') {
      return 'checkbox';
    }
    if (inputType === 'radio') {
      return 'radio';
    }
    if (inputType === 'range') {
      return 'slider';
    }
    return 'textbox';
  }

  return 'interactive';
}

function getAriaLabelledBy(element: HTMLElement): string | undefined {
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  if (ids.length === 0) {
    return undefined;
  }

  const labels = ids
    .map((id) => safeText((element.getRootNode() as Document | ShadowRoot).getElementById(id)))
    .filter((value): value is string => Boolean(value));

  return normalizeLabel(labels.join(' ')) || undefined;
}

function getAssociatedLabel(element: HTMLElement): string | undefined {
  if ('labels' in element) {
    const labels = (element as HTMLInputElement).labels;
    const label = safeText(labels?.[0]);
    if (label) {
      return normalizeLabel(label);
    }
  }

  const id = element.getAttribute('id');
  if (id) {
    const label = Array.from(
      (element.getRootNode() as ParentNode).querySelectorAll('label'),
    ).find((candidate) => candidate.htmlFor === id);
    if (label) {
      return normalizeLabel(safeText(label));
    }
  }

  const wrappingLabel = element.closest('label');
  return wrappingLabel ? normalizeLabel(safeText(wrappingLabel)) : undefined;
}

function getOwnText(element: HTMLElement): string | undefined {
  return normalizeLabel(safeText(element)) || undefined;
}

function getNearbyText(element: HTMLElement): string | undefined {
  let previous = element.previousElementSibling;
  let inspected = 0;

  while (previous && inspected < 2) {
    if (previous.matches('label, legend, [data-label], h1, h2, h3, h4, h5, h6')) {
      return normalizeLabel(safeText(previous)) || undefined;
    }

    previous = previous.previousElementSibling;
    inspected += 1;
  }

  const row = element.closest(
    'fieldset, [role="group"], .form-row, .form-group, li, td, div',
  );
  const rowLabel = row?.querySelector('label, legend, h1, h2, h3, h4, h5, h6');
  return rowLabel ? normalizeLabel(safeText(rowLabel)) || undefined : undefined;
}

function getLabel(element: HTMLElement, role: string): string {
  return (
    firstNonEmpty([
      normalizeLabel(element.getAttribute('aria-label')) || undefined,
      getAriaLabelledBy(element),
      getAssociatedLabel(element),
      getOwnText(element),
      normalizeLabel(element.getAttribute('title')) || undefined,
      normalizeLabel(element.getAttribute('placeholder')) || undefined,
      getNearbyText(element),
      normalizeLabel(element.getAttribute('name')) || undefined,
    ]) ?? role
  );
}

function getSection(element: HTMLElement): string | undefined {
  const container = element.closest(
    'fieldset, section, form, [role="region"], [role="group"]',
  );
  const containerHeading = container?.querySelector<HTMLElement>(HEADING_SELECTOR);
  if (containerHeading && isVisible(containerHeading)) {
    return normalizeLabel(safeText(containerHeading)) || undefined;
  }

  let nearestHeading: HTMLElement | undefined;
  for (const heading of Array.from(
    (element.getRootNode() as ParentNode).querySelectorAll<HTMLElement>(HEADING_SELECTOR),
  )) {
    if (
      isVisible(heading) &&
      Boolean(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
    ) {
      nearestHeading = heading;
    }
  }

  return nearestHeading
    ? normalizeLabel(safeText(nearestHeading)) || undefined
    : undefined;
}

function getHasValue(element: HTMLElement): boolean | undefined {
  const tagName = element.tagName.toLowerCase();

  if (tagName === 'input') {
    const input = element as HTMLInputElement;
    const inputType = (input.type || 'text').toLowerCase();
    return ['checkbox', 'radio'].includes(inputType)
      ? input.checked
      : input.value.length > 0;
  }

  if (tagName === 'textarea') {
    return (element as HTMLTextAreaElement).value.length > 0;
  }

  if (tagName === 'select') {
    const select = element as HTMLSelectElement;
    return select.selectedIndex >= 0 && select.value.length > 0;
  }

  if (element.getAttribute('contenteditable') === 'true') {
    return Boolean(element.textContent?.trim());
  }

  return undefined;
}

function getValidationState(
  element: HTMLElement,
  hasValue: boolean | undefined,
): ValidationState | undefined {
  const explicitState = element.getAttribute('data-validation-state');
  if (explicitState === 'valid' || explicitState === 'invalid') {
    return explicitState;
  }

  const ariaInvalid = element.getAttribute('aria-invalid');
  if (ariaInvalid === 'true') {
    return 'invalid';
  }
  if (ariaInvalid === 'false') {
    return 'valid';
  }

  if (hasValue && 'validity' in element) {
    return (element as HTMLInputElement).validity.valid ? 'valid' : 'invalid';
  }

  return hasValue === undefined ? undefined : 'unknown';
}

export function readSafeControlState(element: HTMLElement): {
  hasValue?: boolean;
  validationState?: ValidationState;
} {
  const hasValue = getHasValue(element);
  return {
    hasValue,
    validationState: getValidationState(element, hasValue),
  };
}

function isDisabled(element: HTMLElement): boolean {
  return (
    element.getAttribute('aria-disabled') === 'true' ||
    element.matches(':disabled')
  );
}

export function discoverSemanticElements(
  root: ParentNode = document,
  options: SemanticExtractionOptions = {},
): DiscoveredElement[] {
  return semanticRoots(root).flatMap((scope) => Array.from(scope.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)))
    .filter((element) => !isCompanionNode(element) && isVisible(element))
    .map((element) => {
      const role = inferRole(element);
      const controlState = readSafeControlState(element);

      return {
        role,
        label: getLabel(element, role),
        section: getSection(element),
        visible: true,
        inViewport: isInViewport(element, options.viewport),
        disabled: isDisabled(element),
        hasValue: controlState.hasValue,
        validationState: controlState.validationState,
        element,
      } satisfies DiscoveredElement;
    })
    .filter((entry) => SUPPORTED_SEMANTIC_ROLES.has(entry.role));
}

export function toSafeSemanticElement(
  entry: DiscoveredElement,
): SafeSemanticElement {
  const safeEntry: SafeSemanticElement = {
    role: entry.role,
    label: entry.label,
    section: entry.section,
    visible: entry.visible,
    inViewport: entry.inViewport,
    disabled: entry.disabled,
  };

  if (entry.hasValue !== undefined) {
    safeEntry.hasValue = entry.hasValue;
  }
  if (entry.validationState !== undefined) {
    safeEntry.validationState = entry.validationState;
  }

  return safeEntry;
}

function getPageContext(documentNode: Document): SemanticPageSnapshot['page'] {
  const page: SemanticPageSnapshot['page'] = {};
  const title = normalizeLabel(documentNode.title);
  const section = Array.from(
    documentNode.querySelectorAll<HTMLElement>('h1'),
  ).find((heading) => isVisible(heading) && !isCompanionNode(heading));

  if (title) {
    page.title = title;
  }
  if (section) {
    page.section = normalizeLabel(safeText(section)) || undefined;
  }

  // Read only semantic result text. Remove current form values locally before transport.
  const roots = semanticRoots(documentNode);
  const privateValues = roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')))
    .flatMap((control) => control instanceof HTMLSelectElement
      ? [control.value, ...Array.from(control.selectedOptions).map((option) => option.textContent ?? '')]
      : [control.value]);
  privateValues.push(...roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')).map((node) => node.textContent ?? '')));
  const valuesToRedact = [...new Set(privateValues.filter(Boolean))].sort((a, b) => b.length - a.length);
  const clean = (value: string): string => {
    let text = value;
    for (const privateValue of valuesToRedact) text = text.replaceAll(privateValue, '[redacted]');
    return redactSensitiveText(text).replace(/\s+/g, ' ').trim().slice(0, 240);
  };
  const evidence: PageEvidence[] = [];
  const seen = new Set<string>();
  const selectors = [
    ['alert', '[role="alert"]'],
    ['status', '[role="status"], output:not([for])'],
    ['status', '[role="tab"][aria-selected="true"], [aria-current="page"]'],
    ['heading', 'h1, h2, h3'],
    ['text', 'main p, [role="main"] p, [role="dialog"] p'],
  ] as const;
  for (const [kind, selector] of selectors) {
    for (const root of roots) {
      for (const node of root.querySelectorAll<HTMLElement>(selector)) {
        if (evidence.length >= 12) break;
        if (isCompanionNode(node) || !isVisible(node) || (kind === 'text' && node.closest('form')) || (node.tagName === 'OUTPUT' && node.closest('form'))) continue;
        const selectedTab = node.getAttribute('role') === 'tab' && node.getAttribute('aria-selected') === 'true';
        const currentPage = node.getAttribute('aria-current') === 'page';
        if ((selectedTab || currentPage) && node.closest('form')) continue;
        const label = safeText(node) || node.getAttribute('aria-label') || '';
        if (!label.trim()) continue;
        const text = clean(`${selectedTab ? 'Selected tab: ' : currentPage ? 'Current page: ' : ''}${label}`);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        evidence.push({ kind, text });
      }
    }
  }
  if (page.title) page.title = clean(page.title);
  if (page.section) page.section = clean(page.section);
  if (evidence.length) page.evidence = evidence;
  const statuses = evidence.filter((entry) => entry.kind === 'status' || entry.kind === 'alert');
  if (statuses.length) page.status = statuses.map((entry) => entry.text).join(' · ').slice(0, 240);
  return page;
}

export function createSemanticSnapshot(
  root: ParentNode = document,
  options: SemanticExtractionOptions = {},
): SemanticPageSnapshot {
  return {
    page: getPageContext(getOwnerDocument(root)),
    elements: discoverSemanticElements(root, options).map(toSafeSemanticElement),
  };
}

export function createSemanticScanner(
  options: SemanticScannerOptions = {},
): SemanticScanner {
  const root = options.root ?? document;
  const debounceMs = options.debounceMs ?? 100;
  const listeners = new Set<(snapshot: SemanticPageSnapshot) => void>();
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let lastSerializedSnapshot: string | undefined;
  let lastEmittedNodes: HTMLElement[] = [];
  const observedRoots = new Set<ParentNode>();
  const observeRoots = () => {
    if (!observer) return;
    for (const scope of semanticRoots(root)) {
      if (observedRoots.has(scope)) continue;
      observedRoots.add(scope);
      observer.observe(scope, { subtree: true, childList: true, attributes: true, characterData: true });
    }
  };

  let discovered: DiscoveredElement[] = [];
  const scan = () => {
    discovered = discoverSemanticElements(root, options);
    return { page: getPageContext(getOwnerDocument(root)), elements: discovered.map(toSafeSemanticElement) };
  };

  const emitIfChanged = () => {
    observeRoots();
    const snapshot = scan();
    const serializedSnapshot = JSON.stringify(snapshot);
    const identityChanged = discovered.length !== lastEmittedNodes.length || discovered.some((entry, index) => entry.element !== lastEmittedNodes[index]);
    if (serializedSnapshot === lastSerializedSnapshot && !identityChanged) {
      return;
    }

    lastSerializedSnapshot = serializedSnapshot;
    lastEmittedNodes = discovered.map((entry) => entry.element);
    listeners.forEach((listener) => listener(snapshot));
  };

  const scheduleScan = () => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = undefined;
      emitIfChanged();
    }, debounceMs);
  };

  return {
    scan,
    getDiscovered: () => discovered,

    start() {
      if (started) {
        return;
      }

      started = true;
      observer = new MutationObserver((records) => {
        if (records.some((record) => !isCompanionNode(record.target instanceof HTMLElement ? record.target : record.target.parentElement ?? document.documentElement))) scheduleScan();
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      emitIfChanged();
    },

    stop() {
      started = false;
      observer?.disconnect();
      observer = undefined;
      observedRoots.clear();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
