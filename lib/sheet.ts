/**
 * ดึง FAQ จาก Google Sheet (published CSV) + cache
 *
 * schema ที่ Sheet ต้องมี (แถวแรกเป็นหัวตาราง):
 *   A category | B question | C answer | D keywords
 *
 * 1 แถว = 1 เรื่อง · ไม่อยากให้บอทตอบเรื่องไหน ลบแถวนั้นออก
 */

import { SHEET_CACHE_TTL_MS, SHEET_TIMEOUT_MS } from './config';

type CacheEntry = { csv: string; fetchedAt: number };

/**
 * cache อยู่ในหน่วยความจำของ instance
 * Vercel อาจมีหลาย instance ต่างคนต่าง cache ซึ่งไม่เป็นไร
 * แต่ละ instance แค่ดึง Sheet เองรอบละไม่เกิน 1 ครั้งต่อ 60 วิ
 */
let cache: CacheEntry | null = null;

export type FaqResult = {
  /** null = ดึงไม่ได้และไม่มี cache เก่าให้ใช้ */
  csv: string | null;
  /** true = Sheet ล่ม กำลังใช้ cache เก่าที่หมดอายุแล้ว */
  stale: boolean;
};

/**
 * คืน CSV ดิบ ๆ ทั้งก้อนให้ Gemini อ่านเอง
 * ไม่ต้อง parse เป็น object เพราะโมเดลอ่าน CSV ได้อยู่แล้ว
 * และการส่งทั้งตารางทำให้มันเลือกแถวที่ตรงคำถามได้ดีกว่าเรา filter เอง
 */
export async function getFaqCsv(): Promise<FaqResult> {
  // รับได้ 2 ชื่อ กันพลาดเรื่องตั้งชื่อ env ไม่ตรงกับที่โค้ดอ่าน
  const url = process.env.FAQ_SHEET_CSV_URL || process.env.SHEET_CSV_URL;
  if (!url) {
    console.error('[sheet] ไม่ได้ตั้งค่า FAQ_SHEET_CSV_URL (หรือ SHEET_CSV_URL)');
    return { csv: null, stale: false };
  }

  const now = Date.now();
  if (cache && now - cache.fetchedAt < SHEET_CACHE_TTL_MS) {
    return { csv: cache.csv, stale: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEET_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // ต้อง bypass cache ของ Next ไม่งั้นแก้ Sheet แล้วไม่อัปเดต
      cache: 'no-store',
    });

    if (!res.ok) {
      // 401/403 = ชีตยังเป็นส่วนตัว · 404 = URL ผิดหรือยังไม่ได้ publish
      const hint =
        res.status === 401 || res.status === 403
          ? ' (ชีตยังไม่เปิดสิทธิ์ให้คนนอกอ่าน)'
          : res.status === 404
            ? ' (URL ผิด หรือชีตยังไม่ได้ publish)'
            : '';
      throw new Error(`HTTP ${res.status}${hint}`);
    }

    const csv = (await res.text()).trim();
    if (!csv) {
      throw new Error('CSV ว่างเปล่า');
    }

    // ถ้าใส่ลิงก์ /edit จาก address bar จะได้หน้าเว็บ HTML กลับมา ไม่ใช่ข้อมูล
    // ต้องดักไว้ ไม่งั้นจะ cache HTML ไว้แล้วส่งให้ Gemini อ่านเป็น FAQ
    if (/^\s*<(!doctype|html)/i.test(csv)) {
      throw new Error(
        'ได้ HTML ไม่ใช่ CSV — ต้องใช้ลิงก์ที่ลงท้ายด้วย output=csv หรือ export?format=csv',
      );
    }

    cache = { csv, fetchedAt: now };
    return { csv, stale: false };
  } catch (err) {
    // Sheet ล่ม → ถ้ามี cache เก่าใช้ต่อได้เลย ไม่มีวันหมดอายุ
    // ข้อมูลเก่าดีกว่าไม่มีข้อมูล (ไม่มีข้อมูล = ตอบ default ทุกคำถาม)
    if (cache) {
      console.error(
        `[sheet] ดึง Sheet ไม่สำเร็จ ใช้ cache เก่าแทน (อายุ ${Math.round(
          (now - cache.fetchedAt) / 1000,
        )} วิ):`,
        err instanceof Error ? err.message : err,
      );
      return { csv: cache.csv, stale: true };
    }

    console.error(
      '[sheet] ดึง Sheet ไม่สำเร็จ และไม่มี cache เก่า:',
      err instanceof Error ? err.message : err,
    );
    return { csv: null, stale: false };
  } finally {
    clearTimeout(timer);
  }
}
