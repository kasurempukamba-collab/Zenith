'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const ai = require('../plugins/ai/chat')

function makeCtx({ body = 'apa itu Baileys?', ai: aiConfig } = {}) {
	const replies = []
	const reactions = []
	return {
		body,
		config: {
			prefix: '.',
			ai: { enabled: true, apiKey: 'kunci-rahasia', model: 'model-uji', systemPrompt: 'prompt-uji', timeoutMs: 5000, ...aiConfig },
		},
		reply: async (content) => {
			replies.push(content)
		},
		react: async (emoji) => {
			reactions.push(emoji)
		},
		_replies: replies,
		_reactions: reactions,
	}
}

function okResponse(text) {
	return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }), text: async () => '' }
}

// Mengganti global.fetch selama satu blok, lalu mengembalikannya (juga kalau test gagal).
async function withFetch(fake, fn) {
	const real = global.fetch
	global.fetch = fake
	try {
		return await fn()
	} finally {
		global.fetch = real
	}
}

// Menunggu sampai signal di-abort, lalu menolak dengan alasannya (meniru perilaku fetch asli).
// AbortSignal.timeout memakai timer "unref" (tidak menahan event loop). Di bot nyata WebSocket yang
// menjaga proses tetap hidup; di test mock, kita tahan event loop sendiri sampai abort terjadi.
function rejectOnAbort(signal) {
	return new Promise((_, reject) => {
		const keepAlive = setInterval(() => {}, 1000)
		const done = () => {
			clearInterval(keepAlive)
			reject(signal.reason)
		}
		if (signal.aborted) return done()
		signal.addEventListener('abort', done, { once: true })
	})
}

// ---------------------------------------------------------------------------
// Perilaku normal (tidak boleh berubah oleh penambahan timeout)
// ---------------------------------------------------------------------------

test('jawaban sukses: dibalas apa adanya (dirapikan), reaksi 🤔 lalu ✅', async () => {
	const ctx = makeCtx()
	await withFetch(async () => okResponse('  Baileys adalah library WhatsApp Web.  '), () => ai.execute(ctx))
	assert.deepEqual(ctx._replies, ['Baileys adalah library WhatsApp Web.'])
	assert.deepEqual(ctx._reactions, ['🤔', '✅'])
})

test('request ke API memakai URL, header, dan body yang benar + signal timeout', async () => {
	const ctx = makeCtx({ body: 'halo' })
	let captured
	await withFetch(
		async (url, init) => {
			captured = { url, init }
			return okResponse('ok')
		},
		() => ai.execute(ctx)
	)

	assert.equal(captured.url, 'https://api.anthropic.com/v1/messages')
	assert.equal(captured.init.method, 'POST')
	assert.equal(captured.init.headers['x-api-key'], 'kunci-rahasia')
	assert.equal(captured.init.headers['anthropic-version'], '2023-06-01')
	assert.equal(captured.init.headers['content-type'], 'application/json')
	assert.deepEqual(JSON.parse(captured.init.body), {
		model: 'model-uji',
		max_tokens: 1024,
		system: 'prompt-uji',
		messages: [{ role: 'user', content: 'halo' }],
	})
	assert.ok(captured.init.signal instanceof AbortSignal, 'request harus membawa AbortSignal sebagai batas waktu')
})

test('error HTTP dari API tetap dilaporkan seperti sebelumnya', async () => {
	const ctx = makeCtx()
	await withFetch(async () => ({ ok: false, status: 401, text: async () => 'kunci salah' }), () => ai.execute(ctx))
	assert.equal(ctx._replies.length, 1)
	assert.match(ctx._replies[0], /^⚠️ Gagal menghubungi AI: HTTP 401 — kunci salah/)
	assert.deepEqual(ctx._reactions, ['🤔', '❌'])
})

test('error jaringan biasa tidak disalahartikan sebagai timeout', async () => {
	const ctx = makeCtx()
	await withFetch(async () => { throw new TypeError('fetch failed') }, () => ai.execute(ctx))
	assert.deepEqual(ctx._replies, ['⚠️ Gagal menghubungi AI: fetch failed'])
	assert.ok(!/tidak merespons/.test(ctx._replies[0]))
})

test('fitur AI dimatikan: dibalas petunjuk, API tidak dipanggil', async () => {
	const ctx = makeCtx({ ai: { enabled: false } })
	let called = false
	await withFetch(async () => { called = true; return okResponse('x') }, () => ai.execute(ctx))
	assert.equal(called, false)
	assert.match(ctx._replies[0], /belum aktif/)
})

test('tanpa pertanyaan: dibalas contoh pemakaian, API tidak dipanggil', async () => {
	const ctx = makeCtx({ body: '' })
	let called = false
	await withFetch(async () => { called = true; return okResponse('x') }, () => ai.execute(ctx))
	assert.equal(called, false)
	assert.match(ctx._replies[0], /Contoh pakai: \.ai/)
})

// ---------------------------------------------------------------------------
// Temuan #4: timeout eksplisit
// ---------------------------------------------------------------------------

test('timeout dari config dipakai untuk AbortSignal.timeout; nilai tidak valid -> default 45 detik', async () => {
	const realTimeout = AbortSignal.timeout
	const dipakai = []
	AbortSignal.timeout = (ms) => {
		dipakai.push(ms)
		return new AbortController().signal
	}
	try {
		for (const timeoutMs of [1234, undefined, 0, -10, 'abc', null]) {
			const ctx = makeCtx({ ai: { timeoutMs } })
			await withFetch(async () => okResponse('ok'), () => ai.execute(ctx))
		}
	} finally {
		AbortSignal.timeout = realTimeout
	}
	assert.deepEqual(dipakai, [1234, 45000, 45000, 45000, 45000, 45000])
})

test('request yang macet sebelum header: dilepas tepat waktu dengan pesan timeout yang jelas', async () => {
	const ctx = makeCtx({ ai: { timeoutMs: 80 } })
	const t0 = Date.now()
	await withFetch((url, init) => rejectOnAbort(init.signal), () => ai.execute(ctx))

	assert.ok(Date.now() - t0 < 1500, 'seharusnya selesai mendekati timeout, bukan menggantung')
	assert.deepEqual(ctx._reactions, ['🤔', '❌'])
	assert.equal(ctx._replies.length, 1)
	assert.match(ctx._replies[0], /^⚠️ AI tidak merespons dalam 1 detik/)
})

test('request yang macet SAAT MEMBACA BODY (header sudah datang) juga dilepas', async () => {
	const ctx = makeCtx({ ai: { timeoutMs: 80 } })
	const t0 = Date.now()
	await withFetch(
		async (url, init) => ({
			ok: true,
			status: 200,
			json: () => rejectOnAbort(init.signal),
			text: () => rejectOnAbort(init.signal),
		}),
		() => ai.execute(ctx)
	)
	assert.ok(Date.now() - t0 < 1500)
	assert.match(ctx._replies[0], /tidak merespons/)
})

// Bukti dengan fetch ASLI Node (undici) terhadap server HTTP lokal yang sengaja macet,
// bukan hanya mock: memastikan AbortSignal benar-benar menutup kedua fase.
async function withLocalServer(handler, fn) {
	const server = http.createServer(handler)
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address()
	const realFetch = global.fetch
	global.fetch = (url, init) => realFetch(`http://127.0.0.1:${port}/v1/messages`, init)
	try {
		return await fn()
	} finally {
		global.fetch = realFetch
		server.closeAllConnections()
		await new Promise((resolve) => server.close(resolve))
	}
}

test('[fetch asli] server tidak pernah menjawab: perintah selesai di sekitar timeout, tidak menggantung', async () => {
	const ctx = makeCtx({ ai: { timeoutMs: 200 } })
	const t0 = Date.now()
	await withLocalServer(
		() => {
			/* menerima koneksi tapi tidak pernah membalas */
		},
		() => ai.execute(ctx)
	)
	const elapsed = Date.now() - t0
	assert.ok(elapsed >= 150 && elapsed < 2500, `selesai dalam ${elapsed}ms`)
	assert.match(ctx._replies[0], /tidak merespons/)
})

test('[fetch asli] server mengirim header lalu macet di tengah body: tetap dilepas', async () => {
	const ctx = makeCtx({ ai: { timeoutMs: 200 } })
	const t0 = Date.now()
	await withLocalServer(
		(req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.write('{"content":[{"type":"te') // body terpotong, tidak pernah selesai
		},
		() => ai.execute(ctx)
	)
	const elapsed = Date.now() - t0
	assert.ok(elapsed >= 150 && elapsed < 2500, `selesai dalam ${elapsed}ms`)
	assert.match(ctx._replies[0], /tidak merespons/)
})

test('[fetch asli] server normal: jawaban sampai utuh walau memakai signal timeout', async () => {
	const ctx = makeCtx({ ai: { timeoutMs: 2000 } })
	await withLocalServer(
		(req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ content: [{ type: 'text', text: 'jawaban dari server asli' }] }))
		},
		() => ai.execute(ctx)
	)
	assert.deepEqual(ctx._replies, ['jawaban dari server asli'])
	assert.deepEqual(ctx._reactions, ['🤔', '✅'])
})
