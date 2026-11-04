import { describe, expect, it } from 'vitest';
import { validateBackendUrl } from './backend-url';

describe('hosted backend configuration', () => {
  it('accepts a deployed HTTPS origin', () => {
    expect(validateBackendUrl('https://my-workspace--voice-companion-backend.modal.run').origin).toBe('https://my-workspace--voice-companion-backend.modal.run');
  });
  it('requires an explicit hosted origin and rejects local or embedded credentials', () => {
    for (const value of [undefined, '', 'http://127.0.0.1:8787', 'https://localhost', 'https://127.0.0.1', 'https://example.com/path', 'https://example.com?secret=x', 'https://user:password@example.com', 'https://example.com/#fragment']) {
      expect(() => validateBackendUrl(value)).toThrow();
    }
  });
});
