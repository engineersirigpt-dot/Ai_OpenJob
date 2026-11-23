/**
 * The one prompt both transcription routes hand to the speech model.
 *
 * It used to be the company's vocabulary list — "ศัพท์ที่ใช้ในการประชุมนี้:
 * CAR, NCR, Spot UV, …" — on the theory that the model would spell those
 * terms right. Measured against a real 8-minute meeting, slice by slice the
 * way the live path sends them, that list came back *instead of* the speech
 * in 19 of 25 slices: the model reads a hard stretch, cannot make it out,
 * and answers with the prompt. Three quarters of the meeting never reached
 * the screen. With no prompt at all, 14 of 25 slices came back in random
 * other languages instead — Vietnamese, Arabic, Japanese — because
 * `language=th` is a hint the model ignores on audio it cannot read.
 *
 * A short Thai sentence saying what the audio is does the one job the model
 * actually needs: it keeps the output Thai. On the same 25 slices it
 * produced no foreign text, twice the Thai, and when it is echoed (7 of 25)
 * it is a fixed phrase the guard removes exactly. Spelling of the print
 * terms is the dictionary's job (domain-dictionary.ts), which does it
 * deterministically and cannot be read back as speech.
 *
 * STT_VOCAB replaces the prompt; STT_VOCAB=off sends none.
 */
export const DEFAULT_STT_PROMPT = "บทสนทนาในที่ประชุมของโรงพิมพ์ พูดภาษาไทย";

export const STT_PROMPT =
  (process.env.STT_VOCAB || "").toLowerCase() === "off"
    ? ""
    : process.env.STT_VOCAB || DEFAULT_STT_PROMPT;
