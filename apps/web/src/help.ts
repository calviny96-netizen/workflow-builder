import type { NodeType, PortType } from '@nodes';

export interface NodeHelp {
  tagline: string; // satu kalimat, dipakai di kartu ringkas palet
  when: string;
  settings: string[];
  tips: string[];
  example: NodeType[][]; // tiap baris satu rangkaian node, digambar sebagai diagram kecil
}

export const NODE_HELP = {
  trigger: {
    tagline: 'Titik mulai workflow. Menanyakan rentang tanggal saat Run ditekan.',
    when: 'Selalu ada, tepat satu per workflow. Rentang tanggal yang diisi saat Run berlaku untuk semua Proses AW.',
    settings: ['Tidak ada pengaturan. Tanggal mulai dan selesai diisi setiap kali menjalankan.'],
    tips: ['Sambungkan ke node Sales supaya alur terbaca dari kiri ke kanan.'],
    example: [['trigger','sales','aw']],
  },
  sales: {
    tagline: 'Sumber chat: satu atau banyak sales WhatsApp dari company terpilih.',
    when: 'Dipakai untuk menentukan chat siapa yang diaudit. Satu node boleh berisi banyak sales; tiap sales menjadi Audital Work sendiri.',
    settings: ['Centang sales dari daftar. Daftar baru muncul setelah company dipilih di bilah atas.', 'Kotak cari menyaring berdasarkan nama atau nomor.'],
    tips: ['Dua node Sales boleh disambung ke satu Proses AW; semuanya berjalan bersamaan dengan prompt yang sama.', 'Sales berstatus disconnected tetap bisa diaudit selama datanya pernah tersinkron.'],
    example: [['sales','aw']],
  },
  prompt: {
    tagline: 'Instruksi untuk AI: saved prompt dari AutoAudit atau teks bebas.',
    when: 'Wajib untuk setiap Proses AW. Satu Prompt bisa dipakai banyak Proses AW.',
    settings: ['Saved prompt: dipilih dari daftar prompt company.', 'Teks bebas: ditulis langsung di panel.'],
    tips: [
      'Kalau hasil akan ditulis ke Excel atau Sheets, minta AI memakai judul kolom yang persis sama di setiap jawaban.',
      'Isi saved prompt dibaca saat run dimulai. Kalau isinya diubah di AutoAudit setelah itu, tombol Lanjutkan pada run yang gagal akan ditolak.',
    ],
    example: [['prompt','aw']],
  },
  memory: {
    tagline: 'Pengetahuan tambahan dari company memory yang ikut dibaca AI.',
    when: 'Opsional. Dipakai bila audit perlu data pembanding, misalnya daftar harga atau riwayat order.',
    settings: ['Centang satu atau beberapa memory.'],
    tips: ['Memory menambah token di setiap Audital Work. Jumlah tokennya terlihat di daftar.'],
    example: [['memory','aw']],
  },
  chunk: {
    tagline: 'Memecah satu sumber menjadi banyak Audital Work supaya AI tidak kepenuhan.',
    when: 'Dipakai bila periode panjang atau kontaknya banyak. Tanpa Chunk, satu sales = satu Audital Work untuk seluruh periode.',
    settings: [
      'Per rentang tanggal: angka adalah panjang tiap bagian. 1–30 dengan 5 hari menjadi 6 Audital Work.',
      'Per jumlah kontak: daftar kontak dibagi rata, mulai dari yang pesannya paling banyak.',
      'Angka dikosongkan = pakai usulan sistem dari hasil preflight.',
    ],
    tips: ['Angka dan mode masih bisa diubah di layar rencana sebelum run disetujui, lalu dihitung ulang.', 'Bagian yang tidak punya chat dilewati, tidak dianggap gagal.'],
    example: [['sales','chunk','aw']],
  },
  aw: {
    tagline: 'Menjalankan Audital Work. Satu run untuk tiap sumber atau potongan yang masuk.',
    when: 'Inti workflow. Di tampilan run, ketupat ini mekar menjadi satu ketupat per Audital Work.',
    settings: [
      'Jalankan di Company: riwayat tersimpan di company dan memotong saldo kredit company.',
      'Jalankan di Superadmin: riwayat di sisi superadmin, saldo company tidak dipotong.',
      'Model, jenis chat (private / grup), jendela jam, dan batas waktu per Audital Work.',
      'Kontak yang dianalisis: semua, hanya nomor tertentu, atau semua kecuali nomor tertentu. Nomor cukup ditempel satu per baris (08…, +62…, atau 62…).',
    ],
    tips: [
      'Letak titik di ketupat: kiri = sumber, atas = prompt, bawah = memory, kanan = laporan.',
      'Jumlah yang berjalan bersamaan dibatasi (default 5) dan bisa diatur di bilah atas.',
      'Bila satu Audital Work gagal, run berhenti: yang sedang jalan dibiarkan selesai, sisanya menunggu. Lanjutkan hanya mengulang yang gagal.',
    ],
    example: [['sales','aw','export'],['prompt','aw']],
  },
  viewer: {
    tagline: 'Penanda bahwa laporan cukup dibaca di aplikasi.',
    when: 'Opsional. Laporan tiap Audital Work selalu bisa dibuka dari tampilan run, dengan atau tanpa node ini.',
    settings: ['Tidak ada pengaturan.'],
    tips: ['Di tampilan run, klik sebuah ketupat untuk membaca laporannya, menyalin teks, atau mengunduh .md / .txt.'],
    example: [['aw','viewer']],
  },
  parse: {
    tagline: 'Mengubah tabel di laporan menjadi baris data.',
    when: 'Dipakai bila ingin melihat pratinjau tabel gabungan, atau memilih hanya tabel pertama sebelum diekspor.',
    settings: ['Semua tabel atau hanya tabel pertama dari tiap laporan.', 'Kolom Sumber dan Bagian bisa ditambahkan untuk menandai asal tiap baris.'],
    tips: ['Tabel digabung hanya bila judul kolomnya sama. Judul kolom yang berbeda menghasilkan tabel terpisah.', 'Export Excel dan Tulis Sheets juga bisa membaca tabel langsung dari Proses AW tanpa node ini.'],
    example: [['aw','parse','export']],
  },
  export: {
    tagline: 'Membuat file hasil: Excel, PDF, atau teks.',
    when: 'Dipakai bila hasil perlu diunduh atau dikirim sebagai file.',
    settings: [
      'Excel: dari tabel di laporan; tiap tabel menjadi satu sheet.',
      'PDF: dirender oleh AutoAudit.',
      'Teks (.md / .txt): isi laporan apa adanya.',
      'Satu file per laporan (bawaan) atau digabung. Bila lebih dari satu file, hasilnya satu .zip.',
      'Pola nama file bisa diatur, bawaannya {{sales}}-{{periode}}-{{judul}}.',
    ],
    tips: ['PDF dan teks harus disambung langsung dari Proses AW. Excel boleh dari Proses AW atau Parse Tabel.', 'File diunduh dari tampilan run: klik node Export setelah selesai.'],
    example: [['aw','export','message']],
  },
  sheets: {
    tagline: 'Menulis baris tabel ke sebuah tab Google Sheets.',
    when: 'Dipakai bila hasil audit dikumpulkan di spreadsheet yang sama dari run ke run.',
    settings: [
      'Tambah semua baris: selalu menambah di bawah.',
      'Tambah yang belum ada: baris yang kuncinya sudah ada di sheet dilewati.',
      'Perbarui dan tambah: baris yang kuncinya cocok diperbarui di tempat, sisanya ditambahkan.',
      'Kolom kunci boleh gabungan, dipisah koma, mis. Nomor WA, Sales.',
    ],
    tips: [
      'Spreadsheet harus dibagikan sebagai Editor ke email service account yang tampil di panel.',
      'Kolom dicocokkan lewat nama header sheet. Kolom tabel yang tidak ada di header tidak ditulis. Tab kosong diberi header otomatis.',
    ],
    example: [['aw','sheets']],
  },
} as Record<NodeType, NodeHelp>;

Object.assign(NODE_HELP, {
  history: {
    tagline: 'Mengambil laporan Audital Work yang sudah pernah dijalankan, tanpa menjalankan ulang.',
    when: 'Dipakai bila hasilnya sudah ada di AutoAudit (dijalankan dari chatbot atau workflow lain) dan hanya perlu diolah: digabung, diekspor, atau ditulis ke Sheets.',
    settings: [
      'Cari dan centang history dari daftar, atau tempel banyak id / tautan history sekaligus.',
      'Sisi Company atau Superadmin: history hanya terlihat di sisi tempat ia dijalankan.',
    ],
    tips: ['Tidak memakai token AI.', 'Bila sebuah history tidak ditemukan, biasanya karena sisi Company/Superadmin-nya tertukar.'],
    example: [['history','export']],
  },
  continuous: {
    tagline: 'Mengambil laporan hasil sebuah jadwal Continuous Audit, tanpa memicu audit.',
    when: 'Dipakai bila audit rutin sudah dijalankan oleh Continuous Audit dan hasilnya perlu diteruskan ke Sheets, file, atau pesan.',
    settings: [
      'Pilih jadwal Continuous Audit dari daftar company.',
      'Run terakhir yang selesai: satu laporan per sales dari run paling baru.',
      'Semua run pada rentang tanggal: memakai tanggal yang diisi saat Run.',
    ],
    tips: ['Tidak memakai token AI dan tidak menjalankan jadwalnya.', 'Sales yang auditnya gagal pada run itu tidak punya laporan; ia muncul sebagai peringatan di layar rencana.'],
    example: [['continuous','sheets']],
  },
  aimerge: {
    tagline: 'Menggabungkan banyak laporan menjadi satu dengan model AI pilihan lewat OpenRouter.',
    when: 'Dipakai setelah Chunk atau banyak sales, bila yang dibutuhkan satu laporan utuh. Tidak bergantung pada fitur merge AutoAudit.',
    settings: [
      'API key OpenRouter: diisi di node ini, lalu disimpan terenkripsi di server. Yang tampil setelahnya hanya empat karakter terakhir.',
      'Model: dipilih dari daftar model OpenRouter.',
      'Instruksi merge dan judul laporan gabungan.',
    ],
    tips: [
      'Biayanya ditagih ke akun OpenRouter pemilik key, bukan ke kredit AutoAudit.',
      'Bila laporan terlalu banyak untuk sekali kirim, penggabungan dilakukan bertingkat otomatis mengikuti kapasitas model.',
      'Hasilnya bisa disambung ke Export, Tulis Sheets, Kirim GOWA, dan lainnya. Hasil ini tidak tersimpan di AutoAudit.',
      'Bila gagal (key ditolak, saldo habis, jawaban terpotong), Lanjutkan hanya mengulang merge; Audital Work tidak dijalankan ulang.',
    ],
    example: [['aw', 'aimerge', 'export']],
  },
  merge: {
    tagline: 'Menggabungkan banyak laporan menjadi satu lewat fitur Merge Reports AutoAudit.',
    when: 'Dipakai setelah Chunk atau banyak sales, bila yang dibutuhkan satu laporan utuh, bukan banyak laporan terpisah.',
    settings: [
      'Instruksi merge: apa yang harus dilakukan AI saat menggabungkan (satukan temuan, pertahankan tabel, dan seterusnya).',
      'Judul laporan gabungan dan model (kosong = model bawaan company).',
    ],
    tips: [
      'Sekali merge maksimal 10 laporan. Lebih dari itu digabung bertingkat secara otomatis: per kelompok dulu, lalu hasilnya digabung lagi.',
      'Memakai token AI dan kredit company. Hasilnya juga tersimpan di menu Merge Reports AutoAudit.',
      'Bila merge gagal, Lanjutkan hanya mengulang merge yang gagal; Audital Work tidak dijalankan ulang.',
      'Butuh endpoint merge AI di server AutoAudit. Panel node memberi tahu bila endpoint itu belum aktif.',
    ],
    example: [['aw', 'merge', 'export']],
  },
  sync: {
    tagline: 'Menyegarkan data chat sales sebelum diaudit, lalu menunggu sampai selesai.',
    when: 'Dipakai bila audit harus memakai chat terbaru, misalnya rekap harian. Semua Proses AW di workflow menunggu sampai sync selesai.',
    settings: [
      'Kapan sync: hanya bila data lebih tua dari N menit (default 30), selalu, atau tidak pernah.',
      'Mode: prioritas maksimum (didahulukan di antrean), biasa, atau no-skip.',
      'Batas waktu, dan apa yang terjadi bila terlewati: berhenti, atau lanjut dengan data yang ada.',
    ],
    tips: ['Letakkan di antara Sales dan Chunk / Proses AW.', 'Estimasi di layar rencana dihitung sebelum sync, jadi angka sebenarnya bisa sedikit lebih besar.', 'Bila sync satu sales gagal, run berhenti sebelum memakai token. Lanjutkan hanya mengulang sales yang gagal.'],
    example: [['sales','sync','chunk','aw']],
  },
  message: {
    tagline: 'Mengirim ringkasan, isi laporan, atau file hasil ke WhatsApp lewat GOWA.',
    when: 'Dipakai untuk memberi tahu grup atau orang begitu hasil siap.',
    settings: [
      'Bentuk kiriman: teks saja, atau file dengan keterangan (keterangan boleh kosong).',
      'Dikirim ke: grup (nama grup persis seperti di WhatsApp, atau id …@g.us) atau nomor perorangan (08… / 628…).',
      'Teks boleh memakai {{workflow}}, {{company}}, {{periode}}, {{jumlah_aw}}, {{jumlah_baris}}.',
      'Sertakan isi laporan: tiap laporan dikirim sebagai pesan tersendiri.',
    ],
    tips: [
      'Mode file: sambungkan dari Export (Excel/PDF/zip), atau isi tautan file sendiri.',
      'File dari Export dikirim langsung ke GOWA; tautan file hanya dipakai bila file-nya ada di tempat lain.',
      'Kredensial GOWA diisi di .env; handler selalu Devina.',
    ],
    example: [['aw','export','message']],
  },
  http: {
    tagline: 'Mengirim hasil sebagai JSON ke sistem lain.',
    when: 'Dipakai untuk meneruskan hasil ke webhook n8n, aplikasi klien, atau layanan lain.',
    settings: ['URL tujuan dan metode (POST, PUT, PATCH).', 'Header tambahan, satu per baris: Nama: nilai.'],
    tips: ['Isi yang dikirim: nama workflow, parameter run, daftar laporan (label, sumber, isi), dan tabel bila disambung dari Parse Tabel.', 'Balasan selain 2xx membuat run berhenti dan bisa dilanjutkan.'],
    example: [['aw','http']],
  },
} satisfies Partial<Record<NodeType, NodeHelp>>);

export const PORT_HELP: Record<PortType, { label: string; color: string; text: string }> = {
  flow: { label: 'Alur', color: '#64748b', text: 'Urutan mulai, dari Trigger ke Sales.' },
  source: { label: 'Sumber', color: '#2563eb', text: 'Chat yang akan diaudit: dari Sales atau potongan dari Chunk.' },
  prompt: { label: 'Prompt', color: '#7c3aed', text: 'Instruksi untuk AI.' },
  memory: { label: 'Memory', color: '#0d9488', text: 'Pengetahuan tambahan.' },
  report: { label: 'Laporan', color: '#dc2626', text: 'Hasil tulisan AI dari tiap Audital Work.' },
  rows: { label: 'Baris', color: '#0369a1', text: 'Baris tabel hasil Parse Tabel.' },
  file: { label: 'File', color: '#15803d', text: 'File hasil export.' },
};

export const GROUPS: { title: string; hint: string; types: NodeType[] }[] = [
  { title: 'Mulai & sumber', hint: 'apa yang diaudit', types: ['trigger', 'sales', 'prompt', 'memory'] },
  { title: 'Ambil hasil yang ada', hint: 'tanpa menjalankan audit', types: ['history', 'continuous'] },
  { title: 'Proses', hint: 'yang dikerjakan', types: ['sync', 'chunk', 'aw', 'aimerge', 'merge', 'parse'] },
  { title: 'Hasil', hint: 'ke mana keluarnya', types: ['viewer', 'export', 'sheets', 'message', 'http'] },
];

export const RECIPES: { title: string; flow: NodeType[]; side?: NodeType[]; note: string }[] = [
  { title: 'Audit sederhana', flow: ['trigger', 'sales', 'aw'], side: ['prompt'], note: 'Satu Audital Work per sales untuk seluruh periode. Prompt disambung ke titik atas Proses AW.' },
  { title: 'Periode panjang', flow: ['trigger', 'sales', 'chunk', 'aw', 'export'], side: ['prompt'], note: 'Periode dipecah, tabel dari semua bagian digabung ke satu file.' },
  { title: 'Satu laporan utuh dari periode panjang', flow: ['trigger', 'sales', 'chunk', 'aw', 'aimerge', 'export'], side: ['prompt'], note: 'Tiap bagian diaudit sendiri, lalu semua laporannya digabung AI menjadi satu.' },
  { title: 'Rekap rutin ke spreadsheet', flow: ['trigger', 'sales', 'chunk', 'aw', 'sheets'], side: ['prompt'], note: 'Pakai mode "perbarui dan tambah" dengan kolom kunci supaya tidak dobel.' },
  { title: 'Laporan untuk dibagikan', flow: ['trigger', 'sales', 'aw', 'export', 'message'], side: ['prompt'], note: 'Semua laporan jadi satu PDF yang dikirim ke grup WhatsApp.' },
  { title: 'Rekap harian dengan data terbaru', flow: ['trigger', 'sales', 'sync', 'aw', 'sheets'], side: ['prompt'], note: 'Chat disegarkan dulu, baru diaudit.' },
  { title: 'Teruskan hasil Continuous Audit', flow: ['trigger', 'continuous', 'sheets'], note: 'Tanpa Sales, Prompt, atau Proses AW; hanya mengambil laporan yang sudah dibuat jadwal.' },
];
