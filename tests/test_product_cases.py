import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

from PIL import Image

from app import server
from app.auth import create_session, create_user, ensure_auth_schema
from app.case_import import import_cases, read_case_workbook
from app.product_cases import (
    CaseConflict, accessible_asset, crop_artwork, ensure_case_schema, get_case,
    list_cases, quote_catalog, quote_key, remove_image, save_case, upload_image,
)


def image_bytes():
    data=BytesIO();Image.new('RGB',(120,80),'#e68a70').save(data,format='PNG');return data.getvalue()


def workbook_bytes(sku=''):
    stream=BytesIO()
    with ZipFile(stream,'w') as z:
        z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="示例供应商" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        cells=f'<row r="2"><c r="B2" t="inlineStr"><is><t>SKU</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>{sku}</t></is></c><c r="D3"><f>_xlfn.DISPIMG("ID_AABBCC",1)</f></c></row>'
        z.writestr('xl/worksheets/sheet1.xml',f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{cells}</sheetData></worksheet>')
        z.writestr('xl/cellimages.xml','<cellImages xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:pic><xdr:cNvPr name="ID_AABBCC"/><a:blip r:embed="rId1"/></xdr:pic></cellImages>')
        z.writestr('xl/_rels/cellimages.xml.rels','<Relationships><Relationship Id="rId1" Target="media/test.png"/></Relationships>')
        z.writestr('xl/media/test.png',image_bytes())
    return stream.getvalue()


class ProductCaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.db=sqlite3.connect(self.root/'test.db');self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('''CREATE TABLE quotes(quote_id TEXT PRIMARY KEY,source TEXT,supplier_name TEXT,sku TEXT,
            process_raw TEXT,material TEXT,product_size_raw TEXT,custom_size_raw TEXT,common_sku TEXT,price_raw TEXT)''')
        self.db.execute('INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?)',('QUOTE-1','cases.xlsx!示例供应商!3','示例供应商','PG001','热转印','陶瓷','11OZ','20*9.5cm','PG002,PG003','9.5'))
        ensure_case_schema(self.db);self.db.commit();self.key=next(iter(quote_catalog(self.db)))
        self.assets=self.root/'assets'

    def tearDown(self):
        self.db.close();self.temp.cleanup()

    def create(self,status='draft'):
        return save_case(self.db,{'title':'猫咪杯','quoteKeys':[self.key],'model':'mug','status':status},'admin')

    def payload(self,item,**overrides):
        p={'caseId':item['case_id'],'version':item['version'],'title':item['title'],'model':item['model_type'],'status':item['status'],'quoteKeys':[l['key'] for l in item['links']],'skuTags':item['sku_tags'],'placements':item['placements'],'note':item['note']};p.update(overrides);return p

    def test_stable_link_ignores_quote_id_and_price_but_not_identity(self):
        item=self.create()
        self.db.execute("UPDATE quotes SET quote_id='QUOTE-999',price_raw='12'")
        loaded=get_case(self.db,item['case_id'],True)
        self.assertFalse(loaded['links'][0]['missing'])
        self.assertEqual(loaded['links'][0]['quote']['price_raw'],'12')
        self.db.execute("UPDATE quotes SET sku='OTHER'")
        self.assertTrue(get_case(self.db,item['case_id'],True)['links'][0]['missing'])
        with self.assertRaisesRegex(ValueError,'失效'):
            save_case(self.db,self.payload(loaded,status='enabled'),'admin')

    def test_members_only_see_enabled_cases_and_exact_common_sku(self):
        draft=self.create();enabled=self.create('enabled')
        self.assertEqual(list_cases(self.db,{})['total'],1)
        self.assertEqual(list_cases(self.db,{'sku':'PG002'})['total'],1)
        self.assertEqual(list_cases(self.db,{'sku':'PG00'})['total'],0)
        with self.assertRaises(KeyError):get_case(self.db,draft['case_id'])
        self.assertEqual(list_cases(self.db,{'quoteKey':self.key})['items'][0]['case_id'],enabled['case_id'])

    def test_stale_edit_rejected_and_missing_quote_rejected(self):
        item=self.create();save_case(self.db,self.payload(item,title='新名字'),'admin')
        with self.assertRaises(CaseConflict):save_case(self.db,self.payload(item,title='旧窗口覆盖'),'admin')
        with self.assertRaisesRegex(ValueError,'不存在'):save_case(self.db,{'title':'bad','quoteKeys':['fake']},'admin')

    def test_upload_crop_and_asset_access_follow_case_status(self):
        item=self.create();item=upload_image(self.db,self.assets,item['case_id'],item['version'],image_bytes(),'reference','原图','admin')
        original=item['images'][0];self.assertIsNone(accessible_asset(self.db,original['asset_id']))
        self.assertIsNotNone(accessible_asset(self.db,original['asset_id'],True))
        item=crop_artwork(self.db,self.assets,{'caseId':item['case_id'],'version':item['version'],'imageId':original['image_id'],'left':10,'top':10,'width':50,'height':40},'admin')
        self.assertEqual(len(item['images']),2);self.assertEqual(item['images'][1]['width'],50)
        self.assertEqual(item['images'][0]['width'],120)
        item=save_case(self.db,self.payload(item,status='enabled'),'admin')
        self.assertIsNotNone(accessible_asset(self.db,original['asset_id']))
        save_case(self.db,self.payload(item,status='disabled'),'admin')
        self.assertIsNone(accessible_asset(self.db,original['asset_id']))

    def test_model_dimensions_persist_and_legacy_clients_do_not_erase_them(self):
        item=self.create('enabled')
        self.assertEqual(item['model_dimensions'], {})
        dims={'diameter':82.5,'height':115}
        item=save_case(self.db,self.payload(item,modelDimensions=dims),'admin')
        self.assertEqual(get_case(self.db,item['case_id'])['model_dimensions'],dims)
        item=save_case(self.db,self.payload(item,title='只改标题'),'admin')
        self.assertEqual(item['model_dimensions'],dims)
        item=save_case(self.db,self.payload(item,model='box'),'admin')
        self.assertEqual(item['model_dimensions'],{})
        item=save_case(self.db,self.payload(item,modelDimensions={'width':100,'depth':60,'height':180}),'admin')
        self.assertEqual(item['model_dimensions']['height'],180)
        item=save_case(self.db,self.payload(item,modelDimensions={}),'admin')
        self.assertEqual(item['model_dimensions'],{})

    def test_model_dimensions_reject_incomplete_wrong_shape_and_invalid_values(self):
        item=self.create()
        invalid=[None,[],{'height':100},{'width':80,'depth':80,'height':100},
                 {'diameter':80,'height':None},{'diameter':80,'height':True},
                 {'diameter':80,'height':'100'},{'diameter':80,'height':float('nan')},
                 {'diameter':80,'height':float('inf')},{'diameter':80,'height':0},
                 {'diameter':80,'height':2001}]
        for dims in invalid:
            with self.subTest(dims=dims), self.assertRaisesRegex(ValueError,'模型尺寸'):
                save_case(self.db,self.payload(item,modelDimensions=dims),'admin')
        self.assertEqual(get_case(self.db,item['case_id'],True)['version'],item['version'])

    def test_additive_dimension_migration_preserves_existing_case_and_runs_twice(self):
        item=self.create()
        self.db.execute('ALTER TABLE product_cases DROP COLUMN model_dimensions')
        ensure_case_schema(self.db)
        ensure_case_schema(self.db)
        loaded=get_case(self.db,item['case_id'],True)
        self.assertEqual(loaded['model_dimensions'],{})
        self.assertEqual(loaded['version'],item['version'])
        self.assertEqual(loaded['links'],item['links'])

    def test_artwork_cannot_cross_cases_and_used_artwork_cannot_be_removed(self):
        item=self.create();other=self.create()
        item=upload_image(self.db,self.assets,item['case_id'],item['version'],image_bytes(),'artwork','图案','admin')
        im=item['images'][0];placement={'name':'杯身','surface':'body','artworkId':im['asset_id']}
        with self.assertRaisesRegex(ValueError,'当前案例'):
            save_case(self.db,self.payload(other,placements=[placement]),'admin')
        item=save_case(self.db,self.payload(item,placements=[placement]),'admin')
        with self.assertRaisesRegex(ValueError,'正在'):
            remove_image(self.db,{'caseId':item['case_id'],'version':item['version'],'imageId':im['image_id']},'admin')

    def test_invalid_image_crop_and_surface_are_rejected(self):
        item=self.create()
        with self.assertRaises(ValueError):upload_image(self.db,self.assets,item['case_id'],item['version'],b'<svg onload="alert(1)"/>','artwork','bad','admin')
        with self.assertRaisesRegex(ValueError,'不支持'):
            save_case(self.db,self.payload(item,placements=[{'name':'invalid','surface':'face_20'}]),'admin')
        item=upload_image(self.db,self.assets,item['case_id'],item['version'],image_bytes(),'reference','原图','admin')
        with self.assertRaisesRegex(ValueError,'超出'):
            crop_artwork(self.db,self.assets,{'caseId':item['case_id'],'version':item['version'],'imageId':item['images'][0]['image_id'],'left':100,'top':0,'width':50,'height':50},'admin')

    def test_workbook_import_is_idempotent_and_preserves_manual_edits(self):
        result=import_cases(self.db,self.assets,workbook_bytes(),'cases.xlsx','admin')
        self.assertEqual(result['created'],1);self.assertEqual(result['linked'],1)
        item=list_cases(self.db,{},True)['items'][0]
        self.assertEqual(item['source'],'cases.xlsx!示例供应商!3')
        self.assertEqual(item['images'][0]['source'],'cases.xlsx!示例供应商!D3')
        save_case(self.db,self.payload(item,title='人工整理'),'admin')
        again=import_cases(self.db,self.assets,workbook_bytes(),'cases.xlsx','admin')
        self.assertEqual(again['skipped'],1);self.assertEqual(again['created'],0)
        self.assertEqual(get_case(self.db,item['case_id'],True)['title'],'人工整理')

    def test_invalid_workbook_is_rejected(self):
        with self.assertRaises(ValueError):read_case_workbook(b'not a zip')

    def test_import_does_not_link_same_source_row_with_different_sku(self):
        result=import_cases(self.db,self.assets,workbook_bytes('DIFFERENT-SKU'),'cases.xlsx','admin')
        self.assertEqual(result['linked'],0)
        self.assertEqual(result['unlinked'],1)
        self.assertTrue(result['warnings'])

    def test_opaque_rgba_png_has_a_valid_thumbnail(self):
        data=BytesIO();Image.new('RGBA',(40,40),(20,50,70,255)).save(data,format='PNG')
        item=self.create();item=upload_image(self.db,self.assets,item['case_id'],item['version'],data.getvalue(),'reference','opaque','admin')
        asset=accessible_asset(self.db,item['images'][0]['asset_id'],True)
        with Image.open(self.assets/asset['thumbnail_name']) as im:self.assertEqual(im.size,(40,40))
        self.assertEqual(asset['mime'],'image/png')

    def test_http_permissions_csrf_and_conflict(self):
        ensure_auth_schema(self.db)
        admin_id=create_user(self.db,'case.admin','Admin','ExamplePass123','admin')
        member_id=create_user(self.db,'case.member','Member','ExamplePass123','member')
        admin_token,admin_csrf,_=create_session(self.db,admin_id)
        member_token,member_csrf,_=create_session(self.db,member_id)
        item=self.create();item=upload_image(self.db,self.assets,item['case_id'],item['version'],image_bytes(),'reference','原图','admin')
        self.db.commit()
        with patch.multiple(server,DATABASE_PATH=self.root/'test.db',CASE_ASSET_DIR=self.assets):
            httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.QueryHandler)
            thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
            def req(method,path,payload=None,token='',csrf=''):
                conn=http.client.HTTPConnection('127.0.0.1',httpd.server_port,timeout=5)
                headers={'Content-Type':'application/json','Cookie':f'quote_session={token}','X-CSRF-Token':csrf}
                conn.request(method,path,json.dumps(payload) if payload is not None else None,headers)
                r=conn.getresponse();body=r.read();status=r.status;conn.close();return status,body
            try:
                self.assertEqual(req('GET','/api/cases')[0],401)
                self.assertEqual(req('GET',f'/api/case-assets/{item["images"][0]["asset_id"]}')[0],401)
                self.assertEqual(req('GET',f'/api/cases/{item["case_id"]}',token=member_token)[0],404)
                self.assertEqual(req('GET',f'/api/case-assets/{item["images"][0]["asset_id"]}',token=member_token)[0],404)
                self.assertEqual(req('POST','/api/admin/cases/save',self.payload(item),member_token,member_csrf)[0],403)
                self.assertEqual(req('POST','/api/admin/cases/save',self.payload(item),admin_token,'')[0],403)
                self.assertEqual(req('POST','/api/admin/cases/save',self.payload(item),admin_token,admin_csrf)[0],200)
                self.assertEqual(req('POST','/api/admin/cases/save',self.payload(item),admin_token,admin_csrf)[0],409)
            finally:httpd.shutdown();httpd.server_close();thread.join()


class RebuildCaseTests(unittest.TestCase):
    def test_full_quote_rebuild_preserves_cases_and_associations(self):
        source=json.loads(server.SOURCE_JSON_PATH.read_text())
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source_path=root/'source.json';source_path.write_text(json.dumps(source))
            with patch.multiple(server,DATABASE_PATH=root/'test.db',SOURCE_JSON_PATH=source_path,DATA_DIR=root):
                server.rebuild_database()
                with server.db_connection() as connection:
                    key=next(iter(quote_catalog(connection)))
                    item=save_case(connection,{'title':'保留案例','quoteKeys':[key],'model':'box',
                                              'modelDimensions':{'width':120,'depth':80,'height':160}},'test')
                for i,q in enumerate(source['quote_items']):q['报价项ID']=f'NEW-{i}'
                source_path.write_text(json.dumps(source))
                server.rebuild_database()
                with server.db_connection() as connection:
                    loaded=get_case(connection,item['case_id'],True)
                    self.assertEqual(loaded['title'],'保留案例')
                    self.assertEqual(loaded['model_dimensions'],{'width':120,'depth':80,'height':160})
                    self.assertFalse(loaded['links'][0]['missing'])
                    self.assertTrue(loaded['links'][0]['quote']['quote_id'].startswith('NEW-'))


if __name__=='__main__':unittest.main()
