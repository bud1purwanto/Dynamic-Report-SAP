"""Regresi: tunggu kunci basis data tidak boleh membekukan peladen."""
import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from sqlalchemy.exc import OperationalError
from starlette.requests import Request

from backend.app import main
from backend.app.db import utcnow


class AuthResponsivenessTests(unittest.IsolatedAsyncioTestCase):
    async def test_sesi_terkunci_tidak_memblokir_permintaan_lain(self):
        row = SimpleNamespace(access_expires_at=utcnow(), expires_at=utcnow())
        # Masa berlaku sesi harus lebih panjang daripada akses.
        from datetime import timedelta
        row.expires_at += timedelta(hours=1)
        db = MagicMock()
        db.get.return_value = row

        def locked_query(*args, **kwargs):
            time.sleep(0.3)
            raise OperationalError("SELECT FOR UPDATE", {}, Exception("lock timeout"))

        db.execute.side_effect = locked_query
        db.execute.return_value.scalar_one_or_none.return_value = row
        db.get.return_value = row
        cookie = main.signer.dumps("sesi-terkunci")
        request = Request({
            "type": "http", "scheme": "http", "path": "/api/auth/me",
            "headers": [(b"cookie", f"{main.settings.cookie_name}={cookie}".encode())],
        })

        async def request_auth():
            with self.assertRaises(HTTPException) as error:
                await main.get_token(request, db)
            self.assertEqual(error.exception.status_code, 503)

        async def permintaan_lain():
            start = time.monotonic()
            await asyncio.sleep(0.04)
            return time.monotonic() - start

        auth = asyncio.create_task(request_auth())
        delay = await permintaan_lain()
        await auth
        self.assertLess(delay, 0.15, "Kunci basis data menahan seluruh event loop")
        db.rollback.assert_called()
