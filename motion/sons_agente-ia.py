"""Trilha e efeitos de anuncio-agente-ia.html.

Os tempos espelham o objeto T do HTML (window.TIMELINE). Se mudar um, mude o outro.
Gera sons_agente-ia.wav (estéreo, 44.1 kHz).
"""
import sfx
from sfx import Mix

DUR = 40.0
T = dict(
    hookOut=2.95,
    appIn=3.2, nameClick=3.95, nameType=4.05, glowAudio=4.7, glowImg=4.9,
    edClick=5.15, ty0=5.25,
    l1=7.55, grab1=7.95, land1=8.4, l1b=8.45,
    l2=8.8, grab2=9.15, land2=9.6, l2b=9.65,
    l3=9.95, grab3=10.25, land3=10.7, l3b=10.75,
    zoomOut=11.1, tabClick=11.5, swClick=11.9, passo=12.05, doneClick=12.6, toast=12.65, buildOut=13.45,
    phoneIn=13.7,
    m1=14.5, m2=15.4, rc2=16.2, m3=16.25, m4=16.9, voiceStart=17.15, voiceEnd=19.1, m5=17.9,
    rc3=18.8, m6=18.8, m7=19.8, tapIn=20.55, tap=21.0, m8=21.3, m9=21.6, m10=22.15,
    crmIn=23.1, heroIn=24.1, mv1=24.9, mv2=26.2,
    tc5=27.5, m11=27.85, ffEnd=28.6, m12=28.95,
    tc6=30.2, m13=30.4, m14=31.0, m15=31.75, m16=32.35, mv3=32.7,
    flowOut=34.5, endIn=35.0,
)
# Textos digitados (mesmo tamanho dos do HTML) → duração do som de teclado
TX = dict(
    name=('Sofia · Vendas', 30),
    p0=('Você é a Sofia, consultora da Loja Aurora. Tire dúvidas, responda em áudio quando o cliente mandar áudio e qualifique o lead.', 56),
    l1a=('Ao apresentar o plano: ', 62), l1b=(' foto do Plano Anual.', 62),
    l2a=('Para o cliente escolher: ', 62), l2b=(' Mensal ou Anual.', 62),
    l3a=('Lead qualificado: ', 62), l3b=(' mover para Qualificado.', 62),
)

# ---------------- trilha ----------------
BPM = 112
BEAT = 60 / BPM
BAR = BEAT * 4
CHORDS = [  # Am – F – C – G
    (45, [57, 60, 64, 69]),
    (41, [53, 57, 60, 65]),
    (48, [55, 60, 64, 67]),
    (43, [55, 59, 62, 67]),
]

music = Mix(DUR)
end_music = T['endIn']
bar = 0
t = 0.0
while t < end_music:
    root, ch = CHORDS[bar % 4]
    music.add(sfx.pad(ch, BAR + 0.5, gain=0.10, bright=1500 if t < T['appIn'] else 2200), t, pan=0)
    groove = t >= T['appIn'] - 0.01
    # arpejo
    for i in range(8):
        m = ch[[0, 1, 2, 3, 2, 1, 2, 3][i]] + 12
        music.add(sfx.pluck(m, 0.35, gain=0.07 if groove else 0.05), t + i * BEAT / 2, pan=(-0.35 if i % 2 else 0.35))
    if groove:
        for b in range(4):
            bt = t + b * BEAT
            if bt >= end_music - 0.05:
                break
            music.add(sfx.kick(0.3, 0.55), bt)
            music.add(sfx.hat(0.05, 0.10, seed=b), bt + BEAT / 2, pan=0.25)
            if b in (1, 3):
                music.add(sfx.clap(0.15, 0.13, seed=b), bt, pan=-0.1)
        music.add(sfx.bass(root, BEAT * 1.5, 0.22), t)
        music.add(sfx.bass(root, BEAT * 0.9, 0.18), t + BEAT * 2)
        music.add(sfx.bass(root + 12 if bar % 2 else root, BEAT * 0.9, 0.16), t + BEAT * 3)
    t += BAR
    bar += 1

# respiro no início do celular (fica só o pad) e acorde final longo
music.add(sfx.pad([57, 60, 64, 69, 72], 5.2, gain=0.13, bright=2600), T['endIn'])
music.add(sfx.bass(45, 4.5, 0.22), T['endIn'])

# ---------------- efeitos ----------------
fx = Mix(DUR)
fx.add(sfx.impact(0.5), 0.0)
fx.add(sfx.pop(0.25, 600, 1200), 0.05)
fx.add(sfx.whoosh(0.7, 0.18, up=True, seed=11), 0.15)
fx.add(sfx.riser(1.0, 0.16), T['hookOut'] - 0.8)
fx.add(sfx.whoosh(0.55, 0.3, up=True, seed=12), T['appIn'] - 0.1)

def typed(key, at):
    text, cps = TX[key]
    fx.add(sfx.typing(len(text) / cps, cps=min(cps, 26), gain=0.13, seed=sum(map(ord, key))), at, pan=0.1)

fx.add(sfx.click(0.35), T['nameClick'])
typed('name', T['nameType'])
fx.add(sfx.pop(0.12, 1200, 1600), T['glowAudio'] + 0.1)
fx.add(sfx.pop(0.12, 1300, 1700), T['glowImg'] + 0.1)
fx.add(sfx.click(0.35), T['edClick'])
fx.add(sfx.whoosh(0.5, 0.14, up=True, seed=13), T['edClick'] - 0.2)
typed('p0', T['ty0'])
for i in (1, 2, 3):
    typed(f'l{i}a', T[f'l{i}'])
    fx.add(sfx.click(0.3), T[f'grab{i}'])
    fx.add(sfx.whoosh(0.45, 0.10, up=True, seed=20 + i), T[f'grab{i}'])
    fx.add(sfx.pop(0.3, 500, 900), T[f'land{i}'])
    typed(f'l{i}b', T[f'l{i}b'])
fx.add(sfx.whoosh(0.5, 0.14, up=False, seed=14), T['zoomOut'])
fx.add(sfx.click(0.35), T['tabClick'])
fx.add(sfx.click(0.35), T['swClick'])
for i in range(3):
    fx.add(sfx.pop(0.12, 900 + i * 200, 1300 + i * 200), T['passo'] + i * 0.12)
fx.add(sfx.click(0.4), T['doneClick'])
fx.add(sfx.success(0.22), T['toast'])
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=15), T['buildOut'])
fx.add(sfx.whoosh(0.7, 0.3, up=True, seed=16), T['phoneIn'])

for k in ('m1', 'm2', 'm8', 'm13', 'm14'):
    fx.add(sfx.msg_out(0.26), T[k], pan=-0.15)
for k in ('m4', 'm5', 'm6', 'm7', 'm10', 'm12', 'm16'):
    fx.add(sfx.msg_in(0.24), T[k], pan=-0.15)
for k in ('rc2', 'rc3'):
    fx.add(sfx.whoosh(0.45, 0.12, up=True, seed=30), T[k] - 0.1, pan=0.4)
fx.add(sfx.click(0.4), T['tap'])

fx.add(sfx.whoosh(0.7, 0.3, up=True, seed=17), T['crmIn'] + 0.2)
fx.add(sfx.pop(0.3, 600, 1100), T['heroIn'])
for k in ('mv1', 'mv2', 'mv3'):
    fx.add(sfx.whoosh(0.6, 0.16, up=True, seed=40), T[k], pan=0.3)
    fx.add(sfx.click(0.28), T[k] + 0.72, pan=0.3)
fx.add(sfx.whoosh(0.45, 0.12, up=True, seed=31), T['tc5'] - 0.1)
fx.add(sfx.tick_tock(7, 0.1, 0.16), T['m11'])
fx.add(sfx.whoosh(0.45, 0.12, up=True, seed=32), T['tc6'] - 0.1)
fx.add(sfx.success(0.28), T['mv3'] + 0.4, pan=0.2)
fx.add(sfx.sparkle(0.16), T['mv3'] + 0.45, pan=0.3)

fx.add(sfx.whoosh(0.6, 0.3, up=False, seed=18), T['flowOut'])
fx.add(sfx.impact(0.7), T['endIn'])
fx.add(sfx.bell(81, 2.5, 0.12), T['endIn'] + 0.15)
fx.add(sfx.bell(88, 2.5, 0.08), T['endIn'] + 0.25)
for i in range(3):
    fx.add(sfx.pop(0.14, 900 + i * 150, 1400 + i * 150), T['endIn'] + 1.5 + i * 0.15)

# mensagens "abaixam" a trilha um pouco para os efeitos aparecerem
for k in ('m1', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8', 'm10', 'm12', 'm13', 'm14', 'm16'):
    music.duck(T[k], 0.4, 0.3)

fx.buf += music.buf * 0.8
fx.write('sons_agente-ia.wav', DUR, fade_out=1.5)
print('ok → sons_agente-ia.wav')
