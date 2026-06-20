import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardDir = join(root, "dashboard");
const siteDir = join(root, "site");
const publicDir = join(root, "public");

function assertInsideRoot(target) {
  const rel = relative(root, resolve(target));
  if (rel.startsWith("..") || rel === "") throw new Error(`Unsafe asset path: ${target}`);
}

function copyDir(source, target) {
  assertInsideRoot(source);
  assertInsideRoot(target);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(target, entry);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

if (!existsSync(dashboardDir)) throw new Error(`Missing dashboard assets: ${dashboardDir}`);
if (!existsSync(siteDir)) throw new Error(`Missing site assets: ${siteDir}`);

assertInsideRoot(publicDir);
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });

copyDir(dashboardDir, publicDir);
copyDir(dashboardDir, join(publicDir, "bot"));
copyDir(siteDir, join(publicDir, "site"));

console.log("Built Cloudflare assets into public/");
