import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} harus diisi di .env")
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str
    database_schema: str
    oidc_issuer: str
    catalog_token: str
    gateway_url: str
    session_secret: str
    session_hours: int
    schedule_delegation_days: int
    cookie_name: str
    cookie_secure: bool | None
    frontend_origin: str
    export_mask_fields: tuple[str, ...]
    ollama_base_url: str
    ollama_model: str


def get_settings() -> Settings:
    schema = required("DATABASE_SCHEMA")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema):
        raise RuntimeError("DATABASE_SCHEMA bukan identifier PostgreSQL yang valid")
    secret = required("SESSION_SECRET")
    if len(secret) < 32:
        raise RuntimeError("SESSION_SECRET minimal 32 karakter")
    cookie_mode = os.getenv("SESSION_COOKIE_SECURE", "auto").strip().lower()
    if cookie_mode not in {"auto", "true", "false"}:
        raise RuntimeError("SESSION_COOKIE_SECURE harus auto, true, atau false")
    return Settings(
        database_url=required("DATABASE_URL"),
        database_schema=schema,
        oidc_issuer=required("DASHBOARD_OIDC_ISSUER").rstrip("/"),
        catalog_token=required("DASHBOARD_MCP_API_TOKEN"),
        gateway_url=required("DASHBOARD_MCP_GATEWAY_URL"),
        session_secret=secret,
        session_hours=int(os.getenv("SESSION_EXPIRE_HOURS", "24")),
        schedule_delegation_days=int(os.getenv("SCHEDULE_DELEGATION_DAYS", "30")),
        cookie_name=os.getenv("SESSION_COOKIE_NAME", "sap_session"),
        cookie_secure=None if cookie_mode == "auto" else cookie_mode == "true",
        frontend_origin=os.getenv("FRONTEND_ORIGIN", "http://localhost:5173"),
        export_mask_fields=tuple(x.strip().upper() for x in
                                 os.getenv("EXPORT_MASK_FIELDS", "IBAN,BANKN,BANKL,STCD1,STCD2").split(",")
                                 if x.strip()),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/"),
        ollama_model=os.getenv("OLLAMA_MODEL", "qwen2.5:3b"),
    )


settings = get_settings()
