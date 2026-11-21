// Links to this project's documentation on GitHub, at the tag of the running version, so the page
// matches what is installed. An unknown or unusual version links to the main branch.
const REPO = 'https://github.com/ShlomiPorush/netbird-control';

export function docsUrl(version: string | undefined, path: string): string {
  const ref = version && /^\d+\.\d+\.\d+$/.test(version.trim()) ? `v${version.trim()}` : 'main';
  return `${REPO}/blob/${ref}/${path}`;
}
