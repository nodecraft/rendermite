import { defineConfig } from 'tsdown';

export default defineConfig({
	dts: true,
	fixedExtension: false,
	format: 'esm',
	target: 'es2022',
	// Per-file output rather than a bundle: builtin.ts resolves the vendored
	// resource packs relative to its own location, and the CLI stays a separate
	// entry with its shebang intact.
	entry: ['src/**/*.ts'],
});
