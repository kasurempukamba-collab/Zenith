'use strict'

const { getTargetJids } = require('../../lib/target')

module.exports = {
	command: 'demote',
	category: 'group',
	description: 'Turunkan admin jadi anggota biasa. Reply/mention orangnya lalu ketik .demote',
	groupOnly: true,
	adminOnly: true,
	botAdminOnly: true,
	async execute(ctx) {
		const targets = getTargetJids(ctx.msg)
		if (targets.length === 0) {
			return ctx.reply('Reply pesan orangnya, atau mention dia, lalu ketik .demote')
		}

		try {
			await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, 'demote')
			await ctx.reply(`✅ ${targets.length} admin diturunkan jadi anggota biasa.`)
		} catch (err) {
			await ctx.reply(`⚠️ Gagal: ${err.message}`)
		}
	},
}
