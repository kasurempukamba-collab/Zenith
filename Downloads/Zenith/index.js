'use strict'

const path = require('path')
const readline = require('readline')
const { Boom } = require('@hapi/boom')
const { DisconnectReason } = require('@whiskeysockets/baileys')
const qrcodeTerminal = require('qrcode-terminal')

const config = require('./config')
const ui = require('./lib/ui')
const Store = require('./lib/store')
const MessageStore = require('./lib/messageStore')
const { AntiBanGuard } = require('./lib/antiban')
const { loadPlugins } = require('./lib/pluginLoader')
const connectionLib = require('./lib/connection')
const identity = require('./lib/identity')

const store = new Store(path.join(__dirname, 'data', 'database.json'))
// Pesan terkirim dicatat (dan disimpan ke disk) supaya bisa dikirim ulang kalau perangkat penerima
// gagal mendekripsi -- lihat lib/messageStore.js.
const messageStore = new MessageStore({
	filePath: path.join(__dirname, 'data', 'messages.json'),
	...config.messageStore,
})
const antiban = new AntiBanGuard(config, store, { onSent: (sent) => messageStore.rememberSent(sent) })
const { commands, passiveHooks, groupHooks, allPlugins } = loadPlugins(path.join(__dirname, 'plugins'))

let reconnectAttempts = 0

function getMessageText(message) {
	if (!message) return ''
	return (
		message.conversation ||
		message.extendedTextMessage?.text ||
		message.imageMessage?.caption ||
		message.videoMessage?.caption ||
		''
	)
}

function askQuestion(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	return new Promise((resolve) => rl.question(question, (answer) => {
		rl.close()
		resolve(answer)
	}))
}

async function requestPairing(sock) {
	let number = config.pairingNumber
	if (!number) {
		number = await askQuestion('Masukkan nomor WhatsApp (format internasional tanpa "+", contoh 6281234567890): ')
	}
	number = String(number).replace(/[^0-9]/g, '')
	if (!number) {
		ui.error('Nomor tidak valid, coba jalankan ulang bot.')
		return
	}
	try {
		const code = await sock.requestPairingCode(number)
		ui.pairingCode(code)
	} catch (err) {
		ui.error(`Gagal meminta kode pairing: ${err.message}`)
	}
}

async function getGroupMetadataCached(sock, jid) {
	let metadata = connectionLib.groupCache.get(jid)
	if (!metadata) {
		metadata = await sock.groupMetadata(jid)
		connectionLib.groupCache.set(jid, metadata)
	}
	return metadata
}

function buildBaseContext(sock, jid, msg) {
	return {
		sock,
		jid,
		msg,
		config,
		store,
		logger: ui,
		commands,
		allPlugins,
		async reply(content, opts = {}) {
			const payload = typeof content === 'string' ? { text: content } : content
			return antiban.safeSend(sock, jid, payload, msg ? { quoted: msg, ...opts } : opts)
		},
		// Pesan kontrol (reaksi, hapus pesan) ikut antrean anti-ban yang sama dengan reply(), tapi
		// tanpa jeda acak dan tanpa "mengetik". Hasilnya bisa di-await (mis. untuk tahu apakah
		// penghapusan berhasil).
		async sendControl(content, opts = {}) {
			return antiban.sendControl(sock, jid, content, opts)
		},
		async react(emoji) {
			if (!msg) return
			// Sengaja tidak di-await: reaksi cukup masuk antrean (urutan terhadap balasan tetap terjaga)
			// dan tidak boleh menahan jalannya perintah. Reaksi gagal bukan hal kritis.
			antiban.sendControl(sock, jid, { react: { text: emoji, key: msg.key } }).catch(() => {})
		},
	}
}

async function handleIncomingMessage(sock, msg) {
	const jid = msg.key.remoteJid
	if (!jid) return

	const isGroup = jid.endsWith('@g.us')
	let groupMetadata = null
	if (isGroup) {
		try {
			groupMetadata = await getGroupMetadataCached(sock, jid)
		} catch (err) {
			ui.warn(`Gagal mengambil metadata grup ${jid}: ${err.message}`)
		}
	}

	const isOwner = identity.isOwnerMessage(msg.key, config.owners)
	const isSenderAdmin = isGroup ? identity.isSenderGroupAdmin(msg.key, groupMetadata) : false
	const isBotAdmin = isGroup ? identity.isBotGroupAdmin(sock.user?.id, groupMetadata) : false

	// Mode privat: bot hanya merespons owner. Berguna saat masih menguji-uji bot.
	const selfMode = store.get('selfMode', config.selfModeDefault)
	if (selfMode && !isOwner) return

	const text = getMessageText(msg.message)
	const base = buildBaseContext(sock, jid, msg)
	const ctx = { ...base, isGroup, isOwner, isSenderAdmin, isBotAdmin, groupMetadata, text }

	// Plugin pasif (mis. antilink) dicek untuk SEMUA pesan, bukan cuma yang berupa command.
	for (const plugin of passiveHooks) {
		try {
			await plugin.onMessage(ctx)
		} catch (err) {
			ui.error(`Plugin pasif "${plugin._file}" error: ${err.message}`)
		}
	}

	if (!text || !text.startsWith(config.prefix)) return
	const withoutPrefix = text.slice(config.prefix.length).trim()
	if (!withoutPrefix) return

	const [cmdRaw, ...rest] = withoutPrefix.split(/\s+/)
	const command = cmdRaw.toLowerCase()
	const plugin = commands.get(command)
	if (!plugin) return

	if (plugin.ownerOnly && !isOwner) {
		return ctx.reply('🔒 Perintah ini khusus untuk owner bot.')
	}
	if (plugin.groupOnly && !isGroup) {
		return ctx.reply('⚠️ Perintah ini hanya bisa dipakai di dalam grup.')
	}
	if (plugin.adminOnly && isGroup && !isSenderAdmin && !isOwner) {
		return ctx.reply('🔒 Perintah ini khusus admin grup.')
	}
	if (plugin.botAdminOnly && isGroup && !isBotAdmin) {
		return ctx.reply('⚠️ Jadikan bot admin grup dulu untuk memakai perintah ini.')
	}

	const args = rest
	const body = rest.join(' ')

	try {
		await plugin.execute({ ...ctx, args, body })
	} catch (err) {
		ui.error(`Plugin ".${command}" (${plugin._file}) error: ${err.stack || err.message}`)
		await ctx.reply('⚠️ Ada error saat menjalankan perintah ini.').catch(() => {})
	}
}

async function handleGroupParticipantsUpdate(sock, event) {
	// Kalau event ini adalah BOT SENDIRI yang dikeluarkan/keluar dari grup, jangan
	// coba ambil groupMetadata lagi -- bot sudah tidak punya akses ke grup itu, dan
	// permintaan itu akan selalu gagal dengan error "forbidden". Cukup bersihkan
	// cache & keluar dengan log yang tenang (bukan [ERR] yang bikin panik).
	if (event.action === 'remove' && identity.isSelfAmongParticipants(sock.user?.id, event.participants)) {
		connectionLib.groupCache.del(event.id)
		ui.info(`Bot dikeluarkan/keluar dari grup ${event.id}, cache metadata grup ini dibersihkan.`)
		return
	}

	let metadata
	try {
		metadata = await sock.groupMetadata(event.id)
		connectionLib.groupCache.set(event.id, metadata)
	} catch (err) {
		// Gagal ambil metadata terbaru (mis. grup baru saja berubah/permission race) --
		// jangan berhenti total, coba pakai cache lama kalau ada supaya hook (welcome/dst)
		// tetap bisa jalan dengan data yang sedikit basi daripada tidak jalan sama sekali.
		metadata = connectionLib.groupCache.get(event.id) || null
		ui.warn(`Gagal refresh metadata grup ${event.id} (${err.message}), pakai cache lama kalau ada.`)
	}

	const base = buildBaseContext(sock, event.id, null)
	const ctx = { ...base, groupMetadata: metadata }
	for (const plugin of groupHooks) {
		try {
			await plugin.onGroupParticipantsUpdate(ctx, event)
		} catch (err) {
			ui.error(`Group hook "${plugin._file}" error: ${err.stack || err.message}`)
		}
	}
}

function scheduleReconnect(immediate) {
	const delay = immediate ? 0 : Math.min(60_000, 2000 * 2 ** reconnectAttempts)
	reconnectAttempts += 1
	if (!immediate) {
		ui.warn(`Koneksi putus, mencoba menyambung ulang dalam ${Math.round(delay / 1000)}s...`)
	}
	setTimeout(() => start(), delay)
}

async function start() {
	const { sock, saveCreds } = await connectionLib.createSocket(config, messageStore)

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			if (config.usePairingCode) {
				if (!sock.authState.creds.registered) {
					await requestPairing(sock)
				}
			} else {
				ui.info('Scan QR code ini dengan WhatsApp (Perangkat Tertaut → Tautkan Perangkat):')
				qrcodeTerminal.generate(qr, { small: true })
			}
		}

		if (connection === 'close') {
			const statusCode =
				lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : undefined

			if (statusCode === DisconnectReason.loggedOut) {
				ui.error(
					`Sesi ini sudah logout (dicabut dari HP). Hapus folder "${config.sessionDir}" lalu jalankan ulang untuk login baru.`
				)
				process.exit(1)
			} else if (statusCode === DisconnectReason.restartRequired) {
				scheduleReconnect(true)
			} else {
				ui.warn(`Koneksi terputus: ${lastDisconnect?.error?.message || 'tidak diketahui'}`)
				scheduleReconnect(false)
			}
		} else if (connection === 'open') {
			reconnectAttempts = 0
			ui.success(`Terhubung sebagai ${sock.user?.id || '(tidak diketahui)'}`)
			ui.info(`${commands.size} alias perintah dimuat dari ${allPlugins.length} plugin.`)
			if (antiban.isWarmup()) {
				ui.warn(
					`Mode warm-up aktif (${config.antiban.warmupDays} hari pertama sejak bot ini pertama dijalankan) — pengiriman pesan sengaja diperlambat.`
				)
			}
		}
	})

	sock.ev.on('messages.upsert', async (event) => {
		if (event.type !== 'notify') return
		for (const msg of event.messages) {
			messageStore.rememberReceived(msg)
			if (!msg.message || msg.key.fromMe) continue
			// Orang ini menghubungi bot DULUAN -> membalasnya bukan "kontak baru" bagi lapisan anti-ban.
			antiban.noteInbound(msg.key)
			try {
				await handleIncomingMessage(sock, msg)
			} catch (err) {
				ui.error(`Gagal memproses pesan masuk: ${err.stack || err.message}`)
			}
		}
	})

	sock.ev.on('groups.update', async ([event]) => {
		try {
			const metadata = await sock.groupMetadata(event.id)
			connectionLib.groupCache.set(event.id, metadata)
		} catch (err) {
			// grup mungkin sudah tidak diikuti bot, aman untuk diabaikan
		}
	})

	sock.ev.on('group-participants.update', (event) => {
		handleGroupParticipantsUpdate(sock, event)
	})
}

process.on('unhandledRejection', (err) => {
	ui.error(`Unhandled rejection: ${err?.stack || err}`)
})
process.on('uncaughtException', (err) => {
	ui.error(`Uncaught exception: ${err?.stack || err}`)
})

// Tulis pesan terkirim yang masih menunggu giliran ke disk sebelum proses berhenti. Ctrl+C / kill
// secara default mematikan proses tanpa event 'exit', jadi sinyalnya ditangani supaya flush tetap jalan.
process.on('exit', () => messageStore.flush())
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(signal, () => process.exit(0))
}

ui.banner(config.botName)
ui.info(`Prefix: "${config.prefix}"  |  Owner terdaftar: ${config.owners.length}`)
if (config.owners.length === 0) {
	ui.warn('OWNER_NUMBERS belum diisi di .env — perintah ownerOnly tidak bisa dipakai siapa pun.')
}
start().catch((err) => {
	ui.error(`Gagal memulai bot: ${err.stack || err.message}`)
	process.exit(1)
})
