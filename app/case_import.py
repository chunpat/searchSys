"""Read embedded WPS DISPIMG and normal Excel drawings; never evaluate formulas."""
from __future__ import annotations

import hashlib
import json
import posixpath
import re
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

from app.product_cases import attach_image, quote_catalog, store_image
from app.dimensions import utc_now

MAX_WORKBOOK_BYTES = 150 * 1024 * 1024
NS = {"s":"http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r":"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "a":"http://schemas.openxmlformats.org/drawingml/2006/main",
      "xdr":"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"}


def read_case_workbook(content):
    if len(content)>MAX_WORKBOOK_BYTES: raise ValueError("案例工作簿不能超过 150 MB")
    try: z=ZipFile(BytesIO(content))
    except BadZipFile as exc: raise ValueError("请选择有效的 .xlsx 文件") from exc
    with z:
        infos=z.infolist()
        if len(infos)>10000 or sum(i.file_size for i in infos)>600*1024*1024:
            raise ValueError("工作簿解压后过大")
        names=set(z.namelist())
        def xml(part):
            if part not in names or z.getinfo(part).file_size>24*1024*1024: raise ValueError("工作簿结构异常或表格过大")
            raw=z.read(part)
            if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw: raise ValueError("不支持包含实体声明的工作簿")
            try: return ET.fromstring(raw)
            except ET.ParseError as exc: raise ValueError("工作簿 XML 无法读取") from exc
        def rels(part):
            rel=posixpath.join(posixpath.dirname(part),"_rels",posixpath.basename(part)+".rels")
            if rel not in names: return {}
            return {r.get("Id"):posixpath.normpath(posixpath.join(posixpath.dirname(part),r.get("Target", ""))).lstrip("/")
                    for r in xml(rel) if r.get("TargetMode")!="External"}
        strings=["".join(si.itertext()) for si in xml("xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in names else []
        bookrels=rels("xl/workbook.xml"); cellmap={}
        if "xl/cellimages.xml" in names:
            cr=rels("xl/cellimages.xml")
            for pic in xml("xl/cellimages.xml").findall(".//xdr:pic",NS):
                props=pic.find(".//xdr:cNvPr",NS);blip=pic.find(".//a:blip",NS)
                if props is not None and blip is not None:
                    media=cr.get(blip.get("{"+NS["r"]+"}embed"))
                    if media: cellmap[props.get("name")]=media
        groups={};sheet_values={}
        def add(sheet,row,cell,media):
            if media not in names or not media.startswith("xl/media/"): return
            group=groups.setdefault((sheet,row),{"sheet":sheet,"row":row,"images":[]})
            if not any(i["media"]==media for i in group["images"]): group["images"].append({"cell":cell,"media":media})
        for sh in xml("xl/workbook.xml").findall("s:sheets/s:sheet",NS):
            sheet=sh.get("name")
            if sh.get("state") in {"hidden","veryHidden"} or sheet=="WpsReserved_CellImgList": continue
            part=bookrels.get(sh.get("{"+NS["r"]+"}id"))
            if not part: continue
            ws=xml(part)
            values={};sheet_values[sheet]=values
            for cell in ws.findall("s:sheetData/s:row/s:c",NS):
                addr=cell.get("r","");f=cell.findtext("s:f",default="",namespaces=NS)
                value=cell.findtext("s:v",default="",namespaces=NS)
                if cell.get("t")=="s" and value:
                    index=int(value)
                    if not 0<=index<len(strings): raise ValueError("工作簿文本索引无效")
                    value=strings[index]
                if cell.get("t")=="inlineStr":
                    inline=cell.find("s:is",NS)
                    value="".join(inline.itertext()) if inline is not None else ""
                if value and not f:
                    values.setdefault(int(re.sub(r"\D","",addr)),{})[re.sub(r"\d","",addr)]=value
                for key in dict.fromkeys(re.findall(r"ID_[A-Fa-f0-9]+",f+" "+value)):
                    if key in cellmap: add(sheet,int(re.sub(r"\D","",addr)),addr,cellmap[key])
            wr=rels(part)
            for drawing in ws.findall("s:drawing",NS):
                dp=wr.get(drawing.get("{"+NS["r"]+"}id"))
                if not dp: continue
                dr=rels(dp)
                for anchor in xml(dp):
                    start=anchor.find("xdr:from",NS)
                    if start is None: continue
                    row=int(start.findtext("xdr:row",namespaces=NS))+1
                    col=int(start.findtext("xdr:col",namespaces=NS))+1
                    letters=""
                    while col: col,r=divmod(col-1,26);letters=chr(65+r)+letters
                    for blip in anchor.findall(".//xdr:pic/xdr:blipFill/a:blip",NS):
                        media=dr.get(blip.get("{"+NS["r"]+"}embed"))
                        if media: add(sheet,row,f"{letters}{row}",media)
        if not groups: raise ValueError("工作簿中没有找到可导入的嵌入图片")
        for group in groups.values():
            values=sheet_values[group['sheet']];headers=values.get(2,{})
            group['sku']=next((values.get(group['row'],{}).get(col,'') for col,name in headers.items() if name.strip()=='SKU'),'')
        media_names={im["media"] for g in groups.values() for im in g["images"]}
        if len(media_names)>1000: raise ValueError("一次最多导入 1000 张图片")
        return list(groups.values()),{name:z.read(name) for name in media_names}


def import_cases(connection,storage,content,filename,user):
    filename=Path(filename).name
    if not filename.lower().endswith(".xlsx") or len(filename)>180: raise ValueError("需要 .xlsx 文件名")
    groups,media=read_case_workbook(content)
    catalog=quote_catalog(connection);by_source={}
    for q in catalog.values(): by_source.setdefault(q["source"],[]).append(q)
    result={"created":0,"skipped":0,"linked":0,"unlinked":0,"images":0,"warnings":[]}
    assets={}
    for group in groups:
        source=f'{filename}!{group["sheet"]}!{group["row"]}'
        origin=hashlib.sha256(source.encode()).hexdigest()
        if connection.execute("SELECT 1 FROM product_cases WHERE origin_key=?",(origin,)).fetchone():
            result["skipped"]+=1;continue
        images=[]
        for im in group["images"]:
            if im["media"] not in assets:
                try: assets[im["media"]]=store_image(connection,storage,media[im["media"]])
                except ValueError as exc:
                    assets[im["media"]]=None;result["warnings"].append(f'{source}: {exc}')
            if assets[im["media"]]: images.append((im,assets[im["media"]]))
        if not images: continue
        quotes=by_source.get(source,[])
        if group['sku'] and quotes:
            matches=[q for q in quotes if str(q['sku'] or '').strip().casefold()==str(group['sku']).strip().casefold()]
            if len(matches)!=len(quotes):result['warnings'].append(f'{source}: SKU 与现有报价不一致，未自动关联，请人工复核')
            quotes=matches
        links=[{"key":q["key"],"snapshot":{k:v for k,v in q.items() if k not in {'dimensionRule','supplierRules'}}} for q in quotes]
        sku=quotes[0]["sku"] if quotes else ""
        model="none"
        if sku in {"马克杯","搪瓷杯","玻璃马克杯","PG4472"}: model="mug"
        elif sku in {"保温杯","磨砂玻璃杯"}: model="thermos"
        elif sku=="DND507": model="dice"
        case_id="CASE-"+origin[:16];now=utc_now()
        title=f'{group["sheet"]} · {sku or "参考资料"} · {group["row"]}'
        connection.execute("""INSERT INTO product_cases(case_id,title,status,model_type,quote_links,source,origin_key,created_at,updated_at,updated_by)
            VALUES(?,?,'draft',?,?,?,?,?,?,?)""",(case_id,title,model,json.dumps(links,ensure_ascii=False),source,origin,now,now,user))
        for im,asset in images:
            attach_image(connection,case_id,asset,"reference",f'{group["sheet"]} {im["cell"]}',f'{filename}!{group["sheet"]}!{im["cell"]}')
            result["images"]+=1
        result["created"]+=1
        result["linked" if links else "unlinked"]+=1
    return result
