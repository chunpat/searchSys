import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const [inputPath, outputPath, previewDir] = process.argv.slice(2);
const fullAudit = process.argv.includes("--full");
if (!inputPath || !outputPath || !previewDir) {
  throw new Error("Usage: node build_quote_suggestions.mjs <source.json> <output.xlsx> <preview-dir>");
}

const source = JSON.parse(await fs.readFile(inputPath, "utf8"));
const quotes = source.quote_items;
const colors = {
  navy: "#17324D", teal: "#0F766E", blue: "#2563EB", sky: "#EAF3FF",
  green: "#DCFCE7", greenText: "#166534", yellow: "#FEF3C7", yellowText: "#92400E",
  orange: "#FFEDD5", orangeText: "#9A3412", red: "#FEE2E2", redText: "#991B1B",
  gray: "#F4F7FA", line: "#D7DEE7", text: "#1F2937", white: "#FFFFFF",
};

function colLetter(index) {
  let value = index;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

function roundPrice(value) {
  if (!numeric(value)) return null;
  if (value < 10) return Math.round(value * 2) / 2;
  if (value < 50) return Math.round(value);
  return Math.round(value / 5) * 5;
}

function textNumbers(raw) {
  return [...String(raw ?? "").matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function parseTextPrice(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const addition = value.match(/^\s*(\d+(?:\.\d+)?)\s*元?\s*\+\s*(\d+(?:\.\d+)?)/);
  if (addition) {
    const base = Number(addition[1]);
    const surcharge = Number(addition[2]);
    return {
      price: Number((base + surcharge).toFixed(2)), low: base, high: Number((base + surcharge).toFixed(2)),
      basis: `按原文算术：基础价 ${base} + 附加费 ${surcharge}`,
      confidence: "中", kind: "AI定义-原文算术", color: "yellow",
    };
  }

  const priceRange = value.match(/(?:约\s*)?(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*元?/);
  if (priceRange && !value.includes("\n")) {
    const low = Number(priceRange[1]);
    const high = Number(priceRange[2]);
    return {
      price: roundPrice((low + high) / 2), low, high,
      basis: `取原文价格区间 ${low}-${high} 的中点`,
      confidence: "中", kind: "AI定义-区间中点", color: "yellow",
    };
  }

  const numbers = textNumbers(value);
  const unique = [...new Set(numbers)];
  if (unique.length === 1 && !/\d+\.\d+\.\d+/.test(value)) {
    return {
      price: roundPrice(unique[0]), low: unique[0], high: unique[0],
      basis: "沿用原文唯一价格数字，计价单位仍需人工确认",
      confidence: "中", kind: "AI定义-文本数字", color: "yellow",
    };
  }
  return null;
}

const supplierProcessValues = new Map();
const processValues = new Map();
const supplierProcessCounts = new Map();
for (const quote of quotes) {
  const supplierProcess = `${quote["供应商原名"]}|${quote["工艺原名"]}`;
  supplierProcessCounts.set(supplierProcess, (supplierProcessCounts.get(supplierProcess) ?? 0) + 1);
  if (quote["价格解析状态"] !== "已结构化" || !numeric(quote["价格下限"])) continue;
  if (!supplierProcessValues.has(supplierProcess)) supplierProcessValues.set(supplierProcess, []);
  supplierProcessValues.get(supplierProcess).push(quote["价格下限"]);
  const process = quote["工艺原名"];
  if (!processValues.has(process)) processValues.set(process, []);
  processValues.get(process).push(quote["价格下限"]);
}

function medianSuggestion(values, kind, basis, color) {
  const mid = median(values);
  return {
    price: roundPrice(mid), low: quantile(values, 0.25), high: quantile(values, 0.75),
    basis, confidence: color === "yellow" && values.length >= 5 ? "中" : "低",
    kind, color,
  };
}

function suggestQuote(quote) {
  if (quote["价格解析状态"] === "已结构化" && numeric(quote["价格下限"])) {
    return {
      sourcePrice: quote["价格下限"], suggestion: null, kind: "源数据固定价",
      color: "green", confidence: "来源明确",
      basis: "沿用原始固定价格；仅限当前 SKU、供应商、工艺和已记录尺寸",
    };
  }

  const parsed = parseTextPrice(quote["价格原文"]);
  if (parsed) return { sourcePrice: null, suggestion: parsed, ...parsed };

  const supplierProcess = `${quote["供应商原名"]}|${quote["工艺原名"]}`;
  const sameSupplierProcess = supplierProcessValues.get(supplierProcess) ?? [];
  if (sameSupplierProcess.length >= 3) {
    const suggestion = medianSuggestion(
      sameSupplierProcess,
      "AI定义-同供应商工艺中位数",
      `同供应商 + 同工艺 ${sameSupplierProcess.length} 条历史固定价的中位数；不跨产品族直接启用`,
      "yellow",
    );
    return { sourcePrice: null, suggestion, ...suggestion };
  }

  const sameProcess = processValues.get(quote["工艺原名"]) ?? [];
  if (sameProcess.length >= 5) {
    const suggestion = medianSuggestion(
      sameProcess,
      "AI定义-同工艺中位数",
      `同工艺跨供应商 ${sameProcess.length} 条历史固定价的中位数；仅作低置信参考`,
      "orange",
    );
    return { sourcePrice: null, suggestion, ...suggestion };
  }

  return {
    sourcePrice: null, suggestion: null, kind: "暂不定价", color: "red",
    confidence: "不可定价", basis: "没有足够的同供应商/同工艺固定价样本，保留人工确认",
  };
}

const quoteSuggestions = quotes.map((quote) => ({ quote, result: suggestQuote(quote) }));

function countBy(items, keyFor) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const skuMappingCounts = countBy(source.sku_mappings, (item) => item["SKU"]);
const capabilityCounts = countBy(source.capabilities, (item) => `${item["供应商原名"]}|${item["二级工艺原名"]}`);
const fileRuleCounts = countBy(source.vendor_file_rules, (item) => `${item["供应商原名"]}|${item["工艺原名"]}`);
const issueCounts = countBy(source.issues, (item) => item["来源"]);
const ruleCounts = new Map();
for (const rule of source.price_rules) {
  const supplier = rule["供应商原名"];
  const process = rule["关联工艺原名"];
  const key = `${supplier}|${process || "*"}`;
  ruleCounts.set(key, (ruleCounts.get(key) ?? 0) + 1);
}

function relationAudit(quote) {
  const supplierProcess = `${quote["供应商原名"]}|${quote["工艺原名"]}`;
  const skuMappings = skuMappingCounts.get(quote["SKU"]) ?? 0;
  const capabilities = capabilityCounts.get(supplierProcess) ?? 0;
  const rules = (ruleCounts.get(supplierProcess) ?? 0) + (ruleCounts.get(`${quote["供应商原名"]}|*`) ?? 0);
  const fileRules = fileRuleCounts.get(supplierProcess) ?? 0;
  const issues = issueCounts.get(quote["来源"]) ?? 0;
  const gaps = [];
  if (!quote["SKU"]) gaps.push("缺SKU");
  else if (!skuMappings) gaps.push("无SKU映射");
  if (!capabilities) gaps.push("无能力精确匹配");
  if (!rules) gaps.push("无规则原文");
  if (issues) gaps.push(`有${issues}个数据问题`);
  return {
    skuMappings, capabilities, rules, fileRules, issues,
    status: gaps.length ? gaps.join("；") : "完整关联",
  };
}

function ruleSuggestions() {
  const rows = [];
  for (const [key, count] of supplierProcessCounts.entries()) {
    const values = supplierProcessValues.get(key) ?? [];
    if (count < 4 || values.length < 3) continue;
    const [supplier, process] = key.split("|");
    const mid = median(values);
    const low = quantile(values, 0.25);
    const high = quantile(values, 0.75);
    const spread = mid ? (high - low) / mid : 99;
    rows.push({
      supplier, process, count, sampleCount: values.length,
      min: Math.min(...values), median: mid, max: Math.max(...values),
      low, high, suggestion: roundPrice(mid),
      confidence: values.length >= 8 && spread <= 0.7 ? "中" : "低",
      color: values.length >= 5 ? "yellow" : "orange",
    });
  }
  return rows.sort((left, right) => right.count - left.count || right.sampleCount - left.sampleCount);
}

const groupRules = ruleSuggestions();

function title(sheet, name, subtitle, columns) {
  sheet.showGridLines = false;
  const last = colLetter(columns);
  sheet.getRange(`A1:${last}1`).merge();
  sheet.getRange(`A1:${last}1`).values = [[name]];
  sheet.getRange(`A1:${last}1`).format = {
    fill: colors.navy, font: { bold: true, color: colors.white, size: 16 },
    verticalAlignment: "center",
  };
  sheet.getRange(`A1:${last}1`).format.rowHeight = 32;
  sheet.getRange(`A2:${last}2`).merge();
  sheet.getRange(`A2:${last}2`).values = [[subtitle]];
  sheet.getRange(`A2:${last}2`).format = {
    fill: colors.gray, font: { color: "#475569", italic: true, size: 10 },
    verticalAlignment: "center", wrapText: true,
  };
  sheet.getRange(`A2:${last}2`).format.rowHeight = 28;
}

function tableShell(sheet, headers, rows, tableName, widths = {}) {
  const last = colLetter(headers.length);
  const endRow = rows.length + 4;
  sheet.getRange(`A4:${last}${endRow}`).values = [headers, ...rows];
  sheet.getRange(`A4:${last}4`).format = {
    fill: colors.teal, font: { bold: true, color: colors.white, size: 10 },
    horizontalAlignment: "center", verticalAlignment: "center", wrapText: true,
    borders: { preset: "outside", style: "thin", color: colors.line },
  };
  sheet.getRange(`A4:${last}4`).format.rowHeight = 34;
  sheet.getRange(`A5:${last}${endRow}`).format = {
    font: { color: colors.text, size: 10 }, verticalAlignment: "top", wrapText: true,
  };
  const table = sheet.tables.add(`A4:${last}${endRow}`, true, tableName);
  table.style = "TableStyleMedium2";
  table.showFilterButton = true;
  headers.forEach((header, index) => {
    const defaults = { "供应商": 17, "SKU": 17, "工艺": 28, "材质": 23, "来源": 38, "备注": 34, "建议依据": 42, "适用边界": 48 };
    sheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidth = widths[header] ?? defaults[header] ?? Math.max(11, Math.min(23, header.length * 2.1));
  });
  sheet.freezePanes.freezeRows(4);
  return endRow;
}

function colorPriceCell(sheet, cell, colorKey) {
  const palette = {
    green: { fill: colors.green, font: { color: colors.greenText, bold: true } },
    yellow: { fill: colors.yellow, font: { color: colors.yellowText, bold: true } },
    orange: { fill: colors.orange, font: { color: colors.orangeText, bold: true } },
    red: { fill: colors.red, font: { color: colors.redText, bold: true } },
  };
  sheet.getRange(cell).format = palette[colorKey];
}

function addReadme(workbook) {
  const sheet = workbook.worksheets.add("说明");
  title(sheet, "报价建议模板（AI 定义价已着色）", "基于现有 345 条报价项生成。AI 建议价仅用于内部初审，默认不导入自动报价。", 10);
  sheet.getRange("A4:B8").values = [
    ["绿色", "源数据固定价：来自原表明确数字，不属于 AI 定义。"],
    ["黄色", "AI 定义价：根据原文算术，或同供应商 + 同工艺历史固定价中位数。"],
    ["橙色", "AI 低置信价：同供应商样本不足，退到同工艺跨供应商中位数。"],
    ["红色", "暂不定价：样本不足，或属于复杂组合/动态公式。"],
    ["启用规则", "只有审批状态为“已接受AI建议 / 人工改价 / 沿用源价格”时，最终采用价才会出现。"],
  ];
  ["green", "yellow", "orange", "red"].forEach((color, index) => colorPriceCell(sheet, `A${index + 4}:B${index + 4}`, color));
  sheet.getRange("A8:B8").format = { fill: colors.sky, font: { color: colors.navy, bold: true }, wrapText: true };
  sheet.getRange("A4:B8").format.borders = { preset: "outside", style: "thin", color: colors.line };
  sheet.getRange("A4:A8").format.columnWidth = 16;
  sheet.getRange("B4:B8").format.columnWidth = 70;
  sheet.getRange("A4:B8").format.rowHeight = 30;

  sheet.getRange("D4:E9").values = [
    ["建议报价概览", "数量"],
    ["源数据固定价", quoteSuggestions.filter((item) => item.result.color === "green").length],
    ["AI 黄色建议", quoteSuggestions.filter((item) => item.result.color === "yellow").length],
    ["AI 橙色建议", quoteSuggestions.filter((item) => item.result.color === "orange").length],
    ["暂不定价", quoteSuggestions.filter((item) => item.result.color === "red").length],
    ["AI 规则建议", groupRules.length],
  ];
  sheet.getRange("D4:E4").format = { fill: colors.teal, font: { color: colors.white, bold: true }, horizontalAlignment: "center" };
  sheet.getRange("D5:D9").format = { fill: colors.sky, font: { color: colors.navy, bold: true } };
  sheet.getRange("E5:E9").format = { fill: colors.gray, font: { color: colors.text, bold: true }, horizontalAlignment: "right", numberFormat: "#,##0" };
  sheet.getRange("D4:E9").format.borders = { preset: "outside", style: "thin", color: colors.line };
  sheet.getRange("D:D").format.columnWidth = 24;
  sheet.getRange("E:E").format.columnWidth = 14;

  sheet.getRange("A11:B16").values = [
    ["定价顺序", "规则"],
    ["1", "原表明确固定数字：放入绿色源固定价。"],
    ["2", "原文“基础价+附加费”、单一价格或单一区间：黄色 AI 建议。"],
    ["3", "无法解析时：取同供应商 + 同工艺固定价中位数，至少 3 个样本。"],
    ["4", "仍无样本时：取同工艺跨供应商中位数，至少 5 个样本，标橙色。"],
    ["5", "不做尺寸外推，不把多行组合价、A3 排版或 3D 公式压成一个价格。"],
  ];
  sheet.getRange("A11:B11").format = { fill: colors.blue, font: { color: colors.white, bold: true }, horizontalAlignment: "center" };
  sheet.getRange("A12:A16").format = { fill: colors.sky, font: { color: colors.navy, bold: true }, horizontalAlignment: "center" };
  sheet.getRange("B12:B16").format = { fill: colors.gray, wrapText: true };
  sheet.getRange("A11:B16").format.borders = { preset: "outside", style: "thin", color: colors.line };
  sheet.getRange("A11:B16").format.rowHeight = 28;
}

function addRuleSuggestions(workbook) {
  const sheet = workbook.worksheets.add("AI规则建议");
  const headers = ["颜色标记", "供应商", "工艺", "报价项数", "固定价样本数", "历史最低", "历史中位数", "历史最高", "AI建议基础价", "建议区间下", "建议区间上", "置信度", "建议规则", "适用边界", "审批状态", "人工调整价", "来源说明"];
  const rows = groupRules.map((item) => [
    item.color === "yellow" ? "黄色-AI定义" : "橙色-AI低置信", item.supplier, item.process,
    item.count, item.sampleCount, item.min, item.median, item.max, item.suggestion, item.low, item.high,
    item.confidence, "以同供应商 + 同工艺历史固定价中位数作为基础参考价",
    "仅限当前供应商与工艺；SKU、材质、尺寸、单双面、颜色或后处理不同则待确认",
    "待确认", "", `来自 ${item.sampleCount} 条历史固定价格样本`,
  ]);
  title(sheet, "AI 规则建议", "这是我基于现有数据定义的基础价规则，全部为待确认。样本来自不同 SKU 时，不得直接作为尺寸公式使用。", headers.length);
  const endRow = tableShell(sheet, headers, rows, "AiRuleSuggestionTable", { "建议规则": 40, "来源说明": 28 });
  sheet.getRange(`D5:K${endRow}`).format.numberFormat = "#,##0.00";
  sheet.getRange(`O5:O${endRow}`).dataValidation = { rule: { type: "list", values: ["待确认", "已接受", "已调整", "已驳回"] } };
  rows.forEach((row, index) => {
    const excelRow = index + 5;
    colorPriceCell(sheet, `A${excelRow}`, groupRules[index].color);
    colorPriceCell(sheet, `I${excelRow}:K${excelRow}`, groupRules[index].color);
    sheet.getRange(`P${excelRow}`).format = { fill: colors.sky, font: { color: colors.navy } };
  });
}

function addQuoteDetails(workbook) {
  const sheet = workbook.worksheets.add("报价建议明细");
  const headers = ["报价ID", "价格属性", "颜色说明", "供应商", "SKU", "工艺", "材质", "产品尺寸", "定制尺寸", "原价格原文", "原价格状态", "源固定价", "AI建议价", "建议区间下", "建议区间上", "建议依据", "置信度", "审批状态", "人工确认价", "最终采用价", "启用状态", "来源", "备注"];
  const rows = quoteSuggestions.map(({ quote, result }) => [
    quote["报价项ID"], result.kind,
    result.color === "green" ? "绿色-源价格" : result.color === "yellow" ? "黄色-AI定义" : result.color === "orange" ? "橙色-AI低置信" : "红色-暂不定价",
    quote["供应商原名"], quote["SKU"], quote["工艺原名"], quote["材质"], quote["产品尺寸原文"], quote["定制尺寸原文"],
    quote["价格原文"], quote["价格解析状态"], result.sourcePrice,
    result.suggestion?.price ?? null, result.suggestion?.low ?? null, result.suggestion?.high ?? null,
    result.basis, result.confidence, result.color === "green" ? "沿用源价格" : "待确认", "", null, null,
    quote["来源"], quote["注意事项"],
  ]);
  title(sheet, "报价建议明细", "绿色为原表固定价；黄色和橙色为我定义的建议价。AI 建议未经审批时，“最终采用价”保持为空。", headers.length);
  const endRow = tableShell(sheet, headers, rows, "QuoteSuggestionDetailTable", { "颜色说明": 19, "价格属性": 28, "产品尺寸": 25, "定制尺寸": 27, "原价格原文": 34, "审批状态": 19, "启用状态": 24 });
  sheet.getRange(`L5:O${endRow}`).format.numberFormat = "#,##0.00";
  sheet.getRange(`S5:T${endRow}`).format.numberFormat = "#,##0.00";
  sheet.getRange(`R5:R${endRow}`).dataValidation = { rule: { type: "list", values: ["待确认", "已接受AI建议", "人工改价", "沿用源价格", "已驳回"] } };
  sheet.getRange(`S5:S${endRow}`).format = { fill: colors.sky, font: { color: colors.navy } };
  sheet.getRange(`T5:T${endRow}`).formulas = rows.map((_, index) => {
    const row = index + 5;
    return [`=IF(R${row}=\"已接受AI建议\",M${row},IF(R${row}=\"人工改价\",S${row},IF(R${row}=\"沿用源价格\",L${row},\"\")))`];
  });
  sheet.getRange(`U5:U${endRow}`).formulas = rows.map((_, index) => {
    const row = index + 5;
    return [`=IF(T${row}>0,\"可导入（待系统接入）\",\"不可导入\")`];
  });
  sheet.getRange(`T5:U${endRow}`).format = { fill: colors.gray, font: { color: colors.text, bold: true } };

  quoteSuggestions.forEach(({ result }, index) => {
    const row = index + 5;
    colorPriceCell(sheet, `B${row}:C${row}`, result.color);
    if (result.color === "green") colorPriceCell(sheet, `L${row}`, "green");
    else if (result.color === "red") colorPriceCell(sheet, `M${row}:O${row}`, "red");
    else colorPriceCell(sheet, `M${row}:O${row}`, result.color);
  });
}

function addFinalReadme(workbook) {
  const sheet = workbook.worksheets.add("终审总览");
  title(sheet, "完整报价终审版", "报价建议、SKU 映射、供应商能力、规则原文、主数据和问题清单已合并。未经审批的 AI 价格仍不可导入。", 10);
  sheet.getRange("A4:B8").values = [
    ["绿色", "源数据固定价：来自原始报价表明确数字。"],
    ["黄色", "AI 定义价：原文算术或同供应商 + 同工艺历史中位数。"],
    ["橙色", "AI 低置信价：同工艺跨供应商历史中位数。"],
    ["红色", "暂不定价或复杂动态规则。"],
    ["终审原则", "价格审批与关联完整性分开检查；有关联缺口不代表删除报价。"],
  ];
  ["green", "yellow", "orange", "red"].forEach((color, index) => colorPriceCell(sheet, `A${index + 4}:B${index + 4}`, color));
  sheet.getRange("A8:B8").format = { fill: colors.sky, font: { color: colors.navy, bold: true }, wrapText: true };
  sheet.getRange("A4:B8").format.borders = { preset: "outside", style: "thin", color: colors.line };
  sheet.getRange("A4:A8").format.columnWidth = 16;
  sheet.getRange("B4:B8").format.columnWidth = 66;
  sheet.getRange("A4:B8").format.rowHeight = 30;

  const summaryRows = [
    ["数据分类", "记录数", "对应工作表"],
    ["完整报价明细", quotes.length, "完整报价明细"],
    ["SKU 映射", source.sku_mappings.length, "SKU映射"],
    ["供应商能力", source.capabilities.length, "供应商能力"],
    ["报价规则原文", source.price_rules.length, "报价规则原文"],
    ["供应商主数据", source.suppliers.length, "供应商主数据"],
    ["供应商别名", source.supplier_aliases.length, "供应商别名"],
    ["工艺主数据", source.processes.length, "工艺主数据"],
    ["工艺别名", source.process_aliases.length, "工艺别名"],
    ["文件要求", source.vendor_file_rules.length, "文件要求"],
    ["数据问题", source.issues.length, "数据问题"],
  ];
  sheet.getRange("D4:F14").values = summaryRows;
  sheet.getRange("D4:F4").format = { fill: colors.teal, font: { color: colors.white, bold: true }, horizontalAlignment: "center" };
  sheet.getRange("D5:D14").format = { fill: colors.sky, font: { color: colors.navy, bold: true } };
  sheet.getRange("E5:E14").format = { fill: colors.gray, font: { color: colors.text, bold: true }, horizontalAlignment: "right", numberFormat: "#,##0" };
  sheet.getRange("F5:F14").format = { fill: colors.gray, font: { color: colors.text } };
  sheet.getRange("D4:F14").format.borders = { preset: "outside", style: "thin", color: colors.line };
  sheet.getRange("D:D").format.columnWidth = 23;
  sheet.getRange("E:E").format.columnWidth = 13;
  sheet.getRange("F:F").format.columnWidth = 24;

  const priceRows = [
    ["价格分类", "数量"],
    ["绿色源固定价", quoteSuggestions.filter((item) => item.result.color === "green").length],
    ["黄色 AI 建议", quoteSuggestions.filter((item) => item.result.color === "yellow").length],
    ["橙色 AI 建议", quoteSuggestions.filter((item) => item.result.color === "orange").length],
    ["红色暂不定价", quoteSuggestions.filter((item) => item.result.color === "red").length],
  ];
  sheet.getRange("A11:B15").values = priceRows;
  sheet.getRange("A11:B11").format = { fill: colors.blue, font: { color: colors.white, bold: true }, horizontalAlignment: "center" };
  sheet.getRange("A12:A15").format = { fill: colors.sky, font: { color: colors.navy, bold: true } };
  sheet.getRange("B12:B15").format = { fill: colors.gray, font: { color: colors.text, bold: true }, horizontalAlignment: "right", numberFormat: "#,##0" };
  sheet.getRange("A11:B15").format.borders = { preset: "outside", style: "thin", color: colors.line };
}

function addFinalQuoteDetails(workbook) {
  const sheet = workbook.worksheets.add("完整报价明细");
  const headers = ["报价ID", "价格属性", "颜色说明", "供应商", "SKU", "共用SKU原文", "工艺", "材质", "产品尺寸", "定制尺寸", "原价格原文", "源固定价", "AI建议价", "建议区间下", "建议区间上", "建议依据", "置信度", "SKU映射数", "能力匹配数", "规则匹配数", "文件要求数", "数据问题数", "关联审核", "审批状态", "人工确认价", "最终采用价", "启用状态", "来源", "备注"];
  const audits = quoteSuggestions.map(({ quote }) => relationAudit(quote));
  const rows = quoteSuggestions.map(({ quote, result }, index) => {
    const audit = audits[index];
    return [
      quote["报价项ID"], result.kind,
      result.color === "green" ? "绿色-源价格" : result.color === "yellow" ? "黄色-AI定义" : result.color === "orange" ? "橙色-AI低置信" : "红色-暂不定价",
      quote["供应商原名"], quote["SKU"], quote["共用SKU原文"], quote["工艺原名"], quote["材质"], quote["产品尺寸原文"], quote["定制尺寸原文"], quote["价格原文"],
      result.sourcePrice, result.suggestion?.price ?? null, result.suggestion?.low ?? null, result.suggestion?.high ?? null,
      result.basis, result.confidence, audit.skuMappings, audit.capabilities, audit.rules, audit.fileRules, audit.issues, audit.status,
      result.color === "green" ? "沿用源价格" : "待确认", "", null, null, quote["来源"], quote["注意事项"],
    ];
  });
  title(sheet, "完整报价明细", "全部 345 条可用报价均在此。关联列来自完整主数据；黄色和橙色价格未经审批时，最终采用价保持为空。", headers.length);
  const endRow = tableShell(sheet, headers, rows, "FinalQuoteAuditTable", {
    "价格属性": 28, "颜色说明": 19, "共用SKU原文": 22, "产品尺寸": 25, "定制尺寸": 27,
    "原价格原文": 34, "审批状态": 19, "启用状态": 24, "关联审核": 38,
  });
  sheet.getRange(`L5:O${endRow}`).format.numberFormat = "#,##0.00";
  sheet.getRange(`R5:V${endRow}`).format.numberFormat = "#,##0";
  sheet.getRange(`Y5:Z${endRow}`).format.numberFormat = "#,##0.00";
  sheet.getRange(`X5:X${endRow}`).dataValidation = { rule: { type: "list", values: ["待确认", "已接受AI建议", "人工改价", "沿用源价格", "已驳回"] } };
  sheet.getRange(`Y5:Y${endRow}`).format = { fill: colors.sky, font: { color: colors.navy } };
  sheet.getRange(`Z5:Z${endRow}`).formulas = rows.map((_, index) => {
    const row = index + 5;
    return [`=IF(X${row}=\"已接受AI建议\",M${row},IF(X${row}=\"人工改价\",Y${row},IF(X${row}=\"沿用源价格\",L${row},\"\")))`];
  });
  sheet.getRange(`AA5:AA${endRow}`).formulas = rows.map((_, index) => {
    const row = index + 5;
    return [`=IF(Z${row}>0,\"可导入（待系统接入）\",\"不可导入\")`];
  });
  sheet.getRange(`Z5:AA${endRow}`).format = { fill: colors.gray, font: { color: colors.text, bold: true } };
  quoteSuggestions.forEach(({ result }, index) => {
    const row = index + 5;
    colorPriceCell(sheet, `B${row}:C${row}`, result.color);
    if (result.color === "green") colorPriceCell(sheet, `L${row}`, "green");
    else if (result.color === "red") colorPriceCell(sheet, `M${row}:O${row}`, "red");
    else colorPriceCell(sheet, `M${row}:O${row}`, result.color);
    if (audits[index].status !== "完整关联") colorPriceCell(sheet, `W${row}`, "red");
    else colorPriceCell(sheet, `W${row}`, "green");
  });
}

function addRawDataSheet(workbook, config) {
  const sheet = workbook.worksheets.add(config.name);
  const headers = Object.keys(config.records[0] ?? { "记录": "" });
  const rows = config.records.length
    ? config.records.map((record) => headers.map((header) => record[header] ?? ""))
    : [["暂无记录"]];
  title(sheet, config.title, config.subtitle, headers.length);
  const endRow = tableShell(sheet, headers, rows, config.tableName, config.widths ?? {});
  for (const header of config.numberHeaders ?? []) {
    const index = headers.indexOf(header) + 1;
    if (index) sheet.getRange(`${colLetter(index)}5:${colLetter(index)}${endRow}`).format.numberFormat = "#,##0.00";
  }
  if (config.issueColors) {
    const severityColumn = headers.indexOf("严重程度") + 1;
    if (severityColumn) {
      const severityLetter = colLetter(severityColumn);
      const bodyRange = sheet.getRange(`A5:${colLetter(headers.length)}${endRow}`);
      bodyRange.conditionalFormats.addCustom(`=$${severityLetter}5=\"高\"`, { fill: colors.red, font: { color: colors.redText } });
      bodyRange.conditionalFormats.addCustom(`=$${severityLetter}5=\"中\"`, { fill: colors.yellow, font: { color: colors.yellowText } });
    }
  }
}

function addComplexBoundaries(workbook) {
  const sheet = workbook.worksheets.add("复杂规则边界");
  const a3Count = quotes.filter((quote) => Object.values(quote).some((value) => String(value ?? "").includes("A3"))).length;
  const surchargeCount = quotes.filter((quote) => /\d+(?:\.\d+)?\s*元?\s*\+\s*\d/.test(String(quote["价格原文"] ?? ""))).length;
  const dimensionCount = quotes.filter((quote) => quote["定制尺寸原文"]).length;
  const threeDRules = source.price_rules.filter((rule) => rule["规则类型"] === "3D打印_克重时长").length;
  const headers = ["规则类型", "现有记录数", "当前处理", "可自动报价", "启用前必须补齐", "建议状态"];
  const rows = [
    ["尺寸插值", dimensionCount, "不插值；已有固定价仍按 SKU 精确查询", "否", "同供应商、产品族、材质、数量段、单双面、颜色与连续尺寸端点", "红色-待确认"],
    ["A3 排版", a3Count, "保留已有静态价，不推导拼版价", "否", "可用版面、出血、间距、形状、拼版数、损耗、覆膜、配袋", "红色-待确认"],
    ["附加费", surchargeCount, "原文可明确相加的只生成黄色建议", "否", "触发条件、计费单位、可叠加范围、数量段", "红色-待确认"],
    ["3D 克重/时长", threeDRules, "保留来源费率原文，不生成公式价", "否", "材料、净重、支撑损耗、时长、后处理、最低收费", "红色-待确认"],
  ];
  title(sheet, "复杂规则边界", "以下规则没有被基础价建议替代；即使出现黄色建议，也必须按原 SKU 和原文条件复核。", headers.length);
  const endRow = tableShell(sheet, headers, rows, "ComplexRuleBoundaryTable", { "当前处理": 38, "启用前必须补齐": 60, "建议状态": 20 });
  rows.forEach((_, index) => colorPriceCell(sheet, `A${index + 5}:F${index + 5}`, "red"));
  sheet.getRange(`B5:B${endRow}`).format.numberFormat = "#,##0";
  sheet.getRange(`A5:F${endRow}`).format.rowHeight = 36;
}

const workbook = Workbook.create();
let previewSheets;
if (fullAudit) {
  addFinalReadme(workbook);
  addFinalQuoteDetails(workbook);
  addRuleSuggestions(workbook);
  addComplexBoundaries(workbook);
  addRawDataSheet(workbook, {
    name: "SKU映射", title: "SKU 映射", subtitle: "全部共用 SKU 和系统配置映射记录，用于核对工艺、供应商和工费关联。",
    records: source.sku_mappings, tableName: "FullSkuMappingsTable",
    widths: { "SKU": 18, "工艺1原名": 24, "工艺2原名": 24, "供应商1原名": 20, "供应商2原名": 20, "来源": 38 },
    numberHeaders: ["工费1", "工费2"],
  });
  addRawDataSheet(workbook, {
    name: "供应商能力", title: "供应商工艺能力", subtitle: "全部供应商工艺能力与生产/物流时效。报价明细只统计供应商 + 二级工艺的精确匹配。",
    records: source.capabilities, tableName: "FullCapabilitiesTable",
    widths: { "供应商原名": 22, "一级工艺原名": 22, "二级工艺原名": 28, "备注": 34, "来源": 38 },
    numberHeaders: ["生产时效_天", "物流时效_天"],
  });
  addRawDataSheet(workbook, {
    name: "报价规则原文", title: "报价规则原文", subtitle: "全部供应商基础规则与 3D 克重/时长规则。待结构化规则不会自动参与最终采用价。",
    records: source.price_rules, tableName: "FullPriceRulesTable",
    widths: { "供应商原名": 20, "规则类型": 24, "关联工艺原名": 22, "尺寸条件原文": 24, "规则原文": 55, "规则状态": 20, "来源": 38 },
    numberHeaders: ["价格下限", "价格上限"],
  });
  addRawDataSheet(workbook, {
    name: "供应商主数据", title: "供应商主数据", subtitle: "全部供应商标准记录。供应商组合仍保留原始写法，待别名映射确认后再拆分。",
    records: source.suppliers, tableName: "FullSuppliersTable",
    widths: { "供应商名称": 24, "供应商类型": 18, "备注": 34, "来源": 40 },
  });
  addRawDataSheet(workbook, {
    name: "供应商别名", title: "供应商别名", subtitle: "全部供应商原名、组合名和映射状态，用于后续提高供应商关联覆盖率。",
    records: source.supplier_aliases, tableName: "FullSupplierAliasesTable",
    widths: { "别名": 24, "别名类型": 18, "映射状态": 18, "来源": 38, "备注": 34 },
  });
  addRawDataSheet(workbook, {
    name: "工艺主数据", title: "标准工艺主数据", subtitle: "全部标准工艺、文件要求和适用材料。",
    records: source.processes, tableName: "FullProcessesTable",
    widths: { "一级分类": 20, "标准工艺名称": 24, "通用文件要求": 42, "适用材料": 42, "通用备注": 34, "来源": 38 },
  });
  addRawDataSheet(workbook, {
    name: "工艺别名", title: "工艺别名", subtitle: "全部来源工艺写法及标准工艺映射状态；待确认项不会自动替换原文。",
    records: source.process_aliases, tableName: "FullProcessAliasesTable",
    widths: { "工艺原名": 38, "映射状态": 18, "处理说明": 40 },
    numberHeaders: ["来源记录数"],
  });
  addRawDataSheet(workbook, {
    name: "文件要求", title: "供应商文件要求", subtitle: "全部供应商工艺文件格式、分辨率、像素和尺寸要求。",
    records: source.vendor_file_rules, tableName: "FullFileRulesTable",
    widths: { "供应商原名": 22, "工艺原名": 28, "文件格式": 22, "分辨率": 22, "像素": 24, "尺寸要求": 40, "来源": 38 },
  });
  addRawDataSheet(workbook, {
    name: "数据问题", title: "数据问题清单", subtitle: "全部导入问题。高严重度标红、中严重度标黄；处理完成后保留记录并更新状态。",
    records: source.issues, tableName: "FullIssuesTable", issueColors: true,
    widths: { "问题类型": 24, "严重程度": 14, "来源": 42, "问题说明": 48, "建议处理": 42, "处理状态": 18 },
  });
  previewSheets = ["终审总览", "完整报价明细", "AI规则建议", "复杂规则边界", "SKU映射", "供应商能力", "报价规则原文", "供应商主数据", "供应商别名", "工艺主数据", "工艺别名", "文件要求", "数据问题"];
} else {
  addReadme(workbook);
  addRuleSuggestions(workbook);
  addQuoteDetails(workbook);
  addComplexBoundaries(workbook);
  previewSheets = ["说明", "AI规则建议", "报价建议明细", "复杂规则边界"];
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.mkdir(previewDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

const check = await workbook.inspect({
  kind: "table", range: fullAudit ? "完整报价明细!A1:AC18" : "报价建议明细!A1:W18", include: "values,formulas",
  tableMaxRows: 18, tableMaxCols: fullAudit ? 29 : 23,
});
console.log(check.ndjson);
const errors = await workbook.inspect({
  kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 200 }, summary: "formula error scan",
});
console.log(errors.ndjson);
console.log(JSON.stringify({
  total: quoteSuggestions.length,
  sourceFixed: quoteSuggestions.filter((item) => item.result.color === "green").length,
  aiYellow: quoteSuggestions.filter((item) => item.result.color === "yellow").length,
  aiOrange: quoteSuggestions.filter((item) => item.result.color === "orange").length,
  noPrice: quoteSuggestions.filter((item) => item.result.color === "red").length,
  ruleSuggestions: groupRules.length,
  fullAudit,
  skuMappings: source.sku_mappings.length,
  capabilities: source.capabilities.length,
  priceRules: source.price_rules.length,
  issues: source.issues.length,
}));

for (const name of previewSheets) {
  const preview = await workbook.render({ sheetName: name, range: "A1:AC20", scale: 1.05, format: "png" });
  await fs.writeFile(path.join(previewDir, `${name}.png`), new Uint8Array(await preview.arrayBuffer()));
}
