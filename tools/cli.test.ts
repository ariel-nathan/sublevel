import { expect, test } from "bun:test";
import { numberOption, parseArgs } from "./cli";

test("parseArgs splits options and positionals", () => {
  const args = parseArgs(["a.json", "--every", "10", "--view=material", "b"]);
  expect(args.positional).toEqual(["a.json", "b"]);
  expect(args.options.get("every")).toBe("10");
  expect(args.options.get("view")).toBe("material");
  expect(numberOption(args, "every", 30)).toBe(10);
  expect(numberOption(args, "from", 0)).toBe(0);
});

test("parseArgs handles flags and missing values", () => {
  const args = parseArgs(["--page", "x"], ["page"]);
  expect(args.options.get("page")).toBe("true");
  expect(args.positional).toEqual(["x"]);
  expect(() => parseArgs(["--out"])).toThrow();
});
