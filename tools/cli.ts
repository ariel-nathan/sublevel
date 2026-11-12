/** Minimal command-line parsing shared by the tools. */

export interface ParsedArgs {
  /** Options given as `--name value` (or `--name` alone, stored as "true"). */
  options: Map<string, string>;
  /** Arguments that are not options, in order. */
  positional: string[];
}

/**
 * Parses `--name value` options and positional arguments. Names listed in
 * `flags` take no value. `--name=value` also works.
 */
export function parseArgs(
  argv: readonly string[],
  flags: readonly string[] = [],
): ParsedArgs {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      options.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (flags.includes(arg.slice(2))) {
      options.set(arg.slice(2), "true");
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`option ${arg} needs a value`);
      }
      options.set(arg.slice(2), value);
      i++;
    }
  }
  return { options, positional };
}

export function numberOption(
  args: ParsedArgs,
  name: string,
  fallback: number,
): number {
  const raw = args.options.get(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`option --${name} must be a number, got "${raw}"`);
  }
  return value;
}
