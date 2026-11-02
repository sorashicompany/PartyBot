let ctx: AudioContext | null = null;
let muted = false;

export function readMuted(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem("sorashi-mute") === "1";
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem("sorashi-mute", value ? "1" : "0");
  } catch {
    /* ignore quota */
  }
}

export function unlockAudio(): void {
  if (muted || typeof window === "undefined") return;
  const AC = window.AudioContext;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") void ctx.resume();
}

export type Sfx = "tap" | "send" | "vote" | "score" | "sweep" | "go" | "fail";

export function sfx(kind: Sfx): void {
  unlockAudio();
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  const tone = (freq: number, at: number, dur: number, type: OscillatorType, gain: number) => {
    const osc = ctx!.createOscillator();
    const amp = ctx!.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    amp.gain.setValueAtTime(gain, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(amp);
    amp.connect(ctx!.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  };
  if (kind === "tap") tone(240, t, 0.05, "square", 0.035);
  if (kind === "send") {
    tone(330, t, 0.07, "square", 0.04);
    tone(494, t + 0.07, 0.09, "square", 0.035);
  }
  if (kind === "vote") {
    tone(160, t, 0.08, "square", 0.04);
    tone(240, t + 0.05, 0.1, "square", 0.03);
  }
  if (kind === "score") {
    tone(523, t, 0.08, "square", 0.04);
    tone(659, t + 0.08, 0.1, "square", 0.04);
    tone(784, t + 0.16, 0.12, "square", 0.035);
  }
  if (kind === "sweep") {
    tone(523, t, 0.08, "square", 0.045);
    tone(659, t + 0.07, 0.08, "square", 0.045);
    tone(784, t + 0.14, 0.08, "square", 0.04);
    tone(1046, t + 0.22, 0.16, "square", 0.04);
  }
  if (kind === "go") {
    tone(146, t, 0.1, "square", 0.04);
    tone(220, t + 0.09, 0.12, "square", 0.04);
  }
  if (kind === "fail") tone(110, t, 0.12, "square", 0.04);
}

export function bindMute(value: boolean): void {
  muted = value;
}
