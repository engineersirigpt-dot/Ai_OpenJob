# Typhoon ASR — บริการถอดเสียงภาษาไทยบนเซิร์ฟเวอร์เรา

ห่อโมเดล `typhoon-asr-realtime` (SCB 10X, open-source) ไว้เป็น HTTP service เล็กๆ
ให้แอปประชุมเรียกใช้ผ่าน `127.0.0.1` — **เสียงประชุมไม่ออกนอกบริษัท**

## ⚠️ ต้องใช้ Python 3.10–3.12 เท่านั้น

NeMo (ที่ Typhoon ASR ใช้) ล็อก `numpy==1.26.4` ซึ่งไม่มี wheel สำหรับ Python 3.13/3.14
ถ้าใช้ Python ใหม่เกินไปจะพังตอน build numpy (`Cannot compile Python.h`)

## ติดตั้ง (ทำครั้งเดียว)

```bash
cd /home/webadmin/ai_openjob/typhoon-asr-service
rm -rf venv

# 1) เอา uv มา (จัดการ Python + ลงแพ็กเกจ เร็วกว่า pip มาก ไม่ต้อง sudo)
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# 2) ดึง Python 3.11 แล้วสร้าง venv (--seed เพื่อให้มี pip ติดมาด้วย)
uv python install 3.11
uv venv --python 3.11 --seed venv
./venv/bin/python -V          # ต้องขึ้น Python 3.11.x

# 3) PyTorch แบบ CPU (เล็กกว่าตัวที่มี CUDA มาก)
uv pip install --python venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu

# 4) ที่เหลือ
uv pip install --python venv/bin/python -r requirements.txt
```

> ใช้พื้นที่รวมหลาย GB (PyTorch + NeMo และ dependency ของมัน) — เช็คก่อนด้วย `df -h /home`
> โมเดลจะถูกดาวน์โหลดตอนถอดเสียงครั้งแรก

## รัน

```bash
chmod +x run.sh
pm2 start ./run.sh --name typhoon-asr --interpreter bash
pm2 save
```

## ทดสอบ

```bash
# 1) service ตื่นไหม
curl http://127.0.0.1:8020/health
# -> {"ok":true,"ready":true,"device":"cpu"}

# 2) ถอดเสียงไฟล์ทดสอบ (ครั้งแรกจะช้าเพราะโหลดโมเดล)
curl -s -F "file=@test.wav" http://127.0.0.1:8020/transcribe
# -> {"text":"..."}
```

ไม่มีไฟล์เสียงทดสอบ? อัดจากเซิร์ฟเวอร์ไม่ได้ ให้เอาไฟล์ .wav อะไรก็ได้ที่มีคนพูดไทยไปวางไว้
แล้วตั้งชื่อ `test.wav` (หรือใช้ `.mp3` / `.flac` / `.ogg` ก็ได้)

## ดู log

```bash
pm2 logs typhoon-asr --lines 50
```

## ตั้งค่า

| ENV | ค่าเริ่มต้น | ความหมาย |
|-----|-----------|----------|
| `TYPHOON_PORT` | `8020` | พอร์ตที่ service ฟัง (localhost เท่านั้น) |
| `TYPHOON_DEVICE` | `cpu` | `cpu` / `cuda` / `auto` |
| `OMP_NUM_THREADS` | `4` | จำกัด thread ไม่ให้แย่ง CPU กับเว็บแอป |
