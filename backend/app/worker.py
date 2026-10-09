"""Run scheduled reports in a separate single-purpose process.

Start with: python -m backend.app.worker
Multiple workers may run safely: due schedules are claimed with SKIP LOCKED.
"""

import asyncio
import logging
from datetime import timedelta

import httpx
from cryptography.fernet import InvalidToken
from sqlalchemy import select

from .config import settings
from .db import AppSession, Report, ReportRun, ReportSchedule, SessionLocal, init_db, utcnow
from .main import QueryIn, apply_report_presentation, execute_query, fernet, make_xlsx


logger = logging.getLogger("lumina.worker")


def claim_due(limit: int = 10) -> list[str]:
    now = utcnow()
    with SessionLocal() as db:
        rows = db.scalars(
            select(ReportSchedule)
            .where(ReportSchedule.enabled.is_(True), ReportSchedule.next_run_at <= now)
            .order_by(ReportSchedule.next_run_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).all()
        ids = []
        for row in rows:
            row.next_run_at = now + timedelta(minutes=row.interval_minutes)
            row.last_status = "running"
            ids.append(row.id)
        db.commit()
        return ids


async def refresh_user_token(refresh_token: str) -> tuple[str, str, int]:
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.post(
            f"{settings.oidc_issuer}/v1/auth/refresh",
            cookies={"refresh_token": refresh_token},
        )
    if res.status_code in (400, 401, 403):
        raise PermissionError("Delegasi OIDC kedaluwarsa; pengguna perlu login ulang dan memperbarui jadwal.")
    res.raise_for_status()
    payload = res.json()
    return payload["accessToken"], res.cookies.get("refresh_token") or refresh_token, int(payload.get("expiresIn", 900))


async def execute_schedule(schedule_id: str) -> None:
    with SessionLocal() as db:
        schedule = db.get(ReportSchedule, schedule_id)
        if not schedule or not schedule.enabled:
            return
        report = db.get(Report, schedule.report_id)
        if not report or report.owner_id != schedule.owner_id:
            schedule.enabled = False
            schedule.last_status = "error"
            schedule.last_error = "Laporan tidak tersedia."
            db.commit()
            return
        session = db.execute(
            select(AppSession).where(AppSession.id == schedule.session_id).with_for_update()
        ).scalar_one_or_none()
        if not session or session.expires_at <= utcnow():
            schedule.enabled = False
            schedule.last_status = "needs_login"
            schedule.last_error = "Delegasi OIDC kedaluwarsa atau sesi telah diakhiri."
            db.commit()
            return
        try:
            refresh = fernet.decrypt(session.refresh_token.encode()).decode()
        except InvalidToken:
            schedule.enabled = False
            schedule.last_status = "needs_login"
            schedule.last_error = "Delegasi OIDC tidak valid."
            db.commit()
            return
        try:
            access_token, rotated_refresh, expires_in = await refresh_user_token(refresh)
            session.access_token = fernet.encrypt(access_token.encode()).decode()
            session.refresh_token = fernet.encrypt(rotated_refresh.encode()).decode()
            session.access_expires_at = utcnow() + timedelta(seconds=expires_in)
            db.commit()
            query = QueryIn.model_validate(report.definition)
            result = await execute_query(query, access_token)
            presented_rows = apply_report_presentation(result["rows"], report.definition.get("presentation"))
            artifact = make_xlsx(presented_rows)
            schedule.last_status = "success"
            schedule.last_error = None
            row_count = len(presented_rows)
        except PermissionError as exc:
            schedule.enabled = False
            schedule.last_status = "needs_login"
            schedule.last_error = str(exc)
            row_count = 0
        except Exception as exc:
            # Do not persist upstream URLs or token-bearing exception strings.
            schedule.last_status = "error"
            schedule.last_error = type(exc).__name__ + ": " + str(exc)[:160] if not isinstance(exc, httpx.HTTPError) else "Koneksi layanan gagal."
            row_count = 0
        schedule.last_run_at = utcnow()
        db.add(ReportRun(
            owner_id=schedule.owner_id,
            report_id=report.id,
            definition=report.definition,
            status=schedule.last_status or "error",
            row_count=row_count,
            error=schedule.last_error,
            artifact=artifact if schedule.last_status == "success" else None,
        ))
        db.commit()


async def run_once() -> int:
    ids = claim_due()
    for schedule_id in ids:
        await execute_schedule(schedule_id)
    return len(ids)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    init_db()
    logger.info("Lumina scheduler started")
    while True:
        try:
            processed = await run_once()
            if processed:
                logger.info("Processed %s scheduled report(s)", processed)
        except Exception:
            logger.exception("Scheduler cycle failed")
        await asyncio.sleep(30)


if __name__ == "__main__":
    asyncio.run(main())
