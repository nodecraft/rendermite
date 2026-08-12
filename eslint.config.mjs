import nodecraft from '@nodecraft/eslint-config';

export default [
	// Global ignores (replaces .eslintignore)
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'.work/**',
		],
	},

	// TypeScript + node configs
	...nodecraft.configs.typescript,
	...nodecraft.configs.node,

	// General overrides
	{
		linterOptions: {
			reportUnusedDisableDirectives: true,
		},
		rules: {
			'n/no-unsupported-features/es-syntax': 'off',
			'n/no-unsupported-features/node-builtins': 'off',
			'@stylistic/no-mixed-operators': 'off',

			// TS rule overrides
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': ['warn', {
				ignoreRestSiblings: true,
			}],
			'no-use-before-define': 'off',
			// Hoisted function declarations are safe; variables/classes stay strict.
			'@typescript-eslint/no-use-before-define': ['error', { functions: false }],
			'n/no-missing-import': 'off',
			'no-duplicate-imports': 'off',
			'no-undef': 'off',
			'unicorn/custom-error-definition': 'off',
			'no-restricted-syntax': ['error', {
				selector: 'TSEnumDeclaration',
				message: 'Don\'t declare enums - they\'re difficult to transpile. Use object literals instead.',
			}],
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-non-null-assertion': 'error',
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

	// CLI entry: exiting with a status code is the point.
	{
		files: ['src/cli.ts'],
		rules: {
			'n/no-process-exit': 'off',
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
