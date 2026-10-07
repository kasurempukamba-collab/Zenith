'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { atomicWriteFileSync, readJsonWithFallback, quarantineFile } = require('../lib/atomicFile')

const tempDirs = []

function makeDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-atomic-'))
	tempDirs.push(dir)
	return dir
}

test.after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

test('atomicWriteFileSync: membuat folder induk dan menulis isi persis', () => {
	const file = path.join(makeDir(), 'dalam', 'lagi', 'data.json')
	atomicWriteFileSync(file, '{"a":1}')
	assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
})

test('atomicWriteFileSync: tidak meninggalkan file .tmp', () => {
	const file = path.join(makeDir(), 'data.json')
	atomicWriteFileSync(file, '1')
	atomicWriteFileSync(file, '2')
	assert.ok(!fs.existsSync(`${file}.tmp`))
})

test('atomicWriteFileSync: versi sebelumnya disimpan di .bak', () => {
	const file = path.join(makeDir(), 'data.json')
	atomicWriteFileSync(file, 'versi-1')
	assert.ok(!fs.existsSync(`${file}.bak`), 'penulisan pertama belum punya versi lama')
	atomicWriteFileSync(file, 'versi-2')
	atomicWriteFileSync(file, 'versi-3')
	assert.equal(fs.readFileSync(file, 'utf8'), 'versi-3')
	assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'versi-2')
})

test('atomicWriteFileSync: file hasil tulis hanya bisa dibaca pemiliknya (kecuali di Windows)', { skip: process.platform === 'win32' }, () => {
	const file = path.join(makeDir(), 'data.json')
	atomicWriteFileSync(file, 'x')
	assert.equal(fs.statSync(file).mode & 0o077, 0)
})

test('atomicWriteFileSync: rename yang gagal sesaat (EPERM) diulang sampai berhasil', () => {
	const file = path.join(makeDir(), 'data.json')
	const realRename = fs.renameSync
	let calls = 0
	fs.renameSync = (from, to) => {
		calls++
		if (calls <= 2) throw Object.assign(new Error('dikunci antivirus'), { code: 'EPERM' })
		return realRename(from, to)
	}
	try {
		atomicWriteFileSync(file, 'berhasil')
	} finally {
		fs.renameSync = realRename
	}
	assert.equal(calls, 3)
	assert.equal(fs.readFileSync(file, 'utf8'), 'berhasil')
	assert.ok(!fs.existsSync(`${file}.tmp`))
})

test('atomicWriteFileSync: rename yang gagal permanen jatuh ke tulis langsung (perubahan tidak hilang)', () => {
	const file = path.join(makeDir(), 'data.json')
	const realRename = fs.renameSync
	fs.renameSync = () => {
		throw Object.assign(new Error('lintas device'), { code: 'EXDEV' })
	}
	try {
		assert.doesNotThrow(() => atomicWriteFileSync(file, 'tetap-tersimpan'))
	} finally {
		fs.renameSync = realRename
	}
	assert.equal(fs.readFileSync(file, 'utf8'), 'tetap-tersimpan')
	assert.ok(!fs.existsSync(`${file}.tmp`))
})

test('readJsonWithFallback: file utama sehat dipakai langsung', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(file, '{"v":1}')
	const r = readJsonWithFallback(file)
	assert.deepEqual(r.data, { v: 1 })
	assert.equal(r.source, file)
	assert.deepEqual(r.corrupt, [])
})

test('readJsonWithFallback: tidak ada file sama sekali -> data null, tidak dianggap rusak', () => {
	const file = path.join(makeDir(), 'tidak-ada.json')
	const r = readJsonWithFallback(file)
	assert.equal(r.data, null)
	assert.equal(r.source, null)
	assert.deepEqual(r.corrupt, [])
})

test('readJsonWithFallback: file utama rusak -> pakai .bak dan laporkan yang rusak', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(file, '{rusak')
	fs.writeFileSync(`${file}.bak`, '{"v":"cadangan"}')
	const r = readJsonWithFallback(file)
	assert.deepEqual(r.data, { v: 'cadangan' })
	assert.equal(r.source, `${file}.bak`)
	assert.deepEqual(r.corrupt, [file])
})

test('readJsonWithFallback: file utama TIDAK ADA -> mulai bersih, .bak lama tidak dihidupkan kembali', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(`${file}.bak`, '{"v":"cadangan lama"}')
	const r = readJsonWithFallback(file)
	assert.equal(r.data, null)
	assert.equal(r.source, null)
	assert.deepEqual(r.corrupt, []) // tidak ada yang rusak, jadi tidak ada yang perlu dikarantina
})

test('readJsonWithFallback: utama rusak dan .bak tidak ada -> data null, hanya utama yang dilaporkan', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(file, '{rusak')
	const r = readJsonWithFallback(file)
	assert.equal(r.data, null)
	assert.deepEqual(r.corrupt, [file])
})

test('readJsonWithFallback: utama dan cadangan sama-sama rusak -> data null, keduanya dilaporkan', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(file, '')
	fs.writeFileSync(`${file}.bak`, '[[[')
	const r = readJsonWithFallback(file)
	assert.equal(r.data, null)
	assert.deepEqual(r.corrupt, [file, `${file}.bak`])
})

test('readJsonWithFallback: validate menolak struktur yang salah', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(file, '[1,2,3]')
	fs.writeFileSync(`${file}.bak`, '{"ok":true}')
	const r = readJsonWithFallback(file, { validate: (v) => v && typeof v === 'object' && !Array.isArray(v) })
	assert.deepEqual(r.data, { ok: true })
	assert.deepEqual(r.corrupt, [file])
})

test('readJsonWithFallback: reviver diteruskan ke JSON.parse', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(file, '{"n":2}')
	const r = readJsonWithFallback(file, { reviver: (k, v) => (k === 'n' ? v * 10 : v) })
	assert.deepEqual(r.data, { n: 20 })
})

test('quarantineFile: memindahkan file dengan isi utuh; null kalau file tidak ada', () => {
	const file = path.join(makeDir(), 'data.json')
	fs.writeFileSync(file, 'isi penting')
	const moved = quarantineFile(file)
	assert.ok(moved && moved.includes('.corrupt-'))
	assert.ok(!fs.existsSync(file))
	assert.equal(fs.readFileSync(moved, 'utf8'), 'isi penting')
	assert.equal(quarantineFile(path.join(makeDir(), 'nggak-ada.json')), null)
})
