// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The four constants below are this
// package's own, and are the only part a sibling package changes.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({
	'@orkestrel/indexeddb': 'src/browser',
	'@src/browser': 'src/browser',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the second assertion below fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

/** The package guide whose flagship fences the executed transcriptions copy. */
const PACKAGE_GUIDE = 'guides/indexeddb.md'

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.keyword === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// The presence guards for the executed transcriptions in
// `tests/src/browser/integration.test.ts`, and for the one behavioural sentence this guide states
// outside any fence, which `tests/src/browser/IndexedDBCursor.test.ts` executes. Every check
// earlier in this file reads a name, and a name that resolves proves nothing about the sentence
// beside it, so the behaviour each flagship fence claims is asserted over real Chromium storage
// there instead. These cases prove the lines those proofs copy are still the documented ones —
// and nothing whatever about behaviour.
// Binding a fence's construction line alone would leave its comments free to claim the opposite
// value and stay green, so every line carrying a claim is bound. Change a fence, change the
// transcription beside it and the line bound here.
describe('flagship fence transcriptions', () => {
	const guideText = requireValue(files[PACKAGE_GUIDE], `Missing file: ${PACKAGE_GUIDE}`)

	it('carries the Surface fence lines the transcription copies', () => {
		expect(guideText).toContain("await users.set({ id: 'u1', name: 'Ada', age: 36 })")
		expect(guideText).toContain(']) // array in → array of keys out (array-first batch)')
		expect(guideText).toContain(
			"await users.get('u1') // point read by primary key → the row, or undefined",
		)
		expect(guideText).toContain(
			"await users.index('byAge').records(rangeFromKey(18)) // adults, index-backed (O(log n))",
		)
	})

	it('carries the key-range fence lines the transcription copies', () => {
		expect(guideText).toContain(
			"await users.records(IDBKeyRange.only('user:1')) // exactly one primary key",
		)
		expect(guideText).toContain(
			"await users.records(rangeAboveKey('user:1')) // keys greater than user:1",
		)
		expect(guideText).toContain(
			"await users.records(rangeBelowKey('user:9')) // keys less than user:9",
		)
		expect(guideText).toContain(
			"await users.records(rangeToKey('user:9')) // keys less than or equal to user:9",
		)
		expect(guideText).toContain(
			"await users.index('byAge').records(IDBKeyRange.bound(18, 65)) // working-age, O(log n)",
		)
		expect(guideText).toContain(
			"await users.index('byAge').count(rangeFromKey(18)) // how many adults",
		)
		expect(guideText).toContain(
			"await users.index('byEmail').get('ada@x.io') // unique-index point lookup",
		)
		expect(guideText).toContain(
			"await users.records(rangePrefix('user:')) // primary-key prefix scan",
		)
	})

	it('carries the cursor-streaming fence lines the transcription copies', () => {
		expect(guideText).toContain('if (cursor.value?.active === false) await cursor.remove()')
		expect(guideText).toContain('cursor = await cursor.continue()')
	})

	it('carries the index-cursor seek fence lines the transcription copies', () => {
		expect(guideText).toContain("if (cursor) cursor = await cursor.seek(30, 'c')")
		expect(guideText).toContain("cursor?.primary // 'c'")
	})

	it('carries the store-cursor seek sentence the cursor suite executes', () => {
		expect(guideText).toContain(
			'a store cursor from `db.store(name).cursor()` throws `InvalidAccessError`',
		)
		expect(guideText).toContain('reaches the caller as an `IndexedDBError` of code `UNKNOWN`')
	})

	it('carries the explicit-transaction fence lines the transcription copies', () => {
		expect(guideText).toContain(
			'if (cursor) cursor = await cursor.advance(1) // skip forward one record',
		)
		expect(guideText).toContain(
			'if (cursor?.value) await cursor.update({ ...cursor.value, seen: true })',
		)
		expect(guideText).toContain(
			'transaction.commit() // flush early instead of waiting for the scope to resolve',
		)
	})

	it('carries the request-boundary fence lines the transcription copies', () => {
		expect(guideText).toContain(
			"await promisifyRequest(wrapCall(() => native.get('u1'))) // sync throw → IndexedDBError too",
		)
		expect(guideText).toContain(
			"await readRecord(native, 'u1') // narrowed to Row (or undefined) with isRecord",
		)
		expect(guideText).toContain('await readRecords(native) // every record, narrowed the same way')
		expect(guideText).toContain("await hasKey(native, 'u1') // a native count() > 0")
		expect(guideText).toContain(
			'await promisifyTransaction(native.transaction) // resolves after the transaction commits',
		)
		expect(guideText).toContain(
			'wrapError(null) // the same DOMException → IndexedDBError mapping every bridge uses',
		)
	})

	it('carries the typed-fault fence lines the transcription copies', () => {
		expect(guideText).toContain("await db.store('users').add({ id: 'u1', name: 'Ada' })")
		expect(guideText).toContain(
			"if (error instanceof IndexedDBError && error.code === 'CONSTRAINT') {",
		)
		expect(guideText).toContain("await db.store('users').set({ id: 'u1', name: 'Ada' })")
	})

	it('carries the isIndexedDBError fence lines the transcription copies', () => {
		expect(guideText).toContain("await db.store('users').resolve('ghost')")
		expect(guideText).toContain("if (isIndexedDBError(error) && error.code === 'NOT_FOUND') {")
	})

	it('carries the upgrade fence lines the transcription copies', () => {
		expect(guideText).toContain("context.stores.drop('legacy')")
		expect(guideText).toContain("context.stores.create('meta', { path: 'key' })")
		expect(guideText).toContain("context.indexes.create('users', { name: 'byName', path: 'name' })")
		expect(guideText).toContain("context.indexes.drop('users', 'byRetired')")
		expect(guideText).toContain("const store = context.stores.store('users')")
		expect(guideText).toContain('await store.set({ ...row, migrated: true })')
	})
})
