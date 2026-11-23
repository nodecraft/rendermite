/**
 * Shared checks for the browser-safe entries (`/pack`, `/hosted`): bundle an
 * entry the way a consumer's bundler would, or walk its built output, and report
 * what came along.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { rolldown } from 'rolldown';

export const root = path.join(import.meta.dirname, '..');

export async function bundleEntry(entry: string): Promise<{ code: string; modules: string[]; }> {
	const build = await rolldown({
		input: path.join(root, entry),
		platform: 'browser',
		// Nothing is external: a dependency that sneaks in has to show up in the
		// output rather than being quietly left for the consumer to install.
		external: [],
	});
	const { output } = await build.generate({ format: 'esm' });
	await build.close();
	const chunks = output.filter(part => part.type === 'chunk');
	const modules = chunks
		.flatMap(chunk => Object.keys(chunk.modules))
		.map(id => path.relative(root, id).replaceAll('\\', '/'))
		.filter(id => !id.startsWith('\0') && id.endsWith('.ts'));
	return { code: chunks.map(chunk => chunk.code).join('\n'), modules };
}

/** Bare specifiers survive bundling as imports, so any left are real dependencies. */
export function bareImports(code: string): string[] {
	return code.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"'.][^"']*)["']/g).map(match => match[1]).toArray();
}

/** Follows a built file's relative imports, returning the bare ones it reaches and the total bytes. */
export function walkBuilt(entry: string): { bare: string[]; bytes: number; } {
	const seen = new Set<string>();
	const bare: string[] = [];
	const walk = (file: string): void => {
		const resolved = path.normalize(file);
		if (seen.has(resolved)) {
			return;
		}
		seen.add(resolved);
		const code = readFileSync(resolved, 'utf8');
		for (const match of code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
			if (match[1].startsWith('.')) {
				walk(path.join(path.dirname(resolved), match[1]));
			} else {
				bare.push(match[1]);
			}
		}
	};
	walk(path.join(root, entry));
	return { bare, bytes: [...seen].reduce((total, file) => total + statSync(file).size, 0) };
}
