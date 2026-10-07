'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const CONFIG_PATH = path.join(__dirname, '..', 'config.js')

const CONFIG_KEYS = [
	'NEW_CONTACT_DAILY_CAP',
	'WARMUP_NEW_CONTACT_DAILY_CAP',
	'SEND_TIMEOUT_MS',
	'MIN_DELAY_MS',
	'MAX_DELAY_MS',
	'WARMUP_DAYS',
	'AI_TIMEOUT_MS',
	'ANTHROPIC_API_KEY',
	'TAGALL_CHUNK_SIZE',
	'TAGALL_MAX_MEMBERS',
	'MESSAGE_STORE_MAX_ENTRIES',
	'MESSAGE_STORE_TTL_HOURS',
]

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-config-'))

test.after(() => {
	fs.rmSync(emptyDir, { recursive: true, force: true })
})

// config.js dimuat di proses terpisah dengan cwd kosong: .env asli developer tidak boleh ikut memengaruhi test.
function loadConfig(overrides = {}) {
	const env = { ...process.env }
	for (const key of CONFIG_KEYS) delete env[key]
	Object.assign(env, overrides)

	const script = `console.log('@@' + JSON.stringify(require(${JSON.stringify(CONFIG_PATH)})))`
	const stdout = execFileSync(process.execPath, ['-e', script], { cwd: emptyDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
	return JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
}

test('default pengaturan baru sesuai yang didokumentasikan', () => {
	const c = loadConfig()
	assert.equal(c.antiban.newContactDailyCap, 20)
	assert.equal(c.antiban.warmupNewContactDailyCap, 5)
	assert.equal(c.antiban.sendTimeoutMs, 120000)
	assert.equal(c.ai.timeoutMs, 45000)
	assert.deepEqual(c.tagall, { chunkSize: 50, maxMembers: 256 })
	assert.deepEqual(c.messageStore, { maxEntries: 1000, ttlMs: 48 * 3_600_000 })
})

test('nilai KOSONG di .env memakai default (bukan 0): jeda anti-ban tidak boleh diam-diam hilang & batas tidak jadi memblokir semua', () => {
	const c = loadConfig({
		NEW_CONTACT_DAILY_CAP: '',
		WARMUP_NEW_CONTACT_DAILY_CAP: '   ',
		MIN_DELAY_MS: '',
		MAX_DELAY_MS: ' ',
		WARMUP_DAYS: '',
		AI_TIMEOUT_MS: '',
		SEND_TIMEOUT_MS: '',
	})
	assert.equal(c.antiban.newContactDailyCap, 20)
	assert.equal(c.antiban.warmupNewContactDailyCap, 5)
	assert.equal(c.antiban.minDelayMs, 1200)
	assert.equal(c.antiban.maxDelayMs, 3500)
	assert.equal(c.antiban.warmupDays, 3)
	assert.equal(c.ai.timeoutMs, 45000)
	assert.equal(c.antiban.sendTimeoutMs, 120000)
})

test('batas harian 0 yang ditulis eksplisit dihormati (artinya: bot tidak boleh memulai chat)', () => {
	const c = loadConfig({ NEW_CONTACT_DAILY_CAP: '0', WARMUP_NEW_CONTACT_DAILY_CAP: '0' })
	assert.equal(c.antiban.newContactDailyCap, 0)
	assert.equal(c.antiban.warmupNewContactDailyCap, 0)
})

test('batas harian negatif / bukan angka memakai default', () => {
	const c = loadConfig({ NEW_CONTACT_DAILY_CAP: '-3', WARMUP_NEW_CONTACT_DAILY_CAP: 'banyak' })
	assert.equal(c.antiban.newContactDailyCap, 20)
	assert.equal(c.antiban.warmupNewContactDailyCap, 5)
})

test('batas harian desimal dibulatkan ke bawah', () => {
	const c = loadConfig({ NEW_CONTACT_DAILY_CAP: '7.9' })
	assert.equal(c.antiban.newContactDailyCap, 7)
})

test('timeout, ukuran batch, dan batas penyimpanan yang 0 / negatif / bukan angka memakai default', () => {
	for (const bad of ['0', '-5', 'abc']) {
		const c = loadConfig({
			AI_TIMEOUT_MS: bad,
			SEND_TIMEOUT_MS: bad,
			TAGALL_CHUNK_SIZE: bad,
			TAGALL_MAX_MEMBERS: bad,
			MESSAGE_STORE_MAX_ENTRIES: bad,
			MESSAGE_STORE_TTL_HOURS: bad,
		})
		assert.equal(c.ai.timeoutMs, 45000, `AI_TIMEOUT_MS=${bad}`)
		assert.equal(c.antiban.sendTimeoutMs, 120000, `SEND_TIMEOUT_MS=${bad}`)
		assert.equal(c.tagall.chunkSize, 50, `TAGALL_CHUNK_SIZE=${bad}`)
		assert.equal(c.tagall.maxMembers, 256, `TAGALL_MAX_MEMBERS=${bad}`)
		assert.equal(c.messageStore.maxEntries, 1000, `MESSAGE_STORE_MAX_ENTRIES=${bad}`)
		assert.equal(c.messageStore.ttlMs, 48 * 3_600_000, `MESSAGE_STORE_TTL_HOURS=${bad}`)
	}
})

test('nilai kustom yang valid dihormati', () => {
	const c = loadConfig({
		AI_TIMEOUT_MS: '60000',
		SEND_TIMEOUT_MS: '30000',
		TAGALL_CHUNK_SIZE: '30.9',
		TAGALL_MAX_MEMBERS: '500',
		MESSAGE_STORE_MAX_ENTRIES: '200',
		MESSAGE_STORE_TTL_HOURS: '1.5',
		MIN_DELAY_MS: '2000',
	})
	assert.equal(c.ai.timeoutMs, 60000)
	assert.equal(c.antiban.sendTimeoutMs, 30000)
	assert.equal(c.tagall.chunkSize, 30)
	assert.equal(c.tagall.maxMembers, 500)
	assert.equal(c.messageStore.maxEntries, 200)
	assert.equal(c.messageStore.ttlMs, 5_400_000)
	assert.equal(c.antiban.minDelayMs, 2000)
})
