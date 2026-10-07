'use strict'

const { BufferJSON, proto } = require('@whiskeysockets/baileys')
const { atomicWriteFileSync, readJsonWithFallback, quarantineFile } = require('./atomicFile')

/**
 * Penyimpanan pesan untuk callback getMessage() milik Baileys.
 *
 * Kenapa perlu: kalau perangkat penerima gagal mendekripsi pesan kita, WhatsApp
 * mengirim "retry receipt". Baileys lalu meminta pesan aslinya lewat getMessage()
 * supaya bisa dienkripsi ulang dan dikirim lagi. Tanpa pesan itu, penerima hanya
 * melihat "Menunggu pesan ini..." tanpa akhir.
 *
 * Dua "ember" terpisah:
 *  - sent     : pesan yang DIKIRIM bot sendiri. Inilah yang dibutuhkan retry. Disimpan
 *               ke disk (data/messages.json) supaya tetap ada setelah bot restart.
 *  - received : pesan masuk. Hanya di memori, tidak pernah ditulis ke disk
 *               (isi chat orang lain tidak perlu disimpan permanen).
 *
 * Keduanya dibatasi jumlah (LRU sederhana) dan umur (TTL), jadi memori tidak
 * membengkak tanpa batas.
 */

const FORMAT_VERSION = 1
const DEFAULT_MAX_ENTRIES = 1000
const RECEIVED_MAX_ENTRIES = 500
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000
const DEFAULT_FLUSH_DELAY_MS = 10_000

function makeKey(remoteJid, id) {
	return `${remoteJid}:${id}`
}

// Objek pesan Baileys adalah protobuf: toJSON() mengubah bytes/Long jadi string, jadi saat
// dimuat dari disk harus dikembalikan lewat fromObject() agar bisa di-encode ulang dengan benar.
function toMessage(plain) {
	try {
		return proto.Message.fromObject(plain)
	} catch (err) {
		return plain
	}
}

/** Map berurutan dengan batas jumlah (yang paling lama dibuang) dan batas umur. */
class BoundedMap {
	constructor(maxEntries, ttlMs) {
		this.maxEntries = Math.max(1, Math.floor(maxEntries))
		this.ttlMs = ttlMs
		this.map = new Map()
	}

	get size() {
		return this.map.size
	}

	_expired(entry, now = Date.now()) {
		return now - entry.at > this.ttlMs
	}

	set(key, value, at = Date.now()) {
		this.map.delete(key) // hapus dulu supaya urutannya pindah jadi yang paling baru
		this.map.set(key, { value, at })
		while (this.map.size > this.maxEntries) {
			this.map.delete(this.map.keys().next().value)
		}
	}

	get(key) {
		const entry = this.map.get(key)
		if (!entry) return undefined
		if (this._expired(entry)) {
			this.map.delete(key)
			return undefined
		}
		return entry.value
	}

	find(predicate) {
		const now = Date.now()
		for (const entry of this.map.values()) {
			if (!this._expired(entry, now) && predicate(entry.value)) return entry.value
		}
		return undefined
	}

	prune() {
		const now = Date.now()
		for (const [key, entry] of this.map) {
			if (this._expired(entry, now)) this.map.delete(key)
		}
	}
}

class MessageStore {
	/**
	 * filePath    : lokasi file persist. null = hanya memori (dipakai di test).
	 * maxEntries  : maksimal pesan terkirim yang disimpan.
	 * ttlMs       : umur maksimal sebuah entri.
	 * flushDelayMs: jeda penulisan ke disk setelah ada pesan baru (digabung, tidak per pesan).
	 */
	constructor({
		filePath = null,
		maxEntries = DEFAULT_MAX_ENTRIES,
		ttlMs = DEFAULT_TTL_MS,
		flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
	} = {}) {
		this.filePath = filePath
		this.flushDelayMs = flushDelayMs
		this.sent = new BoundedMap(maxEntries, ttlMs)
		this.received = new BoundedMap(Math.min(maxEntries, RECEIVED_MAX_ENTRIES), ttlMs)
		this.dirty = false
		this.timer = null

		if (this.filePath) this._load()
	}

	get size() {
		return this.sent.size + this.received.size
	}

	_load() {
		const result = readJsonWithFallback(this.filePath, {
			reviver: BufferJSON.reviver,
			validate: (value) => value !== null && typeof value === 'object' && Array.isArray(value.entries),
		})

		for (const badFile of result.corrupt) {
			const moved = quarantineFile(badFile)
			console.error(
				`File message store rusak: "${badFile}"` + (moved ? ` (disimpan sebagai "${moved}")` : '') + '. Dimulai dari kosong.'
			)
		}

		if (!result.data) return

		const now = Date.now()
		for (const item of result.data.entries) {
			try {
				if (!item || typeof item.id !== 'string' || typeof item.jid !== 'string' || !item.m) continue
				const at = Number(item.at)
				if (!Number.isFinite(at) || now - at > this.sent.ttlMs) continue
				this.sent.set(makeKey(item.jid, item.id), { id: item.id, jid: item.jid, message: toMessage(item.m) }, at)
			} catch (err) {
				// satu entri rusak tidak boleh menggagalkan seluruh pemuatan
			}
		}

		// Dipulihkan dari cadangan / file utama tidak ada -> tulis ulang file utama.
		if (result.source !== this.filePath) {
			this.dirty = true
			this.flush()
		}
	}

	_entryFrom(msg) {
		const jid = msg && msg.key && msg.key.remoteJid
		const id = msg && msg.key && msg.key.id
		if (!jid || !id || !msg.message) return null
		return { key: makeKey(jid, id), value: { id, jid, message: msg.message } }
	}

	/** Catat pesan yang baru DIKIRIM bot (hasil sock.sendMessage). Disimpan ke disk. */
	rememberSent(msg) {
		const entry = this._entryFrom(msg)
		if (!entry) return
		this.sent.set(entry.key, entry.value)
		this._markDirty()
	}

	/** Catat pesan yang DITERIMA. Hanya di memori. */
	rememberReceived(msg) {
		const entry = this._entryFrom(msg)
		if (!entry) return
		this.received.set(entry.key, entry.value)
	}

	/** Dipakai oleh getMessage() Baileys. Mengembalikan isi pesan (IMessage) atau undefined. */
	get(key) {
		if (!key || !key.id) return undefined

		const composite = makeKey(key.remoteJid, key.id)
		const exact = this.sent.get(composite) || this.received.get(composite)
		if (exact) return exact.message

		// Retry receipt bisa datang dengan bentuk JID chat yang berbeda dari yang kita pakai saat
		// mengirim (misalnya versi LID vs nomor telepon). ID pesan buatan kita sendiri unik, jadi
		// khusus untuk pesan KITA (fromMe) boleh dicari lewat ID saja.
		if (key.fromMe) {
			const byId = this.sent.find((value) => value.id === key.id)
			if (byId) return byId.message
		}

		return undefined
	}

	_markDirty() {
		this.dirty = true
		if (!this.filePath || this.timer) return
		this.timer = setTimeout(() => {
			this.timer = null
			this.flush()
		}, this.flushDelayMs)
		// Timer ini tidak boleh menahan proses agar tidak bisa berhenti.
		if (typeof this.timer.unref === 'function') this.timer.unref()
	}

	/** Tulis ke disk sekarang juga (kalau ada perubahan). Aman dipanggil berulang. */
	flush() {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
		if (!this.filePath || !this.dirty) return

		try {
			this.sent.prune()
			const entries = []
			for (const entry of this.sent.map.values()) {
				entries.push({ id: entry.value.id, jid: entry.value.jid, at: entry.at, m: entry.value.message })
			}
			const payload = JSON.stringify({ version: FORMAT_VERSION, entries }, BufferJSON.replacer)
			atomicWriteFileSync(this.filePath, payload, { backup: false })
			this.dirty = false
		} catch (err) {
			// dirty tetap true: akan dicoba lagi pada penulisan berikutnya
			console.error('Gagal menyimpan message store:', err.message)
		}
	}
}

module.exports = MessageStore
