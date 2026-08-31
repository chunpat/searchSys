const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/static/api-response.js'), 'utf8'), context);
const read = context.readApiResponse;

test('successful import preserves counts and warnings', async () => {
  const result = await read(new Response(JSON.stringify({created:317,linked:309,unlinked:8,warnings:[]})));
  assert.equal(result.created, 317);
  assert.equal(result.linked, 309);
  assert.equal(result.warnings.length, 0);
});

test('application validation and conflict messages remain readable', async () => {
  for (const status of [400, 409]) {
    await assert.rejects(read(new Response('{"error":"案例已被其他操作更新"}', {status})), new RegExp(`案例已被其他操作更新.*HTTP ${status}`));
  }
});

test('nginx HTML 413 becomes an upload limit message without disclosing the page', async () => {
  const html = '<html><head><title>413 Request Entity Too Large</title></head><body>private-proxy-detail</body></html>';
  await assert.rejects(read(new Response(html,{status:413,headers:{'Content-Type':'text/html'}})), error => {
    assert.match(error.message,/上传大小.*HTTP 413/);
    assert.doesNotMatch(error.message, /Unexpected token|<html>|private-proxy-detail/);
    return true;
  });
});

for (const status of [408, 504, 524]) test(`timeout ${status} reports uncertain completion instead of encouraging duplicate imports`, async () => {
  await assert.rejects(read(new Response('<html>timeout</html>', {status})), new RegExp(`刷新案例列表确认.*HTTP ${status}`));
});

for (const status of [502, 503]) test(`gateway ${status} preserves status and suggests checking logs`, async () => {
  await assert.rejects(read(new Response('Bad Gateway', {status})), new RegExp(`日志.*HTTP ${status}`));
});

test('a login HTML page returned with HTTP 200 is not mistaken for import success', async () => {
  const response={ok:true,status:200,redirected:true,text:async()=>'<html>login</html>'};
  await assert.rejects(read(response),/重定向.*重新登录.*HTTP 200/);
});

test('wrong route, malformed JSON and empty responses never expose a parsing stack', async () => {
  await assert.rejects(read(new Response('<html>not found</html>',{status:404})),/API 地址不存在.*HTTP 404/);
  for (const body of ['', '{"created":', 'null', '[]']) {
    await assert.rejects(read(new Response(body)), /有效的 JSON.*HTTP 200/);
  }
});
