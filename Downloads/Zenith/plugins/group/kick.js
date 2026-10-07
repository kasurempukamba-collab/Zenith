'use strict'

const { getTargetJids } = require('../../lib/target')

module.exports = {
	command: 'kick',
	aliases: ['remove'],
	category: 'group',
	description: 'Keluarkan anggota grup. Reply/mention orangnya lalu ketik .kick',
	groupOnly: true,
	adminOnly: true,
	botAdminOnly: true,
	async execute(ctx) {
		const targets = getTargetJids(ctx.msg)
		if (targets.length === 0) {
			return ctx.reply('Reply pesan orangnya, atau mention dia, lalu ketik .kick')
		}

		try {
			await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, 'remove')
			await ctx.reply(`✅ Berhasil mengeluarkan ${targets.length} anggota.`)
		} catch (err) {
			await ctx.reply(`⚠️ Gagal: ${err.message}`)
		}
	},
}
