/**
 * LINE webhook — รับข้อความ · verify signature · ประสานงาน sheet + gemini · ตอบกลับ
 */

import { messagingApi, validateSignature } from '@line/bot-sdk';
import { GEMINI_MODEL, getDefaultReply } from '@/lib/config';
import { askGemini } from '@/lib/gemini';
import { getFaqCsv } from '@/lib/sheet';

// ต้องเป็น nodejs ไม่ใช่ edge — validateSignature ใช้ crypto ของ node
export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

type LineTextEvent = {
  type: string;
  replyToken?: string;
  deliveryContext?: { isRedelivery?: boolean };
  message?: { type: string; text?: string };
};

export async function POST(req: Request) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!channelSecret || !accessToken) {
    console.error('[webhook] LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN ไม่ครบ');
    // 200 เสมอ ไม่ให้ LINE ยิงซ้ำ
    return new Response('OK', { status: 200 });
  }

  // 1) ต้องอ่าน raw body ก่อน ห้าม req.json() ไม่งั้น verify ไม่ผ่าน
  const raw = await req.text();
  const signature = req.headers.get('x-line-signature');

  // 2) verify signature ไม่ผ่าน = ตัดจบที่ 401
  if (!signature || !validateSignature(raw, channelSecret, signature)) {
    console.error('[webhook] signature ไม่ผ่าน');
    return new Response('Unauthorized', { status: 401 });
  }

  let events: LineTextEvent[] = [];
  try {
    events = JSON.parse(raw)?.events ?? [];
  } catch {
    console.error('[webhook] parse body ไม่ได้');
    return new Response('OK', { status: 200 });
  }

  // 3) เอาเฉพาะข้อความตัวอักษรที่ไม่ใช่ของยิงซ้ำ — สติกเกอร์/รูปข้ามเงียบ ๆ
  const targets = events.filter(
    (e): e is LineTextEvent & { replyToken: string; message: { text: string } } =>
      e.type === 'message' &&
      e.message?.type === 'text' &&
      typeof e.message.text === 'string' &&
      e.message.text.trim().length > 0 &&
      typeof e.replyToken === 'string' &&
      e.deliveryContext?.isRedelivery !== true,
  );

  if (targets.length === 0) {
    return new Response('OK', { status: 200 });
  }

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: accessToken,
  });

  // 4) โค้ดเป็นคนเลือก default reply ตามเวลาไทย ไม่ใช่ AI
  const defaultReply = getDefaultReply();

  // 5) Sheet ดึงครั้งเดียวใช้ได้ทุก event ใน batch นี้
  const { csv, stale } = await getFaqCsv();
  if (stale) {
    console.warn('[webhook] กำลังใช้ FAQ จาก cache เก่า');
  }

  // 7) ต้อง await ให้ reply เสร็จก่อน return
  //    บน Vercel ถ้า return ก่อน งานที่ค้างอยู่จะโดนตัด ลูกค้าไม่ได้ข้อความ
  await Promise.allSettled(
    targets.map(async (event) => {
      let replyText = defaultReply;

      // ไม่มี FAQ เลย = ข้าม Gemini ไปเลย ไม่มีข้อมูลให้ตอบอยู่ดี
      if (csv) {
        const answer = await askGemini({
          userMessage: event.message.text,
          faqCsv: csv,
          defaultReply,
        });
        if (answer) replyText = answer;
      } else {
        console.error('[webhook] ไม่มี FAQ ข้าม Gemini ตอบ default');
      }

      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: replyText }],
        });
      } catch (err) {
        // reply พังก็ยังต้อง 200 ไม่งั้น LINE ยิงซ้ำทั้ง batch
        console.error(
          '[webhook] reply ไม่สำเร็จ:',
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  // 8) 200 เสมอ — ตอบ 500 เมื่อไหร่ LINE จะยิงซ้ำ
  //    กลายเป็นลูกค้าได้ข้อความหลายรอบและเปลืองโควต้า Gemini
  return new Response('OK', { status: 200 });
}

/**
 * ไว้เปิดในเบราว์เซอร์เช็กว่า route ขึ้นจริง และ deploy ถึง commit ไหนแล้ว
 * commit / model ไม่ใช่ความลับ ไม่มีค่า env ใด ๆ ออกมาจากตรงนี้
 */
export function GET() {
  return Response.json({
    ok: true,
    route: 'line-webhook',
    // Vercel ใส่ค่านี้ให้เอง ใช้ยืนยันว่า production รันโค้ดเวอร์ชันไหนอยู่
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    model: GEMINI_MODEL,
  });
}
