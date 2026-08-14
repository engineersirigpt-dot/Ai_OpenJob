"use client";

import { useState } from "react";
import { ShieldAlert, X, Mic, Eye, FileWarning, Server, Coins } from "lucide-react";

interface Section {
  icon: React.ReactNode;
  title: string;
  points: string[];
}

const SECTIONS: Section[] = [
  {
    icon: <Eye className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    title: "ความเป็นส่วนตัว & การขอความยินยอม",
    points: [
      "แจ้งและขอความยินยอมผู้เข้าร่วมทุกคนก่อนเริ่มบันทึก/ถอดเสียง — หลายที่ถือเป็นข้อกำหนดทางกฎหมาย",
      "ผู้เข้าร่วมมีสิทธิ์ปฏิเสธการบันทึก ใช้ปุ่มพักไมโครโฟนเมื่อมีช่วงสนทนาที่ไม่ควรบันทึก",
      "อย่าเปิด AI ฟังในวาระลับ เช่น เรื่องบุคคล เงินเดือน หรือข้อมูลที่เป็นความลับทางการค้า",
    ],
  },
  {
    icon: <Server className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    title: "ข้อมูลถูกส่งออกไปประมวลผลภายนอก",
    points: [
      "เสียงในห้องประชุมถูกสตรีมไปยัง OpenAI (เซิร์ฟเวอร์ในต่างประเทศ) เพื่อถอดเสียงและตอบ",
      "ค่าเริ่มต้น OpenAI ไม่นำข้อมูล API ไปเทรนโมเดล แต่อาจเก็บได้สูงสุด 30 วันเพื่อตรวจสอบการใช้งานผิดปกติ (ยกเว้นเปิด Zero Data Retention)",
      "ไม่เหมาะกับข้อมูลอ่อนไหวสูง/ความลับระดับองค์กร เว้นแต่ผ่านการอนุมัติด้านความปลอดภัยแล้ว",
    ],
  },
  {
    icon: <FileWarning className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    title: "ความแม่นยำ — อย่าเชื่อ 100%",
    points: [
      "การถอดเสียงอาจผิดพลาด จับผู้พูดสลับ หรือฟังคำเฉพาะ/ตัวเลขผิด โดยเฉพาะภาษาไทยปนอังกฤษ",
      "สรุปและคำตอบของ AI อาจตกหล่นหรือ “แต่งข้อมูลขึ้นเอง” (hallucinate) ได้",
      "ก่อนใช้สรุป/transcript เป็นหลักฐานอ้างอิง ควรให้คนตรวจทานความถูกต้องก่อนเสมอ",
    ],
  },
  {
    icon: <Mic className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    title: "ข้อจำกัดเฉพาะของระบบนี้",
    points: [
      "เอกสารที่อัปโหลด/ดึงมาเก็บใน memory — จะหายเมื่อรีสตาร์ทเซิร์ฟเวอร์",
      "ประวัติการประชุมเก็บเป็นไฟล์ SQLite ในเครื่อง (data/meetings.db) ยังไม่มีระบบล็อกอิน/สิทธิ์เข้าถึง",
      "AI จะพูดเฉพาะเมื่อกด “เสนอความคิดเห็น/ถามคำถาม” เท่านั้น ไม่ได้แทรกเอง",
    ],
  },
  {
    icon: <Coins className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    title: "ค่าใช้จ่าย",
    points: [
      "ทุกนาทีที่ AI ฟัง + การสรุปตอนจบ มีค่าใช้จ่ายตามการใช้งาน OpenAI API",
      "กด “จบประชุม” เมื่อเลิกใช้ เพื่อหยุดการเชื่อมต่อและไม่ให้เกิดค่าใช้จ่ายค้าง",
    ],
  },
];

export function PrecautionsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors"
      >
        <ShieldAlert className="h-3.5 w-3.5" />
        ข้อควรระวัง
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="flex items-center gap-2 text-base font-bold text-amber-700 dark:text-amber-300">
                <ShieldAlert className="h-5 w-5" />
                ข้อควรระวังในการใช้งาน
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                aria-label="ปิด"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              {SECTIONS.map((s) => (
                <div key={s.title}>
                  <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1.5">
                    {s.icon}
                    {s.title}
                  </h4>
                  <ul className="space-y-1 pl-1">
                    {s.points.map((p, i) => (
                      <li key={i} className="flex gap-2 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        <span className="text-amber-500/70 shrink-0">•</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <p className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
              สรุปโดยย่อ: ขอความยินยอมก่อนบันทึก · ไม่ใช้กับเรื่องลับ · ตรวจทานก่อนเชื่อ · กดจบประชุมทุกครั้ง
            </p>
          </div>
        </div>
      )}
    </>
  );
}
