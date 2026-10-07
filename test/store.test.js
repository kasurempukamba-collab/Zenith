'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Store = require('../lib/store')

const tempDirs = []

function makeDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-store-'))
	tempDirs.push(dir)
	return path.join(dir, 'database.json')
}

function freshStore() {
	return new Store(makeDbPath())
}

// Test yang sengaja bikin file rusak akan memicu console.error/warn dari Store; tangkap supaya output test bersih.
function captureConsole(fn) {
	const original = { error: console.error, warn: console.warn }
	const messages = []
	console.error = (...args) => messages.push(args.join(' '))
	console.warn = (...args) => messages.push(args.join(' '))
	try {
		return { result: fn(), messages }
	} finally {
		console.error = original.error
		console.warn = original.warn
	}
}

function filesIn(dbPath) {
	return fs.readdirSync(path.dirname(dbPath))
}

test.after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

test('firstRun otomatis terisi tanggal valid', () => {
	const store = freshStore()
	assert.ok(store.firstRun)
	assert.ok(!Number.isNaN(new Date(store.firstRun).getTime()))
})

test('get/set nilai biasa', () => {
	const store = freshStore()
	store.set('selfMode', true)
	assert.equal(store.get('selfMode', false), true)
})

test('get mengembalikan default kalau key belum ada', () => {
	const store = freshStore()
	assert.equal(store.get('tidakAda', 'fallback'), 'fallback')
})

test('getGroup membuat default kalau grup belum pernah tercatat', () => {
	const store = freshStore()
	const g = store.getGroup('123@g.us')
	assert.equal(g.antilink, false)
	assert.equal(g.welcome, true)
})

test('setGroup melakukan merge, bukan replace total', () => {
	const store = freshStore()
	store.setGroup('123@g.us', { antilink: true })
	const g = store.getGroup('123@g.us')
	assert.equal(g.antilink, true)
	assert.equal(g.welcome, true) // properti lain tidak boleh hilang
})

test('data bertahan setelah file dibaca ulang (persist ke disk)', () => {
	const dbPath = makeDbPath()
	const store1 = new Store(dbPath)
	store1.set('selfMode', true)
	store1.setGroup('123@g.us', { antilink: true })

	const store2 = new Store(dbPath)
	assert.equal(store2.get('selfMode'), true)
	assert.equal(store2.getGroup('123@g.us').antilink, true)
})

test('tidak crash kalau file database korup', () => {
	const dbPath = makeDbPath()
	fs.writeFileSync(dbPath, '{ ini bukan json valid ][')
	assert.doesNotThrow(() => captureConsole(() => new Store(dbPath)))
})

test('penyimpanan atomik: tidak ada file .tmp tersisa dan versi sebelumnya masuk .bak', () => {
	const dbPath = makeDbPath()
	const store = new Store(dbPath)
	store.set('nilai', 'pertama')
	store.set('nilai', 'kedua')

	const files = filesIn(dbPath)
	assert.ok(!files.some((f) => f.endsWith('.tmp')), `file sementara tertinggal: ${files.join(', ')}`)

	assert.equal(JSON.parse(fs.readFileSync(dbPath, 'utf8')).settings.nilai, 'kedua')
	assert.equal(JSON.parse(fs.readFileSync(`${dbPath}.bak`, 'utf8')).settings.nilai, 'pertama')
})

test('crash saat menulis (file .tmp separuh jadi): data lama di file utama tetap utuh', () => {
	const dbPath = makeDbPath()
	const store1 = new Store(dbPath)
	store1.set('selfMode', true)
	const firstRun = store1.firstRun

	// Simulasi proses mati di tengah penyimpanan: sisa file sementara terpotong.
	fs.writeFileSync(`${dbPath}.tmp`, '{"meta":{"firstRun":"2020-01-01T00:00:00.000Z"},"groups":{},"sett')

	const { result: store2, messages } = captureConsole(() => new Store(dbPath))
	assert.equal(store2.get('selfMode'), true)
	assert.equal(store2.firstRun, firstRun)
	assert.deepEqual(messages, []) // file utama sehat, tidak ada yang perlu dilaporkan

	// Penyimpanan berikutnya harus tetap berjalan normal walau ada sisa .tmp.
	store2.set('selfMode', false)
	assert.equal(new Store(dbPath).get('selfMode'), false)
})

test('file utama rusak + cadangan .bak valid: data dipulihkan, file rusak diamankan (tidak hilang)', () => {
	const dbPath = makeDbPath()
	const store1 = new Store(dbPath)
	store1.setGroup('123@g.us', { antilink: true })
	store1.set('selfMode', true) // menghasilkan .bak yang sudah berisi grup + (sebelum selfMode)
	const firstRun = store1.firstRun

	const rusak = '{ separuh json yang rusak'
	fs.writeFileSync(dbPath, rusak)

	const { result: store2, messages } = captureConsole(() => new Store(dbPath))

	// Data lama diselamatkan dari cadangan: firstRun (warm-up) dan pengaturan grup tidak ter-reset.
	assert.equal(store2.firstRun, firstRun)
	assert.equal(store2.getGroup('123@g.us').antilink, true)

	// File rusak dipindahkan dengan isi utuh, bukan ditimpa.
	const quarantined = filesIn(dbPath).filter((f) => f.includes('.corrupt-'))
	assert.equal(quarantined.length, 1)
	assert.equal(fs.readFileSync(path.join(path.dirname(dbPath), quarantined[0]), 'utf8'), rusak)
	assert.ok(messages.some((m) => m.includes('rusak')), 'harus ada pesan yang memberi tahu file rusak')

	// File utama sudah sehat lagi.
	assert.doesNotThrow(() => JSON.parse(fs.readFileSync(dbPath, 'utf8')))
})

test('file utama sengaja dihapus (reset manual): mulai bersih, TIDAK dihidupkan lagi dari .bak', () => {
	const dbPath = makeDbPath()
	const store1 = new Store(dbPath)
	store1.set('a', 1)
	store1.set('b', 2) // .bak berisi a=1
	assert.ok(fs.existsSync(`${dbPath}.bak`))
	fs.unlinkSync(dbPath)

	const { result: store2, messages } = captureConsole(() => new Store(dbPath))
	assert.equal(store2.get('a', 'kosong'), 'kosong')
	assert.equal(store2.get('b', 'kosong'), 'kosong')
	assert.deepEqual(messages, []) // menghapus file bukan kerusakan, tidak perlu peringatan
	assert.ok(fs.existsSync(dbPath), 'file utama baru harus dibuat')
	assert.ok(!filesIn(dbPath).some((f) => f.includes('.corrupt-')))
})

test('file utama rusak dan tidak ada cadangan: mulai kosong TAPI file rusak tetap diamankan', () => {
	const dbPath = makeDbPath()
	const rusak = '\u0000\u0000 bukan json'
	fs.writeFileSync(dbPath, rusak)

	const { result: store } = captureConsole(() => new Store(dbPath))
	assert.equal(store.get('apapun', 'default'), 'default')
	assert.ok(!Number.isNaN(new Date(store.firstRun).getTime()))

	const quarantined = filesIn(dbPath).filter((f) => f.includes('.corrupt-'))
	assert.equal(quarantined.length, 1)
	assert.equal(fs.readFileSync(path.join(path.dirname(dbPath), quarantined[0]), 'utf8'), rusak)
})

test('JSON valid tapi bentuknya salah (array / null) diperlakukan sebagai rusak, tidak crash', () => {
	for (const isi of ['[]', 'null', '123', '"teks"']) {
		const dbPath = makeDbPath()
		fs.writeFileSync(dbPath, isi)
		const { result: store } = captureConsole(() => new Store(dbPath))
		assert.equal(store.get('x', 'd'), 'd', `isi: ${isi}`)
		assert.ok(filesIn(dbPath).some((f) => f.includes('.corrupt-')), `isi: ${isi}`)
	}
})

test('bagian meta/groups/settings yang tipenya salah dinormalisasi, bukan bikin crash', () => {
	const dbPath = makeDbPath()
	fs.writeFileSync(
		dbPath,
		JSON.stringify({ meta: { firstRun: '2024-01-01T00:00:00.000Z' }, groups: 'salah', settings: ['salah'] })
	)
	const store = new Store(dbPath)
	assert.equal(store.firstRun, '2024-01-01T00:00:00.000Z')
	assert.doesNotThrow(() => store.getGroup('1@g.us'))
	assert.doesNotThrow(() => store.set('k', 'v'))
	assert.equal(store.get('k'), 'v')
})

test('firstRun yang hilang/tidak valid di file lama diperbaiki dan disimpan (warm-up tidak macet selamanya)', () => {
	for (const meta of [{}, { firstRun: 'bukan-tanggal' }, { firstRun: 12345 }]) {
		const dbPath = makeDbPath()
		fs.writeFileSync(dbPath, JSON.stringify({ meta, groups: {}, settings: { x: 1 } }))

		const store1 = new Store(dbPath)
		assert.ok(!Number.isNaN(new Date(store1.data.meta.firstRun).getTime()))

		// Harus stabil antar pembacaan & antar restart (sebelumnya selalu "sekarang").
		const store2 = new Store(dbPath)
		assert.equal(store2.firstRun, store1.firstRun)
		assert.equal(store2.get('x'), 1)
	}
})
