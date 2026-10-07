'use strict'

module.exports = {
	command: 'ping',
	aliases: ['p'],
	category: 'general',
	description: 'Cek kecepatan respons bot.',
	async execute(ctx) {
		// Dihitung dari timestamp pesan masuk, BUKAN dari saat balasan terkirim --
		// supaya angkanya mencerminkan kecepatan proses bot, bukan jeda anti-ban
		// yang memang sengaja ditambahkan sebelum mengirim (lihat lib/antiban.js).
		const messageTimeMs = ctx.msg.messageTimestamp ? Number(ctx.msg.messageTimestamp) * 1000 : Date.now()
		const latency = Math.max(0, Date.now() - messageTimeMs)
		await ctx.reply(
			`🏓 Pong! Diproses dalam ${latency}ms.\n` +
				'(Balasan tetap dikirim dengan jeda anti-ban seperti biasa.)'
		)
	},
}
