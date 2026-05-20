import { config } from "dotenv";
config();
import { calculateEta } from "./src/services/truck.service";

async function run() {
  const eta = await calculateEta(24.8, 120.95);
  console.log(eta);
}
run();
