'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { getTargetJids } = require('../lib/target')

test('ambil target dari mentionedJid', () => {
	const msg = { message: { extendedTextMessage: { contextInfo: { mentionedJid: ['a@s.whatsapp.net', 'b@s.whatsapp.net'] } } } }
	assert.deepEqual(getTargetJids(msg), ['a@s.whatsapp.net', 'b@s.whatsapp.net'])
})

test('ambil target dari participant (reply ke orang)', () => {
	const msg = { message: { extendedTextMessage: { contextInfo: { participant: 'c@s.whatsapp.net' } } } }
	assert.deepEqual(getTargetJids(msg), ['c@s.whatsapp.net'])
})

test('participant + mentionedJid digabung tanpa duplikat', () => {
	const msg = {
		message: {
			extendedTextMessage: {
				contextInfo: { participant: 'c@s.whatsapp.net', mentionedJid: ['c@s.whatsapp.net', 'd@s.whatsapp.net'] },
			},
		},
	}
	assert.deepEqual(getTargetJids(msg), ['c@s.whatsapp.net', 'd@s.whatsapp.net'])
})

test('kosong kalau tidak ada contextInfo sama sekali', () => {
	const msg = { message: { conversation: 'halo' } }
	assert.deepEqual(getTargetJids(msg), [])
})

test('tidak crash kalau msg.message kosong', () => {
	const msg = { message: null }
	assert.deepEqual(getTargetJids(msg), [])
})
