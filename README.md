# Lumina Dynamic Report

Aplikasi laporan SAP berbasis React dan FastAPI. Browser hanya menerima cookie sesi HttpOnly. FastAPI memakai token OIDC pengguna untuk akses vault dan semua panggilan SAP melalui MCP Gateway. Backend tidak membuka koneksi RFC atau memakai PyRFC.

## Menjalankan

1. Isi `.env` dari `.env.example`. `DATABASE_URL`, `DATABASE_SCHEMA`, `DASHBOARD_OIDC_ISSUER`, `DASHBOARD_MCP_API_TOKEN`, `DASHBOARD_MCP_GATEWAY_URL`, dan `SESSION_SECRET` wajib ada. `DATABASE_SCHEMA` menjadi sumber tunggal schema tabel aplikasi.
2. Instal backend: `python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt`.
3. Instal frontend: `cd frontend && npm install --include=dev`.
4. Dari root proyek, jalankan `./start.sh`. Skrip ini membangun frontend, menampilkan URL localhost/LAN/Tailscale yang terdeteksi, menjalankan API dan worker jadwal, lalu menghentikan keduanya saat ditekan `Ctrl+C`. Server mendengarkan di semua interface (`0.0.0.0:8000`); gunakan `APP_HOST` dan `APP_PORT` untuk mengubahnya.
5. Buka `http://<IP-LAN>:8000` dari jaringan lokal atau `http://<IP-TAILSCALE>:8000` dari perangkat dalam tailnet yang sama. `SESSION_COOKIE_SECURE=auto` membuat cookie sesi mengikuti skema HTTP/HTTPS; gunakan HTTPS untuk akses di luar jaringan tepercaya.

Saat startup, backend membuat schema dari `DATABASE_SCHEMA` dan tabel `sessions`, `reports`, `variants`, `report_runs`, serta `report_schedules` jika belum ada.

## Fitur saat ini

- Login dan refresh OIDC melalui BFF; access/refresh token terenkripsi dalam tabel sesi, cookie browser hanya berisi session ID yang ditandatangani.
- Katalog SAP, pemetaan `resource_key` ke ID koneksi, serta simpan/hapus kredensial pribadi melalui vault OIDC.
- Query baca hingga tiga tabel dengan filter SAP terstruktur serta join LEFT/INNER yang diolah backend. Struktur tabel dimuat otomatis lewat gateway dan semua field tampil di canvas. Tabel dan canvas dapat digeser; join dari key bersama diusulkan otomatis dan bisa diubah, termasuk join dengan beberapa pasangan field. Setelah itu pengguna memilih kolom output dan field parameter filter secara terpisah. Setiap sumber maksimal 1.000 baris dan hasil join maksimal 10.000 baris.
- Grid dengan filter, sortir, pilihan kolom, variant layout, formula aritmetika terbatas, pivot, perbandingan dua server dengan key unik, serta ekspor Excel. Kolom sensitif dalam `EXPORT_MASK_FIELDS` otomatis disamarkan saat ekspor.
- Laporan dan variant disimpan per pengguna pada schema database yang dikonfigurasi.
- Asisten AI lokal memakai Ollama dan hanya membuat draf query; pengguna meninjau dan menjalankan draf secara terpisah. `OLLAMA_BASE_URL` serta `OLLAMA_MODEL` ada di `.env`.
- Riwayat eksekusi dan jadwal pembuatan Excel. Hasil jadwal tersimpan di database dan hanya pemiliknya dapat mengunduh melalui aplikasi. Jadwal memakai sesi OIDC pengguna yang didelegasikan maksimal `SCHEDULE_DELEGATION_DAYS`; logout menonaktifkan jadwal yang memakai sesi itu.

## Batas integrasi saat ini

- Backend membaca `tools/list` dan memilih tool baca SAP dari `inputSchema`. Pada pemeriksaan terakhir, `mcp-sap__read_table` tersedia dengan argumen `table`, `fields`, dan `rowcount`; `mcp-sap__read_table_structure` juga tersedia. Hasil pembacaan SAP belum diuji dengan token pengguna dan kredensial SAP pribadi.
- Query join memakai hasil tabel yang dibaca secara terpisah dengan batas baris per tabel. Ini cocok untuk laporan terukur; join besar di SAP membutuhkan tool query khusus pada gateway.
- Ollama lokal `qwen2.5:3b` berhasil membuat draf query pada pengujian, tetapi respons contoh membutuhkan sekitar dua menit.
- `create_all` dipakai untuk bootstrap awal; startup juga menambahkan kolom artifact dan menghapus kolom chat lama secara idempoten. Sebelum perubahan schema produksi berikutnya, tambahkan migrasi berversi.

## Verifikasi

```bash
.venv/bin/python -m unittest discover -s backend/tests -v
cd frontend && npm run build
```
