'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadPlugins } = require('../lib/pluginLoader')

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins')

const tempDirs = []

test.after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function listJsFiles(dir) {
	const result = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) result.push(...listJsFiles(full))
		else if (entry.name.endsWith('.js')) result.push(full)
	}
	return result
}

// Membuat folder plugin sementara dari { 'nama/file.js': 'isi file' }.
function makePluginsDir(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-plugins-'))
	tempDirs.push(dir)
	for (const [name, content] of Object.entries(files)) {
		const full = path.join(dir, name)
		fs.mkdirSync(path.dirname(full), { recursive: true })
		fs.writeFileSync(full, content)
	}
	return dir
}

function quietLoad(dir) {
	const original = console.error
	console.error = () => {}
	try {
		return loadPlugins(dir)
	} finally {
		console.error = original
	}
}

test('semua file plugin berhasil dimuat: tidak ada error, tidak ada yang diam-diam terlewat', () => {
	const { allPlugins, errors, skipped } = loadPlugins(PLUGINS_DIR)

	assert.deepEqual(errors, [], `ada plugin yang gagal dimuat / bentrok: ${JSON.stringify(errors)}`)
	assert.deepEqual(skipped, [], `ada file di plugins/ yang bukan plugin (pindahkan helper ke lib/): ${JSON.stringify(skipped)}`)

	// Setiap file .js di plugins/ harus menghasilkan tepat satu plugin. Kalau ada yang hilang diam-diam,
	// test ini gagal -- tanpa angka tetap yang harus diubah setiap kali plugin ditambah atau dihapus.
	const files = listJsFiles(PLUGINS_DIR).map((f) => path.relative(PLUGINS_DIR, f))
	assert.ok(files.length > 0, 'folder plugins/ kosong')
	assert.deepEqual(allPlugins.map((p) => p._file).sort(), files.sort())
})

test('setiap plugin punya minimal satu fungsi: command, onMessage, atau onGroupParticipantsUpdate', () => {
	const { allPlugins } = loadPlugins(PLUGINS_DIR)
	for (const plugin of allPlugins) {
		const hasPurpose =
			Boolean(plugin.command) ||
			typeof plugin.onMessage === 'function' ||
			typeof plugin.onGroupParticipantsUpdate === 'function'
		assert.ok(hasPurpose, `${plugin._file} tidak punya command maupun hook apa pun (lupa module.exports?)`)
	}
})

test('setiap plugin dengan "command" wajib punya execute() berupa fungsi', () => {
	const { allPlugins } = loadPlugins(PLUGINS_DIR)
	for (const plugin of allPlugins) {
		if (plugin.command) {
			assert.equal(typeof plugin.execute, 'function', `${plugin._file} punya "command" tapi tidak punya execute()`)
		}
	}
})

test('tidak ada nama command atau alias yang bentrok/duplikat', () => {
	const { allPlugins } = loadPlugins(PLUGINS_DIR)
	const seen = new Map()
	for (const plugin of allPlugins) {
		if (!plugin.command) continue
		const names = [plugin.command, ...(plugin.aliases || [])]
		for (const name of names) {
			const key = name.toLowerCase()
			assert.ok(!seen.has(key) || seen.get(key) === plugin._file, `nama "${key}" dipakai lebih dari satu plugin: ${seen.get(key)} vs ${plugin._file}`)
			seen.set(key, plugin._file)
		}
	}
})

test('commands map berisi semua command utama + alias-nya', () => {
	const { commands } = loadPlugins(PLUGINS_DIR)
	for (const must of ['menu', 'ping', 'info', 'owner', 'mode', 'tagall', 'kick', 'promote', 'demote', 'antilink', 'welcome', 'sticker', 'toimg', 'ai']) {
		assert.ok(commands.has(must), `command ".${must}" tidak ditemukan di plugin loader`)
	}
})

test('plugin dengan onGroupParticipantsUpdate juga punya command (welcome.js)', () => {
	const { groupHooks } = loadPlugins(PLUGINS_DIR)
	// Memakai pencarian, bukan jumlah: menambah plugin group-hook lain tidak boleh mematahkan test ini.
	const welcome = groupHooks.find((p) => p.command === 'welcome')
	assert.ok(welcome, 'plugin "welcome" harus terdaftar sebagai group hook')
})

test('plugin pasif (antilink) terdaftar sebagai passive hook', () => {
	const { passiveHooks } = loadPlugins(PLUGINS_DIR)
	const names = passiveHooks.map((p) => p.command)
	assert.ok(names.includes('antilink'))
})

// --- perilaku loader itu sendiri (memakai folder plugin sementara) ---

test('loader melaporkan file yang gagal dimuat di errors, plugin lain tetap termuat', () => {
	const dir = makePluginsDir({
		'baik.js': "module.exports = { command: 'halo', execute() {} }",
		'rusak.js': "throw new Error('sengaja rusak')",
	})
	const { allPlugins, errors, commands } = quietLoad(dir)

	assert.equal(allPlugins.length, 1)
	assert.ok(commands.has('halo'))
	assert.equal(errors.length, 1)
	assert.equal(errors[0].file, 'rusak.js')
	assert.match(errors[0].message, /sengaja rusak/)
})

test('loader melaporkan file yang tidak meng-export objek plugin di skipped (bukan error)', () => {
	const dir = makePluginsDir({
		'baik.js': "module.exports = { command: 'halo', execute() {} }",
		'helper.js': 'module.exports = function bukanPlugin() {}',
		'kosong.js': 'module.exports = null',
	})
	const { allPlugins, errors, skipped } = quietLoad(dir)

	assert.equal(allPlugins.length, 1)
	assert.deepEqual(errors, [])
	assert.deepEqual(skipped.map((s) => s.file).sort(), ['helper.js', 'kosong.js'])
})

test('loader melaporkan command yang bentrok di errors dan hanya mendaftarkan yang pertama', () => {
	const dir = makePluginsDir({
		'a.js': "module.exports = { command: 'sama', execute() { return 'a' } }",
		'b.js': "module.exports = { command: 'SAMA', execute() { return 'b' } }",
	})
	const { commands, errors } = quietLoad(dir)

	assert.equal(errors.length, 1)
	assert.match(errors[0].message, /sama/)
	assert.equal(commands.get('sama').execute(), 'a') // yang pertama menang
})

test('loader membaca subfolder dan mengabaikan file non-.js', () => {
	const dir = makePluginsDir({
		'kategori/satu.js': "module.exports = { command: 'satu', execute() {} }",
		'kategori/dalam/dua.js': "module.exports = { command: 'dua', aliases: ['d'], execute() {} }",
		'catatan.txt': 'bukan plugin',
		'data.json': '{}',
	})
	const { commands, allPlugins, errors, skipped } = quietLoad(dir)

	assert.equal(allPlugins.length, 2)
	for (const name of ['satu', 'dua', 'd']) assert.ok(commands.has(name), name)
	assert.deepEqual(errors, [])
	assert.deepEqual(skipped, [])
	assert.deepEqual(allPlugins.map((p) => p._file).sort(), [path.join('kategori', 'dalam', 'dua.js'), path.join('kategori', 'satu.js')])
})

test('folder plugin yang tidak ada menghasilkan hasil kosong, tidak crash', () => {
	const { allPlugins, errors, skipped, commands } = loadPlugins(path.join(os.tmpdir(), 'zenith-folder-yang-tidak-ada'))
	assert.equal(allPlugins.length, 0)
	assert.equal(commands.size, 0)
	assert.deepEqual(errors, [])
	assert.deepEqual(skipped, [])
})
