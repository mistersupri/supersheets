import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // The engine is a workspace TypeScript package, so it is bundled in.
  noExternal: ['@opensheet/engine'],
});
