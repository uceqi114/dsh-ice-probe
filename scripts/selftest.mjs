import { runSelfTest } from "../lib/core.js";

const result = runSelfTest();
for (const testCase of result.cases) {
  console.log(`${testCase.pass ? "PASS" : "FAIL"}  ${testCase.name}`);
  if (!testCase.pass) {
    console.log(`      expected ${testCase.want} insertion(s), got ${testCase.inserted}`);
    console.log(`      input:  ${JSON.stringify(testCase.input)}`);
    console.log(`      output: ${JSON.stringify(testCase.output)}`);
  }
}

console.log(`\ncore ${result.version}: ${result.pass ? "all tests passed" : "FAILED"}`);
process.exit(result.pass ? 0 : 1);
