import { fetchAllStops } from "./src/services/truck.service";
async function run() {
  const data = await fetchAllStops();
  if (data && data.cleanPoint) {
    const x = data.cleanPoint.filter(p => p.district === "3");
    console.log(x.slice(0, 3).map(p => ({ n: p.pointName, t: p.trashDay, r: p.recycleDay })));
  }
}
run();
