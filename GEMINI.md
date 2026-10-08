# UI & Frontend Design Guidelines

## 1. Desain UI & Standar Visual (Wajib Rapi, Jelas, & Kontras)
- **Kontras Teks**: Semua teks, judul, tombol, ikon, dan label pada halaman (sidebar, toolbar, tabel, card, badge) HARUS memiliki kontras warna yang jelas terhadap latar belakangnya. Dilarang menggunakan warna teks yang samar, putih di atas latar terang, atau warna teks yang tidak kontras.
- **Hierarki & Struktur Komponen**:
  - Tombol aksi (misal: tombol hapus/trash) tidak boleh menutupi atau merusak ruang teks utama komponen lain.
  - Elemen flexbox yang menampung teks nama atau label harus selalu menetapkan `min-width: 0`, `overflow: hidden`, dan `text-overflow: ellipsis` jika berpotensi terpotong, tanpa menghilangkan tampilan ikon atau teksnya sama sekali.
  - State interaksi (`:hover`, `.selected`, `:focus`) harus memiliki indikator visual yang jelas (perbedaan warna latar belakang, border, atau warna teks yang tegas).
- **Integritas CSS**:
  - Jangan menimpa selector tombol global (`button`, `.report-list button`) dengan properti `width: 100%` atau `display: flex` tanpa mengecualikan tombol kecil seperti `.icon-button` di dalamnya.
  - Pastikan styling turunan tidak mewarisi properti yang menyebabkan elemen anak mengecil atau tidak terlihat (misal `color: inherit` yang jatuh ke warna transparan atau putih).

## 2. Diagram Canvas (React Flow)
- Garis relasi antar tabel harus bersih, rapi, dan tidak memuat label teks yang menutupi garis atau membingungkan pengguna, kecuali diminta secara eksplisit.
- Handle koneksi tabel harus proporsional dan tidak bertumpuk dengan scrollbar atau tepi kartu.

## 3. Kompilasi & Pengujian
- Setiap perubahan CSS atau UI frontend harus segera dibuild (`npm --prefix frontend run build`) dan diverifikasi kesesuaiannya agar tidak menyebabkan glitch visual, teks putih yang tidak terbaca, atau elemen bertumpukan.

## 4. Modal & Dialog Konfirmasi
- Dilarang menggunakan dialog bawaan browser (`window.confirm()`, `window.alert()`, `window.prompt()`).
- Semua konfirmasi aksi (seperti hapus laporan, hapus jadwal, hapus kredensial) HARUS menggunakan komponen modal custom Lumina (`modal-backdrop`, `modal-card`, header dengan ikon & tombol tutup, isi deskriptif, tombol Batal dan tombol aksi bertema `danger`/`primary`).

## 5. Workflow Git
- JANGAN melakukan auto commit atau push ke remote secara otomatis tanpa persetujuan eksplisit dari pengguna.

