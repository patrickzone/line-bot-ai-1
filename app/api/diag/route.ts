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

import { GEMINI_MODEL, isWithinBusinessHours } from '@/lib/config';
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

  // 3) ชื่อรุ่นที่ตั้งไว้ ใช้ได้จริงไหม + มีรุ่นอะไรให้เลือกบ้าง
  let gemini: Record<string, unknown> = { ok: false, reason: 'ไม่ได้ทดสอบ' };
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    gemini = { ok: false, reason: 'GEMINI_API_KEY ไม่ได้ตั้งค่า' };
  } else {
    // ยิงคำถามสั้น ๆ ด้วยชื่อรุ่นที่ตั้งไว้ เพื่อดูว่า 404 ไหม
    let callResult: Record<string, unknown>;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          GEMINI_MODEL,
        )}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'ตอบว่า ok' }] }] }),
        },
      );
      const body = (await res.json()) as { error?: { message?: string } };
      callResult = res.ok
        ? { ok: true, status: res.status }
        : {
            ok: false,
            status: res.status,
            message: body?.error?.message ?? 'ไม่ทราบสาเหตุ',
            hint:
              res.status === 404
                ? `ไม่มีรุ่นชื่อ "${GEMINI_MODEL}" — เลือกจาก availableModels ด้านล่างแล้วแก้ GEMINI_MODEL`
                : res.status === 429
                  ? 'โควต้าเต็ม'
                  : res.status === 403 || res.status === 400
                    ? 'API key อาจไม่ถูกต้องหรือไม่ได้เปิดสิทธิ์'
                    : undefined,
          };
    } catch (err) {
      callResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // ดึงรายชื่อรุ่นที่ key นี้ใช้ได้จริง จะได้ไม่ต้องเดาชื่อ
    let availableModels: string[] | string;
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey },
      });
      const body = (await res.json()) as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
      };
      availableModels =
        body.models
          ?.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m) => (m.name ?? '').replace(/^models\//, ''))
          .filter(Boolean) ?? [];
    } catch (err) {
      availableModels = `ดึงรายชื่อรุ่นไม่ได้: ${err instanceof Error ? err.message : String(err)}`;
    }

    gemini = { configuredModel: GEMINI_MODEL, call: callResult, availableModels };
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
