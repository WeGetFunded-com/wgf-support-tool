import chalk from "chalk";

const p = chalk.hex("#7C3AED");
const w = chalk.white.bold;
const dim = chalk.gray;

const isWindows = process.platform === "win32";
const ICO = {
  ok:   isWindows ? "[OK]"   : "\u2713",
  fail: isWindows ? "[ERR]"  : "\u2717",
  info: isWindows ? "[i]"    : "\u2139",
  warn: isWindows ? "[!]"    : "\u26A0",
  line: isWindows ? "-".repeat(39) : "\u2500".repeat(39),
};

export function banner(): void {
  console.log("");
  console.log(p("         /\\    /\\"));
  console.log(p("        /  \\  /  \\"));
  console.log(p("       /    \\/    \\"));
  console.log(p("       \\    /\\    /"));
  console.log(p("        \\  /  \\  /"));
  console.log(p("         \\/    \\/"));
  console.log(p("          \\    /"));
  console.log(p("           \\  /"));
  console.log(p("            \\/"));
  console.log("");
  console.log(
    "       " + w("WE ") + p("GET ") + w("FUNDED.")
  );
  console.log("");
  console.log(dim("   " + ICO.line));
  console.log("   " + dim("Support Shell v1.0"));
  console.log(
    "   " + dim("By 6real - le CTO qui vous veut du bien")
  );
  console.log(dim("   " + ICO.line));
  console.log("");
}

export function success(message: string): void {
  console.log(chalk.green(`  ${ICO.ok} ${message}`));
}

export function error(message: string): void {
  console.log(chalk.red(`  ${ICO.fail} ${message}`));
}

export function info(message: string): void {
  console.log(chalk.blue(`  ${ICO.info} ${message}`));
}

export function warn(message: string): void {
  console.log(chalk.yellow(`  ${ICO.warn} ${message}`));
}

export function separator(): void {
  console.log(chalk.gray("  " + ICO.line));
}

export function productionWarning(): void {
  const r = chalk.red.bold;
  const y = chalk.yellow.bold;
  const d = chalk.red;
  console.log("");
  console.log(r("  ┌─────────────────────────────────────────────┐"));
  console.log(r("  │                                             │"));
  console.log(r("  │") + y("     /!\\  ATTENTION — PRODUCTION  /!\\      ") + r("│"));
  console.log(r("  │                                             │"));
  console.log(r("  │") + d("   Vous allez vous connecter a la base      ") + r("│"));
  console.log(r("  │") + d("   de donnees de PRODUCTION.                ") + r("│"));
  console.log(r("  │") + d("   Ce sont les donnees REELLES des clients. ") + r("│"));
  console.log(r("  │                                             │"));
  console.log(r("  │") + d("   Toute action est irreversible.           ") + r("│"));
  console.log(r("  │                                             │"));
  console.log(r("  └─────────────────────────────────────────────┘"));
  console.log("");
}
