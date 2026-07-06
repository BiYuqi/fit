// ─────────────────────────────────────────────────────────────
// 时区：全 app "今天/几点/归属日" 一律钉死 APP_TZ（北京），不跟设备系统时区跑，
// 与后端 backend/src/lib/dates.ts 同口径。用户人在国外时也按北京记账。
// 用 Intl 按真实时区算（需 Hermes Intl，Expo SDK 56 默认带）。
// ⚠️ localDateStr 仍保留：仅用于"纯日历日期"格式化（如周数→周一/周日、
//    日期选择器里用户点的那天），这类 Date 本就按本地日历构造，不能再用时区二次解释。
// ─────────────────────────────────────────────────────────────
export const APP_TZ = 'Asia/Shanghai';

// 某个时刻在 APP_TZ 下的零件（date/时/分），与后端 tzParts 同实现
function appParts(instant: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant);
  const g = (t: string) => parts.find(p => p.type === t)!.value;
  const hour = g('hour') === '24' ? '00' : g('hour'); // 某些运行时午夜给 "24"
  return {
    year: +g('year'), month: +g('month'), day: +g('day'),
    hour: +hour, minute: g('minute'),
    ymd: `${g('year')}-${g('month')}-${g('day')}`,
  };
}

// APP_TZ 下的"今天"（也可传时刻）"YYYY-MM-DD"
export function appToday(instant: Date = new Date()): string {
  return appParts(instant).ymd;
}

// 在日历上给某个 "YYYY-MM-DD" 加减天数（纯日历运算，tz 无关）
export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

// 纯日历日期格式化（本地取值）：仅用于按本地日历构造出来的 Date，见文件头说明
export function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Normalize any date-ish string to "YYYY-MM-DD". Handles ISO timestamps from server. */
export function dateOnly(s: string): string {
  return s.slice(0, 10);
}

// WeChat-style chat timestamp（按 APP_TZ 北京时钟显示，不跟设备时区）
export function formatChatTime(isoStr: string): string {
  const msg = appParts(new Date(isoStr));
  const now = appParts(new Date());

  const hhmm = `${msg.hour}:${msg.minute}`;
  const diffDays = Math.round(
    (Date.UTC(now.year, now.month - 1, now.day) - Date.UTC(msg.year, msg.month - 1, msg.day)) / 86400000,
  );

  if (diffDays === 0) return hhmm;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  if (msg.year === now.year) {
    return `${msg.month}月${msg.day}日 ${hhmm}`;
  }
  return `${msg.year}年${msg.month}月${msg.day}日`;
}

/** Parse "YYYY-MM-DD" → Date at local noon (avoids DST/UTC edge cases) */
function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function formatDateLabel(date: string): string {
  const dateOnly = date.slice(0, 10); // handles both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS.mmmZ"
  const today = appToday();
  if (dateOnly === today) return '今天';
  if (dateOnly === addDays(today, -1)) return '昨天';

  const d = parseDateStr(dateOnly);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekdays[d.getDay()]}`;
}

// Show timestamp when gap between messages > 5 minutes
export const CHAT_TIME_GAP_MS = 5 * 60 * 1000;
