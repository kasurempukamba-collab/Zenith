'use strict'

const { getTargetJids } = require('../../lib/target')

module.exports = {
	command: 'promote',
	category: 'group',
	description: 'Jadikan anggota admin grup. Reply/mention orangnya lalu ketik .promote',
	groupOnly: true,
	adminOnly: true,
	botAdminOnly: true,
	async execute(ctx) {
		const targets = getTargetJids(ctx.msg)
		if (targets.length === 0) {
			return ctx.reply('Reply pesan orangnya, atau mention dia, lalu ketik .promote')
		}

		try {
			await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, 'promote')
			await ctx.reply(`✅ ${targets.length} anggota sekarang jadi admin.`)
		} catch (err) {
			await ctx.reply(`⚠️ Gagal: ${err.message}`)
		}
	},
}
