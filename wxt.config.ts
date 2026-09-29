import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser, manifestVersion }) => ({
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    permissions: ['storage', 'activeTab', 'scripting', 'downloads'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    ...(manifestVersion === 2 ? { optional_permissions: ['http://*/*', 'https://*/*'] } : {}),
    ...(browser === 'firefox' ? {
      browser_specific_settings: {
        gecko: {
          data_collection_permissions: { required: ['none'] },
        },
      },
    } : {}),
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src http: https:",
    },
    action: {
      default_title: '__MSG_extensionName__',
    },
  }),
});
