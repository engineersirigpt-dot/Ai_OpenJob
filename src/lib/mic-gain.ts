/**
 * How much the room's audio is lifted before anything else reads it.
 *
 * The conference mic hands over speech at about -42 dBFS, and even its
 * loudest moments reach only -31 dBFS; speech wants to sit near -23. Two
 * recordings measured days apart came back within 0.3 dB of each other —
 * one with the browser's auto-gain not asked for, one with it asked for —
 * so the browser is not lifting this device whatever we request of it. The
 * app does it itself instead: a gain stage that can be measured and set,
 * rather than one that can only be asked for and silently refused.
 *
 * Everything downstream hears the room through this one number, so the
 * speech gate's thresholds are scaled by it here instead of being written
 * out separately. Raising the gain must not quietly leave the gate sitting
 * below the amplified noise floor, which would hand the transcriber a
 * recording of the air conditioning.
 *
 * Every setting here can also be overridden from the browser's own storage,
 * which exists because the alternative is a deploy per experiment. These are
 * build-time values: finding the right ones means trying them in the real
 * room, and a round trip of edit, build, restart, walk to the meeting room
 * is too slow to ever actually be done. With the override, the room tries
 * four settings in one sitting and the winner is written into .env after.
 *
 *   localStorage.setItem("micAEC", "false"); location.reload();
 *   localStorage.setItem("micGain", "8");    location.reload();
 *   localStorage.clear();                    location.reload();   // back to .env
 */

/** What the room set for this browser, if anything. Never throws. */
function stored(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined; // private window, blocked site data, or the server
  }
}

/**
 * One on/off microphone constraint: the room's choice, else .env, else the
 * measured default. An empty string counts as unset, so a blank .env line
 * does not read as "false".
 */
function flag(storeKey: string, envValue: string | undefined, fallback: boolean): boolean {
  const v = stored(storeKey) ?? envValue;
  return v === undefined || v === "" ? fallback : v !== "false";
}

/**
 * Echo cancellation stops พรชัย's own voice returning through the speaker,
 * so it is on. Noise suppression is off: the measured room floor was
 * -62 dBFS before the gain stage, which is quiet, and suppression is paid
 * for in consonants. Auto-gain is asked for and, on the conference mic,
 * measurably ignored — which is why MIC_GAIN below exists.
 */
export const MIC_AEC = flag("micAEC", process.env.NEXT_PUBLIC_MIC_AEC, true);
export const MIC_NS = flag("micNS", process.env.NEXT_PUBLIC_MIC_NS, false);
export const MIC_AGC = flag("micAGC", process.env.NEXT_PUBLIC_MIC_AGC, true);

/**
 * 1 leaves the mic alone. 4 is +12 dB, which is where a measurement put it:
 * the first try at 6 brought a real recording to -17.5 dBFS, about 5 dB past
 * where speech should sit, and left the limiter working on every syllable.
 */
export const MIC_GAIN = (() => {
  const raw = Number(stored("micGain") ?? process.env.NEXT_PUBLIC_MIC_GAIN);
  return Number.isFinite(raw) && raw >= 1 && raw <= 40 ? raw : 4;
})();

/**
 * Peaks are held back rather than clipped. At gain 6 the measured transient
 * peak (-14.6 dBFS) would land just past 0 dBFS, and a clipped transient is
 * a burst of broadband noise sitting exactly where a consonant was — the
 * one thing worse for Thai aspirated pairs than a quiet recording.
 */
export const LIMITER = { threshold: -6, knee: 0, ratio: 12, attack: 0.003, release: 0.25 };

/**
 * Which microphone to open, when the room has chosen one.
 *
 * Left empty, the browser opens whatever Windows calls the default, and on
 * three separate days that turned out to be the laptop's own array while
 * the conference mic sat unused on the table — once with the laptop's fan
 * and charger hum recorded in its place. The room picks the mic from the
 * list under the level bars; the choice is kept here and reopened next
 * time. A device that has since been unplugged simply fails to open and
 * the default is used instead.
 */
export const MIC_DEVICE_ID = stored("micDeviceId") || "";

/**
 * Mains hum is notched out.
 *
 * The same 29 Oct recording had one sharp tone at 99.6 Hz standing 22 dB
 * above everything around it, with a weaker one at 200 Hz — twice and four
 * times the 50 Hz mains, which is electrical hum reaching the mic (a ground
 * loop through the laptop's charger and the USB cable is the usual route),
 * not air. A high-pass at 150 Hz only dents a tone at 100 Hz, so each tone
 * gets its own narrow notch, which costs the voices nothing. Set to the
 * tone's frequency; 0 turns it off. The real fix is at the plug.
 */
export const MIC_NOTCH = (() => {
  const raw = Number(stored("micNotch") ?? process.env.NEXT_PUBLIC_MIC_NOTCH);
  return Number.isFinite(raw) && raw >= 0 && raw <= 400 ? raw : 100;
})();

/**
 * Rumble is cut before anything is amplified.
 *
 * A recording from the room on 29 Oct carried 92% of its energy below
 * 300 Hz — air moving across the mic and the room's own hum — with a floor
 * at -25 dBFS, 16 dB louder than the day before. Amplifying that lifts the
 * wind along with the words, the limiter then ducks on every gust, and the
 * speech gate sees a floor above its threshold and lets everything through.
 * Speech intelligibility lives from 300 Hz up, so a high-pass at 150 Hz
 * (two stages, 24 dB/octave) takes the rumble and leaves the voices: on
 * that recording it dropped the floor by 8 dB and the sub-300 Hz share from
 * 92% to 46%. 0 turns it off.
 */
export const MIC_HPF = (() => {
  const raw = Number(stored("micHighpass") ?? process.env.NEXT_PUBLIC_MIC_HPF);
  return Number.isFinite(raw) && raw >= 0 && raw <= 400 ? raw : 150;
})();

const base = (storeKey: string, envValue: string | undefined, fallback: number) => {
  const raw = Number(stored(storeKey) ?? envValue);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/**
 * Gate thresholds in the units the gate actually sees — after the gain.
 *
 * The env values stay in pre-gain units, the ones a measurement of a raw
 * recording gives you, so the two settings cannot drift apart.
 */
export const SPEECH_START_RMS =
  base("sttRmsStart", process.env.NEXT_PUBLIC_STT_RMS_START, 0.004) * MIC_GAIN;
export const SPEECH_KEEP_RMS =
  base("sttRmsKeep", process.env.NEXT_PUBLIC_STT_RMS_KEEP, 0.0025) * MIC_GAIN;

/** dBFS, for the log lines a person has to read. */
export function dbfs(rms: number): string {
  return rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : "-inf";
}
