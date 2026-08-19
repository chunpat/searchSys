import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: node build_master_data.mjs <source_data.json> <output.xlsx>");
}

const data = JSON.parse(await fs.readFile(inputPath, "utf8"));

const colors = {
  navy: "#17324D",
  teal: "#0F766E",
  blue: "#2563EB",
  sky: "#EAF3FF",
  mint: "#E8F5F1",
  amber: "#FFF4D6",
  red: "#FEECEB",
  gray: "#F4F7FA",
  border: "#D7DEE7",
  text: "#1F2937",
  white: "#FFFFFF",
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

function clean(value) {
  if (value === null || value === undefined) return "";
  return value;
}

function recordsToMatrix(records) {
  if (!records.length) return [["暂无记录"]];
  const headers = Object.keys(records[0]);
  return [headers, ...records.map((record) => headers.map((header) => clean(record[header])))];
}

function titleRange(columns) {
  return `A1:${colLetter(columns)}1`;
}

function applySheetShell(sheet, title, subtitle, columns) {
  sheet.showGridLines = false;
  const titleCell = sheet.getRange(titleRange(Math.max(columns, 8)));
  titleCell.merge();
  titleCell.values = [[title]];
  titleCell.format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 16 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  titleCell.format.rowHeight = 30;
  const subtitleRange = sheet.getRange(`A2:${colLetter(Math.max(columns, 8))}2`);
  subtitleRange.merge();
  subtitleRange.values = [[subtitle]];
  subtitleRange.format = {
    fill: colors.gray,
    font: { color: "#475569", italic: true, size: 10 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    wrapText: true,
  };
  subtitleRange.format.rowHeight = 26;
}

function setColumnWidths(sheet, headers, rows) {
  headers.forEach((header, index) => {
    const values = rows.slice(0, 80).map((row) => String(row[index] ?? ""));
    const longest = Math.max(String(header).length * 2, ...values.map((value) => Math.min(value.length, 42)));
    const width = Math.max(11, Math.min(Math.ceil(longest * 1.2), 32));
    sheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidth = width;
  });
}

function addTableSheet(workbook, config) {
  const sheet = workbook.worksheets.add(config.name);
  const matrix = recordsToMatrix(config.records);
  const headers = matrix[0];
  const width = headers.length;
  applySheetShell(sheet, config.title, config.subtitle, width);

  const endColumn = colLetter(width);
  const endRow = matrix.length + 3;
  const range = sheet.getRange(`A4:${endColumn}${endRow}`);
  range.values = matrix;
  const headerRange = sheet.getRange(`A4:${endColumn}4`);
  headerRange.format = {
    fill: colors.teal,
    font: { bold: true, color: colors.white, size: 10 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: colors.border },
  };
  headerRange.format.rowHeight = 32;

  const bodyRange = sheet.getRange(`A5:${endColumn}${endRow}`);
  bodyRange.format = {
    font: { color: colors.text, size: 10 },
    verticalAlignment: "top",
    wrapText: true,
  };
  if (config.currencyColumns?.length) {
    for (const column of config.currencyColumns) {
      const columnIndex = headers.indexOf(column) + 1;
      if (columnIndex > 0) {
        sheet.getRange(`${colLetter(columnIndex)}5:${colLetter(columnIndex)}${endRow}`).format.numberFormat = "#,##0.00";
      }
    }
  }
  if (config.integerColumns?.length) {
    for (const column of config.integerColumns) {
      const columnIndex = headers.indexOf(column) + 1;
      if (columnIndex > 0) {
        sheet.getRange(`${colLetter(columnIndex)}5:${colLetter(columnIndex)}${endRow}`).format.numberFormat = "#,##0";
      }
    }
  }

  const table = sheet.tables.add(`A4:${endColumn}${endRow}`, true, config.tableName);
  table.style = "TableStyleMedium2";
  table.showBandedColumns = false;
  table.showFilterButton = true;

  setColumnWidths(sheet, headers, matrix.slice(1));
  const sourceIndex = headers.indexOf("来源") + 1;
  if (sourceIndex > 0) sheet.getRange(`${colLetter(sourceIndex)}:${colLetter(sourceIndex)}`).format.columnWidth = 40;
  const noteIndex = headers.findIndex((header) => header.includes("备注") || header.includes("说明")) + 1;
  if (noteIndex > 0) sheet.getRange(`${colLetter(noteIndex)}:${colLetter(noteIndex)}`).format.columnWidth = 34;
  sheet.freezePanes.freezeRows(4);
  return sheet;
}

function addReadme(workbook) {
  const sheet = workbook.worksheets.add("说明");
  sheet.showGridLines = false;
  const title = sheet.getRange("A1:J1");
  title.merge();
  title.values = [["定制报价查询 - 统一主数据"]];
  title.format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 18 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  title.format.rowHeight = 34;

  const overview = [
    ["用途", "为内部报价查询系统提供可导入、可审核、可追溯的主数据。原始 Excel 不会被修改。"],
    ["查询优先级", "SKU 精确匹配 > 规格精确匹配 > 已配置报价规则 > 人工确认。"],
    ["安全原则", "价格、尺寸、工艺别名只做可确定的自动解析；其余保留原文并进入“数据问题”。"],
    ["刷新方式", "更新原始表后重新运行导入；系统应保留来源文件、工作表和行号。"],
  ];
  sheet.getRange("A3:B6").values = overview;
  sheet.getRange("A3:A6").format = { fill: colors.sky, font: { bold: true, color: colors.navy }, verticalAlignment: "top", wrapText: true };
  sheet.getRange("B3:B6").format = { fill: colors.gray, font: { color: colors.text }, verticalAlignment: "top", wrapText: true };
  sheet.getRange("A3:B6").format.borders = { preset: "outside", style: "thin", color: colors.border };

  const summaryRows = Object.entries(data.summary).map(([label, value]) => [label, value]);
  sheet.getRange(`D3:E${summaryRows.length + 3}`).values = [["初始导入概览", "记录数"], ...summaryRows];
  sheet.getRange("D3:E3").format = { fill: colors.teal, font: { bold: true, color: colors.white }, horizontalAlignment: "center" };
  sheet.getRange(`D4:D${summaryRows.length + 3}`).format = { fill: colors.mint, font: { bold: true, color: colors.navy } };
  sheet.getRange(`E4:E${summaryRows.length + 3}`).format = { fill: colors.gray, font: { bold: true, color: colors.text }, horizontalAlignment: "right", numberFormat: "#,##0" };
  sheet.getRange(`D3:E${summaryRows.length + 3}`).format.borders = { preset: "outside", style: "thin", color: colors.border };

  const types = [
    ["价格类型", "系统行为"],
    ["固定单价", "可直接用于报价"],
    ["文本单价", "需确认计价单位后才能启用"],
    ["供应商基础规则", "保留原文，需拆成可计算的价格规则"],
    ["3D打印_克重时长", "需确认克重与时长的组合公式"],
  ];
  sheet.getRange("A9:B13").values = types;
  sheet.getRange("A9:B9").format = { fill: colors.teal, font: { bold: true, color: colors.white }, horizontalAlignment: "center" };
  sheet.getRange("A10:A13").format = { fill: colors.amber, font: { bold: true, color: colors.navy } };
  sheet.getRange("B10:B13").format = { fill: colors.gray, font: { color: colors.text }, wrapText: true };
  sheet.getRange("A9:B13").format.borders = { preset: "outside", style: "thin", color: colors.border };

  const sequence = [
    ["使用顺序", "动作"],
    ["1", "先处理“数据问题”中的高优先级项：缺报价、价格文本和尺寸待结构化。"],
    ["2", "确认“工艺别名”和“供应商别名”，不要覆盖原始名称。"],
    ["3", "将“报价规则”拆为固定价、尺寸分档、面积、排版、附加费或 3D 打印规则。"],
    ["4", "将确认后的工作簿导入 SQLite，供内部查询页面读取。"],
  ];
  sheet.getRange("D14:E18").values = sequence;
  sheet.getRange("D14:E14").format = { fill: colors.blue, font: { bold: true, color: colors.white }, horizontalAlignment: "center" };
  sheet.getRange("D15:D18").format = { fill: colors.sky, font: { bold: true, color: colors.navy }, horizontalAlignment: "center" };
  sheet.getRange("E15:E18").format = { fill: colors.gray, font: { color: colors.text }, wrapText: true };
  sheet.getRange("D14:E18").format.borders = { preset: "outside", style: "thin", color: colors.border };

  sheet.getRange("A:A").format.columnWidth = 18;
  sheet.getRange("B:B").format.columnWidth = 56;
  sheet.getRange("D:D").format.columnWidth = 22;
  sheet.getRange("E:E").format.columnWidth = 58;
  sheet.getRange("A3:B6").format.rowHeight = 30;
  sheet.getRange("D14:E18").format.rowHeight = 28;
}

const workbook = Workbook.create();
addReadme(workbook);

addTableSheet(workbook, {
  name: "供应商",
  title: "供应商主数据",
  subtitle: "保留来源中的原始供应商名称；供应商组合先作为独立记录，待“供应商别名”表确认拆分。",
  records: data.suppliers,
  tableName: "SuppliersTable",
});
addTableSheet(workbook, {
  name: "供应商别名",
  title: "供应商别名与组合映射",
  subtitle: "原始名称、组合名称和后续简称在此维护；所有查询应最终使用供应商ID。",
  records: data.supplier_aliases,
  tableName: "SupplierAliasesTable",
});
addTableSheet(workbook, {
  name: "标准工艺",
  title: "标准工艺字典",
  subtitle: "来自工艺共享表的通用定义。新增工艺时先在此处建立标准记录。",
  records: data.processes,
  tableName: "ProcessesTable",
});
addTableSheet(workbook, {
  name: "工艺别名",
  title: "工艺别名映射",
  subtitle: "只自动匹配名称完全一致的工艺；组合工艺、近义词和供应商写法请人工确认。",
  records: data.process_aliases,
  tableName: "ProcessAliasesTable",
});
addTableSheet(workbook, {
  name: "供应商能力",
  title: "供应商工艺能力与时效",
  subtitle: "用于筛选可做供应商和交期。生产时效采用来源表中的“更新后生产时效”。",
  records: data.capabilities,
  tableName: "CapabilitiesTable",
  integerColumns: ["生产时效_天", "物流时效_天"],
});
addTableSheet(workbook, {
  name: "报价项",
  title: "报价项",
  subtitle: "一行代表一个供应商的可报价产品/规格记录。原始价格和尺寸保留，已安全解析的数据拆入结构化列。",
  records: data.quote_items,
  tableName: "QuoteItemsTable",
  currencyColumns: ["价格下限", "价格上限"],
  integerColumns: ["生产时效_天", "物流时效_天", "定制宽_mm", "定制高_mm", "定制深_mm"],
});
addTableSheet(workbook, {
  name: "报价规则",
  title: "报价规则",
  subtitle: "供应商基础说明与 3D 打印规则已进入此表；后续应拆解为可计算的尺寸分档、附加费、排版或克重时长规则。",
  records: data.price_rules,
  tableName: "PriceRulesTable",
  currencyColumns: ["价格下限", "价格上限"],
});
addTableSheet(workbook, {
  name: "SKU映射",
  title: "SKU 映射",
  subtitle: "来自共用SKU及 208 个SKU配置状态。工费字段目前为空，保留用于后续补录。",
  records: data.sku_mappings,
  tableName: "SkuMappingsTable",
  currencyColumns: ["工费1", "工费2"],
});
addTableSheet(workbook, {
  name: "供应商文件要求",
  title: "供应商定制文件要求",
  subtitle: "该表可直接供查询结果展示，也可用于上传文件校验规则。",
  records: data.vendor_file_rules,
  tableName: "VendorFileRulesTable",
});
addTableSheet(workbook, {
  name: "数据问题",
  title: "数据问题清单",
  subtitle: "请优先处理高优先级问题。处理完成后保留记录，并更新“处理状态”和处理说明。",
  records: data.issues,
  tableName: "IssuesTable",
});

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);

const checks = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 6000,
  tableMaxRows: 3,
  tableMaxCols: 8,
  tableMaxCellChars: 60,
});
console.log(checks.ndjson);
