"""Optional, read-only direct RFC adapter. Never discovers or exposes passwords."""
import importlib
import json
import os
import re

from fastapi import HTTPException


class DirectUnavailable(Exception):
    """Only pre-execution failures permit fallback to the user's Gateway."""


def target_credentials(resource_key: str) -> dict:
    try:
        targets = json.loads(os.environ.get("LUMINA_PYRFC_TARGETS_JSON", "{}"))
        value = targets[resource_key]
        if not isinstance(value, dict) or not all(value.get(k) for k in ("ashost", "sysnr", "client", "user", "passwd")):
            raise ValueError()
        allowed = {"ashost", "sysnr", "client", "user", "passwd", "lang", "saprouter"}
        if set(value) - allowed:
            raise ValueError()
        return {**value, "lang": value.get("lang", "EN")}
    except (ValueError, KeyError, TypeError):
        raise DirectUnavailable() from None


def direct_call(target: str, name: str, arguments: dict) -> dict:
    key = arguments.get("resource_key")
    if not isinstance(key, str) or not key.startswith("sap:"):
        raise DirectUnavailable()
    credentials = target_credentials(key)
    try:
        Connection = importlib.import_module("pyrfc").Connection
    except (ImportError, OSError, AttributeError):
        raise DirectUnavailable() from None
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
    except Exception:
        # Never persist/log original RFC errors: they may include logon parameters.
        raise HTTPException(502, "Eksekusi direct RFC gagal. Periksa otorisasi SAP, koneksi, dan batas RFC_READ_TABLE (512 byte).") from None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
