"""
Composes the promo's music and sound effects and mixes them under the voiceover.

    python promo/audio.py      # build/{music,sfx,vo,mix}.wav

Everything is synthesised here (numpy and scipy, no samples): a 120 BPM track in D minor /
F major (vi-IV-I-V), arranged by the scenes' "music" sections in build/timeline.json, and
an effect for every cue the page lists in build/cues.json (node promo/render.mjs --cues).
The voice ducks the music; the mix is levelled to -14 LUFS with a -1 dB ceiling.
"""
import json, os, re, subprocess, sys

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import maximum_filter1d, uniform_filter1d

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
SR = 48000
rng = np.random.default_rng(7)


# ------------------------------------------------------------------ building blocks
def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def secs(n):
    return np.arange(n) / SR


def filt(x, kind, f, order=2):
    return signal.sosfilt(signal.butter(order, f, btype=kind, fs=SR, output="sos"), x, axis=-1)


def env(n, a=0.005, r=0.05, hold=None):
    """Linear attack, sustain, linear release over the last r seconds."""
    t = secs(n)
    e = np.minimum(1.0, t / max(a, 1e-4))
    end = n / SR if hold is None else hold + r
    return e * np.clip((end - t) / max(r, 1e-4), 0, 1)


def noise(n):
    return rng.standard_normal(n)


def saw(f, n, phase=0.0):
    """A band-limited sawtooth (polyBLEP)."""
    ph = (phase + f * secs(n)) % 1.0
    dt = f / SR
    y = 2 * ph - 1
    m = ph < dt
    x = ph[m] / dt
    y[m] -= x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt
    y[m] -= x * x + x + x + 1
    return y


def tvband(x, fc, bw=0.8):
    """Noise through a band-pass whose centre moves (fc per sample), via the STFT."""
    f, tt, Z = signal.stft(x, SR, nperseg=1024)
    centre = np.interp(tt, secs(len(x)), fc)
    with np.errstate(divide="ignore"):
        d = np.log2(np.maximum(f[:, None], 1) / centre[None, :])
    Z *= np.exp(-0.5 * (d / bw) ** 2)
    _, y = signal.istft(Z, SR, nperseg=1024)
    return y[: len(x)]


def stereo(y, pan=0.0):
    return np.stack([y * min(1.0, 1 - pan), y * min(1.0, 1 + pan)])


class Track:
    def __init__(self, n):
        self.x = np.zeros((2, n))

    def add(self, sig, at, gain=1.0, pan=0.0):
        sig = np.asarray(sig, dtype=float)
        if sig.ndim == 1:
            sig = stereo(sig, pan)
        i = int(round(at * SR))
        if i < 0:
            sig, i = sig[:, -i:], 0
        j = min(self.x.shape[1], i + sig.shape[1])
        if j > i:
            self.x[:, i:j] += gain * sig[:, : j - i]


def reverb_ir(dur=2.6, tau=0.36, pre=0.022):
    n = int(dur * SR)
    t = secs(n)
    raw = rng.standard_normal((2, n))
    bright, dark = filt(raw, "lowpass", 8000), filt(raw, "lowpass", 2200)
    mix = np.exp(-t / 0.18)
    ir = (bright * mix + dark * (1 - mix)) * np.exp(-t / tau)
    ir[:, : int(pre * SR)] = 0
    return ir / np.sqrt((ir ** 2).sum(axis=1, keepdims=True))


IR = reverb_ir()


def reverb(x):
    return np.stack([signal.fftconvolve(x[c], IR[c])[: x.shape[1]] for c in range(2)])


# ------------------------------------------------------------------ instruments
_cache = {}


def pluck(m, dur=0.42, bright=1.0):
    """Additive pluck: the upper harmonics die first, like a filter closing."""
    key = ("pl", m, dur, bright)
    if key in _cache:
        return _cache[key]
    f, n = mtof(m), int(dur * SR)
    t = secs(n)
    K = max(1, min(36, int(14000 / f)))
    k = np.arange(1, K + 1)[:, None]
    ph = np.random.default_rng(m).random((K, 1)) * 2 * np.pi
    y = ((1.0 / k) * np.exp(-t[None, :] * (5 + 11 * k / bright)) * np.sin(2 * np.pi * f * k * t[None, :] + ph)).sum(0)
    y *= np.minimum(1, t / 0.002) * np.clip((n / SR - t) / 0.01, 0, 1)
    y /= np.abs(y).max() + 1e-9
    _cache[key] = y
    return y


def supersaw(ms, dur, voices=7, spread=20, cutoff=5000, attack=0.01, release=0.25, hp=150):
    n = int((dur + release) * SR)
    out = np.zeros((2, n))
    for m in ms:
        f = mtof(m)
        for v in range(voices):
            c = 0 if voices == 1 else (v / (voices - 1) * 2 - 1)
            y = saw(f * 2 ** (c * spread / 1200), n, rng.random())
            out += stereo(y, c * 0.7)
    out /= np.sqrt(voices) * len(ms)
    out *= env(n, attack, release, hold=dur)
    out = filt(out, "lowpass", cutoff, 2)
    return filt(out, "highpass", hp, 2)


def bass(m, dur):
    n = int(dur * SR)
    t, f = secs(n), mtof(m)
    y = np.sin(2 * np.pi * f * t) + 0.45 * filt(saw(f, n), "lowpass", 480, 2)
    return np.tanh(1.3 * y) * env(n, 0.004, 0.035)


def kick():
    if "kick" in _cache:
        return _cache["kick"]
    n = int(0.45 * SR)
    t = secs(n)
    f = 44 + 120 * np.exp(-t / 0.032)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.27)
    click = filt(noise(n), "highpass", 3000) * np.exp(-t / 0.003) * 0.35
    y = np.tanh(1.7 * (body + click))
    _cache["kick"] = y / np.abs(y).max()
    return _cache["kick"]


def clap():
    n = int(0.35 * SR)
    t = secs(n)
    x = filt(noise(n), "bandpass", [900, 3200])
    e = sum(np.exp(-np.maximum(t - d, 0) / 0.006) * (t >= d) for d in (0, 0.011, 0.022)) + 0.6 * np.exp(-np.maximum(t - 0.03, 0) / 0.11) * (t >= 0.03)
    y = x * e
    return y / np.abs(y).max()


def hat(open_=False):
    n = int((0.25 if open_ else 0.06) * SR)
    t = secs(n)
    y = filt(noise(n), "highpass", 7500) * np.exp(-t / (0.11 if open_ else 0.018))
    return y / np.abs(y).max()


def shaker():
    n = int(0.09 * SR)
    t = secs(n)
    y = filt(noise(n), "bandpass", [5000, 11000]) * np.minimum(1, t / 0.015) * np.exp(-t / 0.035)
    return y / np.abs(y).max()


def crash(dur=2.2):
    n = int(dur * SR)
    t = secs(n)
    x = filt(rng.standard_normal((2, n)), "highpass", 3500)
    y = x * np.exp(-t / 0.55) * np.minimum(1, t / 0.002)
    return y / np.abs(y).max()


def riser(dur, lo=300, hi=9000):
    n = int(dur * SR)
    t = secs(n)
    fc = lo * (hi / lo) ** (t / dur)
    x = tvband(noise(n), fc, 0.6)
    sweep = np.sin(2 * np.pi * np.cumsum(220 * 8 ** (t / dur)) / SR) * 0.25
    y = (x / (np.abs(x).max() + 1e-9) + sweep) * (t / dur) ** 2.4 * np.clip((dur - t) / 0.01, 0, 1)
    return y / (np.abs(y).max() + 1e-9)


def bell(f, tau=0.8):
    n = int(tau * 5 * SR)
    t = secs(n)
    parts = [(1, 1, 1), (2.0, 0.45, 0.7), (3.0, 0.22, 0.45), (4.16, 0.14, 0.3), (5.43, 0.09, 0.2)]
    y = sum(a * np.exp(-t / (tau * d)) * np.sin(2 * np.pi * f * r * t) for r, a, d in parts)
    y *= np.minimum(1, t / 0.0015)
    return y / np.abs(y).max()


# ------------------------------------------------------------------ the music
PROG = [  # vi - IV - I - V in F: Dm9, Bbmaj7, F, Cadd9
    {"root": 38, "pad": [62, 65, 69, 76]},
    {"root": 34, "pad": [62, 65, 69, 70]},
    {"root": 41, "pad": [60, 65, 69, 72]},
    {"root": 36, "pad": [60, 64, 67, 74]},
]
# The hook: a 3-3-3-3-2-2 pluck line, one bar per chord (16th steps -> MIDI note).
MOTIF = [
    {0: 81, 3: 81, 6: 84, 9: 81, 12: 79, 14: 77},
    {0: 77, 3: 77, 6: 81, 9: 77, 12: 74, 14: 72},
    {0: 84, 3: 84, 6: 81, 9: 84, 12: 86, 14: 84},
    {0: 79, 3: 79, 6: 76, 9: 79, 12: 81, 14: 79},
]


def compose(tl, cues, n):
    beat = tl["beat"]
    bar, s16 = 4 * beat, beat / 4
    drums, bassb, chords, plucks, fx = (Track(n) for _ in range(5))
    kicks = []  # (time, depth) for the pump

    # merge neighbouring scenes that share a section
    sections = []
    for s in tl["scenes"]:
        if sections and sections[-1][0] == s["music"]:
            sections[-1][2] = s["end"]
        else:
            sections.append([s["music"], s["start"], s["end"]])

    def chord_at(t, s0):
        return PROG[int((t - s0 + 1e-6) // bar) % 4]

    def steps(s0, e0, step):
        k = 0
        while s0 + k * step < e0 - 1e-6:
            yield k, s0 + k * step
            k += 1

    def four_floor(s0, e0, gain=1.0, depth=0.7, clap_=True, open_=True, closed=0.25, until=None):
        until = e0 if until is None else until
        for k, t in steps(s0, until, beat):
            drums.add(kick(), t, 0.95 * gain)
            kicks.append((t, depth))
            if clap_ and k % 2 == 1:
                drums.add(clap(), t, 0.5 * gain, pan=0.05)
            if open_:
                drums.add(hat(True), t + beat / 2, 0.22 * gain, pan=0.2)
        for k, t in steps(s0, until, s16):
            if closed:
                drums.add(hat(), t, closed * gain * (1.0 if k % 2 else 0.55), pan=-0.25)

    def pads(s0, e0, gain, cutoff, voices=3, every=1):
        for k, t in steps(s0, e0, bar * every):
            c = chord_at(t, s0)
            d = min(bar * every, e0 - t)
            chords.add(supersaw(c["pad"], d, voices=voices, cutoff=cutoff, attack=0.25 if voices < 5 else 0.01, release=0.4), t, gain)

    def big_chords(s0, e0, gain=0.55, cutoff=5200):
        for k, t in steps(s0, e0, bar):
            c = chord_at(t, s0)
            notes = c["pad"] + [c["pad"][0] - 12]
            chords.add(supersaw(notes, min(bar, e0 - t) - 0.02, voices=7, cutoff=cutoff, release=0.12), t, gain)

    def bassline(s0, e0, gain=0.6, pattern="offbeat"):
        for k, t in steps(s0, e0, beat / 2):
            r = chord_at(t, s0)["root"]
            if pattern == "offbeat" and k % 2 == 0:
                continue
            note = r + (12 if pattern == "rolling" and k % 4 == 3 else 0)
            bassb.add(bass(note, beat / 2 * 0.9), t, gain)

    def motif(s0, e0, gain=0.35, octave=0, bright=1.0):
        for k, t in steps(s0, e0, s16):
            bar_i = int((t - s0 + 1e-6) // bar)
            step = k % 16
            m = MOTIF[bar_i % 4].get(step)
            if m is None:
                continue
            y = pluck(m + octave, 0.4, bright)
            plucks.add(y, t, gain, pan=0.0)
            for j, (dl, g, p) in enumerate(((0.375, 0.32, -0.6), (0.75, 0.16, 0.6))):
                plucks.add(y, t + dl, gain * g, pan=p)

    def arp(s0, e0, gain=0.22, step=None, bright=0.55):
        step = step or beat / 2
        for k, t in steps(s0, e0, step):
            c = chord_at(t, s0)["pad"]
            order = [0, 1, 2, 3, 2, 1]
            plucks.add(pluck(c[order[k % len(order)]] + 12, 0.35, bright), t, gain, pan=0.3 if k % 2 else -0.3)

    def build(t0, t1, gain=0.6):
        """Snare roll and riser into t1."""
        for k, t in steps(t0, t1, s16):
            x = (t - t0) / (t1 - t0)
            drums.add(clap(), t, gain * (0.15 + 0.6 * x ** 2), pan=0.0)
        fx.add(riser(t1 - t0), t0, 0.35)

    def crash_at(t, gain=0.4):
        fx.add(crash(), t, gain)

    aiq = next((c["t"] for c in cues if c["kind"] == "impact" and c.get("warm")), None)
    block = next((c["t"] for c in cues if c["kind"] == "block"), None)
    passed = next((c["t"] for c in cues if c["kind"] == "success"), None)

    for name, s0, e0 in sections:
        if name == "intro":
            # tension: a pad, a 16th arp that opens up, a heartbeat once the question lands
            pads(s0, e0, 0.6, 1300)
            for k, t in steps(s0 + 0.5, e0, s16):
                c = chord_at(t, s0)["pad"]
                x = (t - s0) / (e0 - s0)
                plucks.add(pluck(c[[0, 2, 1, 3][k % 4]] + 12, 0.25, 0.3 + 0.7 * x), t, 0.12 + 0.16 * x, pan=0.3 if k % 2 else -0.3)
            for k, t in steps(e0 - 3.0, e0 - 0.5, beat):
                drums.add(kick(), t, 0.55 + 0.1 * k)
            build(e0 - 2.0, e0, 0.5)
        elif name == "impact":
            # the first drop, on the logo
            crash_at(s0, 0.55)
            four_floor(s0, e0, 0.9, 0.7, closed=0.18)
            bassline(s0, e0, 0.6, "rolling")
            big_chords(s0, e0, 0.36, 4600)
            motif(s0, e0, 0.28, 0, 1.0)
        elif name == "grooveA":
            four_floor(s0, e0, 0.85, 0.55, closed=0.16)
            bassline(s0, e0, 0.55, "offbeat")
            pads(s0, e0, 0.24, 1500)
            arp(s0, e0, 0.14, bright=0.6)
        elif name == "grooveB":
            four_floor(s0, e0, 0.9, 0.6, until=e0 - 0.5, closed=0.18)
            for k, t in steps(s0, e0 - 0.5, s16):
                drums.add(shaker(), t, 0.1 if k % 2 else 0.05, pan=0.35)
            bassline(s0, e0 - 0.5, 0.55, "offbeat")
            pads(s0, e0, 0.24, 1800)
            motif(s0, e0 - 0.5, 0.24, -12, 0.8)
            build(e0 - 2.0, e0, 0.55)
        elif name in ("drop", "drop2"):
            for t in np.arange(s0, e0 - 0.1, 4 * bar):
                crash_at(t, 0.42)
            four_floor(s0, e0, 1.0, 0.8, until=e0 - 0.5, closed=0.22)
            bassline(s0, e0 - 0.5, 0.62, "rolling")
            big_chords(s0, e0 - 0.5, 0.36)
            motif(s0, e0 - 0.5, 0.3, 0, 1.0)
            if name == "drop2" and passed:
                crash_at(passed, 0.35)
        elif name == "breakdown":
            hit = aiq or (s0 + e0) / 2
            pads(s0, hit, 0.3, 800, every=2)
            bassb.add(np.sin(2 * np.pi * mtof(26) * secs(int((hit - s0) * SR))) * env(int((hit - s0) * SR), 0.6, 0.3), s0, 0.35)
            for k, t in steps(s0, hit - 1.0, beat / 2):
                drums.add(hat(), t, 0.16 if k % 2 else 0.24, pan=0.4 if k % 2 else -0.4)
            crash_at(hit, 0.5)
            chords.add(supersaw(PROG[2]["pad"] + [53], e0 - hit + 0.4, voices=7, cutoff=4200, release=1.2), hit, 0.38)
            arp(hit + 0.5, e0, 0.12, bright=0.6)
        elif name == "tension":
            for k, t in steps(s0, e0 - 2.0, beat):
                if k % 4 == 0 or k % 8 == 6:
                    drums.add(kick(), t, 0.9)
                    kicks.append((t, 0.5))
                if k % 4 == 2:
                    drums.add(clap(), t, 0.5)
            for k, t in steps(s0, e0 - 2.0, s16):
                drums.add(hat(), t, 0.14 if k % 4 == 2 else 0.06, pan=-0.3)
            bassline(s0, e0 - 2.0, 0.5, "straight")
            pads(s0, e0, 0.26, 1500)
            arp(s0, e0 - 2.0, 0.12, step=s16, bright=0.45)
            build(e0 - 2.0, e0, 0.55)
        elif name == "outro":
            end = s0 + 3 * bar
            crash_at(s0, 0.45)
            four_floor(s0, end, 0.95, 0.75, closed=0.2)
            bassline(s0, end, 0.58, "rolling")
            big_chords(s0, end, 0.34)
            motif(s0, end, 0.28, 0, 1.0)
            # the final hit: the home chord, left to ring
            drums.add(kick(), end, 1.0)
            crash_at(end, 0.5)
            chords.add(supersaw([53, 60, 65, 69, 72, 77], 2.2, voices=7, cutoff=4000, release=1.6), end, 0.42)
            bassb.add(bass(29, 1.6) * env(int(1.6 * SR), 0.004, 1.2), end, 0.6)
            plucks.add(pluck(77, 1.2, 1.0), end, 0.3)

    # the pump: everything tonal ducks under the kick
    pump = np.ones(n)
    for t, depth in kicks:
        i = int(t * SR)
        m = min(n - i, int(0.3 * SR))
        if m <= 0:
            continue
        x = np.arange(m) / (0.24 * SR)
        pump[i : i + m] = np.minimum(pump[i : i + m], 1 - depth * np.clip(1 - x, 0, 1) ** 2)
    tonal = (bassb.x * 0.72 + chords.x + plucks.x) * pump
    wet = reverb(chords.x * 0.25 * pump + plucks.x * 0.5 + drums.x * 0.06 + fx.x * 0.15)
    music = drums.x + tonal + fx.x + 0.32 * wet

    # "Blocked." — the music stops dead for a beat
    if block:
        t = secs(n)
        gate = 1 - np.clip((t - (block - 0.03)) / 0.02, 0, 1) * np.clip((block + 0.55 - t) / 0.12, 0, 1)
        music *= gate
    music = filt(music, "highpass", 34, 4)  # nothing useful lives below; it only eats headroom
    return music


# ------------------------------------------------------------------ the effects
PENT = [77, 79, 81, 84, 86, 89, 91, 93, 96, 98]  # F major pentatonic, F5 up


def fx_sound(c):
    k = c["kind"]
    i = c.get("i", 0)
    if k == "whoosh":
        dur = 0.75 if c.get("big") else 0.55
        n = int(dur * SR)
        t = secs(n)
        x = tvband(noise(n), 350 * 10 ** np.sin(np.pi * t / dur * 0.85), 0.9)
        x *= np.sin(np.pi * np.clip(t / dur, 0, 1) ** 0.75) ** 2
        x /= np.abs(x).max() + 1e-9
        pan = np.linspace(-0.8, 0.8, n)
        return np.stack([x * np.minimum(1, 1 - pan), x * np.minimum(1, 1 + pan)]), 0.38 if c.get("big") else 0.26, 0.2
    if k == "slam":
        big = c.get("big")
        n = int((0.7 if big else 0.32) * SR)
        t = secs(n)
        f = 40 + 70 * np.exp(-t / 0.05)
        y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.32 if big else 0.13))
        y += filt(noise(n), "lowpass", 2600) * np.exp(-t / 0.025) * 0.6
        y += filt(noise(n), "bandpass", [1500, 6000]) * np.exp(-t / 0.012) * 0.3
        return np.tanh(1.5 * y), 0.62 if big else 0.42, 0.25 if big else 0.08
    if k == "ticks":
        dur, m = c["dur"], c["n"]
        n = int((dur + 0.05) * SR)
        y = np.zeros(n)
        for j in range(m):
            at = int(j / max(1, m - 1) * dur * SR)
            w = int(0.012 * SR)
            tt = secs(w)
            y[at : at + w] += (np.sin(2 * np.pi * (2400 + 300 * (j % 3)) * tt) * np.exp(-tt / 0.003))[: n - at]
        return y, 0.14, 0.0
    if k == "scratch":
        n = int(0.26 * SR)
        t = secs(n)
        y = filt(noise(n), "bandpass", [1400, 5200]) * np.abs(np.sin(2 * np.pi * 15 * t)) * np.sin(np.pi * t / 0.26)
        return y / np.abs(y).max(), 0.3, 0.05
    if k == "type":
        dur, m = c["dur"], c["n"]
        n = int((dur + 0.1) * SR)
        y = np.zeros(n)
        times = np.sort(rng.uniform(0, dur, m))
        for at in times:
            for off, g in ((0, 1.0), (0.035, 0.35)):
                w = int(0.01 * SR)
                s = int((at + off) * SR)
                if s + w >= n:
                    continue
                tt = secs(w)
                y[s : s + w] += g * rng.uniform(0.5, 1) * filt(noise(w), "bandpass", [1800, 6500]) * np.exp(-tt / 0.0025)
        return y / (np.abs(y).max() + 1e-9), 0.2, 0.02
    if k == "riser":
        return riser(c["dur"], 400, 10000), 0.3, 0.1
    if k == "impact":
        big, warm = c.get("big"), c.get("warm")
        n = int((2.2 if big else 0.9) * SR)
        t = secs(n)
        f = (32 if warm else 36) + 45 * np.exp(-t / 0.07)
        y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.85 if big else 0.3))
        y += filt(noise(n), "lowpass", 5000) * np.exp(-t / (0.2 if big else 0.08)) * 0.5
        y = np.tanh(1.6 * y)
        return y, 0.75 if big else 0.45, 0.35 if big else 0.15
    if k == "shimmer":
        n = int(1.4 * SR)
        y = np.zeros((2, n))
        for j in range(26):
            at = rng.uniform(0, 0.9)
            f = mtof(PENT[rng.integers(3, len(PENT))] + 12)
            w = int(0.3 * SR)
            tt = secs(w)
            g = np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.07) * np.minimum(1, tt / 0.004) * rng.uniform(0.3, 1)
            s = int(at * SR)
            y[:, s : s + w] += stereo(g, rng.uniform(-0.8, 0.8))[:, : n - s]
        return y / np.abs(y).max(), 0.14, 0.5
    if k == "click":
        n = int(0.06 * SR)
        t = secs(n)
        y = np.sin(2 * np.pi * 1700 * t) * np.exp(-t / 0.004) + 0.8 * np.sin(2 * np.pi * 210 * t) * np.exp(-t / 0.012)
        y += filt(noise(n), "highpass", 3000) * np.exp(-t / 0.002) * 0.5
        return y, 0.42, 0.03
    if k == "pop":
        f = mtof(PENT[i % len(PENT)])
        n = int(0.16 * SR)
        t = secs(n)
        y = np.sin(2 * np.pi * np.cumsum(f * (1 + 0.7 * np.exp(-t / 0.012))) / SR) * np.exp(-t / 0.05)
        return y, 0.2, 0.08
    if k == "tick":
        f = mtof(PENT[i % len(PENT)] + (12 if c.get("bright") else 0))
        n = int(0.14 * SR)
        t = secs(n)
        y = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * np.exp(-t / 0.03)
        return y, 0.24 if c.get("bright") else 0.15, 0.15
    if k in ("ding", "allow", "success"):
        notes = {"ding": [[84, 89], [81, 88]][i % 2], "allow": [89, 93, 96], "success": [77, 81, 84, 89, 93]}[k]
        gap = {"ding": 0.08, "allow": 0.06, "success": 0.075}[k]
        tau = {"ding": 0.5, "allow": 0.6, "success": 0.7}[k]
        parts = [bell(mtof(m), tau) for m in notes]
        n = int((gap * len(notes)) * SR) + len(parts[0])
        y = np.zeros(n)
        for j, p in enumerate(parts):
            s = int(j * gap * SR)
            y[s : s + len(p)] += p
        return y / np.abs(y).max(), {"ding": 0.24, "allow": 0.4, "success": 0.36}[k], 0.35
    if k == "send":
        n = int(0.3 * SR)
        t = secs(n)
        x = tvband(noise(n), 600 * 9 ** (t / 0.3), 0.7) * np.sin(np.pi * np.clip(t / 0.3, 0, 1) ** 0.6)
        return x / (np.abs(x).max() + 1e-9), 0.2, 0.1
    if k == "tile":
        n = int(0.12 * SR)
        t = secs(n)
        y = np.sin(2 * np.pi * (130 + 12 * i) * t) * np.exp(-t / 0.035) + filt(noise(n), "bandpass", [800, 3000]) * np.exp(-t / 0.012) * 0.4
        return y, 0.22, 0.03
    if k == "blip":
        dur = c["dur"]
        n = int(dur * SR)
        t = secs(n)
        f = 500 * 3 ** (t / dur)
        y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / dur) * (0.7 + 0.3 * np.sin(2 * np.pi * 28 * t))
        return y, 0.1, 0.15
    if k == "stamp":
        n = int(0.2 * SR)
        t = secs(n)
        y = np.sin(2 * np.pi * 105 * t) * np.exp(-t / 0.05) + filt(noise(n), "bandpass", [500, 2600]) * np.exp(-t / 0.02) * 0.7
        return np.tanh(1.4 * y), 0.45, 0.08
    if k == "pulse":
        n = int(1.2 * SR)
        t = secs(n)
        y = (np.sin(2 * np.pi * 1320 * t) * 0.6 + np.sin(2 * np.pi * 660 * t)) * np.exp(-t / 0.3) * np.minimum(1, t / 0.003)
        return y, 0.16, 0.4
    if k == "block":
        n = int(0.5 * SR)
        t = secs(n)
        buzz = sum(np.sign(np.sin(2 * np.pi * f * t)) for f in (98, 104.5)) * 0.5
        buzz = filt(buzz, "lowpass", 2200) * np.minimum(1, t / 0.004) * np.exp(-t / 0.16)
        thud = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.04)) / SR) * np.exp(-t / 0.18)
        crunch = filt(noise(n), "bandpass", [700, 4000]) * np.exp(-t / 0.02)
        y = np.tanh(1.4 * (0.6 * buzz + thud + 0.5 * crunch))
        return y, 0.62, 0.15
    if k == "row":
        f = 2200 if c.get("ok") else 1500
        n = int(0.05 * SR)
        t = secs(n)
        return np.sin(2 * np.pi * f * t) * np.exp(-t / 0.009), 0.1, 0.0
    raise ValueError(f"no sound for cue {k}")


def effects(cues, n):
    dry, send = Track(n), Track(n)
    for c in cues:
        y, gain, wet = fx_sound(c)
        pan = 0.0 if c["kind"] not in ("pop", "tick", "tile", "row") else ((c.get("i", 0) % 5) - 2) * 0.18
        dry.add(y, c["t"], gain, pan)
        if wet:
            send.add(y, c["t"], gain * wet, pan)
    return filt(dry.x + reverb(send.x), "highpass", 32, 4)


# ------------------------------------------------------------------ the voice
def voice(tl, n):
    vo = Track(n)
    for line in tl["vo"]:
        y, sr = sf.read(os.path.join(BUILD, "vo", f"{line['id']}.wav"))
        y = signal.resample_poly(y, SR, sr)
        y = filt(y, "highpass", 85, 2)
        active = y[np.abs(y) > 0.02]
        rms = np.sqrt(np.mean(active ** 2)) if len(active) else 0.1
        vo.add(y * (0.1 / rms), line["at"])  # every line at the same level, about -20 dBFS
    return vo.x


def duck(vo, depth_db=-7.5):
    """Music gain that dips while the voice speaks (10 ms frames, fast attack, slow release)."""
    hop = int(0.01 * SR)
    frames = np.sqrt(np.mean(vo[0, : len(vo[0]) // hop * hop].reshape(-1, hop) ** 2, axis=1))
    on = (frames > 0.012).astype(float)
    g = np.zeros_like(on)
    level = 0.0
    for i, x in enumerate(on):
        level = x if x > level else level * 0.965  # ~300 ms release
        g[i] = level
    g = uniform_filter1d(g, 3)
    gain_frames = 10 ** (depth_db * g / 20)
    return np.interp(np.arange(vo.shape[1]), np.arange(len(gain_frames)) * hop, gain_frames)


# ------------------------------------------------------------------ mastering
def limit(x, ceiling_db=-1.0):
    """A look-ahead peak limiter on true (4x oversampled) peaks; the reduction a peak needs is spread 5 ms either side."""
    ceiling = 10 ** (ceiling_db / 20)
    up = np.abs(signal.resample_poly(x.astype(np.float32), 4, 1, axis=1)).max(axis=0)
    peak = np.maximum(up[: x.shape[1] * 4].reshape(-1, 4).max(axis=1), 1e-9)
    need = np.minimum(1.0, ceiling / peak)
    w = 2 * int(0.005 * SR) + 1
    reduction = uniform_filter1d(maximum_filter1d(1 - need, w), w)
    return x * np.minimum(1 - reduction, need)


def lufs(path):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    data = json.loads(out[out.rindex("{") : out.rindex("}") + 1])
    return float(data["input_i"]), float(data["input_tp"])


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


def main():
    tl = json.load(open(os.path.join(BUILD, "timeline.json"), encoding="utf-8"))
    cues = json.load(open(os.path.join(BUILD, "cues.json"), encoding="utf-8"))
    n = int((tl["duration"] + 0.5) * SR)
    print("composing the music…")
    music = compose(tl, cues, n)
    print("placing", len(cues), "effects…")
    sfx = effects(cues, n)
    print("placing the voice…")
    vo = voice(tl, n)
    d = duck(vo)

    # levels: music about 4 dB under the voice before ducking, effects in between
    music *= 10 ** ((rms_db(vo[:, np.abs(vo[0]) > 0.02]) - 4 - rms_db(music)) / 20)
    sfx *= 10 ** ((rms_db(music) - 6 - rms_db(sfx)) / 20)
    mix = vo + music * d + sfx * (0.6 + 0.4 * d)

    for name, x in (("music", music), ("sfx", sfx), ("vo", vo)):
        sf.write(os.path.join(BUILD, f"{name}.wav"), (x / max(1.0, np.abs(x).max())).T.astype(np.float32), SR)
    pre = os.path.join(BUILD, "mix-pre.wav")
    peak = np.abs(mix).max()
    sf.write(pre, (mix / peak * 0.5).T.astype(np.float32), SR)
    li, _ = lufs(pre)
    mix = mix / peak * 0.5 * 10 ** ((-14.0 - li) / 20)
    mix = limit(mix, -1.5)
    out = os.path.join(BUILD, "mix.wav")
    sf.write(out, mix.T.astype(np.float32), SR, subtype="FLOAT")
    os.remove(pre)
    i, tp = lufs(out)
    print(f"wrote {out}: {n / SR:.1f}s, {i:.1f} LUFS, true peak {tp:.1f} dBTP")


if __name__ == "__main__":
    main()
