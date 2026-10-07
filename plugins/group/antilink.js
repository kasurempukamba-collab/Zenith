'use strict'

const LINK_REGEX = /(https?:\/\/|www\.)\S+/i

module.exports = {
	command: 'antilink',
	category: 'group',
	description: 'Nyala/matikan penghapusan otomatis pesan berisi link. Contoh: .antilink on',
	groupOnly: true,
	adminOnly: true,
	async execute(ctx) {
		const choice = (ctx.args[0] || '').toLowerCase()
		if (choice !== 'on' && choice !== 'off') {
			const current = ctx.store.getGroup(ctx.jid).antilink
			return ctx.reply(
				`Antilink di grup ini: *${current ? 'ON' : 'OFF'}*.\n` +
					`Ganti dengan: ${ctx.config.prefix}antilink on  atau  ${ctx.config.prefix}antilink off`
			)
		}
		ctx.store.setGroup(ctx.jid, { antilink: choice === 'on' })
		await ctx.reply(`✅ Antilink sekarang *${choice.toUpperCase()}* di grup ini.`)
	},

	// Hook pasif: dicek di SETIAP pesan grup, bukan cuma saat command dipanggil.
	async onMessage(ctx) {
		if (!ctx.isGroup) return
		if (ctx.isOwner || ctx.isSenderAdmin) return // admin & owner boleh kirim link

		const settings = ctx.store.getGroup(ctx.jid)
		if (!settings.antilink) return
		if (!ctx.text || !LINK_REGEX.test(ctx.text)) return

		try {
			// Lewat antrean anti-ban yang sama dengan semua pengiriman lain (bukan sock.sendMessage langsung).
			await ctx.sendControl({ delete: ctx.msg.key })
			// quoted: undefined -> jangan quote pesan yang baru saja dihapus
			await ctx.reply('🔗 Pesan berisi link dihapus otomatis (antilink aktif di grup ini).', {
				quoted: undefined,
			})
		} catch (err) {
			// Kemungkinan bot bukan admin di grup ini -> tidak bisa hapus pesan orang lain.
		}
	},
}
