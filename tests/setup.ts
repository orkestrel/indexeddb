// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue: DOM/Vue helpers live in `setupBrowser.ts`.

import type {
	AggregateFunction,
	BlockNode,
	BlockquoteNode,
	CodeBlockNode,
	Columns,
	Condition,
	ConditionOperator,
	Connector,
	Criteria,
	DatabaseInterface,
	DriverInterface,
	Eligibility,
	EmitterErrorHandler,
	EmitterInterface,
	EmphasisNode,
	EventMap,
	Expression,
	FieldPath,
	Guard,
	HeadingNode,
	InferentialResult,
	InlineCodeNode,
	InlineNode,
	Key,
	LineResult,
	LinkNode,
	ListNode,
	LogicalResult,
	MarkdownParserInterface,
	ParagraphNode,
	ProgramDefinition,
	QuantitativeDefinition,
	QuantitativeResult,
	ReasonerInterface,
	Reasoning,
	ReasonResult,
	Row,
	RowOf,
	Subject,
	SymbolicExpression,
	SymbolicResult,
	TableInterface,
	TableNode,
	TableSchema,
} from '@src/core'
// `interprets` is not yet registered on the `@src/core` barrel (it lands in
// its own implementation phase) — imported directly from source until then.
import type { Interpretation, Template } from '../src/core/interprets/types.js'
import { InterpretContext } from '../src/core/interprets/managers/InterpretContext.js'
import {
	aggregateDefinition,
	atom,
	belongsTo,
	compound,
	constant,
	createDatabase,
	createMemoryDriver,
	factorGroup,
	fieldFactor,
	hasMany,
	integerShape,
	isArray,
	isRecord,
	lineDefinition,
	logicalDefinition,
	noticeDefinition,
	operation,
	passDefinition,
	programDefinition,
	quantitativeDefinition,
	rule,
	staticFactor,
	rulingDefinition,
	stringShape,
	variable,
	isHeadingNode,
	isListNode,
	isTableNode,
	isParagraphNode,
	isCodeBlockNode,
	isBlockquoteNode,
	isEmphasisNode,
	isCodeSpanNode,
	isLinkNode,
	isTextNode,
} from '@src/core'
import { afterEach, vi } from 'vitest'

afterEach(() => {
	vi.restoreAllMocks()
})

// A real callback that records its calls — use instead of a mock when a test
// only needs to count invocations or inspect arguments.
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

export function createRecorder<
	TArgs extends readonly unknown[] = readonly unknown[],
>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler: (...args: TArgs) => {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

/**
 * Create a recorder for an {@link import('@src/core').EmitterErrorHandler} — the emitter's
 * own listener-error channel (AGENTS §13): a `TestRecorderInterface<[error, event]>` whose
 * `handler` is wired as the `error` option, so an emit-safety test asserts a buggy listener's
 * throw was routed here (with the offending event name) instead of corrupting the entity.
 * Argument order is `(error, event)`, matching `EmitterErrorHandler`. A thin alias over
 * {@link createRecorder} (AGENTS §16.1 — extract-once over the per-entity emit-safety blocks).
 *
 * @returns A recorder of `[error: unknown, event: string]` calls
 */
export function createErrorRecorder(): TestRecorderInterface<
	readonly [error: unknown, event: string]
> {
	return createRecorder<readonly [error: unknown, event: string]>()
}

/** A {@link createRecorder} per listed event of an `EmitterInterface`, keyed by event name. */
export type EmitterRecorders<TMap extends EventMap, TName extends keyof TMap> = {
	readonly [K in TName]: TestRecorderInterface<TMap[K]>
}

/**
 * Wire one {@link createRecorder} onto `emitter` for each of the named events — the
 * one generic form of the per-entity `recordXEvents` bundles (AGENTS §16.1). Each
 * recorder subscribes via `emitter.on(name, recorder.handler)` and is returned keyed
 * by its event name, typed with that event's argument tuple — so a test asserts what
 * fired (`events.write.calls`) and with which payload, exactly as the local bundles did.
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names to record (inferred from `events`)
 * @param emitter - The emitter to subscribe the recorders to
 * @param events - The event names to record (each becomes a key of the result)
 * @returns A recorder per name, each subscribed and keyed by event name
 */
export function recordEmitterEvents<TMap extends EventMap, TName extends keyof TMap>(
	emitter: EmitterInterface<TMap>,
	events: readonly TName[],
): EmitterRecorders<TMap, TName> {
	// Accumulate into a `Partial` of the exact mapped shape — every value keeps its
	// precise per-event tuple type (a recorder is invariant in its argument tuple, so a
	// widened record won't hold it), all keys optional until assigned. Each recorder is
	// created against its event's tuple, so `on(name, handler)` is precisely typed as it
	// is wired. The dynamic key list is the untyped edge: once every listed name is
	// present we narrow `Partial` → total through a guard, never an assertion (§14).
	const recorders: Partial<EmitterRecorders<TMap, TName>> = {}
	for (const name of events) {
		const recorder = createRecorder<TMap[typeof name]>()
		emitter.on(name, recorder.handler)
		recorders[name] = recorder
	}
	if (!isTotal(recorders, events)) {
		throw new Error('recordEmitterEvents: a recorder was not wired for every event')
	}
	return recorders
}

/**
 * Narrow an accumulated `Partial<EmitterRecorders>` to its total mapped form once every
 * listed event has a recorder present — the §14 guard standing in for an assertion in
 * {@link recordEmitterEvents} (whose loop assigns one recorder per name, so this holds;
 * the explicit per-name presence check keeps the narrowing a sound guard, not a cast).
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names that must each have a recorder
 * @param recorders - The partially-accumulated recorder map to narrow
 * @param events - The event names that must all be present for the map to be total
 * @returns Whether every listed event has a recorder (narrowing `recorders` to total)
 */
export function isTotal<TMap extends EventMap, TName extends keyof TMap>(
	recorders: Partial<EmitterRecorders<TMap, TName>>,
	events: readonly TName[],
): recorders is EmitterRecorders<TMap, TName> {
	return events.every((name) => recorders[name] !== undefined)
}

export function waitForDelay(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `thunk` and return the value it threw, or `undefined` if it returned normally — the
 * one shared form of the `try { …; return undefined } catch (error) { return error }` IIFE
 * the error-path tests repeat (AGENTS §16.1). Lets a caller assert on the captured fault
 * unconditionally, never inside a conditional `expect`. For a synchronous throw site; an
 * async rejection is asserted with `await expect(…).rejects` instead.
 *
 * @param thunk - The (synchronous) operation to run and capture the throw of
 * @returns The thrown value, or `undefined` when `thunk` did not throw
 */
export function captureError(thunk: () => unknown): unknown {
	try {
		thunk()
		return undefined
	} catch (error) {
		return error
	}
}

/**
 * A broad spread of values for exercising parse↔guard soundness exhaustively:
 * guard-valid representatives for every shipped guard, coercible inputs (numeric
 * strings, `'true'` / `1`), and adversarial non-matches (mixed arrays, symbol,
 * bigint, function) so both soundness clauses are covered non-vacuously.
 */
export const SOUNDNESS_SAMPLE: readonly unknown[] = [
	null,
	undefined,
	true,
	false,
	0,
	1,
	-1,
	42,
	3.14,
	-0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	'',
	' ',
	'hello',
	'abc',
	'42',
	'3.14',
	'true',
	'false',
	'0',
	'1',
	{},
	{ a: 1 },
	[],
	[1, 2],
	[1, '2'],
	['a', 'b'],
	new Map(),
	new Set(),
	10n,
	Symbol('s'),
	() => 1,
	new Date(),
]

/**
 * Return the parse↔guard soundness violations of a (guard, parser) pair over
 * {@link SOUNDNESS_SAMPLE} — an empty result means the pair is sound (AGENTS §14):
 * - **A** — a guard-valid input is returned UNCHANGED (by identity), never rejected.
 * - **B** — every non-`undefined` output satisfies the guard.
 *
 * @param guard - The guard for the parser's output type
 * @param parse - The parser under test
 * @returns Violation tags (`A@<index>` / `B@<index>`); empty when sound
 */
export function soundnessViolations<T>(
	guard: Guard<T>,
	parse: (value: unknown) => T | undefined,
): readonly string[] {
	const out: string[] = []
	for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
		const value = SOUNDNESS_SAMPLE[index]
		const parsed = parse(value)
		if (guard(value) && !Object.is(parsed, value)) out.push(`A@${index}`)
		if (parsed !== undefined && !guard(parsed)) out.push(`B@${index}`)
	}
	return out
}

// ── MarkdownParser AST assertions ─────────────────────────────────────────────
// Assert a parsed node IS a given element kind — throwing if not — and return it
// narrowed, so a test reads the typed node (`assertHeading(block).level`,
// `assertLink(node).href`) without an `as` or an `if`-guarded `expect` (both
// AGENTS-forbidden; §1 / §16). Thin assert-and-narrow wrappers over the parsers
// module's `is*` validators — one `assert{Element}` per guard — environment-agnostic,
// so they sit here beside the other base helpers, shared by the MarkdownParser unit
// test and the parser-validators test; `inlineText` is additionally reused by the
// guides-parity extractors in `setupGuides.ts`.

/** Parse `markdown` and narrow its FIRST block, asserting at least one exists. */
export function firstBlock(parser: MarkdownParserInterface, markdown: string): BlockNode {
	const block = parser.parse(markdown).children[0]
	if (block === undefined) throw new Error('expected at least one block')
	return block
}

export function assertHeadingNode(block: BlockNode): HeadingNode {
	if (!isHeadingNode(block)) throw new Error(`expected heading, got ${block.element}`)
	return block
}

export function assertListNode(block: BlockNode): ListNode {
	if (!isListNode(block)) throw new Error(`expected list, got ${block.element}`)
	return block
}

export function assertTableNode(block: BlockNode): TableNode {
	if (!isTableNode(block)) throw new Error(`expected table, got ${block.element}`)
	return block
}

export function assertParagraphNode(block: BlockNode | undefined): ParagraphNode {
	if (block === undefined || !isParagraphNode(block)) {
		throw new Error(`expected paragraph, got ${block?.element}`)
	}
	return block
}

export function assertCodeBlockNode(block: BlockNode): CodeBlockNode {
	if (!isCodeBlockNode(block)) throw new Error(`expected codeBlock, got ${block.element}`)
	return block
}

export function assertBlockquoteNode(block: BlockNode): BlockquoteNode {
	if (!isBlockquoteNode(block)) throw new Error(`expected blockquote, got ${block.element}`)
	return block
}

export function assertEmphasisNode(node: InlineNode | undefined): EmphasisNode {
	if (node === undefined || !isEmphasisNode(node)) {
		throw new Error(`expected emphasis, got ${node?.element}`)
	}
	return node
}

export function assertCodeSpanNode(node: InlineNode | undefined): InlineCodeNode {
	if (node === undefined || !isCodeSpanNode(node)) {
		throw new Error(`expected codeSpan, got ${node?.element}`)
	}
	return node
}

export function assertLinkNode(node: InlineNode | undefined): LinkNode {
	if (node === undefined || !isLinkNode(node))
		throw new Error(`expected link, got ${node?.element}`)
	return node
}

// Parse a single-paragraph markdown snippet, assert it yields exactly one
// paragraph, and return its first inline child narrowed to `InlineNode`.
export function assertInlineNode(parser: MarkdownParserInterface, markdown: string): InlineNode {
	const node = assertParagraphNode(firstBlock(parser, markdown)).children[0]
	if (node === undefined) throw new Error(`no inline node parsed from: ${markdown}`)
	return node
}

// The flattened text content of an inline-node tree (text + code values joined,
// descending through emphasis / link children) — a content assertion independent
// of the exact nesting.
export function inlineText(nodes: readonly InlineNode[]): string {
	return nodes
		.map((node) =>
			isTextNode(node) || isCodeSpanNode(node) ? node.value : inlineText(node.children),
		)
		.join('')
}

// ── Parsers test fixtures (environment-agnostic) ──────────────────────────────
// Shared streaming-drain helper for the NDJSON / SSE parsers — both feed a stream
// to a fresh parser handle in fixed-size chunks and flatten every parsed result
// (AGENTS §16.1: the same `drain(size)` closure, byte-for-byte, in both files).

/**
 * Feed `stream` to a fresh parser handle in fixed-size chunks, flattening every
 * parsed result — the shared shape of the NDJSON / SSE parsers' local `drain(size)`
 * closures (AGENTS §16.1): create a handle via `createHandle`, slice `stream` into
 * `size`-length pieces, call `.parse()` on each, and concatenate every result.
 *
 * @typeParam T - The element type each `.parse()` call yields
 * @param createHandle - Builds a fresh parser handle (a `new NDJSONParser()` /
 *   `new SSEParser()`, or any object with a matching `parse` method)
 * @param stream - The full wire content to feed in slices
 * @param size - The chunk length fed per `.parse()` call
 * @returns Every parsed result, in stream order
 */
export function drainInChunks<T>(
	createHandle: () => { parse: (chunk: string) => readonly T[] },
	stream: string,
	size: number,
): readonly T[] {
	const handle = createHandle()
	const results: T[] = []
	for (let index = 0; index < stream.length; index += size) {
		results.push(...handle.parse(stream.slice(index, index + size)))
	}
	return results
}

// ── Databases test fixtures ───────────────────────────────────────────────────
// Shared, environment-agnostic scenario builders for the `databases` / `relations` tests — a
// seeded table over the real in-memory reference driver, condition/schema
// literal factories, and a recording driver for the native-hook dispatch pins
// (AGENTS §16.1: real implementations and recorders, never mocks).

/**
 * Drain an `AsyncIterable<Row>` (a driver `scan`, a cursor stream) into an array
 * — the assertion-friendly counterpart to a streaming read.
 *
 * @param iterable - The async row source to consume to completion
 * @returns Every yielded row, in iteration order
 */
export async function collectRows(iterable: AsyncIterable<Row>): Promise<Row[]> {
	const rows: Row[] = []
	for await (const row of iterable) rows.push(row)
	return rows
}

/**
 * A minimal {@link TableSchema}`[]` for the named tables — each scan-only (empty
 * `columns` / `indexes`, `primary: 'id'`), enough to ready a table by name on a
 * driver that reads only `name` (the reference `MemoryDriver`).
 *
 * @param names - The table names to declare
 * @returns One scan-only schema per name
 */
export function tableSchemas(...names: readonly string[]): readonly TableSchema[] {
	return names.map((name) => ({ name, primary: 'id', columns: [], indexes: [] }))
}

/**
 * Build one {@link Condition} for a criteria/compiler test — the verbose literal
 * (`{ column, operator, values, connector }`) folded into a call.
 *
 * @param column - The {@link FieldPath} the condition reads (a string is ONE
 *   column, an array descends into a nested value)
 * @param operator - The WHERE comparison to apply
 * @param values - The operator's operands (none / one / two / a list)
 * @param connector - How this condition folds into the running result; defaults
 *   to `'and'` and is ignored on the first condition of a list
 * @returns The assembled condition
 */
export function buildCondition(
	column: FieldPath,
	operator: ConditionOperator,
	values: readonly unknown[],
	connector: Connector = 'and',
): Condition {
	return { column, operator, values, connector }
}

/** The shared `users` / `posts` shape maps for the cross-driver integration tests. */
export const INTEGRATION_TABLES = {
	users: { id: stringShape(), name: stringShape(), age: integerShape() },
	posts: { id: stringShape(), author: stringShape(), title: stringShape() },
} as const

/**
 * The relation map for {@link INTEGRATION_TABLES} — users have many posts, a post
 * belongs to its author — fed to `createRelationManager` in every cross-driver
 * integration test (the manager's `database` stays env-specific).
 */
export const INTEGRATION_RELATIONS = {
	users: { posts: hasMany('author') },
	posts: { author: belongsTo('author', 'users') },
} as const

/** A row of the canonical `users` table ({@link INTEGRATION_TABLES}` users`). */
export interface UserRow {
	readonly id: string
	readonly name: string
	readonly age: number
}

/**
 * Build one canonical `users` row (`{ id, name, age }`) — the single most-repeated row
 * literal across the database / driver / relations tests, folded into a factory with a
 * sensible default (`{ id: 'u1', name: 'Ada', age: 36 }`) plus per-call overrides so a
 * test names only the field its scenario varies (AGENTS §16.1). A plain data builder; the
 * shape matches {@link INTEGRATION_TABLES}` users`.
 *
 * @param overrides - Fields to override on the default row
 * @returns The assembled user row
 */
export function createUserRow(overrides?: Partial<UserRow>): UserRow {
	return { id: 'u1', name: 'Ada', age: 36, ...overrides }
}

/**
 * The recurring three-row `users` seed — `Ada` / `Grace` / `Edsger` (`u1` / `u2` / `u3`)
 * — the trio the densest CRUD / batch / query tests `set([...])` before exercising reads
 * (AGENTS §16.1). Built fresh each call (a new array of fresh rows) so a mutating test
 * never leaks into the next; each row is a {@link createUserRow} so the shape stays in one
 * place.
 *
 * @returns The three seed rows, in key order
 */
export function userRows(): readonly UserRow[] {
	return [
		createUserRow(),
		createUserRow({ id: 'u2', name: 'Grace', age: 45 }),
		createUserRow({ id: 'u3', name: 'Edsger', age: 50 }),
	]
}

/**
 * Stand up a LIVE, seeded `users` {@link import('@src/core').TableInterface} for the `databases`
 * entity tests — `createDatabase({ driver: createMemoryDriver(), tables: { users: columns } })`,
 * seed the rows, and return `db.table('users')` (AGENTS §16.1). The shared form of the per-file
 * `seeded()` the `Cursor` / `Query` / `Clause` tests each hand-rolled (each over the SAME base
 * `id` / `name` / `age` columns plus its own 4th column — a `role` literal, a `nickname` optional).
 * The caller passes its FULL `columns` map and `rows`; because `columns` is captured as a `const`
 * generic, the returned table's row type is `RowOf<C>` — inferred PRECISELY (the literal-union
 * `role`, the optional `nickname`), so each file keeps `type Users = Awaited<ReturnType<typeof
 * seeded>>` with NO `as` and NO widening to a bare `Row`. A real `databases` table over the in-memory
 * reference driver (NOT a mock); each call builds a FRESH database so a mutating test never leaks.
 *
 * @typeParam C - The `users` column map (captured `const` so its row type infers precisely)
 * @param options - `columns` (the full column map) and `rows` (the seed rows, typed `RowOf<C>`)
 * @returns The seeded `users` table, typed `TableInterface<RowOf<C>>`
 */
export async function seedUsersTable<const C extends Columns>(
	columns: C,
	seed: (users: TableInterface<RowOf<C>>) => Promise<unknown>,
): Promise<TableInterface<RowOf<C>>> {
	const database = createDatabase({ driver: createMemoryDriver(), tables: { users: columns } })
	const users = database.table('users')
	await seed(users)
	return users
}

/**
 * Stand up a constrained `users` {@link import('@src/core').DatabaseInterface} — the shared
 * shape `Database.test.ts`'s local `userDatabase()` and `Table.test.ts`'s local `userTable()`
 * each hand-rolled byte-for-byte (AGENTS §16.1): `createDatabase({ driver: createMemoryDriver(),
 * name: 'app', tables: { users: { id, name: min(1), age: min(0) } } })`. `error` forwards to the
 * database's own `EmitterErrorHandler` (the one axis `userDatabase` varied); a fresh database is
 * built on every call so a mutating test never leaks.
 *
 * @param error - The database's `EmitterErrorHandler`; omitted when not needed
 * @returns The database and its `users` table
 */
export function createConstrainedUsersDatabase(error?: EmitterErrorHandler): {
	readonly db: DatabaseInterface
	readonly users: TableInterface<UserRow>
} {
	const db = createDatabase({
		driver: createMemoryDriver(),
		name: 'app',
		tables: {
			users: { id: stringShape(), name: stringShape({ min: 1 }), age: integerShape({ min: 0 }) },
		},
		...(error === undefined ? {} : { error }),
	})
	return { db, users: db.table('users') }
}

/** One recorded call to {@link createRecordingDriver}'s native `aggregate` hook. */
export interface RecordingAggregate {
	readonly operation: AggregateFunction
	readonly column: FieldPath
	readonly criteria: Criteria
}

/**
 * A recording {@link DriverInterface} over a Map that ALSO implements the optional
 * native `records` / `count` / `aggregate` hooks (AGENTS §21) — a real driver, not
 * a mock. Rows are stored (so a scan WOULD return them), but the three hooks
 * short-circuit to a fixed sentinel and record what they were handed, so a test can
 * prove `Table` preferred the hook over the scan engine.
 */
export interface RecordingDriverInterface extends DriverInterface {
	/** The native filtered-read hook (always present here) — records its criteria. */
	records(table: string, criteria: Criteria): Promise<readonly Row[]>
	/** The native count hook (always present here) — records its criteria. */
	count(table: string, criteria: Criteria): Promise<number>
	/** The native aggregate hook (always present here) — records its arguments. */
	aggregate(
		table: string,
		operation: AggregateFunction,
		column: FieldPath,
		criteria: Criteria,
	): Promise<number | undefined>
}

/** The sentinel row {@link createRecordingDriver}'s native `records` hook returns. */
export const RECORDING_ROW: Row = { id: 'native', name: 'Native', age: 7 }

/** The sentinel total {@link createRecordingDriver}'s native `count` hook returns. */
export const RECORDING_COUNT = 999

/** The sentinel value {@link createRecordingDriver}'s native `aggregate` hook returns. */
export const RECORDING_AGGREGATE = 123

/**
 * Create a {@link RecordingDriverInterface} plus the arrays its native hooks
 * record into — a real Map-backed driver whose `records` / `count` / `aggregate`
 * return fixed sentinels ({@link RECORDING_ROW} / {@link RECORDING_COUNT} /
 * {@link RECORDING_AGGREGATE}) and push what they receive onto `recordsCalls` /
 * `countCalls` / `aggregateCalls`. Lets a test assert the native hook ran (and with
 * which arguments) instead of the scan engine. `aggregatesUndefined` makes the
 * `aggregate` hook resolve to `undefined` instead — to prove `Table` treats a
 * present hook as having handled the call even when its result is `undefined`.
 *
 * @param aggregatesUndefined - When `true`, the native `aggregate` hook resolves to
 *   `undefined` (still recording the call); defaults to `false`
 * @returns The driver and its three recorded-call arrays
 */
export function createRecordingDriver(aggregatesUndefined = false): {
	readonly driver: RecordingDriverInterface
	readonly recordsCalls: readonly Criteria[]
	readonly countCalls: readonly Criteria[]
	readonly aggregateCalls: readonly RecordingAggregate[]
} {
	const tables = new Map<string, Map<Key, Row>>()
	const recordsCalls: Criteria[] = []
	const countCalls: Criteria[] = []
	const aggregateCalls: RecordingAggregate[] = []
	const store = (table: string): Map<Key, Row> => {
		let map = tables.get(table)
		if (map === undefined) {
			map = new Map()
			tables.set(table, map)
		}
		return map
	}
	const driver: RecordingDriverInterface = {
		async open(schema) {
			for (const table of schema) {
				if (!tables.has(table.name)) tables.set(table.name, new Map())
			}
		},
		async close() {},
		async read(table, key) {
			const row = store(table).get(key)
			return row === undefined ? undefined : { ...row }
		},
		async write(table, key, row) {
			store(table).set(key, { ...row })
		},
		async delete(table, key) {
			return store(table).delete(key)
		},
		async keys(table) {
			return [...store(table).keys()]
		},
		async *scan(table) {
			for (const row of store(table).values()) yield { ...row }
		},
		async clear(table) {
			store(table).clear()
		},
		async snapshot() {
			return async () => {}
		},
		async records(_table, criteria) {
			recordsCalls.push(criteria)
			return [{ ...RECORDING_ROW }]
		},
		async count(_table, criteria) {
			countCalls.push(criteria)
			return RECORDING_COUNT
		},
		async aggregate(_table, operation, column, criteria) {
			aggregateCalls.push({ operation, column, criteria })
			return aggregatesUndefined ? undefined : RECORDING_AGGREGATE
		},
	}
	return { driver, recordsCalls, countCalls, aggregateCalls }
}

// ── Reasons fixtures & narrowing helpers (environment-agnostic) ───────────────
//
// AGENTS §16.1: the shared infrastructure of the reasons tests — one throwing
// narrowing helper per member of the `ReasonResult` union (so a test reads
// `expectQuantitative(result).value` with no casts, §14), the recurring subjects
// the evaluator / reasoner scenarios read, the one-static-factor definition the
// orchestrator / factory tests run, a REAL throwing `ReasonerInterface` for the
// bail / error-event paths (a scripted collaborator, not a mock), and the
// `Reflect.apply` raw-invocation idiom for feeding malformed input past the
// compile-time types. All plain `@src/core` data — no `node:*`, no DOM — so
// everything loads in every project.

/**
 * Narrow a `reason()` return to a `QuantitativeResult` — throws on a batch
 * array or a result of another reasoning, so assertions read the narrowed
 * result with no casts (AGENTS §14).
 *
 * @param result - The single-or-batch return of a `reason()` call
 * @returns The result, narrowed to `QuantitativeResult`
 */
export function expectQuantitative(
	result: ReasonResult | readonly ReasonResult[],
): QuantitativeResult {
	if (isArray<ReasonResult>(result)) throw new Error('Expected a single result, got a batch array')
	if (result.reasoning !== 'quantitative') {
		throw new Error(`Expected a quantitative result, got "${result.reasoning}"`)
	}
	return result
}

/**
 * Narrow a `reason()` return to a `LogicalResult` — throws on a batch array or
 * a result of another reasoning (the {@link expectQuantitative} sibling).
 *
 * @param result - The single-or-batch return of a `reason()` call
 * @returns The result, narrowed to `LogicalResult`
 */
export function expectLogical(result: ReasonResult | readonly ReasonResult[]): LogicalResult {
	if (isArray<ReasonResult>(result)) throw new Error('Expected a single result, got a batch array')
	if (result.reasoning !== 'logical') {
		throw new Error(`Expected a logical result, got "${result.reasoning}"`)
	}
	return result
}

/**
 * Narrow a `reason()` return to a `SymbolicResult` — throws on a batch array or
 * a result of another reasoning (the {@link expectQuantitative} sibling).
 *
 * @param result - The single-or-batch return of a `reason()` call
 * @returns The result, narrowed to `SymbolicResult`
 */
export function expectSymbolic(result: ReasonResult | readonly ReasonResult[]): SymbolicResult {
	if (isArray<ReasonResult>(result)) throw new Error('Expected a single result, got a batch array')
	if (result.reasoning !== 'symbolic') {
		throw new Error(`Expected a symbolic result, got "${result.reasoning}"`)
	}
	return result
}

/**
 * Narrow a `reason()` return to an `InferentialResult` — throws on a batch
 * array or a result of another reasoning (the {@link expectQuantitative} sibling).
 *
 * @param result - The single-or-batch return of a `reason()` call
 * @returns The result, narrowed to `InferentialResult`
 */
export function expectInferential(
	result: ReasonResult | readonly ReasonResult[],
): InferentialResult {
	if (isArray<ReasonResult>(result)) throw new Error('Expected a single result, got a batch array')
	if (result.reasoning !== 'inferential') {
		throw new Error(`Expected an inferential result, got "${result.reasoning}"`)
	}
	return result
}

/**
 * Recursively `Object.freeze` a value and every nested plain object/array it
 * reaches — the deep-frozen-input stress the no-mutation reasoner tests share
 * (AGENTS §16.1), so a mutation anywhere in the input tree throws in strict
 * mode instead of silently succeeding. Narrows with {@link isArray} /
 * {@link isRecord} (never an `as`, AGENTS §1) and recurses only into a plain
 * array's elements or a plain record's `Object.values` — any other value
 * (a primitive, `Date`, `Map`, function) is returned unchanged.
 *
 * @typeParam T - The value's type
 * @param value - The value to deep-freeze
 * @returns `value`, the same reference, frozen (and every plain nested
 *   object/array it reaches, frozen too)
 */
export function deepFreeze<T>(value: T): T {
	if (isArray(value)) {
		for (const item of value) deepFreeze(item)
		Object.freeze(value)
		return value
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) deepFreeze(item)
		Object.freeze(value)
		return value
	}
	return value
}

/**
 * The recurring flat `Subject` of the evaluator / reasoner tests — one field of
 * each scalar kind (number / string / boolean) plus an `id`, so check operators
 * and subject-binding paths read real data without re-typing the literal
 * (AGENTS §16.1).
 */
export const BASIC_SUBJECT: Subject = {
	id: 'subject-1',
	age: 30,
	name: 'Alice',
	score: 85,
	state: 'CA',
	employed: true,
}

/**
 * The recurring nested `Subject` — two levels of nesting for the `FieldPath`
 * array-descent cases (a STRING field is ONE key; an ARRAY descends).
 */
export const NESTED_SUBJECT: Subject = {
	id: 'nested-1',
	address: { city: 'NY', zip: '10001' },
	scores: { math: 90, english: 80 },
}

/**
 * The recurring driver-scoring `Subject` — the multi-factor scenario the
 * evaluator and quantitative-reasoner tests share (AGENTS §16.1).
 */
export const DRIVER_SUBJECT: Subject = {
	driverAge: 22,
	violationCount: 0,
	vehicleYear: 2020,
}

/**
 * Build the simplest runnable `QuantitativeDefinition` — one sum group holding
 * one static factor, producing `value` on ANY subject. The shared definition the
 * orchestrator / factory tests dispatch when the scenario only needs SOME
 * working definition (AGENTS §16.1).
 *
 * @param id - The definition id (and name); defaults to `'static-quant'`
 * @param value - The static factor's value (the run's result); defaults to `42`
 * @returns The assembled quantitative definition
 */
export function buildStaticDefinition(id = 'static-quant', value = 42): QuantitativeDefinition {
	return quantitativeDefinition(id, id, [factorGroup('g1', 'sum', [staticFactor('f1', value)])])
}

/**
 * Create a REAL `ReasonerInterface` whose `reason` always throws
 * `new Error(message)` — the scripted collaborator driving the orchestrator's
 * `bail` / `error`-event paths (AGENTS §16.1: a real implementation of the
 * seam, not a mock of the orchestrator).
 *
 * @param message - The thrown error's message; defaults to `'boom'`
 * @param reasoning - The reasoning to register under; defaults to `'quantitative'`
 * @returns A reasoner whose `reason` throws
 */
export function createThrowingReasoner(
	message = 'boom',
	reasoning: Reasoning = 'quantitative',
): ReasonerInterface {
	return {
		id: 'throwing',
		reasoning,
		supports: (definition) => definition.reasoning === reasoning,
		validate: () => ({ valid: true, errors: [], warnings: [] }),
		reason: () => {
			throw new Error(message)
		},
	}
}

/**
 * Invoke a method with deliberately malformed arguments, bypassing its
 * compile-time parameter types — the runtime-validation idiom for feeding a
 * unit under test input its signature forbids (a malformed definition, an
 * unknown operator) WITHOUT `as` (AGENTS §1/§14). `Reflect.apply` carries the
 * raw arguments past the type system while the method's declared RETURN type is
 * kept (pass `T` explicitly for overloaded methods), so assertions on the
 * result stay typed.
 *
 * @typeParam T - The method's return type
 * @param target - The receiver (`this`) to invoke the method on
 * @param method - The method whose parameter types are bypassed
 * @param args - The raw arguments to hand it
 * @returns Whatever the method returns
 */
export function invokeRaw<T>(
	target: unknown,
	method: (...args: never[]) => T,
	args: readonly unknown[],
): T {
	return Reflect.apply(method, target, [...args])
}

/**
 * Run `scenario` twice against fresh state and return both outcomes — the shared
 * form of the byte-identical `twice(scenario)` closure `DefinitionBuilder.test.ts`
 * and `SubjectBuilder.test.ts` each define locally (AGENTS §16.1), used throughout
 * both files to run a mutation scenario twice and deep-equal the two outcomes,
 * pinning both correctness and determinism in one assertion.
 *
 * @typeParam T - The scenario's return type
 * @param scenario - The (fresh-state) operation to run twice
 * @returns The two outcomes, in call order
 */
export function runTwice<T>(scenario: () => T): readonly [T, T] {
	return [scenario(), scenario()]
}

// ── Raters fixtures (environment-agnostic) ────────────────────────────────────

/**
 * Build a bare {@link LineResult} — the shared shape `Program.test.ts`'s local
 * `amountLine(id, amount?)` and `helpers.test.ts`'s local `lineResult(id, eligibility,
 * amount?)` each hand-rolled (AGENTS §16.1): `id` / `name` (both `id`), the given
 * `eligibility`, an empty `determinations`, and — when `amount` is given — the amount
 * plus a matching `Worksheet` (a one-group, one-step, successful sum). `amountLine`'s
 * callers (`sumAmounts`) never read the worksheet, so building it unconditionally with
 * `lineResult`'s fuller shape preserves both call sites' semantics.
 *
 * @param id - The line id (and name)
 * @param eligibility - The line's eligibility
 * @param amount - The line's resolved amount; when given, also builds a matching worksheet
 * @returns The assembled line result
 */
export function createLineResult(
	id: string,
	eligibility: Eligibility,
	amount?: number,
): LineResult {
	return {
		id,
		name: id,
		eligibility,
		...(amount === undefined ? {} : { amount }),
		...(amount === undefined
			? {}
			: {
					worksheet: {
						id,
						name: id,
						aggregation: 'sum',
						value: amount,
						groups: [],
						steps: [],
						trace: [],
						errors: [],
						success: true,
					},
				}),
		determinations: [],
	}
}

/**
 * Recursively `Object.isFrozen` a value and every nested plain object/array it
 * reaches — the canonical rename of `helpers.test.ts`'s local `deeplyFrozen`
 * guard (AGENTS §4.3/§16.1: a guard is named `is{Condition}`, never a bare
 * adjective). Non-object values (`null`, primitives) are vacuously frozen.
 *
 * @param value - The value to check
 * @returns Whether `value`, and every nested object/array it reaches, is frozen
 */
export function isDeeplyFrozen(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return true
	if (!Object.isFrozen(value)) return false
	return Object.values(value).every((child) => isDeeplyFrozen(child))
}

/** Build the recurring rater subject used by program, manager, and factory tests. */
export function createRatingSubject(overrides?: Partial<Subject>): Subject {
	return {
		id: 's1',
		state: 'CA',
		value: 100,
		limit: 1000,
		coastal: false,
		location: 'north',
		...overrides,
	}
}

/** Build a simple quantitative definition that reads the subject `value` field. */
export function createRatingDefinition(id = 'premium', name = 'Premium') {
	return quantitativeDefinition(id, name, [
		factorGroup('charge', 'sum', [staticFactor('base', 10), fieldFactor('value', 'value')]),
	])
}

/** Build a one-line property program with an optional eligibility pass. */
export function createPropertyProgramDefinition(id = 'property'): ProgramDefinition {
	const eligibility = logicalDefinition('property-gates', 'Property gates', [
		rule('coastal', [atom('coastal', 'equals', true)], atom('coastal', 'equals', true)),
	])
	return programDefinition(id, 'Property', {
		passes: [passDefinition(eligibility, 'building')],
		rulings: {
			coastal: rulingDefinition('referral', 'building', 'Coastal risk at {{location}}'),
		},
		notices: [noticeDefinition('notice', 'Value is {{value}}', 'building')],
		lines: [lineDefinition('building', 'Building', createRatingDefinition())],
	})
}

/** Build a program with authority rules reading the resolved `outcome` projection. */
export function createAuthorityProgramDefinition(id = 'authority'): ProgramDefinition {
	const authority = logicalDefinition('authority-gates', 'Authority gates', [
		rule('large', [atom(['outcome', 'total'], 'above', 100)], atom('large', 'equals', true)),
	])
	return programDefinition(id, 'Authority', {
		authority,
		rulings: {
			large: rulingDefinition('limit', undefined, 'Total {{outcome.total}} needs authority'),
		},
		lines: [lineDefinition('building', 'Building', createRatingDefinition())],
	})
}

/** Build a program whose aggregate gates read whole-batch and group projections. */
export function createAggregateProgramDefinition(id = 'aggregate'): ProgramDefinition {
	const gates = logicalDefinition('aggregate-gates', 'Aggregate gates', [
		rule(
			'portfolio',
			[atom(['aggregate', 'sums', 'value'], 'above', 150)],
			atom('portfolio', 'equals', true),
		),
		rule(
			'group',
			[atom(['aggregate', 'group', 'sums', 'value'], 'above', 120)],
			atom('group', 'equals', true),
		),
	])
	return programDefinition(id, 'Aggregate', {
		aggregate: aggregateDefinition(['value'], 'location', gates),
		rulings: {
			portfolio: rulingDefinition(
				'referral',
				undefined,
				'Portfolio value {{aggregate.sums.value}}',
			),
			group: rulingDefinition('condition', undefined, 'Group value {{aggregate.group.sums.value}}'),
		},
		lines: [lineDefinition('building', 'Building', createRatingDefinition())],
	})
}

// ── Scale & edge-case fixtures (environment-agnostic) ─────────────────────────
//
// AGENTS §16.1: the shared inputs the upcoming scale / numeric-quirk / adversarial-key
// tests would otherwise each re-derive — a pure integer range and a uniform-fill for
// scale/stress inputs, and two curated frozen constant arrays (JavaScript numeric edge
// values, adversarial/unicode object keys) so a field-path or aggregator test reads one
// canonical list instead of hand-rolling its own. All plain data — no `node:*`, no DOM.

/**
 * The contiguous integer range `[start, start + 1, …, start + count - 1]` — the pure
 * generator the scale / stress tests feed an aggregator or transformer instead of
 * hand-writing a literal (AGENTS §16.1). `count` values from `start` (default `0`);
 * an empty range for `count <= 0`.
 *
 * @param count - How many integers to produce
 * @param start - The first integer of the range; defaults to `0`
 * @returns The `count`-long ascending integer range
 */
export function sequence(count: number, start = 0): readonly number[] {
	return Array.from({ length: Math.max(count, 0) }, (_unused, index) => start + index)
}

/**
 * An array of `count` copies of `value` — the uniform-input fill the aggregator /
 * transformer scale tests exercise (AGENTS §16.1). For a reference `value` every slot
 * shares the one reference (a fill, not a deep clone); an empty array for `count <= 0`.
 *
 * @typeParam T - The element type
 * @param count - How many copies to produce
 * @param value - The value to repeat in every slot
 * @returns The `count`-long array of `value`
 */
export function repeatValue<T>(count: number, value: T): readonly T[] {
	return Array.from({ length: Math.max(count, 0) }, () => value)
}

/**
 * The curated JavaScript numeric edge values the numeric-quirk tests probe — signed
 * zero, the safe-integer and representable-magnitude bounds, `EPSILON`, an overflow-scale
 * pair, and the classic `0.1 + 0.2 !== 0.3` floats. Every entry is FINITE; the non-finite
 * cases (`NaN` / `±Infinity`) are named explicitly at their own sites, never smuggled in
 * here. Frozen so a test can share it without risk of mutation.
 */
export const EXTREME_NUMBERS: readonly number[] = Object.freeze([
	0,
	-0,
	1,
	-1,
	Number.MAX_SAFE_INTEGER,
	Number.MIN_SAFE_INTEGER,
	Number.MAX_VALUE,
	Number.MIN_VALUE,
	Number.EPSILON,
	1e308,
	-1e308,
	0.1,
	0.2,
	0.3,
])

/**
 * The curated adversarial / unicode object keys the field-path, subject-key, id, and
 * lookup-table tests probe — the `Object.prototype` / prototype-pollution names, an empty
 * key, a surrogate-pair (astral) key, a combining-sequence key, an NFC-labile key (`Å`
 * ANGSTROM SIGN, which NFC-normalizes to `Å`), and a DOTTED key (`'a.b'`) that proves a
 * single-string {@link FieldPath} is ONE key, never dot-split. Frozen so a test can share it
 * without risk of mutation.
 */
export const TRICKY_KEYS: readonly string[] = Object.freeze([
	'__proto__',
	'constructor',
	'prototype',
	'toString',
	'hasOwnProperty',
	'',
	'\u{1F600}',
	'é',
	'Å',
	'a.b',
])

/**
 * A `length`-long array with REAL holes everywhere except the given
 * `(index, value)` pairs — the sparse-array fixture the array-handling tests
 * probe (AGENTS §16.1). Built from `new Array(length)`, so unfilled slots are
 * genuine holes (absent from `Object.keys` / `for…in`, skipped by `forEach` /
 * `map`), never `undefined` values written into every slot.
 *
 * @typeParam T - The element type
 * @param length - The array's `length`
 * @param filled - The `[index, value]` pairs to assign; every other index stays a hole
 * @returns The `length`-long sparse array
 */
export function sparse<T>(length: number, filled: ReadonlyArray<readonly [number, T]>): T[] {
	const result: T[] = new Array(length)
	for (const [index, value] of filled) {
		result[index] = value
	}
	return result
}

/**
 * Nest `leaf` inside `depth` layers of a single-operand `'and'`
 * {@link compound} — the deep-expression-tree fixture the recursion / stack
 * -depth tests probe (AGENTS §16.1). `depth <= 0` returns `leaf` itself,
 * unwrapped.
 *
 * @param depth - How many `'and'` compound layers to nest
 * @param leaf - The innermost expression
 * @returns `leaf` wrapped in `depth` nested `'and'` compounds
 */
export function deepCompound(depth: number, leaf: Expression): Expression {
	let result = leaf
	for (let index = 0; index < depth; index += 1) {
		result = compound('and', [result])
	}
	return result
}

/**
 * Left-nest `depth` layers of an `'add'` {@link operation} around `leaf`,
 * each layer adding `step` — the deep-symbolic-tree fixture the recursion /
 * stack-depth tests probe (AGENTS §16.1). `depth <= 0` returns `leaf` itself,
 * unwrapped. When `step` is a `constant`, the resulting expression evaluates
 * to `leaf + depth * step`.
 *
 * @param depth - How many `'add'` operation layers to nest
 * @param leaf - The innermost expression
 * @param step - The right operand added at every layer
 * @returns `leaf` wrapped in `depth` nested `'add'` operations
 */
export function deepAddition(
	depth: number,
	leaf: SymbolicExpression,
	step: SymbolicExpression,
): SymbolicExpression {
	let result = leaf
	for (let index = 0; index < depth; index += 1) {
		result = operation('add', result, step)
	}
	return result
}

/**
 * A frozen {@link Subject} whose integer-like keys are authored deliberately
 * OUT of order — the enumeration-order fixture the subject-key / field-path
 * tests probe (AGENTS §16.1). Per the spec, integer-index string keys
 * (`"1"`, `"2"`, `"10"`) always enumerate ascending numerically FIRST,
 * regardless of authoring order, followed by the ordinary string keys in
 * insertion order: `Object.keys(INTEGER_KEY_SUBJECT)` yields
 * `['1', '2', '10', 'id', 'zeta', 'alpha']`. Every non-`id` value is a
 * NUMBER so the fixture serves `subjectToFacts` and symbolic binding alike.
 * Frozen so a test can share it without risk of mutation.
 */
export const INTEGER_KEY_SUBJECT: Subject = Object.freeze({
	'10': 10,
	'2': 2,
	zeta: 26,
	'1': 1,
	id: 'integer-key-subject',
	alpha: 1,
})

/** A symbol key used by {@link ADVERSARIAL_VALUE_SUBJECT} — invisible to `Object.keys`. */
export const ADVERSARIAL_SYMBOL_KEY: unique symbol = Symbol('adversarial')

/**
 * A frozen {@link Subject} exercising the adversarial value shapes
 * `subjectToFacts` must classify correctly (AGENTS §16.1): a
 * symbol-keyed property (invisible to `Object.keys`, so never surfaced as a
 * fact), plus string-keyed `bigint`, `symbol`, and `function` values — each
 * `typeof` is NOT `'object'`, so `subjectToFacts` keeps them as fact terms
 * rather than skipping them like it skips `null` / plain objects. Frozen so
 * a test can share it without risk of mutation.
 */
export const ADVERSARIAL_VALUE_SUBJECT: Subject = Object.freeze({
	id: 'adversarial-value-subject',
	[ADVERSARIAL_SYMBOL_KEY]: 'hidden',
	big: 9007199254740993n,
	sym: Symbol('value'),
	fn: () => 'adversarial',
})

/**
 * `count` subjects `{ id: "s0", value: 0 }, { id: "s1", value: 1 }, …` built
 * from {@link sequence} — the batch-of-subjects fixture the scale /
 * aggregation tests feed a database or reasoner instead of hand-writing a
 * literal array (AGENTS §16.1).
 *
 * @param count - How many subjects to produce
 * @returns The `count`-long array of subjects
 */
export function buildSubjects(count: number): readonly Subject[] {
	return sequence(count).map((index) => ({ id: `s${index}`, value: index }))
}

// ── Interprets fixtures (environment-agnostic) ────────────────────────────────

/**
 * Build a small, neutral `Template` — a single `value` entity mapping onto a
 * one-factor quantitative definition — the shared fixture the `interprets`
 * validator, helper, stage, and orchestrator tests seed a registry with
 * instead of hand-writing the same literal repeatedly (AGENTS §16.1).
 *
 * @param overrides - Fields merged over the neutral defaults
 * @returns The built template
 */
export function buildInterpretTemplate(overrides?: Partial<Template>): Template {
	return {
		id: 'template-1',
		name: 'Arithmetic',
		domain: 'arithmetic',
		intents: ['calculate'],
		mappings: [{ entity: 'value', aliases: ['amount', 'number'], field: 'value' }],
		defaults: [],
		computations: [],
		definition: quantitativeDefinition('template-1', 'Arithmetic', [
			factorGroup('total', 'sum', [fieldFactor('value', 'value')]),
		]),
		...overrides,
	}
}

/**
 * The neutral caller ACTION vocabulary the interprets integration corpus wires
 * into its `Extractor` (`token → action-name`). The redesign has no built-in
 * worldview (divergence ledger 6) — every domain/action word a template answers
 * to must be supplied here, not baked into core.
 */
export const INTERPRET_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
	calculate: 'calculate',
	check: 'check',
	validate: 'validate',
	compute: 'compute',
})

/**
 * The neutral caller DOMAIN vocabulary the interprets integration corpus wires
 * into its `Extractor` (`domain-name → keyword-list`). Per divergence ledger 18
 * a template's own `domain` no longer auto-classifies — a caller MUST list each
 * template's domain keywords here for domain classification to fire.
 */
export const INTERPRET_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	arithmetic: ['arithmetic'],
	insurance: ['insurance'],
	eligibility: ['eligibility', 'qualifies', 'qualify', 'eligible'],
	loan: ['loan'],
	statistics: ['statistics', 'stats'],
})

/**
 * Build the auto-insurance corpus template — the redesign's terrain-vocabulary
 * analog of scsr's `DEFAULT_TEMPLATES` insurance fixture: a required `age`
 * mapping, `accidents`/`coverage`/`deductible` defaults, and a declarative
 * `monthly = deductible / 12` computation (`operation('divide', …)` — the
 * closure-free `ComputedField` replacing scsr's `InferenceRule.compute`).
 *
 * @param overrides - Fields merged over the corpus defaults
 * @returns The built template
 */
export function buildInsuranceTemplate(overrides?: Partial<Template>): Template {
	return {
		id: 'insurance-auto',
		name: 'Auto Insurance',
		domain: 'insurance',
		intents: ['calculate'],
		mappings: [
			{ entity: 'age', aliases: ['years old', 'year old', 'years'], field: 'age', required: true },
			{ entity: 'accidents', aliases: ['accident', 'incidents'], field: 'accidents' },
			{ entity: 'coverage', aliases: ['plan', 'policy'], field: 'coverage' },
		],
		defaults: [
			{ field: 'accidents', value: 0 },
			{ field: 'coverage', value: 'standard' },
			{ field: 'deductible', value: 500 },
		],
		computations: [
			{ field: 'monthly', expression: operation('divide', variable('deductible'), constant(12)) },
		],
		definition: quantitativeDefinition('insurance-auto', 'Auto Insurance Rate', [
			factorGroup('age-group', 'product', [staticFactor('age-factor', 1)]),
		]),
		...overrides,
	}
}

/**
 * Build the eligibility corpus template — two optional mappings (`age`,
 * `score`) whose aliases exercise fuzzy keyword-proximity assignment against a
 * complex sentence, over an (empty-rule) logical definition.
 *
 * @param overrides - Fields merged over the corpus defaults
 * @returns The built template
 */
export function buildEligibilityTemplate(overrides?: Partial<Template>): Template {
	return {
		id: 'eligibility',
		name: 'Eligibility',
		domain: 'eligibility',
		intents: ['check', 'validate'],
		mappings: [
			{ entity: 'age', aliases: ['years old', 'year old', 'years'], field: 'age' },
			{ entity: 'score', aliases: ['credit score', 'credit', 'rating'], field: 'score' },
		],
		defaults: [],
		computations: [],
		definition: logicalDefinition('eligibility', 'Eligibility', []),
		...overrides,
	}
}

/**
 * Build the personal-loan corpus template — a distinct `loan` domain used to
 * pin multi-template best-match selection (the domain/action pair that scores
 * highest wins; no arbitrary `templates[0]` fallback).
 *
 * @param overrides - Fields merged over the corpus defaults
 * @returns The built template
 */
export function buildLoanTemplate(overrides?: Partial<Template>): Template {
	return {
		id: 'loan-personal',
		name: 'Personal Loan',
		domain: 'loan',
		intents: ['calculate'],
		mappings: [{ entity: 'amount', aliases: [], field: 'amount' }],
		defaults: [],
		computations: [],
		definition: quantitativeDefinition('loan-personal', 'Personal Loan', [
			factorGroup('total', 'sum', [fieldFactor('amount', 'amount')]),
		]),
		...overrides,
	}
}

/**
 * Build the statistics corpus template — a SINGLE `value` mapping so extraction
 * collects every number: one number lands as a scalar, several as an array the
 * `Generator` keeps AND augments with `Sum`/`Count`/`Average`/`Minimum`/`Maximum`.
 *
 * @param overrides - Fields merged over the corpus defaults
 * @returns The built template
 */
export function buildStatisticsTemplate(overrides?: Partial<Template>): Template {
	return {
		id: 'statistics',
		name: 'Statistics',
		domain: 'statistics',
		intents: ['compute'],
		mappings: [{ entity: 'value', aliases: [], field: 'value' }],
		defaults: [],
		computations: [],
		definition: quantitativeDefinition('statistics', 'Statistics', [
			factorGroup('total', 'sum', [fieldFactor('value', 'value')]),
		]),
		...overrides,
	}
}

/**
 * Build a minimal, complete-shaped {@link Interpretation} literal — the fixture
 * the `InterpretContext` history/carry-over tests push without running the full
 * orchestrator (AGENTS §16.1). Its single `age` entity and `intent.domain`
 * drive same-domain carry-over reads.
 *
 * @param overrides - Fields merged over the neutral defaults
 * @returns The built interpretation
 */
export function buildInterpretation(overrides?: Partial<Interpretation>): Interpretation {
	return {
		text: 'calculate insurance age 25',
		normalized: 'calculate insurance age 25',
		intent: { action: 'calculate', domain: 'insurance', confidence: 1 },
		entities: [
			{
				name: 'age',
				value: 25,
				provenance: { category: 'extracted', detail: 'keyword' },
				confidence: 1,
			},
		],
		subject: { age: 25 },
		definition: quantitativeDefinition('insurance-auto', 'Auto Insurance', [
			factorGroup('total', 'sum', [fieldFactor('age', 'age')]),
		]),
		mappings: [
			{
				field: 'age',
				entity: 'age',
				value: 25,
				provenance: { category: 'extracted' },
				confidence: 1,
			},
		],
		ambiguities: [],
		prompt: 'Calculate Auto Insurance with age: 25',
		stages: [],
		failures: [],
		complete: true,
		confidence: 1,
		digest: '00000000',
		...overrides,
	}
}

/**
 * Seed a REAL {@link InterpretContext} with `previous` — one `.add(...)` call per
 * given {@link Interpretation}, via the class's own public API — the canonical
 * replacement for `Clarifier.test.ts`'s hand-rolled `buildContext(previous)` fake
 * (a stubbed `InterpretContextInterface` over stub subject/definition managers,
 * AGENTS §16: "No mocks — use real implementations"). The real `InterpretContext`
 * flattens `previous`'s entities and exposes them the same way the fake did, so a
 * `Clarifier` carry-over scenario reads identically against either.
 *
 * @param previous - The prior interpretations to seed, in order
 * @returns A real `InterpretContext`, seeded with `previous`
 */
export function seedInterpretContext(previous: readonly Interpretation[]): InterpretContext {
	const context = new InterpretContext()
	for (const interpretation of previous) context.add(interpretation)
	return context
}
