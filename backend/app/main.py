import base64
import asyncio
import ast
import hashlib
import io
import json
import math
import re
import secrets
import time
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import httpx
import pandas as pd
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeTimedSerializer
from openpyxl import Workbook
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from .config import settings
from .db import AppSession, CompareVariant, Report, ReportRun, ReportSchedule, ReportShare, Variant, auth_engine, get_db, init_db, utcnow


app = FastAPI(title="Lumina Dynamic Report", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|100\.\d+\.\d+\.\d+|.*\.abap\.web\.id|abap\.web\.id)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.session_secret.encode()).digest()))
signer = URLSafeTimedSerializer(settings.session_secret, salt="lumina-session")
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESOURCE_ACCESS_CACHE: dict[tuple[str, str], tuple[float, bool]] = {}
STRUCTURE_CACHE: dict[tuple[str, str], tuple[float, tuple[list[dict[str, Any]], str]]] = {}


async def gateway_allows_resource(token: str, resource_key: str) -> bool | None:
    """Ask the gateway policy without executing an SAP operation.

    Its call_function policy resolves resource_key first, then rejects a missing
    function name before forwarding anything to SAP.
    """
    cache_key = (hashlib.sha256(token.encode()).hexdigest(), resource_key)
    cached = RESOURCE_ACCESS_CACHE.get(cache_key)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.post(
                settings.gateway_url,
                json={"jsonrpc": "2.0", "id": secrets.token_hex(8), "method": "tools/call",
                      "params": {"name": "mcp-sap__call_function",
                                 "arguments": {"resource_key": resource_key, "function_name": ""}}},
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
        if response.status_code == 403:
            allowed = False
        elif response.status_code != 200:
            return None
        else:
            payload = response.json()
            error = payload.get("error") if isinstance(payload, dict) else None
            message = str(error.get("message", "")) if isinstance(error, dict) else ""
            if message == "Missing function name":
                allowed = True
            elif ("not authorized for this client" in message or
                  "No grant for server" in message or
                  "No authorized resources" in message):
                allowed = False
            else:
                return None
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return None
    if len(RESOURCE_ACCESS_CACHE) >= 512:
        RESOURCE_ACCESS_CACHE.clear()
    RESOURCE_ACCESS_CACHE[cache_key] = (time.monotonic() + (60 if allowed else 5), allowed)
    return allowed


@app.on_event("startup")
def startup() -> None:
    init_db()


def secure_cookie_for(request: Request) -> bool:
    return request.url.scheme == "https" if settings.cookie_secure is None else settings.cookie_secure


class LoginIn(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ChangePasswordIn(BaseModel):
    old_password: str | None = None
    new_password: str = Field(min_length=6)




class FilterIn(BaseModel):
    field: str
    operator: str = "EQ"
    value: str = Field(max_length=80)
    high_value: str = Field(default="", max_length=80)
    sign: str = "I"


class ReadIn(BaseModel):
    target: str = Field(min_length=1)
    table_name: str
    fields: list[str] = Field(min_length=1, max_length=100)
    filters: list[FilterIn] = Field(default_factory=list, max_length=100)
    rowcount: int = Field(default=100, ge=1, le=50000)


class StructureIn(BaseModel):
    target: str
    table_name: str


class TableSearchIn(BaseModel):
    target: str
    query: str = ""
    limit: int = Field(default=30, ge=1, le=100)


class PivotIn(BaseModel):
    rows: list[dict[str, Any]] = Field(max_length=10000)
    index: list[str] | str
    columns: str
    values: str
    fallback_values: str | None = None
    aggregation: str = "first"


class CalculatedColumnIn(BaseModel):
    rows: list[dict[str, Any]] = Field(max_length=10000)
    name: str
    operation: str = "custom"
    fields: list[str] = Field(default_factory=list, max_length=50)
    expression: str | None = None


class FormulaIn(BaseModel):
    rows: list[dict[str, Any]] = Field(max_length=10000)
    name: str
    expression: str = Field(min_length=1, max_length=500)


class CompareIn(BaseModel):
    target: str = Field(min_length=1)
    other_target: str = Field(min_length=1)
    table_name: str
    filters: list[FilterIn] = Field(default_factory=list, max_length=10)
    rowcount: int = Field(default=100, ge=1, le=50000)


class SourceIn(BaseModel):
    alias: str
    table_name: str
    fields: list[str] = Field(default_factory=list, max_length=100)
    filters: list[FilterIn] = Field(default_factory=list, max_length=100)


class JoinConditionIn(BaseModel):
    left_field: str
    right_field: str


class JoinIn(BaseModel):
    left_alias: str
    left_field: str = ""
    right_alias: str
    right_field: str = ""
    how: str = "left"
    conditions: list[JoinConditionIn] = Field(default_factory=list, max_length=10)


class QueryIn(BaseModel):
    target: str
    sources: list[SourceIn] = Field(min_length=1, max_length=50)
    joins: list[JoinIn] = []
    rowcount: int = Field(default=100, ge=1, le=50000)
    report_id: str | None = None


class ReportIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    definition: dict[str, Any]


class ReportRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class ReportShareIn(BaseModel):
    username: str = Field(min_length=1, max_length=160)
    permission: Literal["view", "edit"] = "view"


class VariantIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    layout: dict[str, Any]


class CompareVariantIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    config: dict[str, Any]


class ExportIn(BaseModel):
    rows: list[dict[str, Any]] = Field(max_length=10000)
    mask_fields: list[str] = []
    drop_duplicates: bool = False


class AiDraftIn(BaseModel):
    prompt: str = Field(min_length=5, max_length=2000)
    current_query: QueryIn | None = None


class AiFullAssistantIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=3000)
    context_type: Literal["builder", "compare"] = "builder"
    current_state: dict[str, Any] = Field(default_factory=dict)


class ScheduleIn(BaseModel):
    report_id: str
    interval_minutes: int = Field(ge=5, le=10080)


class ScheduleToggleIn(BaseModel):
    enabled: bool


def fail_upstream(res: httpx.Response, service: str) -> None:
    if res.status_code in (401, 403):
        raise HTTPException(401, f"Sesi atau izin {service} tidak valid.")
    if res.status_code >= 400:
        detail = ""
        try:
            body = res.json()
            if isinstance(body, dict):
                detail = str(body.get("message") or body.get("error") or body.get("detail") or "")
        except Exception:
            detail = res.text[:300]
        msg = f"{service} gagal (HTTP {res.status_code}): {detail}" if detail else f"{service} gagal (HTTP {res.status_code})."
        raise HTTPException(502, msg)


def friendly_sap_error(message: str, target: str) -> str:
    lower = message.lower()
    prefix = ""
    if any(x in lower for x in ("rfc_logon_failure", "rc: 103", "password logon")):
        prefix = f"Logon SAP {target} gagal. "
    elif "account locked" in lower or "user locked" in lower:
        prefix = f"Akun SAP Anda pada {target} terkunci. "
    elif "s_rfc" in lower or "no rfc authorization" in lower:
        prefix = f"Akun SAP Anda tidak memiliki izin untuk operasi ini pada {target}. "
    elif any(x in lower for x in ("econnrefused", "connect to sap gateway failed", "timeout")):
        prefix = f"Koneksi ke SAP {target} sedang gagal. "
    if prefix:
        return f"{prefix}[Error Asli: {message}]"
    return f"MCP Gateway SAP ({target}) gagal: {message}"


async def get_token(request: Request, db: Session = Depends(get_db)) -> tuple[AppSession, str]:
    cookie = request.cookies.get(settings.cookie_name)
    if not cookie:
        raise HTTPException(401, "Silakan login.")
    try:
        session_id = signer.loads(cookie, max_age=settings.session_hours * 3600)
    except BadSignature:
        raise HTTPException(401, "Sesi tidak valid.") from None
    try:
        # Sesi ORM sinkron tidak boleh menahan event loop FastAPI.
        row = await asyncio.to_thread(db.get, AppSession, session_id)
        if not row or row.expires_at < utcnow():
            raise HTTPException(401, "Sesi kedaluwarsa.")
        if row.access_expires_at <= utcnow() + timedelta(seconds=60):
            def lock_session():
                # Pembaruan token paralel dapat mengunci baris sesi; batasi
                # antreannya agar seluruh aplikasi tidak ikut menunggu.
                db.execute(text("SET LOCAL lock_timeout = '2s'"))
                return db.execute(
                    select(AppSession).where(AppSession.id == session_id)
                    .with_for_update().execution_options(populate_existing=True)
                ).scalar_one_or_none()

            row = await asyncio.to_thread(lock_session)
            if not row or row.expires_at < utcnow():
                raise HTTPException(401, "Sesi kedaluwarsa.")
    except OperationalError:
        await asyncio.to_thread(db.rollback)
        raise HTTPException(503, "Sesi sedang diproses. Silakan coba lagi.") from None
    try:
        token = fernet.decrypt(row.access_token.encode()).decode()
    except InvalidToken:
        raise HTTPException(401, "Sesi tidak valid. Silakan login kembali.") from None
    if row.access_expires_at <= utcnow() + timedelta(seconds=60):
        try:
            refresh = fernet.decrypt(row.refresh_token.encode()).decode()
        except InvalidToken:
            raise HTTPException(401, "Sesi tidak valid. Silakan login kembali.") from None
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.post(
                    f"{settings.oidc_issuer}/v1/auth/refresh",
                    cookies={"refresh_token": refresh},
                )
            fail_upstream(res, "OIDC")
            data = res.json()
            token = data["accessToken"]
            new_refresh = res.cookies.get("refresh_token") or refresh
            row.access_token = fernet.encrypt(token.encode()).decode()
            row.refresh_token = fernet.encrypt(new_refresh.encode()).decode()
            row.access_expires_at = utcnow() + timedelta(seconds=int(data.get("expiresIn", 900)))
            db.commit()
        except (httpx.HTTPError, KeyError, ValueError):
            raise HTTPException(401, "Sesi OIDC kedaluwarsa. Silakan login kembali.") from None
    return row, token


async def catalog() -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                f"{settings.oidc_issuer}/v1/integration/resources",
                headers={"Authorization": f"Bearer {settings.catalog_token}"},
            )
        fail_upstream(res, "Katalog")
        payload = res.json()
        rows = payload.get("resources", payload) if isinstance(payload, dict) else payload
        return [r for r in rows if isinstance(r, dict) and r.get("kind") == "sap"]
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(502, "Katalog server SAP tidak tersedia.") from None


async def user_catalog(token: str) -> list[dict[str, Any]]:
    resources = await catalog()
    server_ids = {str(r["serverId"]) for r in resources if r.get("serverId")}
    connections: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            for server_id in server_ids:
                res = await client.get(
                    f"{settings.oidc_issuer}/v1/mcp/servers/{quote(server_id, safe='')}/connections",
                    headers={"Authorization": f"Bearer {token}"},
                )
                if res.status_code == 403:
                    continue
                fail_upstream(res, "Koneksi MCP")
                connections.extend(res.json())
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(502, "Daftar koneksi MCP tidak tersedia.") from None
    output = []
    for resource in resources:
        connection = next((c for c in connections if c.get("resourceKey") == resource.get("resource_key")), None)
        if not connection or not connection.get("id"):
            continue
        output.append({
            **resource,
            "id": connection["id"],
            "connection_id": connection["id"],
        })
    access = await asyncio.gather(*(
        gateway_allows_resource(token, str(resource["resource_key"])) for resource in output
    ))
    if any(allowed is None for allowed in access):
        raise HTTPException(503, "Izin resource SAP belum dapat diperiksa melalui MCP Gateway.")
    return [resource for resource, allowed in zip(output, access) if allowed]


def match_target(rows: list[dict[str, Any]], target: str) -> dict[str, Any]:
    wanted = target.strip().lower()
    for row in rows:
        names = [row.get(k) for k in ("id", "connection_id", "resource_key", "sid", "label")]
        names += row.get("aliases") or []
        names = {str(n).lower() for n in names if n}
        names |= {n.split(":", 1)[1] for n in names if n.startswith("sap:")}
        if wanted in names:
            return row
    raise HTTPException(422, f"Target SAP {target} tidak ada dalam katalog.")


async def rpc_call(token: str, target: str, name: str, arguments: dict) -> Any:
    payload = {"jsonrpc": "2.0", "id": secrets.token_hex(8), "method": "tools/call",
               "params": {"name": name, "arguments": arguments}}
    try:
        async with httpx.AsyncClient(timeout=40) as client:
            res = await client.post(
                settings.gateway_url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-SAP-Server": target,
                    "X-SAP-Language": "EN",
                    "Accept": "application/json",
                },
            )
        fail_upstream(res, f"MCP Gateway [{target}]")
        data = res.json()
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError) as err:
        raise HTTPException(502, f"MCP Gateway untuk {target} tidak dapat dihubungi: {err}") from None
    if data.get("error"):
        err_msg = str(data["error"].get("message") or data["error"])
        raise HTTPException(502, friendly_sap_error(err_msg, target))
    result = data.get("result", {})
    if result.get("isError"):
        messages = [str(c.get("text", "")) for c in result.get("content", [])]
        raw_msg = " ".join(messages) if messages else "Eksekusi tool pada MCP Gateway menghasilkan isError=true"
        raise HTTPException(502, friendly_sap_error(raw_msg, target))
    return result


async def read_tool_contract(token: str) -> tuple[str, dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                settings.gateway_url,
                json={"jsonrpc": "2.0", "id": secrets.token_hex(8),
                      "method": "tools/list", "params": {}},
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
        fail_upstream(res, "MCP Gateway")
        payload = res.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "Daftar tool MCP Gateway tidak tersedia.") from None
    result = payload.get("result", {})
    tools = result.get("tools", [])
    for wanted in ("mcp-sap__read_table", "mcp-sap__abap_read_table"):
        tool = next((t for t in tools if t.get("name") == wanted), None)
        if tool:
            return wanted, tool.get("inputSchema") or {}
    partial = " ".join(result.get("_gatewayPartialErrors", []))
    if "mcp-sap" in partial:
        raise HTTPException(503, "Upstream mcp-sap belum tersedia di MCP Gateway.")
    raise HTTPException(403, "Tool baca tabel SAP tidak tersedia untuk akun ini.")


def unpack_rows(result: Any) -> list[dict[str, Any]]:
    candidates = [result]
    if isinstance(result, dict):
        candidates += [result.get("structuredContent"), result.get("data")]
        candidates += [c.get("text") for c in result.get("content", []) if isinstance(c, dict)]
    for item in candidates:
        if isinstance(item, str):
            try:
                item = json.loads(item)
            except ValueError:
                continue
        if isinstance(item, list) and all(isinstance(x, dict) for x in item):
            return item
        if isinstance(item, dict):
            for key in ("rows", "data", "DATA", "result"):
                value = item.get(key)
                if isinstance(value, list) and all(isinstance(x, dict) for x in value):
                    return value
    raise HTTPException(502, "Format hasil tabel dari MCP Gateway belum dikenali.")


def parse_structure(result: Any) -> tuple[list[dict[str, Any]], str]:
    content = result.get("content", []) if isinstance(result, dict) else []
    texts = [str(item.get("text", "")) for item in content if isinstance(item, dict)]
    text_body = "\n".join(texts)[:30000]
    candidates = [result.get("structuredContent") if isinstance(result, dict) else None]
    for item in texts:
        try:
            candidates.append(json.loads(item))
        except ValueError:
            pass
    for candidate in candidates:
        if isinstance(candidate, dict):
            for wrapper in ("result", "data"):
                if isinstance(candidate.get(wrapper), dict):
                    candidate = candidate[wrapper]
                    break
        raw_fields = candidate if isinstance(candidate, list) else (
            next((candidate.get(k) for k in ("fields", "FIELDS", "columns", "FIELD_LIST")
                  if isinstance(candidate.get(k), list)), None)
            if isinstance(candidate, dict) else None
        )
        if raw_fields is None:
            continue
        fields = []
        for field in raw_fields:
            if not isinstance(field, dict):
                continue
            name = next((str(field.get(k)) for k in ("name", "field", "fieldname", "FIELDNAME")
                         if field.get(k)), "")
            if IDENT.fullmatch(name):
                position_value = next((field.get(k) for k in ("position", "POSITION", "field_position", "fieldPosition")
                                       if field.get(k) is not None), None)
                length_value = next((field.get(k) for k in ("length", "LENG", "output_length", "OUTPUTLEN", "intlen", "INTLEN", "field_length")
                                     if field.get(k) is not None), None)
                decimals_value = next((field.get(k) for k in ("decimals", "DECIMALS", "dec")
                                       if field.get(k) is not None), None)
                fields.append({
                    "name": name.upper(),
                    "is_key": bool(field.get("is_key") or field.get("key") or field.get("KEYFLAG") == "X"),
                    "data_type": str(field.get("data_type") or field.get("datatype") or field.get("DATATYPE") or ""),
                    "description": str(next((field.get(k) for k in ("description", "DESCRIPTION", "field_description", "FIELD_DESCRIPTION", "fieldDescription", "field_text", "FIELD_TEXT", "fieldText", "FIELDTEXT", "DDTEXT", "SCRTEXT_L", "scrtext_l", "REPTEXT", "reptext", "label", "text") if field.get(k)), "")),
                    "check_table": str(field.get("check_table") or field.get("CHECKTABLE") or ""),
                    "position": int(position_value) if str(position_value).strip().isdigit() else None,
                    "length": int(length_value) if str(length_value).strip().isdigit() else None,
                    "decimals": int(decimals_value) if str(decimals_value).strip().isdigit() else None,
                })
        if fields:
            return fields, text_body
    # Some MCP implementations present DDIC data as a Markdown table.
    lines = [line.strip() for line in text_body.splitlines() if line.strip().startswith("|")]
    if len(lines) >= 3:
        headers = [cell.strip().lower() for cell in lines[0].strip("|").split("|")]
        name_index = next((i for i, h in enumerate(headers) if h in ("field", "fieldname", "field name", "name")), -1)
        if name_index >= 0:
            fields = []
            position_index = next((i for i, h in enumerate(headers) if h in ("position", "pos")), -1)
            len_index = next((i for i, h in enumerate(headers) if h in ("length", "leng", "len", "output length", "outputlen")), -1)
            dec_index = next((i for i, h in enumerate(headers) if h in ("decimals", "dec")), -1)
            for line in lines[2:]:
                cells = [cell.strip() for cell in line.strip("|").split("|")]
                if len(cells) <= name_index:
                    continue
                name = cells[name_index].strip("`").upper()
                if IDENT.fullmatch(name):
                    key_index = next((i for i, h in enumerate(headers) if h in ("key", "key field")), -1)
                    type_index = next((i for i, h in enumerate(headers) if h in ("type", "datatype", "data type")), -1)
                    fields.append({
                        "name": name,
                        "is_key": key_index >= 0 and key_index < len(cells) and cells[key_index].lower() in ("x", "yes", "true", "key"),
                        "data_type": cells[type_index] if type_index >= 0 and type_index < len(cells) else "",
                        "description": next((cells[i] for i, h in enumerate(headers) if h in ("description", "field description", "field text", "label", "text", "ddtext") and i < len(cells)), ""),
                        "check_table": "",
                        "position": int(cells[position_index]) if position_index >= 0 and position_index < len(cells) and cells[position_index].isdigit() else None,
                        "length": int(cells[len_index]) if len_index >= 0 and len_index < len(cells) and cells[len_index].isdigit() else None,
                        "decimals": int(cells[dec_index]) if dec_index >= 0 and dec_index < len(cells) and cells[dec_index].isdigit() else None,
                    })
            if fields:
                return fields, text_body
    return [], text_body


async def get_structure(token: str, target: dict[str, Any], table_name: str) -> tuple[list[dict[str, Any]], str]:
    if not IDENT.fullmatch(table_name):
        raise HTTPException(422, "Nama tabel tidak valid.")
    table_upper = table_name.upper()
    cache_key = (str(target.get("resource_key") or target.get("id")), table_upper)
    cached = STRUCTURE_CACHE.get(cache_key)
    if cached and cached[0] > time.monotonic():
        # Return deep copy of fields list to avoid mutations
        return [dict(f) for f in cached[1][0]], cached[1][1]

    result = await rpc_call(token, str(target["id"]), "mcp-sap__read_table_structure", {
        "object_name": table_upper,
        "object_type": "TABLE",
        "resource_key": target["resource_key"],
    })
    fields, raw = parse_structure(result)
    if not fields:
        return fields, raw
    ddic_rows: list[dict[str, Any]] = []
    needs_description = any(not field.get("description") for field in fields)
    needs_enrichment = (
        not all(isinstance(field.get("position"), int) and field["position"] > 0 for field in fields)
        or any(not field.get("data_type") or field.get("data_type") == "CHAR" or field.get("length") is None for field in fields)
        or needs_description
    )
    if needs_enrichment:
        try:
            ddic_rows = await read_rows(ReadIn(
                target=str(target["id"]), table_name="DD03L", fields=["FIELDNAME", "POSITION", "ROLLNAME", "DATATYPE", "LENG", "OUTPUTLEN", "DECIMALS"],
                filters=[FilterIn(field="TABNAME", value=table_upper),
                         FilterIn(field="AS4LOCAL", value="A")], rowcount=1000,
            ), token)
            by_name = {str(row.get("FIELDNAME", "")).upper(): row for row in ddic_rows}
            for field in fields:
                info = by_name.get(field["name"])
                if info:
                    if (field.get("position") is None or field.get("position") == 0) and str(info.get("POSITION", "")).strip().isdigit():
                        field["position"] = int(str(info["POSITION"]).strip())
                    if info.get("DATATYPE"):
                        field["data_type"] = str(info["DATATYPE"]).strip()
                    if field.get("length") is None:
                        out_len = str(info.get("OUTPUTLEN") or info.get("LENG") or "").strip()
                        if out_len.isdigit():
                            field["length"] = int(out_len)
                    if field.get("decimals") is None:
                        dec_len = str(info.get("DECIMALS") or "").strip()
                        if dec_len.isdigit():
                            field["decimals"] = int(dec_len)
        except (HTTPException, ValueError, KeyError):
            pass
    if needs_description:
        try:
            texts = await read_rows(ReadIn(
                target=str(target["id"]), table_name="DD03T", fields=["FIELDNAME", "DDTEXT", "DDLANGUAGE"],
                filters=[FilterIn(field="TABNAME", value=table_upper)], rowcount=1000,
            ), token)
            by_name: dict[str, str] = {}
            for row in sorted(texts, key=lambda item: str(item.get("DDLANGUAGE", "")) != "E"):
                name = str(row.get("FIELDNAME", "")).upper()
                description = str(row.get("DDTEXT", "")).strip()
                if name and description and name not in by_name:
                    by_name[name] = description
            for field in fields:
                field["description"] = field.get("description") or by_name.get(field["name"], "")
        except (HTTPException, ValueError, KeyError):
            pass
    if any(not field.get("description") for field in fields) and ddic_rows:
        rollnames = {str(row.get("FIELDNAME", "")).upper(): str(row.get("ROLLNAME", "")).upper()
                     for row in ddic_rows}
        missing_rollnames = list(dict.fromkeys(
            rollnames.get(field["name"], "") for field in fields if not field.get("description")
            and IDENT.fullmatch(rollnames.get(field["name"], ""))))
        if missing_rollnames:
            async def read_element_text(rollname: str) -> tuple[str, str]:
                try:
                    rows = await read_rows(ReadIn(
                        target=str(target["id"]), table_name="DD04T", fields=["DDTEXT"],
                        filters=[FilterIn(field="ROLLNAME", value=rollname),
                                 FilterIn(field="DDLANGUAGE", value="E")], rowcount=1,
                    ), token)
                    return rollname, str(rows[0].get("DDTEXT", "")).strip() if rows else ""
                except (HTTPException, ValueError, KeyError):
                    return rollname, ""
            texts_by_rollname: dict[str, str] = {}
            for offset in range(0, len(missing_rollnames), 6):
                texts_by_rollname.update(await asyncio.gather(
                    *(read_element_text(name) for name in missing_rollnames[offset:offset + 6])))
            for field in fields:
                field["description"] = field.get("description") or texts_by_rollname.get(rollnames.get(field["name"], ""), "")
    fields.sort(key=lambda field: (field.get("position") is None, field.get("position") or 0))
    # Cache for 1 hour (3600 seconds)
    STRUCTURE_CACHE[cache_key] = (time.monotonic() + 3600, ([dict(f) for f in fields], raw))
    return fields, raw


def normalize_sap_filter_value(val: str, field_name: str) -> str:
    s = val.strip()
    if not s:
        return s
    is_date_field = (
        field_name.endswith("DAT")
        or field_name.endswith("DATE")
        or field_name.endswith("DT")
        or field_name in ("DATUM", "CPUDT", "ERDAT", "AEDAT", "FKDAT", "BLDAT", "BUDAT", "BEDAT", "AUDAT", "WADAT", "LFDAT")
    )
    if is_date_field:
        if re.fullmatch(r"\d{8}", s):
            return s
        m_ymd = re.fullmatch(r"(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})", s)
        if m_ymd:
            return f"{m_ymd.group(1)}{int(m_ymd.group(2)):02d}{int(m_ymd.group(3)):02d}"
        m_dmy = re.fullmatch(r"(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})", s)
        if m_dmy:
            p1, p2, yr = int(m_dmy.group(1)), int(m_dmy.group(2)), m_dmy.group(3)
            if p1 > 12:
                day, month = p1, p2
            elif p2 > 12:
                month, day = p1, p2
            else:
                day, month = p1, p2
            return f"{yr}{month:02d}{day:02d}"
    return s


def build_sap_where(filters: list[FilterIn]) -> list[str]:
    operators = {"EQ": "=", "NE": "<>", "GT": ">", "GE": ">=", "LT": "<", "LE": "<="}
    grouped: dict[str, dict[str, list[str]]] = {}
    include_equals: dict[str, list[str]] = {}
    for item in filters:
        if not IDENT.fullmatch(item.field) or item.operator not in (*operators, "BT") or item.sign not in ("I", "E"):
            raise HTTPException(422, "Filter SAP tidak valid.")
        if not item.value.strip():
            continue
        field = item.field.upper()
        low = normalize_sap_filter_value(item.value, field).replace("'", "''")
        if item.operator == "EQ" and item.sign == "I":
            include_equals.setdefault(field, []).append(low)
            grouped.setdefault(field, {"I": [], "E": []})
            continue
        if item.operator == "BT":
            if not item.high_value.strip():
                raise HTTPException(422, f"Isi nilai akhir interval {field}.")
            high = normalize_sap_filter_value(item.high_value, field).replace("'", "''")
            condition = f"({field} >= '{low}' AND {field} <= '{high}')"
        else:
            condition = f"{field} {operators[item.operator]} '{low}'"
        if len(condition) > 72:
            raise HTTPException(422, f"Nilai filter {field} terlalu panjang.")
        grouped.setdefault(field, {"I": [], "E": []})[item.sign].append(condition)
    clauses = []
    for field, selections in grouped.items():
        values = include_equals.get(field, [])
        if values:
            if len(values) == 1:
                selections["I"].insert(0, f"{field} = '{values[0]}'")
            else:
                value_list = ", ".join("'" + value + "'" for value in values)
                selections["I"].insert(0, f"{field} IN ({value_list})")
        if selections["I"]:
            clauses.append(selections["I"][0] if len(selections["I"]) == 1
                           else "(" + " OR ".join(selections["I"]) + ")")
        for condition in selections["E"]:
            clauses.append(f"NOT ({condition})")
    if not clauses:
        return []
    expression = " AND ".join(clauses)
    # RFC_READ_TABLE accepts an array of 72-character option lines.
    words = []
    token = ""
    quoted = False
    for char in expression:
        if char == "'":
            quoted = not quoted
            token += char
        elif not quoted and char == " ":
            if token:
                words.append(token)
                token = ""
        elif not quoted and char == ",":
            token += char
            words.append(token)
            token = ""
        else:
            token += char
    if token:
        words.append(token)
    lines: list[str] = []
    line = ""
    for word in words:
        if len(word) > 72:
            raise HTTPException(422, f"Nilai filter SAP terlalu panjang ({len(word)} karakter).")
        candidate = f"{line} {word}" if line else word
        if len(candidate) > 72:
            if not line:
                raise HTTPException(422, "Nilai filter SAP terlalu panjang.")
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


async def read_rows(dto: ReadIn, token: str) -> list[dict[str, Any]]:
    target = match_target(await user_catalog(token), dto.target)
    if not IDENT.fullmatch(dto.table_name) or any(not IDENT.fullmatch(f) for f in dto.fields):
        raise HTTPException(422, "Nama tabel atau field tidak valid.")
    where = build_sap_where(dto.filters)
    name, schema = await read_tool_contract(token)
    properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
    table_arg = next((k for k in ("table_name", "table", "tablename") if k in properties), "table_name")
    fields_arg = next((k for k in ("fields", "field_names", "columns") if k in properties), "fields")
    limit_arg = next((k for k in ("rowcount", "row_count", "limit", "max_rows") if k in properties), "rowcount")
    required = set(schema.get("required", [])) if isinstance(schema, dict) else set()
    supported = {"resource_key", table_arg, fields_arg, limit_arg}
    if required - supported:
        raise HTTPException(503, "Kontrak tool baca SAP memerlukan parameter tambahan yang belum didukung.")
    field_value: Any = [f.upper() for f in dto.fields]
    if properties.get(fields_arg, {}).get("type") == "string":
        field_value = ",".join(field_value)
    # The gateway strips resource_key and enforces the user's SAP grants.
    arguments = {
        table_arg: dto.table_name.upper(),
        fields_arg: field_value,
        limit_arg: dto.rowcount,
        "resource_key": target["resource_key"],
    }
    if where:
        arguments["where"] = where
    result = await rpc_call(token, dto.target, name, arguments)
    return unpack_rows(result)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/auth/login")
async def login(dto: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(
                f"{settings.oidc_issuer}/v1/auth/login",
                json={"username": dto.username, "password": dto.password},
            )
        if res.status_code in (400, 401):
            raise HTTPException(401, "Username atau password OIDC salah.")
        fail_upstream(res, "OIDC")
        data = res.json()
        refresh = res.cookies.get("refresh_token")
        user = data["user"]
        token = data["accessToken"]
        if not refresh or not isinstance(user, dict) or not (user.get("id") or user.get("sub")):
            raise HTTPException(502, "Respons login OIDC tidak lengkap.")
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(502, "Layanan login OIDC tidak tersedia.") from None
    sid = secrets.token_urlsafe(32)
    row = AppSession(
        id=sid,
        user_id=str(user.get("id") or user["sub"]),
        user_profile=user,
        access_token=fernet.encrypt(token.encode()).decode(),
        refresh_token=fernet.encrypt(refresh.encode()).decode(),
        access_expires_at=utcnow() + timedelta(seconds=int(data.get("expiresIn", 900))),
        expires_at=utcnow() + timedelta(hours=settings.session_hours),
    )
    db.add(row)
    db.commit()
    response.set_cookie(
        settings.cookie_name, signer.dumps(sid), httponly=True,
        secure=secure_cookie_for(request),
        samesite="lax",
        max_age=settings.session_hours * 3600, path="/",
    )
    return {"user": user}


@app.get("/api/auth/me")
async def me(auth: tuple[AppSession, str] = Depends(get_token)):
    return {"user": auth[0].user_profile}


@app.post("/api/auth/change-password")
async def change_password(
    dto: ChangePasswordIn,
    request: Request,
    response: Response,
    auth: tuple[AppSession, str] = Depends(get_token),
    db: Session = Depends(get_db),
):
    session, token = auth
    user_id = session.user_id
    payload = {"newPassword": dto.new_password}
    if dto.old_password:
        payload["oldPassword"] = dto.old_password

    try:
        refresh = fernet.decrypt(session.refresh_token.encode()).decode()
    except InvalidToken:
        refresh = ""

    cookies = {"refresh_token": refresh} if refresh else {}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                f"{settings.oidc_issuer}/v1/auth/change-password",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
                cookies=cookies,
            )
        if res.status_code in (400, 401, 403):
            detail = "Gagal mengubah password."
            try:
                err_data = res.json()
                detail = err_data.get("message") or err_data.get("detail") or detail
                if isinstance(detail, list):
                    detail = ", ".join(detail)
            except Exception:
                pass
            raise HTTPException(res.status_code, detail)
        fail_upstream(res, "OIDC")
        data = res.json()
        new_token = data.get("accessToken") or token
        new_refresh = res.cookies.get("refresh_token") or refresh
        session.access_token = fernet.encrypt(new_token.encode()).decode()
        if new_refresh:
            session.refresh_token = fernet.encrypt(new_refresh.encode()).decode()
        session.access_expires_at = utcnow() + timedelta(seconds=int(data.get("expiresIn", 900)))

        # Update mustChangePassword flag in stored user_profile
        if isinstance(session.user_profile, dict):
            profile = dict(session.user_profile)
            profile["mustChangePassword"] = False
            session.user_profile = profile
        db.commit()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "Layanan OIDC tidak merespons perubahan password.") from None

    return {"success": True, "user": session.user_profile}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response,
                 db: Session = Depends(get_db)):
    cookie = request.cookies.get(settings.cookie_name)
    if cookie:
        try:
            session_id = signer.loads(cookie)
            session = db.get(AppSession, session_id)
            if session:
                for schedule in db.scalars(select(ReportSchedule).where(
                    ReportSchedule.session_id == session.id,
                    ReportSchedule.enabled.is_(True),
                )).all():
                    schedule.enabled = False
                    schedule.last_status = "needs_login"
                    schedule.last_error = "Sesi pengguna diakhiri."
                db.delete(session)
                db.commit()
        except BadSignature:
            pass
    response.delete_cookie(settings.cookie_name, path="/")
    return {"success": True}


@app.get("/api/sap/servers")
async def servers(auth: tuple[AppSession, str] = Depends(get_token)):
    return {"resources": await user_catalog(auth[1])}




@app.post("/api/sap/read-table")
async def read_table(dto: ReadIn, auth: tuple[AppSession, str] = Depends(get_token)):
    rows = await read_rows(dto, auth[1])
    return {"columns": list(dict.fromkeys(k for row in rows for k in row)), "rows": rows}


@app.post("/api/sap/table-structure")
async def table_structure(dto: StructureIn, auth: tuple[AppSession, str] = Depends(get_token)):
    target = match_target(await user_catalog(auth[1]), dto.target)
    fields, raw = await get_structure(auth[1], target, dto.table_name)
    return {"table_name": dto.table_name.upper(),
            "fields": fields, "text": raw}


POPULAR_SAP_TABLES = [
    {"name": "MARA", "description": "General Material Data"},
    {"name": "MAKT", "description": "Material Descriptions"},
    {"name": "MARC", "description": "Plant Data for Material"},
    {"name": "MARD", "description": "Storage Location Data for Material"},
    {"name": "MCH1", "description": "Batches (Material/Batch Level)"},
    {"name": "AUSP", "description": "Characteristic Values (Classification)"},
    {"name": "VBAK", "description": "Sales Document: Header Data"},
    {"name": "VBAP", "description": "Sales Document: Item Data"},
    {"name": "VBKD", "description": "Sales Document: Business Data"},
    {"name": "VBEP", "description": "Sales Document: Schedule Line Data"},
    {"name": "LIKP", "description": "SD Document: Delivery Header Data"},
    {"name": "LIPS", "description": "SD Document: Delivery Item Data"},
    {"name": "VBRK", "description": "Billing Document: Header Data"},
    {"name": "VBRP", "description": "Billing Document: Item Data"},
    {"name": "EKKO", "description": "Purchasing Document Header"},
    {"name": "EKPO", "description": "Purchasing Document Item"},
    {"name": "EKET", "description": "Scheduling Agreement Schedule Lines"},
    {"name": "EBAN", "description": "Purchase Requisition"},
    {"name": "BKPF", "description": "Accounting Document Header"},
    {"name": "BSEG", "description": "Accounting Document Segment"},
    {"name": "BSIS", "description": "G/L Open Items"},
    {"name": "BSAS", "description": "G/L Cleared Items"},
    {"name": "KNA1", "description": "General Data in Customer Master"},
    {"name": "KNB1", "description": "Customer Master (Company Code)"},
    {"name": "KNVV", "description": "Customer Master Sales Data"},
    {"name": "LFA1", "description": "Vendor Master (General Section)"},
    {"name": "LFB1", "description": "Vendor Master (Company Code)"},
    {"name": "LFM1", "description": "Vendor Master: Purchasing Data"},
    {"name": "MKPF", "description": "Header: Material Document"},
    {"name": "MSEG", "description": "Document Segment: Material (Stock Movement)"},
    {"name": "AFKO", "description": "Order Header Data PP Orders"},
    {"name": "AFPO", "description": "Order Item PP Orders"},
    {"name": "AUFK", "description": "Order Master Data"},
]


@app.post("/api/sap/search-tables")
async def search_tables(dto: TableSearchIn, auth: tuple[AppSession, str] = Depends(get_token)):
    q = dto.query.strip().upper()
    
    # If search query is empty, return popular SAP tables first
    if not q:
        return {"tables": POPULAR_SAP_TABLES[:dto.limit]}

    # Prioritize popular tables matching query first
    popular_matches = [
        t for t in POPULAR_SAP_TABLES
        if t["name"] == q or t["name"].startswith(q) or q in t["name"] or q.lower() in t["description"].lower()
    ]

    # Attempt query from SAP DD02T
    try:
        target = match_target(await user_catalog(auth[1]), dto.target)
        clean_q = re.sub(r"[^A-Za-z0-9_% ]", "", dto.query.strip())
        where_clauses = [
            "DDLANGUAGE = 'E' AND TABNAME NOT LIKE '/%' AND (",
            f"TABNAME LIKE '{clean_q.upper()}%' OR",
            f"DDTEXT LIKE '%{clean_q}%')",
        ]
        res = await rpc_call(auth[1], str(target["id"]), "mcp-sap__read_table", {
            "table": "DD02T",
            "fields": ["TABNAME", "DDTEXT"],
            "where": where_clauses,
            "rowcount": dto.limit * 2,
            "resource_key": target["resource_key"],
        })
        raw_rows = unpack_rows(res)
        results = []
        seen = set()
        # Insert popular exact/starts matches first
        for p in popular_matches:
            if p["name"] not in seen:
                seen.add(p["name"])
                results.append(p)

        for r in raw_rows:
            tname = str(r.get("TABNAME", "")).strip().upper()
            tdesc = str(r.get("DDTEXT", "")).strip()
            if tname and tname not in seen:
                seen.add(tname)
                results.append({"name": tname, "description": tdesc})

        # Sort: exact match -> starts with query -> others
        results.sort(key=lambda x: (
            0 if x["name"] == q else (1 if x["name"].startswith(q) else 2),
            len(x["name"]),
            x["name"]
        ))
        if results:
            return {"tables": results[:dto.limit]}
    except Exception:
        pass

    # Fallback: filter from popular SAP tables list
    return {"tables": popular_matches[:dto.limit]}


async def execute_query(dto: QueryIn, token: str) -> dict[str, Any]:
    aliases = [s.alias for s in dto.sources]
    if len(aliases) != len(set(aliases)) or any(not IDENT.fullmatch(a) for a in aliases):
        raise HTTPException(422, "Alias tabel harus unik dan valid.")
    if len(dto.joins) != len(dto.sources) - 1:
        raise HTTPException(422, "Setiap tabel tambahan memerlukan satu join.")
    if not any(source.fields for source in dto.sources):
        raise HTTPException(422, "Pilih setidaknya satu kolom untuk ditampilkan.")
    target = match_target(await user_catalog(token), dto.target)
    metadata: dict[str, dict[str, dict[str, Any]]] = {}
    warnings = []
    for source in dto.sources:
        fields, _ = await get_structure(token, target, source.table_name)
        metadata[source.alias] = {field["name"]: field for field in fields}
        if not fields:
            warnings.append(f"Struktur {source.table_name} tidak dapat diparsing; verifikasi field dilakukan oleh SAP saat baca.")
            continue
        requested = {field.upper() for field in source.fields}
        requested |= {item.field.upper() for item in source.filters if item.value.strip()}
        for join in dto.joins:
            conditions = join.conditions or ([JoinConditionIn(left_field=join.left_field, right_field=join.right_field)]
                                             if join.left_field and join.right_field else [])
            requested |= {condition.left_field.upper() for condition in conditions if join.left_alias == source.alias}
            requested |= {condition.right_field.upper() for condition in conditions if join.right_alias == source.alias}
        unknown = requested - set(metadata[source.alias])
        if unknown:
            raise HTTPException(422, f"Field tidak ada di {source.table_name}: {', '.join(sorted(unknown))}")
    frames = {}
    for source_idx, source in enumerate(dto.sources):
        join_fields = [condition.left_field for join in dto.joins if join.left_alias == source.alias
                       for condition in (join.conditions or [JoinConditionIn(left_field=join.left_field, right_field=join.right_field)])]
        join_fields += [condition.right_field for join in dto.joins if join.right_alias == source.alias
                        for condition in (join.conditions or [JoinConditionIn(left_field=join.left_field, right_field=join.right_field)])]
        fields = list(dict.fromkeys(f.upper() for f in [*source.fields, *join_fields] if f))
        source_filters = [f for f in source.filters if f.value.strip()]

        chunk_col = None
        chunk_batches: list[list[str]] = []
        if source_idx > 0:
            for join in dto.joins:
                if join.right_alias == source.alias and join.left_alias in frames:
                    left_df = frames[join.left_alias]
                    conditions = join.conditions or ([JoinConditionIn(left_field=join.left_field, right_field=join.right_field)]
                                                     if join.left_field and join.right_field else [])
                    for cond in conditions:
                        left_col = f"{join.left_alias}.{cond.left_field.upper()}"
                        right_col = cond.right_field.upper()
                        has_upstream_data = len(left_df) > 0
                        if has_upstream_data and not any(f.field.upper() == right_col for f in source_filters) and left_col in left_df.columns:
                            distinct_vals = [
                                str(v).strip() for v in left_df[left_col].dropna().unique()
                                if str(v).strip() and str(v).strip() != "0"
                            ]
                            if len(distinct_vals) == 1:
                                source_filters.append(FilterIn(field=right_col, operator="EQ", value=distinct_vals[0]))
                            elif 1 < len(distinct_vals) <= 30 - len(source_filters):
                                source_filters.extend(
                                    FilterIn(field=right_col, operator="EQ", value=value)
                                    for value in distinct_vals
                                )
                            elif len(distinct_vals) > 30 - len(source_filters) and not chunk_batches:
                                chunk_col = right_col
                                max_keys = 300
                                if len(distinct_vals) > max_keys:
                                    warnings.append(
                                        f"Kunci join {cond.left_field} melebihi {max_keys} ({len(distinct_vals)} unik). Mengambil data untuk {max_keys} kunci pertama."
                                    )
                                capped = distinct_vals[:max_keys]
                                chunk_batches = [capped[i:i + 25] for i in range(0, len(capped), 25)]
                            elif len(distinct_vals) == 0 and len(left_df) > 0:
                                warnings.append(
                                    f"Field {cond.left_field} pada tabel {join.left_alias} kosong atau 0 untuk data terpilih."
                                )

        downstream_limit = 5000
        if chunk_batches and chunk_col:
            rows: list[dict[str, Any]] = []
            for batch in chunk_batches:
                batch_filters = list(source_filters) + [FilterIn(field=chunk_col, operator="EQ", value=v) for v in batch]
                batch_rows = await read_rows(ReadIn(target=dto.target, table_name=source.table_name,
                                                    fields=fields, filters=batch_filters,
                                                    rowcount=downstream_limit), token)
                rows.extend(batch_rows)
                if len(rows) >= 10000:
                    break
        else:
            fetch_limit = dto.rowcount if source_idx == 0 else downstream_limit
            rows = await read_rows(ReadIn(target=dto.target, table_name=source.table_name,
                                          fields=fields, filters=source_filters,
                                          rowcount=fetch_limit), token)
        frames[source.alias] = pd.DataFrame(rows, columns=fields).rename(
            columns={field: f"{source.alias}.{field}" for field in fields})
    merged = frames[dto.sources[0].alias]
    included = {dto.sources[0].alias}
    for index, source in enumerate(dto.sources[1:]):
        join = dto.joins[index]
        if join.right_alias != source.alias or join.left_alias not in included or join.how not in ("left", "inner"):
            raise HTTPException(422, "Urutan atau tipe join tidak valid.")
        conditions = join.conditions or ([JoinConditionIn(left_field=join.left_field, right_field=join.right_field)]
                                         if join.left_field and join.right_field else [])
        if not conditions:
            raise HTTPException(422, "Pilih field join untuk setiap tabel tambahan.")
        left_keys = [f"{join.left_alias}.{item.left_field.upper()}" for item in conditions]
        right_keys = [f"{join.right_alias}.{item.right_field.upper()}" for item in conditions]
        if any(key not in merged for key in left_keys) or any(key not in frames[source.alias] for key in right_keys):
            raise HTTPException(422, "Field join tidak ada dalam fields tabel.")
        for condition, left_key, right_key in zip(conditions, left_keys, right_keys):
            left_meta = metadata.get(join.left_alias, {}).get(condition.left_field.upper())
            right_meta = metadata.get(join.right_alias, {}).get(condition.right_field.upper())
            if left_meta and right_meta and left_meta["data_type"] and right_meta["data_type"]:
                if left_meta["data_type"].upper() != right_meta["data_type"].upper():
                    raise HTTPException(422, f"Tipe field join {left_key} dan {right_key} berbeda.")
        left_counts = merged[left_keys].astype(str).value_counts(dropna=False)
        right_counts = frames[source.alias][right_keys].astype(str).value_counts(dropna=False)
        estimated = sum(int(count) * max(1 if join.how == "left" else 0,
                                        int(right_counts.get(key, 0)))
                        for key, count in left_counts.items())
        if estimated > 10000:
            raise HTTPException(422, "Hasil join diperkirakan melebihi 10.000 baris. Persempit data.")
        merged = merged.merge(frames[source.alias], left_on=left_keys, right_on=right_keys,
                              how=join.how, validate="many_to_many")
        if len(merged) > 10000:
            raise HTTPException(422, "Hasil join melebihi 10.000 baris. Persempit data.")
        included.add(source.alias)
    output_columns = [f"{source.alias}.{field.upper()}" for source in dto.sources for field in source.fields]
    rows = json.loads(merged[output_columns].to_json(orient="records", date_format="iso"))
    return {"columns": output_columns, "rows": rows, "warnings": warnings}


def check_report_share_access(db: Session, report_id: str, user_id: str, username: str) -> ReportShare | None:
    user_cond = []
    if user_id:
        user_cond.append(ReportShare.shared_with_user_id == user_id)
    if username:
        user_cond.append(func.lower(ReportShare.shared_with_username) == username.lower())
    if not user_cond:
        return None
    return db.scalars(
        select(ReportShare).where(ReportShare.report_id == report_id, or_(*user_cond))
    ).first()


@app.post("/api/sap/query")
async def run_query(dto: QueryIn, auth: tuple[AppSession, str] = Depends(get_token),
                    db: Session = Depends(get_db)):
    report_id = dto.report_id
    if report_id:
        report = db.get(Report, report_id)
        current_username = (auth[0].user_profile.get("username", "") if isinstance(auth[0].user_profile, dict) else "").strip()
        has_share = check_report_share_access(db, report_id, auth[0].user_id, current_username) if report else None
        if not report or (report.owner_id != auth[0].user_id and not has_share):
            report_id = None
    try:
        result = await execute_query(dto, auth[1])
    except HTTPException as exc:
        db.add(ReportRun(owner_id=auth[0].user_id, report_id=report_id, definition=dto.model_dump(),
                         status="error", error=str(exc.detail)[:500]))
        db.commit()
        raise
    except Exception as exc:
        err_msg = str(exc)
        db.add(ReportRun(owner_id=auth[0].user_id, report_id=report_id, definition=dto.model_dump(),
                         status="error", error=err_msg[:500]))
        db.commit()
        raise HTTPException(500, f"Terjadi kesalahan saat mengeksekusi query: {err_msg}") from exc
    db.add(ReportRun(owner_id=auth[0].user_id, report_id=report_id, definition=dto.model_dump(),
                     status="success", row_count=len(result["rows"])))
    db.commit()
    return result


from .ai_service import check_ai_providers_status, query_llm_with_fallback


@app.get("/api/ai/status")
async def ai_status(auth: tuple[AppSession, str] = Depends(get_token)):
    return await check_ai_providers_status()


@app.post("/api/ai/generate")
async def ai_generate(dto: AiFullAssistantIn, auth: tuple[AppSession, str] = Depends(get_token)):
    resources = await user_catalog(auth[1])
    allowed_targets = [r["id"] for r in resources]
    if not allowed_targets:
        raise HTTPException(422, "Tidak ada target SAP yang tersedia untuk akun Anda.")

    if dto.context_type == "compare":
        system_prompt = (
            "Anda adalah AI Assistant SAP Expert Lumina untuk fitur Bandingkan Data. "
            "Tugas Anda adalah menganalisis permintaan pengguna dan menghasilkan konfigurasi perbandingan dalam JSON. "
            "Kembalikan HANYA format JSON valid tanpa markdown/backticks:\n"
            "{\n"
            '  "explanation": "Penjelasan singkat analisis Anda",\n'
            '  "target": "target_id_sumber",\n'
            '  "other_target": "target_id_pembanding",\n'
            '  "table_name": "NAMA_TABEL_SAP",\n'
            '  "rowcount": 100,\n'
            '  "filters": [\n'
            '    {"field": "FIELDNAME", "operator": "EQ|BT|NE|GT|GE|LT|LE", "value": "val1", "high_value": "val2", "sign": "I|E"}\n'
            "  ]\n"
            "}\n"
            "Aturan:\n"
            "1. target dan other_target HARUS dipilih dari daftar server yang diizinkan dan harus berbeda.\n"
            "2. table_name harus nama tabel SAP valid (huruf kapital, misal MARA, VBAK, EKKO, AUSP).\n"
        )
        user_prompt = json.dumps({
            "request": dto.prompt,
            "allowed_servers": [{"id": r["id"], "label": r.get("label")} for r in resources],
            "current_state": dto.current_state,
        }, ensure_ascii=False)
    else:
        system_prompt = (
            "Anda adalah AI Assistant SAP Data Architect Lumina untuk Query Builder & Report Generator. "
            "Tugas Anda: dari instruksi pengguna, susun konfigurasi laporan lengkap secara presisi. "
            "Format balasan HARUS JSON murni tanpa markdown/backticks:\n"
            "{\n"
            '  "explanation": "Penjelasan singkat arsitektur query dan langkah yang diambil",\n'
            '  "target": "target_id",\n'
            '  "rowcount": 100,\n'
            '  "sources": [\n'
            '    {\n'
            '      "alias": "T1",\n'
            '      "table_name": "NAMA_TABEL",\n'
            '      "fields": ["FIELD1", "FIELD2"],\n'
            '      "filters": [{"field": "FIELD1", "operator": "EQ", "value": "VAL", "high_value": "", "sign": "I"}]\n'
            '    }\n'
            '  ],\n'
            '  "joins": [\n'
            '    {\n'
            '      "left_alias": "T1",\n'
            '      "right_alias": "T2",\n'
            '      "how": "left|inner",\n'
            '      "conditions": [{"left_field": "KEY1", "right_field": "KEY1"}]\n'
            '    }\n'
            '  ],\n'
            '  "calculatedColumns": [\n'
            '    {\n'
            '      "name": "NAMA_KOLOM",\n'
            '      "operation": "custom",\n'
            '      "expression": "([T1.FIELD1] * [T2.FIELD2]) / 1000"\n'
            '    }\n'
            '  ],\n'
            '  "pivot": {\n'
            '    "rows": ["T1.FIELD1"],\n'
            '    "column": "T2.FIELD_CHAR",\n'
            '    "value": "T2.ATWRT",\n'
            '    "fallback_value": "T2.ATFLV",\n'
            '    "aggregation": "first|sum|mean|min|max|count"\n'
            '  },\n'
            '  "visibleColumns": ["KOLOM1", "KOLOM2", "KOLOM3"],\n'
            '  "sort": {\n'
            '    "column": "KOLOM1",\n'
            '    "direction": "asc|desc"\n'
            '  }\n'
            "}\n"
            "Aturan Sangat Penting:\n"
            "1. PERIKSA current_state (workspace aktif pengguna). Pengguna bekerja pada workspace yang sedang aktif. "
            "Jika workspace saat ini sudah memiliki tabel/sumber data, PERTAHANKAN dan PERBARUI (merge) sesuai instruksi pengguna (misalnya menambahkan filter baru, menambahkan tabel, atau menambah rumus). "
            "Jangan menghapus tabel atau kolom yang sudah ada kecuali pengguna secara eksplisit meminta 'buat baru', 'ganti semua', atau 'reset'.\n"
            "2. Gunakan target server dari current_state.target (kecuali jika pengguna meminta server lain dari daftar allowed_servers).\n"
            "3. Jika pengguna memasukkan kode atau klausa ABAP SQL (seperti ALIAS~FIELD EQ/IN ... atau WHERE ...), parse alias dan field tersebut. "
            "Petakan ke tabel SAP standar yang sesuai (misalnya C -> AUFK, O -> AFKO, OI -> AFPO, B -> MCHB/MSEG/VBAP) atau gunakan tabel yang sudah ada di workspace, dan tambahkan field-field tersebut ke filters.\n"
            "4. Jika pengguna tidak meminta pivot, set \"pivot\": null (atau pertahankan pivot dari current_state.pivot jika ada dan tidak diminta diubah).\n"
            "5. Jika tidak ada kolom hitung baru dan workspace memiliki calculatedColumns, pertahankan calculatedColumns yang sudah ada kecuali diminta dihapus.\n"
            "6. Jika ada join antara T1 dan T2, conditions HARUS menghubungkan field key yang tepat (misal MATNR ke MATNR, VBELN ke VBELN, AUFNR ke AUFNR).\n"
            "7. Kolom expression pada calculatedColumns harus menggunakan tanda kurung siku [ALIAS.FIELD] atau [KOLOM].\n"
            "8. Nilai target harus dari daftar allowed_servers.\n"
            "9. Pemilihan & Pencocokan Kolom Hitung (calculatedColumns):\n"
            "   a. Periksa daftar 'available_columns' (dan 'column_descriptions') pada current_state.\n"
            "   b. PILIH DAN GUNAKAN HANYA kolom-kolom yang benar-benar relevan dengan rumus yang diminta pengguna. Contoh: jika pengguna minta hitung 'berat aktual', telusuri available_columns dan pilih kolom yang relevan seperti 'Panjang Film (Meter)', 'Lebar Film (Milimeter)', 'Grammage'.\n"
            "   c. Beri nama kolom hasil kalkulasi yang relevan, jelas, dan deskriptif (misal 'BERAT AKTUAL', 'TOTAL BIAYA', 'SELISIH QTY').\n"
            "   d. Tuliskan nama kolom sumber di dalam tanda kurung siku [Nama Kolom Riil] PERSIS sama seperti nama di available_columns (contoh: gunakan [Panjang Film (Meter)], JANGAN disingkat menjadi [Panjang]).\n"
            "   e. Jika kolom yang dibutuhkan belum ada di tabel atau query saat ini, tambahkan field SAP yang relevan tersebut ke dalam sources dan joins terlebih dahulu agar datanya tersedia.\n"
            "10. Pemilihan Kolom Tampil (fields & visibleColumns): Hanya sertakan field-field SAP dan kolom yang relevan dengan kebutuhan pelaporan pengguna agar tabel rapi, tidak memuat kolom yang tidak diperlukan.\n"
            "11. Pengolahan Output, Urutan Kolom ALV, Visibilitas & Sorting (Sangat Penting):\n"
            "   a. Memindahkan Urutan Kolom ALV (Reorder / Move Columns):\n"
            "      - Jika pengguna meminta memindahkan kolom (misal 'pindahkan kolom X ke paling depan', 'pindahkan X setelah Y', 'geser Z ke belakang', 'posisikan kolom A di awal'):\n"
            "        Sertakan array 'visibleColumns' secara LENGKAP dengan urutan baru yang diminta pengguna.\n"
            "        Urutkan daftar 'visibleColumns' sedemikian rupa sehingga kolom yang diminta dipindahkan menempati posisi barunya, dan SEMUA kolom lain dari current_state.visible_columns tetap disertakan setelahnya atau disekitarnya.\n"
            "        JANGAN membuang kolom lain kecuali pengguna secara eksplisit meminta 'sembunyikan' atau 'hanya tampilkan'.\n"
            "   b. Menyembunyikan / Memilih Kolom Tertentu (Column Visibility):\n"
            "      - Jika pengguna meminta 'sembunyikan kolom X', sertakan 'visibleColumns' dengan menghapus kolom X dari current_state.visible_columns.\n"
            "      - Jika pengguna meminta 'hanya tampilkan kolom A, B', sertakan 'visibleColumns': [A, B].\n"
            "      - Jika pengguna meminta 'tampilkan semua kolom', sertakan 'visibleColumns' dengan seluruh daftar current_state.available_columns.\n"
            "   c. Mengurutkan Baris Data ALV (Sorting):\n"
            "      - Jika pengguna meminta mengurutkan baris data (misal 'urutkan data berdasarkan tanggal terbaru', 'sort kolom X secara menurun'):\n"
            "        Sertakan objek 'sort': {\"column\": \"NAMA_KOLOM\", \"direction\": \"asc|desc\"}.\n"
            "   d. Melepas Pivot atau Mengatur Tabel:\n"
            "      - Jika pengguna meminta 'lepas pivot' atau 'kembali ke tabel flat', set \"pivot\": null.\n"
            "      - Jika pengguna meminta 'hapus kolom hitung X', hapus kolom X dari array calculatedColumns.\n"
            "12. Jika pengguna hanya meminta pengolahan output (seperti pindah kolom, sembunyikan kolom, ubah pivot, atau urutkan data), TETAP PERTAHANKAN seluruh konfigurasi 'target', 'sources', 'joins', 'calculatedColumns' dari current_state agar query SQL tidak berubah atau ter-reset!\n"
        )
        user_prompt = json.dumps({
            "request": dto.prompt,
            "allowed_servers": [{"id": r["id"], "label": r.get("label")} for r in resources],
            "current_state": dto.current_state,
        }, ensure_ascii=False)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    try:
        raw_content, provider_used = await query_llm_with_fallback(messages)
    except Exception as exc:
        raise HTTPException(502, f"Gagal memanggil penyedia AI: {exc}") from None

    # Clean potential markdown wrapping ```json ... ```
    cleaned = raw_content.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise HTTPException(502, f"Respons AI dari {provider_used} bukan JSON valid: {exc}\nIsi:\n{cleaned[:300]}") from None

    # Canonicalize formula expressions in calculatedColumns to match exact available_columns
    available_cols = dto.current_state.get("available_columns") if isinstance(dto.current_state, dict) else []
    if not isinstance(available_cols, list):
        available_cols = []

    if available_cols and isinstance(data.get("calculatedColumns"), list):
        for calc in data["calculatedColumns"]:
            expr = calc.get("expression")
            if expr:
                refs = extract_referenced_columns(expr)
                for ref in refs:
                    resolved = resolve_column_name(ref, available_cols)
                    if resolved and resolved != ref:
                        expr = expr.replace(f"[{ref}]", f"[{resolved}]")
                calc["expression"] = expr
            fields = calc.get("fields")
            if isinstance(fields, list):
                calc["fields"] = [resolve_column_name(f, available_cols) or f for f in fields]

    # Canonicalize and safeguard visibleColumns (ALV Column Reordering & Visibility)
    curr_vis = dto.current_state.get("visible_columns") if isinstance(dto.current_state, dict) else []
    if not isinstance(curr_vis, list) or not curr_vis:
        curr_vis = list(available_cols)

    raw_vis = data.get("visibleColumns")
    lower_prompt = dto.prompt.lower()
    is_move_intent = any(w in lower_prompt for w in ["pindah", "geser", "depan", "belakang", "tengah", "taruh", "posisi", "urut", "move", "reorder"])
    is_hide_or_only = any(w in lower_prompt for w in ["hanya", "sembunyi", "hide", "buang", "hapus kolom tampil", "only", "hilang"])

    if isinstance(raw_vis, list) and raw_vis:
        resolved_vis = []
        for col in raw_vis:
            r = resolve_column_name(str(col), available_cols) or str(col)
            if r not in resolved_vis:
                resolved_vis.append(r)

        # If user intended to move/reorder columns, preserve all other currently visible columns
        if is_move_intent and not is_hide_or_only and curr_vis:
            for c in curr_vis:
                if c not in resolved_vis and (not available_cols or c in available_cols):
                    resolved_vis.append(c)

        data["visibleColumns"] = resolved_vis
    elif is_move_intent and curr_vis:
        # Fallback if LLM forgot to output visibleColumns when user asked to move a column
        for col in curr_vis:
            sub_col = col.split(".", 1)[-1]
            if (col.lower() in lower_prompt or sub_col.lower() in lower_prompt) and any(w in lower_prompt for w in ["depan", "awal", "pertama", "kiri", "first"]):
                data["visibleColumns"] = [col] + [c for c in curr_vis if c != col]
                break
            elif (col.lower() in lower_prompt or sub_col.lower() in lower_prompt) and any(w in lower_prompt for w in ["belakang", "akhir", "terakhir", "kanan", "last"]):
                data["visibleColumns"] = [c for c in curr_vis if c != col] + [col]
                break

    # Canonicalize sort
    sort_info = data.get("sort")
    if isinstance(sort_info, dict) and sort_info.get("column"):
        resolved_sort = resolve_column_name(str(sort_info["column"]), available_cols) or str(sort_info["column"])
        data["sort"] = {
            "column": resolved_sort,
            "direction": "desc" if str(sort_info.get("direction", "")).lower() == "desc" else "asc"
        }
    elif any(w in lower_prompt for w in ["urutkan data", "urutkan baris", "sort data", "sort baris"]):
        direction = "desc" if any(w in lower_prompt for w in ["terbesar", "terbanyak", "terbaru", "desc", "menurun"]) else "asc"
        for col in curr_vis:
            sub_col = col.split(".", 1)[-1]
            if col.lower() in lower_prompt or sub_col.lower() in lower_prompt:
                data["sort"] = {"column": col, "direction": direction}
                break

    explanation = str(data.get("explanation", ""))
    return {
        "provider": provider_used,
        "explanation": explanation,
        "data": data,
    }


@app.post("/api/ai/draft-query")
async def ai_draft_query(dto: AiDraftIn, auth: tuple[AppSession, str] = Depends(get_token)):
    # Backward compatibility redirect to ai_generate
    res = await ai_generate(
        AiFullAssistantIn(prompt=dto.prompt, context_type="builder", current_state=dto.current_query.model_dump() if dto.current_query else {}),
        auth,
    )
    return {
        "query": res["data"],
        "explanation": res["explanation"],
        "provider": res["provider"],
        "requires_review": True,
    }


@app.post("/api/data/pivot")
async def pivot(dto: PivotIn, auth: tuple[AppSession, str] = Depends(get_token)):
    return pivot_data(dto)


def format_sap_value(val: Any) -> Any:
    if val is None or pd.isna(val):
        return None
    val_str = str(val).strip()
    if not val_str:
        return None
    try:
        f = float(val_str)
        if f.is_integer():
            return int(f)
        return round(f, 6)
    except (ValueError, TypeError):
        return val_str


def pivot_data(dto: PivotIn) -> dict[str, Any]:
    if dto.aggregation not in ("first", "sum", "mean", "count", "min", "max"):
        raise HTTPException(422, "Agregasi tidak didukung.")
    index_fields = [dto.index] if isinstance(dto.index, str) else dto.index
    if not index_fields or len(set(index_fields)) != len(index_fields):
        raise HTTPException(422, "Pilih kolom Baris yang berbeda (tidak boleh duplikat).")
    if len(index_fields) > 100:
        raise HTTPException(422, "Maksimal 100 kolom Baris pivot.")
    frame = pd.DataFrame(dto.rows)
    # A saved pivot can outlive a changed report selection.  Keep any row
    # dimensions that still exist instead of failing the whole report because
    # a former display/filter field is no longer returned by the query.
    index_fields = [name for name in index_fields if name in frame.columns]
    if not index_fields or dto.columns not in frame.columns or dto.values not in frame.columns:
        return {"columns": list(frame.columns), "rows": dto.rows}
    if dto.columns in index_fields or dto.values in index_fields or dto.values == dto.columns:
        raise HTTPException(422, "Kolom Baris, Kolom, dan Nilai harus berbeda.")

    # Apply fallback value if specified (e.g. ATWRT is primary, ATFLV is fallback for numbers)
    if dto.fallback_values and dto.fallback_values in frame.columns and dto.fallback_values != dto.values:
        def coalesce_val(row):
            primary = row.get(dto.values)
            if primary is not None and not (isinstance(primary, float) and math.isnan(primary)):
                primary_str = str(primary).strip()
                if primary_str:
                    return primary_str
            fallback = row.get(dto.fallback_values)
            return format_sap_value(fallback)

        frame[dto.values] = frame.apply(coalesce_val, axis=1)

    try:
        if dto.aggregation in ("sum", "mean"):
            frame[dto.values] = pd.to_numeric(frame[dto.values], errors="coerce")
            if frame[dto.values].notna().sum() == 0:
                raise ValueError("SUM dan AVERAGE memerlukan kolom Nilai berisi angka.")
        result = frame.pivot_table(
            index=index_fields, columns=dto.columns, values=dto.values,
            aggfunc=dto.aggregation, observed=True, dropna=True, sort=False,
        ).reset_index()
        result.columns = [str(x) for x in result.columns]
        rows = json.loads(result.to_json(orient="records", date_format="iso"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, f"Pivot gagal: {exc}") from None
    return {"columns": list(result.columns), "rows": rows}


@app.post("/api/data/calculated-column")
async def calculated_column(dto: CalculatedColumnIn, auth: tuple[AppSession, str] = Depends(get_token)):
    return calculated_column_data(dto)


def evaluate_formula(node: ast.AST, values: dict[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return evaluate_formula(node.body, values)
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return float(node.value)
    if isinstance(node, ast.Name) and node.id in values:
        return values[node.id]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = evaluate_formula(node.operand, values)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
        left, right = evaluate_formula(node.left, values), evaluate_formula(node.right, values)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        return left / right
    raise ValueError("Formula hanya mendukung angka, referensi [KOLOM], +, -, *, /, dan kurung.")


def resolve_column_name(col: str, available_columns: list[str]) -> str | None:
    if col in available_columns:
        return col
    col_upper = col.upper()
    for c in available_columns:
        if c.upper() == col_upper:
            return c
    for c in available_columns:
        if c.split(".", 1)[-1].upper() == col_upper or col.split(".", 1)[-1].upper() == c.upper():
            return c
    matches = [c for c in available_columns if col_upper in c.upper()]
    if len(matches) == 1:
        return matches[0]
    rev_matches = [c for c in available_columns if c.upper() in col_upper]
    if len(rev_matches) == 1:
        return rev_matches[0]
    return None


def extract_referenced_columns(expression: str) -> list[str]:
    # Extracts all column names inside brackets [Column Name]
    return list(dict.fromkeys(re.findall(r"\[([^\]]+)\]", expression)))


def run_formula_rows(rows: list[dict[str, Any]], name: str, expression: str, columns: list[str]) -> list[dict[str, Any]]:
    referenced = extract_referenced_columns(expression)
    col_map: dict[str, str] = {}
    for col in referenced:
        resolved = resolve_column_name(col, columns)
        if not resolved:
            raise HTTPException(422, f"Kolom [{col}] pada rumus tidak ditemukan dalam data laporan.")
        col_map[col] = resolved
    clean_expr = expression
    for i, col in enumerate(referenced):
        clean_expr = clean_expr.replace(f"[{col}]", f"v{i}")
    try:
        tree = ast.parse(clean_expr, mode="eval")
        dummy_vals = {f"v{i}": 1.0 for i in range(len(referenced))}
        try:
            evaluate_formula(tree, dummy_vals)
        except ZeroDivisionError:
            pass
    except (SyntaxError, ValueError, TypeError) as exc:
        raise HTTPException(422, f"Format rumus matematika tidak valid: {exc}") from None
    output = []
    for row in rows:
        values = {}
        for i, col in enumerate(referenced):
            actual_col = col_map[col]
            raw = row.get(actual_col)
            if raw is not None and str(raw).strip() != "":
                try:
                    val = float(str(raw).strip())
                    if math.isfinite(val):
                        values[f"v{i}"] = val
                    else:
                        values[f"v{i}"] = 0.0
                except (ValueError, TypeError):
                    values[f"v{i}"] = 0.0
            else:
                values[f"v{i}"] = 0.0
        try:
            res = evaluate_formula(tree, values)
            if not pd.notna(res) or abs(res) == float("inf"):
                val_res = None
            else:
                val_res = round(res, 6)
        except ZeroDivisionError:
            val_res = None
        except Exception:
            val_res = None
        output.append({**row, name: val_res})
    return output


def calculated_column_data(dto: CalculatedColumnIn) -> dict[str, Any]:
    name = dto.name.strip()
    if not name or len(name) > 100:
        raise HTTPException(422, "Nama kolom hasil tidak valid.")
    columns = list(dict.fromkeys(key for row in dto.rows for key in row))

    # Mode 1: Custom Formula Expression (e.g. ([Panjang] * [Lebar]) / 1000)
    if dto.operation == "custom" or dto.expression:
        expr = (dto.expression or "").strip()
        if not expr:
            raise HTTPException(422, "Rumus formula tidak boleh kosong.")
        output = run_formula_rows(dto.rows, name, expr, columns)
        new_cols = [*columns, name] if name not in columns else columns
        return {"columns": new_cols, "rows": output}

    # Mode 2: Standard Aggregation & Arithmetic
    resolved_fields = [resolve_column_name(field, columns) for field in dto.fields]
    if any(f is None for f in resolved_fields) or len(set(resolved_fields)) != len(resolved_fields):
        raise HTTPException(422, "Pilih kolom sumber yang tersedia dan berbeda.")
    fields_to_use = [f for f in resolved_fields if f is not None]
    aggregate = dto.operation in ("sum", "average", "min", "max")
    binary = dto.operation in ("subtract", "multiply", "divide")
    if not aggregate and not binary:
        raise HTTPException(422, "Operasi kolom tidak valid.")
    if dto.operation == "divide" and len(fields_to_use) != 2:
        raise HTTPException(422, "Operasi pembagian memerlukan tepat 2 kolom sumber.")
    if len(fields_to_use) < 2 and (binary or dto.operation in ("sum", "average")):
        raise HTTPException(422, "Pilih minimal 2 kolom sumber.")
    output = []
    for row in dto.rows:
        values = []
        for field in fields_to_use:
            raw = row.get(field)
            try:
                parsed = float(raw) if raw not in (None, "") else None
                values.append(parsed if parsed is not None and math.isfinite(parsed) else None)
            except (TypeError, ValueError):
                values.append(None)
        numbers = [value for value in values if value is not None]
        value = None
        if aggregate and numbers:
            value = {"sum": lambda: sum(numbers), "average": lambda: sum(numbers) / len(numbers),
                     "min": lambda: min(numbers), "max": lambda: max(numbers)}[dto.operation]()
        elif binary and len(values) == len(fields_to_use) and all(v is not None for v in values):
            if dto.operation == "subtract":
                res = values[0]
                for v in values[1:]:
                    res -= v
                value = res
            elif dto.operation == "multiply":
                res = 1.0
                for v in values:
                    res *= v
                value = res
            elif dto.operation == "divide" and len(values) == 2 and values[1] != 0:
                value = values[0] / values[1]
        output.append({**row, name: round(value, 6) if value is not None else None})
    new_cols = [*columns, name] if name not in columns else columns
    return {"columns": new_cols, "rows": output}


def apply_report_presentation(rows: list[dict[str, Any]], presentation: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not presentation:
        return rows
    calcs = presentation.get("calculatedColumns") or []
    pivot_config = presentation.get("pivot")
    
    # Run calculations that target pre-pivot columns first
    remaining_calcs = []
    for calculation in calcs:
        current_cols = list(dict.fromkeys(k for r in rows for k in r))
        req_fields = calculation.get("fields", [])
        if calculation.get("expression"):
            req_fields = extract_referenced_columns(calculation["expression"])
        resolved_fields = [resolve_column_name(f, current_cols) for f in req_fields]
        if resolved_fields and all(f is not None for f in resolved_fields):
            col_payload = dict(calculation)
            if calculation.get("expression"):
                new_expr = calculation["expression"]
                for old_f, new_f in zip(req_fields, resolved_fields):
                    if new_f and old_f != new_f:
                        new_expr = new_expr.replace(f"[{old_f}]", f"[{new_f}]")
                col_payload["expression"] = new_expr
            elif calculation.get("fields"):
                col_payload["fields"] = resolved_fields
            rows = calculated_column_data(CalculatedColumnIn(rows=rows, **col_payload))["rows"]
        else:
            remaining_calcs.append(calculation)
            
    if pivot_config:
        rows = pivot_data(PivotIn(
            rows=rows,
            index=pivot_config["rows"],
            columns=pivot_config["column"],
            values=pivot_config["value"],
            fallback_values=pivot_config.get("fallback_value") or pivot_config.get("fallback_values"),
            aggregation=pivot_config["aggregation"],
        ))["rows"]
                                  
    # Run any remaining calculations that target post-pivot columns
    for calculation in remaining_calcs:
        current_cols = list(dict.fromkeys(k for r in rows for k in r))
        req_fields = calculation.get("fields", [])
        if calculation.get("expression"):
            req_fields = extract_referenced_columns(calculation["expression"])
        resolved_fields = [resolve_column_name(f, current_cols) for f in req_fields]
        if resolved_fields and all(f is not None for f in resolved_fields):
            col_payload = dict(calculation)
            if calculation.get("expression"):
                new_expr = calculation["expression"]
                for old_f, new_f in zip(req_fields, resolved_fields):
                    if new_f and old_f != new_f:
                        new_expr = new_expr.replace(f"[{old_f}]", f"[{new_f}]")
                col_payload["expression"] = new_expr
            elif calculation.get("fields"):
                col_payload["fields"] = resolved_fields
            rows = calculated_column_data(CalculatedColumnIn(rows=rows, **col_payload))["rows"]

    visible = presentation.get("visibleColumns")
    if visible:
        calc_names = [c["name"] for c in calcs if c.get("name")]
        all_visible = list(dict.fromkeys([*visible, *calc_names]))
        rows = [{key: row.get(key) for key in all_visible if key in row} for row in rows]
    return rows


@app.post("/api/data/formula")
async def formula(dto: FormulaIn, auth: tuple[AppSession, str] = Depends(get_token)):
    name = dto.name.strip()
    if not name:
        raise HTTPException(422, "Nama kolom formula tidak boleh kosong.")
    columns = list(dict.fromkeys(k for row in dto.rows for k in row))
    output = run_formula_rows(dto.rows, name, dto.expression, columns)
    new_cols = [*columns, name] if name not in columns else columns
    return {"columns": new_cols, "rows": output}


@app.post("/api/sap/compare")
async def compare(dto: CompareIn, auth: tuple[AppSession, str] = Depends(get_token)):
    if dto.target == dto.other_target:
        raise HTTPException(422, "Pilih dua server SAP yang berbeda.")
    catalog = await user_catalog(auth[1])
    source = match_target(catalog, dto.target)
    comparison = match_target(catalog, dto.other_target)
    source_fields, _ = await get_structure(auth[1], source, dto.table_name)
    comparison_fields, _ = await get_structure(auth[1], comparison, dto.table_name)
    fields = [field["name"] for field in source_fields]
    if not fields or set(fields) != {field["name"] for field in comparison_fields}:
        raise HTTPException(422, "Struktur field tabel berbeda atau tidak tersedia pada kedua server.")
    if len(fields) > 100:
        raise HTTPException(422, "Tabel memiliki lebih dari 100 field; gateway belum mendukung pembacaan semua field sekaligus.")
    source_keys = {field["name"] for field in source_fields if field["is_key"]}
    comparison_keys = {field["name"] for field in comparison_fields if field["is_key"]}
    if source_keys != comparison_keys or not source_keys:
        raise HTTPException(422, "Key tabel tidak tersedia atau berbeda pada kedua server.")
    # SAP client numbers may differ across DEV, QA, and PRD.
    keys = [field for field in fields if field in source_keys and (field != "MANDT" or len(source_keys) == 1)]
    if not keys:
        raise HTTPException(422, "Tabel tidak memiliki key bisnis yang dapat digunakan.")
    for item in dto.filters:
        if item.field.upper() not in fields:
            raise HTTPException(422, f"Field filter {item.field} tidak ada pada tabel.")
    left = await read_rows(ReadIn(target=dto.target, table_name=dto.table_name, fields=fields,
                                  filters=dto.filters, rowcount=dto.rowcount), auth[1])
    right = await read_rows(ReadIn(target=dto.other_target, table_name=dto.table_name, fields=fields,
                                   filters=dto.filters, rowcount=dto.rowcount), auth[1])
    def indexed(rows):
        out = {}
        for row in rows:
            key = tuple(str(row.get(k, "")) for k in keys)
            if key in out:
                raise HTTPException(422, "Key perbandingan tidak unik pada salah satu target.")
            out[key] = row
        return out
    a, b = indexed(left), indexed(right)
    rows = []
    for key in sorted(a.keys() | b.keys()):
        old, new = a.get(key), b.get(key)
        changed_fields = [field for field in fields if old and new and old.get(field) != new.get(field)]
        rows.append({"key": dict(zip(keys, key)),
                     "status": "only_left" if old is not None and new is None else
                               "only_right" if old is None and new is not None else
                               "changed" if changed_fields else "same",
                     "changed_fields": changed_fields, "left": old, "right": new})
    # A full page may have more rows behind it; the gateway read contract has no cursor.
    complete = len(left) < dto.rowcount and len(right) < dto.rowcount
    return {"left_count": len(left), "right_count": len(right), "rows": rows,
            "fields": fields, "key_fields": keys, "complete": complete, "row_limit": dto.rowcount}


@app.get("/api/reports")
async def list_reports(auth: tuple[AppSession, str] = Depends(get_token), db: Session = Depends(get_db)):
    rows = db.scalars(select(Report).where(Report.owner_id == auth[0].user_id).order_by(Report.updated_at.desc())).all()
    return [{"id": r.id, "name": r.name, "definition": r.definition} for r in rows]


@app.get("/api/reports/shared")
async def list_shared_reports(auth: tuple[AppSession, str] = Depends(get_token), db: Session = Depends(get_db)):
    current_username = (auth[0].user_profile.get("username", "") if isinstance(auth[0].user_profile, dict) else "").strip()
    user_cond = []
    if auth[0].user_id:
        user_cond.append(ReportShare.shared_with_user_id == auth[0].user_id)
    if current_username:
        user_cond.append(func.lower(ReportShare.shared_with_username) == current_username.lower())
    if not user_cond:
        return []

    shares = db.scalars(
        select(ReportShare)
        .where(or_(*user_cond))
        .order_by(ReportShare.created_at.desc())
    ).all()
    if not shares:
        return []

    report_ids = list({s.report_id for s in shares})
    reports = db.scalars(select(Report).where(Report.id.in_(report_ids))).all()
    report_map = {r.id: r for r in reports}

    owner_ids = list({r.owner_id for r in reports})
    owner_sessions = db.scalars(select(AppSession).where(AppSession.user_id.in_(owner_ids))).all()
    owner_map = {}
    for s in owner_sessions:
        if isinstance(s.user_profile, dict) and s.user_profile.get("username"):
            owner_map[s.user_id] = s.user_profile["username"]

    result = []
    seen = set()
    for s in shares:
        r = report_map.get(s.report_id)
        if not r or r.id in seen:
            continue
        seen.add(r.id)
        shared_by = s.shared_by_username or owner_map.get(r.owner_id) or "Pengguna Lain"
        result.append({
            "id": r.id,
            "name": r.name,
            "definition": r.definition,
            "permission": s.permission,
            "shared_by": shared_by,
            "share_id": s.id,
            "updated_at": r.updated_at.isoformat() if r.updated_at else "",
        })
    return result


@app.get("/api/users")
async def list_available_users(auth: tuple[AppSession, str] = Depends(get_token), db: Session = Depends(get_db)):
    current_username = (auth[0].user_profile.get("username", "") if isinstance(auth[0].user_profile, dict) else "").strip().upper()
    users_dict: dict[str, dict[str, Any]] = {}

    # 1. Ambil data pengguna asli dari database OIDC (ai_auth.users)
    if auth_engine:
        try:
            with auth_engine.connect() as aconn:
                rows = aconn.execute(
                    text("SELECT username, email, role FROM users WHERE is_active = TRUE ORDER BY username ASC")
                ).fetchall()
                for r in rows:
                    u_name = (r[0] or "").strip()
                    if u_name:
                        u_key = u_name.upper()
                        if u_key != current_username:
                            email_val = (r[1] or "").strip()
                            raw_role = (r[2] or "USER").strip().upper()
                            display_role = "Superadmin" if raw_role == "SUPERADMIN" else ("User" if raw_role == "USER" else raw_role.title())
                            users_dict[u_key] = {
                                "username": u_name,
                                "name": email_val or u_name,
                                "role": display_role
                            }
        except Exception:
            pass

    # 2. Enrich dengan profil sesi login lokal (jika ada nama lengkap atau role kustom)
    try:
        sessions = db.scalars(select(AppSession)).all()
        for s in sessions:
            if isinstance(s.user_profile, dict):
                u_name = (s.user_profile.get("username") or "").strip()
                if u_name:
                    u_key = u_name.upper()
                    if u_key != current_username:
                        prof_name = (s.user_profile.get("name") or s.user_profile.get("email") or "").strip()
                        prof_role = (s.user_profile.get("role") or "").strip()
                        if u_key in users_dict:
                            if prof_name and prof_name != u_name:
                                users_dict[u_key]["name"] = prof_name
                            if prof_role:
                                users_dict[u_key]["role"] = prof_role.title() if prof_role.isupper() else prof_role
                        else:
                            users_dict[u_key] = {
                                "username": u_name,
                                "name": prof_name or u_name,
                                "role": prof_role or "User"
                            }
    except Exception:
        pass

    return sorted(users_dict.values(), key=lambda x: x["username"])


@app.get("/api/reports/{report_id}/shares")
async def list_report_shares(report_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                             db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row or row.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan atau Anda bukan pemilik laporan.")
    shares = db.scalars(
        select(ReportShare)
        .where(ReportShare.report_id == report_id)
        .order_by(ReportShare.created_at.desc())
    ).all()
    return [{
        "id": s.id,
        "report_id": s.report_id,
        "shared_with_username": s.shared_with_username,
        "permission": s.permission,
        "created_at": s.created_at.isoformat() if s.created_at else "",
        "updated_at": s.updated_at.isoformat() if s.updated_at else ""
    } for s in shares]


@app.post("/api/reports/{report_id}/shares")
async def create_or_update_report_share(report_id: str, dto: ReportShareIn,
                                       auth: tuple[AppSession, str] = Depends(get_token),
                                       db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row or row.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan atau Anda bukan pemilik laporan.")

    target_username = dto.username.strip()
    if not target_username:
        raise HTTPException(400, "Username target tidak boleh kosong.")

    current_username = (auth[0].user_profile.get("username", "") if isinstance(auth[0].user_profile, dict) else "").strip()
    if target_username.lower() == current_username.lower():
        raise HTTPException(400, "Tidak dapat membagikan laporan ke akun sendiri.")

    target_sessions = db.scalars(select(AppSession)).all()
    target_user_id = None
    for s in target_sessions:
        if isinstance(s.user_profile, dict) and (s.user_profile.get("username") or "").lower() == target_username.lower():
            target_user_id = s.user_id
            break

    existing = db.scalars(select(ReportShare).where(
        ReportShare.report_id == report_id,
        func.lower(ReportShare.shared_with_username) == target_username.lower()
    )).first()

    owner_username = current_username or "Owner"
    if existing:
        existing.permission = dto.permission
        existing.updated_at = utcnow()
        if target_user_id and not existing.shared_with_user_id:
            existing.shared_with_user_id = target_user_id
        db.commit()
        return {
            "id": existing.id,
            "report_id": existing.report_id,
            "shared_with_username": existing.shared_with_username,
            "permission": existing.permission,
            "created_at": existing.created_at.isoformat() if existing.created_at else "",
            "updated_at": existing.updated_at.isoformat() if existing.updated_at else ""
        }

    new_share = ReportShare(
        report_id=report_id,
        shared_by_id=auth[0].user_id,
        shared_by_username=owner_username,
        shared_with_username=target_username,
        shared_with_user_id=target_user_id,
        permission=dto.permission,
    )
    db.add(new_share)
    db.commit()
    return {
        "id": new_share.id,
        "report_id": new_share.report_id,
        "shared_with_username": new_share.shared_with_username,
        "permission": new_share.permission,
        "created_at": new_share.created_at.isoformat() if new_share.created_at else "",
        "updated_at": new_share.updated_at.isoformat() if new_share.updated_at else ""
    }


@app.delete("/api/reports/{report_id}/shares/{share_id}")
async def delete_report_share(report_id: str, share_id: str,
                             auth: tuple[AppSession, str] = Depends(get_token),
                             db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row or row.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan atau Anda bukan pemilik laporan.")
    share = db.get(ReportShare, share_id)
    if not share or share.report_id != report_id:
        raise HTTPException(404, "Data share tidak ditemukan.")
    db.delete(share)
    db.commit()
    return {"success": True}


@app.post("/api/reports")
async def create_report(dto: ReportIn, auth: tuple[AppSession, str] = Depends(get_token),
                        db: Session = Depends(get_db)):
    row = Report(owner_id=auth[0].user_id, name=dto.name, definition=dto.definition)
    db.add(row)
    db.commit()
    return {"id": row.id, "name": row.name}


@app.put("/api/reports/{report_id}")
async def update_report(report_id: str, dto: ReportIn,
                        auth: tuple[AppSession, str] = Depends(get_token),
                        db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    if row.owner_id != auth[0].user_id:
        current_username = (auth[0].user_profile.get("username", "") if isinstance(auth[0].user_profile, dict) else "").strip()
        share = check_report_share_access(db, report_id, auth[0].user_id, current_username)
        if not share:
            raise HTTPException(404, "Laporan tidak ditemukan.")
        if share.permission != "edit":
            raise HTTPException(403, "Anda hanya memiliki izin melihat (view) untuk laporan ini. Gunakan 'Simpan Sebagai Baru' untuk menduplikasi laporan.")
    row.name = dto.name
    row.definition = dto.definition
    db.commit()
    return {"id": row.id, "name": row.name}


@app.patch("/api/reports/{report_id}/rename")
async def rename_report(report_id: str, dto: ReportRenameIn,
                        auth: tuple[AppSession, str] = Depends(get_token),
                        db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    if row.owner_id != auth[0].user_id:
        current_username = (auth[0].user_profile.get("username", "") if isinstance(auth[0].user_profile, dict) else "").strip()
        share = check_report_share_access(db, report_id, auth[0].user_id, current_username)
        if not share:
            raise HTTPException(404, "Laporan tidak ditemukan.")
        if share.permission != "edit":
            raise HTTPException(403, "Anda tidak memiliki izin untuk mengubah nama laporan ini.")
    row.name = dto.name.strip()
    db.commit()
    return {"id": row.id, "name": row.name}


@app.delete("/api/reports/{report_id}")
async def delete_report(report_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                        db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row or row.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    db.query(Variant).filter(Variant.report_id == row.id, Variant.owner_id == auth[0].user_id).delete()
    db.query(ReportSchedule).filter(ReportSchedule.report_id == row.id, ReportSchedule.owner_id == auth[0].user_id).delete()
    db.query(ReportShare).filter(ReportShare.report_id == row.id).delete()
    db.delete(row)
    db.commit()
    return {"success": True}


@app.get("/api/reports/{report_id}/variants")
async def list_variants(report_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                        db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    if row.owner_id != auth[0].user_id:
        current_username = (auth[0].user_profile.get("username", "") if isinstance(auth[0].user_profile, dict) else "").strip()
        share = check_report_share_access(db, report_id, auth[0].user_id, current_username)
        if not share:
            raise HTTPException(404, "Laporan tidak ditemukan.")
    variants = db.scalars(select(Variant).where(Variant.report_id == report_id)).all()
    return [{"id": v.id, "name": v.name, "layout": v.layout} for v in variants]


@app.post("/api/reports/{report_id}/variants")
async def create_variant(report_id: str, dto: VariantIn, auth: tuple[AppSession, str] = Depends(get_token),
                         db: Session = Depends(get_db)):
    report = db.get(Report, report_id)
    if not report or report.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    row = Variant(owner_id=auth[0].user_id, report_id=report_id, name=dto.name, layout=dto.layout)
    db.add(row)
    db.commit()
    return {"id": row.id, "name": row.name}


@app.get("/api/compare-variants")
async def list_compare_variants(auth: tuple[AppSession, str] = Depends(get_token),
                                db: Session = Depends(get_db)):
    variants = db.scalars(
        select(CompareVariant)
        .where(CompareVariant.owner_id == auth[0].user_id)
        .order_by(CompareVariant.created_at.desc())
    ).all()
    return [{"id": v.id, "name": v.name, "config": v.config, "created_at": v.created_at.isoformat()} for v in variants]


@app.post("/api/compare-variants")
async def create_compare_variant(dto: CompareVariantIn, auth: tuple[AppSession, str] = Depends(get_token),
                                 db: Session = Depends(get_db)):
    row = CompareVariant(owner_id=auth[0].user_id, name=dto.name, config=dto.config)
    db.add(row)
    db.commit()
    return {"id": row.id, "name": row.name, "config": row.config}


@app.delete("/api/compare-variants/{variant_id}")
async def delete_compare_variant(variant_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                                 db: Session = Depends(get_db)):
    row = db.get(CompareVariant, variant_id)
    if not row or row.owner_id != auth[0].user_id:
        raise HTTPException(404, "Variant perbandingan tidak ditemukan.")
    db.delete(row)
    db.commit()
    return {"success": True}


@app.get("/api/report-runs")
async def report_runs(auth: tuple[AppSession, str] = Depends(get_token),
                      db: Session = Depends(get_db)):
    rows = db.scalars(
        select(ReportRun).where(ReportRun.owner_id == auth[0].user_id)
        .order_by(ReportRun.started_at.desc()).limit(50)
    ).all()
    return [{"id": row.id, "report_id": row.report_id, "status": row.status,
             "row_count": row.row_count, "error": row.error,
             "has_artifact": row.artifact is not None,
             "started_at": row.started_at.isoformat()} for row in rows]


@app.get("/api/report-runs/{run_id}/download")
async def download_report_run(run_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                              db: Session = Depends(get_db)):
    run = db.get(ReportRun, run_id)
    if not run or run.owner_id != auth[0].user_id or run.artifact is None:
        raise HTTPException(404, "File laporan tidak ditemukan.")
    return StreamingResponse(io.BytesIO(run.artifact),
                             media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="lumina-{run.id}.xlsx"'})


@app.get("/api/schedules/status")
async def schedule_status(auth: tuple[AppSession, str] = Depends(get_token)):
    return {"delegation_days": settings.schedule_delegation_days}


@app.get("/api/schedules")
async def list_schedules(auth: tuple[AppSession, str] = Depends(get_token),
                         db: Session = Depends(get_db)):
    rows = db.scalars(
        select(ReportSchedule).where(ReportSchedule.owner_id == auth[0].user_id)
        .order_by(ReportSchedule.created_at.desc())
    ).all()
    return [{"id": row.id, "report_id": row.report_id, "interval_minutes": row.interval_minutes,
             "enabled": row.enabled,
             "next_run_at": row.next_run_at.isoformat(),
             "last_run_at": row.last_run_at.isoformat() if row.last_run_at else None,
             "last_status": row.last_status, "last_error": row.last_error} for row in rows]


def authorize_schedule(db: Session, schedule_id: str, owner_id: str) -> ReportSchedule:
    row = db.get(ReportSchedule, schedule_id)
    if not row or row.owner_id != owner_id:
        raise HTTPException(404, "Jadwal tidak ditemukan.")
    return row


def extend_delegation(session: AppSession) -> None:
    session.expires_at = max(session.expires_at,
                             utcnow() + timedelta(days=settings.schedule_delegation_days))


@app.post("/api/schedules")
async def create_schedule(dto: ScheduleIn, auth: tuple[AppSession, str] = Depends(get_token),
                          db: Session = Depends(get_db)):
    report = db.get(Report, dto.report_id)
    if not report or report.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    extend_delegation(auth[0])
    row = ReportSchedule(
        owner_id=auth[0].user_id, report_id=report.id, session_id=auth[0].id,
        interval_minutes=dto.interval_minutes,
        next_run_at=utcnow() + timedelta(minutes=dto.interval_minutes),
    )
    db.add(row)
    db.commit()
    return {"id": row.id, "next_run_at": row.next_run_at.isoformat()}


@app.put("/api/schedules/{schedule_id}")
async def toggle_schedule(schedule_id: str, dto: ScheduleToggleIn,
                          auth: tuple[AppSession, str] = Depends(get_token),
                          db: Session = Depends(get_db)):
    row = authorize_schedule(db, schedule_id, auth[0].user_id)
    if dto.enabled:
        extend_delegation(auth[0])
        row.session_id = auth[0].id
        row.next_run_at = utcnow() + timedelta(minutes=row.interval_minutes)
        row.last_error = None
    row.enabled = dto.enabled
    db.commit()
    return {"success": True}


@app.delete("/api/schedules/{schedule_id}")
async def delete_schedule(schedule_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                          db: Session = Depends(get_db)):
    row = authorize_schedule(db, schedule_id, auth[0].user_id)
    db.delete(row)
    db.commit()
    return {"success": True}


@app.post("/api/schedules/{schedule_id}/run-now")
async def run_schedule_now(schedule_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                           db: Session = Depends(get_db)):
    row = authorize_schedule(db, schedule_id, auth[0].user_id)
    if not row.enabled:
        raise HTTPException(422, "Aktifkan jadwal dahulu.")
    if row.last_status == "running":
        raise HTTPException(409, "Jadwal sedang dijalankan.")
    row.last_status = "running"
    row.next_run_at = utcnow() + timedelta(minutes=row.interval_minutes)
    db.commit()
    from .worker import execute_schedule
    await execute_schedule(schedule_id)
    db.expire_all()
    updated = db.get(ReportSchedule, schedule_id)
    return {"success": updated.last_status == "success",
            "status": updated.last_status, "error": updated.last_error}


@app.post("/api/data/export")
async def export_xlsx(dto: ExportIn, auth: tuple[AppSession, str] = Depends(get_token)):
    content = make_xlsx(dto.rows, dto.mask_fields, dto.drop_duplicates)
    return StreamingResponse(io.BytesIO(content), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": 'attachment; filename="lumina-report.xlsx"'})


def make_xlsx(rows: list[dict[str, Any]], mask_fields: list[str] | None = None,
              drop_duplicates: bool = False) -> bytes:
    columns = list(dict.fromkeys(k for row in rows for k in row))
    if len(columns) > 100:
        raise HTTPException(422, "Maksimal 100 kolom.")
    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("Report")
    sheet.append(columns)
    seen = set()
    for row in rows:
        values = []
        for key in columns:
            field = key.rsplit(".", 1)[-1].upper()
            mask = key in (mask_fields or []) or field in settings.export_mask_fields
            value = "***" if mask and row.get(key) not in (None, "") else str(row.get(key, ""))
            if value.startswith(("=", "+", "-", "@")):
                value = "'" + value
            values.append(value)
        values = tuple(values)
        if drop_duplicates and values in seen:
            continue
        seen.add(values)
        sheet.append(values)
    stream = io.BytesIO()
    workbook.save(stream)
    return stream.getvalue()


# Serve the built React app from the same origin as the BFF when available.
frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
