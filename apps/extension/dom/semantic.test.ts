import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSemanticScanner,
  createSemanticSnapshot,
  discoverSemanticElements,
} from './semantic';

function setRect(
  element: HTMLElement,
  rect: { top: number; left: number; right: number; bottom: number },
) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
}

describe('DOM semantic layer', () => {
  beforeEach(() => {
    document.head.innerHTML = '<title>Account Dashboard</title>';
    document.body.innerHTML = '';
  });

  it('discovers accessible controls with inferred roles and bounded context', () => {
    document.body.innerHTML = `
      <h1>Account Dashboard</h1>
      <section>
        <h2>Account Settings</h2>
        <button id="account-settings">Account Settings</button>
        <a href="/activity" aria-label="View Activity">Open</a>
        <label for="accountId">Private account identifier</label>
        <input id="accountId" name="accountId" value="100200300400" />
        <div role="button" aria-labelledby="profile-label">
          <span id="profile-label">Manage Profile</span>
        </div>
      </section>
    `;

    const online = document.querySelector('#account-settings') as HTMLElement;
    const passbook = document.querySelector('a') as HTMLElement;
    const accountId = document.querySelector('#accountId') as HTMLElement;
    const profile = document.querySelector('[role="button"]') as HTMLElement;
    [online, passbook, accountId, profile].forEach((element) =>
      setRect(element, { top: 20, left: 20, right: 240, bottom: 60 }),
    );

    const entries = discoverSemanticElements(document, {
      viewport: { width: 800, height: 600 },
    });

    expect(entries.map(({ role, label }) => ({ role, label }))).toEqual([
      { role: 'button', label: 'Account Settings' },
      { role: 'link', label: 'View Activity' },
      { role: 'textbox', label: 'Private account identifier' },
      { role: 'button', label: 'Manage Profile' },
    ]);
    expect(entries.every((entry) => entry.section === 'Account Settings')).toBe(
      true,
    );
    expect(entries.find((entry) => entry.element === accountId)).toMatchObject({
      hasValue: true,
      validationState: 'valid',
    });
  });

  it('excludes non-interactive landmark roles from model context', () => {
    document.body.innerHTML = `
      <div role="banner">Header</div>
      <nav role="navigation">Navigation</nav>
      <main role="main">
        <button>Account Settings</button>
        <div role="status">Member verified</div>
      </main>
      <footer role="contentinfo">Footer</footer>
    `;

    expect(discoverSemanticElements(document).map(({ role, label }) => ({ role, label }))).toEqual([
      { role: 'button', label: 'Account Settings' },
    ]);
  });

  it('keeps visibility separate from viewport position and filters hidden controls', () => {
    document.body.innerHTML = `
      <button id="above">Above</button>
      <button id="below">Below</button>
      <button id="hidden" hidden>Hidden</button>
    `;

    setRect(document.querySelector('#above') as HTMLElement, {
      top: 20,
      left: 20,
      right: 120,
      bottom: 60,
    });
    setRect(document.querySelector('#below') as HTMLElement, {
      top: 900,
      left: 20,
      right: 120,
      bottom: 940,
    });

    const snapshot = createSemanticSnapshot(document, {
      viewport: { width: 800, height: 600 },
    });

    expect(snapshot.elements.map((element) => element.label)).toEqual([
      'Above',
      'Below',
    ]);
    expect(snapshot.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Above', visible: true, inViewport: true }),
        expect.objectContaining({ label: 'Below', visible: true, inViewport: false }),
      ]),
    );
  });

  it('never serializes input values, including password and OTP-like fields', () => {
    document.body.innerHTML = `
      <label for="password">Password</label>
      <input id="password" type="password" value="not-a-secret" />
      <label for="otp">One Time Password</label>
      <input id="otp" inputmode="numeric" value="123456" aria-invalid="true" />
    `;

    const snapshot = createSemanticSnapshot(document);
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain('not-a-secret');
    expect(serialized).not.toContain('123456');
    expect(snapshot.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Password',
          hasValue: true,
          validationState: 'valid',
        }),
        expect.objectContaining({
          label: 'One Time Password',
          hasValue: true,
          validationState: 'invalid',
        }),
      ]),
    );
  });

  it('does not treat an empty select placeholder as completed', () => {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Claim type');
    select.innerHTML = '<option value="">Choose a claim type</option>';
    document.body.append(select);

    expect(discoverSemanticElements(document)).toEqual([
      expect.objectContaining({
        label: 'Claim type',
        hasValue: false,
        validationState: 'unknown',
      }),
    ]);
  });

  it('debounces mutation-driven rescans and stops observing after cleanup', async () => {
    vi.useFakeTimers();
    const scanner = createSemanticScanner({ debounceMs: 50 });
    const listener = vi.fn();
    scanner.subscribe(listener);
    scanner.start();

    expect(listener).toHaveBeenCalledTimes(1);
    document.body.append(document.createElement('button'));
    document.body.append(document.createElement('button'));

    await vi.advanceTimersByTimeAsync(49);
    expect(listener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(listener).toHaveBeenCalledTimes(2);

    scanner.stop();
    document.body.append(document.createElement('button'));
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('general page support', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('discovers open Shadow DOM controls with labels scoped to that tree', () => {
    document.body.innerHTML = '<span id="label">Wrong document label</span><div id="host"></div>';
    const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<span id="label">Search products</span><button aria-labelledby="label">Go</button>';
    expect(discoverSemanticElements(document)).toEqual([expect.objectContaining({ label: 'Search products', role: 'button' })]);
    (document.querySelector('#host') as HTMLElement).hidden = true;
    expect(discoverSemanticElements(document)).toEqual([]);
  });
  it('excludes the companion and editable values from labels and context', () => {
    document.body.innerHTML = '<section><h2>Profile <span contenteditable="true">private heading value</span></h2><label>Name<textarea>private field value</textarea></label><div contenteditable="true" aria-label="Notes">private notes</div><voice-companion-root></voice-companion-root></section>';
    const assistant = document.querySelector('voice-companion-root')!.attachShadow({ mode: 'open' }); assistant.innerHTML = '<button>Assistant microphone</button>';
    const entries = discoverSemanticElements(document);
    expect(entries.map((entry) => entry.label)).toEqual(['textbox', 'Name', 'Notes']);
    const snapshot = createSemanticSnapshot(document);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|Assistant microphone/);
  });
  it('observes changes inside open shadow roots and captures completion evidence', async () => {
    document.body.innerHTML = '<div id="host"></div><output>Saved successfully</output>';
    const root = document.querySelector('#host')!.attachShadow({ mode: 'open' }); root.innerHTML = '<button>Open</button>';
    const scanner = createSemanticScanner({ root: document, debounceMs: 1 }); const changed = vi.fn(); scanner.subscribe(changed); scanner.start();
    root.querySelector('button')!.textContent = 'Settings';
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ label: 'Settings' })] })));
    expect(scanner.scan().page.status).toContain('Saved successfully'); scanner.stop();
  });
});

describe('semantic registry identity changes', () => {
  it('emits a rescan when an identical-looking control is replaced', async () => {
    document.body.innerHTML = '<button>Search</button>';
    const scanner = createSemanticScanner({ root: document, debounceMs: 1 }); const changed = vi.fn(); scanner.subscribe(changed); scanner.start();
    document.querySelector('button')!.replaceWith(document.querySelector('button')!.cloneNode(true));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2)); scanner.stop();
  });
});

describe('completion evidence', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('collects bounded visible result text while excluding private and hidden content', () => {
    document.body.innerHTML = `
      <main><h1>Application</h1><h2>Result</h2><p>Request complete</p>
      <p hidden>Hidden result</p><p>Visible <span hidden>hidden child</span></p>
      <form><input value="Synthetic Private Value"><p>Private form value</p></form>
      <p contenteditable="true">Private editable value</p>
      <div contenteditable="true"><p>Nested private value</p></div>
      <div role="status">Saved for Synthetic Private Value</div>
      <p>Contact person@example.com</p>
      <div role="alert">Request rejected</div></main>
      <voice-companion-root><p>Companion text</p><h2>Companion heading</h2></voice-companion-root>`;
    const evidence = createSemanticSnapshot(document).page.evidence!;
    const serialized = JSON.stringify(evidence);
    expect(evidence).toContainEqual({ kind: 'text', text: 'Request complete' });
    expect(evidence[0]).toEqual({ kind: 'alert', text: 'Request rejected' });
    for (const value of ['Synthetic Private Value', 'Private form value', 'Private editable value', 'Nested private value', 'Hidden result', 'hidden child', 'person@example.com', 'Companion']) expect(serialized).not.toContain(value);
    expect(serialized).toContain('[redacted]');
  });
  it('caps evidence and prioritizes alerts over ordinary paragraphs', () => {
    document.body.innerHTML = `<main>${'<p>Ordinary text</p>'.repeat(20)}<div role="alert">Failed</div>${Array.from({ length: 20 }, (_, i) => `<h2>Section ${i}</h2>`).join('')}</main>`;
    const evidence = createSemanticSnapshot(document).page.evidence!;
    expect(evidence).toHaveLength(12); expect(evidence[0]).toEqual({ kind: 'alert', text: 'Failed' });
    expect(evidence.every((entry) => entry.text.length <= 240)).toBe(true);
  });
  it('reads a result in an open shadow tree', () => {
    const host = document.createElement('div'); document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<div role="status">Request complete</div>';
    expect(createSemanticSnapshot(document).page.evidence).toContainEqual({ kind: 'status', text: 'Request complete' });
  });
});

describe('echoed value redaction', () => {
  it('removes selected and editable values from headings and completion text', () => {
    document.head.innerHTML = '<title>Selected Private Label</title>';
    document.body.innerHTML = `<select><option value="opaque-value">Selected Private Label</option></select>
      <div contenteditable="true">Private Editable Value</div>
      <main><h1>Selected Private Label</h1><div role="status">Saved Selected Private Label and Private Editable Value</div></main>`;
    const page = createSemanticSnapshot(document).page;
    expect(JSON.stringify(page)).not.toContain('Selected Private Label');
    expect(JSON.stringify(page)).not.toContain('Private Editable Value');
  });
});

describe('visible navigation evidence', () => {
  it('reports the selected tab and current page without treating every tab as reached', () => {
    document.body.innerHTML = '<h1>Backend</h1><div role="tab" aria-selected="false">Function Calls</div><div role="tab" aria-selected="true">Metrics</div><a href="/settings" aria-current="page">Settings</a><div hidden role="tab" aria-selected="true">Hidden tab</div>';
    const page = createSemanticSnapshot(document).page;
    expect(page.evidence).toContainEqual({ kind: 'status', text: 'Selected tab: Metrics' });
    expect(page.evidence).toContainEqual({ kind: 'status', text: 'Current page: Settings' });
    expect(JSON.stringify(page.evidence)).not.toMatch(/Function Calls|Hidden tab/);
  });
  it('redacts echoed form values and excludes form and companion navigation', () => {
    document.body.innerHTML = '<input value="Synthetic Private Value"><div role="tab" aria-selected="true">Synthetic Private Value</div><form><div role="tab" aria-selected="true">Form tab</div></form><voice-companion-root><div role="tab" aria-selected="true">Companion tab</div></voice-companion-root>';
    const evidence = JSON.stringify(createSemanticSnapshot(document).page.evidence);
    expect(evidence).toContain('Selected tab: [redacted]');
    expect(evidence).not.toMatch(/Synthetic Private Value|Form tab|Companion tab/);
  });
});
