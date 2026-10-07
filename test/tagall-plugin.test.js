'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const tagall = require('../plugins/group/tagall')

function makeParticipants(count) {
	return Array.from({ length: count }, (_, i) => ({ id: `${100 + i}@lid` }))
}

function makeCtx({ members = 3, body = '', tagallConfig, participants } = {}) {
	const sent = []
	return {
		body,
		config: { prefix: '.', tagall: tagallConfig },
		groupMetadata: { participants: participants || makeParticipants(members) },
		reply: async (content) => {
			sent.push(content)
		},
		_sent: sent,
	}
}

test('grup kecil: satu pesan, format sama seperti sebelumnya (tanpa label bagian)', async () => {
	const ctx = makeCtx({ members: 3, body: 'ada rapat', tagallConfig: { chunkSize: 50, maxMembers: 256 } })
	await tagall.execute(ctx)

	assert.equal(ctx._sent.length, 1)
	assert.equal(ctx._sent[0].text, '📢 ada rapat\n\n@100 @101 @102')
	assert.deepEqual(ctx._sent[0].mentions, ['100@lid', '101@lid', '102@lid'])
})

test('tanpa teks pengumuman: memakai header bawaan', async () => {
	const ctx = makeCtx({ members: 2, body: '', tagallConfig: { chunkSize: 50, maxMembers: 256 } })
	await tagall.execute(ctx)
	assert.equal(ctx._sent[0].text, '📢 Tag semua anggota\n\n@100 @101')
})

test('grup lebih besar dari chunkSize dikirim bertahap, tiap bagian berlabel (i/n)', async () => {
	const ctx = makeCtx({ members: 7, body: 'kumpul', tagallConfig: { chunkSize: 3, maxMembers: 256 } })
	await tagall.execute(ctx)

	assert.equal(ctx._sent.length, 3)
	assert.deepEqual(ctx._sent.map((m) => m.mentions.length), [3, 3, 1])
	assert.equal(ctx._sent[0].text, '📢 kumpul (1/3)\n\n@100 @101 @102')
	assert.equal(ctx._sent[1].text, '📢 kumpul (2/3)\n\n@103 @104 @105')
	assert.equal(ctx._sent[2].text, '📢 kumpul (3/3)\n\n@106')
})

test('semua anggota ter-mention tepat satu kali, urutan terjaga, tidak ada yang terlewat/duplikat', async () => {
	const ctx = makeCtx({ members: 137, body: 'x', tagallConfig: { chunkSize: 50, maxMembers: 256 } })
	await tagall.execute(ctx)

	const semua = ctx._sent.flatMap((m) => m.mentions)
	assert.deepEqual(semua, makeParticipants(137).map((p) => p.id))
	assert.equal(new Set(semua).size, 137)
	assert.deepEqual(ctx._sent.map((m) => m.mentions.length), [50, 50, 37])
})

test('teks "@..." di tiap pesan cocok dengan daftar mentions pesan itu', async () => {
	const ctx = makeCtx({ members: 10, body: 'cek', tagallConfig: { chunkSize: 4, maxMembers: 256 } })
	await tagall.execute(ctx)

	for (const msg of ctx._sent) {
		const dariTeks = msg.text.split('\n\n')[1].split(' ')
		assert.deepEqual(dariTeks, msg.mentions.map((id) => `@${id.split('@')[0]}`))
	}
})

test('pengumuman diulang di setiap bagian (yang ter-mention di bagian belakang tetap paham konteksnya)', async () => {
	const ctx = makeCtx({ members: 9, body: 'rapat jam 8', tagallConfig: { chunkSize: 3, maxMembers: 256 } })
	await tagall.execute(ctx)
	for (const msg of ctx._sent) assert.ok(msg.text.includes('rapat jam 8'))
})

test('jumlah anggota tepat kelipatan chunkSize tidak menghasilkan pesan kosong', async () => {
	const ctx = makeCtx({ members: 6, tagallConfig: { chunkSize: 3, maxMembers: 256 } })
	await tagall.execute(ctx)
	assert.deepEqual(ctx._sent.map((m) => m.mentions.length), [3, 3])

	const ctx2 = makeCtx({ members: 3, tagallConfig: { chunkSize: 3, maxMembers: 256 } })
	await tagall.execute(ctx2)
	assert.equal(ctx2._sent.length, 1)
	assert.ok(!ctx2._sent[0].text.includes('(1/1)'), 'satu bagian tidak perlu label')
})

test('melebihi maxMembers: DITOLAK dengan penjelasan, tidak ada satu pun pesan mention terkirim', async () => {
	const ctx = makeCtx({ members: 11, body: 'x', tagallConfig: { chunkSize: 5, maxMembers: 10 } })
	await tagall.execute(ctx)

	assert.equal(ctx._sent.length, 1)
	assert.equal(typeof ctx._sent[0], 'string')
	assert.ok(!('mentions' in Object(ctx._sent[0])))
	assert.match(ctx._sent[0], /11 anggota/)
	assert.match(ctx._sent[0], /\(10 anggota\)/)
	assert.match(ctx._sent[0], /TAGALL_MAX_MEMBERS/)
})

test('tepat di batas maxMembers masih diizinkan', async () => {
	const ctx = makeCtx({ members: 10, tagallConfig: { chunkSize: 5, maxMembers: 10 } })
	await tagall.execute(ctx)
	assert.deepEqual(ctx._sent.map((m) => m.mentions.length), [5, 5])
})

test('tanpa config tagall memakai default: chunk 50, batas 256', async () => {
	const ctx = makeCtx({ members: 60, tagallConfig: undefined })
	await tagall.execute(ctx)
	assert.deepEqual(ctx._sent.map((m) => m.mentions.length), [50, 10])

	const besar = makeCtx({ members: 300, tagallConfig: undefined })
	await tagall.execute(besar)
	assert.equal(besar._sent.length, 1)
	assert.match(besar._sent[0], /300 anggota/)
})

test('nilai config tidak valid (0, negatif, bukan angka) memakai default, bukan infinite loop / error', async () => {
	for (const bad of [0, -5, 'abc', NaN, null, undefined]) {
		const ctx = makeCtx({ members: 60, tagallConfig: { chunkSize: bad, maxMembers: bad } })
		await tagall.execute(ctx)
		assert.deepEqual(ctx._sent.map((m) => m.mentions.length), [50, 10], `chunkSize/maxMembers=${String(bad)}`)
	}
})

test('daftar anggota kosong / tidak terbaca: balasan penjelasan, tidak crash', async () => {
	for (const participants of [[], undefined]) {
		const ctx = makeCtx({ tagallConfig: { chunkSize: 50, maxMembers: 256 } })
		ctx.groupMetadata = participants === undefined ? undefined : { participants }
		await tagall.execute(ctx)
		assert.deepEqual(ctx._sent, ['Tidak bisa membaca daftar anggota grup ini.'])
	}
})

test('peserta tanpa id disaring: tidak ada "@" kosong di teks dan tidak ada undefined di mentions', async () => {
	const ctx = makeCtx({
		participants: [{ id: '111@lid' }, {}, { id: '' }, { id: null }, { id: '222@lid' }],
		tagallConfig: { chunkSize: 50, maxMembers: 256 },
	})
	await tagall.execute(ctx)

	assert.equal(ctx._sent.length, 1)
	assert.deepEqual(ctx._sent[0].mentions, ['111@lid', '222@lid'])
	assert.equal(ctx._sent[0].text, '📢 Tag semua anggota\n\n@111 @222')

	const semuaTanpaId = makeCtx({ participants: [{}, { id: '' }], tagallConfig: { chunkSize: 50, maxMembers: 256 } })
	await tagall.execute(semuaTanpaId)
	assert.deepEqual(semuaTanpaId._sent, ['Tidak bisa membaca daftar anggota grup ini.'])
})

test('grup terbesar WhatsApp (1024) dengan batas dinaikkan: 21 pesan kecil, bukan satu pesan raksasa', async () => {
	const ctx = makeCtx({ members: 1024, body: 'pengumuman penting', tagallConfig: { chunkSize: 50, maxMembers: 1024 } })
	await tagall.execute(ctx)

	assert.equal(ctx._sent.length, 21)
	assert.ok(ctx._sent.every((m) => m.mentions.length <= 50))
	assert.ok(ctx._sent.every((m) => m.text.length < 2000), 'tiap pesan harus jauh di bawah batas ukuran teks')
	assert.equal(ctx._sent.flatMap((m) => m.mentions).length, 1024)
})

test('pengiriman dilakukan berurutan (await), bukan serentak', async () => {
	const order = []
	let inFlight = 0
	let maxInFlight = 0
	const ctx = makeCtx({ members: 9, tagallConfig: { chunkSize: 3, maxMembers: 256 } })
	ctx.reply = async (content) => {
		inFlight++
		maxInFlight = Math.max(maxInFlight, inFlight)
		await new Promise((resolve) => setTimeout(resolve, 20))
		order.push(content.mentions[0])
		inFlight--
	}
	await tagall.execute(ctx)

	assert.equal(maxInFlight, 1)
	assert.deepEqual(order, ['100@lid', '103@lid', '106@lid'])
})
