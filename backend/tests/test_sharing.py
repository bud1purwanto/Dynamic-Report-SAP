"""Test suite untuk fitur sharing laporan tersimpan ke pengguna lain."""
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.app import main
from backend.app.db import AppSession, Report, ReportShare, Variant, utcnow


class ReportSharingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner_session = SimpleNamespace(
            user_id="user-owner-123",
            user_profile={"username": "TRSTDEV", "name": "TRST Developer", "role": "superadmin"},
        )
        self.recipient_session = SimpleNamespace(
            user_id="user-recipient-456",
            user_profile={"username": "TRST-BUDI", "name": "Budi Purwanto", "role": "user"},
        )
        self.report = Report(
            id="report-test-001",
            owner_id="user-owner-123",
            name="Laporan Analisis Penjualan",
            definition={"sources": [{"alias": "T1", "table_name": "VBAK", "fields": ["VBELN"]}]},
            created_at=utcnow(),
            updated_at=utcnow(),
        )

    async def test_list_available_users_excludes_current_user(self):
        db = MagicMock(spec=Session)
        session_owner = AppSession(
            id="s1", user_id="user-owner-123", user_profile={"username": "TRSTDEV"},
            access_token="", refresh_token="", access_expires_at=utcnow(), expires_at=utcnow()
        )
        session_other = AppSession(
            id="s2", user_id="user-recipient-456", user_profile={"username": "TRST-BUDI", "name": "Budi Purwanto"},
            access_token="", refresh_token="", access_expires_at=utcnow(), expires_at=utcnow()
        )
        db.scalars.return_value.all.return_value = [session_owner, session_other]
        db.execute.return_value.fetchall.return_value = []

        users = await main.list_available_users((self.owner_session, "token"), db)
        usernames = [u["username"] for u in users]
        self.assertNotIn("TRSTDEV", usernames)
        self.assertIn("TRST-BUDI", usernames)

    async def test_create_share_cannot_share_to_self(self):
        db = MagicMock(spec=Session)
        db.get.return_value = self.report
        dto = main.ReportShareIn(username="TRSTDEV", permission="view")
        with self.assertRaises(HTTPException) as exc:
            await main.create_or_update_report_share("report-test-001", dto, (self.owner_session, "token"), db)
        self.assertEqual(exc.exception.status_code, 400)

    async def test_create_and_update_share_permission(self):
        db = MagicMock(spec=Session)
        db.get.return_value = self.report
        db.scalars.return_value.all.return_value = []
        db.scalars.return_value.first.return_value = None

        # 1. Share baru dengan izin 'view'
        dto = main.ReportShareIn(username="TRST-BUDI", permission="view")
        res = await main.create_or_update_report_share("report-test-001", dto, (self.owner_session, "token"), db)
        self.assertEqual(res["shared_with_username"], "TRST-BUDI")
        self.assertEqual(res["permission"], "view")

        # 2. Update izin menjadi 'edit'
        existing_share = ReportShare(
            id="share-001", report_id="report-test-001", shared_by_id="user-owner-123",
            shared_by_username="TRSTDEV", shared_with_username="TRST-BUDI", permission="view"
        )
        db.scalars.return_value.first.return_value = existing_share
        dto_edit = main.ReportShareIn(username="TRST-BUDI", permission="edit")
        res_edit = await main.create_or_update_report_share("report-test-001", dto_edit, (self.owner_session, "token"), db)
        self.assertEqual(res_edit["permission"], "edit")
        self.assertEqual(existing_share.permission, "edit")

    async def test_update_report_permission_enforcement(self):
        db = MagicMock(spec=Session)
        db.get.return_value = self.report
        dto = main.ReportIn(name="Updated Name", definition=self.report.definition)

        # Penerima dengan izin 'view' tidak boleh update (403)
        share_view = ReportShare(
            id="s1", report_id="report-test-001", shared_by_id="user-owner-123",
            shared_with_username="TRST-BUDI", permission="view"
        )
        db.scalars.return_value.first.return_value = share_view
        with self.assertRaises(HTTPException) as exc:
            await main.update_report("report-test-001", dto, (self.recipient_session, "token"), db)
        self.assertEqual(exc.exception.status_code, 403)

        # Penerima dengan izin 'edit' boleh update
        share_edit = ReportShare(
            id="s1", report_id="report-test-001", shared_by_id="user-owner-123",
            shared_with_username="TRST-BUDI", permission="edit"
        )
        db.scalars.return_value.first.return_value = share_edit
        res = await main.update_report("report-test-001", dto, (self.recipient_session, "token"), db)
        self.assertEqual(res["name"], "Updated Name")


if __name__ == "__main__":
    unittest.main()
