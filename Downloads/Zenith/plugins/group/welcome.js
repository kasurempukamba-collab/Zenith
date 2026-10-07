'use strict'

module.exports = {
	command: 'welcome',
	category: 'group',
	description: 'Nyala/matikan pesan selamat datang & perpisahan otomatis. Contoh: .welcome on',
	groupOnly: true,
	adminOnly: true,
	async execute(ctx) {
		const choice = (ctx.args[0] || '').toLowerCase()
		if (choice !== 'on' && choice !== 'off') {
			const current = ctx.store.getGroup(ctx.jid).welcome
			return ctx.reply(
				`Welcome message di grup ini: *${current ? 'ON' : 'OFF'}*.\n` +
					`Ganti dengan: ${ctx.config.prefix}welcome on  atau  ${ctx.config.prefix}welcome off`
			)
		}
		ctx.store.setGroup(ctx.jid, { welcome: choice === 'on' })
		await ctx.reply(`✅ Welcome message sekarang *${choice.toUpperCase()}* di grup ini.`)
	},

	// event.action: 'add' | 'remove' | 'promote' | 'demote'
	async onGroupParticipantsUpdate(ctx, event) {
		const settings = ctx.store.getGroup(ctx.jid)
		if (!settings.welcome) return
		if (event.action !== 'add' && event.action !== 'remove') return

		const groupName = ctx.groupMetadata?.subject || 'grup ini'
		// PENTING: event.participants berisi objek GroupParticipant (punya .id),
		// BUKAN array string JID mentah -- ini beda dari asumsi awal & sempat bikin
		// bot crash ("jid.split is not a function") saat dites langsung.
		const mentions = event.participants.map((p) => p.id).filter(Boolean)
		const names = mentions.map((id) => `@${id.split('@')[0]}`).join(', ')

		const text =
			event.action === 'add'
				? `👋 Selamat datang ${names} di *${groupName}*! Semoga betah ya.`
				: `👋 ${names} telah meninggalkan *${groupName}*. Sampai jumpa!`

		await ctx.reply({ text, mentions })
	},
}
