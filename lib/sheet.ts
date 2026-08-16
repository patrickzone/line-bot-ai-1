/**
 * ดึง FAQ จาก Google Sheet (published CSV) ทุกแผ่น + cache
 *
 * สเปรดชีตมีหลายแผ่น (tab) แต่ลิงก์ pub?output=csv จะได้มาแค่แผ่นแรกแผ่นเดียว
 * ไฟล์นี้จึงอ่านรายชื่อแผ่นทั้งหมดจากหน้า pubhtml แล้วดึงมาต่อกันให้ครบ
 * สร้างแผ่นใหม่เพิ่มเมื่อไหร่ก็ถูกดึงมาเองโดยไม่ต้องแก้โค้ดหรือแก้ env
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

function looksLikeHtml(text: string): boolean {
  return /^\s*<(!doctype|html)/i.test(text);
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, cache: 'no-store' });
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
  return (await res.text()).trim();
}

/**
 * แยกส่วนหน้าของลิงก์ publish ออกมา
 * เช่น https://docs.google.com/spreadsheets/d/e/2PACX-xxx/pub?output=csv
 *   -> https://docs.google.com/spreadsheets/d/e/2PACX-xxx
 * คืน null ถ้าไม่ใช่ลิงก์ publish รูปแบบนี้ (จะได้ข้ามการค้นหาแผ่นไป)
 */
function publishedBaseUrl(url: string): string | null {
  const m = url.match(/^(https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^/]+)\/pub/);
  return m ? m[1] : null;
}

/**
 * อ่านรายชื่อแผ่นทั้งหมดจากหน้า pubhtml
 * หน้านั้นฝัง javascript ไว้เป็นชุด items.push({name: "...", ... gid: "..."})
 */
async function discoverTabs(
  base: string,
  signal: AbortSignal,
): Promise<Array<{ name: string; gid: string }>> {
  const html = await fetchText(`${base}/pubhtml`, signal);
  const tabs: Array<{ name: string; gid: string }> = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?gid:\s*"(\d+)"/g)) {
    const gid = m[2];
    if (seen.has(gid)) continue;
    seen.add(gid);
    const name = m[1]
      .replace(/\\x26/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"');
    tabs.push({ name, gid });
  }
  return tabs;
}

/**
 * คืน CSV ของทุกแผ่นต่อกัน พร้อมหัวข้อบอกว่าแต่ละก้อนมาจากแผ่นไหน
 * ไม่ parse เป็น object เพราะโมเดลอ่าน CSV ได้อยู่แล้ว
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

  // deadline เดียวคุมทั้งงาน ทั้งหา pubhtml และดึง csv ทุกแผ่น
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEET_TIMEOUT_MS);

  try {
    const base = publishedBaseUrl(url);
    let csv: string;

    if (base) {
      const tabs = await discoverTabs(base, controller.signal);

      if (tabs.length === 0) {
        // หาแผ่นไม่เจอ ถอยไปใช้ลิงก์ที่ตั้งไว้ตรง ๆ
        console.warn('[sheet] อ่านรายชื่อแผ่นไม่ได้ ใช้ลิงก์เดิมแผ่นเดียว');
        csv = await fetchText(url, controller.signal);
      } else {
        const parts = await Promise.all(
          tabs.map(async (tab) => {
            const text = await fetchText(
              `${base}/pub?gid=${tab.gid}&single=true&output=csv`,
              controller.signal,
            );
            return `### แผ่น: ${tab.name}\n${text}`;
          }),
        );
        csv = parts.join('\n\n');
        // ดูขนาดไว้ด้วย ยิ่งเพิ่มแผ่น prompt ยิ่งใหญ่ ค่าใช้จ่ายและเวลาตอบก็เพิ่มตาม
        console.log(
          `[sheet] ดึงครบ ${tabs.length} แผ่น (${Math.round(csv.length / 1024)} KB): ` +
            tabs.map((t) => t.name).join(', '),
        );
      }
    } else {
      // ไม่ใช่ลิงก์ publish (เช่น export?format=csv) ดึงตรง ๆ แผ่นเดียว
      csv = await fetchText(url, controller.signal);
    }

    if (!csv) {
      throw new Error('CSV ว่างเปล่า');
    }

    // ถ้าใส่ลิงก์ /edit จาก address bar จะได้หน้าเว็บ HTML กลับมา ไม่ใช่ข้อมูล
    // ต้องดักไว้ ไม่งั้นจะ cache HTML ไว้แล้วส่งให้ Gemini อ่านเป็น FAQ
    if (looksLikeHtml(csv)) {
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
