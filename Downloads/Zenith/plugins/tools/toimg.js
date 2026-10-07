'use strict'

const sharp = require('sharp')
const { downloadMediaMessage } = require('@whiskeysockets/baileys')
const baileysLogger = require('../../lib/logger')

function extractStickerMessage(msg) {
	const contextInfo = msg.message?.extendedTextMessage?.contextInfo
	const quoted = contextInfo?.quotedMessage
	if (quoted?.stickerMessage) {
		return {
			key: {
				remoteJid: msg.key.remoteJid,
				id: contextInfo.stanzaId,
				participant: contextInfo.participant,
			},
			message: quoted,
		}
	}
	return null
}

module.exports = {
	command: 'toimg',
	category: 'tools',
	description: 'Ubah stiker jadi gambar. Reply sebuah stiker lalu ketik .toimg',
	async execute(ctx) {
		const target = extractStickerMessage(ctx.msg)
		if (!target) {
			return ctx.reply('Reply sebuah stiker dengan perintah ".toimg"')
		}

		await ctx.react('⏳')
		try {
			const buffer = await downloadMediaMessage(
				target,
				'buffer',
				{},
				{ logger: baileysLogger, reuploadRequest: ctx.sock.updateMediaMessage }
			)
			const png = await sharp(buffer).png().toBuffer()
			await ctx.reply({ image: png })
			await ctx.react('✅')
		} catch (err) {
			await ctx.react('❌')
			await ctx.reply(`⚠️ Gagal mengubah stiker: ${err.message}`)
		}
	},
}
