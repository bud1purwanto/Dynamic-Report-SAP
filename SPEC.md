# LUMINA: Enterprise Smart SQVI Web

## Tujuan dan arsitektur

Lumina adalah aplikasi web pengganti SAP SQVI untuk menyusun laporan visual, menampilkan grid dinamis, membandingkan data antarserver SAP, dan mengotomatisasi laporan. [SPEC_OIDC_MCP_SAP_AGENT.md](./SPEC_OIDC_MCP_SAP_AGENT.md) adalah bagian dari spesifikasi ini dan menjadi acuan autentikasi serta akses SAP.

```text
Browser (React) --cookie sesi HttpOnly--> Backend Lumina (FastAPI)
                                             ├── OIDC pusat: login, refresh, katalog, vault
                                             ├── MCP SAP Gateway: semua operasi SAP
                                             └── PostgreSQL: definisi laporan, variant, riwayat
```

- Backend Lumina tidak memakai PyRFC/JCo dan tidak membuka koneksi RFC langsung ke SAP. Backend menangani sesi, validasi, orkestrasi permintaan, pengolahan data, dan penyimpanan data aplikasi.
- Setiap operasi SAP menggunakan token OIDC pengguna aktif ketika backend memanggil MCP Gateway. Kredensial SAP pribadi hanya berada di vault OIDC, bukan di database Lumina atau browser.
- `DASHBOARD_MCP_API_TOKEN` hanya untuk membaca katalog resource. Token layanan ini tidak digunakan untuk eksekusi SAP atas nama pengguna.
- Fungsi ABAP khusus, bila diperlukan, harus disediakan sebagai tool di MCP Gateway dan dijalankan dengan otorisasi OIDC pengguna.

## Teknologi

- Frontend: React, React Flow, AG Grid atau TanStack Table, Zustand, Tailwind CSS.
- Backend: FastAPI, Pandas, HTTP client untuk OIDC dan MCP Gateway.
- Database: PostgreSQL, SQLAlchemy, driver `psycopg`; schema aplikasi ditentukan oleh `DATABASE_SCHEMA` di `.env`.
- Pekerjaan latar: Celery atau APScheduler; Redis jika diperlukan untuk sesi, cache, atau antrean.

## Fitur utama

1. **Visual Query Canvas:** Setelah tabel dipilih, semua field dari metadata SAP tampil pada canvas. Pengguna dapat menggeser tabel dan canvas; relasi key yang cocok diusulkan otomatis serta dapat ditinjau dan diubah. Sesudah join, pengguna memilih kolom output dan field parameter filter secara terpisah, seperti alur SQVI.
2. **Grid dinamis:** Preview data, pengaturan kolom, filter bertingkat, dan formula kolom yang divalidasi backend.
3. **Variant Manager:** Menyimpan layout, kolom aktif, urutan, filter, dan parameter laporan per pengguna.
4. **Cross-Server Data Compare:** Membaca dua target SAP dengan token OIDC pengguna, lalu membandingkan baris berdasarkan key yang ditentukan.
5. **Ekspor dan masking:** Menghasilkan `.xlsx`, menangani duplikat sesuai aturan laporan, dan menyamarkan data sensitif berdasarkan kebijakan akses.
6. **AI dan otomasi:** Natural language to query menghasilkan draf yang divalidasi sebelum eksekusi; scheduler menyimpan hasil Excel yang dapat diunduh pemilik laporan melalui aplikasi.
7. **Validasi query:** Backend memeriksa tabel, field, join, filter, batas baris, dan akses target sebelum memanggil gateway. Validasi yang memerlukan SAP dilakukan melalui gateway.
8. **Smart Data Pivoting:** Meratakan data vertikal menjadi satu baris per key. Endpoint menerima `index`, `columns`, dan `values`; backend memakai `pandas.DataFrame.pivot()` atau `pivot_table()` dan mengembalikan kolom serta baris dinamis. Nilai ganda untuk key yang sama membutuhkan aturan agregasi eksplisit.

## Aturan implementasi

### Akses SAP dan keamanan

- Login, refresh token, vault kredensial, katalog target, dan kontrak MCP mengikuti [spesifikasi OIDC dan MCP](./SPEC_OIDC_MCP_SAP_AGENT.md).
- Browser tidak boleh memilih nama tool MCP dan argumen secara bebas. Backend menyediakan operasi laporan terbatas, memvalidasi input, dan meneruskan hanya tool gateway yang diizinkan.
- Operasi tulis SAP, jika kelak diperlukan, memakai otorisasi tersendiri. Commit atau rollback harus atomik dalam sesi RFC yang sama dan ditangani oleh gateway.

### Backend dan database

- Backend mengelola definisi laporan, variant, riwayat, pivot, formula, diff, masking, dan ekspor.
- Terapkan batas baris, timeout, pagination, serta batas ukuran respons di sekitar panggilan gateway.
- Semua tabel aplikasi ditempatkan dalam schema PostgreSQL dari `DATABASE_SCHEMA`. Jangan menulis nama schema tetap dalam model, migrasi, atau SQL.
- `DATABASE_URL` dan `DATABASE_SCHEMA` dibaca dari `.env` melalui satu modul konfigurasi. Migrasi dan runtime menggunakan nilai yang sama.

### Frontend

- Tombol **Pivot Data** memilih key (`index`), nama kolom baru (`columns`), nilai (`values`), dan agregasi bila diperlukan.
- Grid merender kolom hasil pivot secara dinamis tanpa menghapus pengaturan kolom standar yang disimpan pada variant.
- Browser hanya menyimpan cookie sesi HttpOnly; token OIDC dan password SAP tidak masuk Web Storage.

## Variabel lingkungan

Nilai runtime berada di `.env`; `.env.example` mendokumentasikan nama variabel tanpa kredensial aktif.

```env
DATABASE_URL=postgresql+psycopg://<user>:<password>@<host>:5432/<database>
DATABASE_SCHEMA=dynamic_report
DASHBOARD_OIDC_ISSUER=http://<oidc-host>:4000
DASHBOARD_MCP_API_TOKEN=<catalog-read-token>
DASHBOARD_MCP_GATEWAY_URL=http://<gateway-host>:4000/v1/gateway
SESSION_SECRET=<random-secret-at-least-32-characters>
SESSION_EXPIRE_HOURS=24
SESSION_COOKIE_NAME=sap_session
```

## Struktur proyek yang direncanakan

```text
frontend/src/features/{canvas,grid,compare,chat}/
backend/app/api/       # API BFF
backend/app/core/      # Konfigurasi, sesi, keamanan, koneksi DB
backend/app/models/    # Model pada DATABASE_SCHEMA
backend/app/schemas/   # Validasi request dan response
backend/app/services/  # Klien OIDC/MCP dan pengolahan data
backend/app/tasks/     # Scheduler
database/              # Migrasi schema aplikasi
```
