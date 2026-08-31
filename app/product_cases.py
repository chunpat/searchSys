"""Persistent product cases. Business indexes can be rebuilt without deleting these records."""
from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
import warnings
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from app.dimensions import utc_now

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
MODEL_TYPES = {"none": "仅案例图片", "mug": "马克杯", "taper": "锥形杯", "thermos": "保温杯",
               "bottle": "饮料瓶", "tin": "圆罐", "box": "六面盒", "organizer": "收纳盒", "bag": "手提袋", "dice": "二十面骰子"}
# Millimetres. Defaults describe the template, never a measured supplier product.
MODEL_DIMENSIONS = {
    "none": [],
    "mug": [("diameter", "杯身外径", 64), ("height", "杯身高度", 88)],
    "taper": [("topDiameter", "杯口外径", 78), ("bottomDiameter", "杯底外径", 50), ("height", "杯身高度", 98)],
    "thermos": [("diameter", "杯身外径", 58), ("height", "总高度（含盖）", 154)],
    "bottle": [("diameter", "瓶身外径", 60), ("height", "总高度（含盖）", 148)],
    "tin": [("diameter", "罐体外径", 76), ("height", "总高度（含盖）", 78)],
    "box": [("width", "宽度（左右）", 100), ("depth", "深度（前后）", 72), ("height", "高度", 78)],
    "organizer": [("width", "宽度（左右）", 120), ("depth", "深度（前后）", 80), ("height", "高度", 40)],
    "bag": [("width", "袋身宽度", 83.6), ("depth", "袋身深度", 35.6), ("height", "袋身高度（不含提手）", 106)],
    "dice": [("diameter", "外接球直径", 96)],
}
STATUSES = {"draft": "待整理", "enabled": "已启用", "disabled": "已停用"}
SURFACES = {"front", "back", "left", "right", "top", "bottom", "body"} | {f"face_{n}" for n in range(1, 21)}
SURFACES_BY_MODEL = {
    "none": set(), "mug": {"body", "bottom"}, "taper": {"body", "bottom"},
    "thermos": {"body", "top", "bottom"}, "bottle": {"body", "top", "bottom"},
    "tin": {"body", "top", "bottom"}, "box": {"front", "back", "left", "right", "top", "bottom"},
    "organizer": {"front", "back", "left", "right", "bottom"},
    "bag": {"front", "back", "left", "right", "bottom"}, "dice": {f"face_{n}" for n in range(1, 21)},
}


class CaseConflict(ValueError):
    pass


def ensure_case_schema(connection):
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS product_cases (
            case_id TEXT PRIMARY KEY, title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft', model_type TEXT NOT NULL DEFAULT 'none',
            sku_tags TEXT NOT NULL DEFAULT '[]', quote_links TEXT NOT NULL DEFAULT '[]',
            placements TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '', origin_key TEXT UNIQUE,
            version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS case_assets (
            asset_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, thumbnail_name TEXT NOT NULL,
            mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
            byte_size INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS case_images (
            image_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES product_cases(case_id),
            asset_id TEXT NOT NULL REFERENCES case_assets(asset_id), role TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
            UNIQUE(case_id, asset_id, role)
        );
        CREATE INDEX IF NOT EXISTS case_images_case_idx ON case_images(case_id);
        CREATE INDEX IF NOT EXISTS product_cases_status_idx ON product_cases(status);
    """)
    columns = {r[1] for r in connection.execute("PRAGMA table_info(product_cases)")}
    if "model_dimensions" not in columns:
        connection.execute("ALTER TABLE product_cases ADD COLUMN model_dimensions TEXT NOT NULL DEFAULT '{}'")


def quote_key(row):
    # Do not use sequential QUOTE-xxxx IDs: they change when source rows are inserted.
    fields = ("source", "supplier_name", "sku", "process_raw", "material", "product_size_raw", "custom_size_raw")
    raw = json.dumps([str(row[k] or "").strip() for k in fields], ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def quote_catalog(connection):
    result = {}
    tables={r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    dimensions={r['quote_id']:dict(r) for r in connection.execute("SELECT * FROM dimension_normalizations")} if 'dimension_normalizations' in tables else {}
    rules={}
    if 'price_rules' in tables:
        for r in connection.execute("SELECT supplier_id, rule_raw, rule_state FROM price_rules WHERE rule_type='供应商基础规则'"):
            rules.setdefault(r['supplier_id'],[]).append({'text':r['rule_raw'],'status':r['rule_state']})
    for row in connection.execute("SELECT * FROM quotes ORDER BY quote_id"):
        item = dict(row)
        item["key"] = quote_key(item)
        item['dimensionRule']=dimensions.get(item['quote_id'])
        item['supplierRules']=rules.get(item.get('supplier_id'),[])
        result[item["key"]] = item
    return result


def split_skus(value):
    return list(dict.fromkeys(s.strip() for s in re.split(r"[,，、;；\s]+", value or "") if s.strip()))


def case_options(connection):
    return {"models": MODEL_TYPES, "statuses": STATUSES,
            "modelDimensions": {model: [{"key": key, "label": label, "default": default, "min": 1, "max": 2000}
                                         for key, label, default in fields] for model, fields in MODEL_DIMENSIONS.items()},
            "quotes": [{"key": q["key"], "quoteId": q["quote_id"], "supplier": q["supplier_name"],
                        "sku": q["sku"], "process": q["process_raw"], "material": q["material"],
                        "size": q["custom_size_raw"], "source": q["source"]} for q in quote_catalog(connection).values()]}


def public_case(connection, row, catalog=None):
    item = dict(row)
    for field in ("sku_tags", "quote_links", "placements", "model_dimensions"):
        item[field] = json.loads(item[field])
    catalog = quote_catalog(connection) if catalog is None else catalog
    links = []
    skus = list(item["sku_tags"])
    for saved in item.pop("quote_links"):
        live = catalog.get(saved["key"])
        links.append({"key": saved["key"], "missing": live is None, "snapshot": saved["snapshot"], "quote": live})
        q = live or saved["snapshot"]
        skus.extend(split_skus(q.get("sku", "")))
        skus.extend(split_skus(q.get("common_sku", "")))
    item["links"] = links
    item["skus"] = list(dict.fromkeys(skus))
    item["images"] = [dict(r) for r in connection.execute("""
        SELECT i.*, a.width, a.height, a.mime FROM case_images i
        JOIN case_assets a USING(asset_id) WHERE i.case_id = ? ORDER BY i.rowid
    """, (item["case_id"],))]
    for img in item["images"]:
        img["url"] = f'/api/case-assets/{img["asset_id"]}'
        img["thumbnail"] = img["url"] + "?thumbnail=1"
    item["linkStatus"] = "missing" if any(link["missing"] for link in links) else "linked" if links else "unlinked"
    return item


def get_case(connection, case_id, admin=False):
    row = connection.execute("SELECT * FROM product_cases WHERE case_id = ?", (case_id,)).fetchone()
    if row is None or (not admin and row["status"] != "enabled"):
        raise KeyError("案例不存在或尚未启用")
    return public_case(connection, row)


def list_cases(connection, params, admin=False):
    catalog = quote_catalog(connection)
    rows = connection.execute("SELECT * FROM product_cases ORDER BY updated_at DESC, case_id").fetchall()
    q, sku = str(params.get("q", "")).casefold().strip(), str(params.get("sku", "")).casefold().strip()
    wanted_key = params.get("quoteKey", "")
    status, model = params.get("status", ""), params.get("model", "")
    results, counts = [], {key: 0 for key in STATUSES}
    for row in rows:
        if not admin and row["status"] != "enabled": continue
        counts[row["status"]] += 1
        if status and status != row["status"]: continue
        if model and model != row["model_type"]: continue
        item = public_case(connection, row, catalog)
        if wanted_key and not any(link["key"] == wanted_key for link in item["links"]): continue
        if sku and sku not in [s.casefold() for s in item["skus"]]: continue
        haystack = " ".join([item["title"], item["note"], item["source"], *item["skus"],
            *[json.dumps(link["quote"] or link["snapshot"], ensure_ascii=False) for link in item["links"]]]).casefold()
        if q and q not in haystack: continue
        if params.get("linkStatus") and params["linkStatus"] != item["linkStatus"]: continue
        results.append(item)
    page = max(1, int(params.get("page", 1)))
    size = 24
    return {"items": results[(page-1)*size:page*size], "total": len(results), "page": page, "pageSize": size, "counts": counts}


def checked_text(value, name, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f"{name}不能为空且最长 {limit} 字" if required else f"{name}必须是文本且最长 {limit} 字")
    return value.strip()


def check_version(connection, case_id, version):
    row = connection.execute("SELECT * FROM product_cases WHERE case_id = ?", (case_id,)).fetchone()
    if not row: raise KeyError("案例不存在")
    if isinstance(version, bool) or version != row["version"]:
        raise CaseConflict("案例已被其他操作更新，请重新打开后再保存；你的修改未覆盖原数据")
    return row


def touch_case(connection, case_id, user):
    connection.execute("UPDATE product_cases SET version=version+1, updated_at=?, updated_by=? WHERE case_id=?",
                       (utc_now(), user, case_id))


def save_case(connection, payload, user):
    case_id = payload.get("caseId")
    old = check_version(connection, case_id, payload.get("version")) if case_id else None
    title = checked_text(payload.get("title", ""), "案例名称", 160, True)
    note = checked_text(payload.get("note", ""), "备注", 6000)
    model = payload.get("model", "none")
    status = payload.get("status", "draft")
    if model not in MODEL_TYPES or status not in STATUSES: raise ValueError("无效的模型或状态")
    dimensions = payload.get("modelDimensions", json.loads(old["model_dimensions"]) if old and old["model_type"] == model else {})
    expected = {key for key, _, _ in MODEL_DIMENSIONS[model]}
    if not isinstance(dimensions, dict) or (dimensions and set(dimensions) != expected):
        raise ValueError("模型尺寸字段与当前模型不匹配，请填写完整的模型尺寸")
    for key, value in dimensions.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 1 <= value <= 2000:
            raise ValueError("模型尺寸必须是 1 至 2000 mm 范围内的数字")
    tags = payload.get("skuTags", [])
    keys = payload.get("quoteKeys", [])
    if not isinstance(tags, list) or len(tags)>200 or not isinstance(keys, list) or len(keys)>100:
        raise ValueError("SKU 或关联报价数量过多")
    tags = list(dict.fromkeys(checked_text(t, "SKU", 100, True) for t in tags))
    catalog = quote_catalog(connection)
    saved = {v["key"]:v for v in json.loads(old["quote_links"])} if old else {}
    links = []
    for key in dict.fromkeys(keys):
        if key in catalog: links.append({"key":key,"snapshot":{k:v for k,v in catalog[key].items() if k not in {'dimensionRule','supplierRules'}}})
        elif key in saved: links.append(saved[key])
        else: raise ValueError("关联报价不存在，请刷新报价列表")
    placements = payload.get("placements", [])
    if not isinstance(placements, list) or len(placements)>24: raise ValueError("最多设置 24 个定制区域")
    asset_ids = {r[0] for r in connection.execute("SELECT asset_id FROM case_images WHERE case_id=? AND role='artwork'", (case_id or "",))}
    cleaned = []
    for p in placements:
        if not isinstance(p, dict): raise ValueError("定制区域格式错误")
        surface = p.get("surface")
        if surface not in SURFACES_BY_MODEL[model]: raise ValueError("当前模型不支持该定制面，请删除或调整区域")
        asset = p.get("artworkId", "")
        if asset and asset not in asset_ids: raise ValueError("图案必须来自当前案例的图案素材")
        current = {"name": checked_text(p.get("name", ""), "区域名称", 80, True), "surface":surface,
                   "process": checked_text(p.get("process", ""), "区域工艺", 100), "artworkId":asset}
        for field, default, low, high in [("widthMm",45,.1,2000),("heightMm",45,.1,2000),("x",0,-180,180),("y",0,-100,100),("rotation",0,-180,180)]:
            value = p.get(field, default)
            if isinstance(value, bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
                raise ValueError(f"区域参数 {field} 必须在 {low} 至 {high} 范围内")
            current[field] = value
        cleaned.append(current)
    if status == "enabled" and (not links and not tags): raise ValueError("启用前至少关联一条报价或一个 SKU")
    if status == "enabled" and any(link["key"] not in catalog for link in links): raise ValueError("存在失效报价关联，请重新关联后启用")
    now = utc_now()
    values = (title,status,model,json.dumps(dimensions),json.dumps(tags,ensure_ascii=False),json.dumps(links,ensure_ascii=False),json.dumps(cleaned,ensure_ascii=False),note,now,user)
    if old:
        connection.execute("""UPDATE product_cases SET title=?,status=?,model_type=?,model_dimensions=?,sku_tags=?,quote_links=?,placements=?,note=?,updated_at=?,updated_by=?,version=version+1 WHERE case_id=?""", (*values,case_id))
    else:
        case_id = "CASE-"+secrets.token_hex(8)
        connection.execute("""INSERT INTO product_cases(title,status,model_type,model_dimensions,sku_tags,quote_links,placements,note,updated_at,updated_by,case_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (*values,case_id,now))
    return get_case(connection,case_id,True)


def store_image(connection, storage, content):
    if not content or len(content)>MAX_IMAGE_BYTES: raise ValueError("图片大小必须在 12 MB 以内")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            original = Image.open(BytesIO(content))
            if original.format not in {"PNG","JPEG","WEBP"}: raise ValueError("仅支持 PNG、JPG、WebP 图片")
            if original.width*original.height>MAX_IMAGE_PIXELS: raise ValueError("图片像素总数不能超过 2400 万")
            original.load()
            img = ImageOps.exif_transpose(original).convert("RGBA" if "A" in original.getbands() or "transparency" in original.info else "RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise ValueError("图片损坏或尺寸过大") from exc
    encoded=BytesIO()
    transparent = img.mode == "RGBA" and img.getchannel("A").getextrema()[0]<255
    use_png = transparent or original.format != "JPEG"
    suffix, mime = ("png","image/png") if use_png else ("jpg","image/jpeg")
    if use_png: img.save(encoded,format="PNG")
    else: img.convert("RGB").save(encoded,format="JPEG",quality=93)
    data=encoded.getvalue(); asset=hashlib.sha256(data).hexdigest()
    file_name=asset+"."+suffix; thumb_name=asset+"-thumb."+suffix
    storage=Path(storage); storage.mkdir(parents=True,exist_ok=True)
    if not (storage/file_name).exists(): (storage/file_name).write_bytes(data)
    if not (storage/thumb_name).exists():
        thumb=img.copy(); thumb.thumbnail((480,480))
        if not use_png: thumb=thumb.convert("RGB")
        thumb.save(storage/thumb_name,format="PNG" if use_png else "JPEG")
    connection.execute("""INSERT OR IGNORE INTO case_assets VALUES(?,?,?,?,?,?,?,?)""",(asset,file_name,thumb_name,mime,img.width,img.height,len(data),utc_now()))
    return asset


def attach_image(connection,case_id,asset,role,label="",source=""):
    if role not in {"reference","artwork"}: raise ValueError("无效的图片类型")
    label=checked_text(label,"图片名称",160)
    connection.execute("INSERT OR IGNORE INTO case_images VALUES(?,?,?,?,?,?)",("IMG-"+secrets.token_hex(8),case_id,asset,role,label,source))


def upload_image(connection,storage,case_id,version,content,role,label,user):
    check_version(connection,case_id,version)
    if connection.execute("SELECT count(*) FROM case_images WHERE case_id=?",(case_id,)).fetchone()[0]>=40:
        raise ValueError("单个案例最多保存 40 张图片")
    asset=store_image(connection,storage,content)
    attach_image(connection,case_id,asset,role,label)
    touch_case(connection,case_id,user)
    return get_case(connection,case_id,True)


def crop_artwork(connection,storage,payload,user):
    case_id=payload.get("caseId");check_version(connection,case_id,payload.get("version"))
    image=connection.execute("SELECT a.* FROM case_assets a JOIN case_images i USING(asset_id) WHERE i.case_id=? AND i.image_id=?",(case_id,payload.get("imageId"))).fetchone()
    if not image: raise ValueError("原图不属于当前案例")
    coords=[payload.get(k) for k in ("left","top","width","height")]
    if any(isinstance(v,bool) or not isinstance(v,int) for v in coords): raise ValueError("裁剪坐标必须是整数像素")
    x,y,w,h=coords
    if x<0 or y<0 or w<2 or h<2 or x+w>image["width"] or y+h>image["height"]: raise ValueError("裁剪区域超出原图")
    with Image.open(Path(storage)/image["file_name"]) as im:
        result=BytesIO();im.crop((x,y,x+w,y+h)).save(result,format="PNG")
    return upload_image(connection,storage,case_id,payload["version"],result.getvalue(),"artwork",payload.get("label","裁剪图案"),user)


def remove_image(connection,payload,user):
    case_id=payload.get("caseId"); row=check_version(connection,case_id,payload.get("version"))
    image=connection.execute("SELECT * FROM case_images WHERE case_id=? AND image_id=?",(case_id,payload.get("imageId"))).fetchone()
    if not image: raise ValueError("图片不存在")
    if image["role"]=="artwork" and any(p.get("artworkId")==image["asset_id"] for p in json.loads(row["placements"])):
        raise ValueError("该图案正在定制区域中使用，请先解除区域关联并保存")
    connection.execute("DELETE FROM case_images WHERE image_id=?",(image["image_id"],))
    touch_case(connection,case_id,user)
    return get_case(connection,case_id,True)


def accessible_asset(connection,asset_id,admin=False):
    if not re.fullmatch(r"[a-f0-9]{64}",asset_id): return None
    return connection.execute("""SELECT a.* FROM case_assets a WHERE asset_id=? AND EXISTS(
        SELECT 1 FROM case_images i JOIN product_cases c USING(case_id)
        WHERE i.asset_id=a.asset_id AND (? OR c.status='enabled'))""",(asset_id,admin)).fetchone()
