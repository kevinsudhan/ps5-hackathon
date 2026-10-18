"""
Speaks the promo's voiceover and lays it out in time.

    python promo/voice.py            # build/vo/*.wav + build/timeline.json
    python promo/voice.py --check    # also transcribe every line with Whisper, to hear it with "ears"

Each line of script.json is spoken on its own (Kokoro, local), trimmed, and placed: lines run
one after another with their 'pre'/'gap' pauses, a 'snap' line starts on the next beat, and
every scene starts on a two-beat boundary so cuts land with the music. The timeline is the one
source of timing: index.html animates to it, audio.py composes and mixes to it.
"""
import hashlib, json, math, os, re, sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
VO = os.path.join(BUILD, "vo")
SR = 24000


def plain(text):
    """The words as shown, without pronunciation marks."""
    return re.sub(r"\[([^\]]+)\]\(/[^)]*/\)", r"\1", text)


def trim(audio, floor_db=-42.0, pad=0.02):
    """Cut the silence Kokoro leaves around a line, keeping a few milliseconds."""
    env = np.convolve(np.abs(audio), np.ones(240) / 240, mode="same")
    level = 10 ** (floor_db / 20) * max(env.max(), 1e-9)
    on = np.flatnonzero(env > level)
    if not len(on):
        return audio
    a = max(0, on[0] - int(pad * SR))
    b = min(len(audio), on[-1] + int(pad * SR))
    return audio[a:b]


def speak(lines, voice, speed):
    """One wav per line, cached by its text, voice and speed."""
    os.makedirs(VO, exist_ok=True)
    pipeline = None
    out = {}
    for line in lines:
        sp = line.get("speed", speed)
        key = hashlib.sha1(f"{line['text']}|{voice}|{sp}".encode()).hexdigest()[:12]
        path = os.path.join(VO, f"{line['id']}.wav")
        stamp = path + ".key"
        if not (os.path.exists(path) and os.path.exists(stamp) and open(stamp).read() == key):
            if pipeline is None:
                from kokoro import KPipeline
                pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
            chunks = [a.numpy() if hasattr(a, "numpy") else np.asarray(a) for _, _, a in pipeline(line["text"], voice=voice, speed=sp)]
            audio = trim(np.concatenate(chunks).astype(np.float32))
            sf.write(path, audio, SR)
            open(stamp, "w").write(key)
            print(f"  spoke {line['id']}: {len(audio) / SR:.2f}s")
        out[line["id"]] = sf.info(path).duration
    return out


def layout(script, durations):
    beat = 60.0 / script["bpm"]
    grid = 2 * beat
    t = 0.0
    scenes, vo = [], []
    for scene in script["scenes"]:
        start = math.ceil(t / grid - 1e-9) * grid
        t = start
        for line in scene["lines"]:
            t += line.get("pre", 0.0)
            if line.get("snap"):
                t = math.ceil(t / beat - 1e-9) * beat
            dur = durations[line["id"]]
            vo.append({"id": line["id"], "scene": scene["id"], "at": round(t, 3), "dur": round(dur, 3), "text": line.get("show") or plain(line["text"])})
            t += dur + line.get("gap", 0.0)
        t += scene.get("hold", 0.0)
        end = math.ceil(t / grid - 1e-9) * grid
        scenes.append({"id": scene["id"], "music": scene["music"], "start": round(start, 3), "end": round(end, 3)})
        t = end
    return {"bpm": script["bpm"], "beat": beat, "duration": round(t, 3), "scenes": scenes, "vo": vo}


def captions(timeline, path):
    """An .srt of the voiceover, one caption per line, for players and uploads."""
    def stamp(t):
        ms = int(round(t * 1000))
        return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
    with open(path, "w", encoding="utf-8") as f:
        for i, v in enumerate(timeline["vo"], 1):
            f.write(f"{i}\n{stamp(v['at'])} --> {stamp(v['at'] + v['dur'] + 0.25)}\n{v['text']}\n\n")


def check(script):
    # Whisper imports numba only for word timings, and numba refuses newer NumPy; a stand-in will do.
    import types
    if "numba" not in sys.modules:
        stub = types.ModuleType("numba")
        stub.jit = lambda *a, **k: (lambda f: f)
        sys.modules["numba"] = stub
    import whisper
    model = whisper.load_model("base")
    for scene in script["scenes"]:
        for line in scene["lines"]:
            heard = model.transcribe(os.path.join(VO, f"{line['id']}.wav"), language="en", fp16=False)["text"].strip()
            print(f"  {line['id']:<9} said: {plain(line['text'])}\n  {'':<9} heard: {heard}")


def main():
    script = json.load(open(os.path.join(HERE, "script.json"), encoding="utf-8"))
    lines = [l for s in script["scenes"] for l in s["lines"]]
    durations = speak(lines, script["voice"], script["speed"])
    timeline = layout(script, durations)
    os.makedirs(BUILD, exist_ok=True)
    json.dump(timeline, open(os.path.join(BUILD, "timeline.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    captions(timeline, os.path.join(HERE, "promise-graph-demo.srt"))
    for s in timeline["scenes"]:
        print(f"{s['id']:<8} {s['start']:6.2f} – {s['end']:6.2f}  ({s['end'] - s['start']:.1f}s, {s['music']})")
    print(f"total {timeline['duration']:.1f}s, {len(lines)} lines")
    if "--check" in sys.argv:
        check(script)


if __name__ == "__main__":
    main()
