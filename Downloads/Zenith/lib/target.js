'use strict'

/**
 * Ambil daftar JID "target" dari sebuah command grup (kick/promote/demote/dst):
 * - Kalau pesan me-reply orang lain -> orang yang di-reply itu targetnya.
 * - Kalau pesan meng-@mention satu/lebih orang -> semua yang di-mention.
 * - Kalau tidak ada -> array kosong.
 */
function getTargetJids(msg) {
	const contextInfo = msg.message?.extendedTextMessage?.contextInfo
	if (!contextInfo) return []

	const targets = []
	if (contextInfo.participant) targets.push(contextInfo.participant)
	if (Array.isArray(contextInfo.mentionedJid)) {
		for (const jid of contextInfo.mentionedJid) {
			if (!targets.includes(jid)) targets.push(jid)
		}
	}
	return targets
}

module.exports = { getTargetJids }
