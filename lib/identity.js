'use strict'

const { areJidsSameUser } = require('@whiskeysockets/baileys')

/**
 * Sejak Baileys v7, WhatsApp punya dua bentuk identitas untuk orang yang sama:
 *  - PNJID  (berbasis nomor telepon)  -> ...@s.whatsapp.net
 *  - LIDJID (identitas tersamar)      -> ...@lid   <- ini yang jadi default di grup
 *
 * Supaya deteksi "apakah pengirim ini owner?" / "apakah pengirim ini admin grup?"
 * tetap benar walau WhatsApp mengirim salah satu bentuk saja, semua fungsi di
 * bawah ini membandingkan SEMUA kandidat identitas yang tersedia (bentuk utama
 * + bentuk "Alt"-nya), bukan cuma satu string JID mentah.
 */

function candidatesFromKey(key) {
	// Di dalam grup: pengirim ada di key.participant (+ participantAlt).
	// Di chat pribadi: pengirim adalah lawan bicara di key.remoteJid (+ remoteJidAlt).
	const list = [key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt]
	return list.filter(Boolean)
}

function candidatesFromParticipant(p) {
	// Nama field persis untuk "bentuk alternatif" pada objek participant grup
	// tidak 100% seragam di seluruh versi, jadi dicek beberapa kemungkinan yang
	// masuk akal sekaligus -- lebih aman daripada berasumsi satu nama field saja.
	const list = [p.id, p.jid, p.lid, p.phoneNumber, p.jidAlt, p.participantAlt]
	return list.filter(Boolean)
}

function anyMatch(candidatesA, candidatesB) {
	for (const a of candidatesA) {
		for (const b of candidatesB) {
			try {
				if (areJidsSameUser(a, b)) return true
			} catch (err) {
				// JID tidak valid/tidak terduga -> abaikan pasangan ini, jangan sampai crash
			}
		}
	}
	return false
}

function isOwnerMessage(key, owners) {
	if (!owners || owners.length === 0) return false
	return anyMatch(candidatesFromKey(key), owners)
}

/**
 * Cari data participant pengirim pesan di dalam metadata grup, lalu kembalikan
 * apakah dia admin/superadmin.
 */
function isSenderGroupAdmin(key, groupMetadata) {
	const participant = findParticipant(key, groupMetadata)
	if (!participant) return false
	return participant.admin === 'admin' || participant.admin === 'superadmin'
}

function isBotGroupAdmin(botJid, groupMetadata) {
	if (!groupMetadata?.participants) return false
	for (const p of groupMetadata.participants) {
		if (anyMatch([botJid], candidatesFromParticipant(p))) {
			return p.admin === 'admin' || p.admin === 'superadmin'
		}
	}
	return false
}

/**
 * Cek apakah bot sendiri ada di dalam sebuah daftar GroupParticipant[]
 * (dipakai untuk mendeteksi "bot baru saja dikeluarkan/keluar dari grup"
 * lewat event group-participants.update, action: 'remove').
 */
function isSelfAmongParticipants(botJid, participants) {
	if (!botJid || !Array.isArray(participants)) return false
	for (const p of participants) {
		if (anyMatch([botJid], candidatesFromParticipant(p))) return true
	}
	return false
}

function findParticipant(key, groupMetadata) {
	if (!groupMetadata?.participants) return null
	const senderCandidates = candidatesFromKey(key)
	for (const p of groupMetadata.participants) {
		if (anyMatch(senderCandidates, candidatesFromParticipant(p))) return p
	}
	return null
}

module.exports = {
	isOwnerMessage,
	isSenderGroupAdmin,
	isBotGroupAdmin,
	isSelfAmongParticipants,
	candidatesFromKey,
}
