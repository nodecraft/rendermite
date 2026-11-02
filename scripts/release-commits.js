/**
 * Wraps the commit analyzer and release notes generator so commits that only
 * touch `website/` are ignored. The site deploys on its own, so a `feat:` there
 * should not publish a new package version.
 */

import { execFileSync } from 'node:child_process';

import * as commitAnalyzer from '@semantic-release/commit-analyzer';
import * as notesGenerator from '@semantic-release/release-notes-generator';

function touchesPackage(hash, cwd) {
	const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash], { cwd, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
	return files.some(file => !file.startsWith('website/'));
}

function withoutWebsiteOnly(context) {
	const commits = context.commits.filter(commit => touchesPackage(commit.hash, context.cwd));
	return { ...context, commits };
}

export function analyzeCommits(pluginConfig, context) {
	return commitAnalyzer.analyzeCommits(pluginConfig, withoutWebsiteOnly(context));
}

export function generateNotes(pluginConfig, context) {
	return notesGenerator.generateNotes(pluginConfig, withoutWebsiteOnly(context));
}
