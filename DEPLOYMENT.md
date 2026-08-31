# 公网部署与数据管理

## 准备

- 一台安装了 Docker 的 Linux 服务器。
- 一个域名，DNS A/AAAA 记录指向服务器。
- 防火墙只开放 `80` 和 `443`，不对公网开放应用端口 `8765`。

## 测试服务器首次部署

1. 为测试环境准备一个独立子域名，例如 `quote-test.example.com`，并将 DNS 指向服务器。
2. 从 Git 仓库拉取项目：

```bash
git clone <your-git-repository-url> quote-query
cd quote-query
```

3. 复制 `.env.example` 为 `.env`，设置测试域名和长随机管理员密码：

```bash
cp .env.example .env
chmod 600 .env
```

`.env` 示例：

```dotenv
DOMAIN=quote-test.example.com
QUOTE_ADMIN_USERNAME=admin
QUOTE_ADMIN_PASSWORD=replace-with-a-unique-long-random-password
```

4. 先校验配置，再启动：

```bash
docker compose config --quiet
docker compose up -d --build
```

5. 检查容器和健康状态：

```bash
docker compose ps
docker compose logs --tail=200 app caddy
curl -fsS https://quote-test.example.com/api/health
```

6. 访问 `https://测试域名`。Caddy 会自动申请和续期 HTTPS 证书。首次创建的管理员密码只来自服务器上的 `.env`。

## 账号权限

- `查询账号`：可查询历史报价和生成受控预估。
- `管理员`：额外可创建/停用账号、重置密码、导入导出数据、重建查询索引及查看审计日志。
- 系统禁止停用当前账号，也禁止停用最后一个管理员。

## 数据导出

管理员页面可导出：

- `Excel`：适合业务人员修改，包含报价、SKU 映射、供应商能力、规则和问题清单等完整工作表。
- `JSON`：适合备份、迁移和程序间交换。

## 数据导入

1. 先导出标准 Excel 或 JSON。
2. Excel 中只修改数据行，不修改工作表名、列名和列顺序。
3. 上传后先点击“预检导入”。
4. 只有预检无错误时才会出现“确认导入”。
5. 确认后会全量替换数据并重建 SQLite 索引；原 JSON 会备份到持久化数据目录的 `backups/`。

## 备份与更新

### 案例 Excel 上传返回 HTML 错误页

若页面显示 `Unexpected token '<' ... is not valid JSON`，表示请求返回了网页而不是 API JSON；这条旧提示本身不能确定是文件损坏、上传限制还是代理超时。新页面会显示 HTTP 状态码和处理建议。可在浏览器开发者工具的 Network 中查看 `/api/admin/cases/import` 请求的状态和响应类型，不要分享 Cookie 或认证请求头。

- **413**：某层代理拒绝了请求大小。应用允许 150 MB，不代表外层代理也允许。使用 Nginx 时，应在实际接收该请求的 `server` 或 `location` 中配置适当的 `client_max_body_size`（例如 `160m`），先校验配置再重载；不要关闭所有上传限制。依据：[Nginx 上传大小配置](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)。
- **504 / 524 / 408**：请求超时，后台可能仍在处理。先刷新案例列表并检查服务状态，不要马上重复提交。Nginx 的 `proxy_read_timeout` 控制两次读取上游响应之间的等待时间，延长它不能解决更外层 CDN 的独立限制。依据：[Nginx 代理响应超时](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)。
- **502 / 503**：检查 `docker compose ps` 和 `docker compose logs --tail=100 app caddy`，确认进程、内存和代理连接是否正常。
- **200 + HTML / 404 / 405**：检查是否登录过期、`/api/` 被转发到了静态站点，或者前后端版本不同。

本项目自带 Caddy 配置没有额外设置上传大小限制；若部署前方还有面板 Nginx、Ingress 或 CDN，需要检查实际整条代理链，不能只改应用中的 150 MB 数字。

### 从服务器直接导入大案例工作簿

项目自带的 Docker Compose 部署可使用现有命令导入工具，避开 HTTP 上传和网关等待，但仍执行应用的文件校验、去重和关联规则。不需要关闭认证、公开容器端口或覆盖现有数据库。

1. 先备份现有 `quote_data` 卷；若刚发生网页超时，确认后台处理已经结束，避免并发导入。
2. 通过服务器文件管理工具或 SCP 将原始工作簿放到服务器项目目录，保留文件名、工作表名和行位置。
3. 在包含 `docker-compose.yml` 的目录执行（两处均使用实际原文件名）：

```bash
docker compose cp '副本供应商工艺沉淀 2026.7.16.xlsx' app:/tmp/
docker compose exec -T app python tools/import_product_cases.py '/tmp/副本供应商工艺沉淀 2026.7.16.xlsx'
```

结果中的 `created` 为新增案例，`linked` 为关联成功，`unlinked` 为待关联，`skipped` 为已存在而跳过的案例。案例和图片写入正在使用的 `/app/data` 持久卷，回到管理员页面点击“查找案例”查看“待整理”记录。重复导入不会覆盖原有人工编辑。网页导入和命令导入不要同时执行；导入较大工作簿期间，其他数据库写操作可能需要等待。

此方式同样受服务器内存、磁盘空间和应用 150 MB 文件上限约束。工作簿中的示意图片不会自动成为已经裁剪、定位完毕的生产图案。

### 日常备份与更新

- 应用数据保存在 Docker 卷 `quote_data`，更新镜像不会覆盖数据。
- 产品案例与图案保存在同一卷中的数据库及 `case_assets/`。备份/恢复必须包含二者；管理员导出的报价 Excel/JSON 不包含案例图片。使用说明见 [PRODUCT_CASES.md](PRODUCT_CASES.md)。
- 建议每日备份 `quote_data`，并定期在管理员页导出 JSON 存档。
- 更新应用：

```bash
git pull --ff-only
docker compose config --quiet
docker compose up -d --build
```

- 查看状态：

```bash
docker compose ps
docker compose logs --tail=200 app caddy
```

## 回滚

代码回滚前先确保 `quote_data` 已备份。切换到上一个已验证的提交后重建容器：

```bash
git log --oneline -10
git switch --detach <known-good-commit>
docker compose up -d --build
```

回滚代码不会自动回滚数据。如果新版曾导入或改写业务数据，应使用同一时点的 `quote_data` 备份恢复。

## 管理员密码恢复

如果所有管理员都无法登录，由服务器管理员在命令行执行：

```bash
docker compose run --rm -e QUOTE_ADMIN_PASSWORD='new-long-password-2026' app \
  python app/server.py --reset-user-password admin
docker compose up -d
```
