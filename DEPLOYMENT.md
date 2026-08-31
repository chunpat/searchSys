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
