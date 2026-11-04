export function validateBackendUrl(value?: string): URL {
  if (!value?.trim()) throw new Error('Set WXT_BACKEND_URL to your deployed Modal HTTPS origin before building the extension.');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a backend origin without credentials, path, or query.');
  if (url.protocol !== 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Use the deployed HTTPS backend origin. A local backend is not configured.');
  return url;
}
