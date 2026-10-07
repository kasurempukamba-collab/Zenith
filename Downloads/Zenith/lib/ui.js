'use strict'

const chalk = require('chalk')

function banner(botName) {
	const line = chalk.cyan('─'.repeat(50))
	console.log(line)
	console.log(chalk.bold.greenBright(`   ${botName}`) + chalk.gray('  —  WhatsApp Bot Mandiri'))
	console.log(chalk.gray('   unofficial • self-hosted • jalan 100% di komputer sendiri'))
	console.log(line)
}

function info(msg) {
	console.log(chalk.blueBright('[INFO]'), msg)
}

function success(msg) {
	console.log(chalk.greenBright('[OK]  '), msg)
}

function warn(msg) {
	console.log(chalk.yellowBright('[WARN]'), msg)
}

function error(msg) {
	console.log(chalk.redBright('[ERR] '), msg)
}

function pairingCode(code) {
	const box = chalk.bold.bgGreen.black(` ${code} `)
	console.log('')
	console.log(chalk.gray('  Buka WhatsApp di HP → Perangkat Tertaut → Tautkan Perangkat → Tautkan dengan nomor telepon'))
	console.log('  Kode pairing kamu:  ', box)
	console.log('')
}

module.exports = { banner, info, success, warn, error, pairingCode }
