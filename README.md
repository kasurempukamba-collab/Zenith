# WA Bot Mandiri

Bot WhatsApp *unofficial* (bukan Cloud API resmi) berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) — jalan 100% di komputer kamu sendiri, tidak ada server pihak ketiga yang menyimpan sesi/pesan kamu. Punya sistem plugin, dan lapisan anti-ban yang benar-benar dipaksa secara arsitektur (bukan cuma slogan).

> ⚠️ **Baca bagian ["Tentang Keamanan Akun"](#tentang-keamanan-akun-anti-ban) sebelum pakai.** Tidak ada cara yang menjamin nomor 100% tidak pernah diblokir WhatsApp — siapa pun yang menjanjikan itu, jangan percaya.

## Fitur

**Umum** — `.menu`, `.ping`, `.info`, `.owner`
**Owner** — `.mode self|public` (batasi bot hanya membalas owner)
**Grup** — `.tagall` (grup besar dikirim bertahap, ada batas anggota), `.kick`, `.promote`, `.demote`, `.antilink on|off`, `.welcome on|off`
**Tools** — `.sticker` (gambar → stiker), `.toimg` (stiker → gambar)
**AI** — `.ai <pertanyaan>` (opsional, butuh API key sendiri)

Ketik `.menu` di WhatsApp untuk lihat daftar lengkap beserta siapa saja yang boleh pakai.

Sengaja **tidak ada** fitur broadcast/blast ke banyak nomor sekaligus — lihat kenapa di bagian anti-ban.

## Instalasi

Butuh **Node.js versi 22.12 ke atas** (dependency cache internal mewajibkan Node 22+, dan Baileys adalah paket ESM yang baru bisa di-`require()` tanpa flag mulai Node 22.12).

```bash
npm install
cp .env.example .env
```

Buka file `.env`, isi minimal:
- `OWNER_NUMBERS` — nomor WhatsApp kamu (format `62xxxxxxxxxx`, tanpa `+`)
- Biarkan yang lain default dulu, sudah aman untuk mulai.

## Menjalankan

```bash
npm start
```

Secara default bot login pakai **kode pairing** (8 digit, ketik di HP — tidak perlu scan QR):
1. Bot akan minta nomor WhatsApp kamu di terminal (atau isi `PAIRING_NUMBER` di `.env` supaya tidak ditanya lagi).
2. Buka WhatsApp di HP → **Perangkat Tertaut** → **Tautkan Perangkat** → **Tautkan dengan nomor telepon**.
3. Masukkan 8 digit kode yang muncul di terminal.

Mau pakai QR code biasa? Set `USE_PAIRING_CODE=false` di `.env`.

Sesi login tersimpan di folder `session/` — jangan dihapus kalau tidak mau scan/pairing ulang tiap kali start.

## Data Lokal (folder `data/`)

Bot menyimpan sedikit data di folder `data/` (dibuat otomatis, tidak ikut ke git):

- `database.json` — pengaturan grup (antilink/welcome), mode self/public, tanggal pertama bot dijalankan (dipakai warm-up), dan daftar kontak yang sudah dikenal. Versi sebelumnya disimpan sebagai `database.json.bak`.
- `messages.json` — pesan **terkirim** terakhir milik bot (maks. `MESSAGE_STORE_MAX_ENTRIES` pesan, umur maks. `MESSAGE_STORE_TTL_HOURS` jam). Dipakai untuk mengirim ulang pesan yang gagal didekripsi penerima, juga setelah bot restart. Pesan masuk dari orang lain **tidak pernah** ditulis ke disk. Aman dihapus kapan saja.

Cara kerjanya:
- Penulisan file bersifat **atomik** (tulis ke file sementara, lalu rename), jadi crash, `kill`, atau mati listrik di tengah penyimpanan tidak bisa meninggalkan file separuh jadi.
- Kalau `database.json` ternyata rusak, bot **tidak menimpanya**: file itu dipindah ke `database.json.corrupt-<waktu>` (bisa diperiksa/diselamatkan manual) dan data dipulihkan dari `database.json.bak`.
- Catatan pesan terkirim ditulis ke disk dengan jeda sampai 10 detik, dan langsung ditulis saat bot dimatikan lewat Ctrl+C / `kill`. Kalau proses dimatikan paksa (`kill -9`) atau listrik padam, catatan 10 detik terakhir bisa hilang.
- Mau reset? Hapus **folder `data/`**. Perhatikan: ini juga mengulang hitungan warm-up dari awal.

## Tentang Keamanan Akun (Anti-Ban)

Ini bagian paling penting untuk dibaca jujur-jujuran, bukan bagian marketing.

**Yang benar-benar diterapkan di kode ini** (lihat `lib/antiban.js`), berdasarkan riset — bukan tebakan:

1. **Reaktif, bukan proaktif.** Bot ini didesain untuk *membalas* pesan yang masuk, bukan menghubungi banyak nomor asing duluan. Tidak ada fungsi broadcast/blast sama sekali di proyek ini — ini keputusan desain yang sengaja, karena bot yang proaktif menghubungi banyak orang jauh lebih rawan dilaporkan/diblokir daripada bot yang cuma membalas.
2. **Mode warm-up untuk nomor baru.** Kalau nomor yang kamu pakai masih baru, `WARMUP_MODE=true` (default) akan memperlambat pengiriman & membatasi jumlah "kontak baru" per hari selama beberapa hari pertama. Kalau nomornya sudah lama dipakai normal, boleh dimatikan.
3. **Jeda pengiriman acak + simulasi mengetik.** Setiap balasan diberi jeda acak (manusiawi, bukan instan) dan indikator "mengetik…" sebelum terkirim, supaya pola kirim tidak terlihat seperti mesin yang menembak pesan secepat mungkin. Semua pengiriman (balasan, reaksi, hapus pesan) berjalan **satu per satu** dalam satu antrean: pesan berikutnya baru diproses setelah pengiriman sebelumnya benar-benar selesai, dan jeda dihitung sejak saat itu. Satu pengiriman yang macet dilepas setelah `SEND_TIMEOUT_MS` supaya tidak menahan pesan lain selamanya.
4. **Batas kontak baru per hari — ditegakkan, bukan sekadar peringatan.** "Kontak baru" = nomor yang bot hubungi **duluan**. Membalas orang yang chat lebih dulu tidak dihitung dan tidak pernah diblokir. Kalau batas tercapai, pengiriman ke kontak baru berikutnya **ditolak** (error `NEW_CONTACT_CAP`) sampai pergantian hari (UTC). Atur lewat `NEW_CONTACT_DAILY_CAP` dan `WARMUP_NEW_CONTACT_DAILY_CAP`; nilai `0` berarti bot tidak boleh memulai chat dengan siapa pun.
5. **Cache metadata grup**, supaya bot tidak berulang kali memanggil `groupMetadata` yang bisa memicu rate limit di grup besar.

**Yang TIDAK bisa dijamin, oleh siapa pun, dengan cara apa pun:**
- 100% bebas dari kemungkinan diblokir. Deteksi WhatsApp berubah dari waktu ke waktu dan tidak transparan ke publik.
- Kalau kamu benar-benar spam/kirim konten yang dilaporkan banyak orang, jeda 2 detik pun tidak akan menyelamatkan nomor kamu.

**Saran tambahan yang tidak bisa "dikodekan", cuma bisa kamu lakukan sendiri:**
- Kalau nomor baru: pakai dulu secara normal (chat biasa) selama beberapa hari SEBELUM ditautkan ke bot ini.
- Jangan jalankan bot lain (WA-GB, multi-session app, dsb) di nomor yang sama secara bersamaan.
- Kalau butuh untuk bisnis/produksi yang serius (bukan sekadar coba-coba pribadi), pertimbangkan **WhatsApp Cloud API resmi** dari Meta — itu satu-satunya jalur yang benar-benar didukung & tidak melanggar ToS.

Pembuat Baileys sendiri juga menyatakan library ini tidak untuk dipakai spam/bulk-messaging/stalkerware — proyek ini mengikuti prinsip yang sama.

## Menambah Plugin Sendiri

Buat file baru di `plugins/<kategori>/nama.js`:

```js
module.exports = {
  command: 'halo',
  category: 'general',
  description: 'Contoh plugin sederhana',
  async execute(ctx) {
    await ctx.reply('Halo juga!')
  },
}
```

`ctx` yang tersedia di setiap plugin: `sock`, `msg`, `jid`, `isGroup`, `isOwner`, `isSenderAdmin`, `isBotAdmin`, `groupMetadata`, `text`, `body`, `args`, `store`, `config`, `reply()`, `react()`, `sendControl()`. Restart bot untuk memuat plugin baru.

Kirim pesan **hanya** lewat `ctx.reply()` (percakapan) atau `ctx.sendControl()` (reaksi / hapus pesan), bukan `ctx.sock.sendMessage()` langsung, supaya pengirimannya ikut antrean dan aturan anti-ban di atas.

## Testing

Proyek ini punya test suite permanen (bukan cuma dites sekali lalu dibuang) memakai `node:test` bawaan Node.js — tidak ada dependency tambahan untuk testing.

```bash
npm test           # jalankan seluruh test suite
npm run lint:syntax  # cek sintaks semua file .js
```

Test mencakup: penyimpanan data lokal (termasuk pemulihan saat file rusak), message store, deteksi owner/admin (termasuk dualitas identitas PN/LID di WhatsApp), ekstraksi target untuk kick/promote/demote, antrean pengiriman anti-ban (serial, jeda, batas kontak baru, timeout), parsing konfigurasi `.env`, plugin `.tagall` / `.ai` / antilink / welcome, dan setiap file plugin bisa dimuat tanpa error (tanpa angka jumlah plugin yang harus diubah setiap kali menambah plugin). File sementara test dibuat di folder temporer sistem, bukan di repo. Otomatis dijalankan lewat GitHub Actions (`.github/workflows/ci.yml`) di setiap push/PR ke branch `main`.

## Troubleshooting

- **"Sesi logout"** → hapus folder `session/`, jalankan ulang, pairing/scan lagi.
- **Bot lambat/tidak balas** → cek `LOG_LEVEL=debug` di `.env` untuk lihat detail. Di hari-hari pertama, mode warm-up (`WARMUP_MODE=true`) memang sengaja memperlambat balasan.
- **Log: "Pesan ke kontak baru DIBLOKIR"** → bot mencoba memulai chat dengan nomor yang belum pernah menghubunginya dan batas harian sudah habis (lihat poin 4 di bagian anti-ban). Ini disengaja; balasan ke orang yang chat duluan tidak terpengaruh.
- **`.tagall` menjawab "melebihi batas"** → grupnya lebih besar dari `TAGALL_MAX_MEMBERS`. Naikkan nilainya di `.env` kalau memang perlu; mention dikirim bertahap sebanyak `TAGALL_CHUNK_SIZE` per pesan.
- **`.ai` menjawab "tidak merespons"** → API tidak menjawab dalam `AI_TIMEOUT_MS`. Naikkan nilainya kalau memakai model besar yang lebih lambat.
- **Ada file `*.corrupt-*` di folder `data/`** → itu salinan file yang ditemukan rusak saat bot start (lihat bagian "Data Lokal"). Boleh dihapus setelah kamu yakin tidak membutuhkannya.
- **Error aneh/tidak konek saat pairing** → Baileys `7.0.0` masih berstatus *release candidate* (aktif diperbaiki). Coba `npm update @whiskeysockets/baileys` untuk versi terbaru.
- Proyek ini sengaja **tidak** menyediakan fitur mengubah/mengarsipkan chat (`chatModify`) — API tersebut, kalau dipakai dengan data yang tidak lengkap/salah, dilaporkan bisa memicu WhatsApp mencabut sesi dari SEMUA perangkat tertaut sekaligus.

## Lisensi

[MIT](./LICENSE) — bebas dipakai, dimodifikasi, dan didistribusikan ulang.

## Disclaimer

Proyek ini tidak berafiliasi dengan WhatsApp/Meta. Menggunakan library unofficial (reverse-engineered) untuk menjalankan akun WhatsApp secara otomatis berada di luar Ketentuan Layanan resmi WhatsApp — pakai dengan tanggung jawab sendiri, terutama untuk akun yang penting bagimu.
