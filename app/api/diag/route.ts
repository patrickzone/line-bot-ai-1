/**
 * ตัวตรวจสุขภาพระบบ — ไว้หาว่าบอทตอบ default เพราะอะไร
 *
 * เปิดใช้เมื่อจำเป็นเท่านั้น: ต้อง set env DIAG_TOKEN ก่อน
 * ถ้าไม่ได้ set จะคืน 404 เหมือนไม่มี route นี้อยู่
 * เรียกด้วย /api/diag?token=<DIAG_TOKEN>
 *
 * ไม่คืนค่า env ใด ๆ ออกมา บอกแค่ว่า "ตั้งค่าแล้ว/ยัง" (ไม่บอกแม้แต่ความยาว)
 * และผลลัพธ์ทั้งก้อนถูกกวาดด้วย scrubSecrets() ก่อนส่งออกเสมอ
 * ลบไฟล์นี้ทิ้งได้เมื่อแก้ปัญหาจบแล้ว
 */

import { GoogleGenAI } from '@google/genai';
import {
  GEMINI_MODEL,
  GEMINI_STORE,
  GEMINI_THINKING_LEVEL,
  isWithinBusinessHours,
} from '@/lib/config';
import { getFaqCsv } from '@/lib/sheet';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/** บอกแค่ว่ามีค่าหรือไม่มี ไม่บอกค่า ไม่บอกความยาว */
function describeEnv(name: string) {
  return { set: Boolean(process.env[name]) };
}

/**
 * กันตาย: กวาดผลลัพธ์ทั้งก้อนก่อนส่งออก
 * ถ้ามีค่าจาก env โผล่ในข้อความ error ของ Google หรือที่ไหนก็ตาม ให้ทับด้วย [REDACTED]
 * ตรงนี้ทำให้ "ห้ามเผย env" เป็นสิ่งที่โค้ดบังคับ ไม่ใช่แค่ความตั้งใจ
 */
function scrubSecrets(payload: unknown): unknown {
  const secrets = [
    process.env.LINE_CHANNEL_SECRET,
    process.env.LINE_CHANNEL_ACCESS_TOKEN,
    process.env.GEMINI_API_KEY,
    process.env.FAQ_SHEET_CSV_URL,
    process.env.DIAG_TOKEN,
  ].filter((v): v is string => typeof v === 'string' && v.length >= 8);

  let json = JSON.stringify(payload);
  for (const secret of secrets) {
    json = json.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  }
  return JSON.parse(json);
}

export async function GET(req: Request) {
  const expected = process.env.DIAG_TOKEN;
  const given = new URL(req.url).searchParams.get('token');

  if (!expected || given !== expected) {
    return new Response('Not Found', { status: 404 });
  }

  const now = new Date();

  // 1) env ครบไหม
  const env = {
    LINE_CHANNEL_SECRET: describeEnv('LINE_CHANNEL_SECRET'),
    LINE_CHANNEL_ACCESS_TOKEN: describeEnv('LINE_CHANNEL_ACCESS_TOKEN'),
    GEMINI_API_KEY: describeEnv('GEMINI_API_KEY'),
    FAQ_SHEET_CSV_URL: describeEnv('FAQ_SHEET_CSV_URL'),
  };

  // 2) Sheet ดึงได้ไหม หน้าตาถูกไหม
  let sheet: Record<string, unknown>;
  try {
    const { csv, stale } = await getFaqCsv();
    if (!csv) {
      sheet = { ok: false, reason: 'ดึง CSV ไม่ได้ หรือ FAQ_SHEET_CSV_URL ไม่ได้ตั้งค่า' };
    } else {
      const lines = csv.split('\n').filter((l) => l.trim());
      const header = lines[0] ?? '';
      // ถ้า publish ผิดแบบ จะได้ HTML กลับมาแทน CSV
      const looksLikeHtml = /^\s*<(!doctype|html)/i.test(csv);
      sheet = {
        ok: !looksLikeHtml && lines.length > 1,
        stale,
        looksLikeHtml,
        rowCount: Math.max(0, lines.length - 1),
        header,
        hint: looksLikeHtml
          ? 'ได้ HTML ไม่ใช่ CSV — ลิงก์ต้องมาจาก Publish to web แล้วเลือก .csv'
          : lines.length <= 1
            ? 'มีแต่หัวตาราง ไม่มีข้อมูลสักแถว'
            : undefined,
      };
    }
  } catch (err) {
    sheet = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 3) ยิง Gemini จริงด้วย SDK และรุ่นเดียวกับที่บอทใช้ ผลตรวจจะได้ตรงกับของจริง
  let gemini: Record<string, unknown>;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    gemini = { ok: false, reason: 'GEMINI_API_KEY ไม่ได้ตั้งค่า' };
  } else {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const interaction = await ai.interactions.create({
        model: GEMINI_MODEL,
        input: 'ตอบกลับด้วยคำว่า ok เท่านั้น',
        store: GEMINI_STORE,
        generation_config: { thinking_level: GEMINI_THINKING_LEVEL },
      });
      gemini = {
        ok: interaction.status === 'completed',
        configuredModel: GEMINI_MODEL,
        status: interaction.status,
        replyPreview: interaction.output_text?.slice(0, 40) ?? null,
        errors: interaction.errors?.map((e) => e.message) ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      gemini = {
        ok: false,
        configuredModel: GEMINI_MODEL,
        error: message,
        hint: /404|not found/i.test(message)
          ? `ไม่มีรุ่นชื่อ "${GEMINI_MODEL}" — แก้ GEMINI_MODEL ใน lib/config.ts`
          : /429|quota|exceeded/i.test(message)
            ? 'โควต้าเต็ม'
            : /401|403|API key/i.test(message)
              ? 'API key ไม่ถูกต้องหรือยังไม่ได้เปิดสิทธิ์'
              : undefined,
      };
    }
  }

  return Response.json(
    scrubSecrets({
      thaiTime: new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(now),
      withinBusinessHours: isWithinBusinessHours(now),
      env,
      sheet,
      gemini,
    }),
    { headers: { 'cache-control': 'no-store' } },
  );
}
