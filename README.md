# 定制报价查询系统

内部使用的供应商、工艺、SKU 和历史报价查询系统。支持受控的历史价预估、尺寸边界确认、Excel/JSON 导入导出、管理员与查询账号。

## 本地运行

需要 Python 3.12+ 。首次启动前必须设置管理员账号和密码。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export QUOTE_ADMIN_USERNAME=admin
export QUOTE_ADMIN_PASSWORD='replace-with-a-long-random-password-2026'
python app/server.py --port 8766
```

访问 `http://127.0.0.1:8766/`。运行测试：

```bash
python -m unittest discover -s tests
```

## 部署

公网环境使用 Docker Compose + Caddy，应用端口只在 Docker 内部网络中开放，由 Caddy 提供 HTTPS。详细步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 产品案例与 3D 预览

“产品案例 / 图案”支持供应商 Excel 案例图片导入、报价与 SKU 关联、图片裁剪和管理、多面图案配置，以及可旋转、可调整尺寸的 3D 示意模型。管理员维护案例，查询账号只能查看已启用案例。使用流程、模型尺寸含义和备份方式见 [PRODUCT_CASES.md](PRODUCT_CASES.md)。

## 数据边界

- `data/master_data_source.json` 是新环境的初始业务数据，需纳入版本管理。
- `data/*.db*` 是运行时数据库，可能包含账号和操作记录，禁止提交。
- `.env` 包含真实域名和管理员密码，禁止提交。
- 原始 Excel、导出文件、备份和导入暂存目录不进入 Git。
- 案例数据库与 `data/case_assets/` 中的图片不进入 Git，迁移时需一起备份；只拉取代码不会带入已整理的案例。
- 本地录屏、`data/` 下的视频和 `.workbuddy/` 工作记录不进入 Git，原文件保留在本机。
