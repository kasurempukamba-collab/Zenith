'use strict'

module.exports = {
	command: 'owner',
	aliases: ['creator'],
	category: 'general',
	description: 'Kirim kontak owner bot.',
	async execute(ctx) {
		if (ctx.config.owners.length === 0) {
			return ctx.reply('Owner belum diatur (isi OWNER_NUMBERS di file .env).')
		}

		const ownerJid = ctx.config.owners[0]
		const number = ownerJid.split('@')[0]

		const vcard =
			'BEGIN:VCARD\n' +
			'VERSION:3.0\n' +
			`FN:${ctx.config.botName} Owner\n` +
			`TEL;type=CELL;type=VOICE;waid=${number}:+${number}\n` +
			'END:VCARD'

		await ctx.reply({
			contacts: {
				displayName: `${ctx.config.botName} Owner`,
				contacts: [{ vcard }],
			},
		})
	},
}
