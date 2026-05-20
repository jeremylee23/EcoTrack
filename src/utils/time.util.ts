export function getNextScheduledArrival(
  daysString: string | null, // e.g., "1,2,4,5,6" (1=Mon, 7=Sun)
  scheduledTime: string | null, // e.g., "18:30"
  hasPassedToday: boolean = false,
  defaultDays?: number[]
): { dateStr: string; isToday: boolean } | null {
  if (!daysString || !scheduledTime) return null;

  let validDays = daysString.split(",").map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 7);
  if (validDays.length === 0) {
    if (defaultDays && defaultDays.length > 0) {
      validDays = defaultDays;
    } else {
      return null;
    }
  }

  const [hours, minutes] = scheduledTime.split(":").map(Number);
  if (isNaN(hours) || isNaN(minutes)) return null;

  const now = new Date();
  // Adjust to Taiwan time (UTC+8)
  const taiwanTime = new Date(now.getTime() + 8 * 3600000);
  
  // getUTCDay() on taiwanTime works as local day if we treat UTC methods as local
  let currentDay = taiwanTime.getUTCDay();
  if (currentDay === 0) currentDay = 7; // Convert Sunday(0) to 7

  const currentMinutes = taiwanTime.getUTCHours() * 60 + taiwanTime.getUTCMinutes();
  const scheduledMinutes = hours * 60 + minutes;

  const dayNames = ["", "一", "二", "三", "四", "五", "六", "日"];

  for (let offset = 0; offset <= 7; offset++) {
    let checkDay = currentDay + offset;
    if (checkDay > 7) checkDay -= 7;

    if (validDays.includes(checkDay)) {
      if (offset === 0) {
        // Today is a valid day
        if (hasPassedToday) {
          // Already passed, so skip to next valid day
          continue;
        }
        
        // If we haven't officially passed it via GPS sequence, check time buffer
        // Let's say if it's 60+ minutes past scheduled time and no GPS, it's considered passed.
        // We'll let the caller pass `hasPassedToday` if GPS sequence is past.
        // But if caller didn't pass true, we check strict time.
        if (currentMinutes > scheduledMinutes + 60) {
          // Too late today
          continue;
        }
        
        return {
          dateStr: `今日 ${scheduledTime}`,
          isToday: true
        };
      }

      // Found a future day
      const targetDate = new Date(taiwanTime.getTime() + offset * 24 * 3600000);
      const mm = (targetDate.getUTCMonth() + 1).toString().padStart(2, "0");
      const dd = targetDate.getUTCDate().toString().padStart(2, "0");
      
      return {
        dateStr: `${mm}/${dd}(${dayNames[checkDay]}) ${scheduledTime}`,
        isToday: false
      };
    }
  }

  return null;
}
