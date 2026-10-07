'use strict'

// Dipakai kalau config.ai.timeoutMs tidak valid.
const DEFAULT_TIMEOUT_MS = 45000

module.exports = {
	command: 'ai',
	aliases: ['ask', 'tanya'],
	category: 'ai',
	description: 'Tanya sesuatu ke AI (opsional, butuh ANTHROPIC_API_KEY di .env).',
	async execute(ctx) {
		if (!ctx.config.ai.enabled) {
			return ctx.reply(
				'Fitur AI belum aktif. Isi ANTHROPIC_API_KEY di file .env untuk mengaktifkannya (dapatkan di console.anthropic.com).'
			)
		}
		if (!ctx.body) {
			return ctx.reply(`Contoh pakai: ${ctx.config.prefix}ai apa itu Baileys?`)
		}

		const timeoutMs = Number(ctx.config.ai.timeoutMs) > 0 ? Number(ctx.config.ai.timeoutMs) : DEFAULT_TIMEOUT_MS

		await ctx.react('🤔')
		try {
			const res = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				// Batas waktu untuk SELURUH request (koneksi, menunggu header, sampai body selesai dibaca).
				// Tanpa ini request yang macet baru berhenti oleh default bawaan Node yang sangat panjang.
				signal: AbortSignal.timeout(timeoutMs),
				headers: {
					'content-type': 'application/json',
					'x-api-key': ctx.config.ai.apiKey,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({
					model: ctx.config.ai.model,
					max_tokens: 1024,
					system: ctx.config.ai.systemPrompt,
					messages: [{ role: 'user', content: ctx.body }],
				}),
			})

			if (!res.ok) {
				const errBody = await res.text()
				throw new Error(`HTTP ${res.status} — ${errBody.slice(0, 200)}`)
			}

			const data = await res.json()
			const textBlock = (data.content || []).find((c) => c.type === 'text')
			const answer = textBlock?.text?.trim() || '(AI tidak memberi jawaban teks)'

			await ctx.reply(answer)
			await ctx.react('✅')
		} catch (err) {
			await ctx.react('❌')
			if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
				await ctx.reply(`⚠️ AI tidak merespons dalam ${Math.max(1, Math.round(timeoutMs / 1000))} detik. Coba lagi sebentar lagi.`)
			} else {
				await ctx.reply(`⚠️ Gagal menghubungi AI: ${err.message}`)
			}
		}
	},
}
