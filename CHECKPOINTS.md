# Catatan Tahap Lumina Dynamic Report

## 2026-10-29 — Kajian jembatan koneksi SAP

- Permintaan Baginda: admin dapat mengaktifkan/menonaktifkan jalur pyRFC dan Gateway seperti ABAP Git.
- Acuan terverifikasi: `/data/Projects/ABAP-Git-and-Versioning/frontend/src/components/GeneralSettingsTab.jsx` dan `backend/app/services/sap_transport.py`.
- ABAP Git menyediakan `enable_pyrfc`, `enable_oidc_gateway`, `transport_priority`, dan `enable_transport_fallback`. Perubahan antarmuka dibatasi superadmin. Ketika kedua jalur mati, panggilan SAP ditolak.
- ABAP Git melindungi identitas: pembacaan pengguna melalui Gateway tidak otomatis dialihkan ke pyRFC akun teknis; lihat pemilihan jalur pada sap_transport.py baris 517–525.
- Lumina saat ini menggunakan Gateway melalui `backend/app/main.py::rpc_call`; konfigurasi berada di `backend/app/config.py`. Belum ada pengaturan jalur pyRFC pada konfigurasi yang diperiksa.
- Usulan: panel admin koneksi SAP, dua sakelar independen, prioritas jalur, perpindahan cadangan opsional dan aman, pengujian per jalur, serta pencatatan perubahan. Pertahankan autentikasi OIDC meski jalur data Gateway dimatikan.
- Perlu validasi lanjutan: sumber kredensial pyRFC yang sah, pemetaan target server, hak admin dari identitas terpusat, kesetaraan hasil metadata dan pembacaan tabel, serta seluruh jalur eksekusi laporan termasuk penjadwal.
- Status saat kajian: usulan saja, sebelum implementasi pada catatan berikut.

## 2026-10-29 — Implementasi development jembatan SAP

1. Membaca aturan GEMINI.md, checkpoint, alur main.py/worker.py/db.py/App.tsx/api.ts dan acuan transport/katalog ABAP Git. Katalog acuan tidak memberikan password SAP; pemetaan backend env per resource_key didokumentasikan, tanpa endpoint rekaan.
2. Menjalankan tes RED untuk blokir kedua jalur (502 vs 503 sebelum perbaikan), adapter/admin yang belum tersedia, metadata cache, kontrak direct, panel UI yang belum ada, dan sanitasi error upstream. Menerapkan kontrol sesudah kegagalan tersebut; tes regresi tambahan memeriksa persistensi/audit, fallback aman, dan worker.
3. Menambah tabel additive sap_transport_settings/sap_transport_audit, default Gateway aktif/pyRFC mati, admin API dengan verifikasi OIDC segar, pemilihan transport bersama, adapter pyRFC lazy/read-only, dan panel admin dengan sakelar/prioritas/cadangan/uji per jalur. Error SDK tidak mengganggu Gateway; Gateway tidak pernah fallback ke akun teknis.
4. `.venv/bin/python -m unittest discover -s backend/tests -v` dengan seluruh URL/database dioverride lokal: **57 tes lulus**, 0 gagal, 0 error (0,555 detik pada run terakhir). Log `/home/abap/.hermes/cache/scratch/lumina-tests.log`. Dua pesan warning aplikasi merupakan skenario tes kegagalan metadata yang disengaja.
5. `npm --prefix frontend run build`: **berhasil**, 1742 modul, bundle JS 514,17 kB (peringatan Vite chunk >500 kB). `git diff --check`: **bersih**.
6. PostgreSQL disposable `postgres:16`, bind 127.0.0.1:55439: init_db dua kali berhasil; skrip lumina_pg_check.py membuktikan laporan sentinel tidak berubah, konfigurasi persisten, dan satu audit atomik. Pull image alpine sempat timeout; memakai image postgres:16 yang sudah tersedia berhasil, tanpa menyentuh container produksi.
7. API HTTP terisolasi pada 127.0.0.1:58391: metadata/data SAP 503 ketika dua jalur mati; auth/me, daftar laporan dan pembuatan laporan tetap 200; uji jalur nonaktif 409; probe Gateway sintetis sukses. Browser nyata memverifikasi menu admin, penyimpanan, peringatan disabled, probe sukses dan kegagalan direct tanpa konfigurasi. Pada viewport 390px modal 358,8px, tetap dalam viewport dan scrollable.
8. Dev UI diuji di `http://127.0.0.1:58391` melalui harness scratch lumina_dev_harness.py, **OIDC/SAP sintetis dan SQLite scratch**, bukan SAP enterprise. Proses harness dihentikan otomatis ketika agen pelaksana selesai; alamat tersebut bukan layanan development yang masih aktif. Harness hanya loopback dengan dependency override autentikasi, bukan untuk produksi. PostgreSQL disposable dipakai hanya verifikasi migrasi dan sudah dihentikan/dihapus setelah pengujian.

    Verifikasi ulang oleh Alpaca: seluruh 57 tes lulus (0,547 detik) dengan database/URL lokal terisolasi; kompilasi TypeScript/Vite berhasil (1742 modul, 6,65 detik); `git diff --check` bersih. Peringatan ukuran bundle tetap ada. Tidak ada klaim koneksi SAP nyata sudah teruji.
9. Keterbatasan: SAP nyata/SDK/kredensial target belum diuji; direct mengikuti batas RFC_READ_TABLE 512 byte dan opsi 72 karakter; uji OIDC nyata belum dilakukan. Fallback sengaja konservatif (hanya SDK/pemetaan belum tersedia), bukan retry error SAP/izin/logon. Sakelar tidak membatalkan request yang sudah masuk SAP.
10. Berkas implementasi: backend/app/{main.py,db.py,sap_direct.py}, frontend/src/{App.tsx,SapTransportPanel.tsx}; tes backend/tests/{test_core.py,test_transport.py,test_transport_ui.py}; panduan SAP_TRANSPORT.md dan checkpoint ini. worker.py/api.ts ditelusuri tetapi tidak perlu diubah karena memakai jalur bersama yang sama. Tidak ada commit/push, deployment, restart produksi, atau perubahan project.md.
