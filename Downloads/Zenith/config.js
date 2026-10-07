'use strict'

require('dotenv').config()

function parseOwners(raw) {
	if (!raw) return []
	return raw
		.split(',')
		.map((n) => n.trim().replace(/[^0-9]/g, ''))
		.filter(Boolean)
		.map((n) => `${n}@s.whatsapp.net`)
}

function toBool(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback
	return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

// Nilai kosong (mis. "MIN_DELAY_MS=" di .env) = pakai default. Tanpa ini Number('') === 0 akan
// diam-diam mematikan jeda anti-ban atau, untuk batas harian, memblokir semua kontak baru.
function toNumber(value, fallback) {
	if (value === undefined || value === null || String(value).trim() === '') return fallback
	const n = Number(value)
	return Number.isFinite(n) ? n : fallback
}

// Angka > 0 (timeout, ukuran batch, dst). Nilai 0 / negatif / bukan angka -> pakai default.
function toPositiveNumber(value, fallback) {
	const n = toNumber(value, fallback)
	return n > 0 ? n : fallback
}

function toPositiveInt(value, fallback) {
	const n = Math.floor(toNumber(value, fallback))
	return n > 0 ? n : fallback
}

// Bilangan bulat >= 0. Cocok untuk batas harian: 0 itu sah dan berarti "tidak boleh sama sekali".
function toNonNegativeInt(value, fallback) {
	const n = Math.floor(toNumber(value, fallback))
	return n >= 0 ? n : fallback
}

const config = {
	// --- Identitas bot ---
	botName: process.env.BOT_NAME || 'Zenith',
	prefix: process.env.PREFIX || '.',
	owners: parseOwners(process.env.OWNER_NUMBERS),

	// --- Sesi & login ---
	sessionDir: process.env.SESSION_DIR || 'session',
	usePairingCode: toBool(process.env.USE_PAIRING_CODE, true),
	pairingNumber: (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, ''),

	// --- Mode privasi ---
	// selfMode = true -> bot HANYA merespons pesan dari owner sendiri (paling aman/privat).
	selfModeDefault: toBool(process.env.SELF_MODE, false),

	// --- Anti-ban ---
	antiban: {
		// Mode warm-up: perlambat & batasi pengiriman di hari-hari pertama bot dijalankan.
		// Nyalakan (true) kalau nomor yang dipakai masih baru / baru pertama kali dipakai bot.
		// Boleh dimatikan (false) kalau nomor sudah lama & biasa dipakai normal.
		warmupMode: toBool(process.env.WARMUP_MODE, true),
		warmupDays: toNumber(process.env.WARMUP_DAYS, 3),

		// Jeda acak (ms) antar pengiriman pesan pada kondisi normal.
		minDelayMs: toNumber(process.env.MIN_DELAY_MS, 1200),
		maxDelayMs: toNumber(process.env.MAX_DELAY_MS, 3500),

		// Jeda acak (ms) antar pengiriman pesan selama masa warm-up (lebih lambat).
		warmupMinDelayMs: toNumber(process.env.WARMUP_MIN_DELAY_MS, 4000),
		warmupMaxDelayMs: toNumber(process.env.WARMUP_MAX_DELAY_MS, 9000),

		// Batas jumlah "kontak baru" per hari = nomor yang bot hubungi DULUAN (bot yang memulai chat).
		// Membalas orang yang chat lebih dulu TIDAK dihitung. Kalau batas tercapai, pesan ke kontak
		// baru berikutnya DIBLOKIR sampai pergantian hari (UTC). 0 = bot tidak boleh memulai chat sama sekali.
		newContactDailyCap: toNonNegativeInt(process.env.NEW_CONTACT_DAILY_CAP, 20),
		warmupNewContactDailyCap: toNonNegativeInt(process.env.WARMUP_NEW_CONTACT_DAILY_CAP, 5),

		// Batas waktu (ms) menunggu SATU pengiriman pesan selesai. Lewat dari ini antrean dilepas,
		// supaya satu pengiriman yang macet tidak menahan semua pesan sesudahnya.
		sendTimeoutMs: toPositiveNumber(process.env.SEND_TIMEOUT_MS, 120000),

		// Simulasikan indikator "mengetik…" sebelum mengirim balasan.
		simulateTyping: toBool(process.env.SIMULATE_TYPING, true),
	},

	// --- Fitur AI chat (opsional) ---
	ai: {
		enabled: Boolean(process.env.ANTHROPIC_API_KEY),
		apiKey: process.env.ANTHROPIC_API_KEY || '',
		model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
		systemPrompt:
			process.env.AI_SYSTEM_PROMPT ||
			'Kamu adalah asisten yang ramah dan singkat di dalam chat WhatsApp. Jawab dalam Bahasa Indonesia kecuali diminta lain.',
		// Batas waktu (ms) menunggu jawaban API. Tanpa batas eksplisit, request yang macet baru
		// berhenti oleh default bawaan Node yang panjang (sekitar 5 menit) dan perintah .ai menggantung.
		timeoutMs: toPositiveNumber(process.env.AI_TIMEOUT_MS, 45000),
	},

	// --- Perintah .tagall ---
	tagall: {
		// Jumlah mention per pesan. Grup besar dikirim bertahap (beberapa pesan), bukan satu pesan raksasa.
		chunkSize: toPositiveInt(process.env.TAGALL_CHUNK_SIZE, 50),
		// Grup dengan anggota lebih banyak dari ini ditolak oleh .tagall.
		maxMembers: toPositiveInt(process.env.TAGALL_MAX_MEMBERS, 256),
	},

	// --- Penyimpanan pesan terkirim (untuk retry pesan yang gagal didekripsi penerima) ---
	messageStore: {
		maxEntries: toPositiveInt(process.env.MESSAGE_STORE_MAX_ENTRIES, 1000),
		ttlMs: toPositiveNumber(process.env.MESSAGE_STORE_TTL_HOURS, 48) * 3_600_000,
	},

	// --- Log ---
	logLevel: process.env.LOG_LEVEL || 'silent',
}

module.exports = config
