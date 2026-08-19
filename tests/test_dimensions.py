import unittest

from app.dimensions import dimension_matches, parse_dimension


class DimensionParserTests(unittest.TestCase):
    def test_exact_cm_rectangle(self):
        result = parse_dimension("9.5*7CM")
        self.assertEqual(result["size_type"], "exact_rect")
        self.assertEqual((result["width_max_mm"], result["height_max_mm"]), (95, 70))
        self.assertEqual(result["parse_confidence"], "高")

    def test_missing_unit_is_low_confidence_cm_suggestion(self):
        result = parse_dimension("9*8")
        self.assertEqual((result["width_max_mm"], result["height_max_mm"]), (90, 80))
        self.assertEqual(result["parse_confidence"], "低")

    def test_inside_means_upper_boundary(self):
        result = parse_dimension("20*30CM内")
        self.assertEqual(result["size_type"], "max_rect")
        self.assertEqual(result["comparison"], "max")
        self.assertIsNone(result["width_min_mm"])
        self.assertEqual((result["width_max_mm"], result["height_max_mm"]), (200, 300))

    def test_labeled_leather_size(self):
        result = parse_dimension("皮革：长*宽：6.3cm*1.3cm")
        self.assertEqual(result["size_type"], "exact_rect")
        self.assertEqual((result["width_max_mm"], result["height_max_mm"]), (63, 13))

    def test_a3_standard(self):
        result = parse_dimension("A3")
        self.assertEqual(result["size_type"], "paper")
        self.assertEqual(result["paper_format"], "A3")
        self.assertEqual((result["width_max_mm"], result["height_max_mm"]), (297, 420))

    def test_labeled_three_dimensional_size(self):
        result = parse_dimension("长165mm x 宽115mm x 厚 60mm")
        self.assertEqual(result["size_type"], "exact_3d")
        self.assertEqual(
            (result["width_max_mm"], result["height_max_mm"], result["depth_max_mm"]),
            (165, 115, 60),
        )

    def test_minimum_and_maximum_range(self):
        result = parse_dimension("图案尺寸:最大9*9CM，最小6*8CM")
        self.assertEqual(result["size_type"], "range_rect")
        self.assertEqual(
            (result["width_min_mm"], result["width_max_mm"], result["height_min_mm"], result["height_max_mm"]),
            (60, 90, 80, 90),
        )

    def test_unrelated_multiple_sizes_require_review(self):
        result = parse_dimension("正面9*8cm，背面6*5cm")
        self.assertEqual(result["size_type"], "multiple")
        self.assertEqual(result["review_status"], "待确认")


class DimensionMatchTests(unittest.TestCase):
    def row(self, **changes):
        result = {
            "review_status": "已确认",
            "size_type": "max_rect",
            "width_min_mm": None,
            "width_max_mm": 200,
            "height_min_mm": None,
            "height_max_mm": 300,
            "depth_min_mm": None,
            "depth_max_mm": None,
            "diameter_min_mm": None,
            "diameter_max_mm": None,
        }
        result.update(changes)
        return result

    def test_upper_boundary_accepts_rotation(self):
        self.assertTrue(dimension_matches(self.row(), 290, 190))
        self.assertFalse(dimension_matches(self.row(), 310, 190))

    def test_pending_rule_never_matches(self):
        self.assertFalse(dimension_matches(self.row(review_status="待确认"), 100, 100))

    def test_3d_requires_depth(self):
        row = self.row(
            size_type="exact_3d",
            width_min_mm=165,
            width_max_mm=165,
            height_min_mm=115,
            height_max_mm=115,
            depth_min_mm=60,
            depth_max_mm=60,
        )
        self.assertFalse(dimension_matches(row, 165, 115))
        self.assertTrue(dimension_matches(row, 165, 115, 60))


if __name__ == "__main__":
    unittest.main()
