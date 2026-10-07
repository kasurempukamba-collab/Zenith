'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Store = require('../lib/store')
const { AntiBanGuard, AntiBanError } = require('../lib/antiban')

const tempDirs = []

function freshStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-antiban-'))
	tempDirs.push(dir)
	return new Store(path.join(dir, 'database.json'))
}

test.after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function baseConfig(overrides = {}) {
	return {
		antiban: {
			warmupMode: false,
			warmupDays: 3,
			minDelayMs: 150,
			maxDelayMs: 200,
			warmupMinDelayMs: 4000,
			warmupMaxDelayMs: 9000,
			newContactDailyCap: 2,
			warmupNewContactDailyCap: 1,
			simulateTyping: false, // dimatikan di test ini supaya waktu tes bisa dipastikan presisi
			...overrides,
		},
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function mockSock(sent) {
	return {
		presenceSubscribe: async () => {},
		sendPresenceUpdate: async () => {},
		sendMessage: async (jid, content) => {
			sent.push({ jid, content, t: Date.now() })
			return { key: {} }
		},
	}
}

// Socket tiruan yang meniru pengiriman sungguhan: butuh waktu, dan kita bisa mengukur berapa
// pengiriman yang sedang berjalan bersamaan.
function slowSock({ durationMs = 100, failFor = [] } = {}) {
	const state = { inFlight: 0, maxInFlight: 0, calls: [], presence: [] }
	state.sock = {
		presenceSubscribe: async (jid) => state.presence.push(['presenceSubscribe', jid]),
		sendPresenceUpdate: async (kind, jid) => state.presence.push([kind, jid]),
		sendMessage: async (jid, content) => {
			const call = { jid, content, start: Date.now(), end: null }
			state.calls.push(call)
			state.inFlight++
			state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
			await sleep(durationMs)
			state.inFlight--
			call.end = Date.now()
			if (failFor.includes(content.text)) throw new Error(`gagal kirim ${content.text}`)
			return { key: { id: `ID-${content.text || 'x'}`, remoteJid: jid }, message: content }
		},
	}
	return state
}

// Pesan "dari orang yang chat duluan" -> membalasnya bukan kontak baru.
function inbound(guard, ...jids) {
	for (const jid of jids) guard.noteInbound({ remoteJid: jid })
}

// ---------------------------------------------------------------------------
// Perilaku dasar (sudah ada sejak awal)
// ---------------------------------------------------------------------------

test('safeSend: beberapa pesan terkirim BERURUTAN sesuai urutan pemanggilan', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig(), store)
	const sent = []
	const sock = mockSock(sent)
	inbound(guard, 'a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net') // ketiganya yang chat duluan

	await Promise.all([
		guard.safeSend(sock, 'a@s.whatsapp.net', { text: '1' }),
		guard.safeSend(sock, 'b@s.whatsapp.net', { text: '2' }),
		guard.safeSend(sock, 'c@s.whatsapp.net', { text: '3' }),
	])

	assert.equal(sent.length, 3)
	assert.equal(sent[0].content.text, '1')
	assert.equal(sent[1].content.text, '2')
	assert.equal(sent[2].content.text, '3')
})

test('safeSend: benar-benar ada jeda antar pengiriman (tidak langsung ditembak semua)', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig(), store)
	const sent = []
	const sock = mockSock(sent)

	await guard.safeSend(sock, 'a@s.whatsapp.net', { text: '1' })
	await guard.safeSend(sock, 'b@s.whatsapp.net', { text: '2' })

	const gap = sent[1].t - sent[0].t
	assert.ok(gap >= 100, `jeda cuma ${gap}ms, seharusnya minimal sekitar minDelayMs`)
})

test('isWarmup: false kalau warmupMode dimatikan', () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ warmupMode: false }), store)
	assert.equal(guard.isWarmup(), false)
})

test('isWarmup: true di hari-hari pertama kalau warmupMode dinyalakan', () => {
	const store = freshStore() // firstRun = sekarang
	const guard = new AntiBanGuard(baseConfig({ warmupMode: true, warmupDays: 3 }), store)
	assert.equal(guard.isWarmup(), true)
})

test('kontak baru tercatat & tidak dihitung dua kali untuk JID yang sama', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig(), store)
	const sock = mockSock([])

	await guard.safeSend(sock, 'x@s.whatsapp.net', { text: 'a' })
	await guard.safeSend(sock, 'x@s.whatsapp.net', { text: 'b' }) // JID sama, bukan kontak baru lagi

	const known = store.get('knownJids', [])
	assert.equal(known.filter((j) => j === 'x@s.whatsapp.net').length, 1)
	assert.equal(guard.newContactsToday(), 1)
})

test('JID grup (@g.us) tidak dihitung sebagai "kontak baru"', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig(), store)
	const sock = mockSock([])

	await guard.safeSend(sock, 'grup1@g.us', { text: 'halo semua' })

	const known = store.get('knownJids', [])
	assert.equal(known.includes('grup1@g.us'), false)
})

// ---------------------------------------------------------------------------
// Temuan #1: antrean harus serial terhadap sock.sendMessage() yang sebenarnya
// ---------------------------------------------------------------------------

test('serial ketat: sock.sendMessage tidak pernah berjalan bersamaan, urutan terjaga', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ minDelayMs: 20, maxDelayMs: 20 }), store)
	const s = slowSock({ durationMs: 100 }) // pengiriman (100ms) JAUH lebih lama dari jeda (20ms)
	inbound(guard, ...[1, 2, 3, 4, 5].map((n) => `u${n}@s.whatsapp.net`))

	await Promise.all([1, 2, 3, 4, 5].map((n) => guard.safeSend(s.sock, `u${n}@s.whatsapp.net`, { text: String(n) })))

	assert.equal(s.maxInFlight, 1, `ada ${s.maxInFlight} pengiriman yang berjalan bersamaan`)
	assert.deepEqual(s.calls.map((c) => c.content.text), ['1', '2', '3', '4', '5'])
	for (let i = 1; i < s.calls.length; i++) {
		assert.ok(s.calls[i].start >= s.calls[i - 1].end, `pengiriman ${i + 1} mulai sebelum pengiriman ${i} selesai`)
	}
})

test('jeda dihitung dari saat pengiriman SELESAI, bukan dari sebelum dikirim', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ minDelayMs: 150, maxDelayMs: 150 }), store)
	const s = slowSock({ durationMs: 100 })
	inbound(guard, 'a@s.whatsapp.net', 'b@s.whatsapp.net')

	await Promise.all([
		guard.safeSend(s.sock, 'a@s.whatsapp.net', { text: '1' }),
		guard.safeSend(s.sock, 'b@s.whatsapp.net', { text: '2' }),
	])

	const gap = s.calls[1].start - s.calls[0].end
	assert.ok(gap >= 120, `jeda sejak pengiriman 1 selesai cuma ${gap}ms, seharusnya sekitar 150ms`)
})

test('satu pengiriman yang gagal tidak merusak antrean: pemanggil dapat error aslinya, pesan berikutnya tetap jalan', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ minDelayMs: 10, maxDelayMs: 10 }), store)
	const s = slowSock({ durationMs: 10, failFor: ['2'] })
	inbound(guard, 'a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net', 'd@s.whatsapp.net')

	const results = await Promise.allSettled([
		guard.safeSend(s.sock, 'a@s.whatsapp.net', { text: '1' }),
		guard.safeSend(s.sock, 'b@s.whatsapp.net', { text: '2' }), // gagal
		guard.safeSend(s.sock, 'c@s.whatsapp.net', { text: '3' }),
	])

	assert.equal(results[0].status, 'fulfilled')
	assert.equal(results[1].status, 'rejected')
	assert.equal(results[1].reason.message, 'gagal kirim 2')
	assert.equal(results[2].status, 'fulfilled')

	// Antrean masih sehat untuk pengiriman jauh sesudahnya.
	await guard.safeSend(s.sock, 'd@s.whatsapp.net', { text: '4' })
	assert.deepEqual(s.calls.map((c) => c.content.text), ['1', '2', '3', '4'])
})

test('pengiriman yang macet dilepas setelah timeout (SEND_TIMEOUT) dan tidak memblokir antrean selamanya', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ minDelayMs: 10, maxDelayMs: 10, sendTimeoutMs: 80 }), store)
	inbound(guard, 'a@s.whatsapp.net', 'b@s.whatsapp.net')

	let unhandled = 0
	const onUnhandled = () => unhandled++
	process.on('unhandledRejection', onUnhandled)

	const sent = []
	let call = 0
	const sock = {
		presenceSubscribe: async () => {},
		sendPresenceUpdate: async () => {},
		sendMessage: (jid, content) => {
			call++
			if (call === 1) return new Promise((_, reject) => setTimeout(() => reject(new Error('gagal belakangan')), 250))
			sent.push(content.text)
			return Promise.resolve({ key: {} })
		},
	}

	try {
		const t0 = Date.now()
		const macet = guard.safeSend(sock, 'a@s.whatsapp.net', { text: 'macet' })
		const normal = guard.safeSend(sock, 'b@s.whatsapp.net', { text: 'normal' })

		await assert.rejects(macet, (err) => err instanceof AntiBanError && err.code === 'SEND_TIMEOUT')
		await normal
		assert.deepEqual(sent, ['normal'])
		assert.ok(Date.now() - t0 < 1000)

		await sleep(300) // beri waktu penolakan "belakangan" dari pengiriman yang macet
		assert.equal(unhandled, 0, 'penolakan belakangan dari pengiriman yang sudah time-out tidak boleh jadi unhandled rejection')
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

test('hook onSent dipanggil dengan pesan yang terkirim; hook yang error tidak menggagalkan pengiriman', async () => {
	const store = freshStore()
	const seen = []
	const guard = new AntiBanGuard(baseConfig({ minDelayMs: 10, maxDelayMs: 10 }), store, {
		onSent: (sent) => {
			seen.push(sent.key.id)
			if (seen.length === 1) throw new Error('hook rusak')
		},
	})
	const s = slowSock({ durationMs: 5 })

	const r1 = await guard.safeSend(s.sock, 'a@s.whatsapp.net', { text: '1' })
	const r2 = await guard.sendControl(s.sock, 'a@s.whatsapp.net', { react: { text: '✅' } })

	assert.equal(r1.key.id, 'ID-1') // tetap berhasil walau hook melempar error
	assert.ok(r2)
	assert.deepEqual(seen, ['ID-1', 'ID-x'])
})

test('safeSend tetap menyimulasikan "mengetik" sebelum mengirim (composing -> paused -> kirim)', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ simulateTyping: true, minDelayMs: 10, maxDelayMs: 10 }), store)
	const events = []
	const sock = {
		presenceSubscribe: async () => events.push('subscribe'),
		sendPresenceUpdate: async (kind) => events.push(kind),
		sendMessage: async () => {
			events.push('kirim')
			return { key: {} }
		},
	}
	inbound(guard, 'a@s.whatsapp.net')

	await guard.safeSend(sock, 'a@s.whatsapp.net', { text: 'x' })
	assert.deepEqual(events, ['subscribe', 'composing', 'paused', 'kirim'])
})

// ---------------------------------------------------------------------------
// sendControl: reaksi & hapus pesan ikut antrean yang sama
// ---------------------------------------------------------------------------

test('sendControl ikut antrean serial yang sama (tidak pernah tumpang tindih dengan safeSend), urutan terjaga', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ minDelayMs: 20, maxDelayMs: 20 }), store)
	const s = slowSock({ durationMs: 80 })
	inbound(guard, 'a@s.whatsapp.net')

	await Promise.all([
		guard.sendControl(s.sock, 'a@s.whatsapp.net', { text: 'reaksi-1' }),
		guard.safeSend(s.sock, 'a@s.whatsapp.net', { text: 'balasan' }),
		guard.sendControl(s.sock, 'a@s.whatsapp.net', { text: 'reaksi-2' }),
	])

	assert.equal(s.maxInFlight, 1)
	assert.deepEqual(s.calls.map((c) => c.content.text), ['reaksi-1', 'balasan', 'reaksi-2'])
})

test('sendControl: tanpa simulasi mengetik, tapi tetap ada jarak minimum kecil dari pengiriman sebelumnya', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ simulateTyping: true, minDelayMs: 10, maxDelayMs: 10 }), store)
	const s = slowSock({ durationMs: 10 })
	inbound(guard, 'a@s.whatsapp.net')

	await guard.safeSend(s.sock, 'a@s.whatsapp.net', { text: 'balasan' })
	const presenceSetelahBalasan = s.presence.length
	await guard.sendControl(s.sock, 'a@s.whatsapp.net', { text: 'reaksi' })

	assert.equal(s.presence.length, presenceSetelahBalasan, 'sendControl tidak boleh memicu presence "mengetik"')
	const gap = s.calls[1].start - s.calls[0].end
	assert.ok(gap >= 250, `jarak reaksi dari pengiriman sebelumnya cuma ${gap}ms`)
	assert.ok(gap < 1000, `reaksi seharusnya tidak diberi jeda acak panjang (${gap}ms)`)
})

test('sendControl tidak dihitung sebagai kontak baru dan tidak diblokir batas harian', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 0 }), store)
	const sock = mockSock([])

	await guard.sendControl(sock, 'orang-tak-dikenal@s.whatsapp.net', { react: { text: '✅' } })

	assert.equal(guard.newContactsToday(), 0)
	assert.equal(store.get('knownJids', []).length, 0)
})

// ---------------------------------------------------------------------------
// Temuan #2 & #3: batas kontak baru harian DITEGAKKAN, dan hanya untuk chat yang bot mulai
// ---------------------------------------------------------------------------

test('batas harian ditegakkan: kontak baru ke-(batas+1) DIBLOKIR dan pesannya tidak dikirim', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 2, minDelayMs: 10, maxDelayMs: 10 }), store)
	const sent = []
	const sock = mockSock(sent)

	await guard.safeSend(sock, 'a@s.whatsapp.net', { text: '1' })
	await guard.safeSend(sock, 'b@s.whatsapp.net', { text: '2' })

	await assert.rejects(
		guard.safeSend(sock, 'c@s.whatsapp.net', { text: '3' }),
		(err) => err instanceof AntiBanError && err.code === 'NEW_CONTACT_CAP'
	)

	assert.deepEqual(sent.map((s) => s.jid), ['a@s.whatsapp.net', 'b@s.whatsapp.net'])
	assert.equal(guard.newContactsToday(), 2)
	assert.ok(!store.get('knownJids', []).includes('c@s.whatsapp.net'), 'kontak yang diblokir tidak boleh tercatat sebagai dikenal')
})

test('kontak yang sudah dikenal tetap bisa dikirimi walau batas harian sudah habis', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 1, minDelayMs: 10, maxDelayMs: 10 }), store)
	const sent = []
	const sock = mockSock(sent)

	await guard.safeSend(sock, 'a@s.whatsapp.net', { text: '1' })
	await assert.rejects(guard.safeSend(sock, 'b@s.whatsapp.net', { text: 'x' }), { code: 'NEW_CONTACT_CAP' })
	await guard.safeSend(sock, 'a@s.whatsapp.net', { text: '2' }) // a sudah dikenal

	assert.deepEqual(sent.map((s) => s.content.text), ['1', '2'])
})

test('membalas orang yang chat DULUAN tidak dihitung kontak baru dan tidak pernah diblokir', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 2, minDelayMs: 5, maxDelayMs: 5 }), store)
	const sent = []
	const sock = mockSock(sent)

	// 10 orang berbeda mengirim pesan duluan (jauh di atas batas 2) -> semua balasan harus lolos.
	for (let i = 1; i <= 10; i++) {
		const jid = `user${i}@s.whatsapp.net`
		guard.noteInbound({ remoteJid: jid })
		await guard.safeSend(sock, jid, { text: `balas ${i}` })
	}
	assert.equal(sent.length, 10)
	assert.equal(guard.newContactsToday(), 0)

	// Kuota "bot yang memulai chat" masih utuh: 2 boleh, ke-3 diblokir.
	await guard.safeSend(sock, 'asing1@s.whatsapp.net', { text: 'a' })
	await guard.safeSend(sock, 'asing2@s.whatsapp.net', { text: 'b' })
	await assert.rejects(guard.safeSend(sock, 'asing3@s.whatsapp.net', { text: 'c' }), { code: 'NEW_CONTACT_CAP' })
	assert.equal(guard.newContactsToday(), 2)
})

test('noteInbound: grup/broadcast/newsletter diabaikan, suffix device dibuang, remoteJidAlt ikut tercatat', () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig(), store)

	guard.noteInbound({ remoteJid: 'grup1@g.us' })
	guard.noteInbound({ remoteJid: 'status@broadcast' })
	guard.noteInbound({ remoteJid: '1203630@newsletter' })
	guard.noteInbound({ remoteJid: undefined })
	guard.noteInbound(null)
	assert.deepEqual(store.get('knownJids', []), [])

	guard.noteInbound({ remoteJid: '628111:12@s.whatsapp.net' }) // dengan suffix device
	guard.noteInbound({ remoteJid: '628111@s.whatsapp.net' }) // sama saja
	guard.noteInbound({ remoteJid: '9990001@lid', remoteJidAlt: '628222@s.whatsapp.net' }) // dua bentuk satu orang

	assert.deepEqual(store.get('knownJids', []).sort(), ['628111@s.whatsapp.net', '628222@s.whatsapp.net', '9990001@lid'])
})

test('batas harian terpisah untuk mode warm-up (pakai warmupNewContactDailyCap)', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(
		baseConfig({ warmupMode: true, warmupDays: 3, newContactDailyCap: 5, warmupNewContactDailyCap: 1, warmupMinDelayMs: 5, warmupMaxDelayMs: 5 }),
		store
	)
	const sock = mockSock([])

	await guard.safeSend(sock, 'a@s.whatsapp.net', { text: '1' })
	await assert.rejects(guard.safeSend(sock, 'b@s.whatsapp.net', { text: '2' }), { code: 'NEW_CONTACT_CAP' })
})

test('batas 0 = bot tidak boleh memulai chat dengan siapa pun, tapi tetap bisa membalas', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 0, minDelayMs: 5, maxDelayMs: 5 }), store)
	const sock = mockSock([])

	await assert.rejects(guard.safeSend(sock, 'asing@s.whatsapp.net', { text: 'x' }), { code: 'NEW_CONTACT_CAP' })

	guard.noteInbound({ remoteJid: 'teman@s.whatsapp.net' })
	await guard.safeSend(sock, 'teman@s.whatsapp.net', { text: 'oke' })
})

test('JID grup tidak pernah diblokir batas kontak baru walau kuota habis', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 0, minDelayMs: 5, maxDelayMs: 5 }), store)
	const sent = []
	const sock = mockSock(sent)

	await guard.safeSend(sock, 'grup1@g.us', { text: 'halo semua' })
	await guard.safeSend(sock, 'status@broadcast', { text: 'status' })
	assert.equal(sent.length, 2)
})

test('balapan: dua pengiriman bersamaan ke dua kontak baru saat sisa kuota 1 -> hanya satu yang lolos', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 1, minDelayMs: 5, maxDelayMs: 5 }), store)
	const sock = mockSock([])

	const results = await Promise.allSettled([
		guard.safeSend(sock, 'a@s.whatsapp.net', { text: '1' }),
		guard.safeSend(sock, 'b@s.whatsapp.net', { text: '2' }),
	])

	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
	assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
	assert.equal(guard.newContactsToday(), 1)
})

test('hitungan harian direset saat hari berganti', async () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 1, minDelayMs: 5, maxDelayMs: 5 }), store)
	const sock = mockSock([])

	guard._todayKey = () => '2030-01-01'
	await guard.safeSend(sock, 'a@s.whatsapp.net', { text: '1' })
	await assert.rejects(guard.safeSend(sock, 'b@s.whatsapp.net', { text: '2' }), { code: 'NEW_CONTACT_CAP' })

	guard._todayKey = () => '2030-01-02'
	assert.equal(guard.newContactsToday(), 0)
	await guard.safeSend(sock, 'b@s.whatsapp.net', { text: '2' }) // hari baru, kuota baru
	assert.equal(guard.newContactsToday(), 1)
})

test('kontak dikenal & hitungan harian bertahan setelah restart (store yang sama), batas tetap ditegakkan', async () => {
	const store = freshStore()
	const sock = mockSock([])

	const guard1 = new AntiBanGuard(baseConfig({ newContactDailyCap: 2, minDelayMs: 5, maxDelayMs: 5 }), store)
	await guard1.safeSend(sock, 'a@s.whatsapp.net', { text: '1' })
	await guard1.safeSend(sock, 'b@s.whatsapp.net', { text: '2' })
	guard1.noteInbound({ remoteJid: 'c@s.whatsapp.net' })

	const guard2 = new AntiBanGuard(baseConfig({ newContactDailyCap: 2, minDelayMs: 5, maxDelayMs: 5 }), store)
	assert.equal(guard2.newContactsToday(), 2)
	await guard2.safeSend(sock, 'a@s.whatsapp.net', { text: 'lagi' }) // dikenal
	await guard2.safeSend(sock, 'c@s.whatsapp.net', { text: 'balas' }) // chat duluan (dikenal)
	await assert.rejects(guard2.safeSend(sock, 'd@s.whatsapp.net', { text: 'baru' }), { code: 'NEW_CONTACT_CAP' })
})

test('log hitungan hari-hari lama dibersihkan, hari ini tetap utuh', async () => {
	const store = freshStore()
	store.set('newContactLog', { '2000-01-01': 7, '2000-01-02': 3 })
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 5, minDelayMs: 5, maxDelayMs: 5 }), store)

	await guard.safeSend(mockSock([]), 'a@s.whatsapp.net', { text: '1' })

	const log = store.get('newContactLog', {})
	assert.deepEqual(Object.keys(log), [guard._todayKey()])
	assert.equal(log[guard._todayKey()], 1)
})

test('daftar kontak dikenal dibatasi (yang paling lama dibuang), bukan membengkak tanpa batas', () => {
	const store = freshStore()
	const awal = Array.from({ length: 20_000 }, (_, i) => `u${i}@s.whatsapp.net`)
	store.set('knownJids', awal)
	const guard = new AntiBanGuard(baseConfig(), store)

	guard.noteInbound({ remoteJid: 'baru@s.whatsapp.net' })

	assert.equal(guard.knownJids.size, 20_000)
	assert.ok(guard.knownJids.has('baru@s.whatsapp.net'))
	assert.ok(!guard.knownJids.has('u0@s.whatsapp.net'), 'entri paling lama harus dibuang')
	assert.ok(guard.knownJids.has('u1@s.whatsapp.net'))
})

test('data store yang bentuknya salah tidak bikin crash (knownJids bukan array, newContactLog bukan objek)', async () => {
	const store = freshStore()
	store.set('knownJids', 'bukan-array')
	store.set('newContactLog', ['bukan', 'objek'])

	const guard = new AntiBanGuard(baseConfig({ minDelayMs: 5, maxDelayMs: 5 }), store)
	assert.equal(guard.knownJids.size, 0) // bukan Set dari karakter-karakter string
	assert.equal(guard.newContactsToday(), 0)
	await guard.safeSend(mockSock([]), 'a@s.whatsapp.net', { text: 'x' })
	assert.equal(guard.newContactsToday(), 1)
})

test('batas harian yang tidak valid di config memakai default (20 normal / 5 warm-up), tidak jadi tak terbatas', () => {
	const store = freshStore()
	const guard = new AntiBanGuard(baseConfig({ newContactDailyCap: 'abc', warmupNewContactDailyCap: undefined }), store)
	assert.equal(guard._newContactCap(false), 20)
	assert.equal(guard._newContactCap(true), 5)
})
