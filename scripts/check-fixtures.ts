import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FinalResponseSchema, MarketSnapshotSchema } from "../src/lib/contracts";

const fixtures = [
  { name: "normal", schema: FinalResponseSchema },
  { name: "insufficient_data", schema: FinalResponseSchema },
  { name: "market_normal", schema: MarketSnapshotSchema },
  { name: "market_insufficient_data", schema: MarketSnapshotSchema },
];
let failed = false;

for (const { name, schema } of fixtures) {
  const path = join("src", "fixtures", `${name}.json`);
  const parsed = schema.safeParse(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
  if (parsed.success) {
    console.log(`ok   ${path}`);
  } else {
    failed = true;
    console.error(`FAIL ${path}`);
    console.error(JSON.stringify(parsed.error.issues, null, 2));
  }
}

process.exit(failed ? 1 : 0);
