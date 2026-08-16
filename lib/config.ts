/**
 * ค่าที่แก้บ่อยทั้งหมดรวมอยู่ในไฟล์นี้ไฟล์เดียว
 * ห้าม hardcode ข้อความ / เบอร์ / เลขบัญชี กระจายในโค้ดไฟล์อื่น
 *
 * หมายเหตุ: ราคา โปรโมชั่น ที่ตั้งร้าน เลขบัญชี ไม่อยู่ในไฟล์นี้
 * ข้อมูลพวกนั้นอยู่ใน Google Sheet เท่านั้น (ดู lib/sheet.ts)
 */

export const BRAND_NAME = 'Keep Me Around';

// ── เวลาทำการ ────────────────────────────────────────────────
// จ.–ส. 9:30–18:00 เวลาไทย (อาทิตย์ปิด)
export const BUSINESS_HOURS = {
  timeZone: 'Asia/Bangkok',
  /** 0 = อาทิตย์, 1 = จันทร์, ... 6 = เสาร์ */
  openDays: [1, 2, 3, 4, 5, 6],
  /** นาทีนับจากเที่ยงคืน: 9 * 60 + 30 = 09:30 */
  openMinute: 9 * 60 + 30,
  /** 18 * 60 = 18:00 */
  closeMinute: 18 * 60,
} as const;

// ── ข้อความ default 2 แบบ ────────────────────────────────────
// โค้ดเป็นคนเลือกว่าจะใช้อันไหน ไม่ใช่ AI (AI ไม่รู้เวลาปัจจุบัน)
export const DEFAULT_REPLY_IN_HOURS =
  'เรื่องนี้แอดมินขอตรวจสอบข้อมูลเพิ่มเติมก่อนนะคะ เดี๋ยวติดต่อกลับให้เร็วที่สุดเลยค่ะ ✨';

export const DEFAULT_REPLY_OUT_OF_HOURS =
  'ข้อความนี้เป็นคำตอบจากระบบอัตโนมัติค่ะ เรื่องนี้ขอให้แอดมินตัวจริงมาตอบอีกครั้งในเวลาทำการนะคะ ขอบคุณที่รอค่ะ 🙏';

// ── โมเดล ────────────────────────────────────────────────────
// ถ้ายิงจริงแล้วขึ้น 404 model not found ให้แก้ชื่อรุ่นที่บรรทัดนี้บรรทัดเดียว
// (หรือ set env GEMINI_MODEL เพื่อ override โดยไม่ต้องแก้โค้ด)
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

/**
 * ไม่มี temperature / top_p / top_k อีกแล้ว
 * Google ถอดพารามิเตอร์กลุ่มนี้ออกจากรุ่น 3.5/3.7 (ยืนยันจาก type GenerationConfig ของ SDK 2.x)
 * ถ้าใส่เข้าไปจะ error — คุมโทนคำตอบด้วย prompt ใน lib/gemini.ts แทน
 */

/** ระดับการคิดก่อนตอบ: minimal | low | medium | high — งาน FAQ ใช้ low พอ เร็วและถูก */
export const GEMINI_THINKING_LEVEL = 'low';

/**
 * เผื่อไว้เยอะเพราะโมเดลกิน token ไปกับ thinking ก่อนตอบ
 * ถ้าตั้งต่ำเกินจะได้ status = incomplete แล้วบอทตอบ default ตลอด
 */
export const GEMINI_MAX_OUTPUT_TOKENS = 2048;

/**
 * false = ไม่ให้ Google เก็บบทสนทนาไว้ฝั่งเซิร์ฟเวอร์
 * ค่าเริ่มต้นของ Interactions API คือเก็บ (55 วันสำหรับบัญชีเสียเงิน / 1 วันสำหรับบัญชีฟรี)
 * ร้านนี้คุยกับลูกค้าจริง จึงปิดทิ้ง เราไม่ได้ใช้ previous_interaction_id หรือ background อยู่แล้ว
 */
export const GEMINI_STORE = false;

// ── timeout / cache ──────────────────────────────────────────
/** ดึง CSV จาก Sheet ไม่เกิน 5 วิ */
export const SHEET_TIMEOUT_MS = 5_000;

/** cache CSV 60 วิ แก้ Sheet แล้วรอไม่เกิน 1 นาทีก็มีผล */
export const SHEET_CACHE_TTL_MS = 60_000;

/** เรียก Gemini ไม่เกิน 8 วิ (รวมทั้ง route ต้องจบใน maxDuration = 15) */
export const GEMINI_TIMEOUT_MS = 8_000;

/** ตัดข้อความลูกค้าที่ยาวผิดปกติ กัน token บานและกัน prompt ยัดไส้ */
export const MAX_USER_MESSAGE_CHARS = 1_000;

// ── ตัวช่วยเรื่องเวลา ────────────────────────────────────────

/**
 * เช็กว่าตอนนี้อยู่ในเวลาทำการไหม
 *
 * สำคัญ: Vercel รันเป็น UTC ห้ามใช้ new Date().getHours() ตรง ๆ
 * ต้องแปลงเป็นเวลาไทยด้วย Intl.DateTimeFormat ก่อนเทียบเสมอ
 */
export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_HOURS.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const day = weekdayMap[get('weekday')];
  if (day === undefined) return false;
  if (!(BUSINESS_HOURS.openDays as readonly number[]).includes(day)) return false;

  const minuteOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  if (!Number.isFinite(minuteOfDay)) return false;

  return (
    minuteOfDay >= BUSINESS_HOURS.openMinute &&
    minuteOfDay < BUSINESS_HOURS.closeMinute
  );
}

/** เลือกข้อความ default ตามเวลาไทย ณ ตอนนั้น */
export function getDefaultReply(now: Date = new Date()): string {
  return isWithinBusinessHours(now)
    ? DEFAULT_REPLY_IN_HOURS
    : DEFAULT_REPLY_OUT_OF_HOURS;
}
