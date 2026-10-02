import { defineConfig } from 'vitest/config';

// Separate from vite.config.js so the extension build plugins do not load in tests.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,ts,tsx}'],
    environment: 'node',
  },
});
