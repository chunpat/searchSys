/* Reverse proxies may return HTML even when the application API returns JSON. */
async function readApiResponse(response) {
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { /* Report the HTTP error without displaying a proxy page. */ }
  const object = data && typeof data === 'object' && !Array.isArray(data);
  if (response.ok && object) return data;
  const status = `HTTP ${response.status}`;
  if (!response.ok && object && typeof data.error === 'string' && data.error.trim()) {
    throw new Error(`${data.error}（${status}）`);
  }
  const hints = {
    413: '服务器或代理拒绝了上传大小。页面允许 150 MB，但代理可能有更小的限制；请调整代理上传限制，或改用服务器命令导入。',
    408: '请求超时。导入结果尚不确定，请先刷新案例列表确认，避免连续重复提交；大文件可改用服务器命令导入。',
    504: '网关等待处理结果超时。后台可能仍在导入，请先刷新案例列表确认，避免连续重复提交；大文件可改用服务器命令导入。',
    524: '代理等待处理结果超时。后台可能仍在导入，请先刷新案例列表确认，避免连续重复提交；大文件可改用服务器命令导入。',
    502: '网关无法正常连接应用。请检查应用容器、内存和代理日志；若正在导入，请先确认案例列表中的结果。',
    503: '应用暂不可用。请检查应用容器和代理日志，确认服务恢复后再操作。',
    403: '请求被拒绝。请检查账号权限或服务器防护规则。',
    404: 'API 地址不存在。请确认部署了最新后端，并检查 /api/ 的代理转发。',
    405: '服务器不接受此请求方式。请检查 API 是否被转发到了静态页面服务。',
    500: '服务器处理失败。请检查应用日志后再操作。',
  };
  const fallback = response.redirected
    ? '请求被重定向，未返回 API 数据。请刷新页面重新登录，并检查代理路由。'
    : '接口未返回有效的 JSON 数据，可能返回了网页或代理错误页。请检查部署版本和 API 转发。';
  throw new Error(`${hints[response.status] || fallback}（${status}）`);
}
