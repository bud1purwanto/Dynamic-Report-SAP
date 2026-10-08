import base64
import asyncio
import ast
import hashlib
import io
import json
import re
import secrets
from datetime import timedelta
from pathlib import Path
from typing import Any
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
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from .config import settings
from .db import AppSession, Report, ReportRun, ReportSchedule, Variant, get_db, init_db, utcnow


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


@app.on_event("startup")
def startup() -> None:
    init_db()


def secure_cookie_for(request: Request) -> bool:
    return request.url.scheme == "https" if settings.cookie_secure is None else settings.cookie_secure


class LoginIn(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class CredentialIn(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class FilterIn(BaseModel):
    field: str
    operator: str = "EQ"
    value: str = Field(max_length=80)


class ReadIn(BaseModel):
    target: str = Field(min_length=1)
    table_name: str
    fields: list[str] = Field(min_length=1, max_length=100)
    filters: list[FilterIn] = Field(default_factory=list, max_length=10)
    rowcount: int = Field(default=100, ge=1, le=1000)


class StructureIn(BaseModel):
    target: str
    table_name: str


class TableSearchIn(BaseModel):
    target: str
    query: str = ""
    limit: int = Field(default=30, ge=1, le=100)


class PivotIn(BaseModel):
    rows: list[dict[str, Any]] = Field(max_length=10000)
    index: str
    columns: str
    values: str
    aggregation: str = "first"


class FormulaIn(BaseModel):
    rows: list[dict[str, Any]] = Field(max_length=10000)
    name: str
    expression: str = Field(min_length=1, max_length=500)


class CompareIn(ReadIn):
    other_target: str
    key_fields: list[str] = Field(min_length=1, max_length=10)


class SourceIn(BaseModel):
    alias: str
    table_name: str
    fields: list[str] = Field(default_factory=list, max_length=100)
    filters: list[FilterIn] = Field(default_factory=list, max_length=10)


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
    sources: list[SourceIn] = Field(min_length=1, max_length=3)
    joins: list[JoinIn] = []
    rowcount: int = Field(default=100, ge=1, le=1000)
    report_id: str | None = None


class ReportIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    definition: dict[str, Any]


class VariantIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    layout: dict[str, Any]


class ExportIn(BaseModel):
    rows: list[dict[str, Any]] = Field(max_length=10000)
    mask_fields: list[str] = []
    drop_duplicates: bool = False


class AiDraftIn(BaseModel):
    prompt: str = Field(min_length=5, max_length=2000)
    current_query: QueryIn | None = None


class ScheduleIn(BaseModel):
    report_id: str
    interval_minutes: int = Field(ge=5, le=10080)


class ScheduleToggleIn(BaseModel):
    enabled: bool


def fail_upstream(res: httpx.Response, service: str) -> None:
    if res.status_code in (401, 403):
        raise HTTPException(401, f"Sesi atau izin {service} tidak valid.")
    if res.status_code >= 400:
        raise HTTPException(502, f"{service} gagal (HTTP {res.status_code}).")


def friendly_sap_error(message: str, target: str) -> str:
    lower = message.lower()
    if any(x in lower for x in ("rfc_logon_failure", "rc: 103", "password logon")):
        return f"Logon SAP {target} gagal. Perbarui username atau password SAP Anda."
    if "account locked" in lower or "user locked" in lower:
        return f"Akun SAP Anda pada {target} terkunci. Hubungi tim Basis."
    if "s_rfc" in lower or "no rfc authorization" in lower:
        return f"Akun SAP Anda tidak memiliki izin untuk operasi ini pada {target}."
    if any(x in lower for x in ("econnrefused", "connect to sap gateway failed", "timeout")):
        return f"Koneksi ke SAP {target} sedang gagal."
    return f"Gateway SAP gagal: {message[:300]}"


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
                fail_upstream(res, "Koneksi MCP")
                connections.extend(res.json())
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(502, "Daftar koneksi MCP tidak tersedia.") from None
    output = []
    for resource in resources:
        connection = next((c for c in connections if c.get("resourceKey") == resource.get("resource_key")), None)
        output.append({
            **resource,
            "id": connection["id"] if connection else resource["resource_key"],
            "connection_id": connection["id"] if connection else None,
        })
    return output


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
        fail_upstream(res, "MCP Gateway")
        data = res.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, f"MCP Gateway untuk {target} tidak dapat dihubungi.") from None
    if data.get("error"):
        raise HTTPException(502, friendly_sap_error(str(data["error"].get("message", data["error"])), target))
    result = data.get("result", {})
    if result.get("isError"):
        messages = [str(c.get("text", "")) for c in result.get("content", [])]
        raise HTTPException(502, friendly_sap_error(" ".join(messages), target))
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
                fields.append({
                    "name": name.upper(),
                    "is_key": bool(field.get("is_key") or field.get("key") or field.get("KEYFLAG") == "X"),
                    "data_type": str(field.get("data_type") or field.get("datatype") or field.get("DATATYPE") or ""),
                    "check_table": str(field.get("check_table") or field.get("CHECKTABLE") or ""),
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
                        "check_table": "",
                    })
            if fields:
                return fields, text_body
    return [], text_body


async def get_structure(token: str, target: dict[str, Any], table_name: str) -> tuple[list[dict[str, Any]], str]:
    if not IDENT.fullmatch(table_name):
        raise HTTPException(422, "Nama tabel tidak valid.")
    result = await rpc_call(token, str(target["id"]), "mcp-sap__read_table_structure", {
        "object_name": table_name.upper(),
        "object_type": "TABLE",
        "resource_key": target["resource_key"],
    })
    return parse_structure(result)


async def read_rows(dto: ReadIn, token: str) -> list[dict[str, Any]]:
    target = match_target(await user_catalog(token), dto.target)
    if not IDENT.fullmatch(dto.table_name) or any(not IDENT.fullmatch(f) for f in dto.fields):
        raise HTTPException(422, "Nama tabel atau field tidak valid.")
    where = []
    operators = {"EQ": "=", "NE": "<>", "GT": ">", "GE": ">=", "LT": "<", "LE": "<="}
    for item in dto.filters:
        if not IDENT.fullmatch(item.field) or item.operator not in operators:
            raise HTTPException(422, "Filter SAP tidak valid.")
        escaped = item.value.replace("'", "''")
        condition = f"{item.field.upper()} {operators[item.operator]} '{escaped}'"
        if len(condition) > 72:
            raise HTTPException(422, "Filter SAP terlalu panjang.")
        where.append(condition)
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
        combined = " AND ".join(where)
        if len(combined) > 72:
            raise HTTPException(422, "Gabungan filter SAP melebihi 72 karakter.")
        arguments["where"] = [combined]
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


@app.get("/api/sap/credentials")
async def credentials(auth: tuple[AppSession, str] = Depends(get_token)):
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(
            f"{settings.oidc_issuer}/v1/mcp/sap-credentials/mine",
            headers={"Authorization": f"Bearer {auth[1]}"},
        )
    fail_upstream(res, "Vault OIDC")
    rows = res.json()
    return [{"connectionId": r.get("connectionId"),
             "hasCredential": bool(r.get("configured", r.get("hasCredential", False))),
             "username": r.get("username")} for r in rows]


@app.put("/api/sap/credentials/{connection_id}")
async def save_credential(connection_id: str, dto: CredentialIn,
                          auth: tuple[AppSession, str] = Depends(get_token)):
    row = match_target(await user_catalog(auth[1]), connection_id)
    if not row.get("connection_id"):
        raise HTTPException(422, "ID koneksi SAP belum ditemukan dalam katalog MCP.")
    cid = quote(str(row["connection_id"]), safe="")
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.put(
            f"{settings.oidc_issuer}/v1/mcp/sap-credentials/{cid}",
            json=dto.model_dump(),
            headers={"Authorization": f"Bearer {auth[1]}"},
        )
    fail_upstream(res, "Vault OIDC")
    return {"success": True}


@app.delete("/api/sap/credentials/{connection_id}")
async def delete_credential(connection_id: str, auth: tuple[AppSession, str] = Depends(get_token)):
    row = match_target(await user_catalog(auth[1]), connection_id)
    if not row.get("connection_id"):
        raise HTTPException(422, "ID koneksi SAP belum ditemukan dalam katalog MCP.")
    cid = quote(str(row["connection_id"]), safe="")
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.delete(
            f"{settings.oidc_issuer}/v1/mcp/sap-credentials/{cid}",
            headers={"Authorization": f"Bearer {auth[1]}"},
        )
    fail_upstream(res, "Vault OIDC")
    return {"success": True}


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

        if source_idx > 0:
            for join in dto.joins:
                if join.right_alias == source.alias and join.left_alias in frames:
                    left_df = frames[join.left_alias]
                    conditions = join.conditions or ([JoinConditionIn(left_field=join.left_field, right_field=join.right_field)]
                                                     if join.left_field and join.right_field else [])
                    for cond in conditions:
                        left_col = f"{join.left_alias}.{cond.left_field.upper()}"
                        right_col = cond.right_field.upper()
                        upstream_source = next((s for s in dto.sources if s.alias == join.left_alias), None)
                        has_upstream_filter = bool(upstream_source and any(f.value.strip() for f in upstream_source.filters))
                        if has_upstream_filter and not any(f.field.upper() == right_col for f in source_filters) and left_col in left_df.columns:
                            distinct_vals = [
                                str(v).strip() for v in left_df[left_col].dropna().unique()
                                if str(v).strip() and str(v).strip() != "0"
                            ]
                            if len(distinct_vals) == 1:
                                source_filters.append(FilterIn(field=right_col, operator="EQ", value=distinct_vals[0]))
                            elif len(distinct_vals) == 0 and len(left_df) > 0:
                                warnings.append(
                                    f"Field {cond.left_field} pada tabel {join.left_alias} kosong atau 0 untuk data terpilih."
                                )

        rows = await read_rows(ReadIn(target=dto.target, table_name=source.table_name,
                                      fields=fields, filters=source_filters,
                                      rowcount=dto.rowcount), token)
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


@app.post("/api/sap/query")
async def run_query(dto: QueryIn, auth: tuple[AppSession, str] = Depends(get_token),
                    db: Session = Depends(get_db)):
    report_id = dto.report_id
    if report_id:
        report = db.get(Report, report_id)
        if not report or report.owner_id != auth[0].user_id:
            report_id = None
    try:
        result = await execute_query(dto, auth[1])
    except HTTPException as exc:
        db.add(ReportRun(owner_id=auth[0].user_id, report_id=report_id, definition=dto.model_dump(),
                         status="error", error=str(exc.detail)[:500]))
        db.commit()
        raise
    db.add(ReportRun(owner_id=auth[0].user_id, report_id=report_id, definition=dto.model_dump(),
                     status="success", row_count=len(result["rows"])))
    db.commit()
    return result


@app.get("/api/ai/status")
async def ai_status(auth: tuple[AppSession, str] = Depends(get_token)):
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(f"{settings.ollama_base_url}/api/tags")
        res.raise_for_status()
        available = [item.get("name") for item in res.json().get("models", [])]
        return {"available": settings.ollama_model in available,
                "model": settings.ollama_model}
    except (httpx.HTTPError, ValueError):
        return {"available": False, "model": settings.ollama_model}


@app.post("/api/ai/draft-query")
async def ai_draft_query(dto: AiDraftIn, auth: tuple[AppSession, str] = Depends(get_token)):
    resources = await user_catalog(auth[1])
    allowed_targets = [r["id"] for r in resources]
    if not allowed_targets:
        raise HTTPException(422, "Tidak ada target SAP yang tersedia.")
    context = dto.current_query.model_dump() if dto.current_query else {
        "target": allowed_targets[0], "sources": [], "joins": [], "rowcount": 100}
    system = (
        "Buat draf query SAP, balas JSON saja: "
        "{target,sources:[{alias,table_name,fields,filters:[{field,operator,value}]}],"
        "joins:[{left_alias,left_field,right_alias,right_field,how}],rowcount,explanation}. "
        "Maksimal 3 sources; target harus dari daftar. Jangan mengarang field. "
        "Draf tidak dieksekusi."
    )
    user_message = json.dumps({
        "request": dto.prompt,
        "allowed_targets": [{"id": r["id"], "label": r.get("label")} for r in resources],
        "current_query": context,
    }, ensure_ascii=False)
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            res = await client.post(f"{settings.ollama_base_url}/api/chat", json={
                "model": settings.ollama_model,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.1, "num_predict": 350, "num_ctx": 2048},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user_message}],
            })
        res.raise_for_status()
        content = res.json()["message"]["content"].strip()
        draft = json.loads(content)
        explanation = str(draft.pop("explanation", ""))[:1000]
        query = QueryIn.model_validate(draft)
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        raise HTTPException(502, f"Model lokal gagal membuat draf valid: {str(exc)[:200]}") from None
    if query.target not in allowed_targets:
        raise HTTPException(422, "Draf AI memilih target yang tidak diizinkan.")
    aliases = [s.alias for s in query.sources]
    if len(set(aliases)) != len(aliases) or len(query.joins) != len(query.sources) - 1:
        raise HTTPException(422, "Draf AI memiliki relasi tabel yang tidak valid.")
    for source in query.sources:
        if not IDENT.fullmatch(source.alias) or not IDENT.fullmatch(source.table_name) or any(
            not IDENT.fullmatch(field) for field in source.fields
        ):
            raise HTTPException(422, "Draf AI berisi nama tabel atau field yang tidak valid.")
    return {"query": query.model_dump(), "explanation": explanation,
            "requires_review": True}


@app.post("/api/data/pivot")
async def pivot(dto: PivotIn, auth: tuple[AppSession, str] = Depends(get_token)):
    if dto.aggregation not in ("first", "sum", "count", "min", "max"):
        raise HTTPException(422, "Agregasi tidak didukung.")
    frame = pd.DataFrame(dto.rows)
    for name in (dto.index, dto.columns, dto.values):
        if name not in frame.columns:
            raise HTTPException(422, f"Kolom {name} tidak ada.")
    try:
        result = frame.pivot_table(
            index=dto.index, columns=dto.columns, values=dto.values,
            aggfunc=dto.aggregation, dropna=False,
        ).reset_index()
        result.columns = [str(x) for x in result.columns]
        rows = json.loads(result.to_json(orient="records", date_format="iso"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, f"Pivot gagal: {exc}") from None
    return {"columns": list(result.columns), "rows": rows}


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


@app.post("/api/data/formula")
async def formula(dto: FormulaIn, auth: tuple[AppSession, str] = Depends(get_token)):
    if not IDENT.fullmatch(dto.name):
        raise HTTPException(422, "Nama kolom formula tidak valid.")
    columns = list(dict.fromkeys(k for row in dto.rows for k in row))
    if dto.name in columns:
        raise HTTPException(422, "Nama kolom formula sudah ada.")
    referenced: list[str] = []
    def replace(match: re.Match[str]) -> str:
        field = match.group(1)
        if field not in columns:
            raise HTTPException(422, f"Kolom {field} tidak ada.")
        if field not in referenced:
            referenced.append(field)
        return f"v{referenced.index(field)}"
    expression = re.sub(r"\[([A-Za-z_][A-Za-z0-9_.]*)\]", replace, dto.expression)
    try:
        tree = ast.parse(expression, mode="eval")
        output = []
        for row in dto.rows:
            values = {f"v{i}": float(row.get(field) or 0) for i, field in enumerate(referenced)}
            result = evaluate_formula(tree, values)
            if not pd.notna(result) or abs(result) == float("inf"):
                raise ValueError("Hasil formula tidak terbatas.")
            output.append({**row, dto.name: round(result, 6)})
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError, OverflowError) as exc:
        raise HTTPException(422, f"Formula gagal: {exc}") from None
    return {"columns": columns + [dto.name], "rows": output}


@app.post("/api/sap/compare")
async def compare(dto: CompareIn, auth: tuple[AppSession, str] = Depends(get_token)):
    if any(k.upper() not in [f.upper() for f in dto.fields] for k in dto.key_fields):
        raise HTTPException(422, "Key perbandingan harus ada dalam fields.")
    left = await read_rows(ReadIn(**dto.model_dump(exclude={"other_target", "key_fields"})), auth[1])
    right_data = dto.model_dump(exclude={"other_target", "key_fields"})
    right_data["target"] = dto.other_target
    right = await read_rows(ReadIn(**right_data), auth[1])
    keys = [k.upper() for k in dto.key_fields]
    def indexed(rows):
        out = {}
        for row in rows:
            key = tuple(str(row.get(k, "")) for k in keys)
            if key in out:
                raise HTTPException(422, "Key perbandingan tidak unik pada salah satu target.")
            out[key] = row
        return out
    a, b = indexed(left), indexed(right)
    changes = []
    for key in sorted(a.keys() | b.keys()):
        old, new = a.get(key), b.get(key)
        if old != new:
            changes.append({"key": dict(zip(keys, key)), "status": "changed" if old and new else
                            "only_left" if old else "only_right", "left": old, "right": new})
    return {"left_count": len(left), "right_count": len(right), "changes": changes}


@app.get("/api/reports")
async def list_reports(auth: tuple[AppSession, str] = Depends(get_token), db: Session = Depends(get_db)):
    rows = db.scalars(select(Report).where(Report.owner_id == auth[0].user_id).order_by(Report.updated_at.desc())).all()
    return [{"id": r.id, "name": r.name, "definition": r.definition} for r in rows]


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
    if not row or row.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    row.name = dto.name
    row.definition = dto.definition
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
    db.delete(row)
    db.commit()
    return {"success": True}


@app.get("/api/reports/{report_id}/variants")
async def list_variants(report_id: str, auth: tuple[AppSession, str] = Depends(get_token),
                        db: Session = Depends(get_db)):
    row = db.get(Report, report_id)
    if not row or row.owner_id != auth[0].user_id:
        raise HTTPException(404, "Laporan tidak ditemukan.")
    variants = db.scalars(select(Variant).where(Variant.report_id == report_id, Variant.owner_id == auth[0].user_id)).all()
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
