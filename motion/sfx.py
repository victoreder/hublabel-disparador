"""Efeitos e instrumentos sintetizados (numpy) + mixer simples.

Tudo é gerado aqui: nenhum banco de áudio externo. Cada função devolve um
array float32 mono em SR; a classe Mix posiciona os sons no tempo e exporta
WAV estéreo 16-bit.
"""
import wave

import numpy as np

SR = 44100


def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def env_adsr(n, a=0.005, d=0.08, s=0.6, r=0.2, hold=None):
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    hold_n = max(0, n - a_n - d_n - r_n) if hold is None else int(hold * SR)
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(hold_n, s),
        np.linspace(s, 0, r_n),
    ])
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def exp_env(n, tau):
    return np.exp(-np.arange(n) / (tau * SR))


def lowpass(x, cutoff):
    """Passa-baixa de 1 polo (cutoff pode ser array, para varreduras)."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=np.float64), x.shape)
    alpha = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += alpha[i] * (x[i] - acc)
        y[i] = acc
    return y


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def noise(dur, seed=0):
    return np.random.default_rng(seed).standard_normal(int(dur * SR))


def note(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


# ---------- instrumentos ----------

def kick(dur=0.35, gain=1.0):
    t = t_axis(dur)
    f = 45 + 90 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) * np.exp(-t * 9) * gain).astype(np.float32)


def hat(dur=0.06, gain=0.25, seed=1):
    x = highpass(noise(dur, seed), 7000)
    return (x * exp_env(len(x), 0.012) * gain).astype(np.float32)


def clap(dur=0.18, gain=0.35, seed=4):
    x = highpass(noise(dur, seed), 1200)
    e = exp_env(len(x), 0.04)
    return (x * e * gain).astype(np.float32)


def pad(midis, dur, gain=0.12, bright=1800):
    t = t_axis(dur)
    x = np.zeros_like(t)
    for m in midis:
        for det in (-0.08, 0.0, 0.08):
            f = note(m + det)
            x += 2 * ((t * f) % 1) - 1  # serra
    x = lowpass(x / (len(midis) * 3), bright)
    return (x * env_adsr(len(t), a=0.35, d=0.3, s=0.8, r=0.6) * gain).astype(np.float32)


def pluck(midi, dur=0.45, gain=0.22, bright=3500):
    t = t_axis(dur)
    f = note(midi)
    x = 0.6 * np.sin(2 * np.pi * f * t) + 0.3 * (2 * ((t * f) % 1) - 1) + 0.15 * np.sin(4 * np.pi * f * t)
    x = lowpass(x, bright * np.exp(-t * 6) + 300)
    return (x * exp_env(len(t), 0.16) * gain).astype(np.float32)


def bass(midi, dur, gain=0.3):
    t = t_axis(dur)
    f = note(midi)
    x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return (x * env_adsr(len(t), a=0.01, d=0.1, s=0.7, r=0.08) * gain).astype(np.float32)


def bell(midi, dur=1.2, gain=0.25):
    t = t_axis(dur)
    f = note(midi)
    x = (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 6)
         + 0.25 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 12))
    return (x * exp_env(len(t), 0.45) * gain).astype(np.float32)


# ---------- efeitos de interface ----------

def whoosh(dur=0.6, gain=0.35, up=True, seed=2):
    t = t_axis(dur)
    x = noise(dur, seed)
    sweep = np.linspace(400, 6000, len(t)) if up else np.linspace(6000, 400, len(t))
    x = lowpass(x, sweep) - lowpass(x, sweep * 0.25)
    e = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.5
    return (x * e * gain * 2.2).astype(np.float32)


def click(gain=0.4, seed=3):
    x = highpass(noise(0.03, seed), 2500)
    t = t_axis(0.03)
    x = x * exp_env(len(x), 0.004) + 0.6 * np.sin(2 * np.pi * 1800 * t) * exp_env(len(t), 0.006)
    return (x * gain).astype(np.float32)


def key_tick(seed=0, gain=0.12):
    x = highpass(noise(0.025, 100 + seed), 3000)
    return (x * exp_env(len(x), 0.005) * gain).astype(np.float32)


def typing(dur, cps=30, gain=0.12, seed=0):
    out = np.zeros(int(dur * SR) + SR // 10, dtype=np.float32)
    rng = np.random.default_rng(seed)
    n = int(dur * cps)
    for i in range(n):
        pos = int((i / cps + rng.uniform(-0.008, 0.008)) * SR)
        k = key_tick(i, gain * rng.uniform(0.6, 1.0))
        pos = max(0, pos)
        out[pos:pos + len(k)] += k[:len(out) - pos]
    return out


def pop(gain=0.35, f0=900, f1=1500):
    t = t_axis(0.12)
    f = np.linspace(f0, f1, len(t))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * exp_env(len(t), 0.03)
    return (x * gain).astype(np.float32)


def msg_in(gain=0.3):
    """Notificação de mensagem recebida: dois tons curtos (genérico)."""
    a = pop(gain, 1046, 1046)
    b = pop(gain * 0.8, 1568, 1568)
    out = np.zeros(int(0.25 * SR), dtype=np.float32)
    out[:len(a)] += a
    o = int(0.07 * SR)
    out[o:o + len(b)] += b
    return out


def msg_out(gain=0.25):
    return pop(gain, 700, 1300)


def success(gain=0.3):
    out = np.zeros(int(1.4 * SR), dtype=np.float32)
    for i, m in enumerate([72, 76, 79, 84]):
        b = bell(m, 1.1, gain * (0.8 if i < 3 else 1))
        o = int(i * 0.07 * SR)
        out[o:o + len(b)] += b[:len(out) - o]
    return out


def sparkle(gain=0.18, seed=5):
    out = np.zeros(int(0.9 * SR), dtype=np.float32)
    rng = np.random.default_rng(seed)
    for i in range(9):
        m = 84 + rng.integers(0, 12)
        b = bell(int(m), 0.5, gain * rng.uniform(0.4, 1))
        o = int(i * 0.06 * SR)
        out[o:o + len(b)] += b[:len(out) - o]
    return out


def riser(dur=1.0, gain=0.25, seed=6):
    t = t_axis(dur)
    x = noise(dur, seed)
    x = lowpass(x, np.linspace(300, 9000, len(t)))
    return (x * (t / dur) ** 2 * gain).astype(np.float32)


def impact(gain=0.6):
    k = kick(0.8, gain)
    n = lowpass(noise(0.8, 9), 900) * exp_env(int(0.8 * SR), 0.12) * gain * 0.5
    return (k + n[:len(k)]).astype(np.float32)


def tick_tock(n=6, step=0.11, gain=0.2):
    out = np.zeros(int((n * step + 0.1) * SR), dtype=np.float32)
    for i in range(n):
        p = pop(gain, 2200 if i % 2 == 0 else 1700, 2200 if i % 2 == 0 else 1700)[: int(0.03 * SR)]
        o = int(i * step * SR)
        out[o:o + len(p)] += p
    return out


class Mix:
    def __init__(self, dur):
        self.buf = np.zeros((int(dur * SR) + SR, 2), dtype=np.float32)

    def add(self, x, at, gain=1.0, pan=0.0):
        o = int(at * SR)
        if o >= len(self.buf):
            return
        x = x[: len(self.buf) - o] * gain
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        self.buf[o:o + len(x), 0] += x * l * 1.414
        self.buf[o:o + len(x), 1] += x * r * 1.414

    def duck(self, at, dur=0.25, depth=0.4):
        """Abaixa a trilha brevemente (efeito 'sidechain') — aplicado no bus de música."""
        o, n = int(at * SR), int(dur * SR)
        e = 1 - depth * np.exp(-np.arange(n) / (0.08 * SR))
        end = min(len(self.buf), o + n)
        self.buf[o:end] *= e[: end - o, None]

    def write(self, path, dur, fade_out=1.2, peak=0.89):
        n = int(dur * SR)
        y = self.buf[:n].copy()
        f = int(fade_out * SR)
        y[-f:] *= np.linspace(1, 0, f)[:, None]
        y = np.tanh(y * 1.1) / np.tanh(1.1)  # limitador suave
        y *= peak / max(1e-6, np.abs(y).max())
        with wave.open(path, 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((y * 32767).astype('<i2').tobytes())
