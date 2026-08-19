from __future__ import annotations

import re
from datetime import datetime, timezone


PAPER_SIZES_MM = {
    "A0": (841.0, 1189.0),
    "A1": (594.0, 841.0),
    "A2": (420.0, 594.0),
    "A3": (297.0, 420.0),
    "A4": (210.0, 297.0),
    "A5": (148.0, 210.0),
    "A6": (105.0, 148.0),
}

SIZE_TYPES = {
    "paper": "标准纸张",
    "exact_rect": "精确矩形",
    "max_rect": "上限矩形",
    "range_rect": "范围矩形",
    "exact_3d": "三维尺寸",
    "diameter": "直径",
    "exact_single": "单边尺寸",
    "max_single": "单边上限",
    "multiple": "多规格/多区域",
    "free_text": "自由文本",
    "empty": "无尺寸",
}

COMPARISONS = {
    "standard": "标准规格",
    "exact": "等于",
    "max": "不超过",
    "range": "范围内",
    "approx": "约等于",
    "none": "不可比较",
}

PAIR_RE = re.compile(
    r"(?P<a>\d+(?:\.\d+)?)\s*(?P<ua>mm|cm|in|\")?\s*\*\s*"
    r"(?P<b>\d+(?:\.\d+)?)\s*(?P<ub>mm|cm|in|\")?",
    re.IGNORECASE,
)
TRIPLE_RE = re.compile(
    r"(?P<a>\d+(?:\.\d+)?)\s*(?P<ua>mm|cm|in|\")?\s*\*\s*"
    r"(?P<b>\d+(?:\.\d+)?)\s*(?P<ub>mm|cm|in|\")?\s*\*\s*"
    r"(?P<c>\d+(?:\.\d+)?)\s*(?P<uc>mm|cm|in|\")?",
    re.IGNORECASE,
)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def blank_result(raw_text):
    return {
        "raw_text": raw_text,
        "size_type": "free_text",
        "comparison": "none",
        "width_min_mm": None,
        "width_max_mm": None,
        "height_min_mm": None,
        "height_max_mm": None,
        "depth_min_mm": None,
        "depth_max_mm": None,
        "diameter_min_mm": None,
        "diameter_max_mm": None,
        "paper_format": "",
        "unit_source": "",
        "parse_confidence": "低",
        "review_status": "待确认",
        "source_mode": "auto",
        "parse_note": "未找到可靠的单一尺寸边界",
        "updated_by": "system",
        "updated_at": utc_now(),
    }


def normalize_text(value):
    return (
        str(value or "")
        .strip()
        .replace("×", "*")
        .replace("X", "*")
        .replace("x", "*")
        .replace("#", "*")
        .replace("：", ":")
        .replace("，", ",")
        .replace("\n", " ")
    )


def unit_factor(unit):
    normalized = (unit or "").lower()
    if normalized == "mm":
        return 1.0
    if normalized == "in" or normalized == '"':
        return 25.4
    return 10.0


def trailing_unit(text, end):
    match = re.match(r"\s*(mm|cm|in|\")", text[end : end + 8], re.IGNORECASE)
    return match.group(1) if match else ""


def pair_values(match, text):
    unit_a = match.group("ua") or ""
    unit_b = match.group("ub") or ""
    final_unit = trailing_unit(text, match.end())
    selected_unit = unit_b or unit_a or final_unit or "cm"
    factor_a = unit_factor(unit_a or selected_unit)
    factor_b = unit_factor(unit_b or selected_unit)
    return float(match.group("a")) * factor_a, float(match.group("b")) * factor_b, selected_unit, not bool(unit_a or unit_b or final_unit)


def triple_values(match, text):
    units = [match.group("ua") or "", match.group("ub") or "", match.group("uc") or ""]
    final_unit = trailing_unit(text, match.end())
    selected = next((unit for unit in reversed(units) if unit), final_unit or "cm")
    values = []
    for key, unit in zip(("a", "b", "c"), units):
        values.append(float(match.group(key)) * unit_factor(unit or selected))
    return (*values, selected, not bool(any(units) or final_unit))


def set_rect(result, width, height, comparison, inferred=False):
    result["size_type"] = "max_rect" if comparison == "max" else "exact_rect"
    result["comparison"] = comparison
    if comparison == "max":
        result["width_max_mm"] = round(width, 2)
        result["height_max_mm"] = round(height, 2)
    else:
        result["width_min_mm"] = result["width_max_mm"] = round(width, 2)
        result["height_min_mm"] = result["height_max_mm"] = round(height, 2)
    result["unit_source"] = "推测cm" if inferred else "原文单位"
    result["parse_confidence"] = "低" if inferred else "高"
    result["parse_note"] = "未写单位，按厘米生成建议" if inferred else "自动拆分为长宽边界"
    return result


def parse_dimension(raw_value):
    raw = str(raw_value or "").strip()
    result = blank_result(raw)
    if not raw or raw in {"-", "--", "无", "/", "N/A", "n/a"}:
        result.update(
            size_type="empty",
            comparison="none",
            parse_confidence="高",
            parse_note="原文未提供尺寸",
        )
        return result

    text = normalize_text(raw)
    upper = text.upper()
    paper_match = re.search(r"(?<![A-Z0-9])(A[0-6])(?![A-Z0-9])", upper)
    if paper_match and len(PAIR_RE.findall(text)) == 0:
        paper = paper_match.group(1)
        width, height = PAPER_SIZES_MM[paper]
        result.update(
            size_type="paper",
            comparison="standard",
            width_min_mm=width,
            width_max_mm=width,
            height_min_mm=height,
            height_max_mm=height,
            paper_format=paper,
            unit_source="ISO 216",
            parse_confidence="高",
            parse_note=f"{paper} 标准成品尺寸，排版数仍需另行确认",
        )
        return result

    simplified = re.sub(r"(?:长度|宽度|高度|厚度|长|宽|高|厚)\s*[:]?", "", text)
    triple = TRIPLE_RE.search(simplified)
    if triple:
        width, height, depth, unit, inferred = triple_values(triple, simplified)
        result.update(
            size_type="exact_3d",
            comparison="exact",
            width_min_mm=round(width, 2),
            width_max_mm=round(width, 2),
            height_min_mm=round(height, 2),
            height_max_mm=round(height, 2),
            depth_min_mm=round(depth, 2),
            depth_max_mm=round(depth, 2),
            unit_source="推测cm" if inferred else unit,
            parse_confidence="低" if inferred else "高",
            parse_note="自动拆分为长、宽、高三维尺寸",
        )
        return result

    max_match = re.search(r"最大[^0-9]*(\d+(?:\.\d+)?)[^0-9]{0,6}\*[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(mm|cm)", text, re.IGNORECASE)
    min_match = re.search(r"最小[^0-9]*(\d+(?:\.\d+)?)[^0-9]{0,6}\*[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(mm|cm)", text, re.IGNORECASE)
    if max_match and min_match:
        factor_max = unit_factor(max_match.group(3))
        factor_min = unit_factor(min_match.group(3))
        result.update(
            size_type="range_rect",
            comparison="range",
            width_min_mm=round(float(min_match.group(1)) * factor_min, 2),
            width_max_mm=round(float(max_match.group(1)) * factor_max, 2),
            height_min_mm=round(float(min_match.group(2)) * factor_min, 2),
            height_max_mm=round(float(max_match.group(2)) * factor_max, 2),
            unit_source="原文单位",
            parse_confidence="高",
            parse_note="自动拆分最小与最大长宽",
        )
        return result

    pairs = list(PAIR_RE.finditer(simplified))
    if len(pairs) > 1:
        # One imperial and one metric expression separated by a slash represent
        # the same size; prefer the metric expression. Other repeats are multi-size.
        if "/" in simplified and len(pairs) == 2:
            metric = next((match for match in pairs if "cm" in match.group(0).lower() or "mm" in match.group(0).lower()), None)
            if metric:
                width, height, _unit, inferred = pair_values(metric, simplified)
                comparison = "max" if re.search(r"以内|不超过|不超|内\b", text) else "exact"
                return set_rect(result, width, height, comparison, inferred)
        result.update(
            size_type="multiple",
            comparison="none",
            parse_confidence="低",
            parse_note=f"原文包含 {len(pairs)} 组尺寸，需拆成多条规格后再确认",
        )
        return result

    diameter = re.search(r"直径[^0-9]*(\d+(?:\.\d+)?)\s*(mm|cm)", text, re.IGNORECASE)
    if diameter:
        value = round(float(diameter.group(1)) * unit_factor(diameter.group(2)), 2)
        is_max = bool(re.search(r"以内|不超过|不超|内\b", text))
        result.update(
            size_type="diameter",
            comparison="max" if is_max else "exact",
            diameter_min_mm=None if is_max else value,
            diameter_max_mm=value,
            unit_source="原文单位",
            parse_confidence="高",
            parse_note="自动拆分为直径边界",
        )
        return result

    if pairs:
        width, height, _unit, inferred = pair_values(pairs[0], simplified)
        is_max = bool(re.search(r"以内|不超过|不超|不超出|内(?:\s|$|[,.;，。])", text))
        comparison = "max" if is_max else "approx" if "约" in text else "exact"
        return set_rect(result, width, height, comparison, inferred)

    single = re.search(
        r"(?:(宽度?|高度?|长度?)[^0-9]{0,10})?(\d+(?:\.\d+)?)\s*(mm|cm)\s*(?:以内|内|。|\.|$)",
        text,
        re.IGNORECASE,
    )
    if single:
        axis = single.group(1) or "未指定边"
        value = round(float(single.group(2)) * unit_factor(single.group(3)), 2)
        is_max = bool(re.search(r"以内|不超过|不超|不超出|内", text))
        result.update(
            size_type="max_single" if is_max else "exact_single",
            comparison="max" if is_max else "exact",
            width_min_mm=None if is_max else value,
            width_max_mm=value,
            unit_source="原文单位",
            parse_confidence="中" if axis != "未指定边" else "低",
            parse_note=f"自动拆分单边限制，轴向：{axis}",
        )
        return result

    return result


def ensure_dimension_schema(connection):
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS dimension_normalizations (
            quote_id TEXT PRIMARY KEY,
            raw_text TEXT,
            size_type TEXT NOT NULL,
            comparison TEXT NOT NULL,
            width_min_mm REAL,
            width_max_mm REAL,
            height_min_mm REAL,
            height_max_mm REAL,
            depth_min_mm REAL,
            depth_max_mm REAL,
            diameter_min_mm REAL,
            diameter_max_mm REAL,
            paper_format TEXT,
            unit_source TEXT,
            parse_confidence TEXT,
            review_status TEXT,
            source_mode TEXT,
            parse_note TEXT,
            updated_by TEXT,
            updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS dimension_type_idx ON dimension_normalizations(size_type);
        CREATE INDEX IF NOT EXISTS dimension_status_idx ON dimension_normalizations(review_status);
        """
    )


def sync_dimension_normalizations(connection):
    ensure_dimension_schema(connection)
    quote_rows = connection.execute(
        "SELECT quote_id, custom_size_raw, product_size_raw FROM quotes"
    ).fetchall()
    existing = {
        row["quote_id"]: dict(row)
        for row in connection.execute("SELECT * FROM dimension_normalizations").fetchall()
    }
    valid_ids = set()
    fields = [
        "quote_id", "raw_text", "size_type", "comparison",
        "width_min_mm", "width_max_mm", "height_min_mm", "height_max_mm",
        "depth_min_mm", "depth_max_mm", "diameter_min_mm", "diameter_max_mm",
        "paper_format", "unit_source", "parse_confidence", "review_status",
        "source_mode", "parse_note", "updated_by", "updated_at",
    ]
    placeholders = ", ".join("?" for _ in fields)
    for quote in quote_rows:
        quote_id = quote["quote_id"]
        valid_ids.add(quote_id)
        raw_text = quote["custom_size_raw"] or quote["product_size_raw"] or ""
        previous = existing.get(quote_id)
        if previous and previous["source_mode"] == "manual":
            if previous["raw_text"] != raw_text:
                connection.execute(
                    "UPDATE dimension_normalizations SET raw_text = ?, review_status = '需复核', parse_note = ?, updated_at = ? WHERE quote_id = ?",
                    (raw_text, "尺寸原文已变更，原人工参数需重新确认", utc_now(), quote_id),
                )
            continue
        parsed = parse_dimension(raw_text)
        record = {"quote_id": quote_id, **parsed}
        connection.execute(
            f"INSERT OR REPLACE INTO dimension_normalizations ({', '.join(fields)}) VALUES ({placeholders})",
            [record.get(field) for field in fields],
        )
    stale = set(existing) - valid_ids
    if stale:
        connection.executemany("DELETE FROM dimension_normalizations WHERE quote_id = ?", [(quote_id,) for quote_id in stale])


def dimension_matches(row, width_mm, height_mm, depth_mm=None, tolerance=0.5):
    if row["review_status"] != "已确认":
        return False

    def within(value, minimum, maximum):
        if minimum is not None and value < minimum - tolerance:
            return False
        if maximum is not None and value > maximum + tolerance:
            return False
        return True

    def orientation_matches(width, height):
        direct = within(width, row["width_min_mm"], row["width_max_mm"]) and within(
            height, row["height_min_mm"], row["height_max_mm"]
        )
        rotated = within(height, row["width_min_mm"], row["width_max_mm"]) and within(
            width, row["height_min_mm"], row["height_max_mm"]
        )
        return direct or rotated

    if row["size_type"] in {"paper", "exact_rect", "max_rect", "range_rect", "exact_3d"}:
        if not orientation_matches(width_mm, height_mm):
            return False
        if depth_mm is not None and row["depth_max_mm"] is not None:
            return within(depth_mm, row["depth_min_mm"], row["depth_max_mm"])
        return row["size_type"] != "exact_3d" or depth_mm is not None
    if row["size_type"] in {"exact_single", "max_single"}:
        return within(max(width_mm, height_mm), row["width_min_mm"], row["width_max_mm"])
    if row["size_type"] == "diameter":
        return abs(width_mm - height_mm) <= tolerance and within(width_mm, row["diameter_min_mm"], row["diameter_max_mm"])
    return False
