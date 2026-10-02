import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

describe('manifest web_accessible_resources (F5)', () => {
  it('exposes to web pages only the favicon cache that Spotlight shows in pages', () => {
    expect(manifest.web_accessible_resources).toEqual([
      { resources: ['_favicon/*'], matches: ['<all_urls>'] },
    ]);
  });
});
