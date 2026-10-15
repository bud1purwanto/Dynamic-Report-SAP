import io
import unittest
from unittest.mock import AsyncMock, patch, MagicMock
from types import SimpleNamespace
import httpx

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from starlette.requests import Request
from openpyxl import load_workbook

from backend.app import main


class DataProcessingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        main.STRUCTURE_CACHE.clear()

    async def test_pivot_keeps_material_batch_pairs_and_averages_numeric_values(self):
        rows = [
            {"MATNR": "A", "CHARG": "01", "NAME": "LENGTH", "VALUE": "10"},
            {"MATNR": "A", "CHARG": "01", "NAME": "LENGTH", "VALUE": "20"},
            {"MATNR": "B", "CHARG": "01", "NAME": "LENGTH", "VALUE": "30"},
        ]
        result = await main.pivot(main.PivotIn(rows=rows, index=["MATNR", "CHARG"],
                                               columns="NAME", values="VALUE", aggregation="mean"), (None, ""))
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual([(row["MATNR"], row["LENGTH"]) for row in result["rows"]], [("A", 15.0), ("B", 30.0)])

    async def test_pivot_supports_many_row_dimensions(self):
        # Test with 8 row dimensions (more than previous 6-column limit)
        dimensions = [f"DIM_{i}" for i in range(1, 9)]
        row_template = {dim: f"val_{dim}" for dim in dimensions}
        rows = [
            {**row_template, "NAME": "COLOR", "VALUE": "RED"},
            {**row_template, "NAME": "WEIGHT", "VALUE": "100"},
        ]
        result = await main.pivot(main.PivotIn(rows=rows, index=dimensions,
                                               columns="NAME", values="VALUE", aggregation="first"), (None, ""))
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["COLOR"], "RED")
        self.assertEqual(result["rows"][0]["WEIGHT"], "100")

    async def test_calculated_column_uses_selected_fields_and_handles_division_by_zero(self):
        rows = [{"A": "10", "B": "2"}, {"A": "5", "B": "0"}]
        result = await main.calculated_column(main.CalculatedColumnIn(
            rows=rows, name="RATIO", operation="divide", fields=["A", "B"]), (None, ""))
        self.assertEqual([row["RATIO"] for row in result["rows"]], [5, None])

    def test_saved_pivot_applies_to_scheduled_export_rows(self):
        rows = [
            {"MATNR": "A", "CHARG": "01", "NAME": "WIDTH", "VALUE": "10"},
            {"MATNR": "A", "CHARG": "01", "NAME": "HEIGHT", "VALUE": "20"},
            {"MATNR": "B", "CHARG": "01", "NAME": "WIDTH", "VALUE": "30"},
        ]
        presentation = {"pivot": {"rows": ["MATNR", "CHARG"], "column": "NAME",
                                  "value": "VALUE", "aggregation": "first"},
                        "visibleColumns": ["MATNR", "CHARG", "WIDTH"]}
        result = main.apply_report_presentation(rows, presentation)
        self.assertEqual(result, [{"MATNR": "A", "CHARG": "01", "WIDTH": "10"},
                                  {"MATNR": "B", "CHARG": "01", "WIDTH": "30"}])

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
             patch.object(main, "read_rows", AsyncMock(return_value=[])) as read:
            fields, _ = await main.get_structure("token", {"id": "dev", "resource_key": "sap:dev"}, "MARA")
        self.assertEqual([field["name"] for field in fields], ["A_FIELD", "Z_FIELD"])
        self.assertIn("DD03L", [call.args[0].table_name for call in read.await_args_list])

    async def test_structure_uses_gateway_text_then_dd03t_fallback(self):
        structure = {"structuredContent": {"fields": [
            {"name": "MATNR", "position": 1, "description": "Material Number"},
            {"name": "MTART", "position": 2},
        ]}}
        texts = [{"FIELDNAME": "MATNR", "DDTEXT": "Different text"},
                 {"FIELDNAME": "MTART", "DDTEXT": "Material Type"}]
        async def rows(dto, _token):
            return texts if dto.table_name == "DD03T" else []
        with patch.object(main, "rpc_call", AsyncMock(return_value=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=rows)) as read:
            fields, _ = await main.get_structure("token", {"id": "dev", "resource_key": "sap:dev"}, "MARA")
        self.assertEqual([field["description"] for field in fields], ["Material Number", "Material Type"])
        self.assertEqual(read.await_args.args[0].table_name, "DD03T")

    async def test_structure_uses_data_element_text_when_table_text_is_missing(self):
        structure = {"structuredContent": {"fields": [
            {"name": "MATNR", "position": 1}, {"name": "MTART", "position": 2},
        ]}}
        async def rows(dto, _token):
            if dto.table_name == "DD03L":
                return [{"FIELDNAME": "MATNR", "ROLLNAME": "MATNR", "POSITION": "1"},
                        {"FIELDNAME": "MTART", "ROLLNAME": "MTART", "POSITION": "2"}]
            if dto.table_name == "DD04T":
                return [{"DDTEXT": "Material Number" if dto.filters[0].value == "MATNR" else "Material Type"}]
            return []
        with patch.object(main, "rpc_call", AsyncMock(return_value=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=rows)):
            fields, _ = await main.get_structure("token", {"id": "dev", "resource_key": "sap:dev"}, "MARA")
        self.assertEqual([field["description"] for field in fields], ["Material Number", "Material Type"])

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
            if dto.table_name == "MCH1":
                self.assertFalse(dto.filters)
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

    def test_multiple_selection_and_interval_filters(self):
        filters = [
            main.FilterIn(field="CHARG", value="001"),
            main.FilterIn(field="CHARG", value="005", operator="BT", high_value="009"),
            main.FilterIn(field="CHARG", value="007", sign="E"),
            main.FilterIn(field="WERKS", value="1000"),
        ]
        where = main.build_sap_where(filters)
        self.assertTrue(all(len(line) <= 72 for line in where))
        expression = " ".join(where)
        self.assertIn("(CHARG = '001' OR (CHARG >= '005' AND CHARG <= '009'))", expression)
        self.assertIn("NOT (CHARG = '007')", expression)
        self.assertIn("AND WERKS = '1000'", expression)

    def test_multiple_equal_filters_use_in(self):
        where = main.build_sap_where([
            main.FilterIn(field="CHARG", value="0000366399"),
            main.FilterIn(field="CHARG", value="0000366400"),
        ])
        self.assertEqual(where, ["CHARG IN ('0000366399', '0000366400')"])

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

    def test_resolve_column_name_matches(self):
        columns = ["T1.AUFNR", "Panjang Film (Meter)", "Lebar Film (Milimeter)", "Grammage"]
        self.assertEqual(main.resolve_column_name("T1.AUFNR", columns), "T1.AUFNR")
        self.assertEqual(main.resolve_column_name("aufnr", columns), "T1.AUFNR")
        self.assertEqual(main.resolve_column_name("Panjang", columns), "Panjang Film (Meter)")
        self.assertEqual(main.resolve_column_name("lebar", columns), "Lebar Film (Milimeter)")
        self.assertEqual(main.resolve_column_name("Grammage", columns), "Grammage")

    def test_formula_with_fuzzy_columns(self):
        rows = [{"Panjang Film (Meter)": 1000, "Lebar Film (Milimeter)": 500, "Grammage": 20}]
        cols = ["Panjang Film (Meter)", "Lebar Film (Milimeter)", "Grammage"]
        # AI generated: ([Panjang] * [Lebar] * [Grammage]) / 1000000
        expr = "([Panjang] * [Lebar] * [Grammage]) / 1000000"
        result = main.run_formula_rows(rows, "BERAT AKTUAL", expr, cols)
        self.assertEqual(len(result), 1)
        # 1000 * 500 * 20 / 1000000 = 10.0
        self.assertEqual(result[0]["BERAT AKTUAL"], 10.0)

    def test_apply_report_presentation_preserves_calculated_columns(self):
        rows = [{"Panjang Film (Meter)": 1000, "Lebar Film (Milimeter)": 500, "Grammage": 20}]
        presentation = {
            "calculatedColumns": [
                {"name": "BERAT AKTUAL", "operation": "custom", "expression": "([Panjang] * [Lebar] * [Grammage]) / 1000000"}
            ],
            "visibleColumns": ["Panjang Film (Meter)"]
        }
        res = main.apply_report_presentation(rows, presentation)
        self.assertEqual(len(res), 1)
        self.assertIn("BERAT AKTUAL", res[0])
        self.assertEqual(res[0]["BERAT AKTUAL"], 10.0)

    async def test_ai_generate_canonicalizes_column_names(self):
        llm_response = main.json.dumps({
            "explanation": "Menambahkan kolom hitung BERAT AKTUAL",
            "calculatedColumns": [
                {
                    "name": "BERAT AKTUAL",
                    "operation": "custom",
                    "expression": "([Panjang] * [Lebar] * [Grammage]) / 1000000"
                }
            ]
        })
        dto = main.AiFullAssistantIn(
            prompt="hitung berat aktual",
            context_type="builder",
            current_state={
                "available_columns": ["Panjang Film (Meter)", "Lebar Film (Milimeter)", "Grammage"]
            }
        )
        auth = (SimpleNamespace(user_id="alice"), "token")
        with patch.object(main, "user_catalog", AsyncMock(return_value=[{"id": "conn-dev", "label": "DEV"}])), \
             patch.object(main, "query_llm_with_fallback", AsyncMock(return_value=(llm_response, "test-ai"))):
            result = await main.ai_generate(dto, auth)
        calc = result["data"]["calculatedColumns"][0]
        self.assertEqual(calc["expression"], "([Panjang Film (Meter)] * [Lebar Film (Milimeter)] * [Grammage]) / 1000000")

    async def test_ai_generate_reorders_columns_and_preserves_remaining(self):
        llm_response = main.json.dumps({
            "explanation": "Memindahkan kolom BERAT AKTUAL ke paling depan",
            "visibleColumns": ["BERAT AKTUAL"]
        })
        dto = main.AiFullAssistantIn(
            prompt="pindahkan kolom BERAT AKTUAL ke paling depan",
            context_type="builder",
            current_state={
                "available_columns": ["O.AUFNR", "O.MATNR", "Panjang Film (Meter)", "BERAT AKTUAL"],
                "visible_columns": ["O.AUFNR", "O.MATNR", "Panjang Film (Meter)", "BERAT AKTUAL"]
            }
        )
        auth = (SimpleNamespace(user_id="alice"), "token")
        with patch.object(main, "user_catalog", AsyncMock(return_value=[{"id": "conn-dev", "label": "DEV"}])), \
             patch.object(main, "query_llm_with_fallback", AsyncMock(return_value=(llm_response, "test-ai"))):
            result = await main.ai_generate(dto, auth)
        vis = result["data"]["visibleColumns"]
        self.assertEqual(vis, ["BERAT AKTUAL", "O.AUFNR", "O.MATNR", "Panjang Film (Meter)"])

    async def test_ai_generate_sorts_rows(self):
        llm_response = main.json.dumps({
            "explanation": "Mengurutkan data berdasarkan nomor order menurun",
            "sort": {"column": "AUFNR", "direction": "desc"}
        })
        dto = main.AiFullAssistantIn(
            prompt="urutkan data berdasarkan nomor order menurun",
            context_type="builder",
            current_state={
                "available_columns": ["O.AUFNR", "O.MATNR"],
                "visible_columns": ["O.AUFNR", "O.MATNR"]
            }
        )
        auth = (SimpleNamespace(user_id="alice"), "token")
        with patch.object(main, "user_catalog", AsyncMock(return_value=[{"id": "conn-dev", "label": "DEV"}])), \
             patch.object(main, "query_llm_with_fallback", AsyncMock(return_value=(llm_response, "test-ai"))):
            result = await main.ai_generate(dto, auth)
        sort = result["data"]["sort"]
        self.assertEqual(sort["column"], "O.AUFNR")
    async def test_execute_query_chunks_downstream_filters_when_distinct_keys_exceed_30(self):
        # 40 distinct items in upstream table
        t1_rows = [{"AUFNR": f"ORD_{i:03d}", "WERKS": "1000"} for i in range(40)]
        read_calls = []

        async def read_rows(dto, _token):
            read_calls.append(dto)
            if dto.table_name == "AUFK":
                return t1_rows
            # For AFPO, verify it received chunked batch filter with AUFNR
            received_aufnrs = [f.value for f in dto.filters if f.field == "AUFNR"]
            return [{"AUFNR": aufnr, "MATNR": f"MAT_{aufnr}"} for aufnr in received_aufnrs]

        async def structure(_token, _target, table):
            if table == "AUFK":
                return ([{"name": "AUFNR", "data_type": "CHAR", "is_key": True},
                         {"name": "WERKS", "data_type": "CHAR", "is_key": False}], "")
            return ([{"name": "AUFNR", "data_type": "CHAR", "is_key": True},
                     {"name": "MATNR", "data_type": "CHAR", "is_key": False}], "")

        query = main.QueryIn(
            target="conn-dev",
            sources=[
                main.SourceIn(alias="T1", table_name="AUFK", fields=["AUFNR", "WERKS"]),
                main.SourceIn(alias="T2", table_name="AFPO", fields=["MATNR"]),
            ],
            joins=[main.JoinIn(left_alias="T1", left_field="AUFNR",
                               right_alias="T2", right_field="AUFNR")],
        )
        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "get_structure", AsyncMock(side_effect=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=read_rows)):
            result = await main.execute_query(query, "user-token")

        # AUFK (1 call) + AFPO chunk 1 (25 items) + AFPO chunk 2 (15 items) = 3 calls
        self.assertEqual(len(read_calls), 3)
        self.assertEqual(read_calls[0].table_name, "AUFK")
        self.assertEqual(read_calls[1].table_name, "AFPO")
        self.assertEqual(read_calls[2].table_name, "AFPO")
        self.assertEqual(len([f for f in read_calls[1].filters if f.field == "AUFNR"]), 25)
        self.assertEqual(len([f for f in read_calls[2].filters if f.field == "AUFNR"]), 15)
        # All 40 joined rows matched!
        self.assertEqual(len(result["rows"]), 40)

    async def test_execute_query_allows_combined_source_and_chunk_filters_exceeding_30(self):
        t1_rows = [{"AUFNR": f"{1000000 + i}", "WERKS": "1000"} for i in range(25)]
        read_calls = []

        async def read_rows(dto, _token):
            read_calls.append(dto)
            if dto.table_name == "AUFK":
                return t1_rows
            # Verify AFPO has both existing source filters and chunked AUFNR filters (>30 total)
            self.assertGreater(len(dto.filters), 30)
            return [{"AUFNR": f.value, "MATNR": "M1"} for f in dto.filters if f.field == "AUFNR"]

        async def structure(_token, _target, table):
            if table == "AUFK":
                return ([{"name": "AUFNR", "data_type": "CHAR", "is_key": True},
                         {"name": "WERKS", "data_type": "CHAR", "is_key": False}], "")
            return ([{"name": "AUFNR", "data_type": "CHAR", "is_key": True},
                     {"name": "MATNR", "data_type": "CHAR", "is_key": False}], "")

        # T2 has 10 pre-existing filters
        pre_filters = [main.FilterIn(field="MATNR", operator="EQ", value=f"M{i}") for i in range(10)]
        query = main.QueryIn(
            target="conn-dev",
            sources=[
                main.SourceIn(alias="T1", table_name="AUFK", fields=["AUFNR", "WERKS"]),
                main.SourceIn(alias="T2", table_name="AFPO", fields=["MATNR"], filters=pre_filters),
            ],
            joins=[main.JoinIn(left_alias="T1", left_field="AUFNR",
                               right_alias="T2", right_field="AUFNR")],
        )
        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "get_structure", AsyncMock(side_effect=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=read_rows)):
            result = await main.execute_query(query, "user-token")
        self.assertEqual(len(result["rows"]), 25)

    async def test_rename_report(self):
        mock_db = MagicMock()
        mock_report = SimpleNamespace(id="rep-1", owner_id="user-123", name="Old Name")
        mock_db.get.return_value = mock_report

        auth = (SimpleNamespace(user_id="user-123", user_profile={"username": "user1"}), "tok")
        res = await main.rename_report("rep-1", main.ReportRenameIn(name="New Report Name"), auth, mock_db)

        self.assertEqual(res["name"], "New Report Name")
        self.assertEqual(mock_report.name, "New Report Name")
        mock_db.commit.assert_called_once()

    async def test_rpc_call_timeout_raises_504(self):
        with patch("httpx.AsyncClient.post", side_effect=httpx.ReadTimeout("timed out")):
            with self.assertRaises(main.HTTPException) as ctx:
                await main.rpc_call("tok", "conn-dev", "mcp-sap__read_table", {"table": "AUFK"})
            self.assertEqual(ctx.exception.status_code, 504)
            self.assertIn("Waktu tunggu habis", ctx.exception.detail)

    async def test_execute_query_skips_downstream_when_base_empty(self):
        async def structure(_token, _target, table):
            return [{"name": "AUFNR"}, {"name": "WERKS"}, {"name": "MATNR"}], "raw"

        read_rows_calls = []
        async def mock_read_rows(dto, _token):
            read_rows_calls.append(dto.table_name)
            if dto.table_name == "AUFK":
                return []
            return [{"MATNR": "MAT1", "AUFNR": "100"}]

        query = main.QueryIn(
            target="conn-dev",
            sources=[
                main.SourceIn(alias="T1", table_name="AUFK", fields=["AUFNR", "WERKS"]),
                main.SourceIn(alias="T2", table_name="AFPO", fields=["MATNR"]),
            ],
            joins=[main.JoinIn(left_alias="T1", left_field="AUFNR",
                               right_alias="T2", right_field="AUFNR")],
        )
        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "get_structure", AsyncMock(side_effect=structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=mock_read_rows)):
            result = await main.execute_query(query, "user-token")
        self.assertEqual(len(result["rows"]), 0)
        # Verify that AFPO was never queried because AUFK was empty!
        self.assertEqual(read_rows_calls, ["AUFK"])

    async def test_execute_query_structure_failure_proceeds_with_warning(self):
        async def failing_structure(_token, _target, table):
            raise main.HTTPException(502, f"MCP Gateway timeout reading structure for {table}")

        async def mock_read_rows(dto, _token):
            return [{"AUFNR": "1000", "WERKS": "1100"}]

        query = main.QueryIn(
            target="conn-dev",
            sources=[
                main.SourceIn(alias="T1", table_name="AUFK", fields=["AUFNR", "WERKS"]),
            ],
            joins=[],
        )
        with patch.object(main, "user_catalog", AsyncMock(return_value=[
            {"id": "conn-dev", "resource_key": "sap:dev"}])), \
             patch.object(main, "get_structure", AsyncMock(side_effect=failing_structure)), \
             patch.object(main, "read_rows", AsyncMock(side_effect=mock_read_rows)):
            result = await main.execute_query(query, "user-token")
        self.assertEqual(len(result["rows"]), 1)
        self.assertTrue(any("Struktur AUFK tidak dapat diambil" in w for w in result["warnings"]))


if __name__ == "__main__":
    unittest.main()



