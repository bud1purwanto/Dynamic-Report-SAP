"""UI contract smoke test; interactive coverage is run separately in a browser."""
import unittest
from pathlib import Path


class TransportUIContractTests(unittest.TestCase):
    def test_admin_panel_uses_verified_backend_and_exposes_all_controls(self):
        root = Path(__file__).resolve().parents[2]
        panel = root / 'frontend/src/SapTransportPanel.tsx'
        self.assertTrue(panel.exists(), 'Admin SAP panel is missing')
        content = panel.read_text()
        for name in ('enable_pyrfc', 'enable_oidc_gateway', 'transport_priority', 'enable_transport_fallback', '/admin/sap-transport', 'role="alert"'):
            self.assertIn(name, content)
        self.assertIn('SapTransportPanel', (root / 'frontend/src/App.tsx').read_text())
