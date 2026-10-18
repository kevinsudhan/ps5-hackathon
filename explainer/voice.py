"""
Speaks the explainer's narration and lays it out in time.

    <python with kokoro + soundfile> explainer/voice.py

Each line of script.json is spoken on its own (Kokoro, local, voice af_heart), trimmed, and placed:
lines run one after another with small gaps, scenes get their own 'pre' / 'post' room for the
visuals. Writes build/vo/<line>.wav, build/narration.wav, build/timeline.json (the one source of
timing for index.html and audio.py) and promise-graph-explainer.srt.
"""
import json, os, re

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
VO = os.path.join(BUILD, "vo")
SR = 24000


def trim(audio, floor_db=-42.0, pad=0.03):
    """Cut the silence Kokoro leaves around a line, keeping a few milliseconds."""
    env = np.convolve(np.abs(audio), np.ones(240) / 240, mode="same")
    level = 10 ** (floor_db / 20) * max(env.max(), 1e-9)
    on = np.flatnonzero(env > level)
    if not len(on):
        return audio
    a, b = max(0, on[0] - int(pad * SR)), min(len(audio), on[-1] + int(pad * SR))
    return audio[a:b]


def chunks(text, limit=64):
    """Caption pieces: split at sentence and clause ends, never mid-word, at most `limit` chars."""
    words, out, cur = text.split(), [], ""
    for w in words:
        nxt = (cur + " " + w).strip()
        if len(nxt) > limit and cur:
            out.append(cur)
            cur = w
        else:
            cur = nxt
            if re.search(r"[.:?!]$", w) and len(cur) > limit * 0.45:
                out.append(cur)
                cur = ""
    if cur:
        out.append(cur)
    return out


def stamp(t):
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02}:{int(m):02}:{s:06.3f}".replace(".", ",")


def main():
    from kokoro import KPipeline

    os.makedirs(VO, exist_ok=True)
    script = json.load(open(os.path.join(HERE, "script.json"), encoding="utf-8"))
    pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    t, scenes, lines, track = 0.0, [], [], []
    for si, sc in enumerate(script["scenes"]):
        start = t
        t += sc.get("pre", 0.0)
        for li, ln in enumerate(sc["lines"]):
            parts = [a for _, _, a in pipe(ln.get("say", ln["text"]), voice=script["voice"], speed=script["speed"])]
            audio = trim(np.concatenate([p.numpy() if hasattr(p, "numpy") else np.asarray(p) for p in parts]))
            sf.write(os.path.join(VO, f"{ln['id']}.wav"), audio, SR)
            dur = len(audio) / SR
            lines.append({"id": ln["id"], "scene": sc["id"], "start": round(t, 3), "end": round(t + dur, 3),
                          "text": ln["text"]})
            track.append((t, audio))
            t += dur + (script["line_gap"] if li < len(sc["lines"]) - 1 else 0)
            print(f"{ln['id']:4} {dur:5.2f}s  {ln['text'][:70]}")
        t += sc.get("post", 0.0)
        scenes.append({"id": sc["id"], "start": round(start, 3), "end": round(t, 3)})
        if si < len(script["scenes"]) - 1:
            t += script["scene_gap"]
            scenes[-1]["end"] = round(t, 3)

    total = t
    mix = np.zeros(int(total * SR) + SR)
    for at, audio in track:
        i = int(at * SR)
        mix[i:i + len(audio)] += audio
    sf.write(os.path.join(BUILD, "narration.wav"), mix, SR)

    caps = []
    for ln in lines:
        pieces = chunks(ln["text"])
        n = sum(len(p) for p in pieces)
        at = ln["start"]
        for p in pieces:
            d = (ln["end"] - ln["start"]) * len(p) / n
            caps.append({"start": round(at, 3), "end": round(at + d, 3), "text": p, "line": ln["id"]})
            at += d
    with open(os.path.join(HERE, "promise-graph-explainer.srt"), "w", encoding="utf-8") as f:
        for i, c in enumerate(caps, 1):
            f.write(f"{i}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}\n\n")
    json.dump({"fps": 30, "duration": round(total, 3), "scenes": scenes, "lines": lines, "captions": caps},
              open(os.path.join(BUILD, "timeline.json"), "w", encoding="utf-8"), indent=1)
    print(f"\n{len(lines)} lines, {len(caps)} captions, {total:.1f}s")
    for s in scenes:
        print(f"  {s['id']:11} {s['start']:6.1f} - {s['end']:6.1f}  ({s['end'] - s['start']:.1f}s)")


if __name__ == "__main__":
    main()
