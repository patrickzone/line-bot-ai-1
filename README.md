# line-bot-ai-1

LINE Bot ตอบลูกค้าร้าน **Keep Me Around** ด้วย Gemini โดยอ้างอิงคำตอบจาก Google Sheet เท่านั้น

## โครงไฟล์

```
app/api/line-webhook/route.ts   รับ webhook · verify signature · ประสานงาน
lib/config.ts                   ค่าที่แก้บ่อยรวมจุดเดียว (เวลาทำการ · ข้อความ default · ชื่อรุ่น · timeout)
lib/sheet.ts                    ดึง FAQ CSV + cache 60 วิ + fallback cache เก่า
lib/gemini.ts                   ประกอบ prompt · เรียก Gemini · log · กัน MAX_TOKENS
```

## เวลาทำการ

จันทร์–เสาร์ 9:30–18:00 (เวลาไทย) อาทิตย์ปิด — แก้ได้ที่ `BUSINESS_HOURS` ใน [lib/config.ts](lib/config.ts)

นอกเวลาทำการบอทจะเปลี่ยนไปใช้ข้อความ default อีกแบบโดยอัตโนมัติ **โค้ดเป็นคนตัดสินจากเวลาไทย ไม่ใช่ AI**
(Vercel รันเป็น UTC จึงต้องแปลง timezone ด้วย `Intl.DateTimeFormat` ก่อนเทียบเสมอ)

## Google Sheet

แถวแรกเป็นหัวตาราง 4 คอลัมน์:

| A | B | C | D |
|---|---|---|---|
| `category` | `question` | `answer` | `keywords` |
| การจัดส่ง | ส่งของกี่วันถึง | ส่งภายใน 1-2 วันทำการ ได้รับของประมาณ 2-4 วันค่ะ | ส่งของ, ขนส่ง, กี่วัน, เลขพัสดุ |

ราคา · โปรโมชั่น · ที่ตั้งร้าน · เลขบัญชี **ต้องอยู่ใน Sheet เท่านั้น** ห้ามเขียนลงโค้ด
1 แถว = 1 เรื่อง · ไม่อยากให้ตอบเรื่องไหนก็ลบแถวออก บอทจะตอบ default ให้เอง

ลิงก์ที่ใช้ต้องเป็น CSV: File → Share → Publish to web → เลือกชีต → Comma-separated values (.csv)

## รันในเครื่อง

```bash
cp .env.example .env.local   # แล้วใส่ค่าจริง
npm install
npm run dev
```

เช็กว่า route ขึ้นจริง: เปิด http://localhost:3000/api/line-webhook ต้องได้ `{"ok":true}`

## Deploy

1. `npm run build` ต้องผ่านก่อน
2. เช็กว่า `.env.local` อยู่ใน `.gitignore` แล้ว **ก่อน** push (ตอนนี้ครอบด้วย `.env.*` อยู่)
3. commit + push ขึ้น `main`
4. Vercel → Settings → Environment Variables ใส่ครบ 4 ตัว → **redeploy 1 ครั้ง** ค่าถึงมีผล
5. รอ Deployments ขึ้น Ready → เปิด Runtime Logs ค้างไว้
6. LINE Developers Console → Webhook URL = `https://<โดเมน>.vercel.app/api/line-webhook` → กด **Verify** ต้องขึ้น Success → เปิด Use webhook
7. LINE OA Manager → **ปิด Auto-reply และ Greeting message** ไม่งั้นลูกค้าได้ 2 ข้อความ
8. ทดสอบ 4 เคส: มีใน Sheet / ไม่มีใน Sheet / นอกเวลาทำการ / ถามยาวหลายเรื่องรวด
   (ดู log ว่า `finishReason` เป็น `STOP` ไม่ใช่ `MAX_TOKENS`)

## Environment variables

| ตัวแปร | ใช้ทำอะไร |
|---|---|
| `LINE_CHANNEL_SECRET` | verify signature ของ webhook |
| `LINE_CHANNEL_ACCESS_TOKEN` | ส่งข้อความตอบกลับ |
| `GEMINI_API_KEY` | เรียกโมเดล |
| `FAQ_SHEET_CSV_URL` | ลิงก์ CSV ของ Sheet |
| `GEMINI_MODEL` | ไม่บังคับ — override ชื่อรุ่นโดยไม่ต้องแก้โค้ด |

## Error handling

หลักการเดียว: **ลูกค้าต้องได้ข้อความเสมอ และต้องไม่ได้ข้อมูลมั่ว**

| เหตุการณ์ | ผลลัพธ์ |
|---|---|
| signature ไม่ผ่าน | 401 ทันที |
| Sheet ล่ม แต่มี cache เก่า | ใช้ cache เก่าตอบปกติ |
| Sheet ล่ม ไม่มี cache | ข้าม Gemini → ตอบ default |
| Gemini timeout / error / quota เต็ม | log แล้วตอบ default |
| `finishReason` ไม่ใช่ `STOP` (รวม `MAX_TOKENS`) | ทิ้งคำตอบทั้งก้อน ตอบ default |
| คำตอบว่างเปล่า | ตอบ default |
| LINE reply พัง | `console.error` แต่ยัง return 200 |

**ต้อง return 200 แม้พัง** — ถ้าตอบ 500 LINE จะยิงซ้ำ กลายเป็นตอบลูกค้าหลายรอบและเปลืองโควต้า

log ทุก request: `finishReason` · `thoughtsTokenCount` · `candidatesTokenCount` · latency
ไม่ log access token, API key, ข้อความลูกค้า หรือ userId

## หมายเหตุเรื่องชื่อรุ่น

`GEMINI_MODEL` ตั้งไว้ที่ `gemini-3.5-flash` ถ้ายิงจริงแล้วขึ้น **404 model not found**
แก้ที่ [lib/config.ts](lib/config.ts) บรรทัดเดียว หรือ set env `GEMINI_MODEL` ทับได้เลย
