'use strict'

const sharp = require('sharp')
const { downloadMediaMessage } = require('@whiskeysockets/baileys')
const baileysLogger = require('../../lib/logger')

function extractImageMessage(msg) {
	if (msg.message?.imageMessage) return msg

	const contextInfo = msg.message?.extendedTextMessage?.contextInfo
	const quoted = contextInfo?.quotedMessage
	if (quoted?.imageMessage) {
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
	command: 'sticker',
	aliases: ['s', 'stiker'],
	category: 'tools',
	description: 'Ubah gambar jadi stiker. Kirim gambar dengan caption .sticker, atau reply gambar.',
	async execute(ctx) {
		const target = extractImageMessage(ctx.msg)
		if (!target) {
			return ctx.reply('Kirim gambar dengan caption ".sticker", atau reply sebuah gambar dengan ".sticker".')
		}

		await ctx.react('⏳')
		try {
			const buffer = await downloadMediaMessage(
				target,
				'buffer',
				{},
				{ logger: baileysLogger, reuploadRequest: ctx.sock.updateMediaMessage }
			)

			const webp = await sharp(buffer)
				.resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
				.webp()
				.toBuffer()

			await ctx.reply({ sticker: webp })
			await ctx.react('✅')
		} catch (err) {
			await ctx.react('❌')
			await ctx.reply(`⚠️ Gagal membuat stiker: ${err.message}`)
		}
	},
}
