import { defineConfig } from 'wxt';
import { env } from 'node:process';
import { validateBackendUrl } from './backend-url';

export default defineConfig({
  manifest: () => {
    const backend = validateBackendUrl(env.WXT_BACKEND_URL);
    return {
      name: 'Voice Companion', description: 'Voice and visual guidance on the website you choose.', version: '0.2.0',
      minimum_chrome_version: '116',
      options_ui: { page: 'permission.html', open_in_tab: true },
      permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'tts'],
      host_permissions: [`${backend.origin}/*`],
      action: { default_title: 'Start or stop Voice Companion' },
    };
  },
});
