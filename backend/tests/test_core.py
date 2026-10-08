import io
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from starlette.requests import Request
from openpyxl import load_workbook

from backend.app import main


class DataProcessingTests(unittest.IsolatedAsyncioTestCase):
    async def test_query_joins_two_tables_and_checks_metadata(self):
        async def read_rows(dto, _token):
            if dto.table_name == "MARA":
                return [{"MATNR": "001", "MTART": "FERT"}]
            return [{"MATNR": "001", "WERKS": "1000"}]

        def structure(_token, _target, table):
            fields = ["MATNR", "MTART"] if table == "MARA" else ["MATNR", "WERKS"]
            return ([{"name": field, "data_type": "CHAR", "is_key": field == "MATNR"}
                     for field in fields], "")

        query = main.QueryIn(
            target="conn-dev",
            sources=[
                main.SourceIn(alias="T1", table_name="MARA", fields=["MATNR", "MTART"]),
                main.SourceIn(alias="T2", table_name="MARC", fields=["MATNR", "WERKS"]),
            ],
            joins=[main.JoinIn(left_alias="T1", left_field="MATNR",
                               right_alias="T2", right_field="MATNR")],
        )
        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "get_structure", AsyncMock(side_effect=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=read_rows)):
            result = await main.execute_query(query, "user-token")
        self.assertEqual(result["rows"][0]["T2.WERKS"], "1000")

    async def test_composite_join_uses_hidden_keys_and_only_outputs_selected_columns(self):
        async def read_rows(dto, _token):
            self.assertFalse(dto.filters)
            if dto.table_name == "MCH1":
                return [{"MATNR": "001", "CHARG": "A", "MTART": "FERT"},
                        {"MATNR": "001", "CHARG": "B", "MTART": "HALB"}]
            return [{"MATNR": "001", "CHARG": "A", "WERKS": "1000"},
                    {"MATNR": "001", "CHARG": "B", "WERKS": "2000"}]

        async def structure(_token, _target, table):
            names = ["MATNR", "CHARG", "MTART" if table == "MCH1" else "WERKS"]
            return ([{"name": name, "data_type": "CHAR", "is_key": name in ("MATNR", "CHARG")}
                     for name in names], "")

        query = main.QueryIn(
            target="conn-dev",
            sources=[
                main.SourceIn(alias="T1", table_name="MCH1", fields=["MTART"],
                              filters=[main.FilterIn(field="MATNR", value="")]),
                main.SourceIn(alias="T2", table_name="MCHA", fields=["WERKS"]),
            ],
            joins=[main.JoinIn(left_alias="T1", right_alias="T2", conditions=[
                main.JoinConditionIn(left_field="MATNR", right_field="MATNR"),
                main.JoinConditionIn(left_field="CHARG", right_field="CHARG"),
            ])],
        )
        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "get_structure", AsyncMock(side_effect=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=read_rows)):
            result = await main.execute_query(query, "user-token")
        self.assertEqual(result["columns"], ["T1.MTART", "T2.WERKS"])
        self.assertEqual(result["rows"], [
            {"T1.MTART": "FERT", "T2.WERKS": "1000"},
            {"T1.MTART": "HALB", "T2.WERKS": "2000"},
        ])

    async def test_gateway_arguments_include_authorized_resource_and_escaped_filter(self):
        captured = {}

        async def rpc(_token, _target, name, args):
            captured.update(args)
            self.assertEqual(name, "mcp-sap__read_table")
            return {"structuredContent": {"rows": [{"MATNR": "O'NEIL"}]}}

        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "read_tool_contract", AsyncMock(return_value=(
                 "mcp-sap__read_table",
                 {"properties": {"table": {"type": "string"}, "fields": {"type": "array"},
                                 "rowcount": {"type": "number"}}},
             ))), \
             patch.object(main, "rpc_call", AsyncMock(side_effect=rpc)):
            result = await main.read_rows(main.ReadIn(
                target="conn-dev", table_name="MARA", fields=["MATNR"],
                filters=[main.FilterIn(field="MATNR", value="O'NEIL")],
            ), "user-token")
        self.assertEqual(captured["resource_key"], "sap:dev")
        self.assertEqual(captured["table"], "MARA")
        self.assertEqual(captured["where"], ["MATNR = 'O''NEIL'"])
        self.assertEqual(result[0]["MATNR"], "O'NEIL")

    async def test_formula_rejects_calls(self):
        with self.assertRaises(HTTPException) as raised:
            await main.formula(main.FormulaIn(
                rows=[{"X": 1}], name="Y", expression="__import__('os')"
            ), (None, "token"))
        self.assertEqual(raised.exception.status_code, 422)

    async def test_pivot_flattens_characteristics(self):
        result = await main.pivot(main.PivotIn(
            rows=[{"batch": "A", "characteristic": "COLOR", "value": "BLUE"},
                  {"batch": "A", "characteristic": "SIZE", "value": "L"}],
            index="batch", columns="characteristic", values="value",
        ), (None, "token"))
        self.assertEqual(result["rows"][0]["COLOR"], "BLUE")
        self.assertEqual(result["rows"][0]["SIZE"], "L")

    def test_ddic_structure_parser_and_excel_mask(self):
        fields, _ = main.parse_structure({
            "content": [{"text": '{"fields":[{"FIELDNAME":"MATNR","KEYFLAG":"X","DATATYPE":"CHAR"}]}'}]
        })
        self.assertEqual(fields[0]["name"], "MATNR")
        self.assertTrue(fields[0]["is_key"])
        book = load_workbook(io.BytesIO(main.make_xlsx(
            [{"T1.IBAN": "DE123", "COMMENT": "=1+1"}]
        )), read_only=True)
        cells = list(book.active.values)[1]
        self.assertEqual(cells[0], "***")
        self.assertEqual(cells[1], "'=1+1")

    def test_error_classifier_does_not_call_bad_password_offline(self):
        message = main.friendly_sap_error("RFC_LOGON_FAILURE rc: 103", "DEV")
        self.assertIn("Logon SAP", message)
        self.assertNotIn("Koneksi", message)

    def test_session_cookie_scheme_for_ip_access(self):
        http_request = Request({"type": "http", "scheme": "http", "server": ("192.168.88.83", 8000), "path": "/", "headers": []})
        https_request = Request({"type": "http", "scheme": "https", "server": ("100.73.54.71", 443), "path": "/", "headers": []})
        with patch.object(main, "settings", SimpleNamespace(cookie_secure=None)):
            self.assertFalse(main.secure_cookie_for(http_request))
            self.assertTrue(main.secure_cookie_for(https_request))

    async def test_scheduled_excel_download_is_owner_only(self):
        content = main.make_xlsx([{"MATNR": "001"}])
        db = MagicMock()
        db.get.return_value = SimpleNamespace(id="run-1", owner_id="alice", artifact=content)
        with self.assertRaises(HTTPException) as denied:
            await main.download_report_run("run-1", (SimpleNamespace(user_id="bob"), "token"), db)
        self.assertEqual(denied.exception.status_code, 404)
        response = await main.download_report_run("run-1", (SimpleNamespace(user_id="alice"), "token"), db)
        self.assertIsInstance(response, StreamingResponse)
        self.assertIn("attachment", response.headers["content-disposition"])


if __name__ == "__main__":
    unittest.main()
