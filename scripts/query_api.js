async function run() {
  const url = "https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/getPointData?address=";
  const res = await fetch(url, { headers: { Referer: "https://7966.hccg.gov.tw/WEB/cleanPoint.html" } });
  const data = await res.json();
  console.log(data.data.cleanPoint.slice(0, 10).map(p => p.time));
}
run();
