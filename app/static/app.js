const form = document.querySelector("#searchForm");
const body = document.querySelector("#resultBody");
const resultMeta = document.querySelector("#resultMeta");
const capabilitySection = document.querySelector("#capabilitySection");
const capabilityList = document.querySelector("#capabilityList");
const detailPanel = document.querySelector("#detailPanel");
const detailBackdrop = document.querySelector("#detailBackdrop");
const detailContent = document.querySelector("#detailContent");
const detailTitle = document.querySelector("#detailTitle");
const rebuildButton = document.querySelector("#rebuildButton");
const ruleReadinessBody = document.querySelector("#ruleReadinessBody");
const formulaRuleNote = document.querySelector("#formulaRuleNote");
const estimateButton = document.querySelector("#estimateButton");
const estimateSection = document.querySelector("#estimateSection");
const estimateStatus = document.querySelector("#estimateStatus");
const estimateContent = document.querySelector("#estimateContent");
const dimensionPanel = document.querySelector("#dimensionPanel");
const dimensionBackdrop = document.querySelector("#dimensionBackdrop");
const dimensionForm = document.querySelector("#dimensionForm");
const tabButtons = [...document.querySelectorAll("[data-tab-target]")];
const tabPanels = [...document.querySelectorAll("[data-tab-panel]")];
let currentResults = [];
let currentDimensionRows = [];
let dimensionTypeLabels = {};
let dimensionComparisonLabels = {};
const linkedFields = ["sku", "process", "material", "supplier"];
let optionTimer;
let optionRequestId = 0;
let csrfToken = "";
let sessionUser = null;
let pendingImportToken = "";

function activateTab(requestedTab, updateLocation = true) {
  const requestedButton = tabButtons.find((button) => button.dataset.tabTarget === requestedTab && !button.hidden);
  const activeButton = requestedButton || tabButtons.find((button) => button.dataset.tabTarget === "query");
  const activeTab = activeButton.dataset.tabTarget;
  tabButtons.forEach((button) => {
    const selected = !button.hidden && button.dataset.tabTarget === activeTab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== activeTab;
  });
  if (updateLocation) history.replaceState(null, "", `#${activeTab}`);
  if (activeTab === "cases") window.dispatchEvent(new CustomEvent("cases:activate"));
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tabTarget));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const available = tabButtons.filter((item) => !item.hidden);
    const currentIndex = available.indexOf(button);
    const targetIndex = event.key === "Home" ? 0
      : event.key === "End" ? available.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    available[targetIndex].focus();
    activateTab(available[targetIndex].dataset.tabTarget);
  });
});

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    window.location.replace("/login.html");
    throw new Error("登录已过期");
  }
  return response;
}

async function postJson(url, payload) {
  const response = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readApiResponse(response);
}

function statusClass(status) {
  if (status === "可直接报价") return "direct";
  if (status === "价格待核实") return "review";
  return "reference";
}

function timeLabel(item) {
  const production = item.productionDays ?? "-";
  const logistics = item.logisticsDays ?? "-";
  const total = item.totalDays == null ? "-" : `${item.totalDays}天`;
  return `${production}天 / ${logistics}天 <span class="muted">合计 ${total}</span>`;
}

function money(value) {
  return value == null ? "-" : `¥${Number(value).toFixed(2)}`;
}

function renderResults(results) {
  currentResults = results;
  if (!results.length) {
    body.innerHTML = '<tr><td class="empty" colspan="9">没有找到匹配的报价项</td></tr>';
    return;
  }
  body.innerHTML = results.map((item, index) => `
    <tr>
      <td><span class="status ${statusClass(item.priceStatus)}">${escapeHtml(item.priceStatus)}</span></td>
      <td><div class="price">${escapeHtml(item.price)}</div>${item.priceStatus === "可直接报价" ? "" : `<div class="muted">${escapeHtml(item.priceRaw || "-")}</div>`}</td>
      <td>${escapeHtml(item.supplier || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.process || "-")}</td>
      <td>${escapeHtml(item.material || "-")}</td>
      <td>${escapeHtml(item.customSize || "-")}</td>
      <td class="time">${timeLabel(item)}</td>
      <td><div class="row-actions"><button class="estimate-row-button" data-estimate-index="${index}" type="button">估价</button><button class="source-button" data-result-index="${index}" type="button">依据</button><button class="source-button" data-case-quote="${escapeHtml(item.caseQuoteKey)}" type="button">案例</button></div></td>
    </tr>
  `).join("");
}

function renderCapabilities(capabilities) {
  if (!capabilities.length) {
    capabilitySection.hidden = true;
    capabilityList.innerHTML = "";
    return;
  }
  capabilitySection.hidden = false;
  capabilityList.innerHTML = capabilities.map((item) => `
    <div class="capability-item">
      <strong>${escapeHtml(item.supplier_name)}</strong>
      <span>${escapeHtml(item.secondary_process)} · 生产 ${escapeHtml(item.production_days ?? "-")} 天 · 物流 ${escapeHtml(item.logistics_days ?? "-")} 天</span>
    </div>
  `).join("");
}

function detailRow(label, value, long = false) {
  return `<dt>${escapeHtml(label)}</dt><dd class="${long ? "long" : ""}">${escapeHtml(value || "-")}</dd>`;
}

function openDetail(item) {
  detailTitle.textContent = item.supplier || "报价项";
  detailContent.innerHTML = `
    <div class="detail-status"><span class="status ${statusClass(item.priceStatus)}">${escapeHtml(item.priceStatus)}</span></div>
    <dl class="detail-grid">
      ${detailRow("报价", item.price)}
      ${detailRow("价格原文", item.priceRaw, true)}
      ${detailRow("SKU", item.sku)}
      ${detailRow("工艺", item.process)}
      ${detailRow("材质", item.material)}
      ${detailRow("产品尺寸", item.productSize)}
      ${detailRow("定制尺寸", item.customSize)}
      ${detailRow("尺寸状态", item.dimensionState)}
      ${detailRow("生产时效", item.productionDays == null ? "-" : `${item.productionDays} 天`)}
      ${detailRow("物流时效", item.logisticsDays == null ? "-" : `${item.logisticsDays} 天`)}
      ${detailRow("文件要求", item.fileRequirement, true)}
      ${detailRow("注意事项", item.note, true)}
      ${detailRow("来源", item.source, true)}
    </dl>
  `;
  detailPanel.classList.add("is-open");
  detailPanel.setAttribute("aria-hidden", "false");
  detailBackdrop.hidden = false;
}

function closeDetail() {
  detailPanel.classList.remove("is-open");
  detailPanel.setAttribute("aria-hidden", "true");
  detailBackdrop.hidden = true;
}

async function loadSummary() {
  const response = await apiFetch("/api/summary");
  const summary = await response.json();
  document.querySelector("#quoteCount").textContent = summary.quotes;
  document.querySelector("#readyPriceCount").textContent = summary.readyPrices;
  document.querySelector("#estimateProcessCount").textContent = summary.estimateProcesses;
  document.querySelector("#capabilityCount").textContent = summary.capabilities;
  document.querySelector("#issueCount").textContent = summary.issues;
}

function confidenceClass(value) {
  if (value === "高") return "confidence-high";
  if (value === "中") return "confidence-medium";
  return "confidence-low";
}

function renderEstimateMessage(payload) {
  const optionButtons = (payload.options || []).map((value) => `
    <button class="option-button" type="button" data-option-field="${escapeHtml(payload.field)}" data-option-value="${escapeHtml(value)}">${escapeHtml(value)}</button>
  `).join("");
  const warnings = (payload.boundaryWarnings || []).map((value) => `<span class="boundary-tag">${escapeHtml(value)}</span>`).join("");
  estimateContent.innerHTML = `
    <div class="estimate-message ${payload.status === "blocked" ? "blocked" : ""}">
      <div><div>${escapeHtml(payload.message || "暂时无法生成预估报价。")}</div>${optionButtons ? `<div class="estimate-options">${optionButtons}</div>` : ""}</div>
    </div>
    ${warnings ? `<div class="estimate-warnings">${warnings}</div>` : ""}
  `;
}

function renderEstimate(payload) {
  estimateSection.hidden = false;
  if (!["direct", "estimated"].includes(payload.status)) {
    estimateStatus.className = "status reference";
    estimateStatus.textContent = payload.status === "blocked" ? "需人工核价" : "暂不估价";
    renderEstimateMessage(payload);
    return;
  }

  const direct = payload.status === "direct";
  estimateStatus.className = `status ${direct ? "direct" : "review"}`;
  estimateStatus.textContent = direct ? "精确源价" : "历史预估";
  const warnings = (payload.boundaryWarnings || []).map((value) => `<span class="boundary-tag">${escapeHtml(value)}</span>`).join("");
  const supplierRows = (payload.suppliers || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.supplier)}</td>
      <td><strong>${money(item.price)}</strong></td>
      <td>${money(item.low)} - ${money(item.high)}</td>
      <td>${escapeHtml(item.sampleCount)}</td>
      <td>${escapeHtml(item.productionDays == null ? "-" : `${item.productionDays}天`)}</td>
      <td>${escapeHtml(item.logisticsDays == null ? "-" : `${item.logisticsDays}天`)}</td>
    </tr>
  `).join("");

  estimateContent.innerHTML = `
    <div class="estimate-overview">
      <div>
        <div class="estimate-label">${direct ? "源价" : "建议参考价"}</div>
        <div class="estimate-price">${money(payload.price)}</div>
        <div class="estimate-range">建议区间 ${money(payload.rangeLow)} - ${money(payload.rangeHigh)}</div>
      </div>
      <div>
        <dl class="estimate-facts">
          <div><dt>置信度</dt><dd class="${confidenceClass(payload.confidence)}">${escapeHtml(payload.confidence)}</dd></div>
          <div><dt>有效样本</dt><dd>${escapeHtml(payload.sampleCount)} 条</dd></div>
          <div><dt>历史最低</dt><dd>${money(payload.historyMin)}</dd></div>
          <div><dt>历史最高</dt><dd>${money(payload.historyMax)}</dd></div>
        </dl>
      </div>
      <div>
        <div class="estimate-label">估价依据</div>
        <div class="estimate-basis">${escapeHtml(payload.basis)}</div>
        <div class="muted">${escapeHtml([
          payload.sku,
          payload.process,
          payload.material,
          payload.supplier,
          payload.targetSize ? `${payload.targetSize.widthMm} × ${payload.targetSize.heightMm}${payload.targetSize.depthMm ? ` × ${payload.targetSize.depthMm}` : ""} mm` : "",
        ].filter(Boolean).join(" · "))}</div>
      </div>
    </div>
    <div class="estimate-warnings">${warnings}</div>
    ${supplierRows ? `
      <div class="supplier-compare">
        <h3>同工艺供应商对比</h3>
        <div class="table-scroll">
          <table class="supplier-table">
            <thead><tr><th>供应商</th><th>参考价</th><th>样本区间</th><th>样本数</th><th>生产</th><th>物流</th></tr></thead>
            <tbody>${supplierRows}</tbody>
          </table>
        </div>
      </div>
    ` : ""}
  `;
}

function estimateQuery() {
  const params = new URLSearchParams();
  linkedFields.forEach((field) => {
    const value = String(form.elements[field].value || "").trim();
    if (value) params.set(field, value);
  });
  ["targetWidth", "targetHeight", "targetDepth"].forEach((field) => {
    const value = String(form.elements[field].value || "").trim();
    if (value) params.set(field, value);
  });
  return params.toString();
}

async function estimate() {
  estimateSection.hidden = false;
  estimateStatus.className = "status review";
  estimateStatus.textContent = "计算中";
  estimateContent.innerHTML = '<div class="estimate-message">正在筛选可用历史样本</div>';
  estimateButton.disabled = true;
  try {
    const response = await apiFetch(`/api/estimate?${estimateQuery()}`);
    if (!response.ok) throw new Error("预估报价失败");
    renderEstimate(await response.json());
    estimateSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    renderEstimate({ status: "no_data", message: error.message });
  } finally {
    estimateButton.disabled = false;
  }
}

function renderRuleReadiness(payload) {
  const rows = payload.processes || [];
  ruleReadinessBody.innerHTML = rows.length
    ? rows.map((item) => `
      <tr>
        <td>${escapeHtml(item.process)}</td>
        <td>${escapeHtml(item.quote_count)}</td>
        <td>${escapeHtml(item.direct_count)}</td>
        <td>${escapeHtml(item.pending_price_count)}</td>
        <td>${escapeHtml(item.size_candidate_count)}</td>
        <td>${escapeHtml(item.next_action)}</td>
      </tr>
    `).join("")
    : '<tr><td class="empty" colspan="6">暂无规则推进数据</td></tr>';

  const formulas = payload.formulaRules || [];
  formulaRuleNote.textContent = formulas.length
    ? `待确认公式：${formulas.map((item) => `${item.process || "未关联工艺"} ${item.rule_type} ${item.rule_count} 条（${item.rule_state}）`).join("；")}`
    : "暂无待确认公式。";
}

async function loadRuleReadiness() {
  try {
    const response = await apiFetch("/api/rule-readiness");
    if (!response.ok) throw new Error("规则清单加载失败");
    renderRuleReadiness(await response.json());
  } catch (error) {
    ruleReadinessBody.innerHTML = `<tr><td class="empty" colspan="6">${escapeHtml(error.message)}</td></tr>`;
    formulaRuleNote.textContent = "";
  }
}

function optionQuery() {
  const params = new URLSearchParams();
  linkedFields.forEach((field) => {
    const value = String(form.elements[field].value || "").trim();
    if (value) params.set(field, value);
  });
  return params.toString();
}

function fillDataList(field, values) {
  const list = document.querySelector(`#${field}Options`);
  list.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

async function refreshLinkedOptions() {
  const requestId = ++optionRequestId;
  try {
    const response = await apiFetch(`/api/options?${optionQuery()}`);
    if (!response.ok) return;
    const options = await response.json();
    if (requestId !== optionRequestId) return;
    linkedFields.forEach((field) => fillDataList(field, options[field] || []));
  } catch {
    // The current typed values remain available even when suggestions cannot load.
  }
}

function scheduleOptionRefresh() {
  clearTimeout(optionTimer);
  optionTimer = setTimeout(refreshLinkedOptions, 160);
}

async function search() {
  const params = new URLSearchParams();
  const fields = new FormData(form);
  for (const [key, value] of fields.entries()) {
    if (key === "priceOnly") continue;
    if (String(value).trim()) params.set(key, value);
  }
  if (form.elements.priceOnly.checked) params.set("priceOnly", "1");
  resultMeta.textContent = "正在查询";
  body.innerHTML = '<tr><td class="empty" colspan="9">正在查询</td></tr>';
  try {
    const response = await apiFetch(`/api/search?${params.toString()}`);
    if (!response.ok) throw new Error("查询失败");
    const payload = await response.json();
    renderResults(payload.results);
    renderCapabilities(payload.capabilities);
    resultMeta.textContent = `找到 ${payload.results.length} 条报价项`;
  } catch (error) {
    body.innerHTML = `<tr><td class="empty" colspan="9">${escapeHtml(error.message)}</td></tr>`;
    resultMeta.textContent = "查询失败";
    capabilitySection.hidden = true;
  }
}

function formatDate(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
}

function setUserMessage(message, type = "") {
  const target = document.querySelector("#userMessage");
  target.textContent = message;
  target.className = `admin-message ${type}`;
}

function renderUsers(users) {
  document.querySelector("#userCount").textContent = `${users.length} 个账号`;
  document.querySelector("#userTableBody").innerHTML = users.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.display_name)}</strong><div class="muted">${escapeHtml(item.username)}</div></td>
      <td>${item.role === "admin" ? "管理员" : "查询账号"}</td>
      <td><span class="status ${item.is_active ? "direct" : "reference"}">${item.is_active ? "启用" : "已停用"}</span></td>
      <td>${escapeHtml(formatDate(item.last_login_at))}</td>
      <td><div class="admin-actions">
        <button class="small-button" type="button" data-reset-user="${item.user_id}">重置密码</button>
        <button class="small-button ${item.is_active ? "danger" : ""}" type="button" data-status-user="${item.user_id}" data-active="${item.is_active ? "0" : "1"}">${item.is_active ? "停用" : "启用"}</button>
      </div></td>
    </tr>
  `).join("");
}

function renderAudit(logs) {
  document.querySelector("#auditTableBody").innerHTML = logs.length ? logs.map((item) => `
    <tr>
      <td>${escapeHtml(formatDate(item.created_at))}</td>
      <td>${escapeHtml(item.username || "-")}</td>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.detail || "-")}</td>
      <td>${escapeHtml(item.ip_address || "-")}</td>
    </tr>
  `).join("") : '<tr><td class="empty" colspan="5">暂无操作记录</td></tr>';
}

function dimensionRange(minimum, maximum) {
  if (minimum == null && maximum == null) return "-";
  if (minimum == null) return `≤ ${maximum}`;
  if (maximum == null) return `≥ ${minimum}`;
  if (Number(minimum) === Number(maximum)) return String(maximum);
  return `${minimum} – ${maximum}`;
}

function setDimensionMessage(message, type = "") {
  const target = document.querySelector("#dimensionMessage");
  target.textContent = message;
  target.className = `admin-message ${type}`;
}

function fillDimensionSelects() {
  const typeOptions = Object.entries(dimensionTypeLabels).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
  const comparisonOptions = Object.entries(dimensionComparisonLabels).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
  document.querySelector("#dimensionTypeFilter").innerHTML = `<option value="">全部类型</option>${typeOptions}`;
  dimensionForm.elements.sizeType.innerHTML = typeOptions;
  dimensionForm.elements.comparison.innerHTML = comparisonOptions;
}

function renderDimensionSummary(summary) {
  document.querySelector("#dimensionSummary").textContent = `共 ${summary.total} 条 · 已确认 ${summary.confirmed} · 待确认 ${summary.pending} · 需复核 ${summary.needsReview} · 高置信待确认 ${summary.highConfidencePending}`;
  document.querySelector("#confirmHighDimensions").textContent = `确认高置信建议（${summary.highConfidencePending}）`;
}

function renderDimensions(rows) {
  currentDimensionRows = rows;
  document.querySelector("#dimensionTableBody").innerHTML = rows.length ? rows.map((item, index) => `
    <tr>
      <td class="dimension-context"><strong>${escapeHtml(item.sku || item.quote_id)}</strong><div class="muted">${escapeHtml(item.process_raw || "-")} · ${escapeHtml(item.supplier_name || "-")}</div></td>
      <td class="dimension-source">${escapeHtml(item.raw_text || "-")}</td>
      <td><strong>${escapeHtml(dimensionTypeLabels[item.size_type] || item.size_type)}</strong><div class="muted">${escapeHtml(dimensionComparisonLabels[item.comparison] || item.comparison)}</div></td>
      <td class="dimension-range">${escapeHtml(dimensionRange(item.width_min_mm, item.width_max_mm))}</td>
      <td class="dimension-range">${escapeHtml(dimensionRange(item.height_min_mm, item.height_max_mm))}</td>
      <td class="dimension-range">${escapeHtml(dimensionRange(item.depth_min_mm, item.depth_max_mm))}</td>
      <td><span class="${confidenceClass(item.parse_confidence)}">${escapeHtml(item.parse_confidence)}</span><div><span class="status ${item.review_status === "已确认" ? "direct" : item.review_status === "需复核" ? "reference" : "review"}">${escapeHtml(item.review_status)}</span></div></td>
      <td><button class="small-button" type="button" data-dimension-index="${index}">编辑</button></td>
    </tr>
  `).join("") : '<tr><td class="empty" colspan="8">当前筛选没有尺寸记录</td></tr>';
}

function dimensionQuery() {
  const params = new URLSearchParams();
  const status = document.querySelector("#dimensionStatusFilter").value;
  const type = document.querySelector("#dimensionTypeFilter").value;
  const search = document.querySelector("#dimensionSearch").value.trim();
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  if (search) params.set("search", search);
  return params.toString();
}

async function loadDimensions() {
  const [summaryResponse, rowsResponse] = await Promise.all([
    apiFetch("/api/admin/dimensions/summary"),
    apiFetch(`/api/admin/dimensions?${dimensionQuery()}`),
  ]);
  if (!summaryResponse.ok || !rowsResponse.ok) throw new Error("尺寸规则加载失败");
  const summary = await summaryResponse.json();
  const rowsPayload = await rowsResponse.json();
  dimensionTypeLabels = rowsPayload.sizeTypes || summary.sizeTypes || {};
  dimensionComparisonLabels = rowsPayload.comparisons || summary.comparisons || {};
  const selectedType = document.querySelector("#dimensionTypeFilter").value;
  fillDimensionSelects();
  document.querySelector("#dimensionTypeFilter").value = selectedType;
  renderDimensionSummary(summary);
  renderDimensions(rowsPayload.rows || []);
}

function openDimensionEditor(item) {
  document.querySelector("#dimensionPanelTitle").textContent = item.sku || item.quote_id;
  document.querySelector("#dimensionRaw").textContent = item.raw_text || "未提供尺寸原文";
  dimensionForm.elements.quoteId.value = item.quote_id;
  dimensionForm.elements.sizeType.value = item.size_type;
  dimensionForm.elements.comparison.value = item.comparison;
  dimensionForm.elements.reviewStatus.value = item.review_status;
  dimensionForm.elements.paperFormat.value = item.paper_format || "";
  dimensionForm.elements.parseNote.value = item.parse_note || "";
  ["width_min_mm", "width_max_mm", "height_min_mm", "height_max_mm", "depth_min_mm", "depth_max_mm", "diameter_min_mm", "diameter_max_mm"].forEach((field) => {
    dimensionForm.elements[field].value = item[field] == null ? "" : item[field];
  });
  document.querySelector("#dimensionFormMessage").textContent = `系统置信度：${item.parse_confidence} · 来源：${item.source_mode === "manual" ? "人工维护" : "自动拆分建议"}`;
  dimensionPanel.classList.add("is-open");
  dimensionPanel.setAttribute("aria-hidden", "false");
  dimensionBackdrop.hidden = false;
}

function closeDimensionEditor() {
  dimensionPanel.classList.remove("is-open");
  dimensionPanel.setAttribute("aria-hidden", "true");
  dimensionBackdrop.hidden = true;
}

async function loadAdmin() {
  const [userResponse, auditResponse] = await Promise.all([
    apiFetch("/api/admin/users"),
    apiFetch("/api/admin/audit"),
    loadDimensions(),
  ]);
  if (!userResponse.ok || !auditResponse.ok) throw new Error("管理数据加载失败");
  renderUsers((await userResponse.json()).users || []);
  renderAudit((await auditResponse.json()).logs || []);
}

function downloadAdmin(format) {
  const link = document.createElement("a");
  link.href = `/api/admin/export?format=${format}`;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function renderImportPreview(payload) {
  const target = document.querySelector("#importPreview");
  target.hidden = false;
  const counts = Object.entries(payload.counts || {}).map(([name, count]) => `<span class="boundary-tag">${escapeHtml(name)} ${escapeHtml(count)}</span>`).join("");
  const errors = (payload.errors || []).map((error) => `<li>${escapeHtml(error)}</li>`).join("");
  pendingImportToken = payload.importToken || "";
  target.innerHTML = `
    <div class="import-counts">${counts}</div>
    ${errors ? `<ul class="import-errors">${errors}</ul>` : '<div class="admin-message success">预检通过，确认后将全量替换当前数据并自动备份。</div>'}
    ${pendingImportToken ? '<button class="primary-button import-confirm" type="button" data-commit-import>确认导入</button>' : ""}
  `;
}

async function initialize() {
  const response = await fetch("/api/me", { headers: { "Cache-Control": "no-store" } });
  if (!response.ok) {
    window.location.replace("/login.html");
    return;
  }
  const payload = await response.json();
  sessionUser = payload.user;
  csrfToken = payload.csrfToken;
  window.dispatchEvent(new CustomEvent("cases:session", { detail: { role: sessionUser.role } }));
  document.querySelector("#sessionName").textContent = sessionUser.displayName;
  document.querySelector("#sessionRole").textContent = sessionUser.role === "admin" ? "管理员" : "查询账号";
  if (sessionUser.role === "admin") {
    rebuildButton.hidden = false;
    document.querySelectorAll("[data-admin-tab]").forEach((button) => { button.hidden = false; });
    loadAdmin().catch((error) => setUserMessage(error.message, "error"));
  }
  activateTab(window.location.hash.slice(1) || "query", false);
  await Promise.all([loadSummary(), loadRuleReadiness()]);
  refreshLinkedOptions();
  search();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});

document.querySelector("#resetButton").addEventListener("click", () => {
  form.reset();
  estimateSection.hidden = true;
  refreshLinkedOptions();
  search();
});

estimateButton.addEventListener("click", estimate);

linkedFields.forEach((field) => {
  form.elements[field].addEventListener("input", scheduleOptionRefresh);
  form.elements[field].addEventListener("change", refreshLinkedOptions);
});

body.addEventListener("click", (event) => {
  const estimateRowButton = event.target.closest("[data-estimate-index]");
  if (estimateRowButton) {
    const item = currentResults[Number(estimateRowButton.dataset.estimateIndex)];
    if (item) {
      form.elements.sku.value = item.sku || "";
      form.elements.process.value = item.process || "";
      form.elements.material.value = item.material || "";
      form.elements.supplier.value = item.supplier || "";
      refreshLinkedOptions();
      estimate();
    }
    return;
  }
  const button = event.target.closest("[data-result-index]");
  if (!button) return;
  const item = currentResults[Number(button.dataset.resultIndex)];
  if (item) openDetail(item);
});

estimateContent.addEventListener("click", (event) => {
  const option = event.target.closest("[data-option-field]");
  if (!option || !form.elements[option.dataset.optionField]) return;
  form.elements[option.dataset.optionField].value = option.dataset.optionValue;
  refreshLinkedOptions();
  estimate();
});

document.querySelector("#closeDetail").addEventListener("click", closeDetail);
detailBackdrop.addEventListener("click", closeDetail);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDetail();
    closeDimensionEditor();
  }
});

document.querySelector("#closeDimension").addEventListener("click", closeDimensionEditor);
dimensionBackdrop.addEventListener("click", closeDimensionEditor);

document.querySelector("#refreshDimensions").addEventListener("click", () => {
  loadDimensions().catch((error) => setDimensionMessage(error.message, "error"));
});

document.querySelector("#dimensionSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadDimensions().catch((error) => setDimensionMessage(error.message, "error"));
  }
});

document.querySelector("#dimensionTableBody").addEventListener("click", (event) => {
  const button = event.target.closest("[data-dimension-index]");
  if (!button) return;
  const item = currentDimensionRows[Number(button.dataset.dimensionIndex)];
  if (item) openDimensionEditor(item);
});

dimensionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = dimensionForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(dimensionForm).entries());
    await postJson("/api/admin/dimensions/update", payload);
    closeDimensionEditor();
    setDimensionMessage("尺寸规则已保存，已确认规则可以参与目标尺寸报价。", "success");
    await loadDimensions();
  } catch (error) {
    const target = document.querySelector("#dimensionFormMessage");
    target.textContent = error.message;
    target.className = "admin-message error";
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#confirmHighDimensions").addEventListener("click", async (event) => {
  if (!window.confirm("确认所有高置信、单一尺寸的系统拆分建议？多规格、自由文本和无尺寸记录不会被确认。")) return;
  event.currentTarget.disabled = true;
  try {
    const payload = await postJson("/api/admin/dimensions/confirm-high", {});
    setDimensionMessage(`已确认 ${payload.count} 条高置信尺寸规则。`, "success");
    await loadDimensions();
  } catch (error) {
    setDimensionMessage(error.message, "error");
  } finally {
    event.currentTarget.disabled = false;
  }
});

rebuildButton.addEventListener("click", async () => {
  rebuildButton.disabled = true;
  rebuildButton.textContent = "重建中";
  try {
    const response = await apiFetch("/api/rebuild", { method: "POST" });
    if (!response.ok) throw new Error("重建失败");
    await loadSummary();
    await loadRuleReadiness();
    await search();
    await loadAdmin();
  } catch (error) {
    resultMeta.textContent = error.message;
  } finally {
    rebuildButton.disabled = false;
    rebuildButton.textContent = "重建索引";
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try {
    await postJson("/api/logout", {});
  } finally {
    window.location.replace("/login.html");
  }
});

document.querySelector("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const userForm = event.currentTarget;
  const submitButton = userForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    await postJson("/api/admin/users/create", {
      username: userForm.elements.username.value,
      displayName: userForm.elements.displayName.value,
      role: userForm.elements.role.value,
      password: userForm.elements.password.value,
    });
    userForm.reset();
    setUserMessage("账号已创建", "success");
    await loadAdmin();
  } catch (error) {
    setUserMessage(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#userTableBody").addEventListener("click", async (event) => {
  const statusButton = event.target.closest("[data-status-user]");
  const resetButton = event.target.closest("[data-reset-user]");
  try {
    if (statusButton) {
      await postJson("/api/admin/users/status", {
        userId: Number(statusButton.dataset.statusUser),
        active: statusButton.dataset.active === "1",
      });
      setUserMessage("账号状态已更新", "success");
    } else if (resetButton) {
      const password = window.prompt("输入新密码（至少 10 位，包含字母和数字）");
      if (!password) return;
      await postJson("/api/admin/users/password", {
        userId: Number(resetButton.dataset.resetUser),
        password,
      });
      setUserMessage("密码已重置，该账号已有会话将失效", "success");
    } else {
      return;
    }
    await loadAdmin();
  } catch (error) {
    setUserMessage(error.message, "error");
  }
});

document.querySelector("#exportXlsx").addEventListener("click", () => downloadAdmin("xlsx"));
document.querySelector("#exportJson").addEventListener("click", () => downloadAdmin("json"));

document.querySelector("#previewImport").addEventListener("click", async (event) => {
  const fileInput = document.querySelector("#importFile");
  const file = fileInput.files[0];
  const target = document.querySelector("#importPreview");
  if (!file) {
    target.hidden = false;
    target.innerHTML = '<div class="admin-message error">请先选择 .xlsx 或 .json 文件</div>';
    return;
  }
  const extension = file.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : file.name.toLowerCase().endsWith(".json") ? "json" : "";
  if (!extension) {
    target.hidden = false;
    target.innerHTML = '<div class="admin-message error">仅支持 .xlsx 和 .json 文件</div>';
    return;
  }
  event.currentTarget.disabled = true;
  target.hidden = false;
  target.innerHTML = '<div class="admin-message">正在预检数据</div>';
  try {
    const response = await apiFetch(`/api/admin/import/preview?format=${extension}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "导入预检失败");
    renderImportPreview(payload);
  } catch (error) {
    target.innerHTML = `<div class="admin-message error">${escapeHtml(error.message)}</div>`;
  } finally {
    event.currentTarget.disabled = false;
  }
});

document.querySelector("#importPreview").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-commit-import]");
  if (!button || !pendingImportToken) return;
  button.disabled = true;
  button.textContent = "导入中";
  try {
    const payload = await postJson("/api/admin/import/commit", { importToken: pendingImportToken });
    pendingImportToken = "";
    document.querySelector("#importPreview").innerHTML = `<div class="admin-message success">导入完成，备份：${escapeHtml(payload.backup)}</div>`;
    await Promise.all([loadSummary(), loadRuleReadiness(), loadAdmin(), search(), refreshLinkedOptions()]);
  } catch (error) {
    document.querySelector("#importPreview").innerHTML = `<div class="admin-message error">${escapeHtml(error.message)}</div>`;
  }
});

initialize().catch((error) => {
  resultMeta.textContent = error.message;
});
