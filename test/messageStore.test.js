'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { proto } = require('@whiskeysockets/baileys')
const MessageStore = require('../lib/messageStore')

const tempDirs = []

function makeFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-msgstore-'))
	tempDirs.push(dir)
	return path.join(dir, 'messages.json')
}

test.after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const JID = '628111111111@s.whatsapp.net'

function textMsg(id, text = 'halo', jid = JID, fromMe = true) {
	return { key: { remoteJid: jid, id, fromMe }, message: proto.Message.create({ extendedTextMessage: { text } }) }
}

function encode(message) {
	return Buffer.from(proto.Message.encode(message).finish())
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

test('rememberSent lalu get dengan key yang sama mengembalikan isi pesan', () => {
	const store = new MessageStore()
	const msg = textMsg('ID1', 'isi pesan')
	store.rememberSent(msg)
	assert.equal(store.get({ remoteJid: JID, id: 'ID1' }), msg.message)
})

test('get mengembalikan undefined untuk key yang tidak dikenal atau tidak valid', () => {
	const store = new MessageStore()
	store.rememberSent(textMsg('ID1'))
	assert.equal(store.get({ remoteJid: JID, id: 'TIDAK-ADA' }), undefined)
	assert.equal(store.get({ remoteJid: 'lain@s.whatsapp.net', id: 'ID1' }), undefined)
	assert.equal(store.get(null), undefined)
	assert.equal(store.get(undefined), undefined)
	assert.equal(store.get({ remoteJid: JID }), undefined)
})

test('pesan tanpa key/id/isi (mis. stub) diabaikan, tidak error', () => {
	const store = new MessageStore()
	assert.doesNotThrow(() => {
		store.rememberSent(null)
		store.rememberSent({})
		store.rememberSent({ key: { remoteJid: JID, id: 'X' } }) // tidak ada .message
		store.rememberReceived({ key: { id: 'X' }, message: {} }) // tidak ada remoteJid
	})
	assert.equal(store.size, 0)
})

test('rememberReceived bisa di-get, tapi TIDAK pernah ditulis ke disk', () => {
	const file = makeFile()
	const store = new MessageStore({ filePath: file })
	store.rememberReceived(textMsg('MASUK1', 'rahasia orang lain', JID, false))
	store.rememberSent(textMsg('KELUAR1', 'balasan bot'))
	assert.ok(store.get({ remoteJid: JID, id: 'MASUK1' }))

	store.flush()
	const isiFile = fs.readFileSync(file, 'utf8')
	assert.ok(!isiFile.includes('rahasia orang lain'))
	assert.ok(isiFile.includes('balasan bot'))

	const reloaded = new MessageStore({ filePath: file })
	assert.equal(reloaded.get({ remoteJid: JID, id: 'MASUK1' }), undefined)
	assert.ok(reloaded.get({ remoteJid: JID, id: 'KELUAR1' }))
})

test('pesan terkirim bertahan setelah "restart" dan hasil encode-nya identik byte-per-byte', () => {
	const file = makeFile()
	const store = new MessageStore({ filePath: file })

	const gambar = {
		key: { remoteJid: JID, id: 'IMG1', fromMe: true },
		message: proto.Message.create({
			imageMessage: {
				url: 'https://mmg.whatsapp.net/x',
				mimetype: 'image/jpeg',
				fileSha256: Buffer.from([1, 2, 3, 250, 251]),
				fileLength: 123456,
				mediaKey: Buffer.alloc(32, 7),
				jpegThumbnail: Buffer.alloc(300, 5),
				mediaKeyTimestamp: 1700000000,
			},
		}),
	}
	const mention = {
		key: { remoteJid: JID, id: 'MEN1', fromMe: true },
		message: proto.Message.create({
			extendedTextMessage: { text: 'halo @1', contextInfo: { mentionedJid: ['111@lid'], quotedMessage: { conversation: 'kutipan' } } },
		}),
	}
	store.rememberSent(gambar)
	store.rememberSent(mention)
	store.flush()

	const restarted = new MessageStore({ filePath: file })
	for (const original of [gambar, mention]) {
		const restored = restarted.get({ remoteJid: JID, id: original.key.id })
		assert.ok(restored, `pesan ${original.key.id} hilang setelah restart`)
		assert.ok(encode(restored).equals(encode(original.message)), `encode ${original.key.id} berubah setelah roundtrip`)
	}
})

test('jumlah dibatasi maxEntries: yang paling lama dibuang, yang terbaru bertahan', () => {
	const store = new MessageStore({ maxEntries: 3 })
	for (let i = 1; i <= 5; i++) store.rememberSent(textMsg(`ID${i}`))
	assert.equal(store.get({ remoteJid: JID, id: 'ID1' }), undefined)
	assert.equal(store.get({ remoteJid: JID, id: 'ID2' }), undefined)
	for (const id of ['ID3', 'ID4', 'ID5']) assert.ok(store.get({ remoteJid: JID, id }), id)
	assert.equal(store.sent.size, 3)
})

test('mencatat ulang key yang sama memperbarui posisinya (tidak jadi yang pertama dibuang)', () => {
	const store = new MessageStore({ maxEntries: 3 })
	store.rememberSent(textMsg('A'))
	store.rememberSent(textMsg('B'))
	store.rememberSent(textMsg('C'))
	store.rememberSent(textMsg('A', 'versi baru')) // A jadi yang terbaru
	store.rememberSent(textMsg('D')) // seharusnya B yang terbuang
	assert.equal(store.get({ remoteJid: JID, id: 'B' }), undefined)
	assert.ok(store.get({ remoteJid: JID, id: 'A' }))
	assert.equal(store.sent.size, 3)
})

test('memori pesan masuk juga terbatas (tidak bocor tanpa batas)', () => {
	const store = new MessageStore({ maxEntries: 3 })
	for (let i = 1; i <= 50; i++) store.rememberReceived(textMsg(`IN${i}`, 'x', JID, false))
	assert.equal(store.received.size, 3)
	assert.ok(store.get({ remoteJid: JID, id: 'IN50' }))
	assert.equal(store.get({ remoteJid: JID, id: 'IN1' }), undefined)
})

test('batas default pesan masuk tidak lebih dari 500 walau maxEntries besar', () => {
	const store = new MessageStore({ maxEntries: 5000 })
	for (let i = 0; i < 700; i++) store.rememberReceived(textMsg(`IN${i}`, 'x', JID, false))
	assert.equal(store.received.size, 500)
})

test('entri kedaluwarsa (TTL) tidak dikembalikan', async () => {
	const store = new MessageStore({ ttlMs: 50 })
	store.rememberSent(textMsg('LAMA'))
	assert.ok(store.get({ remoteJid: JID, id: 'LAMA' }))
	await sleep(90)
	assert.equal(store.get({ remoteJid: JID, id: 'LAMA' }), undefined)
	assert.equal(store.get({ remoteJid: JID, id: 'LAMA', fromMe: true }), undefined) // fallback lewat ID pun tidak
})

test('entri kedaluwarsa di file dilewati saat dimuat; yang masih segar dimuat', () => {
	const file = makeFile()
	const sekarang = Date.now()
	const entri = (id, umurMs) => ({
		id,
		jid: JID,
		at: sekarang - umurMs,
		m: { extendedTextMessage: { text: id } },
	})
	fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [entri('BASI', 3 * 3600_000), entri('SEGAR', 60_000)] }))

	const store = new MessageStore({ filePath: file, ttlMs: 3600_000 })
	assert.equal(store.get({ remoteJid: JID, id: 'BASI' }), undefined)
	assert.ok(store.get({ remoteJid: JID, id: 'SEGAR' }))
})

test('retry receipt dengan bentuk JID berbeda (LID vs nomor) tetap ketemu lewat ID, khusus pesan kita (fromMe)', () => {
	const store = new MessageStore()
	const msg = textMsg('KITA1', 'balasan')
	store.rememberSent(msg)

	const bentukLid = { remoteJid: '123456789012345@lid', id: 'KITA1' }
	assert.equal(store.get({ ...bentukLid, fromMe: true }), msg.message)
	assert.equal(store.get({ ...bentukLid, fromMe: false }), undefined) // bukan pesan kita -> hanya cocok persis
	assert.equal(store.get(bentukLid), undefined)
})

test('fallback lewat ID tidak mengembalikan pesan MASUK milik orang lain', () => {
	const store = new MessageStore()
	store.rememberReceived(textMsg('SAMA-ID', 'dari orang lain', JID, false))
	assert.equal(store.get({ remoteJid: '999@lid', id: 'SAMA-ID', fromMe: true }), undefined)
})

test('penulisan ke disk ditunda & digabung (debounce), bukan per pesan', async () => {
	const file = makeFile()
	const store = new MessageStore({ filePath: file, flushDelayMs: 40 })
	for (let i = 0; i < 10; i++) store.rememberSent(textMsg(`B${i}`))
	assert.ok(!fs.existsSync(file), 'belum boleh ada penulisan sebelum jeda habis')

	await sleep(120)
	assert.ok(fs.existsSync(file))
	const tersimpan = JSON.parse(fs.readFileSync(file, 'utf8')).entries.map((e) => e.id)
	assert.deepEqual(tersimpan, Array.from({ length: 10 }, (_, i) => `B${i}`))
})

test('timer flush tidak menahan proses agar bisa berhenti (unref)', () => {
	const store = new MessageStore({ filePath: makeFile(), flushDelayMs: 60_000 })
	store.rememberSent(textMsg('X'))
	assert.ok(store.timer)
	assert.equal(store.timer.hasRef(), false)
	store.flush() // bersihkan timer
	assert.equal(store.timer, null)
})

test('flush() tanpa perubahan tidak menulis file; dipanggil berulang aman', () => {
	const file = makeFile()
	const store = new MessageStore({ filePath: file })
	store.flush()
	assert.ok(!fs.existsSync(file))

	store.rememberSent(textMsg('X'))
	store.flush()
	const mtime1 = fs.statSync(file).mtimeMs
	store.flush()
	store.flush()
	assert.equal(fs.statSync(file).mtimeMs, mtime1)
})

test('file persist hanya bisa dibaca pemiliknya dan tidak meninggalkan .tmp/.bak (kecuali di Windows untuk mode)', () => {
	const file = makeFile()
	const store = new MessageStore({ filePath: file })
	store.rememberSent(textMsg('X'))
	store.flush()
	store.rememberSent(textMsg('Y'))
	store.flush()

	const files = fs.readdirSync(path.dirname(file))
	assert.deepEqual(files.sort(), ['messages.json'])
	if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0)
})

test('file rusak diamankan (tidak ditimpa), store mulai kosong, tidak crash', () => {
	const file = makeFile()
	const rusak = '{ "entries": [ {'
	fs.writeFileSync(file, rusak)

	const original = console.error
	const pesan = []
	console.error = (...args) => pesan.push(args.join(' '))
	let store
	try {
		store = new MessageStore({ filePath: file })
	} finally {
		console.error = original
	}

	assert.equal(store.size, 0)
	const karantina = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'))
	assert.equal(karantina.length, 1)
	assert.equal(fs.readFileSync(path.join(path.dirname(file), karantina[0]), 'utf8'), rusak)
	assert.ok(pesan.length >= 1)

	// Tetap bisa dipakai normal sesudahnya.
	store.rememberSent(textMsg('BARU'))
	store.flush()
	assert.ok(new MessageStore({ filePath: file }).get({ remoteJid: JID, id: 'BARU' }))
})

test('JSON valid tapi bukan format message store (tanpa entries) diperlakukan rusak', () => {
	for (const isi of ['[]', '{}', '{"entries":"bukan array"}', 'null']) {
		const file = makeFile()
		fs.writeFileSync(file, isi)
		const original = console.error
		console.error = () => {}
		try {
			assert.doesNotThrow(() => new MessageStore({ filePath: file }), isi)
		} finally {
			console.error = original
		}
		assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')), isi)
	}
})

test('satu entri rusak di dalam file dilewati, entri lain tetap dimuat', () => {
	const file = makeFile()
	const sekarang = Date.now()
	fs.writeFileSync(
		file,
		JSON.stringify({
			version: 1,
			entries: [
				null,
				{ id: 123, jid: JID, at: sekarang, m: {} },
				{ id: 'TANPA-ISI', jid: JID, at: sekarang },
				{ id: 'TANPA-WAKTU', jid: JID, m: { conversation: 'x' } },
				{ id: 'BAIK', jid: JID, at: sekarang, m: { conversation: 'oke' } },
			],
		})
	)
	const store = new MessageStore({ filePath: file })
	assert.equal(store.sent.size, 1)
	assert.ok(store.get({ remoteJid: JID, id: 'BAIK' }))
})

test('tanpa filePath: murni memori, tidak menyentuh disk dan tidak memasang timer', () => {
	const store = new MessageStore()
	store.rememberSent(textMsg('X'))
	assert.equal(store.timer, null)
	assert.doesNotThrow(() => store.flush())
})
