from __future__ import annotations

import argparse
import hmac
import json
import os
import sqlite3
import sys
import time
from collections import defaultdict
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "app" / "static"
DATA_DIR = ROOT / "data"
DATABASE_PATH = DATA_DIR / "quote_query.db"
SOURCE_JSON_PATH = DATA_DIR / "master_data_source.json"
STAGING_DIR = DATA_DIR / "import_staging"
BACKUP_DIR = DATA_DIR / "backups"
CASE_ASSET_DIR = DATA_DIR / "case_assets"
SESSION_COOKIE = "quote_session"
MAX_IMPORT_BYTES = 25 * 1024 * 1024
LOGIN_ATTEMPTS = {}
LOGIN_LOCK = Lock()

sys.path.insert(0, str(ROOT))
from tools.extract_master_data import main as extract_master_data  # noqa: E402
from app.auth import (  # noqa: E402
    audit,
    authenticate,
    bootstrap_admin,
    create_session,
    create_user,
    delete_session,
    ensure_auth_schema,
    reset_password,
    session_user,
    set_user_active,
)
from app.data_exchange import (  # noqa: E402
    commit_staged_import,
    export_xlsx,
    parse_and_validate,
    stage_import,
)
from app.dimensions import (  # noqa: E402
    COMPARISONS,
    SIZE_TYPES,
    dimension_matches,
    ensure_dimension_schema,
    sync_dimension_normalizations,
    utc_now,
)
from app.product_cases import (  # noqa: E402
    CaseConflict, MAX_IMAGE_BYTES, accessible_asset, case_options, crop_artwork,
    ensure_case_schema, get_case, list_cases, quote_key, remove_image, save_case, upload_image,
)
from app.case_import import import_cases, MAX_WORKBOOK_BYTES  # noqa: E402


@contextmanager
def db_connection():
    connection = sqlite3.connect(DATABASE_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def number(value):
    return value if isinstance(value, (int, float)) else None


def rebuild_database(refresh_source=False):
    DATA_DIR.mkdir(exist_ok=True)
    if refresh_source:
        extract_master_data(SOURCE_JSON_PATH)
    source = json.loads(SOURCE_JSON_PATH.read_text(encoding="utf-8"))

    with db_connection() as connection:
        ensure_auth_schema(connection)
        connection.executescript(
            """
            DROP TABLE IF EXISTS suppliers;
            DROP TABLE IF EXISTS processes;
            DROP TABLE IF EXISTS capabilities;
            DROP TABLE IF EXISTS quotes;
            DROP TABLE IF EXISTS price_rules;
            DROP TABLE IF EXISTS sku_mappings;
            DROP TABLE IF EXISTS import_issues;
            DROP TABLE IF EXISTS app_meta;

            CREATE TABLE suppliers (
                supplier_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                supplier_type TEXT,
                source TEXT,
                status TEXT,
                note TEXT
            );
            CREATE TABLE processes (
                process_id TEXT PRIMARY KEY,
                category TEXT,
                name TEXT NOT NULL,
                file_requirement TEXT,
                material_hint TEXT,
                note TEXT
            );
            CREATE TABLE capabilities (
                capability_id TEXT PRIMARY KEY,
                supplier_id TEXT,
                supplier_name TEXT,
                primary_process TEXT,
                secondary_process TEXT,
                process_id TEXT,
                production_days REAL,
                logistics_days REAL,
                follow_up TEXT,
                note TEXT,
                source TEXT
            );
            CREATE TABLE quotes (
                quote_id TEXT PRIMARY KEY,
                supplier_id TEXT,
                supplier_name TEXT,
                sku TEXT,
                common_sku TEXT,
                process_raw TEXT,
                process_id TEXT,
                material TEXT,
                product_size_raw TEXT,
                custom_size_raw TEXT,
                custom_width_mm REAL,
                custom_height_mm REAL,
                custom_depth_mm REAL,
                dimension_state TEXT,
                production_days REAL,
                logistics_days REAL,
                file_requirement TEXT,
                price_raw TEXT,
                price_min REAL,
                price_max REAL,
                price_type TEXT,
                price_state TEXT,
                note TEXT,
                source TEXT
            );
            CREATE TABLE price_rules (
                rule_id TEXT PRIMARY KEY,
                supplier_id TEXT,
                supplier_name TEXT,
                rule_type TEXT,
                process_raw TEXT,
                material TEXT,
                size_condition TEXT,
                price_min REAL,
                price_max REAL,
                price_unit TEXT,
                rule_raw TEXT,
                rule_state TEXT,
                source TEXT
            );
            CREATE TABLE sku_mappings (
                mapping_id TEXT PRIMARY KEY,
                sku TEXT,
                system_status TEXT,
                process_one TEXT,
                supplier_one TEXT,
                supplier_one_id TEXT,
                fee_one REAL,
                process_two TEXT,
                supplier_two TEXT,
                supplier_two_id TEXT,
                fee_two REAL,
                source TEXT
            );
            CREATE TABLE import_issues (
                issue_id TEXT PRIMARY KEY,
                issue_type TEXT,
                severity TEXT,
                source TEXT,
                detail TEXT,
                suggested_action TEXT,
                status TEXT
            );
            CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);

            CREATE INDEX quotes_sku_idx ON quotes(sku);
            CREATE INDEX quotes_process_idx ON quotes(process_raw);
            CREATE INDEX quotes_supplier_idx ON quotes(supplier_id);
            CREATE INDEX capabilities_process_idx ON capabilities(secondary_process);
            CREATE INDEX sku_mapping_sku_idx ON sku_mappings(sku);
            """
        )

        connection.executemany(
            "INSERT INTO suppliers VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    item["供应商ID"], item["供应商名称"], item["供应商类型"], item["来源"], item["状态"], item["备注"],
                )
                for item in source["suppliers"]
            ],
        )
        connection.executemany(
            "INSERT INTO processes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    item["工艺ID"], item["一级分类"], item["标准工艺名称"], item["通用文件要求"], item["适用材料"], item["通用备注"],
                )
                for item in source["processes"]
            ],
        )
        connection.executemany(
            "INSERT INTO capabilities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    item["能力ID"], item["供应商ID"], item["供应商原名"], item["一级工艺原名"], item["二级工艺原名"],
                    item["标准工艺ID"], number(item["生产时效_天"]), number(item["物流时效_天"]), item["跟单复核"], item["备注"], item["来源"],
                )
                for item in source["capabilities"]
            ],
        )
        connection.executemany(
            "INSERT INTO quotes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    item["报价项ID"], item["供应商ID"], item["供应商原名"], item["SKU"], item["共用SKU原文"],
                    item["工艺原名"], item["标准工艺ID"], item["材质"], item["产品尺寸原文"], item["定制尺寸原文"],
                    number(item["定制宽_mm"]), number(item["定制高_mm"]), number(item["定制深_mm"]), item["尺寸解析状态"],
                    number(item["生产时效_天"]), number(item["物流时效_天"]), item["文件要求"], item["价格原文"],
                    number(item["价格下限"]), number(item["价格上限"]), item["价格类型"], item["价格解析状态"], item["注意事项"], item["来源"],
                )
                for item in source["quote_items"]
            ],
        )
        connection.executemany(
            "INSERT INTO price_rules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    item["规则ID"], item["供应商ID"], item["供应商原名"], item["规则类型"], item["关联工艺原名"], item["材料"],
                    item["尺寸条件原文"], number(item["价格下限"]), number(item["价格上限"]), item["价格单位"], item["规则原文"],
                    item["规则状态"], item["来源"],
                )
                for item in source["price_rules"]
            ],
        )
        connection.executemany(
            "INSERT INTO sku_mappings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    item["映射ID"], item["SKU"], item["系统配置状态"], item["工艺1原名"], item["供应商1原名"], item["供应商1_ID"],
                    number(item["工费1"]), item["工艺2原名"], item["供应商2原名"], item["供应商2_ID"], number(item["工费2"]), item["来源"],
                )
                for item in source["sku_mappings"]
            ],
        )
        connection.executemany(
            "INSERT INTO import_issues VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    item["问题ID"], item["问题类型"], item["严重程度"], item["来源"], item["问题说明"], item["建议处理"], item["处理状态"],
                )
                for item in source["issues"]
            ],
        )
        connection.execute("INSERT INTO app_meta VALUES (?, ?)", ("summary", json.dumps(source["summary"], ensure_ascii=False)))
        sync_dimension_normalizations(connection)
        ensure_case_schema(connection)
    return source["summary"]


def quote_result(record):
    price_min = record["price_min"]
    price_max = record["price_max"]
    state = record["price_state"] or "待结构化"
    if price_min is not None:
        label = f"{price_min:.2f}" if price_max in (None, price_min) else f"{price_min:.2f}-{price_max:.2f}"
        price = f"¥{label}"
        price_status = "可直接报价" if state == "已结构化" else "价格待核实"
    else:
        price = "未结构化"
        price_status = "仅供参考"
    production = record["production_days"]
    logistics = record["logistics_days"]
    total_days = production + logistics if production is not None and logistics is not None else None
    return {
        "quoteId": record["quote_id"],
        "caseQuoteKey": quote_key(record),
        "supplier": record["supplier_name"],
        "sku": record["sku"],
        "process": record["process_raw"],
        "material": record["material"],
        "productSize": record["product_size_raw"],
        "customSize": record["custom_size_raw"],
        "price": price,
        "priceStatus": price_status,
        "priceRaw": record["price_raw"],
        "productionDays": production,
        "logisticsDays": logistics,
        "totalDays": total_days,
        "fileRequirement": record["file_requirement"],
        "note": record["note"],
        "source": record["source"],
        "priceState": state,
        "dimensionState": record["dimension_state"],
    }


def quantile(values, percentile):
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * weight


def round_estimate_price(value):
    if value is None:
        return None
    if value < 10:
        return round(value * 2) / 2
    if value < 50:
        return round(value)
    return round(value / 5) * 5


def resolve_quote_value(connection, column, raw_value):
    """Resolve a typed linked field to one source value before estimating."""
    value = (raw_value or "").strip()
    if not value:
        return {"value": "", "options": []}
    exact = connection.execute(
        f"SELECT DISTINCT {column} FROM quotes WHERE {column} = ? AND {column} <> '' LIMIT 2",
        (value,),
    ).fetchall()
    if exact:
        return {"value": exact[0][0], "options": []}
    options = [
        row[0]
        for row in connection.execute(
            f"SELECT DISTINCT {column} FROM quotes WHERE {column} LIKE ? AND {column} <> '' ORDER BY {column} LIMIT 8",
            (f"%{value}%",),
        ).fetchall()
    ]
    if len(options) == 1:
        return {"value": options[0], "options": []}
    return {"value": "", "options": options}


def estimate_summary(rows):
    prices = [row["price_min"] for row in rows if row["price_min"] is not None]
    median_price = quantile(prices, 0.5)
    low = quantile(prices, 0.25)
    high = quantile(prices, 0.75)
    return {
        "price": round_estimate_price(median_price),
        "low": round(low, 2),
        "high": round(high, 2),
        "historyMin": round(min(prices), 2),
        "historyMax": round(max(prices), 2),
        "sampleCount": len(prices),
        "spread": 0 if not median_price else (high - low) / median_price,
    }


def supplier_estimates(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["supplier_name"] or "未记录供应商"].append(row)
    estimates = []
    for supplier, supplier_rows in grouped.items():
        summary = estimate_summary(supplier_rows)
        production = [row["production_days"] for row in supplier_rows if row["production_days"] is not None]
        logistics = [row["logistics_days"] for row in supplier_rows if row["logistics_days"] is not None]
        estimates.append({
            "supplier": supplier,
            "price": summary["price"],
            "low": summary["low"],
            "high": summary["high"],
            "sampleCount": summary["sampleCount"],
            "productionDays": quantile(production, 0.5),
            "logisticsDays": quantile(logistics, 0.5),
        })
    return sorted(estimates, key=lambda item: (-item["sampleCount"], item["price"], item["supplier"]))[:6]


def estimate_quote(params):
    process_input = params.get("process", "").strip()
    if not process_input:
        return {
            "status": "needs_input",
            "message": "请先选择一个具体工艺，再生成预估报价。",
        }

    with db_connection() as connection:
        ensure_dimension_schema(connection)
        resolved = {}
        fields = {
            "process": ("process_raw", "工艺"),
            "material": ("material", "材质"),
            "supplier": ("supplier_name", "供应商"),
            "sku": ("sku", "SKU"),
        }
        for field, (column, label) in fields.items():
            result = resolve_quote_value(connection, column, params.get(field, ""))
            if result["options"]:
                return {
                    "status": "needs_selection",
                    "field": field,
                    "message": f"{label}匹配到多个值，请从下拉选项中选定后再估价。",
                    "options": result["options"],
                }
            resolved[field] = result["value"]

        process = resolved["process"]
        if not process:
            return {"status": "no_data", "message": "没有找到该工艺的历史报价。"}

        process_lower = process.lower()
        if "3d" in process_lower:
            return {
                "status": "blocked",
                "message": "3D 报价依赖材料、净重、支撑损耗和打印时长，当前公式尚未确认，不能自动预估。",
                "boundaryWarnings": ["请查询历史明细并由供应商人工核价"],
            }

        base_sql = """
            SELECT q.*,
              d.size_type, d.comparison,
              d.width_min_mm, d.width_max_mm, d.height_min_mm, d.height_max_mm,
              d.depth_min_mm, d.depth_max_mm, d.diameter_min_mm, d.diameter_max_mm,
              d.review_status
            FROM quotes q
            LEFT JOIN dimension_normalizations d ON d.quote_id = q.quote_id
            WHERE q.price_state = '已结构化' AND q.price_min IS NOT NULL AND q.process_raw = ?
        """
        process_rows = connection.execute(base_sql, (process,)).fetchall()
        if not process_rows:
            return {"status": "no_data", "message": "该工艺没有可用于估价的固定价样本。"}

        target_values = {}
        for key, label in (("targetWidth", "目标宽"), ("targetHeight", "目标高"), ("targetDepth", "目标厚/深")):
            raw_value = str(params.get(key, "") or "").strip()
            if not raw_value:
                target_values[key] = None
                continue
            try:
                parsed_value = float(raw_value)
            except ValueError:
                return {"status": "needs_input", "message": f"{label}必须是毫米数值。"}
            if parsed_value <= 0:
                return {"status": "needs_input", "message": f"{label}必须大于 0 mm。"}
            target_values[key] = parsed_value

        target_width = target_values["targetWidth"]
        target_height = target_values["targetHeight"]
        target_depth = target_values["targetDepth"]
        if (target_width is None) != (target_height is None):
            return {"status": "needs_input", "message": "按尺寸估价时，目标宽和目标高必须同时填写。"}
        target_size = None
        if target_width is not None:
            target_size = {
                "widthMm": target_width,
                "heightMm": target_height,
                "depthMm": target_depth,
            }
            matching_rows = [
                row for row in process_rows
                if dimension_matches(row, target_width, target_height, target_depth)
            ]
            if not matching_rows:
                return {
                    "status": "blocked",
                    "message": "没有已确认且覆盖该目标尺寸的历史价格边界，暂不自动报价。",
                    "targetSize": target_size,
                    "boundaryWarnings": ["请由管理员先确认对应尺寸规则，或向供应商人工核价"],
                }
            process_rows = matching_rows

        sku = resolved["sku"]
        supplier = resolved["supplier"]
        material = resolved["material"]
        exact_rows = [
            row for row in process_rows
            if sku and supplier and material
            and row["sku"] == sku
            and row["supplier_name"] == supplier
            and row["material"] == material
        ]
        exact_prices = {row["price_min"] for row in exact_rows}
        exact_sizes = {
            (row["product_size_raw"], row["custom_size_raw"])
            for row in exact_rows
            if row["product_size_raw"] or row["custom_size_raw"]
        }
        exact_direct = bool(exact_rows) and len(exact_prices) == 1 and len(exact_sizes) <= 1

        if ("a3" in process_lower or "排版" in process) and not exact_direct:
            return {
                "status": "blocked",
                "message": "A3 排版受版面数、出血、间距、形状和拼版数影响，只有精确命中原 SKU 时才可沿用源价。",
                "boundaryWarnings": ["当前不进行 A3 自动排版换算"],
            }

        warnings = [
            "不包含尺寸插值或超出原尺寸的换算",
            "不包含加急、打样、特殊材质及其他附加费",
            "价格单位沿用源表，下单前需复核计价单位",
        ]
        if target_size:
            warnings[0] = "目标尺寸仅匹配已确认边界，未进行尺寸插值"
        if sku and not exact_rows:
            warnings.insert(0, f"SKU {sku} 未找到完全一致的固定价，已改用同类历史样本")

        if exact_direct:
            selected_rows = exact_rows
            level = "exact"
            basis = "精确命中同 SKU、同供应商、同工艺、同材质的源固定价"
            confidence = "高"
            status = "direct"
        elif exact_rows:
            selected_rows = exact_rows
            level = "exact_group"
            basis = "同 SKU、同供应商、同工艺、同材质存在多个历史尺寸或价格，取中位数作参考"
            confidence = "低" if len(exact_sizes) > 1 else "中"
            status = "estimated"
            warnings.insert(0, "完全一致的组合中仍有多个尺寸或价格，未按目标尺寸换算")
        else:
            candidate_levels = []
            if supplier and material:
                candidate_levels.append((
                    "supplier_process_material", 2,
                    [row for row in process_rows if row["supplier_name"] == supplier and row["material"] == material],
                    "同供应商、同工艺、同材质历史固定价",
                ))
            if supplier:
                candidate_levels.append((
                    "supplier_process", 3,
                    [row for row in process_rows if row["supplier_name"] == supplier],
                    "同供应商、同工艺历史固定价",
                ))
            if material:
                candidate_levels.append((
                    "process_material", 3,
                    [row for row in process_rows if row["material"] == material],
                    "同工艺、同材质的跨供应商历史固定价",
                ))
            candidate_levels.append(("process", 5, process_rows, "同工艺跨供应商历史固定价"))

            selected = next((item for item in candidate_levels if len(item[2]) >= item[1]), None)
            if not selected:
                return {
                    "status": "no_data",
                    "message": "有历史报价，但同类固定价样本不足，暂不生成预估价。",
                    "boundaryWarnings": warnings,
                }
            level, _minimum, selected_rows, basis = selected
            status = "estimated"
            confidence = "中" if level in {"supplier_process_material", "supplier_process"} else "低"

        summary = estimate_summary(selected_rows)
        if summary["spread"] > 0.7 and confidence != "高":
            confidence = "低"
            warnings.insert(0, "历史价格分散较大，建议优先向候选供应商询价")

        comparison_rows = process_rows
        if material:
            same_material = [row for row in process_rows if row["material"] == material]
            if same_material:
                comparison_rows = same_material

        return {
            "status": status,
            "process": process,
            "material": material,
            "supplier": supplier,
            "sku": sku,
            "price": summary["price"],
            "rangeLow": summary["low"],
            "rangeHigh": summary["high"],
            "historyMin": summary["historyMin"],
            "historyMax": summary["historyMax"],
            "confidence": confidence,
            "sampleCount": summary["sampleCount"],
            "basis": basis,
            "level": level,
            "boundaryWarnings": warnings,
            "suppliers": supplier_estimates(comparison_rows),
            "targetSize": target_size,
        }


def search_quotes(params):
    sku = params.get("sku", "").strip()
    process = params.get("process", "").strip()
    material = params.get("material", "").strip()
    supplier = params.get("supplier", "").strip()
    price_only = params.get("priceOnly") == "1"
    max_days = params.get("maxDays", "").strip()

    clauses = []
    values = []
    if sku:
        clauses.append("(q.sku LIKE ? OR q.common_sku LIKE ?)")
        values.extend([f"%{sku}%", f"%{sku}%"])
    if process:
        clauses.append("q.process_raw LIKE ?")
        values.append(f"%{process}%")
    if material:
        clauses.append("q.material LIKE ?")
        values.append(f"%{material}%")
    if supplier:
        clauses.append("q.supplier_name LIKE ?")
        values.append(f"%{supplier}%")
    if price_only:
        clauses.append("q.price_state = '已结构化'")
    if max_days:
        try:
            day_limit = float(max_days)
            clauses.append("q.production_days IS NOT NULL AND q.logistics_days IS NOT NULL AND q.production_days + q.logistics_days <= ?")
            values.append(day_limit)
        except ValueError:
            pass

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"""
        SELECT q.*
        FROM quotes q
        {where}
        ORDER BY
          CASE q.price_state WHEN '已结构化' THEN 0 WHEN '待确认单位' THEN 1 ELSE 2 END,
          CASE WHEN q.production_days IS NULL OR q.logistics_days IS NULL THEN 999 ELSE q.production_days + q.logistics_days END,
          COALESCE(q.price_min, 999999), q.supplier_name
        LIMIT 100
    """
    with db_connection() as connection:
        quote_rows = [quote_result(row) for row in connection.execute(sql, values).fetchall()]
        capability_rows = []
        if process:
            capability_rows = [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT supplier_name, secondary_process, production_days, logistics_days, note, source
                    FROM capabilities
                    WHERE secondary_process LIKE ?
                    ORDER BY production_days, logistics_days, supplier_name
                    LIMIT 30
                    """,
                    (f"%{process}%",),
                ).fetchall()
            ]
    return {"results": quote_rows, "capabilities": capability_rows}


def option_values(params):
    """Return linked dropdown values without making the user choose a strict order."""
    field_columns = {
        "sku": "q.sku",
        "process": "q.process_raw",
        "material": "q.material",
        "supplier": "q.supplier_name",
    }

    def quote_filters(exclude):
        clauses = []
        values = []
        for field, column in field_columns.items():
            value = params.get(field, "").strip()
            if value and field != exclude:
                if field == "sku":
                    clauses.append("(q.sku LIKE ? OR q.common_sku LIKE ?)")
                    values.extend([f"%{value}%", f"%{value}%"])
                else:
                    clauses.append(f"{column} LIKE ?")
                    values.append(f"%{value}%")
        return (f"WHERE {' AND '.join(clauses)}" if clauses else ""), values

    def quote_options(field):
        where, values = quote_filters(field)
        column = field_columns[field]
        with db_connection() as connection:
            return [
                row[0]
                for row in connection.execute(
                    f"SELECT DISTINCT {column} FROM quotes q {where} AND {column} <> '' ORDER BY {column} LIMIT 900"
                    if where
                    else f"SELECT DISTINCT {column} FROM quotes q WHERE {column} <> '' ORDER BY {column} LIMIT 900",
                    values,
                ).fetchall()
            ]

    values = {field: quote_options(field) for field in field_columns}

    # SKU mappings and supplier capability records are useful when starting a
    # search, but they have less detail than a quote. Do not let their full
    # lists dilute a quote-based association once a condition is selected.
    has_quote_constraint = any(params.get(field, "").strip() for field in ("process", "material", "supplier"))

    with db_connection() as connection:
        if not has_quote_constraint:
            mapped_skus = [
                row[0]
                for row in connection.execute(
                    "SELECT DISTINCT sku FROM sku_mappings WHERE sku <> '' ORDER BY sku LIMIT 900"
                ).fetchall()
            ]
            values["sku"] = sorted(set(values["sku"]) | set(mapped_skus))[:900]

        def capability_options(field):
            clauses = []
            query_values = []

            if field != "process" and params.get("process", "").strip():
                clauses.append("secondary_process LIKE ?")
                query_values.append(f"%{params.get('process', '').strip()}%")
            if field != "supplier" and params.get("supplier", "").strip():
                clauses.append("supplier_name LIKE ?")
                query_values.append(f"%{params.get('supplier', '').strip()}%")

            # Capability records do not carry material, so they cannot give a
            # meaningful association after the user filters by material.
            if params.get("material", "").strip() and not clauses:
                return []

            column = "secondary_process" if field == "process" else "supplier_name"
            conditions = [*clauses, f"{column} <> ''"]
            rows = connection.execute(
                f"SELECT DISTINCT {column} FROM capabilities WHERE {' AND '.join(conditions)} "
                f"ORDER BY {column} LIMIT 300",
                query_values,
            ).fetchall()
            return [row[0] for row in rows]

        values["process"] = sorted(set(values["process"]) | set(capability_options("process")))[:300]
        values["supplier"] = sorted(set(values["supplier"]) | set(capability_options("supplier")))[:300]
    return values


def get_dimension_summary():
    with db_connection() as connection:
        ensure_dimension_schema(connection)
        totals = connection.execute(
            """
            SELECT COUNT(*) AS total,
              SUM(CASE WHEN review_status = '已确认' THEN 1 ELSE 0 END) AS confirmed,
              SUM(CASE WHEN review_status = '待确认' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN review_status = '需复核' THEN 1 ELSE 0 END) AS needs_review,
              SUM(CASE WHEN review_status = '待确认' AND parse_confidence = '高'
                AND size_type NOT IN ('multiple', 'free_text', 'empty') THEN 1 ELSE 0 END) AS high_confidence_pending
            FROM dimension_normalizations
            """
        ).fetchone()
        types = [
            {"type": row["size_type"], "label": SIZE_TYPES.get(row["size_type"], row["size_type"]), "count": row["count"]}
            for row in connection.execute(
                "SELECT size_type, COUNT(*) AS count FROM dimension_normalizations GROUP BY size_type ORDER BY count DESC"
            ).fetchall()
        ]
    return {
        "total": totals["total"] or 0,
        "confirmed": totals["confirmed"] or 0,
        "pending": totals["pending"] or 0,
        "needsReview": totals["needs_review"] or 0,
        "highConfidencePending": totals["high_confidence_pending"] or 0,
        "types": types,
        "sizeTypes": SIZE_TYPES,
        "comparisons": COMPARISONS,
    }


def get_dimension_rows(params):
    clauses = []
    values = []
    status = params.get("status", "").strip()
    size_type = params.get("type", "").strip()
    search = params.get("search", "").strip()
    if status:
        clauses.append("d.review_status = ?")
        values.append(status)
    if size_type:
        clauses.append("d.size_type = ?")
        values.append(size_type)
    if search:
        clauses.append("(d.raw_text LIKE ? OR q.sku LIKE ? OR q.process_raw LIKE ? OR q.material LIKE ? OR q.supplier_name LIKE ?)")
        values.extend([f"%{search}%"] * 5)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db_connection() as connection:
        ensure_dimension_schema(connection)
        rows = connection.execute(
            f"""
            SELECT d.*, q.sku, q.process_raw, q.material, q.supplier_name
            FROM dimension_normalizations d
            JOIN quotes q ON q.quote_id = d.quote_id
            {where}
            ORDER BY
              CASE d.review_status WHEN '需复核' THEN 0 WHEN '待确认' THEN 1 ELSE 2 END,
              CASE d.parse_confidence WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
              d.updated_at DESC, d.quote_id
            LIMIT 250
            """,
            values,
        ).fetchall()
    return {
        "rows": [dict(row) for row in rows],
        "sizeTypes": SIZE_TYPES,
        "comparisons": COMPARISONS,
    }


DIMENSION_NUMERIC_FIELDS = (
    "width_min_mm", "width_max_mm", "height_min_mm", "height_max_mm",
    "depth_min_mm", "depth_max_mm", "diameter_min_mm", "diameter_max_mm",
)


def update_dimension_rule(connection, payload, user):
    quote_id = str(payload.get("quoteId", "")).strip()
    if not quote_id:
        raise ValueError("缺少报价项 ID")
    size_type = str(payload.get("sizeType", "")).strip()
    comparison = str(payload.get("comparison", "")).strip()
    review_status = str(payload.get("reviewStatus", "")).strip()
    if size_type not in SIZE_TYPES:
        raise ValueError("尺寸类型无效")
    if comparison not in COMPARISONS:
        raise ValueError("边界条件无效")
    if review_status not in {"待确认", "已确认", "需复核"}:
        raise ValueError("复核状态无效")

    numeric = {}
    for field in DIMENSION_NUMERIC_FIELDS:
        value = payload.get(field)
        if value in (None, ""):
            numeric[field] = None
            continue
        try:
            numeric[field] = float(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"{field} 必须是数值") from error
        if numeric[field] < 0:
            raise ValueError("尺寸不能小于 0")
    for minimum, maximum in (("width_min_mm", "width_max_mm"), ("height_min_mm", "height_max_mm"), ("depth_min_mm", "depth_max_mm"), ("diameter_min_mm", "diameter_max_mm")):
        if numeric[minimum] is not None and numeric[maximum] is not None and numeric[minimum] > numeric[maximum]:
            raise ValueError("尺寸下限不能大于上限")

    cursor = connection.execute(
        f"""
        UPDATE dimension_normalizations SET
          size_type = ?, comparison = ?,
          {', '.join(f'{field} = ?' for field in DIMENSION_NUMERIC_FIELDS)},
          paper_format = ?, review_status = ?, source_mode = 'manual',
          parse_note = ?, updated_by = ?, updated_at = ?
        WHERE quote_id = ?
        """,
        [
            size_type, comparison,
            *[numeric[field] for field in DIMENSION_NUMERIC_FIELDS],
            str(payload.get("paperFormat", "")).strip(), review_status,
            str(payload.get("parseNote", "")).strip(), user["username"], utc_now(), quote_id,
        ],
    )
    if cursor.rowcount != 1:
        raise ValueError("报价项不存在")
    return quote_id


def get_summary():
    with db_connection() as connection:
        counts = {
            "quotes": connection.execute("SELECT COUNT(*) FROM quotes").fetchone()[0],
            "readyPrices": connection.execute("SELECT COUNT(*) FROM quotes WHERE price_state = '已结构化'").fetchone()[0],
            "estimateProcesses": connection.execute(
                """
                SELECT COUNT(*) FROM (
                  SELECT process_raw FROM quotes
                  WHERE price_state = '已结构化' AND price_min IS NOT NULL
                    AND lower(process_raw) NOT LIKE '%3d%'
                  GROUP BY process_raw HAVING COUNT(*) >= 5
                )
                """
            ).fetchone()[0],
            "capabilities": connection.execute("SELECT COUNT(*) FROM capabilities").fetchone()[0],
            "issues": connection.execute("SELECT COUNT(*) FROM import_issues").fetchone()[0],
        }
        suppliers = connection.execute("SELECT COUNT(*) FROM suppliers").fetchone()[0]
    return {**counts, "suppliers": suppliers}


def get_rule_readiness():
    """List the next manual rule-normalisation work without calculating a price."""
    with db_connection() as connection:
        process_rows = [
            dict(row)
            for row in connection.execute(
                """
                SELECT
                  process_raw AS process,
                  COUNT(*) AS quote_count,
                  SUM(CASE WHEN price_state = '已结构化' THEN 1 ELSE 0 END) AS direct_count,
                  SUM(CASE WHEN price_state <> '已结构化' THEN 1 ELSE 0 END) AS pending_price_count,
                  SUM(CASE WHEN custom_size_raw <> '' THEN 1 ELSE 0 END) AS size_candidate_count,
                  SUM(CASE WHEN dimension_state = '待确认' THEN 1 ELSE 0 END) AS unresolved_dimension_count
                FROM quotes
                WHERE process_raw <> ''
                GROUP BY process_raw
                ORDER BY quote_count DESC, pending_price_count DESC, size_candidate_count DESC, process_raw
                LIMIT 12
                """
            ).fetchall()
        ]
        formula_rows = [
            dict(row)
            for row in connection.execute(
                """
                SELECT rule_type, process_raw AS process, COUNT(*) AS rule_count, rule_state
                FROM price_rules
                WHERE rule_state LIKE '待确认%' OR rule_state = '待结构化'
                GROUP BY rule_type, process_raw, rule_state
                ORDER BY rule_count DESC, rule_type
                """
            ).fetchall()
        ]

    for row in process_rows:
        if row["pending_price_count"]:
            row["next_action"] = "先拆为固定价或尺寸分档"
        elif row["size_candidate_count"]:
            row["next_action"] = "先确认尺寸边界，再启用尺寸报价"
        else:
            row["next_action"] = "可作为后续规则样本"
    return {"processes": process_rows, "formulaRules": formula_rows}


def public_user(user):
    return {
        "userId": user["user_id"],
        "username": user["username"],
        "displayName": user["display_name"],
        "role": user["role"],
    }


def login_is_limited(ip_address, username):
    key = (ip_address, (username or "").strip().lower())
    now = time.time()
    with LOGIN_LOCK:
        attempts = [timestamp for timestamp in LOGIN_ATTEMPTS.get(key, []) if now - timestamp < 10 * 60]
        LOGIN_ATTEMPTS[key] = attempts
        return len(attempts) >= 5


def record_login_failure(ip_address, username):
    key = (ip_address, (username or "").strip().lower())
    with LOGIN_LOCK:
        LOGIN_ATTEMPTS.setdefault(key, []).append(time.time())


def clear_login_failures(ip_address, username):
    with LOGIN_LOCK:
        LOGIN_ATTEMPTS.pop((ip_address, (username or "").strip().lower()), None)


class QueryHandler(SimpleHTTPRequestHandler):
    server_version = "QuoteQuery/1.0"

    def log_message(self, format, *args):
        return

    @property
    def ip_address(self):
        return self.client_address[0]

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )

    def send_json(self, payload, status=HTTPStatus.OK, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, content_type, filename):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.security_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self, maximum=1024 * 1024):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("无效的请求长度") from error
        if length <= 0:
            return b""
        if length > maximum:
            raise ValueError("上传内容超过大小限制")
        return self.rfile.read(length)

    def read_json(self, maximum=1024 * 1024):
        try:
            payload = json.loads(self.read_body(maximum).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("请求数据不是有效 JSON") from error
        if not isinstance(payload, dict):
            raise ValueError("请求数据必须是对象")
        return payload

    def raw_session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else ""

    def current_user(self):
        with db_connection() as connection:
            ensure_auth_schema(connection)
            return session_user(connection, self.raw_session_token())

    def require_user(self, admin=False):
        user = self.current_user()
        if not user:
            self.send_json({"error": "请先登录"}, HTTPStatus.UNAUTHORIZED)
            return None
        if admin and user["role"] != "admin":
            self.send_json({"error": "需要管理员权限"}, HTTPStatus.FORBIDDEN)
            return None
        return user

    def require_csrf(self, user):
        supplied = self.headers.get("X-CSRF-Token", "")
        if not supplied or not hmac.compare_digest(supplied, user["csrf_token"]):
            self.send_json({"error": "安全校验失败，请刷新页面重试"}, HTTPStatus.FORBIDDEN)
            return False
        return True

    def session_cookie(self, token, max_age):
        parts = [f"{SESSION_COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Strict", f"Max-Age={max_age}"]
        if os.environ.get("QUOTE_SECURE_COOKIES", "0") == "1":
            parts.append("Secure")
        return "; ".join(parts)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self.send_json({"ok": DATABASE_PATH.exists()})
        if parsed.path == "/api/me":
            user = self.require_user()
            if user:
                return self.send_json({"user": public_user(user), "csrfToken": user["csrf_token"]})
            return None

        if parsed.path.startswith("/api/"):
            admin_paths = {
                "/api/admin/users", "/api/admin/audit", "/api/admin/export",
                "/api/admin/dimensions", "/api/admin/dimensions/summary",
            }
            user = self.require_user(admin=parsed.path in admin_paths or parsed.path.startswith("/api/admin/"))
            if not user:
                return None
            if parsed.path.startswith("/api/case-assets/"):
                with db_connection() as connection:
                    asset = accessible_asset(connection, parsed.path.rsplit("/", 1)[-1], user["role"] == "admin")
                if not asset:
                    return self.send_json({"error": "图片不存在或无权限"}, HTTPStatus.NOT_FOUND)
                filename = asset["thumbnail_name"] if parse_qs(parsed.query).get("thumbnail") == ["1"] else asset["file_name"]
                target = CASE_ASSET_DIR / filename
                if not target.is_file():
                    return self.send_json({"error": "图片文件缺失，请恢复图片备份"}, HTTPStatus.NOT_FOUND)
                data = target.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", asset["mime"])
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("Content-Length", str(len(data)))
                self.security_headers()
                self.end_headers()
                self.wfile.write(data)
                return
            if parsed.path == "/api/cases" or parsed.path.startswith("/api/cases/"):
                try:
                    with db_connection() as connection:
                        if parsed.path == "/api/cases/options":
                            payload = case_options(connection)
                        elif parsed.path == "/api/cases":
                            payload = list_cases(connection, {k:v[0] for k,v in parse_qs(parsed.query).items()}, user["role"] == "admin")
                        else:
                            payload = get_case(connection, parsed.path.rsplit("/",1)[-1], user["role"] == "admin")
                    return self.send_json(payload)
                except KeyError as error:
                    return self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
                except (ValueError, TypeError) as error:
                    return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            if parsed.path == "/api/summary":
                return self.send_json(get_summary())
            if parsed.path == "/api/rule-readiness":
                return self.send_json(get_rule_readiness())
            if parsed.path == "/api/search":
                raw = parse_qs(parsed.query)
                return self.send_json(search_quotes({key: value[0] for key, value in raw.items()}))
            if parsed.path == "/api/estimate":
                raw = parse_qs(parsed.query)
                return self.send_json(estimate_quote({key: value[0] for key, value in raw.items()}))
            if parsed.path == "/api/options":
                raw = parse_qs(parsed.query)
                return self.send_json(option_values({key: value[0] for key, value in raw.items()}))
            if parsed.path == "/api/admin/users":
                with db_connection() as connection:
                    rows = connection.execute(
                        """
                        SELECT user_id, username, display_name, role, is_active, created_at, last_login_at
                        FROM users ORDER BY role, username COLLATE NOCASE
                        """
                    ).fetchall()
                return self.send_json({"users": [dict(row) for row in rows]})
            if parsed.path == "/api/admin/audit":
                with db_connection() as connection:
                    rows = connection.execute(
                        "SELECT username, action, detail, ip_address, created_at FROM audit_logs ORDER BY audit_id DESC LIMIT 100"
                    ).fetchall()
                return self.send_json({"logs": [dict(row) for row in rows]})
            if parsed.path == "/api/admin/dimensions/summary":
                return self.send_json(get_dimension_summary())
            if parsed.path == "/api/admin/dimensions":
                raw = parse_qs(parsed.query)
                return self.send_json(get_dimension_rows({key: value[0] for key, value in raw.items()}))
            if parsed.path == "/api/admin/export":
                file_format = parse_qs(parsed.query).get("format", ["xlsx"])[0]
                source = json.loads(SOURCE_JSON_PATH.read_text(encoding="utf-8"))
                with db_connection() as connection:
                    audit(connection, user, "data_export", file_format, self.ip_address)
                if file_format == "xlsx":
                    return self.send_bytes(
                        export_xlsx(source),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        "quotation-data.xlsx",
                    )
                if file_format == "json":
                    return self.send_bytes(
                        json.dumps(source, ensure_ascii=False, indent=2).encode("utf-8"),
                        "application/json; charset=utf-8",
                        "quotation-data.json",
                    )
                return self.send_json({"error": "仅支持 xlsx 和 json"}, HTTPStatus.BAD_REQUEST)
            return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

        public_files = {"/login.html", "/login.js", "/style.css"}
        if parsed.path in public_files:
            if parsed.path == "/login.html" and self.current_user():
                return self.redirect("/")
            return self.serve_static(parsed.path)
        if not self.current_user():
            return self.redirect("/login.html")
        return self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/login":
            try:
                payload = self.read_json()
            except ValueError as error:
                return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            username = payload.get("username", "")
            if login_is_limited(self.ip_address, username):
                return self.send_json({"error": "登录尝试过多，请 10 分钟后重试"}, HTTPStatus.TOO_MANY_REQUESTS)
            with db_connection() as connection:
                ensure_auth_schema(connection)
                user = authenticate(connection, username, payload.get("password", ""))
                if not user:
                    record_login_failure(self.ip_address, username)
                    audit(connection, None, "login_failed", str(username), self.ip_address)
                    return self.send_json({"error": "用户名或密码错误"}, HTTPStatus.UNAUTHORIZED)
                clear_login_failures(self.ip_address, username)
                token, csrf_token, expires_at = create_session(connection, user["user_id"])
                audit(connection, user, "login", "", self.ip_address)
            return self.send_json(
                {"user": public_user(user), "csrfToken": csrf_token, "expiresAt": expires_at},
                headers={"Set-Cookie": self.session_cookie(token, expires_at - int(time.time()))},
            )

        user = self.require_user(admin=parsed.path.startswith("/api/admin/") or parsed.path == "/api/rebuild")
        if not user or not self.require_csrf(user):
            return None
        try:
            if parsed.path.startswith("/api/admin/cases/"):
                action = parsed.path.rsplit("/", 1)[-1]
                params = {k:v[0] for k,v in parse_qs(parsed.query).items()}
                if action == "upload":
                    content = self.read_body(MAX_IMAGE_BYTES)
                elif action == "import":
                    content = self.read_body(MAX_WORKBOOK_BYTES)
                else:
                    payload = self.read_json()
                with db_connection() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    if action == "save": result = save_case(connection, payload, user["username"])
                    elif action == "upload":
                        result = upload_image(connection,CASE_ASSET_DIR,params.get("caseId"),int(params.get("version",0)),content,params.get("role"),params.get("label","上传图片"),user["username"])
                    elif action == "crop": result = crop_artwork(connection,CASE_ASSET_DIR,payload,user["username"])
                    elif action == "remove-image": result = remove_image(connection,payload,user["username"])
                    elif action == "import": result = import_cases(connection,CASE_ASSET_DIR,content,params.get("filename","cases.xlsx"),user["username"])
                    else: return self.send_json({"error":"接口不存在"}, HTTPStatus.NOT_FOUND)
                    audit(connection,user,"case_"+action,result.get("case_id",json.dumps({k:v for k,v in result.items() if k in {"created","skipped","linked","unlinked"}},ensure_ascii=False)),self.ip_address)
                return self.send_json(result)
            if parsed.path == "/api/logout":
                with db_connection() as connection:
                    delete_session(connection, self.raw_session_token())
                    audit(connection, user, "logout", "", self.ip_address)
                return self.send_json({"ok": True}, headers={"Set-Cookie": self.session_cookie("", 0)})

            if parsed.path == "/api/rebuild":
                summary = rebuild_database(refresh_source=False)
                with db_connection() as connection:
                    audit(connection, user, "database_rebuild", "从当前标准数据重建", self.ip_address)
                return self.send_json({"summary": summary})

            if parsed.path == "/api/admin/users/create":
                payload = self.read_json()
                with db_connection() as connection:
                    user_id = create_user(
                        connection,
                        payload.get("username"),
                        payload.get("displayName"),
                        payload.get("password"),
                        payload.get("role", "member"),
                    )
                    audit(connection, user, "user_create", f"user_id={user_id}", self.ip_address)
                return self.send_json({"ok": True, "userId": user_id}, HTTPStatus.CREATED)

            if parsed.path == "/api/admin/users/status":
                payload = self.read_json()
                target_id = int(payload.get("userId"))
                active = bool(payload.get("active"))
                with db_connection() as connection:
                    set_user_active(connection, target_id, active, user["user_id"])
                    audit(connection, user, "user_status", f"user_id={target_id}; active={active}", self.ip_address)
                return self.send_json({"ok": True})

            if parsed.path == "/api/admin/users/password":
                payload = self.read_json()
                target_id = int(payload.get("userId"))
                with db_connection() as connection:
                    reset_password(connection, target_id, payload.get("password"))
                    audit(connection, user, "user_password_reset", f"user_id={target_id}", self.ip_address)
                return self.send_json({"ok": True})

            if parsed.path == "/api/admin/dimensions/update":
                payload = self.read_json()
                with db_connection() as connection:
                    quote_id = update_dimension_rule(connection, payload, user)
                    audit(connection, user, "dimension_rule_update", quote_id, self.ip_address)
                return self.send_json({"ok": True, "quoteId": quote_id})

            if parsed.path == "/api/admin/dimensions/confirm-high":
                with db_connection() as connection:
                    cursor = connection.execute(
                        """
                        UPDATE dimension_normalizations
                        SET review_status = '已确认', updated_by = ?, updated_at = ?
                        WHERE review_status = '待确认' AND parse_confidence = '高'
                          AND size_type NOT IN ('multiple', 'free_text', 'empty')
                        """,
                        (user["username"], utc_now()),
                    )
                    count = cursor.rowcount
                    audit(connection, user, "dimension_rules_confirm_high", f"count={count}", self.ip_address)
                return self.send_json({"ok": True, "count": count})

            if parsed.path == "/api/admin/import/preview":
                file_format = parse_qs(parsed.query).get("format", [""])[0]
                content = self.read_body(MAX_IMPORT_BYTES)
                reference = json.loads(SOURCE_JSON_PATH.read_text(encoding="utf-8"))
                source, counts, errors = parse_and_validate(content, file_format, reference)
                token = None if errors else stage_import(STAGING_DIR, source, user["user_id"])
                with db_connection() as connection:
                    audit(connection, user, "data_import_preview", f"format={file_format}; errors={len(errors)}", self.ip_address)
                return self.send_json({"counts": counts, "errors": errors, "importToken": token})

            if parsed.path == "/api/admin/import/commit":
                payload = self.read_json()
                summary, backup_path = commit_staged_import(
                    STAGING_DIR,
                    payload.get("importToken", ""),
                    user["user_id"],
                    SOURCE_JSON_PATH,
                    BACKUP_DIR,
                    lambda: rebuild_database(refresh_source=False),
                )
                with db_connection() as connection:
                    audit(connection, user, "data_import_commit", backup_path.name, self.ip_address)
                return self.send_json({"summary": summary, "backup": backup_path.name})
        except CaseConflict as error:
            return self.send_json({"error": str(error)}, HTTPStatus.CONFLICT)
        except (ValueError, TypeError, KeyError) as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:  # pragma: no cover - returned to the browser
            return self.send_json({"error": f"操作失败：{error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
        return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def serve_static(self, request_path):
        relative = "index.html" if request_path in {"/", ""} else request_path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            return self.send_error(HTTPStatus.NOT_FOUND)
        if not target.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_types.get(target.suffix, "application/octet-stream"))
        self.send_header("Cache-Control", "no-store" if target.suffix == ".html" else "private, max-age=300")
        self.security_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Quotation query system")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--refresh-source", action="store_true")
    parser.add_argument("--reset-user-password", metavar="USERNAME")
    args = parser.parse_args()

    if args.refresh_source:
        rebuild_database(refresh_source=True)
        print(f"Refreshed source data and rebuilt {DATABASE_PATH}")
        return
    if args.rebuild or not DATABASE_PATH.exists():
        rebuild_database(refresh_source=False)
    if args.rebuild:
        print(f"Rebuilt {DATABASE_PATH}")
        return

    if args.reset_user_password:
        new_password = os.environ.get("QUOTE_ADMIN_PASSWORD", "")
        if not new_password:
            raise RuntimeError("重置密码时需通过 QUOTE_ADMIN_PASSWORD 环境变量传入新密码")
        with db_connection() as connection:
            ensure_auth_schema(connection)
            target = connection.execute("SELECT user_id FROM users WHERE username = ? COLLATE NOCASE", (args.reset_user_password,)).fetchone()
            if not target:
                raise RuntimeError("账号不存在")
            reset_password(connection, target["user_id"], new_password)
        print(f"Reset password for {args.reset_user_password}")
        return

    with db_connection() as connection:
        bootstrap_admin(connection)
        sync_dimension_normalizations(connection)
        ensure_case_schema(connection)
        connection.execute("PRAGMA journal_mode = WAL")

    server = ThreadingHTTPServer((args.host, args.port), QueryHandler)
    server.daemon_threads = True
    print(f"Quote query system running at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
