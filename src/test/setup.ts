// Extends Vitest's `expect` with @testing-library/jest-dom matchers
// (e.g. toBeInTheDocument, toHaveTextContent) and registers DOM cleanup
// after each test. Imported via vitest.config.ts setupFiles.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library's built-in auto-cleanup relies on a global `afterEach`,
// which is only registered when Vitest runs with `globals: true`. We use
// explicit imports throughout the project, so we register cleanup ourselves.
afterEach(() => {
  cleanup();
});
