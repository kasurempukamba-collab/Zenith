'use strict'

module.exports = {
	command: 'menu',
	aliases: ['help', 'bantuan'],
	category: 'general',
	description: 'Tampilkan daftar semua perintah.',
	async execute(ctx) {
		const byCategory = new Map()
		for (const plugin of ctx.allPlugins) {
			if (!plugin.command) continue // lewati plugin pasif (mis. antilink listener)
			const cat = plugin.category || 'lainnya'
			if (!byCategory.has(cat)) byCategory.set(cat, [])
			byCategory.get(cat).push(plugin)
		}

		const p = ctx.config.prefix
		let text = `*${ctx.config.botName}* — WhatsApp Bot Mandiri\n`
		text += `Prefix: "${p}"\n`

		const order = ['general', 'owner', 'group', 'tools', 'ai', 'lainnya']
		const categories = [...byCategory.keys()].sort((a, b) => {
			const ia = order.indexOf(a)
			const ib = order.indexOf(b)
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
		})

		for (const cat of categories) {
			text += `\n*${cat.toUpperCase()}*\n`
			for (const plugin of byCategory.get(cat)) {
				const flags = []
				if (plugin.ownerOnly) flags.push('owner')
				if (plugin.adminOnly) flags.push('admin')
				if (plugin.groupOnly) flags.push('grup')
				const suffix = flags.length ? ` _(${flags.join(', ')})_` : ''
				text += `${p}${plugin.command} — ${plugin.description || ''}${suffix}\n`
			}
		}

		text += `\nTotal: ${ctx.commands.size} alias perintah dari ${ctx.allPlugins.length} plugin.`

		await ctx.reply(text)
	},
}
