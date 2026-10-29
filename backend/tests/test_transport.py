import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from backend.app import main


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_routes_block_before_gateway(self):
        with patch.object(main, 'transport_config', return_value={
            'enable_pyrfc': False, 'enable_oidc_gateway': False,
            'transport_priority': 'gateway', 'enable_transport_fallback': False,
        }, create=True), patch.object(main, 'gateway_rpc_call', AsyncMock(), create=True) as gateway:
            with self.assertRaises(HTTPException) as caught:
                await main.rpc_call('user-token', 'sap:dev', 'mcp-sap__read_table', {})
            self.assertEqual(caught.exception.status_code, 503)
            gateway.assert_not_awaited()

    async def test_disabled_routes_block_cached_metadata(self):
        main.STRUCTURE_CACHE[('sap:dev', 'T000')] = (float('inf'), ([{'name': 'ID'}], ''))
        with patch.object(main, 'transport_config', return_value=main.TransportIn(enable_oidc_gateway=False).model_dump()):
            with self.assertRaises(HTTPException) as caught:
                await main.get_structure('tok', {'resource_key': 'sap:dev', 'id': 'dev'}, 'T000')
            self.assertEqual(caught.exception.status_code, 503)
        main.STRUCTURE_CACHE.clear()

    async def test_direct_contract_does_not_require_gateway_tools_list(self):
        with patch.object(main, 'transport_config', return_value=main.TransportIn(enable_pyrfc=True, enable_oidc_gateway=False).model_dump()):
            name, schema = await main.read_tool_contract('tok')
            self.assertEqual(name, 'mcp-sap__read_table')
            self.assertIn('fields', schema['properties'])

    async def test_settings_persist_with_atomic_audit_and_safe_defaults(self):
        from sqlalchemy import create_engine, select
        from sqlalchemy.orm import sessionmaker
        from backend.app.db import Base, SapTransportSettings, SapTransportAudit
        from types import SimpleNamespace
        engine = create_engine('sqlite://', execution_options={'schema_translate_map': {main.settings.database_schema: None}})
        Base.metadata.create_all(engine)
        factory = sessionmaker(engine, expire_on_commit=False)
        auth = (SimpleNamespace(user_id='admin'), 'tok')
        with factory() as db, patch.object(main, 'SessionLocal', factory):
            self.assertEqual(main.transport_config(), main.TransportIn().model_dump())
            dto = main.TransportIn(enable_oidc_gateway=False)
            main.update_transport_settings(dto, auth, db)
            self.assertEqual(main.transport_config(), dto.model_dump())
            main.update_transport_settings(dto, auth, db)
            audit = db.scalars(select(SapTransportAudit)).all()
            self.assertEqual(len(audit), 1)
            self.assertEqual(audit[0].actor, 'admin')
            self.assertTrue(audit[0].before['enable_oidc_gateway'])
            self.assertFalse(audit[0].after['enable_oidc_gateway'])
            self.assertIsNotNone(db.get(SapTransportSettings, 'global'))
        engine.dispose()

    async def test_worker_obeys_disabled_policy(self):
        from backend.app import worker
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        from datetime import timedelta
        session = SimpleNamespace(expires_at=main.utcnow() + timedelta(hours=1), refresh_token=main.fernet.encrypt(b'refresh').decode())
        schedule = SimpleNamespace(enabled=True, report_id='r', owner_id='u', session_id='s')
        report = SimpleNamespace(id='r', owner_id='u', definition={'target': 'dev', 'sources': [{'alias': 'T1', 'table_name': 'T000', 'fields': ['ID']}]})
        db = MagicMock()
        db.get.side_effect = [schedule, report]
        db.execute.return_value.scalar_one_or_none.return_value = session
        db.__enter__.return_value = db
        with patch.object(worker, 'SessionLocal', return_value=db), patch.object(worker, 'refresh_user_token', AsyncMock(return_value=('tok', 'refresh', 900))), patch.object(main, 'transport_config', return_value=main.TransportIn(enable_oidc_gateway=False).model_dump()), patch.object(main, 'user_catalog', AsyncMock(return_value=[{'id': 'dev', 'resource_key': 'sap:dev'}])):
            await worker.execute_schedule('s')
        self.assertEqual(schedule.last_status, 'error')
        self.assertEqual(db.add.call_args.args[0].row_count, 0)

    async def test_gateway_errors_do_not_expose_upstream_secrets(self):
        import httpx
        response = httpx.Response(500, json={'message': 'passwd=DO_NOT_EXPOSE'})
        with patch('httpx.AsyncClient.post', AsyncMock(return_value=response)):
            with self.assertRaises(HTTPException) as caught:
                await main.gateway_rpc_call('tok', 'dev', 'mcp-sap__read_table', {})
        self.assertNotIn('DO_NOT_EXPOSE', caught.exception.detail)

    async def test_missing_sdk_can_fallback_to_user_gateway_only_when_enabled(self):
        from backend.app.sap_direct import DirectUnavailable
        cfg = main.TransportIn(enable_pyrfc=True, transport_priority='pyrfc', enable_transport_fallback=True).model_dump()
        with patch.object(main, 'transport_config', return_value=cfg), patch('backend.app.sap_direct.direct_call', side_effect=DirectUnavailable()), patch.object(main, 'gateway_rpc_call', AsyncMock(return_value={'structuredContent': {'rows': []}})) as gateway:
            await main.rpc_call('personal-token', 'explicit-dev', 'mcp-sap__read_table', {'resource_key': 'sap:dev'})
            self.assertEqual(gateway.call_args.args[0], 'personal-token')
        cfg['enable_transport_fallback'] = False
        with patch.object(main, 'transport_config', return_value=cfg), patch('backend.app.sap_direct.direct_call', side_effect=DirectUnavailable()), patch.object(main, 'gateway_rpc_call', AsyncMock()) as gateway:
            with self.assertRaises(HTTPException):
                await main.rpc_call('tok', 'dev', 'mcp-sap__read_table', {})
            gateway.assert_not_awaited()

    async def test_direct_execution_denial_is_not_retried(self):
        cfg = main.TransportIn(enable_pyrfc=True, transport_priority='pyrfc', enable_transport_fallback=True).model_dump()
        with patch.object(main, 'transport_config', return_value=cfg), patch('backend.app.sap_direct.direct_call', side_effect=HTTPException(502, 'denied')), patch.object(main, 'gateway_rpc_call', AsyncMock()) as gateway:
            with self.assertRaises(HTTPException):
                await main.rpc_call('tok', 'dev', 'mcp-sap__read_table', {})
            gateway.assert_not_awaited()

    async def test_direct_normalizes_rows_and_closes(self):
        from backend.app.sap_direct import direct_call
        import sys, types, os, json
        from unittest.mock import MagicMock
        conn = MagicMock()
        conn.call.return_value = {'FIELDS': [{'FIELDNAME': 'ID', 'OFFSET': '0', 'LENGTH': '3'}], 'DATA': [{'WA': '001'}, {'WA': '002'}]}
        module = types.SimpleNamespace(Connection=MagicMock(return_value=conn))
        mapping = {'sap:dev': {'ashost': 'example.invalid', 'sysnr': '00', 'client': '100', 'user': 'technical', 'passwd': 'secret'}}
        with patch.dict(os.environ, {'LUMINA_PYRFC_TARGETS_JSON': json.dumps(mapping)}), patch.dict(sys.modules, {'pyrfc': module}):
            result = direct_call('connection-id', 'mcp-sap__read_table', {'resource_key': 'sap:dev', 'table_name': 'T000', 'fields': ['ID'], 'rowcount': 2})
        self.assertEqual(main.unpack_rows(result), [{'ID': '001'}, {'ID': '002'}])
        conn.close.assert_called_once()

    async def test_gateway_denial_never_falls_back(self):
        cfg = main.TransportIn(enable_pyrfc=True, enable_transport_fallback=True).model_dump()
        with patch.object(main, 'transport_config', return_value=cfg), patch.object(main, 'gateway_rpc_call', AsyncMock(side_effect=HTTPException(403, 'denied'))):
            with self.assertRaises(HTTPException) as caught:
                await main.rpc_call('tok', 'sap:dev', 'mcp-sap__read_table', {})
            self.assertEqual(caught.exception.status_code, 403)

    async def test_admin_rejects_forged_local_profile(self):
        from types import SimpleNamespace
        auth = (SimpleNamespace(user_profile={'role': 'SUPERADMIN'}, user_id='u'), 'token')
        with patch('httpx.AsyncClient.get', AsyncMock(return_value=__import__('httpx').Response(200, json={'user': {'id': 'u', 'role': 'USER'}}))):
            with self.assertRaises(HTTPException) as caught:
                await main.require_transport_admin(auth)
            self.assertEqual(caught.exception.status_code, 403)
