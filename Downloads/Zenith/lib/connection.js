'use strict'

const makeWASocket = require('@whiskeysockets/baileys').default
const {
	useMultiFileAuthState,
	makeCacheableSignalKeyStore,
	fetchLatestBaileysVersion,
	Browsers,
	isJidBroadcast,
	isJidNewsletter,
} = require('@whiskeysockets/baileys')
const { NodeCache } = require('@cacheable/node-cache')
const P = require('pino')

// Cache HARUS bertahan lintas reconnect (bukan dibuat ulang setiap kali createSocket
// dipanggil), supaya hitungan retry & metadata grup tidak hilang tiap kali koneksi
// putus-nyambung. Lihat docs resmi Baileys (Socket config -> Message reliability &
// Group performance).
const msgRetryCounterCache = new NodeCache()
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false })

/**
 * messageStore: instance MessageStore (lib/messageStore.js). Dibuat SEKALI oleh pemanggil dan
 * dipakai ulang di setiap reconnect, jadi pesan terkirim tetap tersedia untuk retry.
 */
async function createSocket(config, messageStore) {
	const logger = P({ level: config.logLevel }).child({ class: 'baileys' })
	const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir)
	const { version } = await fetchLatestBaileysVersion()

	const sock = makeWASocket({
		version,
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		browser: Browsers.ubuntu(config.botName),
		// Biarkan HP tetap dapat notifikasi push selagi bot jalan di background.
		markOnlineOnConnect: false,
		// Riwayat penuh jarang perlu untuk bot & bikin start lebih lama -- dimatikan.
		syncFullHistory: false,
		generateHighQualityLinkPreview: true,
		msgRetryCounterCache,
		maxMsgRetryCount: 5,
		connectTimeoutMs: 20_000,
		defaultQueryTimeoutMs: 60_000,
		keepAliveIntervalMs: 30_000,
		// Abaikan status/broadcast list/newsletter -- bukan percakapan sungguhan,
		// dan mengurangi noise + trafik yang tidak perlu diproses bot.
		shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidNewsletter(jid),
		getMessage: async (key) => {
			try {
				return messageStore ? messageStore.get(key) : undefined
			} catch (err) {
				return undefined // kegagalan lookup tidak boleh merusak alur retry Baileys
			}
		},
		cachedGroupMetadata: async (jid) => groupCache.get(jid),
	})

	return { sock, saveCreds, groupCache }
}

module.exports = { createSocket, groupCache }
