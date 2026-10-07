'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Bentuk sebuah file plugin (contoh lengkap ada di plugins/general/ping.js):
 *
 *   module.exports = {
 *     command: 'ping',            // wajib untuk plugin aktif (dipanggil via prefix)
 *     aliases: ['p'],             // opsional
 *     category: 'general',        // dipakai untuk pengelompokan di .menu
 *     description: 'Cek kecepatan respons bot',
 *     ownerOnly: false,
 *     groupOnly: false,
 *     adminOnly: false,           // pengirim harus admin grup
 *     botAdminOnly: false,        // bot harus admin grup (untuk kick/promote/dst)
 *     async execute(ctx, args) {  // ctx lihat index.js
 *       await ctx.reply('pong!')
 *     },
 *
 *     // opsional, dipakai plugin pasif seperti antilink (tanpa "command"):
 *     passive: true,
 *     async onMessage(ctx) {},
 *
 *     // opsional, dipanggil saat ada peserta grup masuk/keluar/dipromote/dst:
 *     async onGroupParticipantsUpdate(ctx, event) {},
 *   }
 *
 * Selain plugin yang berhasil dimuat, hasilnya melaporkan apa yang TIDAK beres supaya tidak
 * hilang diam-diam (dipakai test):
 *   errors  : [{ file, message }] file yang gagal dimuat, atau command yang bentrok
 *   skipped : [{ file, message }] file .js yang tidak meng-export objek plugin
 */
function loadPlugins(pluginsDir) {
	const commands = new Map()
	const passiveHooks = []
	const groupHooks = []
	const allPlugins = []
	const errors = []
	const skipped = []

	const files = walk(pluginsDir).filter((f) => f.endsWith('.js'))

	for (const file of files) {
		let plugin
		try {
			delete require.cache[require.resolve(file)]
			plugin = require(file)
		} catch (err) {
			console.error(`Gagal memuat plugin "${file}":`, err.message)
			errors.push({ file: path.relative(pluginsDir, file), message: err.message })
			continue
		}

		if (!plugin || typeof plugin !== 'object') {
			skipped.push({ file: path.relative(pluginsDir, file), message: 'file ini tidak meng-export objek plugin' })
			continue
		}

		plugin._file = path.relative(pluginsDir, file)
		allPlugins.push(plugin)

		if (plugin.command) {
			const key = String(plugin.command).toLowerCase()
			if (commands.has(key)) {
				console.error(`Perintah ".${key}" bentrok antara plugin dan sudah terdaftar sebelumnya. Dilewati: ${plugin._file}`)
				errors.push({ file: plugin._file, message: `perintah ".${key}" bentrok dengan plugin lain` })
			} else {
				commands.set(key, plugin)
				for (const alias of plugin.aliases || []) {
					const aliasKey = String(alias).toLowerCase()
					if (!commands.has(aliasKey)) commands.set(aliasKey, plugin)
				}
			}
		}

		if (typeof plugin.onMessage === 'function') passiveHooks.push(plugin)
		if (typeof plugin.onGroupParticipantsUpdate === 'function') groupHooks.push(plugin)
	}

	return { commands, passiveHooks, groupHooks, allPlugins, errors, skipped }
}

function walk(dir) {
	let results = []
	if (!fs.existsSync(dir)) return results
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			results = results.concat(walk(full))
		} else {
			results.push(full)
		}
	}
	return results
}

module.exports = { loadPlugins }
