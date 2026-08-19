import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const [inputPath, outputPath, previewDir] = process.argv.slice(2);
if (!inputPath || !outputPath || !previewDir) {
  throw new Error("Usage: node build_rule_workbench.mjs <source.json> <output.xlsx> <preview-dir>");
}

const source = JSON.parse(await fs.readFile(inputPath, "utf8"));
const colors = {
  navy: "#17324D", teal: "#0F766E", blue: "#2563EB", sky: "#EAF3FF",
  mint: "#E8F5F1", amber: "#FFF4D6", red: "#FEECEB", gray: "#F4F7FA",
  border: "#D7DEE7", text: "#1F2937", white: "#FFFFFF",
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

function rangeFor(columns, row) {
  return `A${row}:${colLetter(columns)}${row}`;
}

function setTitle(sheet, title, subtitle, columns) {
  sheet.showGridLines = false;
  const titleRange = sheet.getRange(rangeFor(columns, 1));
  titleRange.merge();
  titleRange.values = [[title]];
  titleRange.format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 16 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  titleRange.format.rowHeight = 32;
  const subtitleRange = sheet.getRange(rangeFor(columns, 2));
  subtitleRange.merge();
  subtitleRange.values = [[subtitle]];
  subtitleRange.format = {
    fill: colors.gray,
    font: { color: "#475569", italic: true, size: 10 },
    verticalAlignment: "center",
    wrapText: true,
  };
  subtitleRange.format.rowHeight = 28;
}

function applyHeader(sheet, headers, endRow, tableName, widths = {}) {
  const endColumn = colLetter(headers.length);
  sheet.getRange(`A4:${endColumn}4`).values = [headers];
  sheet.getRange(`A4:${endColumn}4`).format = {
    fill: colors.teal,
    font: { bold: true, color: colors.white, size: 10 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: colors.border },
  };
  sheet.getRange(`A4:${endColumn}4`).format.rowHeight = 34;
  sheet.getRange(`A5:${endColumn}${endRow}`).format = {
    font: { color: colors.text, size: 10 },
    verticalAlignment: "top",
    wrapText: true,
  };
  sheet.tables.add(`A4:${endColumn}${endRow}`, true, tableName).style = "TableStyleMedium2";
  headers.forEach((header, index) => {
    const standardWidths = { "规则状态": 16, "自动报价许可": 16, "优先级": 10, "确认人": 14 };
    const width = widths[header] ?? standardWidths[header] ?? Math.max(11, Math.min(22, Math.ceil(header.length * 2.2)));
    sheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidth = width;
  });
  sheet.freezePanes.freezeRows(4);
}

function priorityItems() {
  const grouped = new Map();
  for (const quote of source.quote_items) {
    if (!quote["工艺原名"] || !quote["供应商原名"]) continue;
    const key = `${quote["供应商原名"]}|${quote["工艺原名"]}`;
    const item = grouped.get(key) ?? {
      supplier: quote["供应商原名"], process: quote["工艺原名"], quoteCount: 0,
      directCount: 0, pendingCount: 0, sizeCount: 0,
    };
    item.quoteCount += 1;
    if (quote["价格解析状态"] === "已结构化") item.directCount += 1;
    else item.pendingCount += 1;
    if (quote["定制尺寸原文"]) item.sizeCount += 1;
    grouped.set(key, item);
  }
  return [...grouped.values()]
    .filter((item) => item.quoteCount >= 4)
    .sort((left, right) => right.quoteCount - left.quoteCount || right.pendingCount - left.pendingCount)
    .slice(0, 16)
    .map((item, index) => ({ ...item, priority: index < 5 ? "P1" : index < 10 ? "P2" : "P3" }));
}

const priorities = priorityItems();
const defaultRows = 40;

function fixedRuleRows() {
  return Array.from({ length: defaultRows }, (_, index) => {
    const item = priorities[index];
    return [
      `FIX-${String(index + 1).padStart(3, "0")}`, item?.priority ?? "P3", "待补录", "禁止",
      item?.supplier ?? "", item?.process ?? "", "", "", "", "", "", "", "", "", "",
      "", "元/件", "待确认", "待确认", "", "", "", "",
    ];
  });
}

function tierRuleRows() {
  return Array.from({ length: defaultRows }, (_, index) => {
    const item = priorities[index];
    return [
      `TIER-${String(index + 1).padStart(3, "0")}`, item?.priority ?? "P3", "待补录", "禁止",
      item?.supplier ?? "", item?.process ?? "", "", "", "", "", "最长边", "mm",
      "", "", "", "", "", "", "含上限", "", "", "元/件", "", "", "", "",
    ].slice(0, 25);
  });
}

function emptyRows(count, columns, prefix, type) {
  return Array.from({ length: count }, (_, index) => {
    const row = Array(columns).fill("");
    row[0] = `${prefix}-${String(index + 1).padStart(3, "0")}`;
    row[1] = "P3";
    row[2] = "待补录";
    row[3] = "禁止";
    row[7] = type;
    return row;
  });
}

function addRuleSheet(workbook, config) {
  const sheet = workbook.worksheets.add(config.name);
  setTitle(sheet, config.title, config.subtitle, config.headers.length);
  const endRow = config.rows.length + 4;
  sheet.getRange(`A5:${colLetter(config.headers.length)}${endRow}`).values = config.rows;
  applyHeader(sheet, config.headers, endRow, config.tableName, config.widths);
  if (config.bodyRowHeight) sheet.getRange(`A5:${colLetter(config.headers.length)}${endRow}`).format.rowHeight = config.bodyRowHeight;
  for (const header of config.currencyHeaders ?? []) {
    const index = config.headers.indexOf(header) + 1;
    if (index) sheet.getRange(`${colLetter(index)}5:${colLetter(index)}${endRow}`).format.numberFormat = "#,##0.00";
  }
  for (const header of config.integerHeaders ?? []) {
    const index = config.headers.indexOf(header) + 1;
    if (index) sheet.getRange(`${colLetter(index)}5:${colLetter(index)}${endRow}`).format.numberFormat = "#,##0";
  }
  const statusCol = config.headers.indexOf("规则状态") + 1;
  const autoCol = config.headers.indexOf("自动报价许可") + 1;
  const priorityCol = config.headers.indexOf("优先级") + 1;
  if (statusCol) sheet.getRange(`${colLetter(statusCol)}5:${colLetter(statusCol)}${endRow}`).dataValidation = { rule: { type: "list", values: ["待补录", "待复核", "待确认计算公式", "已启用", "已停用"] } };
  if (autoCol) sheet.getRange(`${colLetter(autoCol)}5:${colLetter(autoCol)}${endRow}`).dataValidation = { rule: { type: "list", values: ["禁止", "允许"] } };
  if (priorityCol) sheet.getRange(`${colLetter(priorityCol)}5:${colLetter(priorityCol)}${endRow}`).dataValidation = { rule: { type: "list", values: ["P1", "P2", "P3"] } };
  if (statusCol) sheet.getRange(`${colLetter(statusCol)}5:${colLetter(statusCol)}${endRow}`).conditionalFormats.add("containsText", { text: "已启用", format: { fill: colors.mint, font: { color: "#0B5C54", bold: true } } });
  if (autoCol) sheet.getRange(`${colLetter(autoCol)}5:${colLetter(autoCol)}${endRow}`).conditionalFormats.add("containsText", { text: "禁止", format: { fill: colors.amber, font: { color: "#A96000", bold: true } } });
  return sheet;
}

function addReadme(workbook) {
  const sheet = workbook.worksheets.add("说明");
  setTitle(sheet, "报价规则工作台", "用于人工结构化高频报价规则。默认禁止自动报价；任何缺失边界或未复核规则都只能供查询参考。", 8);
  const policy = [
    ["自动报价门槛", "同供应商、SKU/产品族、工艺、材质、数量、单/双面、颜色、定制位置和尺寸范围必须同时命中已确认规则。"],
    ["尺寸规则", "仅支持供应商确认的尺寸分档；不跨档、不外推。尺寸插值现阶段关闭，即使有两个历史点也不能直接报价。"],
    ["A3 排版", "必须补齐可用版面、出血、间距、拼版数、异形、单双面、覆膜、损耗和配袋条件后才可启用。"],
    ["附加费", "必须明确触发条件、一次性/按件/按色/按面/按位置、是否可叠加及数量范围。"],
    ["3D 打印", "当前克重/时长费率为区间，需确认材料、净重、支撑损耗、机器时长、后处理与最低收费后才能启用。"],
  ];
  sheet.getRange("A4:B8").values = policy;
  sheet.getRange("A4:A8").format = { fill: colors.sky, font: { bold: true, color: colors.navy }, verticalAlignment: "top", wrapText: true };
  sheet.getRange("B4:B8").format = { fill: colors.gray, font: { color: colors.text }, verticalAlignment: "top", wrapText: true };
  sheet.getRange("A4:B8").format.borders = { preset: "outside", style: "thin", color: colors.border };
  sheet.getRange("A4:B8").format.rowHeight = 36;
  sheet.getRange("D4:E8").values = [
    ["工作台状态", "数量"],
    ["待补录固定价规则", null],
    ["待补录尺寸分档", null],
    ["待确认 3D 公式", null],
    ["自动报价已启用", null],
  ];
  sheet.getRange("D4:E4").format = { fill: colors.teal, font: { bold: true, color: colors.white }, horizontalAlignment: "center" };
  sheet.getRange("D5:D8").format = { fill: colors.mint, font: { bold: true, color: colors.navy } };
  sheet.getRange("E5:E8").format = { fill: colors.gray, font: { bold: true, color: colors.text }, horizontalAlignment: "right", numberFormat: "#,##0" };
  sheet.getRange("D4:E8").format.borders = { preset: "outside", style: "thin", color: colors.border };
  sheet.getRange("A:A").format.columnWidth = 19;
  sheet.getRange("B:B").format.columnWidth = 64;
  sheet.getRange("D:D").format.columnWidth = 24;
  sheet.getRange("E:E").format.columnWidth = 13;
}

function addWorklist(workbook) {
  const headers = ["优先级", "供应商", "工艺", "报价项数", "可直接报价", "待结构化价格", "含尺寸记录", "建议动作", "负责人", "当前状态", "复核日期"];
  const rows = priorities.map((item) => [
    item.priority, item.supplier, item.process, item.quoteCount, item.directCount, item.pendingCount, item.sizeCount,
    item.pendingCount ? "先拆固定价/尺寸分档" : "先确认尺寸边界", "", "待开始", "",
  ]);
  const sheet = workbook.worksheets.add("规则工作清单");
  setTitle(sheet, "高频工艺规则工作清单", "优先级按历史报价项数量和待结构化价格排序。每一行只代表一个供应商 + 工艺组合，禁止跨供应商合并。", headers.length);
  sheet.getRange(`A5:${colLetter(headers.length)}${rows.length + 4}`).values = rows;
  applyHeader(sheet, headers, rows.length + 4, "RuleWorklistTable", { "建议动作": 28, "供应商": 18, "工艺": 28 });
  sheet.getRange(`D5:G${rows.length + 4}`).format.numberFormat = "#,##0";
  sheet.getRange(`K5:K${rows.length + 4}`).format.numberFormat = "yyyy-mm-dd";
  sheet.getRange(`A5:A${rows.length + 4}`).dataValidation = { rule: { type: "list", values: ["P1", "P2", "P3"] } };
  sheet.getRange(`J5:J${rows.length + 4}`).dataValidation = { rule: { type: "list", values: ["待开始", "进行中", "已完成"] } };
}

function addDictionary(workbook) {
  const sheet = workbook.worksheets.add("字典");
  setTitle(sheet, "规则配置字典", "下拉选项统一在此维护。不要删除既有值，新增值可追加到列表末尾。", 5);
  sheet.getRange("A4:E9").values = [
    ["规则状态", "自动报价许可", "优先级", "工作状态", "尺寸计价基准"],
    ["待补录", "禁止", "P1", "待开始", "最长边"],
    ["待复核", "允许", "P2", "进行中", "宽×高"],
    ["待确认计算公式", "", "P3", "已完成", "面积"],
    ["已启用", "", "", "", "体积"],
    ["已停用", "", "", "", "标准规格"],
  ];
  sheet.getRange("A4:E4").format = { fill: colors.teal, font: { bold: true, color: colors.white }, horizontalAlignment: "center" };
  sheet.getRange("A5:E9").format = { fill: colors.gray, font: { color: colors.text } };
  sheet.getRange("A4:E9").format.borders = { preset: "outside", style: "thin", color: colors.border };
  sheet.getRange("A:E").format.columnWidth = 20;
}

const workbook = Workbook.create();
addReadme(workbook);
addWorklist(workbook);

addRuleSheet(workbook, {
  name: "固定价规则", title: "固定价规则", subtitle: "仅当所有条件精确命中且状态为“已启用”、自动报价许可为“允许”时，才可返回直接报价。",
  headers: ["规则ID", "优先级", "规则状态", "自动报价许可", "供应商", "工艺", "SKU/产品族", "材质", "数量下限", "数量上限", "单/双面", "颜色数", "定制位置", "后处理", "价格", "价格单位", "含税", "含包装", "生效日期", "失效日期", "确认人", "来源", "备注"],
  rows: fixedRuleRows(), tableName: "FixedPriceRulesTable", currencyHeaders: ["价格"], integerHeaders: ["数量下限", "数量上限"],
  widths: { "SKU/产品族": 22, "工艺": 24, "供应商": 16, "来源": 32, "备注": 30 },
});

addRuleSheet(workbook, {
  name: "尺寸分档规则", title: "尺寸分档规则", subtitle: "只允许供应商确认的尺寸范围。边界必须写明是否包含上限；跨档、缺尺寸、超出范围均返回待确认。",
  headers: ["规则ID", "优先级", "规则状态", "自动报价许可", "供应商", "工艺", "SKU/产品族", "材质", "数量下限", "数量上限", "尺寸计价基准", "单位", "宽下限", "宽上限", "高下限", "高上限", "深下限", "深上限", "边界方式", "价格", "最低收费", "价格单位", "确认人", "来源", "备注"],
  rows: tierRuleRows(), tableName: "SizeTierRulesTable", currencyHeaders: ["价格", "最低收费"], integerHeaders: ["数量下限", "数量上限", "宽下限", "宽上限", "高下限", "高上限", "深下限", "深上限"],
  widths: { "SKU/产品族": 22, "工艺": 24, "供应商": 16, "来源": 32, "备注": 30 },
});

addRuleSheet(workbook, {
  name: "A3排版规则", title: "A3 排版规则", subtitle: "本表仅录入计算条件，默认禁止自动报价。必须明确可用版面、拼版方式和损耗后才能复核。",
  headers: ["规则ID", "优先级", "规则状态", "自动报价许可", "供应商", "工艺", "SKU/产品族", "规则类型", "版材宽mm", "版材高mm", "可用宽mm", "可用高mm", "出血mm", "间距mm", "成品形状", "单双面", "覆膜", "损耗率", "每版固定费", "每件加工费", "最少数量", "确认人", "来源", "备注"],
  rows: emptyRows(20, 24, "A3", "A3排版"), tableName: "A3LayoutRulesTable", currencyHeaders: ["每版固定费", "每件加工费"], integerHeaders: ["版材宽mm", "版材高mm", "可用宽mm", "可用高mm", "出血mm", "间距mm", "最少数量"],
  widths: { "SKU/产品族": 22, "工艺": 24, "供应商": 16, "来源": 32, "备注": 30 },
});

addRuleSheet(workbook, {
  name: "附加费规则", title: "附加费规则", subtitle: "附加费必须有明确触发条件和计费单位。未说明是否可叠加、与哪条主规则关联时，禁止自动计算。",
  headers: ["规则ID", "优先级", "规则状态", "自动报价许可", "供应商", "工艺", "SKU/产品族", "规则类型", "触发条件", "计费方式", "数量下限", "数量上限", "金额", "金额单位", "可与主价叠加", "可与其他附加费叠加", "确认人", "来源", "备注"],
  rows: emptyRows(20, 19, "ADD", "附加费"), tableName: "SurchargeRulesTable", currencyHeaders: ["金额"], integerHeaders: ["数量下限", "数量上限"],
  widths: { "SKU/产品族": 22, "触发条件": 28, "工艺": 24, "供应商": 16, "来源": 32, "备注": 30 },
});

const threeDRows = source.price_rules
  .filter((item) => item["规则类型"] === "3D打印_克重时长")
  .map((item, index) => [
    `3D-${String(index + 1).padStart(3, "0")}`, "P2", item["规则状态"], "禁止", item["供应商原名"], item["关联工艺原名"], item["材料"], item["尺寸条件原文"], item["规则原文"], "", "", "", "", "", "", "", item["来源"], "需确认取值、损耗、最低收费和后处理后才可启用",
  ]);
addRuleSheet(workbook, {
  name: "3D克重时长规则", title: "3D 克重 / 时长规则", subtitle: "已从来源提取的 6 条费率说明。费率区间不等同于可执行公式，当前全部禁止自动报价。",
  headers: ["规则ID", "优先级", "规则状态", "自动报价许可", "供应商", "工艺", "材料", "最大尺寸", "来源规则原文", "净重费率", "支撑损耗率", "机器时费率", "后处理费", "最低收费", "数量下限", "数量上限", "来源", "备注"],
  rows: threeDRows, tableName: "ThreeDPrintRulesTable", currencyHeaders: ["净重费率", "机器时费率", "后处理费", "最低收费"], integerHeaders: ["数量下限", "数量上限"],
  widths: { "来源规则原文": 55, "材料": 22, "最大尺寸": 18, "供应商": 16, "来源": 32, "备注": 36 }, bodyRowHeight: 38,
});

addDictionary(workbook);

// Cross-sheet formulas are written only after every referenced worksheet exists.
workbook.worksheets.getItem("说明").getRange("E5:E8").formulas = [
  ["=COUNTIF('固定价规则'!$C$5:$C$44,\"待补录\")"],
  ["=COUNTIF('尺寸分档规则'!$C$5:$C$44,\"待补录\")"],
  ["=COUNTIF('3D克重时长规则'!$C$5:$C$10,\"待确认计算公式\")"],
  ["=COUNTIF('固定价规则'!$C$5:$C$44,\"已启用\")+COUNTIF('尺寸分档规则'!$C$5:$C$44,\"已启用\")"],
];

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.mkdir(previewDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

const check = await workbook.inspect({
  kind: "table",
  range: "固定价规则!A1:W12",
  include: "values,formulas",
  tableMaxRows: 12,
  tableMaxCols: 23,
});
console.log(check.ndjson);
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});
console.log(errors.ndjson);
for (const name of ["说明", "规则工作清单", "固定价规则", "尺寸分档规则", "A3排版规则", "附加费规则", "3D克重时长规则", "字典"]) {
  const preview = await workbook.render({ sheetName: name, range: "A1:Z18", scale: 1.2, format: "png" });
  await fs.writeFile(path.join(previewDir, `${name}.png`), new Uint8Array(await preview.arrayBuffer()));
}
