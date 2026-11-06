// Run by CI. Prints the Built With list, or what stopped being true.
import { readRepo } from "./claimsFiles";
import { builtWith, checkClaims, CLAIMS } from "./claims";

const problems = checkClaims(CLAIMS, readRepo());
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`Built With: ${builtWith(CLAIMS).join(", ")}`);
