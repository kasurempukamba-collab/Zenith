'use strict'

const P = require('pino')
const config = require('../config')

// Logger pino terpisah dari lib/ui.js (yang untuk tampilan konsol berwarna).
// Ini dipakai khusus saat memanggil fungsi internal Baileys yang mengharapkan
// instance pino (mis. downloadMediaMessage), supaya bentuknya sesuai ekspektasi
// library -- bukan objek console-helper biasa.
const baileysLogger = P({ level: config.logLevel }).child({ class: 'plugin' })

module.exports = baileysLogger
