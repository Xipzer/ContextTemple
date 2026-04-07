import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { DirectoryCreateError } from "./errors.ts";

export type TemplePaths = {
  homeDir: string;
  dbPath: string;
};

export function resolveTemplePaths({ homeDir }: { homeDir?: string } = {}): TemplePaths {
  const resolvedHome = homeDir ?? process.env.CONTEXTTEMPLE_HOME ?? path.join(os.homedir(), ".contexttemple");

  return {
    homeDir: resolvedHome,
    dbPath: path.join(resolvedHome, "contexttemple.db"),
  };
}

export async function ensureTempleHome({ homeDir }: { homeDir?: string } = {}) {
  const paths = resolveTemplePaths({ homeDir });

  const mkdirResult = await fs.mkdir(paths.homeDir, { recursive: true }).then(() => null).catch(
    (cause) => new DirectoryCreateError({ path: paths.homeDir, cause }),
  );
  if (mkdirResult instanceof Error) return mkdirResult;

  return paths;
}
