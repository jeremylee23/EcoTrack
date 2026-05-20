import fetch from "node-fetch";

async function run() {
  const res = await fetch("https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getPointData?address=", {
    headers: { "Referer": "https://7966.hccg.gov.tw/WEB/cleanPoint.html" }
  });
  const json = await res.json();
  const xiangshan = json.data.cleanPoint.filter(p => p.district === "3");
  console.log(xiangshan.slice(0,3).map(p => ({ pointName: p.pointName, trashDay: p.trashDay, recycleDay: p.recycleDay, time: p.time })));
}
run();
