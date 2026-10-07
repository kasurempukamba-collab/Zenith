'use strict'

module.exports = {
	command: 'mode',
	category: 'owner',
	description: 'Ganti mode bot: "self" (hanya balas owner) atau "public".',
	ownerOnly: true,
	async execute(ctx) {
		const choice = (ctx.args[0] || '').toLowerCase()

		if (choice !== 'self' && choice !== 'public') {
			const current = ctx.store.get('selfMode', ctx.config.selfModeDefault)
			return ctx.reply(
				`Mode saat ini: *${current ? 'self (privat)' : 'public'}*.\n` +
					`Ganti dengan: ${ctx.config.prefix}mode self  atau  ${ctx.config.prefix}mode public`
			)
		}

		ctx.store.set('selfMode', choice === 'self')
		await ctx.reply(
			choice === 'self'
				? '🔒 Mode privat aktif — bot hanya akan membalas pesan dari owner.'
				: '🌐 Mode publik aktif — bot akan membalas semua orang (sesuai aturan tiap perintah).'
		)
	},
}
