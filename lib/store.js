'use strict'

const { atomicWriteFileSync, readJsonWithFallback, quarantineFile } = require('./atomicFile')

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidDate(value) {
	return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

/**
 * Database lokal super sederhana berbasis file JSON.
 * Dipakai untuk hal-hal kecil: pengaturan per-grup (antilink/welcome),
 * tanggal pertama kali bot dijalankan (dipakai fitur warm-up), dan
 * daftar kontak yang sudah pernah diajak bicara.
 *
 * Sengaja tidak pakai database eksternal (lowdb/sqlite/dst) supaya
 * instalasi tetap ringan dan tidak ada dependency tambahan yang bisa gagal.
 *
 * Keamanan data:
 *  - Penyimpanan atomik (tulis ke file sementara lalu rename), jadi crash/kill/mati
 *    listrik di tengah penyimpanan tidak bisa meninggalkan file separuh jadi.
 *  - Versi sebelumnya disimpan sebagai "<file>.bak".
 *  - File yang rusak TIDAK ditimpa: dipindah ke "<file>.corrupt-<waktu>", lalu bot
 *    memulihkan data dari ".bak" kalau ada. Data lama tidak dikorbankan.
 */
class Store {
	constructor(filePath) {
		this.filePath = filePath
		this.data = { meta: {}, groups: {}, settings: {} }
		this._load()
	}

	_load() {
		const result = readJsonWithFallback(this.filePath, { validate: isPlainObject })

		// Jangan timpa file rusak: amankan dulu supaya masih bisa diperiksa/diselamatkan manual.
		for (const badFile of result.corrupt) {
			const moved = quarantineFile(badFile)
			console.error(
				`Database lokal rusak atau tidak terbaca: "${badFile}"` +
					(moved ? ` (disimpan sebagai "${moved}")` : '') +
					'.'
			)
		}

		if (!result.data) {
			// Pertama kali jalan (atau semua salinan rusak) -> mulai dari data kosong.
			this.data = { meta: { firstRun: new Date().toISOString() }, groups: {}, settings: {} }
			this._save()
			return
		}

		const parsed = result.data
		this.data = {
			meta: isPlainObject(parsed.meta) ? parsed.meta : {},
			groups: isPlainObject(parsed.groups) ? parsed.groups : {},
			settings: isPlainObject(parsed.settings) ? parsed.settings : {},
		}

		let needsSave = false

		if (result.source !== this.filePath) {
			console.warn(`Database utama tidak bisa dipakai, data dipulihkan dari cadangan "${result.source}".`)
			needsSave = true
		}

		// Tanpa firstRun yang valid, warm-up tidak akan pernah selesai (firstRun = "sekarang" terus).
		if (!isValidDate(this.data.meta.firstRun)) {
			this.data.meta.firstRun = new Date().toISOString()
			needsSave = true
		}

		if (needsSave) this._save()
	}

	_save() {
		try {
			atomicWriteFileSync(this.filePath, JSON.stringify(this.data, null, 2))
		} catch (err) {
			console.error('Gagal menyimpan database lokal:', err.message)
		}
	}

	get firstRun() {
		return this.data.meta.firstRun || new Date().toISOString()
	}

	getGroup(jid) {
		if (!this.data.groups[jid]) {
			this.data.groups[jid] = { antilink: false, welcome: true }
			this._save()
		}
		return this.data.groups[jid]
	}

	setGroup(jid, patch) {
		const current = this.getGroup(jid)
		this.data.groups[jid] = { ...current, ...patch }
		this._save()
		return this.data.groups[jid]
	}

	get(key, fallback) {
		return key in this.data.settings ? this.data.settings[key] : fallback
	}

	set(key, value) {
		this.data.settings[key] = value
		this._save()
	}
}

module.exports = Store
