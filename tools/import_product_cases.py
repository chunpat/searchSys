"""Add supplier workbook images to the case library without rebuilding quote data."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.server import db_connection, CASE_ASSET_DIR
from app.product_cases import ensure_case_schema
from app.case_import import import_cases
from app.auth import audit


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook",type=Path)
    args=parser.parse_args()
    with db_connection() as connection:
        ensure_case_schema(connection)
        connection.execute("BEGIN IMMEDIATE")
        result=import_cases(connection,CASE_ASSET_DIR,args.workbook.read_bytes(),args.workbook.name,"local-import")
        audit(connection,None,"case_import",json.dumps(result,ensure_ascii=False))
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=="__main__": main()
