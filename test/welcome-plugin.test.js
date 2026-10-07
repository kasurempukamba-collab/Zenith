'use strict'

// Test regresi untuk bug nyata yang sempat lolos ke user: welcome.js mengasumsikan
// event.participants berisi array string JID mentah, padahal Baileys v7 mengirim
// array objek GroupParticipant ({ id, lid?, phoneNumber?, admin?, ... }).
// Lihat lib/identity.js & node_modules/@whiskeysockets/baileys/lib/Types/Contact.d.ts
// untuk bentuk data yang benar.

const test = require('node:test')
const assert = require('node:assert/strict')
const welcome = require('../plugins/group/welcome')

function makeStore(welcomeEnabled) {
	return {
		getGroup: () => ({ welcome: welcomeEnabled, antilink: false }),
	}
}

function makeCtx(welcomeEnabled) {
	const sent = []
	return {
		store: makeStore(welcomeEnabled),
		groupMetadata: { subject: 'Grup Uji Coba' },
		reply: async (content) => {
			sent.push(content)
		},
		_sent: sent,
	}
}

test('onGroupParticipantsUpdate TIDAK crash saat participants berupa objek GroupParticipant (bentuk asli Baileys v7)', async () => {
	const ctx = makeCtx(true)
	const event = {
		id: 'grup1@g.us',
		action: 'add',
		participants: [
			{ id: '111222@lid', phoneNumber: '6281234567890@s.whatsapp.net' },
			{ id: '333444@lid', phoneNumber: '6281111111111@s.whatsapp.net' },
		],
	}

	await assert.doesNotReject(() => welcome.onGroupParticipantsUpdate(ctx, event))
	assert.equal(ctx._sent.length, 1)
	assert.match(ctx._sent[0].text, /Selamat datang/)
	assert.deepEqual(ctx._sent[0].mentions, ['111222@lid', '333444@lid'])
})

test('onGroupParticipantsUpdate: pesan perpisahan saat action "remove"', async () => {
	const ctx = makeCtx(true)
	const event = {
		id: 'grup1@g.us',
		action: 'remove',
		participants: [{ id: '111222@lid', phoneNumber: '6281234567890@s.whatsapp.net' }],
	}

	await welcome.onGroupParticipantsUpdate(ctx, event)
	assert.match(ctx._sent[0].text, /meninggalkan/)
})

test('onGroupParticipantsUpdate: tidak kirim apa-apa kalau welcome dimatikan di grup itu', async () => {
	const ctx = makeCtx(false)
	const event = { id: 'grup1@g.us', action: 'add', participants: [{ id: '111@lid' }] }

	await welcome.onGroupParticipantsUpdate(ctx, event)
	assert.equal(ctx._sent.length, 0)
})

test('onGroupParticipantsUpdate: tidak crash & tidak kirim apa-apa untuk action selain add/remove (mis. "promote")', async () => {
	const ctx = makeCtx(true)
	const event = { id: 'grup1@g.us', action: 'promote', participants: [{ id: '111@lid' }] }

	await assert.doesNotReject(() => welcome.onGroupParticipantsUpdate(ctx, event))
	assert.equal(ctx._sent.length, 0)
})

test('onGroupParticipantsUpdate: tidak crash walau groupMetadata null (mis. bot baru saja kehilangan akses)', async () => {
	const ctx = makeCtx(true)
	ctx.groupMetadata = null
	const event = { id: 'grup1@g.us', action: 'add', participants: [{ id: '111@lid' }] }

	await assert.doesNotReject(() => welcome.onGroupParticipantsUpdate(ctx, event))
	assert.match(ctx._sent[0].text, /grup ini/) // fallback nama grup
})
