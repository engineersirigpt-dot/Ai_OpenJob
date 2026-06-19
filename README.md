# AI Meeting Assistant

AI ผู้ช่วยเข้าร่วมประชุม ฟังการสนทนาแบบเรียลไทม์ อ่านเอกสารประกอบ พร้อมเสนอความคิดเห็นและตอบคำถามได้

## ฟีเจอร์หลัก

- **เริ่มประชุม** — กดเริ่มแล้ว AI จะนั่งฟังการประชุมแบบเรียลไทม์ผ่าน WebRTC + OpenAI Realtime API
- **อ่านเอกสาร** — อัปโหลด PDF / DOCX / TXT / MD เพื่อให้ AI ใช้เป็นข้อมูลอ้างอิง
- **เสนอความคิดเห็น** — กดปุ่ม "เสนอความคิดเห็น" → AI สรุปประเด็นและให้ข้อเสนอแนะจากที่ฟัง + เอกสาร
- **ถามคำถาม** — พิมพ์คำถาม → AI ตอบโดยอ้างอิงเอกสารและความรู้ทั่วไป
- **บทสนทนาแบบเรียลไทม์** — เห็น transcript ของทั้งห้องประชุมและ AI

## Setup

```bash
cd Ai_OpenJob
npm install
cp .env.example .env
# แก้ .env: ใส่ OPENAI_API_KEY
npm run dev
```

จากนั้นเปิด <http://localhost:3002>

## โครงสร้าง

```
src/
├── app/
│   ├── api/
│   │   ├── realtime/route.ts      # Ephemeral token endpoint
│   │   └── documents/route.ts     # Upload / list / delete docs
│   ├── layout.tsx
│   ├── page.tsx                   # หน้าหลัก
│   └── globals.css
├── hooks/
│   ├── use-webrtc.ts              # WebRTC + audio streaming
│   └── use-transcript.ts          # Transcript state
├── components/
│   ├── transcript-feed.tsx        # บทสนทนา UI
│   └── document-upload.tsx        # Upload UI
└── lib/
    ├── prompts.ts                 # System / comment / question prompts
    ├── document-parser.ts         # PDF/DOCX → text
    └── document-store.ts          # In-memory doc store
```

## คีย์การออกแบบ

- AI **ไม่พูดเองโดยอัตโนมัติ** — turn_detection ถูกตั้งเป็น null
- AI จะพูดเฉพาะเมื่อกดปุ่ม "เสนอความคิดเห็น" หรือ "ถามคำถาม" เท่านั้น
- เอกสารทั้งหมดถูก inject เข้าใน system prompt ของ session

## ปรับแต่งเพิ่มเติม

- เปลี่ยน model: ตั้ง `REALTIME_MODEL` ใน `.env`
- เปลี่ยนเสียง: ตั้ง `VOICE` ใน `.env` (`ash`, `ballad`, `shimmer`, ...)
- จะเปลี่ยน document store จาก in-memory เป็น DB ก็แก้ที่ `src/lib/document-store.ts`
