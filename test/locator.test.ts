import { describe, expect, it } from 'vitest';

import { InvalidResourceLocatorError, ResourceLocator } from '../src/resources/locator.ts';

describe('ResourceLocator', () => {
	it('parses namespaced locators', () => {
		const loc = ResourceLocator.parse('minecraft:item/stone');
		expect(loc.namespace).toBe('minecraft');
		expect(loc.path).toBe('item/stone');
	});

	it('defaults the namespace to minecraft', () => {
		expect(ResourceLocator.parse('item/stone').toString()).toBe('minecraft:item/stone');
	});

	it('accepts a custom default namespace', () => {
		expect(ResourceLocator.parse('item/wrench', 'create').namespace).toBe('create');
	});

	it('treats an empty namespace before the colon as the default', () => {
		expect(ResourceLocator.parse(':item/stone').namespace).toBe('minecraft');
	});

	it('normalizes case and whitespace instead of failing', () => {
		const loc = ResourceLocator.parse(' MyMod:Item/Thing ');
		expect(loc.toString()).toBe('mymod:item/thing');
	});

	it('rejects unnormalizable ids', () => {
		expect(() => ResourceLocator.parse('bad mod:item')).toThrow(InvalidResourceLocatorError);
		expect(ResourceLocator.tryParse('bad mod:item')).toBeNull();
	});

	it('compares by value', () => {
		expect(ResourceLocator.parse('a:b').equals(ResourceLocator.parse('a:b'))).toBe(true);
		expect(ResourceLocator.parse('a:b').equals(ResourceLocator.parse('a:c'))).toBe(false);
	});
});
