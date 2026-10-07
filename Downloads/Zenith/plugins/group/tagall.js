'use strict'

// Nilai bawaan kalau config tidak memberi angka yang valid. Nilai ini pilihan konservatif
// proyek ini, BUKAN batas protokol WhatsApp -- bisa diubah lewat TAGALL_* di .env.
const DEFAULT_CHUNK_SIZE = 50
const DEFAULT_MAX_MEMBERS = 256

function positiveInt(value, fallback) {
	const n = Math.floor(Number(value))
	return Number.isFinite(n) && n > 0 ? n : fallback
}

function chunk(list, size) {
	const chunks = []
	for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size))
	return chunks
}

module.exports = {
	command: 'tagall',
	aliases: ['everyone'],
	category: 'group',
	description: 'Mention semua anggota grup (grup besar dikirim bertahap). Contoh: .tagall ada pengumuman!',
	groupOnly: true,
	adminOnly: true,
	async execute(ctx) {
		const participants = ctx.groupMetadata?.participants || []
		const ids = participants.map((p) => p.id).filter(Boolean)
		if (ids.length === 0) {
			return ctx.reply('Tidak bisa membaca daftar anggota grup ini.')
		}

		const chunkSize = positiveInt(ctx.config?.tagall?.chunkSize, DEFAULT_CHUNK_SIZE)
		const maxMembers = positiveInt(ctx.config?.tagall?.maxMembers, DEFAULT_MAX_MEMBERS)

		// Batas atas: satu perintah tidak boleh membanjiri grup raksasa dengan puluhan pesan mention.
		if (ids.length > maxMembers) {
			return ctx.reply(
				`⚠️ Grup ini punya ${ids.length} anggota, melebihi batas ${ctx.config?.prefix || '.'}tagall (${maxMembers} anggota) ` +
					'supaya grup tidak kebanjiran mention. Owner bot bisa menaikkan batasnya lewat TAGALL_MAX_MEMBERS di file .env.'
			)
		}

		// Dikirim bertahap: tiap pesan memuat paling banyak `chunkSize` mention, bukan satu pesan raksasa.
		// Pengumuman diulang di setiap bagian supaya orang yang ter-mention di bagian belakang tetap paham konteksnya.
		const announcement = ctx.body ? `📢 ${ctx.body}` : '📢 Tag semua anggota'
		const batches = chunk(ids, chunkSize)

		for (let i = 0; i < batches.length; i++) {
			const part = batches.length > 1 ? ` (${i + 1}/${batches.length})` : ''
			const mentionText = batches[i].map((id) => `@${id.split('@')[0]}`).join(' ')
			await ctx.reply({
				text: `${announcement}${part}\n\n${mentionText}`,
				mentions: batches[i],
			})
		}
	},
}
