import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    env: { WXT_BACKEND_URL: 'https://voice-companion-test.modal.run' },
    include: ['**/*.test.ts', '**/*.test.tsx'],
  },
});
