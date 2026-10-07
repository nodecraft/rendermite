import nodecraft from '@nodecraft/eslint-config';

export default [
	// Global ignores (replaces .eslintignore)
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'.work/**',
			'.bench/**',
		],
	},

	// TypeScript + node configs
	...nodecraft.configs.typescript,
	...nodecraft.configs.node,

	// General overrides
	{
		rules: {
			// The node config is spread last, so eslint-plugin-n's recommended set
			// re-enables these after the TypeScript config already turned them off.
			'n/no-unsupported-features/es-syntax': 'off',
			'n/no-missing-import': 'off',

			// Render math is dense arithmetic ported from upstream; the parens this
			// rule wants obscure more than they clarify.
			'@stylistic/no-mixed-operators': 'off',

			// Hoisted function declarations are safe; variables/classes stay strict.
			'@typescript-eslint/no-use-before-define': ['error', { functions: false }],
		},
	},

	// Render math mirrors upstream's vector/corner naming (a–h, u/v, r/g/b/a);
	// renaming would make the ports harder to audit against the PHP.
	{
		files: ['src/render/**/*.ts', 'src/atlas/**/*.ts'],
		rules: {
			'id-length': 'off',
		},
	},

	// CLI entry: exiting with a status code is the point, and the shebang is
	// required because src/cli.ts builds to dist/cli.js, the package bin —
	// convertPath teaches n/hashbang that mapping.
	{
		files: ['src/cli.ts'],
		rules: {
			'n/no-process-exit': 'off',
			'n/hashbang': ['error', {
				convertPath: [{
					include: ['src/**/*.ts'],
					replace: [String.raw`^src/(.+)\.ts$`, 'dist/$1.js'],
				}],
			}],
		},
	},

	// Test files - relax non-null assertions (common in fixture assertions)
	{
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'off',
		},
	},
];
