import fetch from "node-fetch";
async function run() {
  const res = await fetch("https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getRouteData", {
    headers: { "Referer": "https://7966.hccg.gov.tw/WEB/cleanPoint.html" }
  });
  const json = await res.json();
  const xiangshanRoutes = json.data.route.slice(0,5);
  console.log(xiangshanRoutes.map(r => ({ r: r.routeId, t: r.trashDay, rc: r.recycleDay })));
}
run();
