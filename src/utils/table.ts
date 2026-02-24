import chalk from "chalk";

const p = chalk.hex("#7C3AED");

export function renderKeyValue(data: Record<string, string>, indent = 4): void {
  const maxKeyLen = Math.max(...Object.keys(data).map((k) => k.length));
  for (const [key, value] of Object.entries(data)) {
    const paddedKey = key.padEnd(maxKeyLen);
    console.log(`${" ".repeat(indent)}${p(paddedKey)}  ${chalk.white(value)}`);
  }
}

export function renderTable(headers: string[], rows: string[][], indent = 4): void {
  if (rows.length === 0) {
    console.log(`${" ".repeat(indent)}${chalk.gray("Aucun resultat.")}`);
    return;
  }

  const colWidths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, (row[i] || "").length), 0);
    return Math.max(h.length, maxData);
  });

  const pad = " ".repeat(indent);
  const sep = chalk.gray(
    `${pad}${"+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+"}`
  );

  const headerRow =
    pad +
    "|" +
    headers.map((h, i) => ` ${p(h.padEnd(colWidths[i]))} `).join("|") +
    "|";

  console.log(sep);
  console.log(headerRow);
  console.log(sep);

  for (const row of rows) {
    const line =
      pad +
      "|" +
      row.map((cell, i) => ` ${chalk.white((cell || "").padEnd(colWidths[i]))} `).join("|") +
      "|";
    console.log(line);
  }

  console.log(sep);
  console.log(`${pad}${chalk.gray(`${rows.length} resultat(s)`)}`);
}
