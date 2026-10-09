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
    async def test_structure_uses_sap_ddic_position_instead_of_alphabetical_order(self):
        structure = {"structuredContent": {"fields": [
            {"name": "ZZ_FIELD", "is_key": False},
            {"name": "AA_FIELD", "is_key": True},
        ]}}
        positions = [{"FIELDNAME": "ZZ_FIELD", "POSITION": "0002"},
                     {"FIELDNAME": "AA_FIELD", "POSITION": "0001"}]
        with patch.object(main, "rpc_call", AsyncMock(return_value=structure)), \
             patch.object(main, "read_rows", AsyncMock(return_value=positions)) as read:
            fields, _ = await main.get_structure("token", {"id": "dev", "resource_key": "sap:dev"}, "MARA")
        self.assertEqual([field["name"] for field in fields], ["AA_FIELD", "ZZ_FIELD"])
        self.assertIn("DD03L", [call.args[0].table_name for call in read.await_args_list])

    async def test_structure_uses_positions_already_supplied_by_gateway(self):
        structure = {"structuredContent": {"fields": [
            {"name": "Z_FIELD", "position": 2}, {"name": "A_FIELD", "position": 1},
        ]}}
        with patch.object(main, "rpc_call", AsyncMock(return_value=structure)), \
             patch.object(main, "read_rows", AsyncMock()) as read:
            fields, _ = await main.get_structure("token", {"id": "dev", "resource_key": "sap:dev"}, "MARA")
        self.assertEqual([field["name"] for field in fields], ["A_FIELD", "Z_FIELD"])
        self.assertNotIn("DD03L", [call.args[0].table_name for call in read.await_args_list])

    async def test_structure_uses_gateway_text_then_dd03t_fallback(self):
        structure = {"structuredContent": {"fields": [
            {"name": "MATNR", "position": 1, "description": "Material Number"},
            {"name": "MTART", "position": 2},
        ]}}
        texts = [{"FIELDNAME": "MATNR", "DDTEXT": "Different text"},
                 {"FIELDNAME": "MTART", "DDTEXT": "Material Type"}]
        with patch.object(main, "rpc_call", AsyncMock(return_value=structure)), \
             patch.object(main, "read_rows", AsyncMock(return_value=texts)) as read:
            fields, _ = await main.get_structure("token", {"id": "dev", "resource_key": "sap:dev"}, "MARA")
        self.assertEqual([field["description"] for field in fields], ["Material Number", "Material Type"])
        self.assertEqual(read.await_args.args[0].table_name, "DD03T")

    async def test_user_catalog_only_returns_user_connections(self):
        resources = [
            {"serverId": "gateway", "kind": "sap", "resource_key": "sap:dev", "label": "DEV"},
            {"serverId": "gateway", "kind": "sap", "resource_key": "sap:prd", "label": "PRD"},
        ]
        response = SimpleNamespace(status_code=200, json=lambda: [
            {"id": "conn-dev", "resourceKey": "sap:dev"},
            {"id": "conn-prd", "resourceKey": "sap:prd"}])
        with patch.object(main, "catalog", AsyncMock(return_value=resources)), \
             patch.object(main.httpx, "AsyncClient") as client_class, \
             patch.object(main, "gateway_allows_resource", AsyncMock(side_effect=lambda _token, key: key == "sap:dev")):
            client_class.return_value.__aenter__.return_value.get = AsyncMock(return_value=response)
            visible = await main.user_catalog("user-token")
        self.assertEqual([item["resource_key"] for item in visible], ["sap:dev"])
        with self.assertRaises(HTTPException):
            main.match_target(visible, "sap:prd")

    async def test_gateway_resource_probe_stops_before_sap_execution(self):
        main.RESOURCE_ACCESS_CACHE.clear()
        response = SimpleNamespace(status_code=200, json=lambda: {
            "error": {"message": "Missing function name"}})
        with patch.object(main.httpx, "AsyncClient") as client_class:
            post = client_class.return_value.__aenter__.return_value.post = AsyncMock(return_value=response)
            self.assertTrue(await main.gateway_allows_resource("user-token", "sap:dev"))
            self.assertEqual(post.call_args.kwargs["json"]["params"]["arguments"],
                             {"resource_key": "sap:dev", "function_name": ""})
        main.RESOURCE_ACCESS_CACHE.clear()
        denied = SimpleNamespace(status_code=200, json=lambda: {
            "error": {"message": 'Forbidden: Resource key "sap:prd" is not authorized for this client'}})
        with patch.object(main.httpx, "AsyncClient") as client_class:
            client_class.return_value.__aenter__.return_value.post = AsyncMock(return_value=denied)
            self.assertFalse(await main.gateway_allows_resource("user-token", "sap:prd"))
        main.RESOURCE_ACCESS_CACHE.clear()

    async def test_compare_uses_all_metadata_fields_and_reports_same_and_different_rows(self):
        metadata = [
            {"name": "MANDT", "is_key": True},
            {"name": "MATNR", "is_key": True},
            {"name": "MTART", "is_key": False},
        ]
        async def read_rows(dto, _token):
            self.assertEqual(dto.fields, ["MANDT", "MATNR", "MTART"])
            if dto.target == "dev":
                return [{"MANDT": "100", "MATNR": "A", "MTART": "FERT"},
                        {"MANDT": "100", "MATNR": "B", "MTART": "FERT"}]
            return [{"MANDT": "100", "MATNR": "A", "MTART": "FERT"},
                    {"MANDT": "100", "MATNR": "B", "MTART": "HALB"}]

        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "dev", "resource_key": "sap:dev"},
            {"id": "qa", "resource_key": "sap:qa"}])), \
             patch.object(main, "get_structure", AsyncMock(return_value=(metadata, ""))), \
             patch.object(main, "read_rows", AsyncMock(side_effect=read_rows)):
            result = await main.compare(main.CompareIn(target="dev", other_target="qa",
                                                       table_name="MARA"), (None, "token"))
        self.assertEqual(result["key_fields"], ["MATNR"])
        self.assertEqual([row["status"] for row in result["rows"]], ["same", "changed"])
        self.assertEqual(result["rows"][1]["changed_fields"], ["MTART"])

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
    async def test_pushdown_join_filter_when_upstream_is_filtered(self):
        passed_filters = {}
        async def read_rows(dto, _token):
            passed_filters[dto.table_name] = dto.filters
            if dto.table_name == "MCH1":
                return [{"CHARG": "0000366399", "CUOBJ_BM": "12345"}]
            return [{"OBJEK": "12345", "ATWRT": "VAL1"}]

        async def structure(_token, _target, table):
            names = ["CHARG", "CUOBJ_BM"] if table == "MCH1" else ["OBJEK", "ATWRT"]
            return ([{"name": name, "data_type": "CHAR", "is_key": False} for name in names], "")

        query = main.QueryIn(
            target="conn-dev",
            sources=[
                main.SourceIn(alias="T1", table_name="MCH1", fields=["CHARG"],
                              filters=[main.FilterIn(field="CHARG", operator="EQ", value="0000366399")]),
                main.SourceIn(alias="T2", table_name="AUSP", fields=["ATWRT"]),
            ],
            joins=[main.JoinIn(left_alias="T1", right_alias="T2", how="inner", conditions=[
                main.JoinConditionIn(left_field="CUOBJ_BM", right_field="OBJEK"),
            ])],
        )
        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "get_structure", AsyncMock(side_effect=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=read_rows)):
            result = await main.execute_query(query, "user-token")
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["T2.ATWRT"], "VAL1")
        self.assertEqual(passed_filters["AUSP"][0].field, "OBJEK")
        self.assertEqual(passed_filters["AUSP"][0].value, "12345")


if __name__ == "__main__":
    unittest.main()
