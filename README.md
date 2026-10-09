# AutoAudit Workflow Builder

Aplikasi untuk merakit alur kerja (workflow) AutoAudit dengan cara **seret dan sambung**, mirip draw.io. Anda menyusun kotak-kotak (node) di kanvas, menyambungkannya dengan garis, lalu menekan **Jalankan**. Aplikasi yang mengurus sisanya: memecah periode, menjalankan Audital Work, menggabungkan laporan, dan mengirim hasilnya.

Aplikasi ini berbicara ke AutoAudit lewat **Integration API**, jadi Anda butuh API key AutoAudit untuk memakainya.

## Apa yang bisa dilakukan

- Menjalankan Audital Work (AW) untuk satu atau banyak sales sekaligus.
- Node Sales menyediakan pilihan **Sales ID** dan **WhatsApp Official** dari
  company yang sama. Keduanya dapat dipilih dalam satu node; ID disimpan
  bersama jenis sumber agar akun yang angkanya sama tidak tertukar.
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

### Menjalankan dengan Docker Compose

Isi `.env` berdasarkan `.env.example`, lalu jalankan:

```bash
docker compose up -d --build
```

Compose menjalankan web, server Node.js 24, dan PostgreSQL dalam container.
Port host ditetapkan secara eksplisit; jika sudah dipakai, container gagal mulai.

| Layanan | Alamat dari komputer | Alamat dari n8n |
|---|---|---|
| Web | http://127.0.0.1:5173 | — |
| Server/API | http://127.0.0.1:8787 | http://autoaudit-server:8787 |
| PostgreSQL | 127.0.0.1:54329 | autoaudit-postgres:5432 |

Konfigurasi ini memakai jaringan Docker eksternal `n8n_default` milik n8n
yang sudah berjalan. Pada mesin baru tanpa jaringan tersebut, buat dengan
`docker network create n8n_default` dan hubungkan container n8n ke jaringan itu.
Server juga dapat mengakses n8n di `http://n8n:5678`.

Database aplikasi bernama `aawb`, dengan user `aawb` dan password lokal
`aawb-local`. Compose mengganti `DATABASE_URL` untuk memakai hostname
`postgres` di jaringan container; nilai localhost di `.env` tetap dapat
dipakai oleh alat yang berjalan dari komputer.

Data database dan file/kunci aplikasi disimpan dalam volume Docker dan
tetap tersedia saat container dibuat ulang. Container otomatis mulai lagi
setelah Docker hidup. Untuk login, gunakan nilai admin dari `.env`.

```bash
docker compose ps
docker compose logs --tail=100
docker compose down
```

`docker compose down` menghentikan aplikasi tanpa menghapus volume data.
Jika shell lama belum mendapat grup Docker meskipun akun sudah menjadi
anggotanya, perintah dapat dijalankan melalui
`sg docker -c 'docker compose up -d --build'`.

### Akses publik dan PM2

Hostname yang disiapkan: `wokflowbuilder.dbautoaudit.stream` (sesuai nama yang diminta).
Cloudflare Tunnel `n8n-autoaudit` mengarahkan hostname ini ke `http://127.0.0.1:5173`.
HTTPS diterminasi oleh Cloudflare; login pada hostname publik memakai cookie Secure.
Semua endpoint workflow tetap memerlukan sesi login aplikasi.

PM2 menjalankan **workflow-builder**, pengawas Docker dari `ecosystem.config.cjs`.
Aplikasi, database, dan web tetap berjalan di Docker. Setiap 30 detik pengawas memastikan
container ada dan berjalan, memulai kembali container yang berhenti, serta merestart
service yang unhealthy. Tidak ada instance server Node tambahan di luar Docker.

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 status workflow-builder
pm2 logs workflow-builder
```

Daftar PM2 disimpan di `~/.pm2/dump.pm2`. Startup aktif memakai user service
`pm2-workflow-builder.service` dengan linger diaktifkan untuk `oem`, sehingga
tetap berjalan tanpa sesi login. Unit sistem lama `pm2-oem.service` mengalami
masalah file PID; pengawas baru memakai pemeriksaan koneksi PM2 dan tidak bergantung
pada file PID. Periksa dengan `systemctl --user status pm2-workflow-builder.service`.
Crontab pengguna juga memiliki fallback `@reboot` untuk `pm2 resurrect` tanpa
mengubah entri crontab yang sudah ada. Docker dan `cloudflared-n8n.service` enabled
untuk mulai saat boot. Host dan koneksi internet perlu tetap tersedia untuk akses publik.

### Menjalankan langsung tanpa Docker

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

Untuk mengganti email atau password, buka menu **Pengaturan** di halaman
Workflow. Masukkan password saat ini untuk menyimpan perubahan; password baru
minimal 8 karakter dan dapat dikosongkan jika hanya mengganti email.
Sesi di perangkat lain akan keluar setelah perubahan disimpan.
Kredensial terbaru tersimpan di database dan tetap berlaku setelah restart.
`ADMIN_EMAIL` dan `ADMIN_PASSWORD` di `.env` hanya membuat admin pertama ketika
tabel users masih kosong.

## Pengaturan tambahan (opsional)

### Sumber WhatsApp Official

Pada node **Sales**, pilih **Jenis sumber → WhatsApp Official**, lalu centang
akun company. Ganti kembali ke **Sales ID** untuk menambahkan sales; pilihan
sebelumnya tetap tersimpan. Akun Official memakai
`whatsapp_official_account_id` serta endpoint preflight/run khusus Official,
sedangkan Sales ID memakai `sales_id` dan endpoint sebelumnya.

Official membaca pesan teks private. Pada **Proses AW**, pilih **Hanya chat
private** dan **Hanya rentang tanggal terpilih**. Chunk per tanggal maupun
kontak tersedia; pembacaan kontak mengikuti cursor sampai selesai. Official
melewati **Sync Sales**, karena dataset akun dibaca langsung oleh API.
Jika company belum memiliki akun Official, daftar menampilkan keterangan kosong.

Kontrak API mengacu pada [dokumentasi WhatsApp Official di Postman](https://www.postman.com/accountexecutive-2720143/account-exec-autoaudit-s-workspace/http-example/bebgg5u/official-private-text-message-estimate).

### Google Sheets

1. Buat service account di Google Cloud dan unduh kuncinya (file JSON).
2. Aktifkan Google Sheets API. Di node **Tulis Sheets**, unggah file JSON pada bagian **Kredensial Google Workspace**. Login Google diperiksa sebelum kredensial disimpan terenkripsi di volume `server-data` (`.data/google.enc`).
3. Bagikan spreadsheet tujuan ke alamat email service account sebagai **Editor**.
4. Muat daftar tab, pilih tab dan mode append/upsert. Kredensial langsung aktif untuk seluruh workflow tanpa restart.

Alternatif pemasangan server: simpan JSON sebagai `.secrets/google.json`, lalu jalankan `npm run deploy`. Folder ini dipasang read-only ke container, tidak disalin ke image. Kredensial terenkripsi dari UI diprioritaskan. Pada server di luar Docker, lokasi alternatif dapat ditentukan melalui `GOOGLE_APPLICATION_CREDENTIALS`.

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

### Pengelolaan workflow dan penyimpanan

Workflow, graf node, pilihan Sales ID/WhatsApp Official, pengaturan concurrency/persetujuan,
status publish/arsip, akun pengguna, sesi, dan riwayat run disimpan di PostgreSQL Docker `aawb`.
Rahasia node disimpan terenkripsi di PostgreSQL. File hasil dan kunci enkripsi berada di
volume `server-data`; database berada di `postgres-data`. Keduanya tetap tersedia setelah
restart atau rebuild container. Integrasi dasar dari `.env` tetap dikonfigurasi lewat `.env`.

- **Publish** memeriksa kelengkapan workflow dan menandainya Published. Perubahan konfigurasi,
  nama, atau rahasia node mengembalikannya menjadi Draft; publish ulang setelah selesai mengedit.
- **Unpublish** mengembalikan workflow ke Draft. Run manual tetap tersedia untuk menguji Draft.
- **Arsipkan** menyimpan konfigurasi dan riwayat tanpa mengizinkan edit atau run baru.
  Batalkan run aktif/menunggu persetujuan terlebih dahulu. **Pulihkan** mengembalikannya ke Draft.
- **Hapus permanen** hanya tersedia pada Arsip. Ketik tepat `DELETE` di dialog. Server juga
  memverifikasi kata ini. Workflow, run, unit, langkah, rahasia node, dan direktori file hasil
  dihapus. Pembersihan file yang terputus dilanjutkan saat server hidup lagi.
- Daftar workflow menyediakan pencarian nama/company dan filter Aktif, Draft, Published, Arsip, Semua.

Untuk integrasi seperti n8n, kirim `mode: "published"` pada
`POST /api/workflows/:id/runs` bersama `start_date` dan `end_date` menggunakan sesi login
aplikasi. Mode ini menolak Draft/Arsip. Tanpa `mode`, endpoint memakai mode manual.
Publish tidak membuat jadwal otomatis; n8n dapat menentukan jadwal pemanggilannya.
Unpublish tidak membatalkan run yang sudah dibuat.

Contoh backup database (simpan backup di lokasi terlindungi):

```bash
docker compose exec -T postgres pg_dump -U aawb -d aawb > aawb-backup.sql
```

Backup juga volume `server-data` agar file hasil dan kunci enkripsi dapat dipulihkan bersama
backup database. Menghapus volume melalui `docker compose down -v` menghapus data persisten.

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
| Mulai & sumber | Start / Trigger | Manual (default), jadwal WIB, atau webhook dengan token. |
| Proses | Code | Python/JavaScript untuk filter dan transformasi JSON tanpa LLM. |
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

### HTTP hasil ke Autobot

Node HTTP baru menggunakan tujuan Autobot. Masukkan Workflow ID dan kunci integrasi
Autobot; endpoint HTTPS `/integration/v1/workflows/ID/builder-results` dibentuk otomatis.
Kunci Autobot disimpan melalui `node_secrets` terenkripsi dan dimuat hanya saat eksekusi.
Isi Company ID sumber pada workflow Autobot agar payload builder lolos pemeriksaan company.
Pilihan Endpoint khusus mempertahankan URL, metode, dan header. Node lama yang sudah
mempunyai URL tetap menggunakan endpoint lamanya. Parameter URL `autobot_workflow_id`
dari iframe Autobot hanya mengisi node HTTP baru; tidak mengubah graf yang sudah disimpan.
Uji kontrak tanpa pengiriman jaringan: `node --test apps/server/src/http-autobot.test.ts`.


### Periode dan jadwal analisis AW

Pada node **Proses AW**, gunakan **Periode & jadwal analisis** untuk memilih tanggal
khusus atau periode relatif terhadap tanggal run dalam WIB. “H-7” adalah satu hari
tepat tujuh hari sebelumnya; “Beberapa hari terakhir” dengan jumlah 7 dan berakhir
H-1 membaca tujuh hari penuh sampai kemarin. “Bulan berjalan” membaca tanggal 1
sampai hari run; untuk laporan bulan lengkap setiap tanggal 1 pilih “Bulan lalu,
lengkap”. Tanggal saat Run hanya berlaku pada AW yang memilih “Ikuti tanggal saat Run”.

Preset tersedia untuk harian H-1, setiap 2 hari (dua hari sebelumnya), Senin
(minggu Senin–Minggu sebelumnya), tanggal 1 (bulan sebelumnya), akhir bulan,
serta tanggal 1 & 16. Preset terakhir membaca tanggal 16–akhir bulan lalu pada
tanggal 1 dan tanggal 1–15 bulan ini pada tanggal 16. Hari terakhir mengikuti
28/29/30/31; pilihan tanggal bulanan yang tidak ada pada suatu bulan dilewati.
Panel menampilkan tiga jadwal berikutnya beserta periode analisisnya.

Aktifkan **Jalankan otomatis** pada satu AW per workflow lalu **Publish**. Jadwal
menjalankan seluruh workflow, sementara tiap AW menggunakan periodenya sendiri.
AW lain yang mengikuti tanggal Run membaca tanggal eksekusi jadwal. Jam jadwal
adalah waktu **mulai analisis**, bukan jaminan waktu hasil diterima. Sambungkan
node Kirim Pesan atau HTTP Request untuk mengirim hasil setelah selesai. Pengaturan
**Konfirmasi sebelum jalan** tetap berlaku; matikan bila ingin setiap run otomatis
berjalan tanpa persetujuan manual. Chunk pada run otomatis memakai ukuran tersimpan
atau rekomendasi sistem.

Server memeriksa jadwal setiap 30 detik dalam WIB. Draft/arsip menghentikan pemicu
baru. Setiap kejadian tersimpan dengan kunci unik di PostgreSQL agar restart atau
lebih dari satu server tidak membuat run ganda. Tanggal acuan disimpan pada run
agar periode tetap sama saat rencana dihitung ulang. Saat server kembali hidup,
jadwal hari ini yang sudah jatuh tempo dapat berjalan; tanggal sebelumnya tidak
diputar ulang. Publish setelah jam jadwal tidak mengulang kejadian yang terlewat.

Validasi: `node --experimental-strip-types --test packages/*/src/*.test.ts apps/server/src/*.test.ts`,
`npm run build`, dan `node --experimental-strip-types scripts/calendar-scheduler.integration.ts`
(terakhir memakai PostgreSQL sementara terisolasi pada port 55439 dan tidak mengirim audit/pesan).


### Deploy perubahan

Jalankan `npm run deploy` setelah perubahan terverifikasi. Script mengunci deploy,
menghentikan sementara pengawas `workflow-builder` agar tidak berbenturan dengan
Docker Compose saat rebuild, memperbarui server dan web, memeriksa health API,
lalu mengaktifkan dan menyimpan PM2 kembali. Volume data tetap dipertahankan.
HTML menggunakan `Cache-Control: no-store` agar reload mengambil versi terkini;
asset dengan nama hash memakai cache immutable. Tab yang sudah terbuka sebelum
deploy perlu di-refresh sekali agar memuat aplikasi baru.


## Start otomatis dan webhook

Klik **Start / Trigger → Mulai workflow melalui**. Manual tetap menjadi default.
Jadwal mendukung harian, interval hari, hari tertentu setiap minggu, tanggal tertentu
setiap bulan, akhir bulan, serta tanggal 1 dan 16. Pilih jam WIB dan tanggal mulai;
pratinjau menunjukkan jadwal berikutnya. Publish workflow untuk mengaktifkannya.
Saat Start otomatis aktif, nonaktifkan jadwal di Proses AW. AW tetap memakai periode
analisisnya sendiri; pilihan “Ikuti tanggal saat Run” memakai periode dari Start.
Konfirmasi sebelum jalan tetap berlaku; matikan pilihan ini untuk eksekusi penuh otomatis.

Webhook menerima POST pada `/integration/v1/workflows/WORKFLOW_ID/webhook`
dengan `Authorization: Bearer TOKEN`. Buat dan salin token di panel Start;
token disimpan terenkripsi. JSON body opsional:

```json
{"request_id":"event-123","start_date":"2026-10-01","end_date":"2026-10-03","items":[{"id":1,"amount":100}]}
```

Tanpa tanggal, periode Start digunakan. Kedua tanggal harus diberikan bersama.
`request_id` yang sama pada workflow yang sama mengembalikan run sebelumnya.
`items` atau `data` menjadi masukan Code yang tersambung dari Start.

## Node Code tanpa LLM

Tambahkan **Code** dari palet Proses. Pilih Python atau JavaScript, beri nama node,
dan tulis kode pada editor. Mode **semua item** memanggil kode sekali untuk seluruh
input; mode **per item** memanggilnya sekali per item. Contoh siap pakai tersedia
untuk filtering, mapping, deduplikasi, pemecahan array, agregasi, dan chat pribadi.
Beberapa Code dapat dirangkai, misalnya **Start → Code filter → Code rekap → Export**.
Alur ini tidak perlu Proses AW, prompt, model, atau panggilan LLM.

Input dari Code sebelumnya atau respons HTTP memakai item JSON langsung. Laporan
AW/history menjadi item berisi `label`, `source`, `content`, dan `period`; Parse
Tabel menjadi objek per baris. Jika hanya tersambung dari Start, input berasal dari
JSON di panel (bisa dibaca dari file `.json`) atau payload webhook. Uji kode memakai
input panel tanpa menjalankan node lain. Output tersimpan di riwayat run dan dapat
diteruskan sebagai JSON ke Code/HTTP atau sebagai tabel/teks ke node hasil.

JavaScript:

```javascript
return $input.all().filter(item => item.json.status === 'active');
```

Python:

```python
return [item for item in _input.all() if item['json'].get('status') == 'active']
```

Gunakan `return` untuk mengembalikan objek atau daftar item `{json: {...}}`.
Dalam mode per item, JavaScript menyediakan `$json` dan `$itemIndex`; Python
menyediakan `_json` dan `_itemIndex`. `params` memuat periode run, tanggal acuan,
company ID, dan nama workflow. `console.log()`/`print()` tersimpan sebagai log.

Eksekusi sinkron dibatasi 1–30 detik, input/output 2 MB, dan 10.000 item. JavaScript
berjalan di QuickJS/WASM; Python dibatasi proses dengan seccomp dan batas memori/CPU.
Kode tidak mendapat akses filesystem, jaringan, environment aplikasi, atau paket
pihak ketiga. Python mendukung modul yang dimuat runtime seperti `json`, `re`,
`math`, `datetime`, `statistics`, `collections`, `itertools`, `csv`, dan `decimal`.
Image deployment sudah menyertakan Python dan libseccomp; untuk server lokal Linux,
pasang `python3` dan `libseccomp2` sebelum memakai bahasa Python.

Uji: `node --test apps/server/src/code.test.ts` dan
`node scripts/code-node.integration.ts` (PostgreSQL fixture terpisah, tanpa layanan eksternal).
