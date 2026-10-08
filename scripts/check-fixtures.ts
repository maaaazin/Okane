import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FinalResponseSchema } from "../src/lib/contracts";

const fixtureNames = ["normal", "insufficient_data"];
let failed = false;

for (const name of fixtureNames) {
  const path = join("src", "fixtures", `${name}.json`);
  const parsed = FinalResponseSchema.safeParse(
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
