/**
 * Schedule formatting + no-service messaging helpers.
 * Goal: clearer than the official "今日無收運服務" banner, with next pickup.
 */

const DAY_NAMES = ["", "一", "二", "三", "四", "五", "六", "日"];

export function parseDayList(daysString: string | null | undefined): number[] {
  if (!daysString) return [];
  return daysString
    .split(",")
    .map((v) => parseInt(v, 10))
    .filter((n) => n >= 1 && n <= 7);
}

export function formatWeekSchedule(options: {
  stopName: string;
  scheduledTime: string | null;
  trashDays: string | null | undefined;
  recycleDays: string | null | undefined;
  historicalAvgTime?: string;
}): string {
  const trash = parseDayList(options.trashDays);
  const recycle = parseDayList(options.recycleDays);
  const time = options.scheduledTime ?? "未知";

  const trashText =
    trash.length > 0
      ? trash.map((d) => `週${DAY_NAMES[d]}`).join("、")
      : "無資料（常見為週一／二／四／五／六）";
  const recycleText =
    recycle.length > 0
      ? recycle.map((d) => `週${DAY_NAMES[d]}`).join("、")
      : "無固定回收日資料";

  const noWedNote =
    trash.length > 0 && !trash.includes(3)
      ? "\n⚠️ 此站通常「週三不收運」（與市府公告一致）"
      : "";

  return (
    `📅 本週清運班表（優於官方：一次看完＋下次提醒）\n` +
    `📍 ${options.stopName}\n` +
    `🕐 表定時段：${time}\n` +
    (options.historicalAvgTime
      ? `📊 歷史平均抵達：約 ${options.historicalAvgTime}\n`
      : "") +
    `🚛 垃圾車：${trashText}\n` +
    `♻️ 回收車：${recycleText}` +
    noWedNote +
    `\n\n💡 比官方多：靠近 5 分鐘會主動推播；也可傳「垃圾車」看即時 ETA。`
  );
}

export function buildNoServiceTodayMessage(options: {
  stopName: string;
  weekday: number; // 1=Mon..7=Sun
  nextGarbageDate?: string;
  nextRecycleDate?: string;
  reason?: string;
}): string {
  const dayLabel = DAY_NAMES[options.weekday] ?? "?";
  const nextGarbage = options.nextGarbageDate
    ? `\n🚛 下次垃圾車：${options.nextGarbageDate}`
    : "";
  const nextRecycle = options.nextRecycleDate
    ? `\n♻️ 下次回收車：${options.nextRecycleDate}`
    : "";

  return (
    `🚫 今日無收運服務（週${dayLabel}）\n` +
    `📍 ${options.stopName}\n` +
    (options.reason ? `${options.reason}\n` : "") +
    `官方網頁只會跳出「今日無收運服務」；我們多給你下次時間：` +
    `${nextGarbage}${nextRecycle}\n\n` +
    `💡 傳「班表」可看整週；傳「垃圾車」可在有班日追即時位置。`
  );
}
