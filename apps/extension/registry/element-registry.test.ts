import { beforeEach, describe, expect, it } from 'vitest';
import {
  createElementRegistry,
  type ElementRegistry,
} from './element-registry';
import type { DiscoveredElement } from '../dom/semantic';

function discovered(
  element: HTMLElement,
  label: string,
  overrides: Partial<DiscoveredElement> = {},
): DiscoveredElement {
  return {
    role: 'button',
    label,
    visible: true,
    inViewport: true,
    disabled: false,
    element,
    ...overrides,
  };
}

describe('element registry', () => {
  let registry: ElementRegistry;

  beforeEach(() => {
    document.body.innerHTML = '';
    registry = createElementRegistry();
  });

  it('assigns runtime IDs and retains them for surviving DOM nodes', () => {
    const first = document.createElement('button');
    const second = document.createElement('button');
    const replacement = document.createElement('button');
    document.body.append(first, second, replacement);

    registry.reconcile([
      discovered(first, 'First'),
      discovered(second, 'Second'),
    ]);

    expect(registry.snapshot().map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'el_1', label: 'First' },
      { id: 'el_2', label: 'Second' },
    ]);

    registry.reconcile([
      discovered(first, 'First updated', { inViewport: false }),
      discovered(replacement, 'Replacement'),
    ]);

    expect(registry.snapshot().map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'el_1', label: 'First updated' },
      { id: 'el_3', label: 'Replacement' },
    ]);
    expect(registry.get('el_1')?.element).toBe(first);
    expect(registry.get('el_2')).toBeUndefined();
  });

  it('deduplicates a discovered DOM node and removes detached entries on reconcile', () => {
    const button = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(button, other);

    registry.reconcile([
      discovered(button, 'Button'),
      discovered(button, 'Button duplicate'),
      discovered(other, 'Other'),
    ]);

    expect(registry.list()).toHaveLength(2);
    expect(registry.get('el_1')?.label).toBe('Button');

    other.remove();
    registry.reconcile([discovered(button, 'Button')]);

    expect(registry.get('el_2')).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('returns only live entries through getLive', () => {
    const button = document.createElement('button');
    document.body.append(button);
    registry.reconcile([discovered(button, 'Live button')]);

    expect(registry.getLive('el_1')?.element).toBe(button);

    button.remove();

    expect(registry.get('el_1')?.element).toBe(button);
    expect(registry.getLive('el_1')).toBeUndefined();
  });

  it('keeps DOM references and coordinates out of model snapshots', () => {
    const button = document.createElement('button');
    document.body.append(button);
    registry.reconcile([
      discovered(button, 'Safe target', {
        hasValue: true,
        validationState: 'valid',
      }),
    ]);

    const snapshot = registry.snapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot[0]).not.toHaveProperty('element');
    expect(snapshot[0]).not.toHaveProperty('rect');
    expect(serialized).not.toContain('getBoundingClientRect');
    expect(serialized).toContain('Safe target');
  });

  it('clears current entries and prevents old IDs from resolving', () => {
    const button = document.createElement('button');
    document.body.append(button);
    registry.reconcile([discovered(button, 'Old')]);

    registry.clear();

    expect(registry.list()).toEqual([]);
    expect(registry.get('el_1')).toBeUndefined();
    expect(registry.getLive('el_1')).toBeUndefined();
  });
});
