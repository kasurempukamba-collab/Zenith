'use strict'

const ui = require('./ui')

const DEFAULT_SEND_TIMEOUT_MS = 120_000
const DEFAULT_NEW_CONTACT_CAP = 20
const DEFAULT_WARMUP_NEW_CONTACT_CAP = 5

// Pesan "kontrol" (reaksi, hapus pesan) bukan percakapan: tidak diberi jeda acak 1-3 detik dan
// tidak memakai simulasi mengetik, tapi tetap diberi jarak minimum supaya tidak menembak beruntun.
const CONTROL_MIN_GAP_MS = 300

// Batas penyimpanan supaya data tidak membengkak tanpa batas.
const MAX_KNOWN_JIDS = 20_000
const LOG_RETENTION_DAYS = 14

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Error yang sengaja dilempar lapisan anti-ban (bukan bug). Cek `err.code`. */
class AntiBanError extends Error {
	constructor(message, code) {
		super(message)
		this.name = 'AntiBanError'
		this.code = code // 'NEW_CONTACT_CAP' | 'SEND_TIMEOUT'
	}
}

// Hanya chat pribadi (nomor telepon atau LID) yang dianggap "kontak". Grup, broadcast/status,
// dan newsletter bukan kontak. Akhiran device (":12") dibuang supaya satu orang = satu entri.
const USER_JID = /^([^@:]+)(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/

function normalizeUserJid(jid) {
	if (typeof jid !== 'string') return null
	const match = USER_JID.exec(jid)
	if (!match) return null
	return `${match[1]}@${match[2] === 'c.us' ? 's.whatsapp.net' : match[2]}`
}

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Menunggu `promise` paling lama `ms`. Kalau lewat, antrean dilepas. Catatan: pengiriman yang
// sudah terlanjur berjalan tidak bisa dibatalkan, jadi pesannya masih bisa sampai belakangan.
function withTimeout(promise, ms, makeError) {
	let timer
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(makeError()), ms)
	})
	const original = Promise.resolve(promise)
	original.catch(() => {}) // kalau timeout menang lalu pengiriman asli gagal belakangan, jangan jadi unhandled rejection
	return Promise.race([original, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Lapisan anti-ban. SEMUA pesan keluar wajib lewat safeSend() (percakapan) atau
 * sendControl() (reaksi / hapus pesan) di sini, bukan sock.sendMessage() langsung.
 * Prinsip yang diterapkan (hasil riset, bukan tebakan) ada di README bagian
 * "Tentang Keamanan Akun":
 *
 *  1. Nomor baru lebih rawan diblokir -> mode warm-up memperlambat &
 *     membatasi pengiriman di hari-hari pertama.
 *  2. Bot ini didesain REAKTIF (membalas pesan yang masuk), bukan PROAKTIF
 *     (broadcast/blast ke banyak nomor asing). Tidak ada fungsi broadcast
 *     massal di proyek ini sama sekali -- ini keputusan desain yang
 *     disengaja, bukan keterbatasan teknis.
 *  3. Jeda pengiriman acak + indikator "mengetik" supaya pola pengiriman
 *     terlihat wajar. Seluruh pengiriman berjalan SATU PER SATU dalam satu
 *     antrean: pengiriman berikutnya baru mulai setelah sock.sendMessage()
 *     sebelumnya benar-benar selesai, dan jeda dihitung dari saat itu.
 *  4. Ada batas jumlah "kontak baru" per hari. "Kontak baru" = nomor yang
 *     bot hubungi DULUAN. Membalas orang yang chat lebih dulu bukan kontak
 *     baru dan tidak dihitung. Kalau batas tercapai, pengiriman ke kontak
 *     baru berikutnya DIBLOKIR (AntiBanError, code 'NEW_CONTACT_CAP').
 *
 * Tidak ada teknik di sini yang menjamin akun 100% aman -- tidak ada yang
 * bisa menjamin itu (lihat README). Ini hanya mengurangi pola perilaku
 * yang paling sering memicu deteksi otomatis WhatsApp.
 */
class AntiBanGuard {
	/**
	 * hooks.onSent(pesanTerkirim): dipanggil setelah sebuah pesan benar-benar terkirim
	 * (dipakai untuk mencatat pesan keluar ke message store). Error di hook diabaikan.
	 */
	constructor(config, store, hooks = {}) {
		this.config = config
		this.store = store
		this.onSent = typeof hooks.onSent === 'function' ? hooks.onSent : null

		// Ekor antrean. SELALU berstatus fulfilled (error dibuang di _enqueue) supaya satu
		// pengiriman yang gagal tidak membuat semua pengiriman sesudahnya ikut gagal.
		this._tail = Promise.resolve()
		this.lastSentAt = 0

		const storedJids = store.get('knownJids', [])
		this.knownJids = new Set(Array.isArray(storedJids) ? storedJids : [])
		const storedLog = store.get('newContactLog', {})
		this.newContactLog = isPlainObject(storedLog) ? { ...storedLog } : {} // { 'YYYY-MM-DD': jumlah }
	}

	isWarmup() {
		if (!this.config.antiban.warmupMode) return false
		const firstRun = new Date(this.store.firstRun).getTime()
		const elapsedDays = (Date.now() - firstRun) / 86_400_000
		return elapsedDays < this.config.antiban.warmupDays
	}

	_randomDelay() {
		const warmup = this.isWarmup()
		const [min, max] = warmup
			? [this.config.antiban.warmupMinDelayMs, this.config.antiban.warmupMaxDelayMs]
			: [this.config.antiban.minDelayMs, this.config.antiban.maxDelayMs]
		return Math.floor(min + Math.random() * Math.max(0, max - min))
	}

	_sendTimeoutMs() {
		const ms = Number(this.config.antiban.sendTimeoutMs)
		return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SEND_TIMEOUT_MS
	}

	_todayKey() {
		return new Date().toISOString().slice(0, 10)
	}

	_newContactCap(warmup) {
		const cfg = this.config.antiban
		const cap = Math.floor(Number(warmup ? cfg.warmupNewContactDailyCap : cfg.newContactDailyCap))
		if (Number.isFinite(cap) && cap >= 0) return cap
		return warmup ? DEFAULT_WARMUP_NEW_CONTACT_CAP : DEFAULT_NEW_CONTACT_CAP
	}

	/** Jumlah kontak baru yang sudah dihubungi bot hari ini. */
	newContactsToday() {
		return this.newContactLog[this._todayKey()] || 0
	}

	_addKnown(jid) {
		this.knownJids.add(jid)
		while (this.knownJids.size > MAX_KNOWN_JIDS) {
			this.knownJids.delete(this.knownJids.values().next().value) // buang yang paling lama
		}
	}

	_persistKnown() {
		this.store.set('knownJids', Array.from(this.knownJids))
	}

	_pruneNewContactLog(todayKey) {
		const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
		for (const day of Object.keys(this.newContactLog)) {
			if (day !== todayKey && day < cutoff) delete this.newContactLog[day]
		}
	}

	/**
	 * Catat bahwa seseorang menghubungi bot DULUAN (panggil untuk setiap pesan masuk).
	 * Membalas orang seperti ini bukan "kontak baru": bukan bot yang memulai percakapan,
	 * jadi tidak dihitung ke batas harian dan tidak pernah diblokir oleh batas itu.
	 */
	noteInbound(key) {
		if (!key) return
		let added = false
		for (const jid of [key.remoteJid, key.remoteJidAlt]) {
			const normalized = normalizeUserJid(jid)
			if (normalized && !this.knownJids.has(normalized)) {
				this._addKnown(normalized)
				added = true
			}
		}
		if (added) this._persistKnown()
	}

	/**
	 * Dipanggil sebelum mengirim ke `jid`. Kalau ini kontak baru yang dihubungi bot
	 * DULUAN (belum pernah chat ke bot dan belum pernah dikirimi pesan), hitung ke
	 * batas harian -- dan lempar error kalau batas sudah tercapai.
	 */
	_reserveContact(jid) {
		const normalized = normalizeUserJid(jid)
		if (!normalized || this.knownJids.has(normalized)) return

		const warmup = this.isWarmup()
		const cap = this._newContactCap(warmup)
		const today = this._todayKey()
		const used = this.newContactLog[today] || 0

		if (used >= cap) {
			ui.warn(
				`Pesan ke kontak baru DIBLOKIR: sudah ${used} kontak baru hari ini ` +
					`(batas: ${cap}${warmup ? ', mode warm-up aktif' : ''}). ` +
					'Batas direset otomatis pada pergantian hari (UTC).'
			)
			throw new AntiBanError(
				`Batas kontak baru harian tercapai (${used}/${cap}${warmup ? ', mode warm-up' : ''}); pesan tidak dikirim.`,
				'NEW_CONTACT_CAP'
			)
		}

		this.newContactLog[today] = used + 1
		this._pruneNewContactLog(today)
		// Simpan log hitungan dulu, baru daftar kontak: kalau proses mati di antara keduanya,
		// yang terjadi paling buruk hitungan terlalu besar (aman), bukan terlalu kecil.
		this.store.set('newContactLog', this.newContactLog)
		this._addKnown(normalized)
		this._persistKnown()

		if (used + 1 === cap) {
			ui.warn(
				`Batas kontak baru hari ini tercapai (${cap}${warmup ? ', mode warm-up aktif' : ''}). ` +
					'Pesan ke kontak baru berikutnya akan diblokir sampai pergantian hari (UTC).'
			)
		}
	}

	// Menjalankan `task` setelah SEMUA task sebelumnya selesai (berhasil atau gagal).
	// Hasil/error task diteruskan apa adanya ke pemanggil, tapi ekor antrean tidak pernah ikut gagal.
	_enqueue(task) {
		const run = this._tail.then(task)
		this._tail = run.then(
			() => {},
			() => {}
		)
		return run
	}

	async _humanPause() {
		const elapsed = Date.now() - this.lastSentAt
		const targetDelay = this._randomDelay()
		if (elapsed < targetDelay) await sleep(targetDelay - elapsed)
	}

	async _simulateTyping(sock, jid) {
		if (!this.config.antiban.simulateTyping) return
		if (typeof jid !== 'string' || jid.endsWith('@broadcast')) return
		try {
			await sock.presenceSubscribe(jid)
			await sock.sendPresenceUpdate('composing', jid)
			await sleep(350 + Math.random() * 650)
			await sock.sendPresenceUpdate('paused', jid)
		} catch (err) {
			// Kegagalan presence bukan hal fatal -- lanjut kirim pesan seperti biasa.
		}
	}

	async _deliver(sock, jid, content, options, kind) {
		try {
			if (kind === 'message') {
				await this._humanPause()
				await this._simulateTyping(sock, jid)
			} else {
				const elapsed = Date.now() - this.lastSentAt
				if (elapsed < CONTROL_MIN_GAP_MS) await sleep(CONTROL_MIN_GAP_MS - elapsed)
			}

			const timeoutMs = this._sendTimeoutMs()
			const sent = await withTimeout(
				sock.sendMessage(jid, content, options),
				timeoutMs,
				() =>
					new AntiBanError(
						`Pengiriman pesan ke ${jid} tidak selesai dalam ${Math.round(timeoutMs / 1000)} detik; antrean dilepas.`,
						'SEND_TIMEOUT'
					)
			)

			if (this.onSent) {
				try {
					this.onSent(sent)
				} catch (err) {
					// Hook yang gagal tidak boleh membuat pesan yang sudah terkirim dianggap gagal.
				}
			}
			return sent
		} finally {
			// Jeda berikutnya dihitung dari saat pengiriman SELESAI (juga kalau gagal).
			this.lastSentAt = Date.now()
		}
	}

	/**
	 * Kirim pesan percakapan dengan aman: antri satu per satu, beri jeda acak yang manusiawi,
	 * simulasikan "sedang mengetik", baru benar-benar kirim lewat sock.sendMessage -- dan
	 * antrean baru lanjut ke pesan berikutnya setelah pengiriman itu selesai.
	 *
	 * Melempar AntiBanError('NEW_CONTACT_CAP') kalau ini kontak baru yang bot hubungi duluan
	 * dan batas harian sudah tercapai, dan AntiBanError('SEND_TIMEOUT') kalau pengiriman macet.
	 */
	async safeSend(sock, jid, content, options = {}) {
		this._reserveContact(jid)
		return this._enqueue(() => this._deliver(sock, jid, content, options, 'message'))
	}

	/**
	 * Untuk pesan kontrol: reaksi dan hapus pesan. Ikut antrean yang sama (tidak pernah
	 * tumpang tindih dengan pengiriman lain) tapi tanpa jeda acak dan tanpa "mengetik",
	 * serta tidak dihitung sebagai kontak baru (selalu terjadi di chat yang sudah ada).
	 */
	async sendControl(sock, jid, content, options = {}) {
		return this._enqueue(() => this._deliver(sock, jid, content, options, 'control'))
	}
}

module.exports = { AntiBanGuard, AntiBanError }
