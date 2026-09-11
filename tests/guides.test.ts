// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/indexeddb.md'
/** The package identity the guide manifest and package manifest must share. */
const PACKAGE_MODULE = '@orkestrel/indexeddb'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({
	[PACKAGE_MODULE]: 'src/browser',
	'@src/browser': 'src/browser',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isRecord, parseJSON } = await import('@orkestrel/contract')
	const { computeSymbolKey, findMissingSymbols } = await import('@orkestrel/guide')
	const { requireValue } = await import('@orkestrel/test')
	const { describe, expect, it } = await import('vitest')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.map((row) => row.entry.spec)).toContain(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. `README.md` is outside the concept index, so the reader is
	// applied to it directly rather than through a manifest row. Each side is guarded
	// against `undefined` first, so a file that lost its blockquote reports that rather
	// than reporting two absences as agreement.
	it('opens the README with the guide tagline', () => {
		const manifest = parseJSON(requireValue(files['package.json'], 'Missing file: package.json'))
		expect(isRecord(manifest) ? manifest.name : undefined).toBe(PACKAGE_MODULE)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
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

			it('carries every required populated section', () => {
				expect(report.sections.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps behavioral interfaces and implementing classes in parity', () => {
				expect(report.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents every behavioral declaration', () => {
				expect(report.declarations.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides through the native entry, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist the native entry prints, so a failure here is read the way that command's
			// output is. Select source authority with `--to guide`, or guide authority with
			// `--to source`.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps the executable example population non-empty', () => {
				expect(report.examples.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			it('documents an example for every method', () => {
				expect(report.examples.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('imports only real exports in every ```ts fence', () => {
				expect(report.imports.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('resolves every relative link', () => {
				expect(report.links.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
			it('links only to test files that exist', () => {
				expect(report.tests.filter((finding) => finding.spec === entry.spec)).toEqual([])
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
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)

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
			expect(guideText).toContain(
				'await readRecords(native) // every record, narrowed the same way',
			)
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
			expect(guideText).toContain(
				"context.indexes.create('users', { name: 'byName', path: 'name' })",
			)
			expect(guideText).toContain("context.indexes.drop('users', 'byRetired')")
			expect(guideText).toContain("const store = context.stores.store('users')")
			expect(guideText).toContain('await store.set({ ...row, migrated: true })')
		})
	})
})
