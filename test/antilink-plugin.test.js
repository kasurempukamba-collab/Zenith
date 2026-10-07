'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const antilink = require('../plugins/group/antilink')

function makeCtx({ antilinkOn = true, isGroup = true, isOwner = false, isSenderAdmin = false, text = 'lihat https://contoh.com', failControl = false } = {}) {
	const calls = []
	const key = { id: 'MSG1', remoteJid: 'grup1@g.us', participant: '111@lid' }
	return {
		isGroup,
		isOwner,
		isSenderAdmin,
		jid: 'grup1@g.us',
		text,
		msg: { key },
		config: { prefix: '.' },
		args: [],
		store: {
			getGroup: () => ({ antilink: antilinkOn, welcome: true }),
			setGroup: (jid, patch) => calls.push(['setGroup', jid, patch]),
		},
		// Jalur lama memakai sock.sendMessage langsung; kalau terpanggil, test gagal.
		sock: {
			sendMessage: async () => {
				throw new Error('sock.sendMessage dipanggil langsung -- melewati antrean anti-ban!')
			},
		},
		sendControl: async (content) => {
			calls.push(['sendControl', content])
			if (failControl) throw new Error('bot bukan admin')
		},
		reply: async (content, opts) => {
			calls.push(['reply', content, opts])
		},
		_calls: calls,
		_key: key,
	}
}

test('antilink ON + non-admin kirim link: pesan dihapus LEWAT sendControl, lalu ada pemberitahuan', async () => {
	const ctx = makeCtx()
	await antilink.onMessage(ctx)

	assert.equal(ctx._calls.length, 2)
	assert.deepEqual(ctx._calls[0], ['sendControl', { delete: ctx._key }]) // hapus dulu
	assert.equal(ctx._calls[1][0], 'reply') // baru pemberitahuan
	assert.match(ctx._calls[1][1], /dihapus otomatis/)
	assert.deepEqual(ctx._calls[1][2], { quoted: undefined }) // tidak mengutip pesan yang sudah dihapus
})

test('penghapusan tidak lagi memanggil sock.sendMessage langsung (tidak melewati antrean anti-ban)', async () => {
	const ctx = makeCtx()
	await assert.doesNotReject(() => antilink.onMessage(ctx)) // sock.sendMessage di ctx akan melempar error kalau dipanggil
	assert.equal(ctx._calls[0][0], 'sendControl')
})

test('admin dan owner boleh kirim link', async () => {
	for (const flags of [{ isSenderAdmin: true }, { isOwner: true }]) {
		const ctx = makeCtx(flags)
		await antilink.onMessage(ctx)
		assert.deepEqual(ctx._calls, [], JSON.stringify(flags))
	}
})

test('antilink OFF: tidak melakukan apa-apa', async () => {
	const ctx = makeCtx({ antilinkOn: false })
	await antilink.onMessage(ctx)
	assert.deepEqual(ctx._calls, [])
})

test('di luar grup: tidak melakukan apa-apa', async () => {
	const ctx = makeCtx({ isGroup: false })
	await antilink.onMessage(ctx)
	assert.deepEqual(ctx._calls, [])
})

test('mendeteksi http://, https://, www. (tanpa peduli huruf besar/kecil); teks tanpa link dibiarkan', async () => {
	for (const text of ['buka http://a.com', 'buka https://a.com/x?y=1', 'buka www.a.com', 'BUKA HTTPS://A.COM', 'ini  https://a.com di tengah kalimat']) {
		const ctx = makeCtx()
		ctx.text = text
		await antilink.onMessage(ctx)
		assert.equal(ctx._calls[0]?.[0], 'sendControl', `harus terdeteksi: ${text}`)
	}
	// ctx.text diset langsung (bukan lewat makeCtx) supaya nilai undefined tidak tergantikan default parameter.
	for (const text of ['halo semua', 'contoh.com tanpa skema', '', undefined]) {
		const ctx = makeCtx()
		ctx.text = text
		await antilink.onMessage(ctx)
		assert.deepEqual(ctx._calls, [], `tidak boleh terdeteksi: ${String(text)}`)
	}
})

test('penghapusan gagal (mis. bot bukan admin): error ditelan dan pemberitahuan TIDAK dikirim', async () => {
	const ctx = makeCtx({ failControl: true })
	await assert.doesNotReject(() => antilink.onMessage(ctx))
	assert.deepEqual(ctx._calls.map((c) => c[0]), ['sendControl']) // tidak ada 'reply'
})

test('perintah .antilink: tanpa argumen menampilkan status; on/off mengubah pengaturan grup', async () => {
	const status = makeCtx({ antilinkOn: false })
	await antilink.execute(status)
	assert.match(status._calls[0][1], /OFF/)

	const on = makeCtx()
	on.args = ['on']
	await antilink.execute(on)
	assert.deepEqual(on._calls[0], ['setGroup', 'grup1@g.us', { antilink: true }])
	assert.match(on._calls[1][1], /ON/)

	const off = makeCtx()
	off.args = ['OFF']
	await antilink.execute(off)
	assert.deepEqual(off._calls[0], ['setGroup', 'grup1@g.us', { antilink: false }])
})
