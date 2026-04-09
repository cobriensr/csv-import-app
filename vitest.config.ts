import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest configuration with three projects:
 *
 *  - `api`: Node environment for Express + supertest tests under api/.
 *  - `src`: happy-dom environment for React component tests under src/.
 *  - `scripts`: Node environment for the sample-data generator tests.
 *
 * Each project gets its own environment, glob, and (for src) setup file.
 * Run all tests with `npm test`. Run a single project with:
 *   npx vitest --project api
 *   npx vitest --project src
 *   npx vitest --project scripts
 */
export default defineConfig({
  test: {
    reporters: ['default', 'html'],
    coverage: {
      provider: 'v8',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'api',
          environment: 'node',
          include: ['api/**/*.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'src',
          environment: 'happy-dom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
    ],
  },
});
