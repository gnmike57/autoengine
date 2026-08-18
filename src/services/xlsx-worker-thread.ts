/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, @typescript-eslint/no-misused-promises*/
import { parentPort } from "worker_threads";
import ExcelJS from "exceljs";

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF111827" },
};

const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FF06B6D4" },
  size: 11,
  name: "Calibri",
};

const OUTCOME_COLORS: { [key: string]: { bg: string; font: string } } = {
  success:      { bg: "FF22C55E", font: "FF000000" },
  incorrect:    { bg: "FFEF4444", font: "FFFFFFFF" },
  tempdisabled: { bg: "FFF97316", font: "FF000000" },
  permdisabled: { bg: "FFB91C1C", font: "FFFFFFFF" },
  blocked:      { bg: "FF8B5CF6", font: "FFFFFFFF" },
  "2FA":        { bg: "FFEAB308", font: "FF000000" },
  noaccount:    { bg: "FF6B7280", font: "FFFFFFFF" },
  testing:      { bg: "FF3B82F6", font: "FFFFFFFF" },
  failed:       { bg: "FFEF4444", font: "FFFFFFFF" },
  "N/A":        { bg: "FF4B5563", font: "FFFFFFFF" },
};

function getCellFill(outcome: string): ExcelJS.Fill | undefined {
  const c = OUTCOME_COLORS[outcome];
  if (!c) return undefined;
  return {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: c.bg },
  };
}

function getCellFont(outcome: string): Partial<ExcelJS.Font> {
  const c = OUTCOME_COLORS[outcome];
  return {
    color: { argb: c?.font || "FFFFFFFF" },
    size: 10,
    name: "Calibri",
  };
}

function getPasswordOutcome(
  passwordIdx: number,
  passwords: string[],
  sites: { [name: string]: { outcome: string; attempts: number } },
  currentBatch: number,
  passwordResults: any[]
): string {
  const directResult = passwordResults.find(r => r.attemptIndex === passwordIdx);
  if (directResult) return directResult.outcome;

  const pw = passwords[passwordIdx];
  if (!pw || pw.length === 0) return "";

  const batchOfPw = Math.floor(passwordIdx / 3);
  if (batchOfPw > currentBatch) return "queued";

  if (batchOfPw === currentBatch) {
    const outcomes = Object.values(sites).map(s => s.outcome);
    if (outcomes.includes("success")) return "success";
    if (outcomes.includes("testing")) return "testing";
    if (outcomes.includes("tempdisabled")) return "tempdisabled";
    if (outcomes.includes("permdisabled")) return "permdisabled";
    if (outcomes.includes("blocked")) return "blocked";
    if (outcomes.includes("2FA")) return "2FA";
    if (outcomes.includes("noaccount")) return "noaccount";
    if (outcomes.some(o => o === "N/A" || o === "failed")) return "incorrect";
    if (outcomes.includes("queued")) return "queued";
    return "incorrect";
  }

  const siteOutcomes = Object.values(sites).map(s => s.outcome);
  if (siteOutcomes.includes("tempdisabled")) return "tempdisabled";
  return "incorrect";
}

parentPort?.on("message", async (msg) => {
  const { rows, outputPath, csvPath } = msg;

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Automati Engine";
    workbook.created = new Date();
    workbook.modified = new Date();

    const sheet = workbook.addWorksheet("Credentials", {
      properties: { tabColor: { argb: "FF06B6D4" } },
    });

    const maxPw = Math.max(1, ...rows.map((r: any) => r.passwords.length));

    const headers = ["#", "Email"];
    for (let i = 0; i < maxPw; i++) {
      headers.push(i === 0 ? "Password" : `Password${i + 1}`);
    }
    headers.push("Overall", "Batch", "Sites", "Last Updated");

    const headerRow = sheet.addRow(headers);
    headerRow.eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.border = {
        bottom: { style: "thin", color: { argb: "FF06B6D4" } },
      };
      cell.alignment = { vertical: "middle" };
    });

    sheet.getColumn(1).width = 5;
    sheet.getColumn(2).width = 35;
    for (let i = 0; i < maxPw; i++) {
      sheet.getColumn(3 + i).width = 20;
    }
    sheet.getColumn(3 + maxPw).width = 15;
    sheet.getColumn(4 + maxPw).width = 10;
    sheet.getColumn(5 + maxPw).width = 30;
    sheet.getColumn(6 + maxPw).width = 20;

    sheet.views = [{ state: "frozen", ySplit: 1 }];

    rows.forEach((r: any, idx: number) => {
      const rowData: (string | number)[] = [idx + 1, r.email];

      for (let i = 0; i < maxPw; i++) {
        rowData.push(r.passwords[i] || "");
      }

      rowData.push(r.overallOutcome.toUpperCase());

      const totalBatches = Math.ceil(r.passwords.length / 3);
      rowData.push(`${r.currentBatch + 1}/${totalBatches}`);

      const siteSummary = Object.entries(r.sites)
        .map(([name, s]: any) => `${name}: ${s.outcome}`)
        .join(" | ");
      rowData.push(siteSummary);

      const lastTime = Object.values(r.sites)
        .map((s: any) => s.timestamp || "")
        .filter(t => t)
        .sort()
        .pop();
      rowData.push(lastTime ? new Date(lastTime as string).toLocaleString() : "—");

      const dataRow = sheet.addRow(rowData);

      const emailCell = dataRow.getCell(2);
      emailCell.font = { name: "Consolas", size: 10, color: { argb: "FFFFFFFF" } };

      for (let i = 0; i < maxPw; i++) {
        const cell = dataRow.getCell(3 + i);
        const pw = r.passwords[i];
        if (!pw || pw.length === 0) continue;

        const outcome = getPasswordOutcome(
          i,
          r.passwords,
          r.sites,
          r.currentBatch,
          r.passwordResults
        );

        if (outcome && outcome !== "queued" && outcome !== "") {
          const fill = getCellFill(outcome);
          const font = getCellFont(outcome);
          if (fill) cell.fill = fill;
          cell.font = { ...font, name: "Consolas" };
        } else {
          cell.font = { name: "Consolas", size: 10, color: { argb: "FFD1D5DB" } };
        }
      }

      const overallCell = dataRow.getCell(3 + maxPw);
      const overallFill = getCellFill(r.overallOutcome);
      if (overallFill) {
        overallCell.fill = overallFill;
        overallCell.font = { ...getCellFont(r.overallOutcome), bold: true };
      }

      if (idx % 2 === 0) {
        dataRow.eachCell((cell) => {
          if (!cell.fill || (cell.fill as any).pattern === "none") {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FF0A0F1A" },
            };
          }
        });
      }
    });

    const legend = workbook.addWorksheet("Legend", {
      properties: { tabColor: { argb: "FF10B981" } },
    });
    legend.getColumn(1).width = 20;
    legend.getColumn(2).width = 40;
    const legendData = [
      ["Color", "Meaning"],
      ["GREEN", "✓ Correct password / Success"],
      ["RED", "✗ Incorrect password / Failed"],
      ["ORANGE", "⏸ Temporarily disabled (1hr cooldown)"],
      ["DARK RED", "🚫 Permanently disabled"],
      ["PURPLE", "🛡 Blocked"],
      ["YELLOW", "🔐 2FA required"],
      ["GRAY", "👻 No account found"],
      ["BLUE", "⏳ Currently testing"],
      ["NO FILL", "📋 Queued / not yet tested"],
    ];
    legendData.forEach(([color, meaning], i) => {
      const row = legend.addRow([color, meaning]);
      if (i === 0) {
        row.eachCell(c => { c.font = HEADER_FONT; c.fill = HEADER_FILL; });
      } else {
        const colorMap: any = { GREEN: "success", RED: "incorrect", ORANGE: "tempdisabled", "DARK RED": "permdisabled", PURPLE: "blocked", YELLOW: "2FA", GRAY: "noaccount", BLUE: "testing" };
        const key = colorMap[color as string];
        if (key) {
          const fill = getCellFill(key);
          if (fill) row.getCell(1).fill = fill;
          row.getCell(1).font = getCellFont(key);
        }
      }
    });

    await workbook.xlsx.writeFile(outputPath);
    parentPort?.postMessage({ status: "done" });
  } catch (err: unknown) {
    parentPort?.postMessage({ status: "error", message: (err instanceof Error ? err.message : String(err)) });
  }
});