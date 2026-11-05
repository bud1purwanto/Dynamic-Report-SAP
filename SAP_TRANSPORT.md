# Jembatan SAP Lumina

## Kebijakan dan identitas

- Default tanpa baris pengaturan: Gateway aktif, pyRFC mati, prioritas Gateway, cadangan mati.
- Menu **Jembatan SAP** muncul hanya jika backend berhasil memverifikasi identitas dan peran ADMIN/SUPERADMIN melalui endpoint OIDC `/v1/auth/me`. Setiap GET/PUT/pengujian melakukan verifikasi ulang; profil/role kiriman browser tidak dipercaya. Endpoint ini juga dipakai implementasi autentikasi proyek RAG dalam workspace.
- Dua sakelar mati menolak eksekusi data dan metadata SAP, termasuk worker. Login/refresh OIDC, penyimpanan laporan, dan unduhan hasil tersimpan tidak dimatikan.
- Prioritas pyRFC adalah pilihan eksplisit admin untuk memakai akun teknis **pada semua pengguna dan jadwal**. Hak resource pengguna tetap diperiksa lewat katalog koneksi dan policy Gateway sebelum pembacaan; direct tidak menggantikan policy yang menolak akses.
- Gateway tidak pernah fallback ke akun teknis pyRFC, sekalipun cadangan aktif. Cadangan pyRFC → Gateway hanya diperbolehkan sebelum eksekusi jika pemetaan/SDK tidak tersedia. Error logon, izin, bisnis, runtime, dan koneksi sesudah percobaan pyRFC tidak diulang. Token Gateway tetap token pribadi pengguna.
- Uji setiap jalur memanggil RFC_SYSTEM_INFO tanpa fallback; jalur harus disimpan aktif sebelum diuji. Status merupakan hasil uji saat itu, bukan health monitoring berkelanjutan.

## Penyimpanan dan migrasi

Startup `init_db()` membuat tabel baru `sap_transport_settings` dan `sap_transport_audit` dengan SQLAlchemy `create_all`, tanpa mengubah baris laporan/sesi lama. Default dibaca saat belum ada baris global; perubahan disimpan atomik bersama audit actor/before/after/timestamp. Writer PostgreSQL diserialisasi dengan advisory transaction lock. Tidak ada password atau token pada tabel ini. Konfigurasi dibaca kembali setiap operasi (bukan cache per proses), sehingga worker ikut perubahan tanpa restart. Operasi yang sudah berada di SAP tidak dapat dibatalkan oleh sakelar.

## Sumber kredensial direct yang sah

Sama dengan ABAP Git: Direct pyRFC **tidak punya pengaturan server sendiri**. Kredensial dibaca langsung dari tabel `sandboxes` ABAP Git (`host`, `sysnr`, `client`, `rfc_user`, `rfc_password`) di database yang sama, schema `abap_git_dev` lalu `abap_git` (ubah lewat env `ABAPGIT_DATABASE_SCHEMA`). Server dicocokkan lewat `connection_id` / pemetaan nama ABAP Git ke resource key katalog (mis. `sap:dev`).

- Jembatan hanya untuk **membaca data**: RFC_READ_TABLE, DDIF_FIELDINFO_GET, RFC_SYSTEM_INFO. Tidak ada operasi tulis.
- Server ABAP Git dengan host `gateway` atau tanpa user/password RFC dianggap "Hanya Gateway".
- Password tidak pernah dikirim ke browser; `GET /api/admin/sap-rfc-targets` hanya menampilkan host/client/user.
- `LUMINA_PYRFC_TARGETS_JSON` tetap dibaca sebagai cadangan bila server tidak ada di ABAP Git.

## Pemasangan SDK dan pyrfc

SAP NW RFC SDK berada di host `/usr/local/sap/nwrfcsdk` (sama dengan ABAP Git). pyrfc 3.3.1 ditandai *yanked* di PyPI, jadi harus dipin:

- Lokal (`start.sh`): `SAPNWRFC_HOME=/usr/local/sap/nwrfcsdk .venv/bin/pip install "pyrfc==3.3.1"`
- Docker: `docker compose build` membangun wheel pyrfc dari build context `nwrfcsdk` (`SAPNWRFC_HOST_PATH`, default `/usr/local/sap/nwrfcsdk`) dan mount SDK read-only saat runtime.

Status SDK tampil di modal Jembatan SAP. Import pyRFC bersifat lazy; bila belum terpasang, mode Gateway tetap berjalan.

## Kontrak dan batas direct

Adapter mengembalikan `structuredContent.rows` dan `structuredContent.fields`, kompatibel dengan parser Lumina. Data menggunakan RFC_READ_TABLE dengan pagination 1.000 baris, ROWSKIPS/ROWCOUNT dan offset/length fields; metadata menggunakan DDIF_FIELDINFO_GET. Hanya pembacaan tabel, metadata, dan probe RFC_SYSTEM_INFO diperbolehkan. Batas standar RFC_READ_TABLE 512 byte/baris dan OPTIONS 72 karakter tetap berlaku; tabel lebar dapat memerlukan pemilihan field lebih sedikit. Tidak ada klaim semua tipe SAP setara tanpa uji SAP nyata.

## Development dan bukti uji

Gunakan `.venv/bin/python -m unittest discover -s backend/tests -v`, `npm --prefix frontend run build`, dan `git diff --check`. Untuk pengujian, override seluruh URL/database dengan target lokal terisolasi sebelum import, jangan memakai `.env` produksi.

Harness sementara `/home/abap/.hermes/cache/scratch/lumina_dev_harness.py` dapat dijalankan dari root proyek dengan `.venv/bin/python /home/abap/.hermes/cache/scratch/lumina_dev_harness.py`. UI di `http://127.0.0.1:58391` memakai SQLite scratch serta **identitas OIDC dan hasil SAP sintetis**, bukan login atau SAP nyata. Harness sengaja dependency-override autentikasi untuk uji UI, bind loopback saja, dan bukan server untuk produksi. Hentikan setelah tinjauan. PostgreSQL disposable terpisah pada port 55439 dipakai menguji migrasi idempoten/preservasi laporan/audit, bukan database enterprise.

Gunakan tombol **Uji pyRFC** per server (RFC_SYSTEM_INFO) untuk membuktikan koneksi SAP nyata.
