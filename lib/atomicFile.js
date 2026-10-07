'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Helper baca/tulis file JSON yang tahan crash, mati listrik, atau proses di-kill.
 *
 * Masalah yang diselesaikan: fs.writeFileSync(file, data) langsung menimpa file
 * tujuan. Kalau proses mati di tengah penulisan, file tujuan tinggal separuh,
 * JSON-nya rusak, dan data lama ikut hilang.
 *
 * atomicWriteFileSync():
 *   1. Tulis isi baru ke "<file>.tmp", lalu fsync (dipastikan benar-benar ada di disk).
 *   2. Salin versi lama "<file>" menjadi "<file>.bak" (cadangan, best-effort).
 *   3. rename("<file>.tmp" -> "<file>"). Rename di satu folder bersifat atomik:
 *      file tujuan selalu berisi versi lama yang utuh ATAU versi baru yang utuh,
 *      tidak pernah separuh-separuh.
 *
 * readJsonWithFallback() membaca "<file>"; kalau file itu ADA tapi rusak, dicoba
 * "<file>.bak". Kalau file utama tidak ada sama sekali (belum pernah dibuat atau
 * sengaja dihapus untuk reset), hasilnya "tidak ada data" -- cadangan lama tidak
 * dihidupkan kembali. File yang rusak JANGAN ditimpa begitu saja -- pakai
 * quarantineFile() supaya masih bisa diperiksa atau diselamatkan manual.
 */

const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])

// Tidur sinkron (tanpa busy-loop). Dipakai hanya untuk jeda singkat saat retry rename.
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Di Windows, rename kadang gagal sesaat karena file sedang dipegang antivirus/indexer.
function renameWithRetry(from, to, attempts = 5) {
	for (let attempt = 1; ; attempt++) {
		try {
			fs.renameSync(from, to)
			return
		} catch (err) {
			if (attempt >= attempts || !RETRYABLE_RENAME_ERRORS.has(err.code)) throw err
			sleepSync(20 * attempt)
		}
	}
}

/**
 * options.backup (default true): salin versi lama ke "<file>.bak" sebelum diganti.
 * Matikan untuk data yang cuma cache dan tidak perlu cadangan.
 */
function atomicWriteFileSync(filePath, content, { backup = true } = {}) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	const tmpPath = `${filePath}.tmp`
	const bakPath = `${filePath}.bak`

	// 1. Tulis ke file sementara dan paksa sampai ke disk. Mode 0o600: data bot
	// (termasuk isi pesan terkirim) tidak perlu terbaca user lain di mesin yang sama.
	const fd = fs.openSync(tmpPath, 'w', 0o600)
	try {
		fs.writeFileSync(fd, content)
		fs.fsyncSync(fd)
	} finally {
		fs.closeSync(fd)
	}

	// 2. Cadangkan versi lama. Gagal bikin cadangan tidak boleh menggagalkan penyimpanan.
	if (backup) {
		try {
			if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bakPath)
		} catch (err) {
			// diabaikan: cadangan hanya pelengkap
		}
	}

	// 3. Ganti file tujuan secara atomik.
	try {
		renameWithRetry(tmpPath, filePath)
	} catch (err) {
		// Pilihan terakhir: tulis langsung (tidak atomik, tapi lebih baik daripada
		// kehilangan perubahan). Kalau ini juga gagal, error-nya diteruskan ke pemanggil.
		fs.writeFileSync(filePath, content)
		try {
			fs.unlinkSync(tmpPath)
		} catch (_) {
			// abaikan
		}
	}
}

/**
 * Baca file JSON; kalau file utama ada tapi rusak, coba cadangannya (".bak").
 *
 * Mengembalikan:
 *   data    : hasil parse, atau null kalau tidak ada yang bisa dipakai
 *   source  : path file yang berhasil dibaca (null kalau tidak ada)
 *   corrupt : daftar file yang ADA tetapi tidak bisa dipakai (rusak / bentuknya salah)
 *
 * File utama yang tidak ada = mulai bersih (data null, corrupt kosong). Cadangan hanya
 * dipakai untuk memulihkan file utama yang RUSAK, bukan untuk "menghapus penghapusan".
 *
 * validate(parsed) -> boolean : opsional, tolak struktur yang bentuknya salah.
 * reviver             : opsional, diteruskan ke JSON.parse.
 */
function readJsonWithFallback(filePath, { validate, reviver } = {}) {
	const result = { data: null, source: null, corrupt: [] }

	// Mengembalikan 'ok' | 'missing' | 'bad'
	function attempt(candidate) {
		let raw
		try {
			raw = fs.readFileSync(candidate, 'utf8')
		} catch (err) {
			return err.code === 'ENOENT' ? 'missing' : 'bad'
		}

		try {
			const parsed = JSON.parse(raw, reviver)
			if (validate && !validate(parsed)) return 'bad'
			result.data = parsed
			result.source = candidate
			return 'ok'
		} catch (err) {
			return 'bad'
		}
	}

	const main = attempt(filePath)
	if (main !== 'bad') return result // 'ok' (data terisi) atau 'missing' (mulai bersih)

	result.corrupt.push(filePath)
	const backupPath = `${filePath}.bak`
	if (attempt(backupPath) === 'bad') result.corrupt.push(backupPath)
	return result
}

/**
 * Pindahkan file rusak ke "<file>.corrupt-<waktu>" alih-alih menimpa/menghapusnya.
 * Mengembalikan path baru, atau null kalau gagal dipindahkan.
 */
function quarantineFile(filePath) {
	const target = `${filePath}.corrupt-${Date.now()}`
	try {
		fs.renameSync(filePath, target)
		return target
	} catch (err) {
		return null
	}
}

module.exports = { atomicWriteFileSync, readJsonWithFallback, quarantineFile }
