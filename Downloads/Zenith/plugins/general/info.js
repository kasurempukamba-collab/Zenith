'use strict'

function formatUptime(seconds) {
	const d = Math.floor(seconds / 86400)
	const h = Math.floor((seconds % 86400) / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	const s = Math.floor(seconds % 60)
	return `${d}h ${h}j ${m}m ${s}d`.replace('0h ', '')
}

module.exports = {
	command: 'info',
	aliases: ['status', 'runtime'],
	category: 'general',
	description: 'Info teknis bot: uptime, memori, mode, status anti-ban.',
	async execute(ctx) {
		const mem = process.memoryUsage()
		const usedMb = (mem.rss / 1024 / 1024).toFixed(1)
		const selfMode = ctx.store.get('selfMode', ctx.config.selfModeDefault)

		const text = [
			`*${ctx.config.botName} — Info*`,
			``,
			`Uptime: ${formatUptime(process.uptime())}`,
			`Memori terpakai: ${usedMb} MB`,
			`Node.js: ${process.version}`,
			`Plugin dimuat: ${ctx.allPlugins.length} (${ctx.commands.size} alias perintah)`,
			`Mode: ${selfMode ? 'privat (hanya owner)' : 'publik'}`,
			``,
			`*Anti-ban*`,
			`Warm-up: ${ctx.config.antiban.warmupMode ? `aktif (${ctx.config.antiban.warmupDays} hari)` : 'nonaktif'}`,
			`Jeda kirim normal: ${ctx.config.antiban.minDelayMs}–${ctx.config.antiban.maxDelayMs}ms`,
		].join('\n')

		await ctx.reply(text)
	},
}
