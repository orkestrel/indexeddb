import { createIndexedDBDatabase, range } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { createCleanups, deleteDatabase, uniqueName } from '../../setupBrowser.js'

// `createIndexedDBDatabase` (`src/browser/factories.ts`) in real
// Chromium: the factory returns a working `IndexedDBDatabaseInterface` — it
// connects lazily, creates its declared stores and indexes, and round-trips
// real data. This file pins the factory's product (the database test pins the
// handle's full surface); the schema here is exercised end to end.

const cleanups = createCleanups()

afterEach(cleanups.run)

describe('createIndexedDBDatabase', () => {
	it('returns a connecting, round-tripping database over its schema', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const db = createIndexedDBDatabase({
			name,
			version: 1,
			stores: {
				users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
			},
		})
		cleanups.push(async () => {
			db.close()
			await deleteDatabase(name)
		})
		// A handle, not yet connected.
		expect(db.name).toBe(name)
		expect(db.open).toBe(false)

		// Connects on use, and the declared store + index round-trip real data.
		await db.store('users').set([
			{ id: 'u1', name: 'Ada', age: 36 },
			{ id: 'u2', name: 'Grace', age: 45 },
		])
		expect(db.open).toBe(true)
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada', age: 36 })
		expect(
			(await db.store('users').index('byAge').records(range.from(40))).map((r) => r.id),
		).toEqual(['u2'])
	})

	it('opens in auto-managed mode when no version is given', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const db = createIndexedDBDatabase({ name, stores: { items: { path: 'id' } } })
		cleanups.push(async () => {
			db.close()
			await deleteDatabase(name)
		})
		await db.connect()
		expect(db.version).toBe(1) // auto-managed: settled at the created version
		await db.store('items').set({ id: 'i1' })
		expect(await db.store('items').get('i1')).toEqual({ id: 'i1' })
	})
})
