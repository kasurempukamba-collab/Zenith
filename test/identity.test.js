'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const identity = require('../lib/identity')

const owners = ['6281234567890@s.whatsapp.net']

test('owner cocok lewat remoteJid di chat pribadi (bentuk PN)', () => {
	const key = { remoteJid: '6281234567890@s.whatsapp.net' }
	assert.equal(identity.isOwnerMessage(key, owners), true)
})

test('owner cocok lewat remoteJidAlt di chat pribadi (bentuk LID)', () => {
	const key = { remoteJid: '999888777@lid', remoteJidAlt: '6281234567890@s.whatsapp.net' }
	assert.equal(identity.isOwnerMessage(key, owners), true)
})

test('bukan owner kalau tidak cocok sama sekali', () => {
	const key = { remoteJid: '6289999999999@s.whatsapp.net' }
	assert.equal(identity.isOwnerMessage(key, owners), false)
})

test('owner cocok di dalam grup lewat participantAlt (bentuk LID)', () => {
	const key = { remoteJid: 'grup1@g.us', participant: '111222@lid', participantAlt: '6281234567890@s.whatsapp.net' }
	assert.equal(identity.isOwnerMessage(key, owners), true)
})

test('owners kosong -> tidak pernah dianggap owner', () => {
	const key = { remoteJid: '6281234567890@s.whatsapp.net' }
	assert.equal(identity.isOwnerMessage(key, []), false)
})

const groupMetadata = {
	participants: [
		{ id: '111222@lid', phoneNumber: '6281234567890@s.whatsapp.net', admin: 'superadmin' },
		{ id: '333444@lid', phoneNumber: '6281111111111@s.whatsapp.net', admin: null },
		{ id: '555666@lid', phoneNumber: '6282222222222@s.whatsapp.net', admin: 'admin' },
	],
}

test('deteksi sender admin (superadmin) via field alternatif phoneNumber', () => {
	const key = { participant: '6281234567890@s.whatsapp.net' } // sender kirim dalam bentuk PN
	assert.equal(identity.isSenderGroupAdmin(key, groupMetadata), true)
})

test('deteksi sender BUKAN admin', () => {
	const key = { participant: '6281111111111@s.whatsapp.net' }
	assert.equal(identity.isSenderGroupAdmin(key, groupMetadata), false)
})

test('deteksi sender yang tidak ada di grup -> bukan admin', () => {
	const key = { participant: '6289999999999@s.whatsapp.net' }
	assert.equal(identity.isSenderGroupAdmin(key, groupMetadata), false)
})

test('deteksi bot admin (role: admin)', () => {
	assert.equal(identity.isBotGroupAdmin('555666@lid', groupMetadata), true)
})

test('deteksi bot BUKAN admin', () => {
	assert.equal(identity.isBotGroupAdmin('333444@lid', groupMetadata), false)
})

test('groupMetadata kosong/null tidak bikin crash', () => {
	assert.equal(identity.isBotGroupAdmin('555666@lid', null), false)
	assert.equal(identity.isSenderGroupAdmin({ participant: 'x@s.whatsapp.net' }, null), false)
})

// isSelfAmongParticipants -- dipakai index.js untuk deteksi "bot dikeluarkan dari grup"
// lewat event group-participants.update (lihat plugins/group/welcome.js untuk bentuk data asli).
test('isSelfAmongParticipants: true kalau bot (bentuk LID) ada di daftar participant', () => {
	const participants = [{ id: '111222@lid', phoneNumber: '6281234567890@s.whatsapp.net' }]
	assert.equal(identity.isSelfAmongParticipants('111222@lid', participants), true)
})

test('isSelfAmongParticipants: true walau bot dicek dalam bentuk PN tapi participant dalam bentuk LID', () => {
	const participants = [{ id: '111222@lid', phoneNumber: '6281234567890@s.whatsapp.net' }]
	assert.equal(identity.isSelfAmongParticipants('6281234567890@s.whatsapp.net', participants), true)
})

test('isSelfAmongParticipants: false kalau bot tidak ada di daftar', () => {
	const participants = [{ id: '333444@lid', phoneNumber: '6281111111111@s.whatsapp.net' }]
	assert.equal(identity.isSelfAmongParticipants('111222@lid', participants), false)
})

test('isSelfAmongParticipants: tidak crash untuk input kosong/tidak valid', () => {
	assert.equal(identity.isSelfAmongParticipants(undefined, []), false)
	assert.equal(identity.isSelfAmongParticipants('111@lid', undefined), false)
	assert.equal(identity.isSelfAmongParticipants('111@lid', null), false)
})
