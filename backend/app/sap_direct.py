"""Read-only direct RFC adapter. Never discovers or exposes passwords.

Sama dengan ABAP-Git: kredensial pyRFC per server dibaca langsung dari tabel `sandboxes` milik
ABAP-Git (host/sysnr/client/rfc_user/rfc_password), dicocokkan lewat resource key (`sap:dev`, ...).
Tidak ada pengaturan server terpisah di Lumina. Jembatan ini hanya dipakai untuk membaca data
(RFC_READ_TABLE, DDIF_FIELDINFO_GET, RFC_SYSTEM_INFO). Env LUMINA_PYRFC_TARGETS_JSON tetap
didukung sebagai cadangan lama.
"""
import importlib
import json
import os
import re

from fastapi import HTTPException
from sqlalchemy import text

# Schema ABAP-Git di database yang sama; boleh beberapa, dicoba berurutan.
ABAPGIT_SCHEMAS = [x.strip() for x in os.environ.get("ABAPGIT_DATABASE_SCHEMA", "abap_git_dev,abap_git").split(",") if x.strip()]

# Salinan RESOURCE_KEY_MAP ABAP-Git (services/sap_transport.py) untuk baris lama tanpa connection_id.
ABAPGIT_NAME_MAP = {
    "sandbox new company": "sap:sandbox-new",
    "sandbox build competence": "sap:sandbox",
    "development aix": "sap:dev",
    "development windows": "sap:dev-win",
    "qa": "sap:qa",
    "production aix": "sap:prod",
    "production windows": "sap:prod-win",
}


class DirectUnavailable(Exception):
    """Only pre-execution failures permit fallback to the user's Gateway."""

    def __init__(self, reason: str = "Direct pyRFC belum tersedia."):
        super().__init__(reason)
        self.reason = reason


def _abapgit_key(row) -> str:
    name = (row.name or "").strip()
    key = row.connection_id or ABAPGIT_NAME_MAP.get(name.lower()) or row.oidc_target or name
    if not key.startswith("sap:"):
        key = ABAPGIT_NAME_MAP.get(key.lower()) or ABAPGIT_NAME_MAP.get(name.lower()) or key
    return key


def abapgit_servers(include_secret: bool = False) -> list[dict]:
    """Server pyRFC dari ABAP-Git. Password hanya disertakan bila include_secret=True (internal)."""
    from .db import engine
    for schema in ABAPGIT_SCHEMAS:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
            continue
        try:
            with engine.connect() as conn:
                rows = conn.execute(text(
                    f'SELECT name, host, sysnr, client, rfc_user, rfc_password, connection_id, oidc_target '
                    f'FROM "{schema}".sandboxes ORDER BY id')).fetchall()
        except Exception:
            continue
        output = []
        for row in rows:
            usable = bool(row.host and row.host.lower() != "gateway" and row.rfc_user and row.rfc_password)
            item = {"resource_key": _abapgit_key(row), "name": row.name, "ashost": row.host, "sysnr": row.sysnr,
                    "client": row.client, "rfc_user": row.rfc_user, "usable": usable, "source": f"ABAP-Git ({schema})"}
            if include_secret:
                item["passwd"] = row.rfc_password
            output.append(item)
        return output
    return []


def sdk_status() -> dict:
    """Status SDK/pyRFC tanpa membuka koneksi SAP."""
    try:
        module = _connection_module()
        return {"available": True, "version": getattr(module, "__version__", "")}
    except DirectUnavailable as exc:
        return {"available": False, "reason": exc.reason}


def _connection_module():
    try:
        return importlib.import_module("pyrfc")
    except (ImportError, OSError):
        raise DirectUnavailable("Modul pyrfc / SAP NW RFC SDK belum terpasang di server backend.") from None


def target_credentials(resource_key: str) -> dict:
    match = next((x for x in abapgit_servers(include_secret=True) if x["resource_key"] == resource_key), None)
    if match and match["usable"]:
        return {"ashost": match["ashost"], "sysnr": match["sysnr"], "client": match["client"],
                "user": match["rfc_user"], "passwd": match["passwd"], "lang": "EN"}
    try:
        value = json.loads(os.environ.get("LUMINA_PYRFC_TARGETS_JSON", "{}") or "{}").get(resource_key)
    except (ValueError, TypeError, AttributeError):
        value = None
    allowed = {"ashost", "sysnr", "client", "user", "passwd", "lang", "saprouter"}
    if isinstance(value, dict) and not set(value) - allowed and all(value.get(k) for k in ("ashost", "sysnr", "client", "user", "passwd")):
        return {**value, "lang": value.get("lang", "EN")}
    if match:
        raise DirectUnavailable(f"Server {match['name']} di ABAP-Git tidak punya host/user RFC langsung (lewat Gateway); pakai jalur OIDC Gateway.")
    raise DirectUnavailable(f"Target {resource_key} tidak ditemukan di daftar server ABAP-Git.")


def rfc_error_message(exc: Exception) -> str:
    """Pesan aman (tanpa parameter logon) berdasarkan jenis exception pyRFC."""
    kind = type(exc).__name__
    return {
        "LogonError": "Logon SAP ditolak: user/password RFC salah, terkunci, atau client tidak valid.",
        "CommunicationError": "Tidak dapat terhubung ke host SAP: periksa host, nomor sistem, SAProuter, dan jaringan.",
        "ABAPApplicationError": "SAP menolak pemanggilan fungsi (error aplikasi ABAP).",
        "ABAPRuntimeError": "Terjadi runtime error ABAP di SAP.",
        "ExternalAuthorizationError": "User RFC tidak memiliki otorisasi untuk operasi ini.",
    }.get(kind, "Eksekusi direct RFC gagal. Periksa otorisasi SAP, koneksi, dan batas RFC_READ_TABLE (512 byte).")


def direct_call(target: str, name: str, arguments: dict) -> dict:
    key = arguments.get("resource_key")
    if not isinstance(key, str) or not key.startswith("sap:"):
        raise DirectUnavailable("Target SAP tidak memiliki resource key yang valid untuk pyRFC.")
    credentials = target_credentials(key)
    Connection = getattr(_connection_module(), "Connection", None)
    if Connection is None:
        raise DirectUnavailable("Modul pyrfc tidak lengkap; pasang ulang pyrfc.")
    conn = None
    try:
        conn = Connection(**credentials)
        if name == "mcp-sap__call_function" and arguments.get("function_name") == "RFC_SYSTEM_INFO":
            conn.call("RFC_SYSTEM_INFO")
            return {"structuredContent": {"status": "ok"}}
        if name == "mcp-sap__read_table_structure":
            table = arguments.get("object_name", "")
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table):
                raise HTTPException(422, "Nama tabel tidak valid.")
            data = conn.call("DDIF_FIELDINFO_GET", TABNAME=table, LANGU="E", ALL_TYPES="X")
            return {"structuredContent": {"fields": data.get("DFIES_TAB", [])}}
        if name not in {"mcp-sap__read_table", "mcp-sap__abap_read_table"}:
            raise HTTPException(422, "Operasi direct RFC tidak didukung.")
        table = arguments.get("table_name") or arguments.get("table")
        fields = arguments.get("fields", [])
        if isinstance(fields, str):
            fields = fields.split(",")
        if not isinstance(table, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table) or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", f) for f in fields):
            raise HTTPException(422, "Nama tabel atau field tidak valid.")
        where = arguments.get("where", [])
        if isinstance(where, str):
            where = [where]
        if any(len(line) > 72 for line in where):
            raise HTTPException(422, "Filter RFC_READ_TABLE melebihi 72 karakter per baris.")
        limit = int(arguments.get("rowcount", 0))
        rows = []
        offset = 0
        while True:
            batch = min(1000, limit - offset) if limit else 1000
            data = conn.call("RFC_READ_TABLE", QUERY_TABLE=table.upper(), DELIMITER="", ROWSKIPS=offset, ROWCOUNT=batch,
                             FIELDS=[{"FIELDNAME": f.upper()} for f in fields], OPTIONS=[{"TEXT": line} for line in where])
            layout = data.get("FIELDS", [])
            raw = data.get("DATA", [])
            rows.extend({f["FIELDNAME"]: row["WA"][int(f["OFFSET"]):int(f["OFFSET"]) + int(f["LENGTH"])].strip() for f in layout} for row in raw)
            offset += len(raw)
            if len(raw) < batch or (limit and offset >= limit):
                break
        return {"structuredContent": {"rows": rows}}
    except HTTPException:
        raise
    except Exception as exc:
        # Never persist/log original RFC errors: they may include logon parameters.
        raise HTTPException(502, rfc_error_message(exc)) from None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
