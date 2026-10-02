# AutoAudit Workflow Builder

Aplikasi untuk merakit alur kerja (workflow) AutoAudit dengan cara **seret dan sambung**, mirip draw.io. Anda menyusun kotak-kotak (node) di kanvas, menyambungkannya dengan garis, lalu menekan **Jalankan**. Aplikasi yang mengurus sisanya: memecah periode, menjalankan Audital Work, menggabungkan laporan, dan mengirim hasilnya.

Aplikasi ini berbicara ke AutoAudit lewat **Integration API**, jadi Anda butuh API key AutoAudit untuk memakainya.

## Apa yang bisa dilakukan

- Menjalankan Audital Work (AW) untuk satu atau banyak sales sekaligus.
- Memecah periode panjang atau kontak yang banyak menjadi beberapa AW (chunk), dengan pratinjau sebelum jalan.
- Mengambil laporan yang sudah ada dari History AW atau Continuous Audit, tanpa menjalankan audit baru.
- Menggabungkan banyak laporan menjadi satu (lewat AutoAudit atau lewat OpenRouter).
- Mengeluarkan hasil sebagai Excel, PDF, atau teks; menulis ke Google Sheets; mengirim ke WhatsApp (GOWA); atau mengirim ke sistem lain lewat HTTP.
- Melanjutkan run yang gagal dari titik gagalnya, tanpa mengulang AW yang sudah selesai.

## Yang perlu disiapkan

| Kebutuhan | Keterangan |
|---|---|
| **Node.js versi 24 atau lebih baru** | Unduh di https://nodejs.org. Cek dengan `node -v`. |
| **Git** | Untuk mengunduh kode. |
| **API key AutoAudit** | Integration API Key dari menu API Management di AutoAudit. |
| Kunci service account Google | Opsional. Hanya untuk node Tulis Sheets. |
| Akun GOWA | Opsional. Hanya untuk node Kirim GOWA. |
| API key OpenRouter | Opsional. Hanya untuk node Merge AI; diisi di dalam node, bukan di file. |

Tidak perlu memasang database. Aplikasi membawa Postgres sendiri untuk pemakaian lokal.

## Instalasi

**1. Unduh kode dan pasang dependensi**

```bash
git clone https://github.com/Mohammadfaizulilalbab/work-flow-autoaudit-builder.git
```

```bash
cd work-flow-autoaudit-builder
```

```bash
npm install
```

**2. Buat file pengaturan**

```bash
cp .env.example .env
```

Buka file `.env` dengan editor teks, lalu isi minimal tiga baris ini:

```
AUTOAUDIT_API_KEY=isi_api_key_autoaudit
ADMIN_EMAIL=admin@ordo.local
ADMIN_PASSWORD=isi_password_untuk_login
```

Aturan menulis `.env`: tanpa spasi di sekitar `=`, tanpa tanda kutip, satu nilai per baris. Baris yang diawali `#` diabaikan.

**3. Jalankan aplikasi**

Buka tiga tab terminal di folder proyek, satu perintah per tab, berurutan:

```bash
npm run db
```

```bash
npm run server
```

```bash
npm run web
```

| Perintah | Fungsi | Alamat |
|---|---|---|
| `npm run db` | Database lokal (data tersimpan di folder `.data`) | port 54329 |
| `npm run server` | Server dan mesin yang menjalankan workflow | http://127.0.0.1:8787 |
| `npm run web` | Tampilan kanvas | http://localhost:5173 |

**4. Masuk**

Buka http://localhost:5173 dan masuk dengan `ADMIN_EMAIL` dan `ADMIN_PASSWORD` dari file `.env`.

Untuk mengganti password, ubah `ADMIN_PASSWORD` di `.env` lalu jalankan ulang `npm run server`.

## Pengaturan tambahan (opsional)

### Google Sheets

1. Buat service account di Google Cloud dan unduh kuncinya (file JSON).
2. Simpan file itu sebagai `.secrets/google.json` di folder proyek.
3. Bagikan spreadsheet tujuan ke alamat email service account sebagai **Editor**.
4. Jalankan ulang `npm run server`. Log akan menulis "Google Sheets siap".

### WhatsApp lewat GOWA

Tambahkan ke `.env`, lalu jalankan ulang server:

```
GOWA_BASE_URL=https://alamat-server-gowa
GOWA_USER=isi_user
GOWA_PASSWORD=isi_password
GOWA_DEVICE_ID=isi_device_id
```

### Merge AI (OpenRouter)

API key OpenRouter diisi langsung di node Merge AI pada kanvas. Key disimpan terenkripsi di server dan tidak pernah ditampilkan lagi.

## Cara pakai singkat

1. Klik **+ Workflow baru**, pilih company, beri nama.
2. Seret node dari palet kiri ke kanvas.
3. Sambungkan node dengan menarik garis dari titik di sisi kanan sebuah node ke titik di sisi kiri node berikutnya. Saat menarik, node yang bisa disambung akan menyala.
4. Klik sebuah node untuk mengisi pengaturannya di panel kanan.
5. Daftar **Pemeriksaan** di kanan memberi tahu apa yang masih kurang. Tombol Jalankan aktif setelah daftar itu kosong.
6. Tekan **Jalankan**, isi rentang tanggal, periksa pratinjau, lalu setujui.
7. Pantau jalannya di halaman run. Klik tiap kotak untuk melihat laporan atau mengunduh file.

Tombol **Panduan** di editor menjelaskan fungsi tiap node dan memberi contoh alur.

### Contoh alur

| Tujuan | Susunan node |
|---|---|
| Audit sederhana | Trigger → Sales → Proses AW (+ Prompt) |
| Periode panjang jadi satu file | Trigger → Sales → Chunk → Proses AW → Export |
| Satu laporan utuh dari periode panjang | Trigger → Sales → Chunk → Proses AW → Merge AI → Export |
| Rekap ke spreadsheet | Trigger → Sales → Chunk → Proses AW → Tulis Sheets |
| Laporan dikirim ke grup WhatsApp | Trigger → Sales → Proses AW → Export → Kirim GOWA |
| Ambil hasil Continuous Audit | Trigger → Hasil Continuous → Export |

## Daftar node

| Kelompok | Node | Fungsi |
|---|---|---|
| Mulai & sumber | Trigger Manual | Memulai run; rentang tanggal diisi saat menekan Jalankan. |
| | Sales | Satu atau banyak sales WhatsApp sebagai sumber chat. |
| | Prompt | Instruksi audit: saved prompt AutoAudit atau teks sendiri. |
| | Memory | Memory AutoAudit yang ikut dibaca saat audit. |
| Ambil hasil yang ada | History AW | Mengambil laporan AW yang sudah pernah jalan. |
| | Hasil Continuous | Mengambil laporan dari jadwal Continuous Audit. |
| Proses | Sync Sales | Menyegarkan data chat sebelum audit. |
| | Chunk | Memecah per tanggal atau per kontak. |
| | Proses AW | Menjalankan Audital Work. Memakai token AI. |
| | Merge AI | Menggabungkan laporan lewat OpenRouter. |
| | Merge AutoAudit | Menggabungkan laporan lewat AutoAudit. Memakai kredit company. |
| | Parse Tabel | Mengambil tabel dari laporan menjadi baris data. |
| Hasil | Penampil | Membaca laporan di layar. |
| | Export | Excel, PDF, atau teks. Lebih dari satu file otomatis jadi zip. |
| | Tulis Sheets | Menulis baris ke Google Sheets. |
| | Kirim GOWA | Mengirim teks atau file ke WhatsApp. |
| | HTTP Request | Mengirim hasil sebagai JSON ke sistem lain. |

## Hal yang perlu diketahui

- **Proses AW dan Merge memakai token atau kredit sungguhan.** Pratinjau sebelum run tidak memakai token.
- **Run gagal bisa dilanjutkan.** Tombol "Lanjutkan dari yang gagal" hanya mengulang bagian yang gagal, selama prompt dan filter tidak diubah.
- **Batas AW bersamaan** bawaannya 5; ubah lewat `AW_CONCURRENCY` di `.env`.

## Keamanan

File dan folder berikut berisi rahasia dan **tidak ikut ke git**: `.env`, `.secrets/`, `.data/`. Jangan pernah menaruh API key, password, atau kunci Google di file lain, dan jangan membagikannya lewat chat.

## Masalah yang sering muncul

| Gejala | Penyebab dan jalan keluar |
|---|---|
| "Email atau password salah" | Nilai di `.env` berubah tetapi server belum dijalankan ulang, atau ada baris `ADMIN_...` ganda di `.env`. |
| Server berhenti dengan galat database | `npm run db` belum jalan atau tab-nya tertutup. Jalankan lagi, lalu `npm run server`. |
| Dropdown sales atau prompt kosong | Company belum dipilih, atau `AUTOAUDIT_API_KEY` salah. |
| Tombol Jalankan tidak aktif | Lihat daftar Pemeriksaan di panel kanan. |
| Tulis Sheets gagal dengan pesan izin | Spreadsheet belum dibagikan ke email service account sebagai Editor. |
| `node: bad option` atau galat sintaks saat start | Versi Node di bawah 24. |

## Untuk pengembang

```bash
npm test
```

```bash
npm run test:engine
```

```bash
npm run build
```

- `npm test`: uji logika murni, tanpa database.
- `npm run test:engine`: uji mesin ujung ke ujung terhadap AutoAudit tiruan; butuh `npm run db`.
- `npm run build`: membangun tampilan web ke `apps/web/dist`; server menyajikannya bila folder itu ada.
- `npm run contract`: uji hanya-baca terhadap AutoAudit nyata. `contract:run` dan `contract:merge` memakai token AI sungguhan.

| Folder | Isi |
|---|---|
| `packages/autoaudit` | Klien Integration API. GET diulang bila gagal, POST tidak pernah. |
| `packages/engine` | Perhitungan murni: pecah tanggal/kontak, usulan chunk, sidik jari, tabel. |
| `packages/nodes` | Katalog node dan aturan sambungan; dipakai kanvas dan server. |
| `apps/server` | Fastify + Postgres: login, perencana, mesin eksekusi, langkah-langkah keluaran. |
| `apps/web` | React + React Flow: editor dan tampilan run. |
| `scripts` | Database lokal, uji kontrak, uji mesin. |

Server ditulis dalam TypeScript dan dijalankan langsung oleh Node 24 tanpa proses build.
