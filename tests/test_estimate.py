import unittest

from app.server import estimate_quote


class EstimateQuoteTests(unittest.TestCase):
    def test_process_is_required(self):
        result = estimate_quote({})
        self.assertEqual(result["status"], "needs_input")

    def test_ambiguous_process_requires_selection(self):
        result = estimate_quote({"process": "印刷"})
        self.assertEqual(result["status"], "needs_selection")
        self.assertGreater(len(result["options"]), 1)

    def test_3d_formula_is_blocked(self):
        result = estimate_quote({"process": "3D印刷"})
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("price", result)

    def test_a3_without_exact_sku_is_blocked(self):
        result = estimate_quote({"process": "印刷（A3不覆膜）"})
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("price", result)

    def test_unique_source_combination_is_direct(self):
        result = estimate_quote({
            "process": "热转印",
            "supplier": "印礼派",
            "material": "不锈钢",
            "sku": "保温杯",
        })
        self.assertEqual(result["status"], "direct")
        self.assertEqual(result["price"], 6)
        self.assertEqual(result["confidence"], "高")

    def test_same_combination_with_multiple_sizes_is_not_direct(self):
        result = estimate_quote({
            "process": "热转印",
            "supplier": "耀庭",
            "material": "400G聚酯纤维",
            "sku": "沙滩巾",
        })
        self.assertEqual(result["status"], "estimated")
        self.assertEqual(result["confidence"], "低")
        self.assertGreater(result["sampleCount"], 1)

    def test_process_history_estimate_has_auditable_range(self):
        result = estimate_quote({"process": "热转印"})
        self.assertEqual(result["status"], "estimated")
        self.assertGreaterEqual(result["historyMax"], result["rangeHigh"])
        self.assertLessEqual(result["historyMin"], result["rangeLow"])
        self.assertGreaterEqual(len(result["suppliers"]), 1)


if __name__ == "__main__":
    unittest.main()
